import 'server-only';
// Personal details (docs/people-data-model.md §5, decision PD-5): the only place that reads or writes
// people_employee_personal_details. Every function checks people:read_sensitive itself, on top of the
// route's permission, so no caller can reach these fields with directory access alone. Changes are
// audited by field name only; values never reach the audit log.
import type { EmployeePersonalDetails } from '@business-os/contracts';
import { ForbiddenError } from '@/modules/access';
import { recordAudit } from '@/core/audit';
import type { AppTenantDb } from '@/core/db';
import { StateConflictError } from '@/core/http/errors';
import { loadEmployee } from './employees';
import { changedFields, type Viewer } from './shared';

const FIELDS = ['personalEmail', 'personalPhone', 'homeAddress', 'emergencyContactName', 'emergencyContactRelationship', 'emergencyContactPhone'] as const;
type Field = (typeof FIELDS)[number];
type Row = Record<Field, string | null> & { version: number; updatedAt: Date };

const select = { ...Object.fromEntries(FIELDS.map((f) => [f, true])), version: true, updatedAt: true } as Record<string, true>;

const toDto = (r: Row | null): EmployeePersonalDetails => ({
  personalEmail: r?.personalEmail ?? null, personalPhone: r?.personalPhone ?? null, homeAddress: r?.homeAddress ?? null,
  emergencyContactName: r?.emergencyContactName ?? null, emergencyContactRelationship: r?.emergencyContactRelationship ?? null,
  emergencyContactPhone: r?.emergencyContactPhone ?? null, version: r?.version ?? 0, updatedAt: r?.updatedAt.toISOString() ?? null,
});

async function read(db: AppTenantDb, employeeId: string) {
  return (await db.peopleEmployeePersonalDetails.findFirst({ where: { employeeId }, select } as never)) as Row | null;
}

export async function getPersonalDetails(db: AppTenantDb, viewer: Viewer, employeeId: string) {
  if (!viewer.canReadSensitive) throw new ForbiddenError();
  await loadEmployee(db, employeeId);
  return toDto(await read(db, employeeId));
}

/** Version 0 creates the row; a second first-save racing it loses on the primary key (409 stale). */
export async function updatePersonalDetails(
  db: AppTenantDb, viewer: Viewer, actorUserId: string, employeeId: string, patch: Partial<Record<Field, string | null>> & { version: number },
) {
  if (!viewer.canReadSensitive) throw new ForbiddenError();
  await loadEmployee(db, employeeId);
  const before = await read(db, employeeId);
  if ((before?.version ?? 0) !== patch.version) throw new StateConflictError('stale');
  const data: Record<string, unknown> = {};
  for (const f of FIELDS) if (patch[f] !== undefined) data[f] = patch[f];
  const fields = changedFields((before ?? {}) as Record<string, unknown>, data).filter((f) => before || data[f] !== null);
  if (fields.length === 0) return toDto(before);
  if (!before) {
    await db.peopleEmployeePersonalDetails.create({ data: { employeeId, ...data, updatedById: actorUserId } } as never);
  } else {
    const result = await db.peopleEmployeePersonalDetails.updateMany({
      where: { employeeId, version: patch.version }, data: { ...data, version: { increment: 1 }, updatedById: actorUserId },
    } as never);
    if (result.count === 0) throw new StateConflictError('stale');
  }
  await recordAudit(db, actorUserId, 'people.employee.personal_details_updated', { type: 'people_employee', id: employeeId }, { fields });
  return toDto(await read(db, employeeId));
}
