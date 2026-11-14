import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Guards for the token sheet: the two dark blocks stay identical, and every text/background pair the
// components use meets WCAG AA (4.5:1 for text, 3:1 for focus rings and input borders).
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

function block(start: RegExp): string {
  const at = css.search(start);
  const open = css.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`unclosed block for ${start}`);
}

function vars(body: string): Record<string, string> {
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}

const light = vars(block(/\/\* 2\. Semantic tokens: light[^\n]*\n:root/));
const darkMedia = vars(block(/:root:not\(\.light\)/));
const darkClass = vars(block(/\n\.dark \{/));

type Rgba = [number, number, number, number];
function parse(value: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16)).concat(1) as Rgba;
  const rgb = /^rgb\((\d+) (\d+) (\d+)(?: \/ ([\d.]+))?\)$/.exec(value);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] ? Number(rgb[4]) : 1];
  throw new Error(`cannot parse colour ${value}`);
}
function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top[3];
  return [0, 1, 2].map((i) => top[i]! * a + bottom[i]! * (1 - a)).concat(1) as Rgba;
}
function luminance([r, g, b]: Rgba) {
  const c = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
function contrast(fg: string, bg: string, theme: Record<string, string>, base = '--background') {
  const ground = over(parse(theme[bg]!), parse(theme[base]!));
  const ink = over(parse(theme[fg]!), ground);
  const [hi, lo] = [luminance(ink), luminance(ground)].sort((a, b) => b - a) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT_PAIRS: Array<[string, string]> = [
  ['--foreground', '--background'],
  ['--muted-foreground', '--background'],
  ['--muted-foreground', '--card'],
  ['--muted-foreground', '--muted'],
  ['--card-foreground', '--card'],
  ['--foreground', '--surface-raised'],
  ['--popover-foreground', '--popover'],
  ['--primary-foreground', '--primary'],
  ['--primary-foreground', '--primary-hover'],
  ['--secondary-foreground', '--secondary'],
  ['--foreground', '--field'],
  ['--destructive-foreground', '--destructive'],
  ['--success-foreground', '--success'],
  ['--warning-foreground', '--warning'],
  ['--info-foreground', '--info'],
  ['--destructive', '--card'],
  ['--success', '--card'],
  ['--warning', '--card'],
  ['--info', '--card'],
  ['--destructive', '--background'],
  ['--foreground', '--glass-fallback'],
  ['--muted-foreground', '--glass-fallback'],
];
const UI_PAIRS: Array<[string, string]> = [
  ['--ring', '--background'],
  ['--ring', '--card'],
  ['--input', '--field'],
];

describe('design tokens', () => {
  it('declares the dark theme identically for the OS preference and the .dark class', () => {
    expect(darkClass).toEqual(darkMedia);
  });

  it('gives the dark theme a value for every light token', () => {
    const themed = Object.keys(light).filter((k) => !['--radius'].includes(k));
    expect(themed.filter((k) => !(k in darkClass))).toEqual([]);
  });

  for (const [name, theme] of [['light', light], ['dark', { ...light, ...darkClass }]] as const) {
    it.each(TEXT_PAIRS)(`${name}: %s on %s meets 4.5:1`, (fg, bg) => {
      expect(contrast(fg, bg, theme)).toBeGreaterThanOrEqual(4.5);
    });
    it.each(UI_PAIRS)(`${name}: %s on %s meets 3:1`, (fg, bg) => {
      expect(contrast(fg, bg, theme)).toBeGreaterThanOrEqual(3);
    });
  }
});
