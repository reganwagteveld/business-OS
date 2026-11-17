# CIQ-A5 replay, step 1: read-only fetch of CI runs, jobs, merged PRs, commits, files and ready_for_review events
# from the GitHub REST API into prs.json, runs.json, jobs.json (files.json: see the loop at the end). Run: python3 replay-fetch.py
import json, urllib.request, os, sys, time
A="https://api.github.com/repos/reganwagteveld/business-OS"
def get(url):
    for i in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"Accept":"application/vnd.github+json"}), timeout=60) as r:
                return json.load(r)
        except Exception as e:
            print("retry",url,e,file=sys.stderr); time.sleep(2+i*3)
    raise SystemExit("failed "+url)
def pages(url, key=None, maxp=30):
    out=[]
    for p in range(1,maxp+1):
        d=get(url+("&" if "?" in url else "?")+f"per_page=100&page={p}")
        items=d[key] if key else d
        out+=items
        if len(items)<100: break
    return out
SINCE="2026-11-15T00:00:00Z"
prs=[p for p in pages(f"{A}/pulls?state=closed&sort=updated&direction=desc",maxp=5) if p.get("merged_at") and p["merged_at"]>=SINCE]
print("merged PRs",len(prs),file=sys.stderr)
runs=pages(f"{A}/actions/workflows/ci.yml/runs?created=>={SINCE}","workflow_runs",maxp=30)
print("ci runs",len(runs),file=sys.stderr)
json.dump(runs,open("runs.json","w"))
data={}
for p in prs:
    n=p["number"]
    commits=pages(f"{A}/pulls/{n}/commits",maxp=3)
    tl=pages(f"{A}/issues/{n}/timeline",maxp=5)
    ev=[{"event":e.get("event"),"at":e.get("created_at")} for e in tl if e.get("event") in("ready_for_review","convert_to_draft","converted_to_draft")]
    data[n]={"number":n,"title":p["title"],"created_at":p["created_at"],"merged_at":p["merged_at"],"head_ref":p["head"]["ref"],"head_sha":p["head"]["sha"],
      "merge_sha":p["merge_commit_sha"],
      "commits":[{"sha":c["sha"],"parents":len(c["parents"]),"msg":c["commit"]["message"].split("\n")[0][:80],"date":c["commit"]["committer"]["date"]} for c in commits],
      "timeline":ev}
json.dump(data,open("prs.json","w"))
# jobs for every PR-event and push-main run
jobs={}
for r in runs:
    if r["status"]!="completed": continue
    att=r["run_attempt"]
    js=[]
    for a in range(1,att+1):
        js+= [dict(j,attempt=a) for j in pages(f"{A}/actions/runs/{r['id']}/attempts/{a}/jobs","jobs",maxp=2)]
    jobs[r["id"]]=[{"name":j["name"],"attempt":j["attempt"],"conclusion":j["conclusion"],"started":j["started_at"],"completed":j["completed_at"],"labels":j["labels"],"runner":j.get("runner_name")} for j in js]
json.dump(jobs,open("jobs.json","w"))
print("done",file=sys.stderr)

# changed files per merged PR
p=json.load(open("prs.json")); out={}
for n in p:
    fs=[]
    for pg in range(1,6):
        with urllib.request.urlopen(f"{A}/pulls/{n}/files?per_page=100&page={pg}",timeout=60) as r: d=json.load(r)
        fs+=[f["filename"] for f in d]
        if len(d)<100: break
    out[n]=fs
json.dump(out,open("files.json","w"))
