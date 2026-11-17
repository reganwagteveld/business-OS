// AT-11 "no pills" source scan (docs/ui/pixa-visual-identity-v2-b2.md §10, §4 rule 4).
//
// Finds round or capsule shapes however they are written, not only the literal `rounded-full`:
// - Tailwind radius classes on any side or corner: rounded-full, rounded-pill, rounded-dialog (16 px), rounded-3xl,
//   rounded-4xl, rounded-(--radius-pill), and arbitrary values such as rounded-[9999px], rounded-[50%], rounded-[2rem]
//   or rounded-[var(--radius-pill)] (arbitrary radii of 16 px or more, any percentage, any pill or dialog token);
// - CSS and inline styles: border-radius 50% or 100%, 9999px-style values and var(--radius-pill);
// - shapes inherited from a component variant: a `packages/ui` component whose own source has a round shape makes
//   every `<Component` use in an app count too, so a pill cannot hide behind <Badge> or <StatusIndicator>.
// Loading spinners (`animate-spin`) are exempt: a spinning ring is a progress indicator, not a control shape.
//
// Run: node packages/ui/scripts/pill-scan.ts  (prints counts for packages/ui and packages/app)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIDE = String.raw`(?:-(?:t|r|b|l|tl|tr|br|bl|s|e|ss|se|es|ee))?`;
const CLASS = new RegExp(String.raw`(?<![\w-])rounded${SIDE}-(full|pill|dialog|3xl|4xl|\(--radius-(?:pill|dialog)\)|\[[^\]\s]+\])`, 'g');
const CSS = /border-?radius\s*:\s*['"]?\s*(50%|100%|\d{3,}(?:px)?|var\(--radius-(?:pill|dialog)\))|borderRadius\s*:\s*(\d{3,})\b/gi;
const DECLARATION = /^\s*--radius-(?:pill|dialog)\s*:/;

/** True when an arbitrary radius such as `[9999px]` or `[50%]` would make a typical control round. */
function roundArbitrary(value: string): boolean {
  const inner = value.slice(1, -1);
  if (/radius-(?:pill|dialog)/.test(inner)) return true;
  if (inner.endsWith('%')) return true;
  const px = /^(\d+(?:\.\d+)?)px$/.exec(inner);
  if (px) return Number(px[1]) >= 16;
  const rem = /^(\d+(?:\.\d+)?)r?em$/.exec(inner);
  return rem ? Number(rem[1]) >= 1 : false;
}

export type PillHit = { file: string; line: number; text: string };

/** Round shapes written directly in one source text. */
export function findPills(source: string, file = '<source>'): PillHit[] {
  const hits: PillHit[] = [];
  source.split('\n').forEach((text, i) => {
    if (DECLARATION.test(text) || text.includes('animate-spin')) return;
    for (const m of text.matchAll(CLASS)) {
      const value = m[1]!;
      if (value.startsWith('[') && !roundArbitrary(value)) continue;
      hits.push({ file, line: i + 1, text: m[0] });
    }
    for (const m of text.matchAll(CSS)) hits.push({ file, line: i + 1, text: m[0] });
  });
  return hits;
}

/**
 * Names of exported components whose own body has a round shape. A file is split at each top-level
 * `export function`, so one round helper does not mark every export in the same file.
 */
export function roundComponents(source: string): string[] {
  const parts = source.split(/^(?=export function )/m);
  return parts.flatMap((part) => {
    const name = /^export function ([A-Z]\w*)/.exec(part)?.[1];
    return name && findPills(part).length > 0 ? [name] : [];
  });
}

/** Names a source imports from `@business-os/ui`. */
function uiImports(source: string): string[] {
  return [...source.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]@business-os\/ui['"]/g)].flatMap((m) =>
    m[1]!.split(',').map((s) => s.trim().split(/\s+as\s+/)[0]!.replace(/^type\s+/, '')).filter(Boolean),
  );
}

/** `<Name` uses of the given `@business-os/ui` components (JSX opening tags, in files that import them). */
export function findUses(source: string, names: string[], file = '<source>'): PillHit[] {
  const imported = new Set(uiImports(source));
  names = names.filter((n) => imported.has(n));
  if (names.length === 0) return [];
  const tag = new RegExp(String.raw`<(${names.join('|')})(?=[\s/>])`, 'g');
  const hits: PillHit[] = [];
  source.split('\n').forEach((text, i) => {
    for (const m of text.matchAll(tag)) hits.push({ file, line: i + 1, text: m[0] });
  });
  return hits;
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === 'node_modules' || entry === '__generated__' ? [] : sources(path);
    return /\.(tsx?|css)$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry) ? [path] : [];
  });
}

export type PillReport = { direct: PillHit[]; inherited: PillHit[]; components: string[] };

/** Scans `uiComponents` for round shapes and round components, and `appRoots` for both kinds of use. */
export function scan(uiComponents: string, appRoots: string[] = [], base = process.cwd()): { ui: PillReport; app: PillReport } {
  const uiFiles = sources(uiComponents);
  const components = uiFiles.flatMap((f) => roundComponents(readFileSync(f, 'utf8'))).sort();
  const report = (files: string[], countUses: boolean): PillReport => ({
    components,
    direct: files.flatMap((f) => findPills(readFileSync(f, 'utf8'), relative(base, f))),
    inherited: countUses ? files.flatMap((f) => findUses(readFileSync(f, 'utf8'), components, relative(base, f))) : [],
  });
  return { ui: report(uiFiles, false), app: report(appRoots.flatMap(sources), true) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const { ui, app } = scan(join(root, 'packages/ui/src/components'), [join(root, 'packages/app/src')], root);
  const print = (label: string, hits: PillHit[]) => {
    console.log(`${label}: ${hits.length}`);
    for (const h of hits) console.log(`  ${h.file}:${h.line}  ${h.text}`);
  };
  console.log(`Round packages/ui components: ${ui.components.join(', ') || 'none'}`);
  print('packages/ui/src/components, direct', ui.direct);
  print('packages/app/src, direct', app.direct);
  print('packages/app/src, through a round component', app.inherited);
}
