import { Card, CardContent, CardDescription, CardHeader, CardTitle, StatusIndicator } from '@business-os/ui';
import type { CurrentUser } from '@business-os/contracts';
import type { ClientPlatform } from '../config';
import type { ApiStatus } from './use-api-status';

const PLATFORM_LABEL: Record<ClientPlatform, string> = { desktop: 'Desktop app', web: 'Browser app' };

/**
 * Phase 1a Home shell. It shows only real information: which client is running and whether the API
 * answers. Zones and business data arrive in later phases (no placeholder metrics).
 */
export function Home({ platform, apiBaseUrl, status, user, onSignOut }: {
  platform: ClientPlatform;
  apiBaseUrl: string;
  status: ApiStatus;
  user?: CurrentUser;
  onSignOut?: () => void;
}) {
  return (
    <div className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-4 py-10">
      <header className="flex items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Business OS</h1>
        <span className="text-sm text-muted-foreground">{PLATFORM_LABEL[platform]}</span>
      </header>
      {user ? (
        <Card>
          <CardHeader>
            <CardTitle>Signed in</CardTitle>
            <CardDescription className="break-all">{user.name ? `${user.name} · ${user.email}` : user.email}</CardDescription>
          </CardHeader>
          <CardContent>
            <button type="button" className="text-sm underline underline-offset-4" onClick={onSignOut}>Sign out</button>
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Cloud API</CardTitle>
          <CardDescription className="break-all">{apiBaseUrl}</CardDescription>
        </CardHeader>
        <CardContent>
          <ApiStatusLine status={status} />
        </CardContent>
      </Card>
    </div>
  );
}

function ApiStatusLine({ status }: { status: ApiStatus }) {
  switch (status.state) {
    case 'checking':
      return <StatusIndicator tone="pending">Checking connection…</StatusIndicator>;
    case 'connected':
      return <StatusIndicator tone="ok">Connected (API {status.apiVersion})</StatusIndicator>;
    case 'unreachable':
      return <StatusIndicator tone="error" role="alert">Not reachable: {status.reason}</StatusIndicator>;
  }
}
