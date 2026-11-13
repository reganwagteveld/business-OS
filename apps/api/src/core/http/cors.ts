// CORS for the cloud API (ADR 0005). The desktop and browser apps are separate origins, so the API
// answers cross-origin requests only for an exact allowlist from validated configuration. CORS is a
// browser courtesy, not access control: every endpoint still authenticates and authorises itself.

const ALLOWED_METHODS = 'GET, POST, PATCH, DELETE, OPTIONS';
const ALLOWED_HEADERS = 'Accept, Authorization, Content-Type';

/** Headers to add to a response for a request from `origin`. Unknown origins get no CORS grant. */
export function corsHeaders(origin: string | null, allowedOrigins: readonly string[]): Record<string, string> {
  const headers: Record<string, string> = { Vary: 'Origin' };
  if (origin && allowedOrigins.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = ALLOWED_METHODS;
    headers['Access-Control-Allow-Headers'] = ALLOWED_HEADERS;
    headers['Access-Control-Max-Age'] = '600';
  }
  return headers;
}
