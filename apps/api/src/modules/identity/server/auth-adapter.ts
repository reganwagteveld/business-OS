import 'server-only';
// The identity module's Better Auth instance (ADR 0001). The ONLY file that may import the bos_auth
// database client. Everything else in the app depends on ../index.ts, never on Better Auth.
import { randomUUID } from 'node:crypto';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { getAuthPrisma } from '@/core/db/auth-client';
import { getEnv } from '@/core/config/env';
import { sendEmail } from '@/core/email';
import { withHashedSecrets } from './hashed-adapter';

export const AUTH_BASE_PATH = '/api/v1/auth';
const DAY = 60 * 60 * 24;

function createAuth() {
  const env = getEnv();
  const secure = env.APP_BASE_URL.startsWith('https://');
  const inner = prismaAdapter(getAuthPrisma(), { provider: 'postgresql' });
  return betterAuth({
    appName: 'Business OS',
    baseURL: env.APP_BASE_URL,
    basePath: AUTH_BASE_PATH,
    secret: env.AUTH_SECRET,
    telemetry: { enabled: false },
    database: ((options: BetterAuthOptions) => withHashedSecrets(inner(options) as never)) as typeof inner,
    user: { fields: { image: 'imageUrl' } },
    session: {
      fields: { token: 'tokenHash' },
      expiresIn: 30 * DAY,
      updateAge: DAY,
      // Every request checks the database, so a revoked session stops working immediately.
      cookieCache: { enabled: false },
    },
    emailAndPassword: {
      enabled: true,
      // Also makes sign-up answer identically for new and existing emails (ADR 0001 condition 3).
      requireEmailVerification: true,
      autoSignIn: false,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: 60 * 60,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        await sendEmail({ to: user.email, subject: 'Reset your Business OS password', text: `Reset your password: ${url}\n\nThe link expires in 1 hour. If you did not ask for this, ignore this email.` });
      },
      // The person who owns the address learns about the attempt; the requester learns nothing.
      onExistingUserSignUp: async ({ user }) => {
        await sendEmail({ to: user.email, subject: 'Someone tried to create a Business OS account with your email', text: 'You already have an account. If this was you, sign in or reset your password. If not, you can ignore this email.' });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: false,
      expiresIn: DAY,
      sendVerificationEmail: async ({ user, url }) => {
        await sendEmail({ to: user.email, subject: 'Verify your email for Business OS', text: `Confirm your email address: ${url}\n\nThe link expires in 24 hours.` });
      },
    },
    rateLimit: {
      enabled: true,
      // Counters live in PostgreSQL so limits hold across serverless instances (ADR 0001 condition 2).
      storage: 'database',
      window: 60,
      max: 60,
      customRules: {
        '/sign-in/email': { window: 60, max: 5 },
        '/sign-up/email': { window: 60 * 60, max: 10 },
        '/request-password-reset': { window: 60 * 60, max: 5 },
        '/reset-password': { window: 60 * 60, max: 10 },
        '/send-verification-email': { window: 60 * 60, max: 5 },
      },
    },
    trustedOrigins: [new URL(env.APP_BASE_URL).origin, ...env.CORS_ALLOWED_ORIGINS],
    advanced: {
      cookiePrefix: 'bos',
      useSecureCookies: secure,
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', secure, path: '/' },
      database: { generateId: () => randomUUID() },
    },
  });
}

let instance: ReturnType<typeof createAuth> | undefined;

export function getAuth() {
  instance ??= createAuth();
  return instance;
}
