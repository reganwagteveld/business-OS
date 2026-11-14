import { useEffect, useEffectEvent, useState } from 'react';
import type { Outcome } from '../api/tenancy';

export type Loaded<T> = { status: 'loading' } | { status: 'done'; outcome: Outcome<T> };

/**
 * Runs one read per `key` and ignores anything that comes back for an older key (a fast typist, a
 * business switch, a retry). The previous request is aborted. Nothing is cached across keys, so one
 * business's data is never shown under another.
 */
export function useLoad<T>(key: string, load: (signal: AbortSignal) => Promise<Outcome<T>>): {
  state: Loaded<T>;
  reload: () => void;
  /** The last answer for this exact key before the current reload, so a refresh can keep showing it. */
  previous: Outcome<T> | null;
} {
  const [tick, setTick] = useState(0);
  const [result, setResult] = useState<{ key: string; outcome: Outcome<T> } | null>(null);
  const fullKey = `${key}#${tick}`;
  const run = useEffectEvent(load);
  useEffect(() => {
    const abort = new AbortController();
    let live = true;
    void run(abort.signal).then(
      (outcome) => {
        if (live) setResult({ key: fullKey, outcome });
      },
      () => {
        if (live) setResult({ key: fullKey, outcome: { kind: 'unreachable' } });
      },
    );
    return () => {
      live = false;
      abort.abort();
    };
  }, [fullKey]);
  const sameKey = result !== null && result.key.slice(0, result.key.lastIndexOf('#')) === key;
  return {
    state: result?.key === fullKey ? { status: 'done', outcome: result.outcome } : { status: 'loading' },
    reload: () => setTick((t) => t + 1),
    previous: sameKey ? result.outcome : null,
  };
}
