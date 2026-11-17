/**
 * INFRA-VC-1: the browser app's Vercel "Ignored Build Step" (scripts/vercel/ignore-build.sh) and the
 * Vercel project configuration it depends on. Vercel's contract: exit 0 skips a deployment, exit 1
 * builds. Every case that is not a provably docs-only or API-only preview must build (fail open).
 * Each case runs the real script against a throwaway git repository; nothing here contacts Vercel.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(ROOT, 'scripts/vercel/ignore-build.sh');
const SKIP = 0;
const BUILD = 1;

const temps: string[] = [];
afterAll(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'vc-ignore-'));
  temps.push(d);
  return d;
};

const gitEnv = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: tmpdir(),
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1',
};

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function write(repo: string, path: string, content = `${path} ${Math.random()}\n`) {
  const full = join(repo, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/** A repository whose main branch has a commit touching every area, plus a feature branch. */
function repoWithBase(): { repo: string; base: string } {
  const repo = tempDir();
  git(repo, 'init', '-q', '-b', 'main');
  for (const p of ['README.md', 'docs/a.md', 'apps/web/src/main.tsx', 'apps/api/src/route.ts', 'packages/ui/src/x.tsx', 'pnpm-lock.yaml']) write(repo, p);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', '-b', 'feature');
  return { repo, base };
}

function change(repo: string, paths: string[]) {
  paths.forEach((p) => write(repo, p));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'change');
}

