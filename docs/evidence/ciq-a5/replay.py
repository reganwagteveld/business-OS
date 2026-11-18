# CIQ-A5 replay, step 2: classify runs into final-candidate and dev-stage runs and price the early-CI variants.
# Run in the directory holding the step-1 JSON: python3 replay.py [replay-prs.csv]
import json, re, statistics as st, collections, datetime as dt
P=json.load(open("prs.json")); R=json.load(open("runs.json")); J=json.load(open("jobs.json")); F=json.load(open("files.json"))
def t(s): return dt.datetime.fromisoformat(s.replace("Z","+00:00"))
CI=re.compile(r"^\.github/")
GOV=re.compile(r"(^|/)(CLAUDE|AGENTS|SECURITY)\.md$|^docs/(agent-|merge-queue|active-workstreams)",re.I)
DB=re.compile(r"^apps/api/prisma/(migrations|privileged)/|^docker/init/")
KW=re.compile(r"auth|session|admission|permission|tenant|tenanc|rbac|role|token|(^|[/_.-])rls|csrf|secret|credential",re.I)
VAR={"S0 request-only":lambda f:False,
     "S1 CI+governance":lambda f:bool(CI.search(f) or GOV.search(f)),
     "S2 S1+migrations/privileged":lambda f:bool(CI.search(f) or GOV.search(f) or DB.search(f)),
     "S3 S2+security keywords":lambda f:bool(CI.search(f) or GOV.search(f) or DB.search(f) or KW.search(f))}
def jm(j):
    if not j["started"] or not j["completed"]: return 0
    return max(0,(t(j["completed"])-t(j["started"])).total_seconds()/60)
def osj(j):
    l=" ".join(j["labels"]).lower(); return "macos" if "macos" in l else "windows" if "windows" in l else "linux"
def tally(rs):
    d=collections.Counter()
    for r in rs:
        for j in J.get(str(r["id"]),[]):
            o=osj(j); d[o+"_min"]+=jm(j); d["jobs"]+=1
            if o=="macos": d["mac_jobs"]+=1; d["mac_unalloc"]+= (j["conclusion"]=="cancelled" and jm(j)>=13)
            if j["name"].startswith("Database"): d["db_jobs"]+=1
            if j["name"] in("Detect changes","CI gate"): d["cheap_min"]+=jm(j); d["cheap_n"]+=1
    return d
prs=[]
for n,p in P.items():
    created,merged=t(p["created_at"]),t(p["merged_at"])
    runs=sorted([r for r in R if r["event"]=="pull_request" and r["head_branch"]==p["head_ref"] and created-dt.timedelta(minutes=1)<=t(r["created_at"])<=merged],key=lambda r:r["created_at"])
    if not runs: continue
    ready=[t(e["at"]) for e in p["timeline"] if e["event"]=="ready_for_review"]
    ready_at=max(ready) if ready else None
    commits=p["commits"]; code=[c for c in commits if c["parents"]==1]
    li=max([i for i,c in enumerate(commits) if c["parents"]==1] or [0])
    sync_heads={c["sha"] for c in commits[li+1:] if c["parents"]==2}
    heads={r["head_sha"] for r in runs}
    final_heads=(sync_heads&heads) or {p["head_sha"]}
    final=[ [r for r in runs if r["head_sha"]==h][-1] for h in final_heads if any(r["head_sha"]==h for r in runs)] or [runs[-1]]
    fid={r["id"] for r in final}
    dev=[r for r in runs if r["id"] not in fid]
    prs.append(dict(n=int(n),runs=runs,final=final,dev=dev,files=F[n],ready_at=ready_at,commits=len(commits),code=len(code),syncs=len(commits)-len(code),
        dev_fail=sum(1 for r in dev if r["conclusion"]=="failure"),final_fail=sum(1 for r in final if r["conclusion"]=="failure"),
        early_ready= bool(ready_at) and any(t(r["created_at"])>=ready_at for r in dev)))
N=len(prs); allr=[r for p in prs for r in p["runs"]]; dev=[r for p in prs for r in p["dev"]]; fin=[r for p in prs for r in p["final"]]
print(f"PRs {N}; PR CI runs {len(allr)}; per PR median {st.median(len(p['runs']) for p in prs)} mean {len(allr)/N:.2f} max {max(len(p['runs']) for p in prs)}")
print(f"commits/PR median {st.median(p['commits'] for p in prs)}, code commits median {st.median(p['code'] for p in prs)}, sync merges {sum(p['syncs'] for p in prs)}")
print(f"final-candidate runs {len(fin)} ({len(fin)/N:.2f}/PR); dev-stage runs {len(dev)} ({len(dev)/N:.2f}/PR)")
print(f"runs while draft {sum(1 for p in prs for r in p['runs'] if p['ready_at'] and t(r['created_at'])<p['ready_at'])}; PRs opened ready {sum(1 for p in prs if not p['ready_at'])}; PRs with dev runs after ready {sum(p['early_ready'] for p in prs)}")
print(f"dev runs failed {sum(p['dev_fail'] for p in prs)} in {sum(1 for p in prs if p['dev_fail'])} PRs; final runs failed {sum(p['final_fail'] for p in prs)}")
A,D,Fn=tally(allr),tally(dev),tally(fin)
print("ALL",dict(A)); print("DEV",dict(D)); print("FINAL",dict(Fn))
cheap=D["cheap_min"]/max(1,len(dev))
print(f"suppressed-run cost estimate (Detect changes + gate, measured on dev runs): {cheap:.2f} min/run")
for name,f in VAR.items():
    early=[p for p in prs if any(f(x) for x in p["files"])]
    rem=[r for p in prs if p not in early for r in p["dev"]]
    T=tally(rem)
    print(f"{name}: early PRs {len(early)}, dev runs removed {len(rem)}/{len(dev)} = {100*len(rem)/len(dev):.0f}% of dev-stage, {100*len(rem)/len(allr):.0f}% of all PR runs; runs/PR {(len(allr)-len(rem))/N:.2f}; jobs {T['jobs']}, mac {T['mac_jobs']} (unalloc {T['mac_unalloc']}), db {T['db_jobs']}, linux {T['linux_min']:.0f} min, mac {T['macos_min']:.0f} min, win {T['windows_min']:.0f} min; minus suppressed cost {len(rem)*cheap:.0f} linux min; dev failures in removed {sum(1 for r in rem if r['conclusion']=='failure')}")
# runs per PR distribution
print("runs/PR dist",collections.Counter(min(len(p['runs']),10) for p in prs))
pm=[r for r in R if r["event"]=="push"]; T=tally(pm); print("push(main) runs",len(pm),dict(T))
import csv,sys
if len(sys.argv)>1:
    w=csv.writer(open(sys.argv[1],"w",newline=""))
    w.writerow(["pr","commits","code_commits","sync_merges","pr_ci_runs","final_candidate_runs","dev_stage_runs","opened_ready","early_ci_S1","early_ci_S2","early_ci_S3","dev_jobs","dev_macos_jobs","dev_db_jobs","dev_linux_min","dev_macos_min","dev_windows_min"])
    for p in sorted(prs,key=lambda p:p["n"]):
        T=tally(p["dev"])
        w.writerow([p["n"],p["commits"],p["code"],p["syncs"],len(p["runs"]),len(p["final"]),len(p["dev"]),int(not p["ready_at"])]+[int(any(VAR[k](x) for x in p["files"])) for k in list(VAR)[1:]]+[T["jobs"],T["mac_jobs"],T["db_jobs"],round(T["linux_min"],1),round(T["macos_min"],1),round(T["windows_min"],1)])
