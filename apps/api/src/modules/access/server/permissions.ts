// Permission model (architecture §7.2, §13.2). Code checks PERMISSION KEYS, never roles.
//
// Keys are `<zone>:<action>`. Each Zone declares the keys it owns here; the registry is their
// union, so a typo is a type error. Future Zone-level grants (e.g. "this member may use the
// Customers zone only") and custom roles replace ROLE_PERMISSIONS with a lookup that still returns
// a set of these keys, so call sites do not change.

export const ZONE_PERMISSIONS = {
  business: ['business:read', 'business:manage', 'business:delete'],
  members: ['members:read', 'members:invite', 'members:manage'],
  audit: ['audit:read'],
  customers: ['customers:read', 'customers:write', 'customers:delete'],
  // read_restricted: see RESTRICTED notes written by others (docs/communications-c1.md §4). Authors
  // always see their own; editing and removing are author-only under activity:write.
  activity: ['activity:read', 'activity:write', 'activity:read_restricted'],
  // sales:write covers opportunities (create, edit, move stage, win/lose/reopen, archive/restore);
  // sales:manage covers pipeline configuration, a business setting (docs/sales-data-model.md §5).
  sales: ['sales:read', 'sales:write', 'sales:manage'],
  // Projects and their tasks (docs/projects-data-model.md §5). Owners and assignees of projects and
  // tasks are work assignments, not security principals: being one never grants any of these.
  projects: ['projects:read', 'projects:create', 'projects:update', 'projects:archive', 'projects:manage_tasks'],
  // Finance (docs/finance-data-model.md §7.1, owner decision FD-P1). Separate from every other Zone:
  // customer, sales or project keys (or being a project owner or assignee) grant no finance access,
  // and finance keys grant nothing elsewhere. write = drafts; issue = issue, accept, decline, expire,
  // void; payments and expenses are for F2/F3; manage = numbering, tax rates, finance settings.
  // F5 documents (docs/finance-documents-f5.md §7): preview = draft previews and viewing stored PDF
  // versions inline; generate = create the original PDF and add new versions; download = save a stored
  // version as a file; branding = logo, colour, footer and template text. Viewing the records and the
  // version history stays finance:read. None of them changes a financial record.
  // billing (F6, D-F6-3) = recurring invoice schedules: create, change, pause, resume, cancel, generate
  // now, retry and skip periods; and (F6-3) payment reminders: policies, customer assignments, holds and
  // dismissing a reminder. Reading schedules, runs, policies, holds and reminders is finance:read.
  finance: [
    'finance:read', 'finance:write', 'finance:issue', 'finance:payments', 'finance:expenses', 'finance:manage',
    'finance:documents_preview', 'finance:documents_generate', 'finance:documents_download', 'finance:documents_branding',
    'finance:billing',
  ],
  // People (docs/people-data-model.md §5, decision PD-1). Separate from every other Zone. read = the
  // directory (work fields, org, reporting lines, history without reasons); read_sensitive = personal
  // details and history reasons; manage = employees, assignments, lifecycle, user links; configure =
  // departments and locations. Being someone's manager in the reporting line grants none of these.
  people: ['people:read', 'people:read_sensitive', 'people:manage', 'people:configure'],
  // Scheduling S1 (docs/scheduling-s1.md §5). Calendars are shared by the whole business (no private
  // calendars yet). create/update/cancel cover events (cancel also archives an event, both keep history);
  // manage_calendars covers creating, editing, archiving and restoring calendars and choosing the default.
  // S2 (docs/scheduling-s2.md §7): manage_resources = create, edit, deactivate, archive and restore
  // resources. Seeing resources and their availability is scheduling:read; assigning them to an event is
  // that event's scheduling:create or scheduling:update.
  scheduling: ['scheduling:read', 'scheduling:create', 'scheduling:update', 'scheduling:cancel', 'scheduling:manage_calendars', 'scheduling:manage_resources'],
  // Communications C1: conversations and recorded/imported historical messages. Nothing is sent.
  // C2-A (docs/communications-c2.md §4): connect = connect, reconnect, share, pause and disconnect
  // YOUR OWN mailbox; manage_connections = see every mailbox's metadata, restrict, pause, disconnect
  // and request a sync for any of them. Neither grants reading an OWNER_ONLY mailbox's mail.
  communications: ['communications:read', 'communications:record', 'communications:connect', 'communications:manage_connections'],
  // Reporting R1 (docs/reporting-r1.md §6). read = open Reporting, run trusted metrics and open saved views
  // visible to you; save = create, edit and delete your own saved views; share = make a view visible to the
  // whole business; manage = delete other people's shared views. None of these grants any source data:
  // every metric also requires its source Zone's own read key, checked on every execution.
  reporting: ['reporting:read', 'reporting:save', 'reporting:share', 'reporting:manage'],
} as const;

