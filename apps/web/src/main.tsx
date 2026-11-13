import { App, parseClientConfig } from '@business-os/app';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';

// The browser app is served from the same site as the API (D9b), so the HTTP-only session cookie is
// first-party and never readable by this code.
const { apiBaseUrl } = parseClientConfig(import.meta.env);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App
      platform="web"
      apiBaseUrl={apiBaseUrl}
      transport={{ kind: 'cookie' }}
      location={{ pathname: window.location.pathname, search: window.location.search }}
      navigate={(url) => window.location.assign(url)}
    />
  </StrictMode>,
);
