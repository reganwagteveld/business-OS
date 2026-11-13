// Writes src-tauri/tauri.generated.conf.json, merged over tauri.conf.json by `tauri build --config`.
// It narrows the Content Security Policy so the desktop app can connect only to the configured API
// origin (VITE_API_BASE_URL) and never to anything else, including a database host (ADR 0005).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function readDotEnv(path) {
  try {
    return Object.fromEntries(
      readFileSync(path, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#') && line.includes('='))
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
  } catch {
    return {};
  }
}

export function apiOrigin(value) {
  if (!value) throw new Error('VITE_API_BASE_URL is required to build the desktop app');
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error(`VITE_API_BASE_URL must be https (http only for localhost), got ${url.protocol}`);
  }
  return url.origin;
}

export function generatedConfig(baseConfig, origin) {
  const csp = { ...baseConfig.app.security.csp, 'connect-src': `'self' ipc: http://ipc.localhost ${origin}` };
  return { app: { security: { csp } } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = { ...readDotEnv(resolve(root, '.env')), ...process.env };
  const base = JSON.parse(readFileSync(resolve(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  const config = generatedConfig(base, apiOrigin(env.VITE_API_BASE_URL));
  writeFileSync(resolve(root, 'src-tauri/tauri.generated.conf.json'), `${JSON.stringify(config, null, 2)}\n`);
  console.log(`Desktop CSP connect-src: ${config.app.security.csp['connect-src']}`);
}
