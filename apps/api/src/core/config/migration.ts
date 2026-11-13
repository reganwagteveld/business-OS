// MIGRATION environment: owner-role credentials for `prisma migrate` and the migration check.
// Deliberately separate from the runtime schema (./schema.ts): the running API must boot, and
// must be deployable, without these values. Nothing under src/ except this file may read them
// (enforced by the `runtime-owner-credentials` source rule in scripts/check-boundaries.mjs).
import { z } from 'zod';
import { postgresUrl } from './schema';

export const migrationEnvSchema = z.object({
  MIGRATION_DATABASE_URL: postgresUrl,
  SHADOW_DATABASE_URL: postgresUrl.optional(),
});

export type MigrationEnv = z.infer<typeof migrationEnvSchema>;

export function parseMigrationEnv(input: Record<string, string | undefined>): MigrationEnv {
  const result = migrationEnvSchema.safeParse(input);
  if (!result.success) throw new Error(`Invalid migration environment:\n${z.prettifyError(result.error)}`);
  return result.data;
}
