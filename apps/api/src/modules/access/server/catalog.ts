// Administration A2-C (docs/administration-a2.md §3.1, §5, §7): a read-only description of the access model for
// the Settings "Roles & access" page. Nothing here grants or checks anything: the keys and role grants come from
// permissions.ts, and every route keeps checking its own key on every request.
//
// The text tables are typed by Permission, Zone and Role, so a new key, Zone or role without a description is a
// type error. Who can do what is never written here by hand: it is computed from ROLE_PERMISSIONS and the rank rules.
import {
  ALL_PERMISSIONS, canAssignRole, canAttestBusinessMailbox, canManageMember, ROLE_PERMISSIONS, ROLES, ZONE_PERMISSIONS,
  type Permission, type Principal, type Role, type Zone,
} from './permissions';

export const ZONE_LABELS: Record<Zone, string> = {
  business: 'Business',
  members: 'Team',
  audit: 'Audit log',
  customers: 'Customers',
  activity: 'Activity and notes',
  sales: 'Sales',
  projects: 'Projects',
  finance: 'Finance',
  people: 'People',
  scheduling: 'Scheduling',
  communications: 'Communications',
  reporting: 'Reporting',
};

export const PERMISSION_TEXT: Record<Permission, { label: string; description: string }> = {
  'business:read': { label: 'View the business', description: 'Open the business and see its profile and regional settings.' },
  'business:manage': { label: 'Manage business settings', description: 'Edit the business profile and regional settings (country, time zone, language, currency, financial year).' },
  'business:delete': { label: 'Archive or delete the business', description: 'Reserved for archiving or deleting the business. Not available in this build.' },
  'members:read': { label: 'See the team', description: 'See who is in the business, their names and their roles.' },
  'members:invite': { label: 'Invite people', description: 'Invite people to roles below your own, manage open invitations and see members’ email addresses.' },
  'members:manage': { label: 'Manage members', description: 'Change the role of, suspend, reactivate or remove other members whose role is below your own. Owners can act on any other member, including owners.' },
  'audit:read': { label: 'Read the audit log', description: 'See the business’s recorded changes.' },
  'customers:read': { label: 'View customers', description: 'See customers and their contacts.' },
  'customers:write': { label: 'Edit customers', description: 'Create and edit customers and contacts.' },
  'customers:delete': { label: 'Archive customers', description: 'Archive and restore customers and contacts.' },
  'activity:read': { label: 'View activity', description: 'See the activity timeline and notes, except restricted notes written by others.' },
  'activity:write': { label: 'Record activity', description: 'Add notes and activity. Editing and removing a note is for its author only.' },
  'activity:read_restricted': { label: 'View restricted notes', description: 'See restricted notes written by others.' },
  'sales:read': { label: 'View sales', description: 'See the pipeline and opportunities.' },
  'sales:write': { label: 'Work on opportunities', description: 'Create, edit, move, win, lose, reopen, archive and restore opportunities.' },
  'sales:manage': { label: 'Configure pipelines', description: 'Set up pipelines and their stages.' },
  'projects:read': { label: 'View projects', description: 'See projects and their tasks.' },
  'projects:create': { label: 'Create projects', description: 'Start new projects.' },
  'projects:update': { label: 'Edit projects', description: 'Edit projects and their details.' },
  'projects:archive': { label: 'Archive projects', description: 'Archive and restore projects.' },
  'projects:manage_tasks': { label: 'Manage tasks', description: 'Create, edit, move and complete tasks.' },
  'finance:read': { label: 'View finance', description: 'See quotes, invoices, payments, expenses, the catalog, schedules and reminders.' },
  'finance:write': { label: 'Draft finance documents', description: 'Create and edit draft quotes and invoices.' },
  'finance:issue': { label: 'Issue finance documents', description: 'Issue, accept, decline, expire and void quotes and invoices.' },
  'finance:payments': { label: 'Record payments', description: 'Record payments and credit applications.' },
  'finance:expenses': { label: 'Enter expenses', description: 'Enter and edit expenses.' },
  'finance:manage': { label: 'Manage finance settings', description: 'Numbering, tax rates and finance settings.' },
  'finance:documents_preview': { label: 'Preview documents', description: 'Preview drafts and view stored PDF versions.' },
  'finance:documents_generate': { label: 'Generate documents', description: 'Create PDFs and add new versions.' },
  'finance:documents_download': { label: 'Download documents', description: 'Save stored PDF versions as files.' },
  'finance:documents_branding': { label: 'Document branding', description: 'Logo, colour, footer and template text on documents.' },
  'finance:billing': { label: 'Recurring billing and reminders', description: 'Manage recurring invoice schedules and payment reminder policies, holds and reminders.' },
  'finance:catalog': { label: 'Manage the catalog', description: 'Create, edit, deactivate, archive and restore products and services.' },
  'people:read': { label: 'View the directory', description: 'See employees’ work details, organisation and reporting lines.' },
  'people:read_sensitive': { label: 'View personal details', description: 'See employees’ personal details and the reasons in their history.' },
  'people:manage': { label: 'Manage employees', description: 'Manage employees, assignments, lifecycle and user links.' },
  'people:configure': { label: 'Configure People', description: 'Set up departments and locations.' },
  'scheduling:read': { label: 'View the schedule', description: 'See calendars, events, resources and availability.' },
  'scheduling:create': { label: 'Create events', description: 'Create events and assign resources to them.' },
  'scheduling:update': { label: 'Edit events', description: 'Edit events and their resources.' },
  'scheduling:cancel': { label: 'Cancel events', description: 'Cancel and archive events.' },
  'scheduling:manage_calendars': { label: 'Manage calendars', description: 'Create, edit, archive and restore calendars and choose the default.' },
  'scheduling:manage_resources': { label: 'Manage resources', description: 'Create, edit, deactivate, archive and restore resources.' },
  'communications:read': { label: 'View conversations', description: 'See conversations and message history.' },
  'communications:record': { label: 'Record messages', description: 'Record and import message history. Nothing is sent.' },
  'communications:connect': { label: 'Connect your mailbox', description: 'Connect, share, pause and disconnect your own mailbox.' },
  'communications:manage_connections': { label: 'Manage mailboxes', description: 'See every connected mailbox and restrict, pause, disconnect or sync it. Does not open private mail.' },
  'reporting:read': { label: 'Run reports', description: 'Open Reporting and run reports. Each report also needs access to the Zone its data comes from.' },
  'reporting:save': { label: 'Save views', description: 'Save, edit and delete your own report views.' },
  'reporting:share': { label: 'Share views', description: 'Share report views with the whole business.' },
  'reporting:manage': { label: 'Manage shared views', description: 'Delete report views shared by others.' },
};

