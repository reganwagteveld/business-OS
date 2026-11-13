import 'server-only';
import { getEnv } from '@/core/config/env';
import { getAuth } from './auth-adapter';
import { authHeaders } from './session';

/** Browsers always send Origin on cross-site POSTs; only our own app origins may change auth state. */
function originAllowed(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin || request.method === 'GET' || request.method === 'HEAD') return true;
  const env = getEnv();
  return origin === new URL(env.APP_BASE_URL).origin || env.CORS_ALLOWED_ORIGINS.includes(origin);
}

/** Passes a request under /api/v1/auth to Better Auth, with desktop bearer tokens converted. */
export async function handleAuthRequest(request: Request): Promise<Response> {
  if (!originAllowed(request)) return Response.json({ error: 'forbidden_origin' }, { status: 403 });
  const headers = await authHeaders(request);
  const forwarded = new Request(request.url, {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer(),
  });
  return getAuth().handler(forwarded);
}