export type Zone = keyof typeof ZONE_PERMISSIONS;
export type Permission = (typeof ZONE_PERMISSIONS)[Zone][number];
export const ALL_PERMISSIONS: readonly Permission[] = Object.values(ZONE_PERMISSIONS).flat();

export const ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'MEMBER'] as const;
export type Role = (typeof ROLES)[number];

/** Higher rank = more authority. Used only by the role-assignment rules below, never for access. */
const RANK: Record<Role, number> = { OWNER: 4, ADMIN: 3, MANAGER: 2, MEMBER: 1 };

const PROJECTS_WORK: Permission[] = ['projects:read', 'projects:create', 'projects:update', 'projects:manage_tasks'];
/**
 * FD-P1 defaults: MANAGER drafts and enters expenses; OWNER and ADMIN also issue, record payments and manage settings.
 * F5 (provisional, owner decision F5-D3): everyone with finance access previews, generates and downloads
 * documents; branding is a setting, so OWNER and ADMIN only.
 */
const FINANCE_DOCUMENTS: Permission[] = ['finance:documents_preview', 'finance:documents_generate', 'finance:documents_download'];
const FINANCE_WORK: Permission[] = ['finance:read', 'finance:write', 'finance:expenses', ...FINANCE_DOCUMENTS];
const FINANCE_ALL: Permission[] = [...FINANCE_WORK, 'finance:issue', 'finance:payments', 'finance:manage', 'finance:documents_branding', 'finance:billing'];
/** PD-1 defaults: OWNER and ADMIN administer People; MANAGER sees the directory only; MEMBER has no People access. */
const PEOPLE_ALL: Permission[] = ['people:read', 'people:read_sensitive', 'people:manage', 'people:configure'];
/** Everyone in the business works with the schedule; configuring calendars is for whoever runs the work. */
const SCHEDULING_WORK: Permission[] = ['scheduling:read', 'scheduling:create', 'scheduling:update', 'scheduling:cancel'];
/**
 * C1 defaults: every role reads and records message history; restricted notes are OWNER/ADMIN (plus the author).
 * C2-A defaults (D-C2-2): OWNER, ADMIN and MANAGER may connect their own mailbox; OWNER and ADMIN manage connections.
 */
