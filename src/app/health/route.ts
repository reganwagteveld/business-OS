import { NextResponse } from 'next/server';
import { getEnv } from '@/core/config/env';
export const dynamic = 'force-dynamic';
export function GET() {
  getEnv();
  return NextResponse.json({ status: 'ok' }, { headers: { 'Cache-Control': 'no-store' } });
}
