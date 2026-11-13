import 'server-only';
// Unit of work for tenant data (docs/data-model.md §5.3, ADR 0004).
//
// Every tenant query runs inside ONE Prisma interactive transaction. Its first statement sets the
// transaction-local tenant context with set_config(..., true); every later statement uses the same
// transaction client and therefore the same pooled connection, so the context cannot leak to
// another request and a transaction-mode pooler cannot split it across server connections.
//
// Layers enforced here: the context is set and checked (fail closed), and the transaction client
// handed to services is narrowed and scoped to the tenant (layer 3). Row-Level Security in the
// database (layer 4) and composite foreign keys (layer 5) hold independently of this code.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Verified server-side identity of the tenant for one unit of work. Never built from client input. */
export interface TenantContext {
  readonly businessId: string;
  /** Empty for system work (scheduled jobs). */
  readonly userId?: string | null;
}

/** Which database role the unit of work runs as. "jobs" is for scheduled purge work only. */
export type TenantRole = 'app' | 'jobs';

export class TenantContextError extends Error {
  constructor(message = 'Tenant context could not be established') {
    super(message);
    this.name = 'TenantContextError';
  }
}

export class TenantScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantScopeError';
  }
}

type IsolationLevel = 'ReadCommitted';

/** The part of a generated Prisma client this module relies on. */
export interface TransactionalClient<Tx> {
  $transaction<R>(
    fn: (tx: Tx) => PromiseLike<R>,
    options?: { maxWait?: number; timeout?: number; isolationLevel?: IsolationLevel },
  ): PromiseLike<R>;
}

interface RawQueryable {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): PromiseLike<T>;
}

declare const tenantBrand: unique symbol;

/**
 * What a module service receives: the tenant models it may use and tagged `$queryRaw`, nothing
 * else (no `$transaction`, no `$executeRawUnsafe`/`$queryRawUnsafe`). The brand makes a plain
 * client, or a transaction opened elsewhere, unassignable, so a service cannot run tenant queries
 * outside `withTenant` (spike test S3).
 */
export type TenantDb<Tx, M extends keyof Tx> = Pick<Tx, M | Extract<'$queryRaw', keyof Tx>> & {
  readonly [tenantBrand]: TenantContext;
};

/** Tenant models and the column that holds the tenant id (`businesses` uses its own id). */
export type TenantModels<Tx> = Partial<Record<keyof Tx & string, string>>;

export interface WithTenantOptions {
  role?: TenantRole;
  timeoutMs?: number;
}

export interface TenantRunnerConfig<Tx, M extends keyof Tx & string> {
  clients: { app: TransactionalClient<Tx>; jobs?: TransactionalClient<Tx> };
  models: Record<M, string>;
  /**
   * Test seam for spike test S8 only: proves Row-Level Security holds with the application-layer
   * scope disabled. Production wiring never sets it.
   */
  disableScopeGuardForIsolationTests?: boolean;
}

const DEFAULT_TIMEOUT_MS = 5_000;

export function createWithTenant<Tx extends RawQueryable, M extends keyof Tx & string>(config: TenantRunnerConfig<Tx, M>) {
  return async function withTenant<T>(
    ctx: TenantContext,
    work: (db: TenantDb<Tx, M>) => Promise<T>,
    opts: WithTenantOptions = {},
  ): Promise<T> {
    const role = opts.role ?? 'app';
    const client = config.clients[role];
    if (!client) throw new TenantContextError(`No database client configured for role "${role}"`);
    if (!UUID.test(ctx.businessId)) throw new TenantContextError();
    const userId = ctx.userId ?? '';
    if (userId !== '' && !UUID.test(userId)) throw new TenantContextError();

    return client.$transaction(
      async (tx) => {
        // set_config returns a row, so it goes through tagged $queryRaw. One round trip sets both
        // values; the returned values are checked so a silently ignored call fails closed.
        const rows = await tx.$queryRaw<{ business_id: string; user_id: string }[]>`
          SELECT set_config('app.business_id', ${ctx.businessId}::text, true) AS business_id,
                 set_config('app.user_id', ${userId}::text, true) AS user_id`;
        const row = rows[0];
        if (row?.business_id !== ctx.businessId || row.user_id !== userId) throw new TenantContextError();
        const db = config.disableScopeGuardForIsolationTests ? narrow(tx, config.models) : scopeToTenant(tx, ctx, config.models);
        return work(db as TenantDb<Tx, M>);
      },
      { timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, isolationLevel: 'ReadCommitted' },
    );
  };
}

// --- Layer 3: application-side tenant scope ---------------------------------------------------

const CREATE_OPS = new Set(['create', 'createMany', 'createManyAndReturn']);
const WHERE_OPS = new Set([
  'findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany', 'count', 'aggregate', 'groupBy',
  'update', 'updateMany', 'updateManyAndReturn', 'delete', 'deleteMany',
]);

type Args = Record<string, unknown> | undefined;

function checkData(data: unknown, column: string, businessId: string) {
  const rows = Array.isArray(data) ? data : [data];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const value = (row as Record<string, unknown>)[column];
    if (value !== undefined && value !== businessId) throw new TenantScopeError(`Write for another business rejected (${column})`);
  }
}

function scopeWhere(where: unknown, column: string, businessId: string) {
  const base = (where && typeof where === 'object' ? where : {}) as Record<string, unknown>;
  if (base[column] !== undefined && base[column] !== businessId) throw new TenantScopeError(`Query for another business rejected (${column})`);
  return { ...base, [column]: businessId };
}

function scopeDelegate(delegate: Record<string, unknown>, column: string, businessId: string) {
  return new Proxy(delegate, {
    get(target, op: string | symbol) {
      const fn = target[op as string];
      if (typeof op !== 'string' || typeof fn !== 'function') return fn;
      if (op === 'upsert') {
        return () => {
          throw new TenantScopeError('upsert is not available on tenant models; use create or update');
        };
      }
      return (args: Args) => {
        const next: Record<string, unknown> = { ...(args ?? {}) };
        if (CREATE_OPS.has(op)) {
          // A create without the tenant column gets it injected; a different value is rejected.
          if (Array.isArray(next.data)) {
            checkData(next.data, column, businessId);
            next.data = next.data.map((row) => ({ ...(row as object), [column]: businessId }));
          } else {
            checkData(next.data, column, businessId);
            next.data = { ...(next.data as object), [column]: businessId };
          }
        } else if (WHERE_OPS.has(op)) {
          next.where = scopeWhere(next.where, column, businessId);
          if ('data' in next) checkData(next.data, column, businessId);
        } else {
          throw new TenantScopeError(`Operation ${op} is not available on tenant models`);
        }
        return (fn as (a: unknown) => unknown).call(target, next);
      };
    },
  });
}

function scopeToTenant<Tx extends RawQueryable>(tx: Tx, ctx: TenantContext, models: Record<string, string>) {
  const db: Record<string | symbol, unknown> = { $queryRaw: tx.$queryRaw.bind(tx) };
  for (const [model, column] of Object.entries(models)) {
    db[model] = scopeDelegate((tx as unknown as Record<string, Record<string, unknown>>)[model]!, column, ctx.businessId);
  }
  return Object.freeze(db);
}

/** Only the narrowing, without the scope guard (isolation tests, S8). */
function narrow<Tx extends RawQueryable>(tx: Tx, models: Record<string, string>) {
  const db: Record<string | symbol, unknown> = { $queryRaw: tx.$queryRaw.bind(tx) };
  for (const model of Object.keys(models)) db[model] = (tx as unknown as Record<string, unknown>)[model];
  return Object.freeze(db);
}
