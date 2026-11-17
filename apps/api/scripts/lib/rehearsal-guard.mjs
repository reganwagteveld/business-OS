// Target guard for scripts/search-index-rehearsal.mjs (docs/search-index-migration.md §2; ChatGPT audit of
// PR #97, HIGH). The rehearsal seeds data, writes and runs `prisma migrate deploy`, so it must PROVE its
// target is disposable before it touches anything. It fails closed: any doubt, missing input or API error
// refuses. Two targets are accepted:
//
//   local       every URL is a loopback host or a local socket (a developer or CI database);
//   neon-branch the Neon control plane (API key held by the operator) confirms that the named branch is a
//               temporary rehearsal branch: explicitly not the default branch, explicitly not protected, named
//               `rehearsal-search-indexes-…`, created within the last 72 hours (and not in the future beyond 5 minutes of clock skew); that every URL's host is
//               one of THAT branch's endpoints; and, independently, that no URL's host is an endpoint of
//               the project's default (production) branch.
//
// Nothing here trusts an operator-typed "disposable" flag or a repeated host string.

export const BRANCH_NAME_PATTERN = /^rehearsal-search-indexes-[a-z0-9-]{1,40}$/;
export const MAX_BRANCH_AGE_HOURS = 72;
/** Tolerated difference between this machine's clock and Neon's for a just-created branch. */
export const CLOCK_SKEW_MINUTES = 5;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '']);
const NEON_API = 'https://console.neon.tech/api/v2';

export class RehearsalTargetError extends Error {}
const refuse = (reason) => {
  throw new RehearsalTargetError(reason);
};

/** A Neon pooled host (`ep-x-pooler.region…`) and its direct host name the same endpoint. */
export function endpointHost(hostname) {
  const [first, ...rest] = hostname.toLowerCase().split('.');
  return [first.replace(/-pooler$/, ''), ...rest].join('.');
}

function parse(label, value) {
  if (!value) refuse(`${label} is not set.`);
  let u;
  try {
    u = new URL(value);
  } catch {
    refuse(`${label} is not a valid URL.`);
  }
  if (!/^postgres(ql)?:$/.test(u.protocol)) refuse(`${label} is not a PostgreSQL URL.`);
  if (!u.pathname || u.pathname === '/') refuse(`${label} names no database.`);
  return { label, host: endpointHost(u.hostname), database: u.pathname, user: decodeURIComponent(u.username || '') };
}

