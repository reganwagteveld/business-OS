/**
 * Spike test S3 (docs/data-model.md §5.4): fail closed at the type level. Checked by `tsc`
 * (`pnpm typecheck`, run in CI); every line marked @ts-expect-error must stay a type error.
 */
import type { PrismaClient } from './generated/prisma/client';
import type { TenantDb } from '@/core/db/with-tenant';

type Tx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'>;
type CustomersDb = TenantDb<Tx, 'customer' | 'contact'>;

/** A module service: it can only be called with a TenantDb handed out by withTenant. */
export async function listCustomers(db: CustomersDb) {
  return db.customer.findMany();
}

export async function misuse(client: PrismaClient, tx: Tx, db: CustomersDb) {
  // @ts-expect-error a plain client is not a TenantDb: no tenant context was set
  await listCustomers(client);
  // @ts-expect-error a transaction opened outside withTenant is not a TenantDb either
  await listCustomers(tx);
  // @ts-expect-error no nested transactions inside a unit of work
  await db.$transaction(async () => undefined);
  // @ts-expect-error no string-built SQL
  await db.$queryRawUnsafe('SELECT 1');
  // @ts-expect-error no unscoped raw writes
  await db.$executeRawUnsafe('DELETE FROM customers');
  // @ts-expect-error models outside the service's declared set are not reachable
  await db.business.findMany();
}
