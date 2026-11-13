import { App, parseClientConfig } from '@business-os/app';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';

// The desktop app is the same shared client as the browser app, inside a native window.
// It has no direct database access and no server code: all data comes from the cloud API (ADR 0005).
const { apiBaseUrl } = parseClientConfig(import.meta.env);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App platform="desktop" apiBaseUrl={apiBaseUrl} />
  </StrictMode>,
);
