import { z } from 'zod';
import { CalendarDate } from './sales.ts';

// People Zone (docs/people-data-model.md). Every path is under /api/v1/b/:slug/people, so no request
// carries a business id, and bodies are strict: an unknown field (a business id, a tax number, a bank
// account, a status sent to PATCH) is rejected rather than ignored. Payroll, tax, retirement, leave
// balances, geolocation, biometrics, identity documents and bank details are out of scope and have no
// fields here.

const Uuid = z.string().uuid();
const Count = z.number().int().min(1);
const optionalText = (max: number) =>
  z.string().trim().max(max).transform((v) => (v === '' ? null : v)).nullable().optional();
const optionalEmail = z
  .string().trim().max(254)
  .transform((v) => (v === '' ? null : v.toLowerCase()))
  .refine((v) => v === null || z.string().email().safeParse(v).success, 'Enter a valid email address')
  .nullable().optional();
const Limit = z.coerce.number().int().min(1).max(100).default(25);
const Cursor = z.string().max(500).regex(/^[A-Za-z0-9_-]+$/).optional();
const Version = z.number().int().min(1);

export const EmploymentStatus = z.enum(['PENDING', 'ACTIVE', 'ON_LEAVE', 'TERMINATED']);
export type EmploymentStatus = z.infer<typeof EmploymentStatus>;
export const EmploymentType = z.enum(['FULL_TIME', 'PART_TIME', 'CASUAL', 'CONTRACTOR', 'TEMPORARY', 'OTHER']);
export type EmploymentType = z.infer<typeof EmploymentType>;

// ---- departments and locations ------------------------------------------------------------------

export const Department = z
  .object({
    id: Uuid, name: z.string(), description: z.string().nullable(), version: Count,
    createdAt: z.string().datetime(), updatedAt: z.string().datetime(), archivedAt: z.string().datetime().nullable(),
  })
  .strict();
export type Department = z.infer<typeof Department>;

const departmentFields = { name: z.string().trim().min(1, 'A name is required').max(120), description: optionalText(2000) };
export const CreateDepartmentRequest = z.object(departmentFields).strict();
export const UpdateDepartmentRequest = z
  .object(departmentFields).partial().extend({ version: Version }).strict()
  .refine((v) => Object.keys(v).some((k) => k !== 'version'), 'Nothing to update');
export const DepartmentResponse = z.object({ department: Department }).strict();

export const Location = z
  .object({
    id: Uuid, name: z.string(), address: z.string().nullable(), version: Count,
    createdAt: z.string().datetime(), updatedAt: z.string().datetime(), archivedAt: z.string().datetime().nullable(),
  })
  .strict();
export type Location = z.infer<typeof Location>;

const locationFields = { name: z.string().trim().min(1, 'A name is required').max(120), address: optionalText(500) };
export const CreateLocationRequest = z.object(locationFields).strict();
export const UpdateLocationRequest = z
  .object(locationFields).partial().extend({ version: Version }).strict()
  .refine((v) => Object.keys(v).some((k) => k !== 'version'), 'Nothing to update');
export const LocationResponse = z.object({ location: Location }).strict();

/** Departments and locations: active (default), archived or all; A to Z by name. */
export const ListOrgUnitsQuery = z
  .object({ q: z.string().trim().max(100).optional(), archived: z.enum(['active', 'archived', 'all']).default('active'), cursor: Cursor, limit: Limit })
  .strict();
export const ListDepartmentsResponse = z.object({ departments: z.array(Department), nextCursor: z.string().nullable() }).strict();
export const ListLocationsResponse = z.object({ locations: z.array(Location), nextCursor: z.string().nullable() }).strict();

// ---- employees ----------------------------------------------------------------------------------

const Ref = z.object({ id: Uuid, name: z.string(), archived: z.boolean() }).strict();
const ManagerRef = z.object({ id: Uuid, name: z.string(), status: EmploymentStatus }).strict();

/**
 * Work information only. Personal details are a separate resource (EmployeePersonalDetails) behind
 * people:read_sensitive; this object never carries them.
 */
