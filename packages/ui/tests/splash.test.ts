import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The splash in each app's index.html paints before any CSS loads, so it repeats a few token values
// and applies the stored theme with a tiny script. This keeps both in step with the design system
// and with the theme preference in packages/app (V2-B1).
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const css = read('../src/styles.css');
const preferences = read('../../app/src/shell/preferences.ts');

function themed(selector: RegExp) {
  const at = css.search(selector);
  const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}
const light = themed(/\/\* 4\. Semantic tokens: light[^\n]*\n:root/);
const dark = themed(/\/\* 4\. Semantic tokens: dark \(`\.dark` class\)[^\n]*\n\.dark/);

describe.each(['web', 'desktop'])('%s splash', (app) => {
  const html = read(`../../../apps/${app}/index.html`);
  const script = read(`../../../apps/${app}/public/theme-boot.js`);

  it('uses the V2 canvas, text and muted colours in both themes', () => {
    for (const token of ['--bg-canvas', '--fg-default', '--fg-muted']) {
      expect(html).toContain(light[token]);
      expect(html).toContain(dark[token]);
    }
    expect(html).toMatch(/html\.dark[^{]*\{background:#0b0f1e/);
    expect(html).toMatch(/prefers-color-scheme:dark\)\{html:not\(\.light\)/);
  });

  it('loads the theme script from self in <head>, before the app', () => {
    const head = html.slice(0, html.indexOf('</head>'));
    expect(head).toContain('<script src="/theme-boot.js"></script>');
    expect(html).not.toMatch(/<script>(?!<\/script>)/); // no inline script: the CSP forbids it
  });

  it('reads the same storage key and classes as the app', () => {
    const key = /THEME_KEY = '([^']+)'/.exec(preferences)?.[1];
    expect(key).toBe('bos.theme');
    expect(script).toContain(`getItem('${key}')`);
    expect(script).toContain("theme === 'light' || theme === 'dark'");
    expect(script).toContain('classList.add(theme)');
  });
});

it('keeps the two splash pages and theme scripts identical', () => {
  expect(read('../../../apps/web/index.html')).toBe(read('../../../apps/desktop/index.html'));
  expect(read('../../../apps/web/public/theme-boot.js')).toBe(read('../../../apps/desktop/public/theme-boot.js'));
});
