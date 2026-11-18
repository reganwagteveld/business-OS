import { App, applyStoredTheme, createDesktopTransport, createHashHistory, parseClientConfig } from '@business-os/app';
import { invoke } from '@tauri-apps/api/core';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';

// The desktop app is the same shared client as the browser app, inside a native window.
// It has no direct database access and no server code: all data comes from the cloud API (ADR 0005).
// Sign-in happens in the system browser; the session token lives in the OS credential store (D9a).
const { apiBaseUrl } = parseClientConfig(import.meta.env);

const transport = createDesktopTransport(apiBaseUrl, {
  awaitBrowserSignIn: (authorizeUrl, state) => invoke('await_browser_sign_in', { authorizeUrl, state }),
  loadToken: () => invoke<string | null>('load_session_token'),
  storeToken: (token) => invoke('store_session_token', { token }),
  forgetToken: () => invoke('forget_session_token'),
});

// Apply a theme chosen on this device before the first paint, so it does not flash the OS one.
applyStoredTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App platform="desktop" apiBaseUrl={apiBaseUrl} transport={transport} history={createHashHistory()} />
  </StrictMode>,
);
