import pg from 'pg';

/**
 * Deterministic coordination for concurrency tests. Instead of sleeping and hoping the other
 * transaction has reached its lock by then, these helpers ask PostgreSQL directly which sessions
 * are waiting on which (pg_blocking_pids), so a test proceeds exactly when the interleaving it
 * describes exists, however slow the machine is.
 */

export async function backendPid(client: pg.Client): Promise<number> {
  return (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
}

/** Sessions waiting on `holderPid`, directly or through a chain of waiters (A waits on B waits on holder). */
const WAITERS = `
  WITH RECURSIVE waiting(pid) AS (
    SELECT pid FROM pg_stat_activity WHERE $1::int = ANY (pg_blocking_pids(pid))
    UNION
    SELECT a.pid FROM pg_stat_activity a JOIN waiting w ON w.pid = ANY (pg_blocking_pids(a.pid))
  )
  SELECT count(*)::int AS n FROM waiting`;

/**
 * Resolves once at least `count` sessions are blocked, directly or transitively, behind locks held
 * by `holderPid`. Polls from a superuser connection (`observer`) that takes no locks itself. The
 * deadline only turns a hang into a readable failure; it never decides a passing outcome. Pass an
 * AbortSignal to stop waiting (resolves to false) when a race against another outcome is settled.
 */
export async function waitUntilBlocked(
  observer: pg.Client,
  holderPid: number,
  { count = 1, signal, deadlineMs = 15_000 }: { count?: number; signal?: AbortSignal; deadlineMs?: number } = {},
): Promise<boolean> {
  const giveUpAt = Date.now() + deadlineMs;
  for (;;) {
    if (signal?.aborted) return false;
    const n = (await observer.query(WAITERS, [holderPid])).rows[0].n as number;
    if (n >= count) return true;
    if (Date.now() > giveUpAt) throw new Error(`expected ${count} session(s) blocked behind pid ${holderPid}, found ${n}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Settles a race between `work` finishing and `work` becoming blocked behind `holderPid`:
 * 'finished' if it completed without ever waiting on the holder, 'blocked' if it is waiting.
 */
export async function finishesOrBlocks(observer: pg.Client, holderPid: number, work: Promise<unknown>): Promise<'finished' | 'blocked'> {
  const stop = new AbortController();
  try {
    return await Promise.race([
      work.then(() => 'finished' as const),
      waitUntilBlocked(observer, holderPid, { signal: stop.signal }).then((blocked) => (blocked ? ('blocked' as const) : new Promise<never>(() => {}))),
    ]);
  } finally {
    stop.abort();
  }
}

/**
 * Row-lock ordering setup. An unordered scan of a heap meets rows in physical (ctid) order, so a
 * writer that did NOT lock in id order would block on the physically first row while holding
 * nothing. Returns the physically first row of `ids`, guaranteed not to be the lowest id: hold that
 * row, and an id-ordered writer must already hold the lowest id while it waits.
 *
 * PostgreSQL decides where a row version lands (heap-only updates reuse line pointers freed by page
 * pruning, so a new version can sort before older ones), so the order is read back, not assumed.
 * Only when the lowest id happens to be physically first is it rewritten to move it; the result is
 * checked every time.
 */
export async function physicallyFirstNotLowest(admin: pg.Client, ids: string[]): Promise<string> {
  const lowest = [...ids].sort()[0]!;
  for (let attempt = 0; attempt < 20; attempt++) {
    const order = (await admin.query('SELECT id FROM project_tasks WHERE id = ANY($1) ORDER BY ctid', [ids])).rows.map((r) => r.id as string);
    if (order.length !== ids.length) throw new Error('rows missing');
    if (order[0] !== lowest) return order[0]!;
    await admin.query('UPDATE project_tasks SET updated_at = updated_at WHERE id = $1', [lowest]);
  }
  throw new Error('could not place a row other than the lowest id first in the heap');
}

/**
 * The row a writer WITHOUT `ORDER BY id` would lock first: runs the writer's own predicate, unordered,
 * as the application role in the tenant's context, so PostgreSQL picks the same kind of plan (a
 * sequential scan meets rows in heap order; an index scan in index order). Holding that row makes an
 * unordered writer block while holding nothing, which the lowest-id probe then catches. If that row
 * is the lowest id (an unordered writer would then lock it first by luck), falls back to the
 * physically first row that is not the lowest. Either way the result is never the lowest id, so a
 * correct, id-ordered writer always holds the lowest id while it waits.
 */
export async function firstLockedByUnorderedScan(
  admin: pg.Client,
  tenant: { connectionString: string; businessId: string; userId: string },
  predicate: { sql: string; params: unknown[] },
  ids: string[],
): Promise<string> {
  const lowest = [...ids].sort()[0]!;
  const c = new pg.Client({ connectionString: tenant.connectionString });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.business_id', $1, true), set_config('app.user_id', $2, true)", [tenant.businessId, tenant.userId]);
    const first = (await c.query(`SELECT id FROM project_tasks WHERE ${predicate.sql}`, predicate.params)).rows[0]?.id as string | undefined;
    await c.query('ROLLBACK');
    if (first && first !== lowest && ids.includes(first)) return first;
  } finally {
    await c.end();
  }
  return physicallyFirstNotLowest(admin, ids);
}
