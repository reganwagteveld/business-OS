// Pure RUNTIME environment schema: no secrets are read here, so it is safe to import from
// instrumentation and tests. Server code reads the environment through ./env.ts.
// The running API never holds migration-owner credentials: those are validated separately in
// ./migration.ts and used only by migration tooling (architecture §7.3 layer 4, ADR 0004).
import { z } from 'zod';
import { VERCEL_TO_AWS_REGION } from './regions';

// Exact origins only: scheme://host[:port], no wildcard, no path. tauri:// is the macOS desktop app.
const ORIGIN = /^(https?|tauri):\/\/[a-z0-9.-]+(:\d{1,5})?$/;

const originList = z
  .string()
  .default('')
  .transform((value) => value.split(',').map((origin) => origin.trim()).filter(Boolean))
  .pipe(z.array(z.string().regex(ORIGIN, 'Each CORS origin must be an exact origin such as https://app.example.com (no wildcard, no path)')));

export const postgresUrl = z
  .url()
  .refine((url) => url.startsWith('postgresql://') || url.startsWith('postgres://'), 'Must be a PostgreSQL URL');

export const envSchema = z
  .object({
    DATABASE_URL: postgresUrl,
    APP_BASE_URL: z.url(),
    // Browser and desktop origins allowed to call the API cross-origin. Empty means none (ADR 0005).
    CORS_ALLOWED_ORIGINS: originList,
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
