import { exchangeDesktopCode } from '@/modules/identity';
import { apiHeaders, preflight } from '@/core/http';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const response = await exchangeDesktopCode(request);
  for (const [k, v] of Object.entries(apiHeaders(request))) if (!response.headers.has(k)) response.headers.set(k, v);
  return response;
}
export function OPTIONS(request: Request) {
  return preflight(request);
}
