import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Guards for the token sheet (V2-B1, docs/ui/pixa-design-system-v2-a.md §7 and §12):
// - the two dark blocks stay identical and no themed token is missing from either theme;
// - every V1 name still resolves (compatibility aliases) so existing screens keep working;
// - every text/background pair the components use meets WCAG AA (4.5:1 for text, 3:1 for focus
//   rings, input borders and chart marks), in both themes, through the aliases as well as directly;
// - the state recipes and treatments keep their forced-colours, reduced-motion and fallback rules;
// - the bundled font files exist and stay inside the size budget.
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

function block(start: RegExp): string {
  const at = css.search(start);
  if (at < 0) throw new Error(`no block for ${start}`);
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

const scale = vars(block(/\/\* 3\. Scale tokens[^\n]*\n:root/));
const light = vars(block(/\/\* 4\. Semantic tokens: light[^\n]*\n:root/));
const darkMedia = vars(block(/:root:not\(\.light\)/));
const darkClass = vars(block(/\/\* 4\. Semantic tokens: dark \(`\.dark` class\)[^\n]*\n\.dark/));
const aliases = vars(block(/\/\* 5\. Compatibility aliases[\s\S]*?\*\/\n:root,\n\.light,\n\.dark/));
const themeMap = vars(block(/\n@theme inline \{/));

/** Resolves `var(--x)` chains against a theme, the way the browser does on <html>. */
function resolver(theme: Record<string, string>) {
  const all = { ...scale, ...theme, ...aliases };
  return function resolve(name: string, seen: string[] = []): string {
    if (seen.includes(name)) throw new Error(`cycle: ${[...seen, name].join(' -> ')}`);
    const value = all[name];
    if (value === undefined) throw new Error(`${name} is not defined`);
    const ref = /^var\((--[\w-]+)\)$/.exec(value);
    return ref ? resolve(ref[1]!, [...seen, name]) : value;
  };
}
const THEMES = [
  ['light', resolver(light)],
  ['dark', resolver({ ...light, ...darkClass })],
] as const;

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
/** Contrast of fg over bg, where a translucent bg sits on `base` (the canvas unless stated). */
function contrast(resolve: (name: string) => string, fg: string, bg: string, base = '--bg-canvas') {
  const ground = over(parse(resolve(bg)), parse(resolve(base)));
  const ink = over(parse(resolve(fg)), ground);
  const [hi, lo] = [luminance(ink), luminance(ground)].sort((a, b) => b - a) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const STATUSES = ['success', 'warning', 'danger', 'info'] as const;

// V2 pairs (text, 4.5:1). Translucent backgrounds are measured over the canvas.
const V2_TEXT: Array<[string, string, string?]> = [
  ...['--bg-canvas', '--bg-surface', '--bg-sunken', '--bg-raised', '--bg-selected'].flatMap((bg) => [
    ['--fg-default', bg] as [string, string],
    ['--fg-muted', bg] as [string, string],
  ]),
  ['--fg-subtle', '--bg-canvas'],
  ['--fg-subtle', '--bg-surface'],
  ['--fg-subtle', '--bg-raised'],
  ['--fg-accent', '--bg-canvas'],
  ['--fg-accent', '--bg-surface'],
  ['--fg-accent', '--accent-subtle'],
  ['--fg-on-accent', '--accent-solid'],
  ['--fg-on-accent', '--accent-hover'],
  ...STATUSES.flatMap((s) => [
    [`--status-${s}-fg`, '--bg-canvas'] as [string, string],
    [`--status-${s}-fg`, '--bg-surface'] as [string, string],
    [`--status-${s}-fg`, `--status-${s}-bg`] as [string, string],
    [`--status-${s}-fg`, `--status-${s}-bg`, '--bg-surface'] as [string, string, string],
    [`--status-${s}-on-solid`, `--status-${s}-solid`] as [string, string],
  ]),
  ['--fg-default', '--field'],
  ['--fg-muted', '--muted'],
  ['--secondary-foreground', '--secondary'],
  ['--fg-default', '--glass-fallback'],
  ['--fg-muted', '--glass-fallback'],
];
// V2 non-text pairs (3:1): focus ring, field borders, chart marks (WCAG 1.4.11).
const V2_UI: Array<[string, string]> = [
  ['--focus-ring', '--bg-canvas'],
  ['--focus-ring', '--bg-surface'],
  ['--focus-ring', '--bg-raised'],
  ['--border-input', '--field'],
  ['--border-input', '--bg-surface'],
  ['--border-input', '--bg-canvas'],
  ...['1', '2', '3', '4', '5', 'comparison'].map((c) => [`--chart-${c}`, '--bg-surface'] as [string, string]),
];
// Disabled text is exempt from WCAG contrast, but V2 keeps it legible (§5: opacity-50 dropped to 2.4:1).
const DISABLED: Array<[string, string]> = [['--disabled-fg', '--disabled-bg']];

// V1 pairs through the aliases: what today's screens render once V2 lands.
const V1_TEXT: Array<[string, string]> = [
  ['--foreground', '--background'],
  ['--muted-foreground', '--background'],
  ['--muted-foreground', '--card'],
  ['--muted-foreground', '--muted'],
  ['--card-foreground', '--card'],
  ['--foreground', '--surface-raised'],
  ['--popover-foreground', '--popover'],
  ['--accent-foreground', '--accent'],
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
const V1_UI: Array<[string, string]> = [
  ['--ring', '--background'],
  ['--ring', '--card'],
  ['--input', '--field'],
];

// Every V1 Tailwind colour that existed before V2-B1; each must still be mapped and resolve.
const V1_TAILWIND = [
  'background', 'foreground', 'card', 'card-foreground', 'surface-raised', 'popover', 'popover-foreground', 'primary',
  'primary-hover', 'primary-foreground', 'secondary', 'secondary-hover', 'secondary-foreground', 'muted',
  'muted-foreground', 'accent', 'accent-foreground', 'destructive', 'destructive-foreground', 'success',
  'success-foreground', 'warning', 'warning-foreground', 'info', 'info-foreground', 'border', 'input', 'field', 'ring',
  'overlay', 'chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5', 'chart-comparison', 'chart-grid',
];

describe('design tokens: structure', () => {
  it('declares the dark theme identically for the OS preference and the .dark class', () => {
    expect(darkClass).toEqual(darkMedia);
  });

  it('gives every themed token a value in both themes (token manifest)', () => {
    const lightKeys = Object.keys(light).sort();
    const darkKeys = Object.keys(darkClass).sort();
    expect(darkKeys.filter((k) => !(k in light))).toEqual([]);
    expect(lightKeys.filter((k) => !(k in darkClass))).toEqual([]);
  });

  it('declares every V2 semantic token from the spec', () => {
    const required = [
      '--bg-canvas', '--bg-surface', '--bg-sunken', '--bg-raised', '--bg-hover', '--bg-selected',
      '--fg-default', '--fg-muted', '--fg-subtle', '--fg-accent', '--fg-on-accent',
      '--border-default', '--border-strong', '--border-input',
      '--accent-solid', '--accent-hover', '--accent-subtle', '--focus-ring',
      ...STATUSES.flatMap((s) => ['fg', 'bg', 'border', 'solid', 'on-solid'].map((p) => `--status-${s}-${p}`)),
      '--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5', '--chart-comparison', '--chart-grid',
      '--overlay', '--disabled-fg', '--disabled-bg', '--shadow-raised', '--shadow-overlay',
      '--bg-bezel',
    ];
    expect(required.filter((k) => !(k in light))).toEqual([]);
  });

  it('declares the scale tokens from the spec', () => {
    expect(scale).toMatchObject({
      '--control-h-sm': '28px', '--control-h-md': '32px', '--control-h-lg': '40px',
      '--row-h-compact': '32px', '--row-h-default': '40px', '--row-h-comfortable': '48px',
      '--radius-control': '8px', '--radius-panel': '12px', '--radius-dialog': '16px', '--radius-pill': '9999px',
      '--sidebar-w': '232px', '--sidebar-w-compact': '64px', '--topbar-h': '48px', '--content-max': '1240px',
      '--duration-fast': '100ms', '--duration-base': '160ms', '--duration-slow': '240ms',
      '--font-size-caption': '12px', '--font-size-small': '13px', '--font-size-body': '14px', '--font-size-lead': '16px',
      '--font-size-section': '18px', '--font-size-title': '22px', '--font-size-display': '28px',
      '--inspector-w': '360px', '--bezel-gutter': '8px', '--marker-size': '6px', '--marker-radius': '1.5px',
    });
    expect(scale['--font-family-sans']).toMatch(/^'Inter Variable', 'Inter Fallback'/);
  });

  it('keeps scale tokens out of the themed blocks (one value for both themes)', () => {
    expect(Object.keys(scale).filter((k) => k in light || k in darkClass)).toEqual([]);
  });

  it('keeps raw palette tokens out of everything components can reach', () => {
    for (const body of [light, darkClass, aliases, themeMap]) {
      expect(Object.values(body).filter((v) => v.includes('--pk-'))).toEqual([]);
    }
  });

  it('keeps every V1 Tailwind colour and maps each to something that resolves in both themes', () => {
    for (const name of V1_TAILWIND) {
      const mapped = themeMap[`--color-${name}`];
      expect(mapped, name).toMatch(/^var\(--[\w-]+\)$/);
      for (const [, resolve] of THEMES) expect(() => parse(resolve(mapped!.slice(4, -1)))).not.toThrow();
    }
  });

  it('maps every V2 colour utility to a defined token', () => {
    const v2 = Object.entries(themeMap).filter(([k]) => k.startsWith('--color-') && !V1_TAILWIND.includes(k.slice(8)));
    expect(v2.length).toBeGreaterThan(30);
    for (const [key, value] of v2) {
      for (const [, resolve] of THEMES) expect(() => parse(resolve(value.slice(4, -1))), key).not.toThrow();
    }
  });

  it('keeps the V1 accent meaning (selection tint) and gives the V2 solid accent its own name', () => {
    expect(aliases['--accent']).toBe('var(--bg-selected)');
    expect(aliases['--primary']).toBe('var(--accent-solid)');
    expect(themeMap['--color-accent-solid']).toBe('var(--accent-solid)');
  });
});

for (const [name, resolve] of THEMES) {
  describe(`design tokens: ${name} contrast`, () => {
    it.each(V2_TEXT)('%s on %s meets 4.5:1', (fg, bg, base) => {
      expect(contrast(resolve, fg, bg, base)).toBeGreaterThanOrEqual(4.5);
    });
    it.each(V2_UI)('%s on %s meets 3:1', (fg, bg) => {
      expect(contrast(resolve, fg, bg)).toBeGreaterThanOrEqual(3);
    });
    it.each(DISABLED)('%s on %s stays legible (3:1)', (fg, bg) => {
      expect(contrast(resolve, fg, bg)).toBeGreaterThanOrEqual(3);
    });
    it.each(V1_TEXT)('alias %s on %s meets 4.5:1', (fg, bg) => {
      expect(contrast(resolve, fg, bg, '--background')).toBeGreaterThanOrEqual(4.5);
    });
    it.each(V1_UI)('alias %s on %s meets 3:1', (fg, bg) => {
      expect(contrast(resolve, fg, bg, '--background')).toBeGreaterThanOrEqual(3);
    });
    it('makes the selected state distinguishable from a hovered row without relying on colour alone', () => {
      // Selection also carries aria state and, in forced colours, Highlight (checked below).
      expect(resolve('--bg-selected')).not.toBe(resolve('--bg-hover'));
    });
  });
}

// Pixa identity (V2-B2, docs/ui/pixa-visual-identity-v2-b2.md §7 and §11.4).
describe('design tokens: Pixa identity (V2-B2)', () => {
  const [, lightResolve] = THEMES[0];
  const [, darkResolve] = THEMES[1];

  it('gives the bezel one ink in both themes, equal to the dark canvas, so the frame and the dark-scope rail match', () => {
    expect(light['--bg-bezel']).toBe('#0b0f1e');
    expect(darkClass['--bg-bezel']).toBe('#0b0f1e');
    expect(darkMedia['--bg-bezel']).toBe('#0b0f1e');
    expect(darkClass['--bg-canvas']).toBe(light['--bg-bezel']);
    expect(themeMap['--color-bezel']).toBe('var(--bg-bezel)');
  });

  it('keeps the marker square: small radius, never a pill', () => {
    expect(parseFloat(scale['--marker-radius']!)).toBeLessThanOrEqual(2);
    expect(parseFloat(scale['--marker-radius']!) * 2).toBeLessThan(parseFloat(scale['--marker-size']!));
    expect(themeMap['--radius-marker']).toBe('var(--marker-radius)');
  });

  it('changes no V2-B1 value (the V2-B1 tokens keep their B1 values)', () => {
    expect(light['--bg-canvas']).toBe('#f7f7fb');
    expect(light['--bg-surface']).toBe('#ffffff');
    expect(darkClass['--bg-surface']).toBe('#121729');
    expect(scale['--radius-pill']).toBe('9999px');
  });

  // The rail is a dark-scope island (§6.2): in both themes its text uses the dark tokens on the bezel.
  it.each([['--fg-default'], ['--fg-muted'], ['--fg-subtle'], ['--fg-accent']])('rail text %s on the bezel meets 4.5:1', (fg) => {
    expect(contrast(darkResolve, fg, '--bg-bezel')).toBeGreaterThanOrEqual(4.5);
  });

  it('rail current bar and focus ring on the bezel meet 3:1', () => {
    expect(contrast(darkResolve, '--fg-accent', '--bg-bezel')).toBeGreaterThanOrEqual(3);
    expect(contrast(darkResolve, '--focus-ring', '--bg-bezel')).toBeGreaterThanOrEqual(3);
  });

  for (const [name, resolve] of THEMES) {
    it(`${name}: the selected-row bar meets 3:1 on the selected row`, () => {
      expect(contrast(resolve, '--fg-accent', '--bg-selected', '--bg-surface')).toBeGreaterThanOrEqual(3);
    });

    it.each([...STATUSES.map((s) => `--status-${s}-solid`), '--fg-subtle'])(`${name}: marker %s on the sheet meets 3:1`, (marker) => {
      expect(contrast(resolve, marker, '--bg-surface')).toBeGreaterThanOrEqual(3);
      expect(contrast(resolve, marker, '--bg-sunken')).toBeGreaterThanOrEqual(3);
    });

    it(`${name}: a filled progress square meets 3:1 on the sheet (squares are decorative; the text carries the value)`, () => {
      expect(contrast(resolve, '--accent-solid', '--bg-surface')).toBeGreaterThanOrEqual(3);
    });
  }

  it('records the light sheet against the bezel as strongly separated and the dark one as needing its 1 px edge', () => {
    expect(contrast(lightResolve, '--bg-surface', '--bg-bezel')).toBeGreaterThan(15);
    expect(contrast(darkResolve, '--bg-surface', '--bg-bezel')).toBeLessThan(1.5);
  });
});

describe('design tokens: recipes, preferences and fallbacks', () => {
  const utility = (name: string) => block(new RegExp(`@utility ${name} \\{`));

  it.each(['focus-ring', 'focus-ring-inset'])('%s draws a 2 px ring and switches to Highlight in forced colours', (name) => {
    const body = utility(name);
    expect(body).toContain('outline: 2px solid var(--focus-ring)');
    expect(body).toMatch(/forced-colors: active[\s\S]*outline-color: Highlight/);
  });

  it('shows selection in forced colours with system colours, not background alone', () => {
    expect(utility('state-selected')).toMatch(/forced-colors: active[\s\S]*Highlight[\s\S]*HighlightText[\s\S]*CanvasText/);
  });

  it('uses GrayText for disabled controls in forced colours instead of opacity', () => {
    const body = utility('state-disabled');
    expect(body).toContain('GrayText');
    expect(body).not.toContain('opacity');
  });

  it('keeps every focus indicator visible in forced colours', () => {
    expect(block(/@layer base/)).toMatch(/forced-colors: active[\s\S]*:focus-visible[\s\S]*Highlight/);
  });

  it('drops every motion duration to 0 ms when reduced motion is requested', () => {
    const reduced = vars(block(/@media \(prefers-reduced-motion: reduce\)/));
    expect(reduced).toEqual({ '--duration-fast': '0ms', '--duration-base': '0ms', '--duration-slow': '0ms' });
  });

  it('draws markers as squares that become CanvasText in forced colours', () => {
    const body = utility('pixel-marker');
    expect(body).toContain('width: var(--marker-size)');
    expect(body).toContain('border-radius: var(--marker-radius)');
    expect(body).toMatch(/forced-colors: active[\s\S]*forced-color-adjust: none[\s\S]*CanvasText/);
    expect(utility('pixel-track')).toMatch(/forced-colors: active[\s\S]*CanvasText/);
    expect(utility('pixel-track-fill')).toMatch(/forced-colors: active[\s\S]*CanvasText/);
  });

  it('raises control and target sizes on coarse pointers', () => {
    expect(vars(block(/@media \(pointer: coarse\)/))).toEqual({ '--control-h-md': '40px', '--target-min': '44px' });
  });

  it('only makes glass translucent where color-mix is supported, with opaque fallbacks after it', () => {
    const glass = block(/@layer components/);
    const base = glass.slice(glass.indexOf('.bos-glass {'));
    const first = base.slice(0, base.indexOf('}'));
    expect(first).not.toContain('color-mix');
    const supports = glass.indexOf('@supports (color: color-mix(in oklab, red, red))');
    expect(supports).toBeGreaterThan(-1);
    expect(glass.indexOf('@supports not ((backdrop-filter')).toBeGreaterThan(supports);
    expect(glass.indexOf('prefers-reduced-transparency: reduce')).toBeGreaterThan(supports);
  });
});

describe('bundled font', () => {
  const files = ['inter-latin-wght-normal.woff2', 'inter-latin-ext-wght-normal.woff2'];

  it.each(files)('%s exists, is WOFF2 and is referenced with a relative URL', (file) => {
    const url = new URL(`../src/fonts/${file}`, import.meta.url);
    expect(existsSync(url)).toBe(true);
    expect(readFileSync(url).subarray(0, 4).toString('latin1')).toBe('wOF2');
    expect(css).toContain(`url('./fonts/${file}')`);
  });

  it('ships the licence with the font', () => {
    expect(readFileSync(new URL('../src/fonts/OFL-Inter.txt', import.meta.url), 'utf8')).toContain('SIL Open Font License');
  });

  it('keeps the Latin file every screen downloads under the 110 kB budget (§12.2)', () => {
    expect(statSync(new URL(`../src/fonts/${files[0]}`, import.meta.url)).size).toBeLessThanOrEqual(110 * 1024);
  });

  it('swaps without invisible text and has a metric-matched fallback', () => {
    expect(css.match(/font-display: swap/g)?.length).toBe(2);
    expect(css).toMatch(/font-family: 'Inter Fallback';[\s\S]*size-adjust:/);
  });
});