export const ROLE_TEXT: Record<Role, { label: string; description: string }> = {
  OWNER: { label: 'Owner', description: 'Runs the business. Has every permission, manages everyone including other owners, and alone can hand over ownership.' },
  ADMIN: { label: 'Admin', description: 'Manages the business settings and members below Admin, with full access to every Zone.' },
  MANAGER: { label: 'Manager', description: 'Runs day-to-day work. Can invite and manage Members, works with drafts and expenses in Finance and sees the People directory. No settings or audit log.' },
  MEMBER: { label: 'Member', description: 'Works with customers, sales, projects, the schedule, conversations and reports. No Finance, People, member or settings access.' },
};

const principal = (role: Role): Principal => ({ role, permissions: ROLE_PERMISSIONS[role] });
const rolesWhere = (test: (role: Role) => boolean): Role[] => ROLES.filter(test);

/**
 * The fixed roles and what each may do. The same for every business and every caller, holds no tenant data,
 * and is computed from the live grants and rank rules, so it cannot disagree with what the server enforces.
 */
export function describeAccessModel() {
  return {
    model: { customRoles: false as const, editable: false as const },
    roles: ROLES.map((role) => {
      const actor = principal(role);
      return {
        role,
        ...ROLE_TEXT[role],
        permissions: ALL_PERMISSIONS.filter((key) => actor.permissions.has(key)),
        canInvite: rolesWhere((next) => canAssignRole(actor, next, 'invite')).filter((r): r is Exclude<Role, 'OWNER'> => r !== 'OWNER'),
        canAssign: rolesWhere((next) => canAssignRole(actor, next, 'change')),
        canManage: rolesWhere((target) => canManageMember(actor, target, false)),
      };
    }),
    zones: (Object.keys(ZONE_PERMISSIONS) as Zone[]).map((zone) => ({
      zone,
      label: ZONE_LABELS[zone],
      permissions: ZONE_PERMISSIONS[zone].map((key: Permission) => ({ key, ...PERMISSION_TEXT[key] })),
    })),
    // Role rules that no permission key carries. Transfer, step-down and leave are enforced in
    // modules/tenancy/server/members.ts (and pinned by tests/integration/membership-lifecycle.test.ts).
    rules: [
      { id: 'transfer_ownership' as const, roles: ['OWNER'] as Role[], description: 'Make another active member an owner, optionally stepping down to Admin in the same step.' },
      { id: 'step_down' as const, roles: ['OWNER'] as Role[], description: 'Step down from Owner to Admin while another active owner remains.' },
      {
        id: 'attest_business_mailbox' as const,
        roles: rolesWhere((role) => canAttestBusinessMailbox(principal(role))),
        description: 'Confirm that the business may use a personal email address (for example a gmail.com address) as a business mailbox.',
      },
      { id: 'leave_business' as const, roles: [...ROLES], description: 'Leave the business. The last active owner cannot leave.' },
    ],
  };
}
