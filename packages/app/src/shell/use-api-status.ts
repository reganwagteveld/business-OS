import { useEffect, useState } from 'react';
import type { ApiClient } from '../api/client';

export type ApiStatus = { state: 'checking' } | { state: 'connected'; apiVersion: string } | { state: 'unreachable'; reason: string };

/** Checks the API once on mount. Reports the real result; there is no offline or cached mode (ADR 0005). */
export function useApiStatus(client: ApiClient): ApiStatus {
  const [status, setStatus] = useState<ApiStatus>({ state: 'checking' });
  useEffect(() => {
    const controller = new AbortController();
    client.health(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setStatus(result.ok ? { state: 'connected', apiVersion: result.data.apiVersion } : { state: 'unreachable', reason: result.error });
    });
    return () => controller.abort();
  }, [client]);
  return status;
}
