import { MeResponse } from '@business-os/contracts';
import { NextResponse } from 'next/server';
import { apiHeaders, preflight } from '@/core/http';
import { getCurrentUser } from '@/modules/identity';

export const dynamic = 'force-dynamic';

/** The signed-in user (contract: endpoints.me). Browser: session cookie. Desktop: bearer token. */
export async function GET(request: Request) {
  const user = await getCurrentUser(request);
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401, headers: apiHeaders(request) });
  return NextResponse.json(MeResponse.parse({ user }), { headers: apiHeaders(request) });
}

export function OPTIONS(request: Request) {
  return preflight(request);
}
