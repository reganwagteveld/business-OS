# ADR 0007: Finance integrity, numbering and concurrency

- Status: **Proposed** (F0, Phase 6), revised after ChatGPT's first audit (series initial state; database-owned transition metadata). For final audit and Regan's approval. Nothing in F1 starts before then.
- Date: 2026-11-14
- Related: [finance-data-model.md](../finance-data-model.md), ADR 0004 (database isolation design), ADR 0006 (scheduling: the same "database holds the invariant, locks are for liveness" approach)

## Context

The Finance Zone records quotes, invoices, credit notes, manual payments, allocations of payments to invoices, and expenses. Some properties must hold even when service code is wrong or requests race:

1. No invoice is settled above its total, and no payment is allocated above its amount.
2. Document numbers are unique, gapless among issued documents, and cannot be chosen or reset by clients.
3. Issued documents, their lines and their billing snapshots never change.
4. Nothing links across businesses, and allocations only join records of the same customer and currency.
5. Financial history is never deleted by tenant code.

All of it must work under the existing isolation design (ADR 0004): forced RLS, `bos_app` without `BYPASSRLS`, a transaction-mode pooler, `READ COMMITTED`, Prisma 7.10.1 with `@prisma/adapter-pg`, and no privileged SQL unless unavoidable.

## Options considered

**Over-allocation and over-settlement**
1. *Service sums allocations under `SELECT … FOR UPDATE`.* Works only if every path locks and sums correctly; a forgotten lock double-spends silently.
2. *`SERIALIZABLE` transactions with retry.* Correct, but every finance write becomes retryable, the API would have to retry mutations (which the repository forbids, scheduling-data-model §10.2), and serialization failures are hard to explain to users.
3. *Database-maintained counters with CHECK constraints* (chosen). Each allocation increments `allocated_total` on its payment and invoice in an `AFTER` trigger; `CHECK (allocated_total <= total)` and `<= amount` refuse the excess. Row-level update serialisation makes it exact under `READ COMMITTED`.

**Numbering**
1. *PostgreSQL sequences.* Not gapless (rollbacks and caching burn numbers), one sequence per business and kind is unmanageable.
2. *Service reads max(number)+1.* Races; needs a lock anyway.
3. *A counter row per business and kind, incremented by the issue trigger in the issuing transaction* (chosen). Gapless across committed transactions, clients cannot choose numbers, rollback returns the number. Costs a hot row per series.

**Immutability**
1. *Column grants only.* Cannot express "editable while draft, frozen once issued".
2. *Service checks only.* Bypassable by any other code path.
3. *A `BEFORE UPDATE` guard comparing the row as jsonb minus an allow-list* (chosen). Deny-by-default: a column added later is frozen unless explicitly allowed.

**Document tables**
1. *Separate tables per kind.* Three copies of numbering, snapshot and guard logic.
2. *One `finance_documents` table with `kind`* (chosen), with kind pinned into composite FKs so an allocation can only reference an invoice and a credit note only an invoice.

## Decision

1. **Counters and CHECKs** hold settlement limits (option 3 above). `allocated_total` on invoices and payments is written only by the allocation triggers; direct writes are refused by a guard (`pg_trigger_depth() < 2`). Allocation and reversal triggers update the payment first, then the invoice.
2. **Database-assigned gapless numbers** from `finance_number_series`, inside the issue trigger, after the document row is locked. Formatting never truncates. Client-supplied numbers and hashes are overwritten. A series is created unused at an explicit `starting_value` (default 1; a migrating business continues its numbering), which can change only while no number has been issued.
3. **Sealing at issue.** The issue trigger recomputes every line (`round(qty × price, scale) − discount`, `round(net × pct / 100, scale)`, half away from zero) and the header sums, refuses any difference, stamps the number and `issued_at`, and stores a SHA-256 of the canonical content.
4. **Immutability guards**, deny-by-default, on documents, lines (via the parent's status, taken `FOR SHARE`), payments and expenses. Reversal of allocations and payments is one way. Void requires no allocations and no live credit notes.
5. **Composite FKs carry tenant, kind, customer and currency**, so cross-tenant links, allocations to non-invoices and cross-currency or cross-customer settlements are impossible even with raw SQL.
5a. **Transition metadata belongs to the database.** Issue, status-change, void, record and reversal times (and allocation creation and reversal times) are stamped with the transaction time, overwriting client values; void and reversal reasons are accepted only in their transition; outside it, none can be set, cleared or rewritten.
6. **No DELETE** on any finance table for any runtime role, except lines of a draft.
7. **All guards are `SECURITY INVOKER`** and run as `bos_app` under RLS. No `SECURITY DEFINER`, no extension, no privileged migration step.
8. **Lock order (liveness):** payments by id → documents (the one changed, then referenced ones `FOR SHARE`; several by id) → draft lines → number series. Services lock explicitly with `SELECT … ORDER BY id FOR NO KEY UPDATE` (not `FOR UPDATE`, which conflicts with the `FOR KEY SHARE` taken by FK checks).
9. **Idempotency:** `Idempotency-Key` required on recording payments, stored with a request hash under a business-scoped unique index; allocations are unique per live (payment, invoice) pair; transitions are state-conditional.
10. **No currency conversion.** Every amount carries its currency and snapshotted precision; reports are per currency.

Jurisdiction-specific rules (numbering regimes, mandatory content, tax modes, retention, e-invoicing) are not decided here; they are owner decisions FD-* in finance-data-model §14.

## Consequences

1. **Invariants survive service bugs and races.** The F0 spike shows it: 30 concurrent allocations to one invoice commit exactly as many as fit; 40 concurrent issues with 10 rollbacks leave 30 consecutive numbers; of 62 mutations removing one mechanism each, 57 fail at least one test on their own and the other 5 are deliberate backstops that fail when removed with the mechanism they back.
2. **Deadlocks are possible only on a wrong lock order, and are harmless to correctness.** K4 reproduces the crossed-settlement deadlock deterministically: one transaction gets `40P01` and rolls back whole. With the documented order the same pair queues. The API maps `40P01` to `503 retryable` (scheduling-data-model §10.2); it never retries by itself.
3. **Hot rows by design.** Each series row serialises issues for its business and kind; each invoice and payment row serialises its allocations. Expected volumes make this cheap; F1 measures it. Alternatives (multiple series, numbering decoupled from issue) need FD-L1.
4. **Trigger-depth guards** assume no other trigger updates the counters or series. F1 adds a schema test listing every trigger on finance tables.
5. **Administrative bypass.** An administrative role can disable triggers; the content hash and a reconciliation job (finance-data-model §10) detect the result after the fact.
6. **Error codes.** The spike uses generic SQLSTATEs (`42501` doubles as an RLS refusal). F1 assigns each guard a dedicated SQLSTATE and maps it to a stable API error.
7. **Retention conflicts with existing lifecycle jobs.** `ON DELETE RESTRICT` from finance tables to `businesses` blocks the current purge job for businesses with finance records until FD-L3 decides retention.
8. **Revisit if:** a jurisdiction requires per-period or pre-allocated numbering, signed or chained invoices, or real-time government reporting; volumes make the series row a bottleneck; or accounting (double-entry) becomes in scope (FD-A5), in which case allocations become journal lines and these counters become derived balances.
