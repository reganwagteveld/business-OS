import 'server-only';
// Append-only security log entries for tenant actions (data-model §4.8, §5.6). Written inside the
// same unit of work as the change; business_id is added by the tenant scope and checked by RLS,
// and the policy requires actor_user_id to equal the verified session user.
import { randomUUID } from 'node:crypto';
import type { AppTenantDb } from '../db';

export async function recordAudit(
  db: AppTenantDb,
  actorUserId: string,
  action: string,
  target: { type: string; id: string },
  metadata: Record<string, string | string[] | null> = {},
): Promise<void> {
  await db.auditEvent.create({
    data: { id: randomUUID(), actorUserId, action, targetType: target.type, targetId: target.id, metadata } as never,
  });
}
