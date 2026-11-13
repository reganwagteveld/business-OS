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
    // The auth library's own role (bos_auth): only the identity module's auth adapter uses it.
    AUTH_DATABASE_URL: postgresUrl,
    // Signs session cookies and desktop bearer tokens. At least 32 characters, never committed.
    AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),
    // Where verification and password-reset emails go. "log" writes them to the server log and is
    // refused in Vercel production; "resend" sends through the provider's HTTPS API.
    EMAIL_TRANSPORT: z.enum(['log', 'resend']).default('log'),
    EMAIL_FROM: z.string().min(3).optional(),
    RESEND_API_KEY: z.string().min(1).optional(),
    // Set by Vercel: "production", "preview" or "development".
    VERCEL_ENV: z.string().optional(),
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
    if (value.VERCEL_ENV === 'production' && value.EMAIL_TRANSPORT === 'log') {
      ctx.addIssue({ code: 'custom', path: ['EMAIL_TRANSPORT'], message: 'Production must send real email (EMAIL_TRANSPORT=resend)' });
    }
    if (value.EMAIL_TRANSPORT === 'resend' && (!value.RESEND_API_KEY || !value.EMAIL_FROM)) {
      ctx.addIssue({ code: 'custom', path: ['RESEND_API_KEY'], message: 'EMAIL_TRANSPORT=resend needs RESEND_API_KEY and EMAIL_FROM' });
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
