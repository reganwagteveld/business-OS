// Query normalisation for global search (docs/global-search-gs1.md §9.1). One function, unit-tested.
// Lower-casing happens in SQL with lower() on both sides, never here, so the query folds case exactly
// like the index expression.
import { SEARCH_LIMITS } from '@business-os/contracts';
import type { NormalizedQuery } from '@/core/search';
import { RuleViolationError } from '@/core/http/errors';

const TOKEN = /[\p{L}\p{N}]+/gu;
const TOKEN_ONLY = /^[\p{L}\p{N}]+$/u;
/** The word arm runs only from this many characters (§5.3): shorter prefixes are served by B-tree arms alone. */
export const WORD_ARM_MIN_LENGTH = 3;

export function normalizeQuery(raw: string): NormalizedQuery {
  const q = raw.normalize('NFC').trim().replace(/\s+/gu, ' ');
  const length = [...q].length;
  if (length < SEARCH_LIMITS.minQueryLength || length > SEARCH_LIMITS.maxQueryLength || q.split(' ').length > SEARCH_LIMITS.maxTerms) {
    throw new RuleViolationError('invalid_query', 'Type between 2 and 100 characters, in at most 8 words.');
  }
  const tokens = (q.match(TOKEN) ?? []).slice(0, SEARCH_LIMITS.maxTerms);
  return { q, tsquery: length >= WORD_ARM_MIN_LENGTH && tokens.length > 0 ? toTsquery(tokens) : null };
}

/**
 * `'tok1':* & 'tok2':*`. Every token is a run of letters and digits, so the text can hold no tsquery
 * operator, quote or backslash; anything else is a programming error and throws.
 */
export function toTsquery(tokens: readonly string[]): string {
  for (const token of tokens) if (!TOKEN_ONLY.test(token)) throw new Error('search token outside the letter/digit pattern');
  return tokens.map((t) => `'${t}':*`).join(' & ');
}
