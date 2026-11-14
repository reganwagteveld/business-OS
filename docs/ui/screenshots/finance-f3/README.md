# Finance F3 screenshots

Taken from the real web build (`apps/web`, production `vite build`) talking to the real F3 API (`next dev`) on a local throwaway PostgreSQL database with the F1–F3 migrations applied. The data was entered through the API: a business in AUD with a 10% "GST" tax rate (the business's own rate, not a built-in one), six expenses (draft, unpaid bill, partly paid and overdue, paid by card, paid in full at recording, void) and one custom category. Captured with Playwright (Chrome) at device scale 2.

| File | Shows |
|---|---|
| 01-expenses-list | Expense list: per-currency unpaid total from the server, filters, status and payment badges |
| 02-expenses-filtered-not-fully-paid | Server-side "Not fully paid" filter |
| 03-expense-detail-partly-paid-overdue | Detail: tax split, paid and left to pay, payment history |
| 04-void-blocked-by-payments | Void refused while payments are linked (F3-D3) |
| 05-record-dialog-paid-in-full | Recording a draft, optionally paid in full |
| 06-new-expense-form | Draft form: only the receipt figure is entered |
| 07-categories | Default and custom categories, reorder, rename, archive |
| 08-expenses-list-dark | Dark theme |
| 09-expenses-list-mobile, 09b-expenses-table-mobile, 10-expense-detail-mobile | 390 px wide |

There is no receipt upload or download anywhere (F3-D2).
