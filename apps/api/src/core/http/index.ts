import 'server-only';
import { getEnv } from '../config/env';
import { corsHeaders } from './cors';

/** Response headers every API route sends: no caching of tenant data (ADR 0002) plus CORS (ADR 0005). */
export function apiHeaders(request: Request): Record<string, string> {
  return { 'Cache-Control': 'private, no-store', ...corsHeaders(request.headers.get('origin'), getEnv().CORS_ALLOWED_ORIGINS) };
}

/** Answers a CORS preflight. Disallowed origins get 204 without CORS headers, so the browser blocks the call. */
export function preflight(request: Request): Response {
  return new Response(null, { status: 204, headers: apiHeaders(request) });
}
