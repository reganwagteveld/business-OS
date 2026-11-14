import type { ExpensePaymentState, ExpenseTaxTreatment, FinanceExpenseStatus } from '@business-os/contracts';
import type { BadgeTone } from '@business-os/ui';

export { formatDate, formatMoney, formatWhen } from '../sales/format';

export const STATUS_LABEL: Record<FinanceExpenseStatus, string> = { DRAFT: 'Draft', RECORDED: 'Recorded', VOID: 'Void' };
export const STATUS_TONE: Record<FinanceExpenseStatus, BadgeTone> = { DRAFT: 'neutral', RECORDED: 'brand', VOID: 'danger' };
export const PAYMENT_LABEL: Record<ExpensePaymentState, string> = { UNPAID: 'Unpaid', PARTIALLY_PAID: 'Partly paid', PAID: 'Paid' };
export const PAYMENT_TONE: Record<ExpensePaymentState, BadgeTone> = { UNPAID: 'warning', PARTIALLY_PAID: 'info', PAID: 'success' };
export const TREATMENT_LABEL: Record<ExpenseTaxTreatment, string> = {
  NO_TAX: 'No tax',
  TAX_INCLUSIVE: 'Amount includes tax',
  TAX_EXCLUSIVE: 'Tax is added to the amount',
};
export const METHOD_LABEL = { BANK_TRANSFER: 'Bank transfer', CASH: 'Cash', CARD: 'Card', CHEQUE: 'Cheque', OTHER: 'Other' } as const;

/** Server error codes, in words a person can act on. */
export function conflictMessage(code: string | undefined): string {
  switch (code) {
    case 'stale': return 'Someone else changed this expense. Reload it and try again.';
    case 'archived_reference': return 'The category, tax rate, project or customer you chose has been archived. Choose an active one.';
    case 'has_payments': return 'This expense has payments. Reverse its payments first, then void it.';
    case 'invalid_state': return 'This expense can no longer be changed in that way.';
    case 'duplicate_name': return 'An active category already has that name.';
    case 'over_payment': return 'That is more than the expense has left to pay.';
    default: return 'That change could not be made. Reload and try again.';
  }
}
