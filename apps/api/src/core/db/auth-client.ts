import 'server-only';
// Prisma client for the auth library's own role, bos_auth (ADR 0001, data-model §5.1). It can reach
// the identity tables and nothing else. Only modules/identity/server/auth-adapter.ts may import
// this file (source rule `auth-client-only-in-identity`).
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';
import { getEnv } from '../config/env';

let client: PrismaClient | undefined;

export function getAuthPrisma(): PrismaClient {
  client ??= new PrismaClient({ adapter: new PrismaPg({ connectionString: getEnv().AUTH_DATABASE_URL, max: 5 }) });
  return client;
}

export type AuthPrisma = PrismaClient;
