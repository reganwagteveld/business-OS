import { z } from 'zod';

// Global search, GS1-A (docs/global-search-gs1.md §7, §8). Both endpoints are POST so the search
// text travels in the body, never in a URL (D-GS1-12). Every schema is strict: an unknown field (a
// business id, an "allowed Zones" list, a page offset) is rejected, not ignored (§6.6, §6.7).
//
// GS2 §4.5: the six result fields below are the ONLY fields a result may carry. The result object is
// strict, so a server regression that adds a field fails response validation on the server and the
// client's parse, instead of reaching the screen.

/**
 * Record types searchable in GS1-A/B (§4.1). Scheduling events and resources are deliberately absent
 * until the Scheduling readiness check (D-V2A-8, §10.6): asking for them is a 400.
 */
export const SearchType = z.enum([
  'customer', 'contact', 'opportunity', 'project', 'task', 'quote', 'invoice', 'credit_note', 'catalog_item', 'employee',
]);
export type SearchType = z.infer<typeof SearchType>;

/** Zones a result can open in. Search never adds a Zone the shell does not already have. */
export const SearchZone = z.enum(['customers', 'sales', 'projects', 'finance', 'people']);
export type SearchZone = z.infer<typeof SearchZone>;

/** Closed set of status badges. A client maps each to a fixed label and drops anything else (GS2 §4.5 rule 3). */
export const SearchBadge = z.enum([
  'archived', 'draft', 'void', 'former', 'won', 'lost', 'completed', 'cancelled', 'accepted', 'declined', 'expired', 'done', 'inactive',
]);
export type SearchBadge = z.infer<typeof SearchBadge>;

/** Limits shared by the contract and the server's own re-clamping (§6.9). */
export const SEARCH_LIMITS = {
  minQueryLength: 2,
  maxQueryLength: 100,
  maxTerms: 8,
  defaultLimit: 5,
  maxLimit: 25,
  maxResolveItems: 8,
  maxCursorLength: 1000,
} as const;

const Query = z
  .string()
  .max(SEARCH_LIMITS.maxQueryLength * 2) // raw length guard before normalisation
  .transform((v) => v.normalize('NFC').trim().replace(/\s+/gu, ' '))
  .refine((v) => [...v].length >= SEARCH_LIMITS.minQueryLength, 'Type at least 2 characters')
  .refine((v) => [...v].length <= SEARCH_LIMITS.maxQueryLength, 'Search text is too long')
  .refine((v) => v.split(' ').length <= SEARCH_LIMITS.maxTerms, 'Use at most 8 words');

export const SearchRequest = z
  .object({
    q: Query,
    /** Optional: narrows the caller's permitted types. A type the caller cannot read is dropped silently (§6.7). */
    types: z.array(SearchType).min(1).max(SearchType.options.length).optional(),
    /** Per type. */
    limit: z.number().int().min(1).max(SEARCH_LIMITS.maxLimit).default(SEARCH_LIMITS.defaultLimit),
    includeArchived: z.boolean().default(false),
    /** Opaque keyset cursor from a previous single-type response. Only valid with exactly one type (§7.2). */
    cursor: z.string().min(1).max(SEARCH_LIMITS.maxCursorLength).nullable().default(null),
  })
  .strict()
  .refine((v) => v.cursor === null || v.types?.length === 1, { message: 'A cursor needs exactly one type', path: ['cursor'] });
export type SearchRequest = z.input<typeof SearchRequest>;

/** A ShellRoute the client can open (`target` is a Zone-specific record target, §10.6). Never displayed. */
export const SearchRoute = z
  .object({ zone: SearchZone, child: z.string().max(40).optional(), target: z.string().min(1).max(120) })
  .strict();
export type SearchRoute = z.infer<typeof SearchRoute>;

export const SearchResult = z
  .object({
    type: SearchType,
    id: z.string().uuid(),
    title: z.string().max(200),
    subtitle: z.string().max(160).nullable(),
    badges: z.array(SearchBadge).max(4),
    route: SearchRoute,
  })
  .strict();
export type SearchResult = z.infer<typeof SearchResult>;

export const SearchGroup = z
  .object({
    type: SearchType,
    zone: SearchZone,
    items: z.array(SearchResult).max(SEARCH_LIMITS.maxLimit),
    hasMore: z.boolean(),
    /** Set only for single-type requests with more rows (§7.1). */
    nextCursor: z.string().max(SEARCH_LIMITS.maxCursorLength).nullable(),
  })
  .strict();
export type SearchGroup = z.infer<typeof SearchGroup>;

export const SearchResponse = z
  .object({
    /** Types that were searched for this caller (from the caller's own permissions only). */
    searchedTypes: z.array(SearchType),
    /** Groups with hits only, in display order (§9.4). */
    groups: z.array(SearchGroup),
  })
  .strict();
export type SearchResponse = z.infer<typeof SearchResponse>;

export const SearchResolveRequest = z
  .object({
    items: z
      .array(z.object({ type: SearchType, id: z.string().uuid() }).strict())
      .min(1)
      .max(SEARCH_LIMITS.maxResolveItems),
  })
  .strict();
export type SearchResolveRequest = z.infer<typeof SearchResolveRequest>;

/** Items the caller can still see, in request order; anything else is silently left out (§7.3). */
export const SearchResolveResponse = z.object({ items: z.array(SearchResult).max(SEARCH_LIMITS.maxResolveItems) }).strict();
export type SearchResolveResponse = z.infer<typeof SearchResolveResponse>;
