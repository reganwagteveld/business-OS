import 'server-only';
// Re-checks the acting member INSIDE the unit of work (docs/administration-a2.md §3.11). The route
// resolves the caller's role through app_private.my_memberships before the transaction opens; an
// administrative change re-reads that membership here and holds a FOR SHARE lock on it until commit,
// so a concurrent demotion, suspension or removal of the actor either waits for this change or makes
// it fail. Other Zones keep per-request resolution.
import { authorize, ForbiddenError, permissionsFor, type Permission, type Principal, type Role } from '@/modules/access';
import type { AppTenantDb } from '@/core/db';

/** Who is acting: the verified membership of the signed-in user in the current business. */
export interface Actor extends Principal {
  readonly userId: string;
  readonly membershipId: string;
}

export async function lockActor(db: AppTenantDb, actor: Actor, permission: Permission): Promise<Actor> {
  const rows = await db.$queryRaw<{ role: Role; status: string; user_id: string }[]>`
    SELECT role::text AS role, status::text AS status, user_id::text AS user_id FROM memberships
    WHERE id = ${actor.membershipId}::uuid AND business_id = nullif(current_setting('app.business_id', true), '')::uuid
    FOR SHARE`;
  const row = rows[0];
  if (!row || row.status !== 'ACTIVE' || row.user_id !== actor.userId) throw new ForbiddenError();
  const current: Actor = { ...actor, role: row.role, permissions: new Set(permissionsFor(row.role)) };
  authorize(current, permission);
  return current;
}
