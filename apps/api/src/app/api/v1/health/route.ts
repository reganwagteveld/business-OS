import { HealthResponse } from '@business-os/contracts';
import { NextResponse } from 'next/server';
import { apiHeaders, preflight } from '@/core/http';

export const dynamic = 'force-dynamic';

/** Liveness check (contract: endpoints.health). Validates configuration but never touches tenant data. */
export function GET(request: Request) {
  const body: HealthResponse = { status: 'ok', service: 'business-os-api', apiVersion: 'v1' };
  return NextResponse.json(HealthResponse.parse(body), { headers: apiHeaders(request) });
}

export function OPTIONS(request: Request) {
  return preflight(request);
}
