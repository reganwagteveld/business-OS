import { describe, expect, it } from 'vitest';
import { violations } from '../scripts/check-boundaries.mjs';
describe('architectural boundaries', () => {
  it('forbids Prisma client outside core/db', () => expect(violations([['modules/customers/index.ts', "import '@prisma/client';"]])).toHaveLength(1));
  it('forbids domain modules importing app', () => expect(violations([['modules/customers/index.ts', "import '@/app/page';"]])).toHaveLength(1));
  it('forbids cross-module deep imports', () => expect(violations([['modules/customers/index.ts', "import '@/modules/identity/server/private';"]])).toHaveLength(1));
  it('forbids client-to-server imports', () => expect(violations([['ui/button.client.tsx', "import '@/core/db';"]])).toHaveLength(1));
  it('allows module public entrypoints', () => expect(violations([['modules/customers/index.ts', "import '@/modules/identity';"]])).toHaveLength(0));
});