export const Employee = z
  .object({
    id: Uuid,
    employeeNumber: z.string().nullable(),
    givenName: z.string(),
    familyName: z.string(),
    preferredName: z.string().nullable(),
    /** Preferred name (or given name) and family name. */
    displayName: z.string(),
    jobTitle: z.string().nullable(),
    employmentType: EmploymentType.nullable(),
    workEmail: z.string().nullable(),
    workPhone: z.string().nullable(),
    status: EmploymentStatus,
    startDate: z.string().nullable(),
    endDate: z.string().nullable(),
    /** Current values, from the open assignment rows. */
    department: Ref.nullable(),
    manager: ManagerRef.nullable(),
    location: Ref.nullable(),
    /** Optional link to a member of this business. Grants no permissions. */
    userId: Uuid.nullable(),
    /** Increases with every change (including status and assignments). Writes must send it. */
    version: Count,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type Employee = z.infer<typeof Employee>;

/** Optional; unique per business ignoring case. Blank clears it. */
const EmployeeNumber = z
  .string().trim().max(30)
  .refine((v) => v === '' || /^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/.test(v), 'Use letters, numbers, spaces, dots, dashes or slashes')
  .transform((v) => (v === '' ? null : v));

const employeeFields = {
  employeeNumber: EmployeeNumber.nullable().optional(),
  givenName: z.string().trim().min(1, 'A given name is required').max(100),
  familyName: z.string().trim().min(1, 'A family name is required').max(100),
  preferredName: optionalText(100),
  jobTitle: optionalText(150),
  employmentType: EmploymentType.nullable().optional(),
  workEmail: optionalEmail,
  workPhone: optionalText(40),
  locationId: Uuid.nullable().optional(),
  userId: Uuid.nullable().optional(),
};

/**
 * Creates a PENDING (default) or ACTIVE employee. ACTIVE needs a start date that is not in the future.
 * An initial department and manager may be given; they start on the start date (or today).
 */
export const CreateEmployeeRequest = z
  .object({
    ...employeeFields,
    status: z.enum(['PENDING', 'ACTIVE']).optional(),
    startDate: CalendarDate.nullable().optional(),
    departmentId: Uuid.nullable().optional(),
    managerEmployeeId: Uuid.nullable().optional(),
  })
  .strict();
/**
 * Edits work details, location and the user link. Status, department and manager have their own
 * endpoints (they write history). startDate may be edited only while PENDING.
 */
export const UpdateEmployeeRequest = z
  .object({ ...employeeFields, startDate: CalendarDate.nullable().optional() })
  .partial()
  .extend({ version: Version })
  .strict()
  .refine((v) => Object.keys(v).some((k) => k !== 'version'), 'Nothing to update');
export const EmployeeResponse = z.object({ employee: Employee }).strict();

/** Lifecycle (docs/people-data-model.md §3). effectiveDate defaults to today in the business's time zone. */
export const ChangeEmploymentStatusRequest = z
  .object({ status: EmploymentStatus, effectiveDate: CalendarDate.optional(), reason: optionalText(1000), version: Version })
  .strict();
export const ChangeDepartmentRequest = z.object({ departmentId: Uuid.nullable(), effectiveDate: CalendarDate.optional(), version: Version }).strict();
export const ChangeManagerRequest = z.object({ managerEmployeeId: Uuid.nullable(), effectiveDate: CalendarDate.optional(), version: Version }).strict();

export const EmployeeSort = z.enum(['name', 'number', 'newest']);
export const ListEmployeesQuery = z
  .object({
    /** Matches given, family or preferred name, employee number or work email. */
    q: z.string().trim().max(100).optional(),
    /** `current` = everyone not terminated. */
    status: z.union([EmploymentStatus, z.enum(['current', 'all'])]).default('current'),
    departmentId: Uuid.optional(),
    locationId: Uuid.optional(),
    /** Direct reports of this employee (open reporting lines). */
    managerEmployeeId: Uuid.optional(),
    sort: EmployeeSort.default('name'),
    cursor: Cursor,
    limit: Limit,
  })
  .strict();
export const ListEmployeesResponse = z.object({ employees: z.array(Employee), nextCursor: z.string().nullable() }).strict();

// ---- history ------------------------------------------------------------------------------------

export const EmploymentStatusChange = z
  .object({
    id: Uuid, fromStatus: EmploymentStatus.nullable(), toStatus: EmploymentStatus, effectiveDate: z.string(),
    /** Null unless the caller holds people:read_sensitive (even when a reason was recorded). */
    reason: z.string().nullable(),
    recordedById: Uuid.nullable(), recordedAt: z.string().datetime(),
  })
  .strict();
export const DepartmentAssignment = z
  .object({ id: Uuid, department: Ref, startsOn: z.string(), endsOn: z.string().nullable(), createdById: Uuid.nullable(), endedById: Uuid.nullable() })
  .strict();
export const ManagerAssignment = z
  .object({ id: Uuid, manager: ManagerRef, startsOn: z.string(), endsOn: z.string().nullable(), createdById: Uuid.nullable(), endedById: Uuid.nullable() })
  .strict();
/** Oldest first. Rows are never edited or removed; closed assignments have an end date. */
export const EmployeeHistoryResponse = z
  .object({ status: z.array(EmploymentStatusChange), departments: z.array(DepartmentAssignment), managers: z.array(ManagerAssignment) })
  .strict();

// ---- personal details (people:read_sensitive) ----------------------------------------------------

export const EmployeePersonalDetails = z
  .object({
    personalEmail: z.string().nullable(),
    personalPhone: z.string().nullable(),
    homeAddress: z.string().nullable(),
    emergencyContactName: z.string().nullable(),
    emergencyContactRelationship: z.string().nullable(),
    emergencyContactPhone: z.string().nullable(),
    /** 0 until details are first saved. PATCH must send it. */
    version: z.number().int().min(0),
    updatedAt: z.string().datetime().nullable(),
  })
  .strict();
export type EmployeePersonalDetails = z.infer<typeof EmployeePersonalDetails>;
/** Omitted fields stay as they are; null or blank clears one. */
export const UpdatePersonalDetailsRequest = z
  .object({
    personalEmail: optionalEmail,
    personalPhone: optionalText(40),
    homeAddress: optionalText(500),
    emergencyContactName: optionalText(200),
    emergencyContactRelationship: optionalText(100),
    emergencyContactPhone: optionalText(40),
    version: z.number().int().min(0),
  })
  .strict()
  .refine((v) => Object.keys(v).some((k) => k !== 'version'), 'Nothing to update');
export const PersonalDetailsResponse = z.object({ personalDetails: EmployeePersonalDetails }).strict();
