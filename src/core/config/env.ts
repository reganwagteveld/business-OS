import 'server-only';
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.url().refine((url) => url.startsWith('postgresql://') || url.startsWith('postgres://'), 'Must be a PostgreSQL URL'),
  MIGRATION_DATABASE_URL: z.url().refine((url) => url.startsWith('postgresql://') || url.startsWith('postgres://'), 'Must be a PostgreSQL URL'),
  APP_BASE_URL: z.url(),
  REGION: z.string().min(1),
  DATABASE_REGION: z.string().min(1),
}).superRefine((value, ctx) => {
  if (value.REGION !== value.DATABASE_REGION) ctx.addIssue({ code: 'custom', path: ['DATABASE_REGION'], message: 'Application and database regions must match' });
});

export function parseEnv(input: NodeJS.ProcessEnv) {
  const result = envSchema.safeParse(input);
  if (!result.success) throw new Error(`Invalid Business OS environment: ${z.prettifyError(result.error)}`);
  return result.data;
}
export function getEnv() { return parseEnv(process.env); }