const COMMUNICATIONS: Permission[] = ['communications:read', 'communications:record'];
/** Reporting R1 defaults: everyone may run reports (source keys still apply) and keep private views; sharing is for whoever runs the work. */
const REPORTING_WORK: Permission[] = ['reporting:read', 'reporting:save'];
const DATA: Permission[] = [
  'customers:read', 'customers:write', 'customers:delete', 'activity:read', 'activity:write', 'sales:read', 'sales:write', ...PROJECTS_WORK, 'projects:archive',
  ...SCHEDULING_WORK, 'scheduling:manage_calendars', 'scheduling:manage_resources',
  ...COMMUNICATIONS,
];

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  // Created the business; manages everything, including other owners; only owners may delete
  // (archive) the business or, later, manage billing.
  OWNER: new Set(ALL_PERMISSIONS),
  // Manages members below owner and the business settings; full data access.
  ADMIN: new Set<Permission>([
    'business:read', 'business:manage', 'members:read', 'members:invite', 'members:manage', 'audit:read', 'sales:manage', ...DATA, ...FINANCE_ALL, ...PEOPLE_ALL,
    'activity:read_restricted', 'communications:connect', 'communications:manage_connections', ...REPORTING_WORK, 'reporting:share', 'reporting:manage',
  ]),
  // Runs day-to-day work; can invite and manage MEMBERs only; no settings or audit log.
  MANAGER: new Set<Permission>([
    'business:read', 'members:read', 'members:invite', 'members:manage', ...DATA, ...FINANCE_WORK, 'people:read', 'communications:connect', ...REPORTING_WORK,
    'reporting:share',
  ]),
  // Reads and writes business data; no member or settings management. Works on projects and their
  // tasks but cannot archive or restore a project (a decision for whoever runs the work). No finance
  // access (FD-P1) and no People access (PD-1).
  MEMBER: new Set<Permission>([
    'business:read', 'members:read', 'customers:read', 'customers:write', 'activity:read', 'activity:write', 'sales:read', 'sales:write', ...PROJECTS_WORK,
    ...SCHEDULING_WORK,
    ...COMMUNICATIONS,
    ...REPORTING_WORK,
  ]),
};

export function permissionsFor(role: Role): Permission[] {
  return ALL_PERMISSIONS.filter((p) => ROLE_PERMISSIONS[role].has(p));
}

/** What a check is about. Reserved for record- and Zone-scoped rules; Phase 1 ignores it. */
export interface ResourceScope {
  zone?: Zone;
  type?: string;
  id?: string;
}

export interface Principal {
  readonly role: Role;
  readonly permissions: ReadonlySet<Permission>;
}

export class ForbiddenError extends Error {
  readonly status = 403;
  constructor(message = 'Not allowed') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/**
 * Communications C2-B1 (owner decision D-C2-3): only an OWNER may attest that the business is
 * authorised to use a consumer address (gmail.com, outlook.com…) as a business mailbox. The decision
 * names the role itself, so this is a role rule kept here with the other role rules, not a permission
 * key that a future custom role could be given.
 */
export function canAttestBusinessMailbox(principal: Principal): boolean {
  return principal.role === 'OWNER';
}

export function can(principal: Principal, permission: Permission, resource?: ResourceScope): boolean {
  // Phase 1: role-level grants only. Zone- and record-scoped rules will narrow by `resource` here.
  void resource;
  return principal.permissions.has(permission);
}

/** Throws ForbiddenError unless the principal holds the permission. */
export function authorize(principal: Principal, permission: Permission, resource?: ResourceScope): void {
  if (!can(principal, permission, resource)) throw new ForbiddenError();
}

/**
 * May `actor` change or remove a membership whose current role is `target`?
 * Owners act on anyone (other owners included); everyone else only on roles strictly below their own.
 * Nobody acts on their own membership through member management.
 */
export function canManageMember(actor: Principal, target: Role, isSelf: boolean): boolean {
  if (isSelf || !can(actor, 'members:manage')) return false;
  return actor.role === 'OWNER' || RANK[target] < RANK[actor.role];
}

/**
 * May `actor` give someone the role `next` (by invitation or role change)? No escalation: only
 * roles strictly below the actor's own, except that an owner may make another owner. Invitations
 * never grant OWNER (the database rejects it too).
 */
export function canAssignRole(actor: Principal, next: Role, via: 'invite' | 'change'): boolean {
  const needed: Permission = via === 'invite' ? 'members:invite' : 'members:manage';
  if (!can(actor, needed)) return false;
  if (next === 'OWNER') return via === 'change' && actor.role === 'OWNER';
  return actor.role === 'OWNER' || RANK[next] < RANK[actor.role];
}
