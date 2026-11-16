import 'server-only';
// The business's ordinary-communications retention period (D-C2-9, owner clarification 2026-11-15,
// docs/communications-c2.md §16.6). There is no product default: until the business sets one,
//   - no BUSINESS mailbox can sync (no sync job can be queued for it), and
//   - no PERSONAL mailbox can be shared with the business (sharing = BUSINESS),
// and C2-B2 adds the same requirement to sharing a personal thread and to "Keep as record". The
// database enforces the first two as well (guard CM009). The period can be changed, never unset.
// E1 (D-E1-3, docs/communications-e1.md §4): a SHORTER period takes effect 30 days after the change; until
// then the longer previous period stays in force. The database stamps that delay itself (trigger
// mail_retention_settings_stamp), so no code path can skip it; only an OWNER's audited, single-use
// authorised apply-reduction (erasure.ts) ends it early.
import type { MailRetention } from '@business-os/contracts';
import type { AppTenantDb } from '@/core/db';
import { recordAudit } from '@/core/audit';
import { StateConflictError } from '@/core/http/errors';

type Row = {
  businessId: string; ordinaryRetentionDays: number; updatedAt: Date; version: number; previousRetentionDays: number | null; shorteningEffectiveAt: Date | null;
};
const rowSelect = {
  businessId: true, ordinaryRetentionDays: true, updatedAt: true, version: true, previousRetentionDays: true, shorteningEffectiveAt: true,
} as const;

export async function retentionIsSet(db: AppTenantDb): Promise<boolean> {
  return Boolean(await db.mailRetentionSetting.findFirst({ select: { businessId: true } }));
}

/** Mirrors the database's mail_effective_ordinary_days: the previous, longer period until the delay ends. */
function inForce(r: Row, now: Date): { days: number; pending: MailRetention['pendingReduction'] } {
  if (r.previousRetentionDays != null && r.shorteningEffectiveAt && r.shorteningEffectiveAt > now) {
    return { days: r.previousRetentionDays, pending: { previousDays: r.previousRetentionDays, effectiveAt: r.shorteningEffectiveAt.toISOString() } };
  }
  return { days: r.ordinaryRetentionDays, pending: null };
}

const toRetention = (r: Row | null): MailRetention => {
  const current = r ? inForce(r, new Date()) : null;
  return {
    ordinaryRetentionDays: r?.ordinaryRetentionDays ?? null, updatedAt: r?.updatedAt.toISOString() ?? null, version: r?.version ?? null,
    ordinaryRetentionDaysInForce: current?.days ?? null, pendingReduction: current?.pending ?? null,
  };
};

export async function getRetention(db: AppTenantDb): Promise<MailRetention> {
  const row = (await db.mailRetentionSetting.findFirst({ select: rowSelect })) as Row | null;
  return toRetention(row);
}

/** Sets (version null) or changes (current version) the period. Caller holds manage_connections. A shorter period waits 30 days. */
export async function setRetention(db: AppTenantDb, userId: string, input: { ordinaryRetentionDays: number; version: number | null }): Promise<MailRetention> {
  const current = (await db.mailRetentionSetting.findFirst({ select: rowSelect })) as Row | null;
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
