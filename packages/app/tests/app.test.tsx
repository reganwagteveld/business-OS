import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createApiClient, parseClientConfig } from '../src';
import { Home } from '../src/shell/home';

const okBody = { status: 'ok', service: 'business-os-api', apiVersion: 'v1' };

describe('createApiClient', () => {
  it('calls the versioned health endpoint and validates the contract', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(okBody), { status: 200 }));
    const result = await createApiClient('https://api.example.test', fetchMock).health();
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.test/api/v1/health', expect.objectContaining({ method: 'GET' }));
    expect(result).toEqual({ ok: true, data: okBody });
  });

  it('rejects a response that does not match the contract', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }));
    expect(await createApiClient('https://api.example.test', fetchMock).health()).toEqual({ ok: false, error: 'Response did not match the API contract' });
  });

  it('reports HTTP and network failures honestly', async () => {
    const http = vi.fn(async () => new Response('nope', { status: 503 }));
    expect(await createApiClient('https://x.test', http).health()).toEqual({ ok: false, error: 'HTTP 503' });
    const network = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await createApiClient('https://x.test', network).health()).toEqual({ ok: false, error: 'Failed to fetch' });
  });
});

describe('parseClientConfig', () => {
  it('accepts https and local http, strips the trailing slash', () => {
    expect(parseClientConfig({ VITE_API_BASE_URL: 'https://api.example.test/' })).toEqual({ apiBaseUrl: 'https://api.example.test' });
    expect(parseClientConfig({ VITE_API_BASE_URL: 'http://localhost:3000' })).toEqual({ apiBaseUrl: 'http://localhost:3000' });
  });

  it('rejects missing, non-https and database URLs', () => {
    expect(() => parseClientConfig({})).toThrow(/VITE_API_BASE_URL/);
    expect(() => parseClientConfig({ VITE_API_BASE_URL: 'http://api.example.test' })).toThrow(/https/);
    expect(() => parseClientConfig({ VITE_API_BASE_URL: 'postgresql://u:p@db.example.test/db' })).toThrow(/https/);
  });
});

describe('Home', () => {
  it('shows the real API state and no business data', () => {
    const html = renderToStaticMarkup(<Home platform="desktop" apiBaseUrl="https://api.example.test" status={{ state: 'unreachable', reason: 'HTTP 503' }} />);
    expect(html).toContain('Desktop app');
    expect(html).toContain('Not reachable: HTTP 503');
  });
});
