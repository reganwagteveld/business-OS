import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const root = resolve('src');
const extensions = /\.(ts|tsx|js|jsx)$/;
function walk(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(resolve(dir, e.name)) : extensions.test(e.name) ? [resolve(dir, e.name)] : []); }
export function violations(files) {
  const errors = [];
  for (const [name, content] of files) {
    const isModule = name.startsWith('modules/');
    const imports = [...content.matchAll(/(?:import\s+(?:[\s\S]*?\s+from\s+)?|require\()\s*['"]([^'"]+)['"]/g)].map(m => m[1]);
    for (const spec of imports) {
      if (spec === '@prisma/client' && !name.startsWith('core/db/')) errors.push(`${name}: Prisma client outside core/db`);
      if (isModule && spec.startsWith('@/app/')) errors.push(`${name}: modules cannot import app`);
      if (isModule && /^(?:@\/modules\/)([^/]+)\/(?:server|internal)\//.test(spec) && !name.startsWith(`modules/${spec.split('/')[2]}/`)) errors.push(`${name}: cross-module deep import ${spec}`);
      if (name.includes('.client.') && (spec === 'server-only' || /^(?:@\/core\/(?:db|tenant)|@\/modules\/[^/]+\/server)/.test(spec))) errors.push(`${name}: client imports server-only module`);
      if (isModule && /^(?:@vercel\/|@aws-sdk\/|@upstash\/)/.test(spec)) errors.push(`${name}: vendor SDK inside domain module`);
    }
  }
  return errors;
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const files = walk(root).map(path => [relative(root, path).replaceAll('\\', '/'), readFileSync(path, 'utf8')]);
  const errors = violations(files);
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else console.log(`Boundary checks passed (${files.length} source files)`);
}
