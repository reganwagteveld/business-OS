import { handleAuthRequest } from '@/modules/identity';
import { apiHeaders, preflight } from '@/core/http';

export const dynamic = 'force-dynamic';

async function handle(request: Request) {
  const response = await handleAuthRequest(request);
  for (const [k, v] of Object.entries(apiHeaders(request))) if (!response.headers.has(k)) response.headers.set(k, v);
  return response;
}

export const GET = handle;
export const POST = handle;
export function OPTIONS(request: Request) {
  return preflight(request);
}
