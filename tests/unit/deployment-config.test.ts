import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VERCEL_TO_AWS_REGION } from '@/core/config/regions';

const vercel = JSON.parse(readFileSync(resolve(__dirname, '../../vercel.json'), 'utf8')) as { regions?: string[] };

describe('deployment configuration (ADR 0002)', () => {
  it('pins functions to exactly one region', () => expect(vercel.regions).toHaveLength(1));
  it('pins functions to US East (N. Virginia), colocated with the database', () =>
    expect(VERCEL_TO_AWS_REGION[vercel.regions?.[0] ?? '']).toBe('us-east-1'));
});
