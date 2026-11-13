import 'server-only';
// Hashed storage for bearer secrets (ADR 0001 condition 1, data-model §5.5).
//
// Better Auth 1.7 stores the raw session token. This wrapper sits between Better Auth and its
// Prisma adapter so the database only ever holds hex(sha256(token)):
//   - writes: a session's token is hashed before it is stored; the caller gets the raw token back
//   - lookups by token: the value is hashed, and the row comes back carrying the raw token
//   - rows read without a token filter (e.g. "list my sessions") carry an internal reference
//     "h:<hash>" instead, which only this wrapper resolves. It cannot be used to sign in: session
//     cookies and desktop bearer tokens must carry a valid HMAC signature of the raw token.
// The same applies to password-reset and desktop sign-in codes kept in `verifications`.
import { createHash } from 'node:crypto';

type Where = { field: string; value: unknown; operator?: string; connector?: string };
type Row = Record<string, unknown>;
// The subset of Better Auth's DBAdapter this wrapper touches. Every other member passes through.
type Adapter = Record<string, unknown> & {
  transaction?: <R>(cb: (trx: Adapter) => Promise<R>) => Promise<R>;
};

const HASH = /^[0-9a-f]{64}$/;
export const SESSION_REF_PREFIX = 'h:';
const HASHED_VERIFICATION_PREFIXES = ['reset-password:', 'desktop-code:'];

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hashToken(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (value.startsWith(SESSION_REF_PREFIX) && HASH.test(value.slice(SESSION_REF_PREFIX.length))) {
    return value.slice(SESSION_REF_PREFIX.length);
  }
  return sha256Hex(value);
}

function hashIdentifier(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const prefix = HASHED_VERIFICATION_PREFIXES.find((p) => value.startsWith(p));
  return prefix ? prefix + sha256Hex(value.slice(prefix.length)) : value;
}

function mapWhere(model: string, where: Where[] | undefined): { where: Where[] | undefined; rawToken?: string } {
  if (!where) return { where };
  let rawToken: string | undefined;
  const mapped = where.map((w) => {
    if (model === 'session' && w.field === 'token') {
      if (typeof w.value === 'string' && (!w.operator || w.operator === 'eq')) rawToken = w.value;
      const value = Array.isArray(w.value) ? w.value.map(hashToken) : hashToken(w.value);
      return { ...w, value };
    }
    if (model === 'verification' && w.field === 'identifier') {
      const value = Array.isArray(w.value) ? w.value.map(hashIdentifier) : hashIdentifier(w.value);
      return { ...w, value };
    }
    return w;
  });
  return { where: mapped, rawToken };
}

function mapData(model: string, data: Row | undefined): Row | undefined {
  if (!data) return data;
  if (model === 'session' && typeof data.token === 'string') return { ...data, token: sha256Hex(data.token) };
  if (model === 'verification' && typeof data.identifier === 'string') return { ...data, identifier: hashIdentifier(data.identifier) };
  return data;
}

function mapRow(model: string, row: unknown, rawToken?: string): unknown {
  if (model !== 'session' || !row || typeof row !== 'object') return row;
  const r = row as Row;
  if (typeof r.token !== 'string') return row;
  return { ...r, token: rawToken !== undefined && sha256Hex(rawToken) === r.token ? rawToken : SESSION_REF_PREFIX + r.token };
}

function mapResult(model: string, result: unknown, rawToken?: string): unknown {
  return Array.isArray(result) ? result.map((row) => mapRow(model, row, rawToken)) : mapRow(model, result, rawToken);
}

type Call = { model: string; where?: Where[]; data?: Row; update?: Row } & Row;

export function withHashedSecrets<A extends Adapter>(inner: A): A {
  const wrap = (name: string) => {
    const fn = inner[name];
    if (typeof fn !== 'function') return fn;
    return async (args: Call) => {
      const { where, rawToken } = mapWhere(args.model, args.where);
      const next: Call = { ...args, ...(args.where ? { where } : {}) };
      if (name === 'create') {
        const raw = args.model === 'session' && typeof args.data?.token === 'string' ? args.data.token : undefined;
        next.data = mapData(args.model, args.data);
        return mapResult(args.model, await (fn as (a: Call) => Promise<unknown>).call(inner, next), raw);
      }
      if (args.update) next.update = mapData(args.model, args.update);
      return mapResult(args.model, await (fn as (a: Call) => Promise<unknown>).call(inner, next), rawToken);
    };
  };
  const methods = ['create', 'findOne', 'findMany', 'count', 'update', 'updateMany', 'delete', 'deleteMany', 'consumeOne', 'incrementOne'];
  const wrapped: Adapter = { ...inner };
  for (const name of methods) if (name in inner) wrapped[name] = wrap(name);
  if (typeof inner.transaction === 'function') {
    wrapped.transaction = (cb) => inner.transaction!((trx) => cb(withHashedSecrets(trx)));
  }
  return wrapped as A;
}
