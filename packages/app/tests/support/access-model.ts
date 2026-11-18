import type { AccessModelData } from '../../src/api/settings';

/**
 * A copy of the server's real roles description (apps/api modules/access `describeAccessModel()`, A2-C) as
 * served by `GET /access/roles` on main 2a96f44. Test data only: the server stays the authority, and
 * tests/settings-access.test.tsx checks this copy against the shared contract.
 */
export const ACCESS_MODEL: AccessModelData = {
  "model": {
    "customRoles": false,
    "editable": false
  },
  "roles": [
    {
      "role": "OWNER",
      "label": "Owner",
      "description": "Runs the business. Has every permission, manages everyone including other owners, and alone can hand over ownership.",
      "permissions": [
        "business:read",
        "business:manage",
        "business:delete",
        "members:read",
        "members:invite",
        "members:manage",
        "audit:read",
        "customers:read",
        "customers:write",
        "customers:delete",
        "activity:read",
        "activity:write",
        "activity:read_restricted",
        "sales:read",
        "sales:write",
        "sales:manage",
        "projects:read",
        "projects:create",
        "projects:update",
        "projects:archive",
        "projects:manage_tasks",
        "finance:read",
        "finance:write",
        "finance:issue",
        "finance:payments",
        "finance:expenses",
        "finance:manage",
        "finance:documents_preview",
        "finance:documents_generate",
        "finance:documents_download",
        "finance:documents_branding",
        "finance:billing",
        "finance:catalog",
        "people:read",
        "people:read_sensitive",
        "people:manage",
        "people:configure",
        "scheduling:read",
        "scheduling:create",
        "scheduling:update",
        "scheduling:cancel",
        "scheduling:manage_calendars",
        "scheduling:manage_resources",
        "communications:read",
        "communications:record",
        "communications:connect",
        "communications:manage_connections",
        "reporting:read",
        "reporting:save",
        "reporting:share",
        "reporting:manage"
      ],
      "canInvite": [
        "ADMIN",
        "MANAGER",
        "MEMBER"
      ],
      "canAssign": [
        "OWNER",
        "ADMIN",
        "MANAGER",
        "MEMBER"
      ],
      "canManage": [
        "OWNER",
        "ADMIN",
        "MANAGER",
        "MEMBER"
      ]
    },
    {
      "role": "ADMIN",
      "label": "Admin",
      "description": "Manages the business settings and members below Admin, with full access to every Zone.",
      "permissions": [
        "business:read",
        "business:manage",
        "members:read",
        "members:invite",
        "members:manage",
        "audit:read",
        "customers:read",
        "customers:write",
        "customers:delete",
        "activity:read",
        "activity:write",
        "activity:read_restricted",
        "sales:read",
        "sales:write",
        "sales:manage",
        "projects:read",
        "projects:create",
        "projects:update",
        "projects:archive",
        "projects:manage_tasks",
        "finance:read",
        "finance:write",
        "finance:issue",
        "finance:payments",
        "finance:expenses",
        "finance:manage",
        "finance:documents_preview",
        "finance:documents_generate",
        "finance:documents_download",
        "finance:documents_branding",
        "finance:billing",
        "finance:catalog",
        "people:read",
        "people:read_sensitive",
        "people:manage",
        "people:configure",
        "scheduling:read",
        "scheduling:create",
        "scheduling:update",
        "scheduling:cancel",
        "scheduling:manage_calendars",
        "scheduling:manage_resources",
        "communications:read",
        "communications:record",
        "communications:connect",
        "communications:manage_connections",
        "reporting:read",
        "reporting:save",
        "reporting:share",
        "reporting:manage"
      ],
      "canInvite": [
        "MANAGER",
        "MEMBER"
      ],
      "canAssign": [
        "MANAGER",
        "MEMBER"
      ],
      "canManage": [
        "MANAGER",
        "MEMBER"
      ]
    },
    {
      "role": "MANAGER",
      "label": "Manager",
      "description": "Runs day-to-day work. Can invite and manage Members, works with drafts and expenses in Finance and sees the People directory. No settings or audit log.",
      "permissions": [
        "business:read",
        "members:read",
        "members:invite",
        "members:manage",
        "customers:read",
        "customers:write",
        "customers:delete",
        "activity:read",
        "activity:write",
        "sales:read",
        "sales:write",
        "projects:read",
        "projects:create",
        "projects:update",
        "projects:archive",
        "projects:manage_tasks",
        "finance:read",
        "finance:write",
        "finance:expenses",
        "finance:documents_preview",
        "finance:documents_generate",
        "finance:documents_download",
        "people:read",
        "scheduling:read",
        "scheduling:create",
        "scheduling:update",
        "scheduling:cancel",
        "scheduling:manage_calendars",
        "scheduling:manage_resources",
        "communications:read",
        "communications:record",
        "communications:connect",
        "reporting:read",
        "reporting:save",
        "reporting:share"
      ],
      "canInvite": [
        "MEMBER"
      ],
      "canAssign": [
        "MEMBER"
      ],
      "canManage": [
        "MEMBER"
      ]
    },
    {
      "role": "MEMBER",
      "label": "Member",
      "description": "Works with customers, sales, projects, the schedule, conversations and reports. No Finance, People, member or settings access.",
      "permissions": [
        "business:read",
        "members:read",
        "customers:read",
        "customers:write",
        "activity:read",
        "activity:write",
        "sales:read",
        "sales:write",
        "projects:read",
        "projects:create",
        "projects:update",
        "projects:manage_tasks",
        "scheduling:read",
        "scheduling:create",
        "scheduling:update",
        "scheduling:cancel",
        "communications:read",
        "communications:record",
        "reporting:read",
        "reporting:save"
      ],
      "canInvite": [],
      "canAssign": [],
      "canManage": []
    }
  ],
  "zones": [
    {
      "zone": "business",
      "label": "Business",
      "permissions": [
        {
          "key": "business:read",
          "label": "View the business",
          "description": "Open the business and see its profile and regional settings."
        },
        {
          "key": "business:manage",
          "label": "Manage business settings",
          "description": "Edit the business profile and regional settings (country, time zone, language, currency, financial year)."
        },
        {
          "key": "business:delete",
          "label": "Archive or delete the business",
          "description": "Reserved for archiving or deleting the business. Not available in this build."
        }
      ]
    },
    {
      "zone": "members",
      "label": "Team",
      "permissions": [
        {
          "key": "members:read",
          "label": "See the team",
          "description": "See who is in the business, their names and their roles."
        },
        {
          "key": "members:invite",
          "label": "Invite people",
          "description": "Invite people to roles below your own, manage open invitations and see members’ email addresses."
        },
        {
          "key": "members:manage",
          "label": "Manage members",
          "description": "Change the role of, suspend, reactivate or remove other members whose role is below your own. Owners can act on any other member, including owners."
        }
      ]
    },
    {
      "zone": "audit",
      "label": "Audit log",
      "permissions": [
        {
          "key": "audit:read",
          "label": "Read the audit log",
          "description": "See the business’s recorded changes."
        }
      ]
    },
    {
      "zone": "customers",
      "label": "Customers",
      "permissions": [
        {
          "key": "customers:read",
          "label": "View customers",
          "description": "See customers and their contacts."
        },
        {
          "key": "customers:write",
          "label": "Edit customers",
          "description": "Create and edit customers and contacts."
        },
        {
          "key": "customers:delete",
          "label": "Archive customers",
          "description": "Archive and restore customers and contacts."
        }
      ]
    },
    {
      "zone": "activity",
      "label": "Activity and notes",
      "permissions": [
        {
          "key": "activity:read",
          "label": "View activity",
          "description": "See the activity timeline and notes, except restricted notes written by others."
        },
        {
          "key": "activity:write",
          "label": "Record activity",
          "description": "Add notes and activity. Editing and removing a note is for its author only."
        },
        {
          "key": "activity:read_restricted",
          "label": "View restricted notes",
          "description": "See restricted notes written by others."
        }
      ]
    },
    {
      "zone": "sales",
      "label": "Sales",
      "permissions": [
        {
          "key": "sales:read",
          "label": "View sales",
          "description": "See the pipeline and opportunities."
        },
        {
          "key": "sales:write",
          "label": "Work on opportunities",
          "description": "Create, edit, move, win, lose, reopen, archive and restore opportunities."
        },
        {
          "key": "sales:manage",
          "label": "Configure pipelines",
          "description": "Set up pipelines and their stages."
        }
      ]
    },
    {
      "zone": "projects",
      "label": "Projects",
      "permissions": [
        {
          "key": "projects:read",
          "label": "View projects",
          "description": "See projects and their tasks."
        },
        {
          "key": "projects:create",
          "label": "Create projects",
          "description": "Start new projects."
        },
        {
          "key": "projects:update",
          "label": "Edit projects",
          "description": "Edit projects and their details."
        },
        {
          "key": "projects:archive",
          "label": "Archive projects",
          "description": "Archive and restore projects."
        },
        {
          "key": "projects:manage_tasks",
          "label": "Manage tasks",
          "description": "Create, edit, move and complete tasks."
        }
      ]
    },
    {
      "zone": "finance",
      "label": "Finance",
      "permissions": [
        {
          "key": "finance:read",
          "label": "View finance",
          "description": "See quotes, invoices, payments, expenses, the catalog, schedules and reminders."
        },
        {
          "key": "finance:write",
          "label": "Draft finance documents",
          "description": "Create and edit draft quotes and invoices."
        },
        {
          "key": "finance:issue",
          "label": "Issue finance documents",
          "description": "Issue, accept, decline, expire and void quotes and invoices."
        },
        {
          "key": "finance:payments",
          "label": "Record payments",
          "description": "Record payments and credit applications."
        },
        {
          "key": "finance:expenses",
          "label": "Enter expenses",
          "description": "Enter and edit expenses."
        },
        {
          "key": "finance:manage",
          "label": "Manage finance settings",
          "description": "Numbering, tax rates and finance settings."
        },
        {
          "key": "finance:documents_preview",
          "label": "Preview documents",
          "description": "Preview drafts and view stored PDF versions."
        },
        {
          "key": "finance:documents_generate",
          "label": "Generate documents",
          "description": "Create PDFs and add new versions."
        },
        {
          "key": "finance:documents_download",
          "label": "Download documents",
          "description": "Save stored PDF versions as files."
        },
        {
          "key": "finance:documents_branding",
          "label": "Document branding",
          "description": "Logo, colour, footer and template text on documents."
        },
        {
          "key": "finance:billing",
          "label": "Recurring billing and reminders",
          "description": "Manage recurring invoice schedules and payment reminder policies, holds and reminders."
        },
        {
          "key": "finance:catalog",
          "label": "Manage the catalog",
          "description": "Create, edit, deactivate, archive and restore products and services."
        }
      ]
    },
    {
      "zone": "people",
      "label": "People",
      "permissions": [
        {
          "key": "people:read",
          "label": "View the directory",
          "description": "See employees’ work details, organisation and reporting lines."
        },
        {
          "key": "people:read_sensitive",
          "label": "View personal details",
          "description": "See employees’ personal details and the reasons in their history."
        },
        {
          "key": "people:manage",
          "label": "Manage employees",
          "description": "Manage employees, assignments, lifecycle and user links."
        },
        {
          "key": "people:configure",
          "label": "Configure People",
          "description": "Set up departments and locations."
        }
      ]
    },
    {
      "zone": "scheduling",
      "label": "Scheduling",
      "permissions": [
        {
          "key": "scheduling:read",
          "label": "View the schedule",
          "description": "See calendars, events, resources and availability."
        },
        {
          "key": "scheduling:create",
          "label": "Create events",
          "description": "Create events and assign resources to them."
        },
        {
          "key": "scheduling:update",
          "label": "Edit events",
          "description": "Edit events and their resources."
        },
        {
          "key": "scheduling:cancel",
          "label": "Cancel events",
          "description": "Cancel and archive events."
        },
        {
          "key": "scheduling:manage_calendars",
          "label": "Manage calendars",
          "description": "Create, edit, archive and restore calendars and choose the default."
        },
        {
          "key": "scheduling:manage_resources",
          "label": "Manage resources",
          "description": "Create, edit, deactivate, archive and restore resources."
        }
      ]
    },
    {
      "zone": "communications",
      "label": "Communications",
      "permissions": [
        {
          "key": "communications:read",
          "label": "View conversations",
          "description": "See conversations and message history."
        },
        {
          "key": "communications:record",
          "label": "Record messages",
          "description": "Record and import message history. Nothing is sent."
        },
        {
          "key": "communications:connect",
          "label": "Connect your mailbox",
          "description": "Connect, share, pause and disconnect your own mailbox."
        },
        {
          "key": "communications:manage_connections",
          "label": "Manage mailboxes",
          "description": "See every connected mailbox and restrict, pause, disconnect or sync it. Does not open private mail."
        }
      ]
    },
    {
      "zone": "reporting",
      "label": "Reporting",
      "permissions": [
        {
          "key": "reporting:read",
          "label": "Run reports",
          "description": "Open Reporting and run reports. Each report also needs access to the Zone its data comes from."
        },
        {
          "key": "reporting:save",
          "label": "Save views",
          "description": "Save, edit and delete your own report views."
        },
        {
          "key": "reporting:share",
          "label": "Share views",
          "description": "Share report views with the whole business."
        },
        {
          "key": "reporting:manage",
          "label": "Manage shared views",
          "description": "Delete report views shared by others."
        }
      ]
    }
  ],
  "rules": [
    {
      "id": "transfer_ownership",
      "roles": [
        "OWNER"
      ],
      "description": "Make another active member an owner, optionally stepping down to Admin in the same step."
    },
    {
      "id": "step_down",
      "roles": [
        "OWNER"
      ],
      "description": "Step down from Owner to Admin while another active owner remains."
    },
    {
      "id": "attest_business_mailbox",
      "roles": [
        "OWNER"
      ],
      "description": "Confirm that the business may use a personal email address (for example a gmail.com address) as a business mailbox."
    },
    {
      "id": "leave_business",
      "roles": [
        "OWNER",
        "ADMIN",
        "MANAGER",
        "MEMBER"
      ],
      "description": "Leave the business. The last active owner cannot leave."
    }
  ]
};
