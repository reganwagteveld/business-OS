import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findPills, findUses, roundComponents, scan } from '../scripts/pill-scan';

// AT-11 (docs/ui/pixa-visual-identity-v2-b2.md §10): no pills. The scan must catch round shapes however they
// are written, and the B2-2 components must have none.
const components = new URL('../src/components', import.meta.url).pathname;

describe('AT-11 pill scan', () => {
  it.each([
    'rounded-full', 'rounded-pill', 'rounded-l-full', 'rounded-tr-full', 'rounded-s-full', 'rounded-3xl', 'rounded-4xl',
    'rounded-dialog', 'rounded-[9999px]', 'rounded-[999px]', 'rounded-[50%]', 'rounded-[100%]', 'rounded-[2rem]', 'rounded-[16px]',
    'rounded-(--radius-pill)', 'rounded-[var(--radius-pill)]', 'md:rounded-full', 'hover:rounded-full',
  ])('catches the class %s', (cls) => {
    expect(findPills(`<span className="inline-flex ${cls} px-2" />`)).toHaveLength(1);
  });

  it.each([
    'border-radius: 50%;', 'border-radius: 9999px;', 'border-radius: var(--radius-pill);', 'borderRadius: 9999', "borderRadius: '50%'",
  ])('catches the style %s', (style) => {
    expect(findPills(style)).toHaveLength(1);
  });

  it.each(['rounded', 'rounded-sm', 'rounded-md', 'rounded-lg', 'rounded-xl', 'rounded-control', 'rounded-panel', 'rounded-marker', 'rounded-[6px]', 'rounded-[4px]', 'border-radius: 8px;'])(
    'allows the square radius %s',
    (cls) => {
      expect(findPills(`<span className="${cls}" style="" />`)).toEqual([]);
    },
  );

  it('ignores the token declarations and spinning loaders', () => {
    expect(findPills('  --radius-pill: 9999px;')).toEqual([]);
    expect(findPills('<span className="size-4 animate-spin rounded-full" />')).toEqual([]);
  });

  it('finds the component, not the whole file, that carries a round shape', () => {
    const file = [
      "export function Plain() { return <div className='rounded-md' />; }",
      "export function Round() { return <div className='rounded-full' />; }",
    ].join('\n');
    expect(roundComponents(file)).toEqual(['Round']);
  });

  it('counts uses of a round @business-os/ui component, so a variant cannot hide a pill', () => {
    const app = ["import { Badge, Button } from '@business-os/ui';", '<Badge tone="danger">Overdue</Badge>', '<Button>Save</Button>'].join('\n');
    expect(findUses(app, ['Badge'])).toHaveLength(1);
    expect(findUses("function Badge() {}\n<Badge />", ['Badge'])).toEqual([]);
  });

  it('keeps the V2-B2 identity components free of round shapes', () => {
    const { ui } = scan(components);
    for (const file of ['pixel-marker.tsx', 'figure.tsx', 'progress-squares.tsx']) {
      expect(findPills(readFileSync(`${components}/${file}`, 'utf8'), file)).toEqual([]);
    }
    expect(ui.components).not.toEqual(expect.arrayContaining(['PixelMarker', 'Marker', 'Figure', 'FigureStrip', 'ProgressSquares', 'SectionHeader']));
  });

  it('never adds a round shape to packages/ui (baseline on main: Badge, EmptyState, StatusIndicator)', () => {
    const { ui } = scan(components);
    expect(ui.direct.length).toBeLessThanOrEqual(3);
    expect(ui.components).toEqual(['Badge', 'EmptyState', 'StatusIndicator']);
  });
});
