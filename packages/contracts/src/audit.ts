import { z } from 'zod';

// Administration audit viewer (A-AUD-1, docs/administration-audit-viewer.md). One read-only list of the
// business's recorded changes. Everything the server sends is chosen by an allow-list (docs §5): a field
// that is not listed here, or not allowed for that action, never leaves the server.

const Uuid = z.string().uuid();
const Instant = z.string().datetime();
const Cursor = z.string().min(1).max(600).regex(/^[A-Za-z0-9_-]+$/);

/** The longest window one request may cover (docs §4). Older history is reached by moving the window back. */
export const AUDIT_MAX_WINDOW_DAYS = 92;
const MAX_WINDOW_MS = AUDIT_MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000;

export const AuditGroup = z.enum(['team', 'business', 'customers', 'sales', 'projects', 'scheduling', 'people', 'finance', 'communications', 'reporting', 'other']);
export type AuditGroup = z.infer<typeof AuditGroup>;

/**
 * Dotted-boundary prefix of an action ("sales" matches "sales" and "sales.opportunity.won", never "salesforce").
 * Lower-case words and underscores only, so it can never carry SQL wildcards or markup.
 */
const ActionPrefix = z.string().min(1).max(60).regex(/^[a-z][a-z_]*(\.[a-z][a-z_]*)*$/);

/**
 * Targets are not filterable in v1 (docs §4, D-AUD-10): a filter by target would let a caller test whether a
 * restricted record id appears in the log. The schema is strict, so `targetType` and `targetId` are refused
 * like any unknown parameter (400 invalid_query).
 */
export const ListAuditEventsQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: Cursor.optional(),
    actionPrefix: ActionPrefix.optional(),
    /** A current member of this business. Any other id answers the same empty page as an unused one (D-AUD-9). */
    actorUserId: Uuid.optional(),
    /** Events with no acting user (`system`). Never matches a former member. */
    actorKind: z.literal('system').optional(),
    from: Instant.optional(),
    to: Instant.optional(),
  })
  .strict()
  .superRefine((q, ctx) => {
    if (q.actorUserId !== undefined && q.actorKind !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['actorKind'], message: 'actorUserId and actorKind cannot be combined' });
    }
    if (q.from !== undefined && q.to !== undefined) {
      const span = Date.parse(q.to) - Date.parse(q.from);
      if (span < 0) ctx.addIssue({ code: 'custom', path: ['to'], message: 'to is before from' });
      if (span > MAX_WINDOW_MS) ctx.addIssue({ code: 'custom', path: ['to'], message: `at most ${AUDIT_MAX_WINDOW_DAYS} days per request` });
    }
  });

const MetadataValue = z.union([z.string().max(200), z.number(), z.boolean(), z.array(z.string().max(200)).max(20)]);

export const AuditActor = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('member'), userId: Uuid, name: z.string().max(200) }).strict(),
  /** Someone who acted and is no longer a member. No id, no name, no email. */
  z.object({ kind: z.literal('former_member') }).strict(),
  z.object({ kind: z.literal('system') }).strict(),
]);

/**
 * `type` is one of a fixed list of safe record types or the literal "record" (an unclassified type is never
 * echoed). `id` is present only when the action's rule allows it; `name` only for a current member target.
 */
export const AuditTarget = z.object({ type: z.string().max(60), id: Uuid.optional(), name: z.string().max(200).optional() }).strict();

export const AuditEventView = z
  .object({
    id: Uuid,
    createdAt: Instant,
    action: z.string().max(80),
    /** A short English label for the action, from the server's registry (a fixed fallback for unknown actions). */
    label: z.string().max(120),
    group: AuditGroup,
    actor: AuditActor,
    target: AuditTarget.nullable(),
    metadata: z.record(z.string().max(60), MetadataValue),
  })
  .strict();

export const ListAuditEventsResponse = z
  .object({
    events: z.array(AuditEventView),
    nextCursor: z.string().nullable(),
    /** The window this page and every following page cover (follow nextCursor to stay inside it). */
    window: z.object({ from: Instant, to: Instant }).strict(),
  })
  .strict();

export type ListAuditEventsQuery = z.infer<typeof ListAuditEventsQuery>;
export type AuditEventView = z.infer<typeof AuditEventView>;
export type ListAuditEventsResponse = z.infer<typeof ListAuditEventsResponse>;
