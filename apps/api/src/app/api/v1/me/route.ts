import { MeResponse, UpdateProfileRequest, UpdateProfileResponse } from '@business-os/contracts';
import { NextResponse } from 'next/server';
import { apiHeaders, preflight } from '@/core/http';
import { getCurrentUser, updateDisplayName } from '@/modules/identity';
import { publicRoute } from '../../_lib/routes';

export const dynamic = 'force-dynamic';

/**
 * The signed-in user (contract: endpoints.me). Browser: session cookie. Desktop: bearer token.
 * Deliberately not a publicRoute: it answers before admission and email verification, so the clients can tell
 * those states apart. A failure (database or auth library unavailable) still answers like every other route:
 * JSON 500 with the no-store and CORS headers, never a bare error the clients would read as "offline".
 */
export async function GET(request: Request) {
  try {
    const user = await getCurrentUser(request);
    if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401, headers: apiHeaders(request) });
    return NextResponse.json(MeResponse.parse({ user }), { headers: apiHeaders(request) });
  } catch (error) {
    console.error('[api] unexpected error', error instanceof Error ? error.name : typeof error);
    return NextResponse.json({ error: 'internal_error' }, { status: 500, headers: apiHeaders(request) });
  }
}

/**
 * Change your own display name (contract: endpoints.updateMe, Settings A3-A). Admission required, like every
 * account change (settings-a3 §15.2). The user is the verified session's; the body carries only `name`.
 */
export const PATCH = publicRoute({ input: UpdateProfileRequest, response: UpdateProfileResponse }, async ({ user, sessionToken, input }) => ({
  body: { user: await updateDisplayName({ userId: user.id, sessionToken, name: input.name }) },
}));

export function OPTIONS(request: Request) {
  return preflight(request);
}
