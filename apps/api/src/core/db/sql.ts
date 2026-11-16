import 'server-only';
// Composable tagged SQL for the few services that build one statement from reviewed fragments
// (global search, docs/global-search-gs1.md §5.3). Values are always bound parameters; `rawSql` is
// only for constant identifiers and expressions written in source code, never for request input.
import { Prisma } from '../../generated/prisma/client';

export type SqlFragment = Prisma.Sql;
export const sql = Prisma.sql;
export const joinSql = Prisma.join;
export const emptySql = Prisma.empty;
/** A constant SQL fragment from source code. Never pass request data. */
export const rawSql = (constant: string): SqlFragment => Prisma.raw(constant);
