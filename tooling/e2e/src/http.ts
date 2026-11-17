// A minimal real-HTTP client: every call goes over the network to the built API server, with a per-actor
// cookie jar, a distinct client address (so per-IP rate limits never couple unrelated actors) and an
// Idempotency-Key on POSTs (payments require one; other routes ignore it).
import { randomUUID } from 'node:crypto';
import { env } from './env';

const ORIGIN = new URL(env.apiUrl).origin;
let addr = 1 + Math.floor(Math.random() * 60_000);
const nextAddress = () => `100.${64 + (Math.floor(addr / 65_025) % 60)}.${Math.floor(addr / 255) % 255}.${(addr++ % 254) + 1}`;

export interface ApiResult<T = any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  status: number;
  body: T;
  headers: Headers;
}

export class Client {
  private cookies = new Map<string, string>();
  readonly address = nextAddress();

  async request<T = any>(method: string, path: string, opts: { body?: unknown; idempotencyKey?: string | null; headers?: Record<string, string> } = {}): Promise<ApiResult<T>> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const headers = new Headers({ 'x-forwarded-for': this.address, origin: ORIGIN, ...opts.headers });
    if (this.cookies.size) headers.set('cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    if (opts.body !== undefined) headers.set('content-type', 'application/json');
    if (method === 'POST' && opts.idempotencyKey !== null) headers.set('idempotency-key', opts.idempotencyKey ?? randomUUID());
    const res = await fetch(`${env.apiUrl}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const eq = pair!.indexOf('=');
      const name = pair!.slice(0, eq);
      const value = pair!.slice(eq + 1);
      if (value) this.cookies.set(name, value);
      else this.cookies.delete(name);
    }
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: res.status, body: body as T, headers: res.headers };
  }

  get = <T = any>(path: string) => this.request<T>('GET', path); // eslint-disable-line @typescript-eslint/no-explicit-any
  post = <T = any>(path: string, body?: unknown, idempotencyKey?: string | null) => this.request<T>('POST', path, { body: body ?? {}, idempotencyKey }); // eslint-disable-line @typescript-eslint/no-explicit-any
  patch = <T = any>(path: string, body: unknown) => this.request<T>('PATCH', path, { body }); // eslint-disable-line @typescript-eslint/no-explicit-any
  delete = <T = any>(path: string) => this.request<T>('DELETE', path); // eslint-disable-line @typescript-eslint/no-explicit-any

  hasSession(): boolean {
    return [...this.cookies.keys()].some((k) => /session_token$/.test(k));
  }
}
