import 'server-only';
// Path parameters of the finance routes. A malformed id answers exactly like a missing one (404).
import { RecordNotFoundError } from '@/core/http/errors';
import type { FinanceKind } from '@/modules/finance';
import { isUuid } from './routes';

export function documentIdOf(params: Record<string, string>): string {
  if (!isUuid(params.documentId)) throw new RecordNotFoundError();
  return params.documentId;
}

const KINDS: Record<string, FinanceKind> = { quote: 'QUOTE', invoice: 'INVOICE', 'credit-note': 'CREDIT_NOTE' };
export function seriesKindOf(params: Record<string, string>): FinanceKind {
  const kind = KINDS[params.kind ?? ''];
  if (!kind) throw new RecordNotFoundError();
  return kind;
}
