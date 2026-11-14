import { App, applyStoredTheme, parseClientConfig } from '@business-os/app';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';

// The browser app is served from the same site as the API (D9b), so the HTTP-only session cookie is
// first-party and never readable by this code.
const { apiBaseUrl } = parseClientConfig(import.meta.env);

// Apply a theme chosen on this device before the first paint, so it does not flash the OS one.
applyStoredTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App
      platform="web"
      apiBaseUrl={apiBaseUrl}
      transport={{ kind: 'cookie' }}
      location={{ pathname: window.location.pathname, search: window.location.search }}
      navigate={(url) => window.location.assign(url)}
      replaceLocation={(path) => window.history.replaceState(null, '', path)}
    />
  </StrictMode>,
);
