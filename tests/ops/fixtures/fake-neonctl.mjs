#!/usr/bin/env node
// Fake, read-only `neonctl api <path>` for CLI tests. Serves JSON from FAKE_NEON_STATE; never contacts Neon.
import { readFileSync } from 'node:fs';

const [cmd, path, ...rest] = process.argv.slice(2);
if (cmd !== 'api' || rest.length > 0) {
  process.stderr.write(`fake neonctl: unsupported call ${process.argv.slice(2).join(' ')}\n`);
  process.exit(9);
}
const state = JSON.parse(readFileSync(process.env.FAKE_NEON_STATE, 'utf8'));
if (/\/branches(\?|$)/.test(path)) process.stdout.write(JSON.stringify({ branches: state.branches }));
else if (/\/endpoints$/.test(path)) process.stdout.write(JSON.stringify({ endpoints: state.endpoints }));
else {
  process.stderr.write(`fake neonctl: unknown path ${path}\n`);
  process.exit(9);
}
