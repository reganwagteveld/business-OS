// Pure environment schema: no secrets are read here, so it is safe to import from
// instrumentation and tests. Server code reads the environment through ./env.ts.
import { z } from 'zod';
import { VERCEL_TO_AWS_REGION } from './regions';

const postgresUrl = z
  .url()
  .refine((url) => url.startsWith('postgresql://') || url.startsWith('postgres://'), 'Must be a PostgreSQL URL');

export const envSchema = z
  .object({
    DATABASE_URL: postgresUrl,
    MIGRATION_DATABASE_URL: postgresUrl,
    APP_BASE_URL: z.url(),
    REGION: z.string().min(1),
    DATABASE_REGION: z.string().min(1),
    // Set by Vercel at runtime to the region the function is actually running in.
    VERCEL_REGION: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.REGION !== value.DATABASE_REGION) {
      ctx.addIssue({ code: 'custom', path: ['DATABASE_REGION'], message: 'Application and database regions must match' });
    }
    if (value.VERCEL_REGION && value.VERCEL_REGION !== 'dev1') {
      const actual = VERCEL_TO_AWS_REGION[value.VERCEL_REGION];
      if (actual !== value.REGION) {
        ctx.addIssue({
          code: 'custom',
          path: ['VERCEL_REGION'],
          message: `Functions are running in ${value.VERCEL_REGION} (${actual ?? 'unknown region'}) but REGION is ${value.REGION}; compute and database must be colocated`,
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

export function parseEnv(input: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(input);
  if (!result.success) throw new Error(`Invalid Business OS environment:\n${z.prettifyError(result.error)}`);
  return result.data;
}
