import 'server-only';
// The business's ordinary-communications retention period (D-C2-9, owner clarification 2026-11-15,
// docs/communications-c2.md §16.6). There is no product default: until the business sets one,
//   - no BUSINESS mailbox can sync (no sync job can be queued for it), and
//   - no PERSONAL mailbox can be shared with the business (sharing = BUSINESS),
// and C2-B2 adds the same requirement to sharing a personal thread and to "Keep as record". The
// database enforces the first two as well (guard CM009). The period can be changed, never unset.
// Applying it to stored message copies (retain_until, the purge job) is C2-B2: C2-B1 stores no mail.
import type { MailRetention } from '@business-os/contracts';
import type { AppTenantDb } from '@/core/db';
import { recordAudit } from '@/core/audit';
import { StateConflictError } from '@/core/http/errors';

type Row = { businessId: string; ordinaryRetentionDays: number; updatedAt: Date; version: number };

export async function retentionIsSet(db: AppTenantDb): Promise<boolean> {
  return Boolean(await db.mailRetentionSetting.findFirst({ select: { businessId: true } }));
}

const toRetention = (r: Row | null): MailRetention => ({
  ordinaryRetentionDays: r?.ordinaryRetentionDays ?? null, updatedAt: r?.updatedAt.toISOString() ?? null, version: r?.version ?? null,
});

export async function getRetention(db: AppTenantDb): Promise<MailRetention> {
  const row = (await db.mailRetentionSetting.findFirst({ select: { businessId: true, ordinaryRetentionDays: true, updatedAt: true, version: true } })) as Row | null;
  return toRetention(row);
}

/** Sets (version null) or changes (current version) the period. Caller holds manage_connections. */
export async function setRetention(db: AppTenantDb, userId: string, input: { ordinaryRetentionDays: number; version: number | null }): Promise<MailRetention> {
  const current = (await db.mailRetentionSetting.findFirst({ select: { businessId: true, ordinaryRetentionDays: true, updatedAt: true, version: true } })) as Row | null;
  if ((current?.version ?? null) !== input.version) throw new StateConflictError('stale');
  if (!current) {
    await db.mailRetentionSetting.create({ data: { ordinaryRetentionDays: input.ordinaryRetentionDays, updatedById: userId } as never });
  } else if (current.ordinaryRetentionDays !== input.ordinaryRetentionDays) {
    const changed = await db.mailRetentionSetting.updateMany({
      where: { version: current.version },
      data: { ordinaryRetentionDays: input.ordinaryRetentionDays, updatedById: userId, version: current.version + 1, updatedAt: new Date() },
    });
    if (changed.count !== 1) throw new StateConflictError('stale');
  } else {
    return toRetention(current);
  }
  const business = (await db.business.findFirst({ select: { id: true } })) as { id: string };
  await recordAudit(db, userId, 'communications.retention.ordinary_set', { type: 'business', id: business.id }, {
    ordinaryRetentionDays: String(input.ordinaryRetentionDays), previousDays: current ? String(current.ordinaryRetentionDays) : null,
  });
  return getRetention(db);
}
