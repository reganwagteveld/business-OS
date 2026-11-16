import 'server-only';
// Authorisation of the internal scheduler routes (docs/finance-billing-f6.md §5, §10.6). Vercel Cron
// sends `Authorization: Bearer $CRON_SECRET`; SHA-256 digests are compared in constant time.
import { createHash, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

const digest = (v: string) => createHash('sha256').update(v).digest();

export function cronAuthorised(request: Request, secret: string): boolean {
  const header = request.headers.get('authorization') ?? '';
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}

export const cronReply = (status: number, body: unknown) => NextResponse.json(body, { status, headers: { 'cache-control': 'no-store' } });
