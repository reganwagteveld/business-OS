import 'server-only';
import { APIError } from 'better-auth/api';
import { betaCanRegister, betaCanSignIn } from '@/core/db';

// Lifecycle hooks cover email signup, future OAuth first-login and internal auth APIs.
// Provider profiles and client-supplied fields cannot grant admission.
export const admissionHooks = {
  user: { create: { before: async (user: { email: string }) => {
    if (!await betaCanRegister(user.email)) {
      throw new APIError('FORBIDDEN', { code: 'INVITE_REQUIRED', message: 'An invitation is required to join the private beta.' });
    }
  } } },
  session: { create: { before: async (session: { userId: string }) => {
    if (!await betaCanSignIn(session.userId)) {
      throw new APIError('FORBIDDEN', { code: 'INVITE_REQUIRED', message: 'An invitation is required to join the private beta.' });
    }
  } } },
};
