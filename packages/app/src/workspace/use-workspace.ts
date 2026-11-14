import type { CreateBusinessRequest } from '@business-os/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import type { AuthClient } from '../api/auth';
import type { TenancyClient } from '../api/tenancy';
import { createBusinessFlow, resolveWorkspace, type Phase } from './resolve';
import type { WorkspaceStorage } from './storage';

const STARTING = 'Starting Business OS…';
const OPENING = 'Opening your workspace…';

export type CreateBusinessInput = z.infer<typeof CreateBusinessRequest>;
export type CreateResult = { ok: true } | { ok: false; message: string };

export interface WorkspaceController {
  phase: Phase;
  /** Runs the whole resolution again (used by Retry and after sign-in). */
  retry(): void;
  /** Opens a business the person chose; the server still decides whether they may. */
  select(slug: string): void;
  /**
   * Creates a business and opens it. After a network failure the server may still have created it,
   * so memberships are read again before anything is retried (no duplicate businesses).
   */
  create(input: CreateBusinessInput): Promise<CreateResult>;
  signOut(): Promise<void>;
}

export function useWorkspace(deps: { auth: AuthClient; tenancy: TenancyClient; storage: WorkspaceStorage }): WorkspaceController {
  const { auth, tenancy, storage } = deps;
  const [phase, setPhase] = useState<Phase>({ kind: 'booting', message: STARTING });
  const run = useRef(0);
  const controller = useRef<AbortController | null>(null);

  const start = useCallback(
    (message: string, preferredSlug?: string) => {
      controller.current?.abort();
      const abort = new AbortController();
      controller.current = abort;
      const mine = ++run.current;
      setPhase({ kind: 'booting', message });
      void resolveWorkspace({ auth, tenancy, storage, preferredSlug, signal: abort.signal }).then(
        (resolved) => {
          if (mine === run.current) setPhase(resolved);
        },
        () => {
          // An aborted request is a newer run taking over; anything else is an unexpected failure.
          if (mine === run.current && !abort.signal.aborted) setPhase({ kind: 'failed' });
        },
      );
    },
    [auth, tenancy, storage],
  );

  useEffect(() => {
    // Begin after the first paint (the state is already "booting"), not synchronously inside the effect.
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) start(STARTING);
    });
    return () => {
      cancelled = true;
      controller.current?.abort();
    };
  }, [start]);

  // When the device comes back online, try again by itself if we were stuck offline.
  const unreachable = phase.kind === 'unreachable';
  useEffect(() => {
    if (!unreachable || typeof window === 'undefined') return;
    const again = () => start(STARTING);
    window.addEventListener('online', again);
    return () => window.removeEventListener('online', again);
  }, [unreachable, start]);

  const creating = useRef(false);
  const create = async (input: CreateBusinessInput): Promise<CreateResult> => {
    if (creating.current) return { ok: false, message: 'Already creating your business…' }; // double submit
    creating.current = true;
    try {
      const result = await createBusinessFlow(tenancy, input);
      if (result.kind === 'created') {
        start(OPENING, result.slug);
        return { ok: true };
      }
      if (result.kind === 'session-ended') {
        start(STARTING); // resolution will show sign-in
        return { ok: false, message: 'Your session has ended. Please sign in again.' };
      }
      return { ok: false, message: result.message };
    } finally {
      creating.current = false;
    }
  };

  return {
    phase,
    retry: () => start(STARTING),
    select: (slug) => start(OPENING, slug),
    create,
    signOut: async () => {
      await auth.signOut();
      storage.setHadSession(false);
      storage.clearSlug();
      start(STARTING);
    },
  };
}