function run(cwd: string, env: Record<string, string>) {
  const r = spawnSync('bash', [SCRIPT], { cwd, env: { ...gitEnv, ...env }, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const preview = (prev: string) => ({ VERCEL_ENV: 'preview', VERCEL_GIT_PREVIOUS_SHA: prev });

describe('ignore-build.sh: previews that may skip', () => {
  const skippable: Array<[string, string[]]> = [
    ['docs markdown', ['docs/guide.md']],
    ['docs image and root markdown', ['docs/ui/shot.png', 'CLAUDE.md']],
    ['API source', ['apps/api/src/modules/x/route.ts']],
    ['API migration and tests', ['apps/api/prisma/migrations/20990101000000_x/migration.sql', 'apps/api/tests/x.test.ts']],
    ['API vercel.json and package.json', ['apps/api/vercel.json', 'apps/api/package.json']],
    ['docs and API together', ['docs/x.md', 'apps/api/src/y.ts']],
  ];
  it.each(skippable)('%s skips', (_name, paths) => {
    const { repo, base } = repoWithBase();
    change(repo, paths);
    const r = run(repo, preview(base));
    expect(r.out).toContain('skip');
    expect(r.status).toBe(SKIP);
  });
});

describe('ignore-build.sh: everything else builds', () => {
  const building: Array<[string, string[]]> = [
    ['web source', ['apps/web/src/main.tsx']],
    ['web vercel.json', ['apps/web/vercel.json']],
    ['shared app package', ['packages/app/src/shell/x.tsx']],
    ['shared ui package', ['packages/ui/src/x.tsx']],
    ['contracts', ['packages/contracts/src/x.ts']],
    ['lockfile', ['pnpm-lock.yaml']],
    ['root manifest', ['package.json']],
    ['workspace definition', ['pnpm-workspace.yaml']],
    ['node version', ['.nvmrc']],
    ['root tsconfig', ['tsconfig.base.json']],
    ['this script', ['scripts/vercel/ignore-build.sh']],
    ['CI workflow', ['.github/workflows/ci.yml']],
    ['tooling', ['tooling/visual/x.ts']],
    ['desktop', ['apps/desktop/src/main.tsx']],
    ['non-documentation file under docs', ['docs/data.json']],
    ['nested markdown outside docs', ['packages/ui/README.md']],
    ['docs plus one web file', ['docs/x.md', 'apps/web/src/y.tsx']],
    ['API plus lockfile', ['apps/api/package.json', 'pnpm-lock.yaml']],
    ['unknown top-level path', ['something-new/file.txt']],
  ];
  it.each(building)('%s builds', (_name, paths) => {
    const { repo, base } = repoWithBase();
    change(repo, paths);
    expect(run(repo, preview(base)).status).toBe(BUILD);
  });

  it('production always builds, even for docs-only changes', () => {
    const { repo, base } = repoWithBase();
    change(repo, ['docs/x.md']);
    expect(run(repo, { VERCEL_ENV: 'production', VERCEL_GIT_PREVIOUS_SHA: base }).status).toBe(BUILD);
  });

  it('a missing or unknown VERCEL_ENV builds', () => {
    const { repo, base } = repoWithBase();
    change(repo, ['docs/x.md']);
    expect(run(repo, { VERCEL_GIT_PREVIOUS_SHA: base }).status).toBe(BUILD);
    expect(run(repo, { VERCEL_ENV: 'development', VERCEL_GIT_PREVIOUS_SHA: base }).status).toBe(BUILD);
  });

  it('an empty diff builds', () => {
    const { repo, base } = repoWithBase();
    change(repo, []);
    expect(run(repo, preview(base)).status).toBe(BUILD);
  });

  it('a malformed previous SHA builds', () => {
    const { repo } = repoWithBase();
    change(repo, ['docs/x.md']);
    expect(run(repo, preview('not-a-sha; rm -rf /')).status).toBe(BUILD);
  });

  it('an unknown previous SHA with no remote builds', () => {
    const { repo } = repoWithBase();
    change(repo, ['docs/x.md']);
    expect(run(repo, preview('0123456789abcdef0123456789abcdef01234567')).status).toBe(BUILD);
  });

  it('no previous deployment and no reachable main builds', () => {
    const { repo } = repoWithBase();
    change(repo, ['docs/x.md']);
    expect(run(repo, { VERCEL_ENV: 'preview', VERCEL_IGNORE_BUILD_REMOTE: join(tempDir(), 'missing.git') }).status).toBe(BUILD);
  });

  it('outside a git repository builds', () => {
    expect(run(tempDir(), preview('0123456789abcdef0123456789abcdef01234567')).status).toBe(BUILD);
  });
});

describe('ignore-build.sh: first deployment of a branch compares with main', () => {
  function withRemote() {
    const { repo, base } = repoWithBase();
    const remote = join(tempDir(), 'remote.git');
    git(repo, 'clone', '-q', '--bare', repo, remote);
    git(remote, 'update-ref', 'refs/heads/main', base);
    return { repo, remote };
  }

  it('docs-only branch skips', () => {
    const { repo, remote } = withRemote();
    change(repo, ['docs/x.md']);
    expect(run(repo, { VERCEL_ENV: 'preview', VERCEL_IGNORE_BUILD_REMOTE: remote }).status).toBe(SKIP);
  });

  it('web branch builds', () => {
    const { repo, remote } = withRemote();
    change(repo, ['apps/web/src/x.tsx']);
    expect(run(repo, { VERCEL_ENV: 'preview', VERCEL_IGNORE_BUILD_REMOTE: remote }).status).toBe(BUILD);
  });

  it('an unknown previous SHA falls back to main', () => {
    const { repo, remote } = withRemote();
    change(repo, ['docs/x.md']);
    const r = run(repo, { ...preview('0123456789abcdef0123456789abcdef01234567'), VERCEL_IGNORE_BUILD_REMOTE: remote });
    expect(r.status).toBe(SKIP);
  });
});

describe('Vercel configuration and the skip rules stay consistent', () => {
  const readJson = (p: string) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
  const fnBody = (file: string, name: string) => {
    const src = readFileSync(join(ROOT, file), 'utf8');
    const m = src.match(new RegExp(`${name}\\(\\) \\{[^\\n]*\\n([\\s\\S]*?)\\n\\}`));
    if (!m) throw new Error(`${name} not found in ${file}`);
    return (m[1] ?? '').split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean).join('\n');
  };

  it('the documentation allow-list matches the CI classifier exactly', () => {
    expect(fnBody('scripts/vercel/ignore-build.sh', 'is_docs')).toBe(fnBody('.github/scripts/classify-changes.sh', 'is_docs'));
  });

  it('the browser app never depends on the API package (API-only changes cannot affect it)', () => {
    const byName = new Map<string, string>();
    for (const dir of ['apps/api', 'apps/web', 'apps/desktop', 'packages/app', 'packages/ui', 'packages/contracts']) {
      byName.set(readJson(`${dir}/package.json`).name, dir);
    }
    const closure = new Set<string>();
    const visit = (dir: string) => {
      if (closure.has(dir)) return;
      closure.add(dir);
      const pkg = readJson(`${dir}/package.json`);
      for (const deps of [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies]) {
        for (const [name, version] of Object.entries(deps ?? {})) {
          if (String(version).startsWith('workspace:')) {
            const target = byName.get(name);
            if (!target) throw new Error(`unknown workspace dependency ${name}; add it to this test`);
            visit(target);
          }
        }
      }
    };
    visit('apps/web');
    expect([...closure].sort()).toEqual(['apps/web', 'packages/app', 'packages/contracts', 'packages/ui']);
    expect([...closure].some((d) => d.startsWith('apps/api'))).toBe(false);
  });

  it('the browser app wires the ignore script and keeps every deployment enabled', () => {
    const web = readJson('apps/web/vercel.json');
    expect(web.ignoreCommand).toContain('scripts/vercel/ignore-build.sh');
    expect(web.ignoreCommand.length).toBeLessThanOrEqual(256);
    expect(web.git?.deploymentEnabled).toBeUndefined();
    expect(existsSync(SCRIPT)).toBe(true);
  });

  it('the API project deploys main only: production stays on, previews are off', () => {
    const api = readJson('apps/api/vercel.json');
    expect(api.git.deploymentEnabled).toEqual({ main: true, '**': false });
    expect(api.ignoreCommand).toBeUndefined();
    expect(api.framework).toBe('nextjs');
    expect(api.regions).toEqual(['iad1']);
  });
});