async function neonGet(fetchImpl, apiKey, path) {
  let res;
  try {
    res = await fetchImpl(`${NEON_API}${path}`, { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' } });
  } catch {
    refuse('The Neon API could not be reached, so the branch cannot be verified.');
  }
  if (!res.ok) refuse(`The Neon API answered ${res.status}, so the branch cannot be verified.`);
  try {
    return await res.json();
  } catch {
    refuse('The Neon API answered with something that is not JSON.');
  }
}

/**
 * Verifies the rehearsal target or throws RehearsalTargetError. Inputs:
 *   urls: { owner, app, admin }   the three rehearsal URLs
 *   env:  process.env-like object  (NEON_API_KEY, NEON_PROJECT_ID, REHEARSAL_NEON_BRANCH_ID, production URLs)
 *   fetchImpl: fetch               injectable for tests
 *   now:  Date                     injectable for tests
 * Returns { mode: 'local' } or { mode: 'neon-branch', branchName }.
 */
export async function verifyRehearsalTarget({ urls, env, fetchImpl = globalThis.fetch, now = new Date() }) {
  const owner = parse('REHEARSAL_DATABASE_URL', urls.owner);
  const app = parse('REHEARSAL_APP_DATABASE_URL', urls.app);
  const admin = parse('REHEARSAL_ADMIN_DATABASE_URL', urls.admin);
  const all = [owner, app, admin];

  // One database, three distinct roles: the writers must not run as the owner or the admin.
  if (new Set(all.map((u) => u.host)).size !== 1) refuse('The three rehearsal URLs point at different hosts.');
  if (new Set(all.map((u) => u.database)).size !== 1) refuse('The three rehearsal URLs point at different databases.');
  if (!app.user || app.user === owner.user || app.user === admin.user) refuse('The app URL must use the app role, distinct from the owner and admin roles.');

  // Independent of Neon: a production URL present in this shell must never be the target.
  for (const key of ['DATABASE_URL', 'MIGRATION_DATABASE_URL', 'AUTH_DATABASE_URL', 'ADMIN_DATABASE_URL', 'PRODUCTION_DATABASE_URL']) {
    if (!env[key]) continue;
    let other;
    try {
      other = new URL(env[key]);
    } catch {
      continue;
    }
    if (!LOCAL_HOSTS.has(other.hostname) && endpointHost(other.hostname) === owner.host) refuse(`The rehearsal host is the host of ${key}.`);
  }

  if (all.every((u) => LOCAL_HOSTS.has(u.host))) return { mode: 'local' };
  if (all.some((u) => LOCAL_HOSTS.has(u.host))) refuse('Mixed local and remote URLs.');

  const apiKey = env.NEON_API_KEY;
  const projectId = env.NEON_PROJECT_ID;
  const branchId = env.REHEARSAL_NEON_BRANCH_ID;
  if (!apiKey || !projectId || !branchId) refuse('A remote rehearsal needs NEON_API_KEY, NEON_PROJECT_ID and REHEARSAL_NEON_BRANCH_ID to verify the branch.');
  const p = encodeURIComponent(projectId);
  const b = encodeURIComponent(branchId);

  const { branch } = (await neonGet(fetchImpl, apiKey, `/projects/${p}/branches/${b}`)) ?? {};
  if (!branch || branch.id !== branchId) refuse('The Neon API did not return the named branch.');
  // Fail closed on missing or malformed metadata: both flags must be present and explicitly false.
  if (branch.default !== false || branch.primary === true) refuse('The named branch is the project default (production) branch, or its default flag is missing.');
  if (branch.protected !== false) refuse('The named branch is protected, or its protection flag is missing.');
  if (!BRANCH_NAME_PATTERN.test(branch.name ?? '')) refuse('The named branch is not a temporary rehearsal branch (rehearsal-search-indexes-…).');
  const created = Date.parse(branch.created_at ?? '');
  if (!Number.isFinite(created) || now.getTime() - created > MAX_BRANCH_AGE_HOURS * 3600_000) refuse(`The named branch is older than ${MAX_BRANCH_AGE_HOURS} hours or has no creation time.`);
  if (created - now.getTime() > CLOCK_SKEW_MINUTES * 60_000) refuse('The named branch has a creation time in the future.');

  const { branches } = (await neonGet(fetchImpl, apiKey, `/projects/${p}/branches`)) ?? {};
  const defaults = (branches ?? []).filter((x) => x.default === true || x.primary === true);
  if (defaults.length !== 1) refuse('The project default branch could not be identified.');
  if (defaults[0].id === branchId) refuse('The named branch is the project default (production) branch.');

  const { endpoints: own } = (await neonGet(fetchImpl, apiKey, `/projects/${p}/branches/${b}/endpoints`)) ?? {};
  const ownHosts = new Set((own ?? []).map((e) => endpointHost(e.host ?? '')));
  if (!ownHosts.has(owner.host)) refuse('The rehearsal host is not an endpoint of the named branch.');

  const { endpoints: prod } = (await neonGet(fetchImpl, apiKey, `/projects/${p}/branches/${encodeURIComponent(defaults[0].id)}/endpoints`)) ?? {};
  if ((prod ?? []).some((e) => endpointHost(e.host ?? '') === owner.host)) refuse('The rehearsal host is an endpoint of the production branch.');

  return { mode: 'neon-branch', branchName: branch.name };
}

/**
 * Removes anything that names the rehearsal target from tool output before it reaches a report or the console:
 * connection URLs, the target host (and its pooled form) and any Neon endpoint host.
 */
export function redactTarget(text, host) {
  let out = String(text ?? '').replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgresql://<redacted>');
  for (const h of new Set([host, host && endpointHost(host)].filter(Boolean))) out = out.split(h).join('<redacted-host>');
  return out.replace(/\bep-[a-z0-9-]+(?:\.[a-z0-9-]+)*\.neon\.tech\b/gi, '<redacted-host>');
}
