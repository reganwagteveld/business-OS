import { useMemo } from 'react';
import { createApiClient, type ApiClient } from './api/client';
import type { ClientPlatform } from './config';
import { Home } from './shell/home';
import { useApiStatus } from './shell/use-api-status';

export interface AppProps {
  platform: ClientPlatform;
  apiBaseUrl: string;
  /** Injected in tests; production uses the default fetch-based client. */
  client?: ApiClient;
}

/** The shared client application, rendered identically by apps/desktop and apps/web. */
export function App({ platform, apiBaseUrl, client }: AppProps) {
  const api = useMemo(() => client ?? createApiClient(apiBaseUrl), [client, apiBaseUrl]);
  const status = useApiStatus(api);
  return <Home platform={platform} apiBaseUrl={apiBaseUrl} status={status} />;
}
