import 'server-only';
// Exact decimal arithmetic for money (docs/sales-data-model.md §3). Re-exported from core/db so
// modules never import Prisma directly (architecture §5.2 rule 6).
import { Prisma } from '../../generated/prisma/client';

export const Decimal = Prisma.Decimal;
export type Decimal = Prisma.Decimal;
