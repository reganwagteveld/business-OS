import { App, parseClientConfig } from '@business-os/app';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';

const { apiBaseUrl } = parseClientConfig(import.meta.env);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App platform="web" apiBaseUrl={apiBaseUrl} />
  </StrictMode>,
);
