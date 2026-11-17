// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { Button, cn, Figure, FigureStrip, Marker, PixelMarker, ProgressSquares, PROGRESS_SQUARES_MAX, SectionHeader } from '../src';

afterEach(cleanup);

describe('cn and the V2 type scale', () => {
  it('keeps a type-scale size next to a text colour, and lets a later size win', () => {
    expect(cn('text-small', 'text-status-danger-fg')).toBe('text-small text-status-danger-fg');
    expect(cn('text-caption text-fg-muted')).toBe('text-caption text-fg-muted');
    expect(cn('text-small', 'text-title')).toBe('text-title');
    expect(cn('text-sm', 'text-small')).toBe('text-small');
  });
});

// V2-B2 identity foundations (docs/ui/pixa-visual-identity-v2-b2.md §6.6, §6.7, §6.10).
describe('PixelMarker', () => {
  it('pairs a decorative square with the status word', () => {
    render(<PixelMarker tone="success">Paid</PixelMarker>);
    const status = screen.getByText('Paid');
    const square = status.querySelector('.pixel-marker')!;
    expect(square.getAttribute('aria-hidden')).toBe('true');
    expect(square.className).toContain('text-status-success-solid');
    expect(status.textContent).toBe('Paid');
  });

  it('is hollow for "not started" states and filled otherwise', () => {
    expect(renderToStaticMarkup(<PixelMarker hollow>Draft</PixelMarker>)).toContain('data-hollow="true"');
    expect(renderToStaticMarkup(<PixelMarker tone="info">Sent</PixelMarker>)).not.toContain('data-hollow');
  });

  it('uses the subtle text colour for neutral and colours the word only for danger', () => {
    expect(renderToStaticMarkup(<Marker />)).toContain('text-fg-subtle');
    const danger = renderToStaticMarkup(<PixelMarker tone="danger">Overdue</PixelMarker>);
    expect(danger).toContain('text-status-danger-fg');
    expect(danger).toContain('font-medium');
    expect(danger).toContain('text-small');
    expect(renderToStaticMarkup(<PixelMarker tone="warning">Due soon</PixelMarker>)).not.toContain('text-status-warning-fg');
  });
});

describe('FigureStrip and Figure', () => {
  const strip = (
    <FigureStrip aria-label="Money" columns={3}>
      <Figure label="Outstanding" value="£9,340.00" secondaryValue="€1,200.00" note="As of 17 Nov" />
      <Figure label="Overdue" marker="danger" value="£960.00" note="2 invoices" />
      <Figure label="Paid this month" state="loading" />
    </FigureStrip>
  );

  it('is a labelled description list where each label names its value', () => {
    render(strip);
    const list = screen.getByRole('group', { name: 'Money' }).querySelector('dl')!;
    const terms = list.querySelectorAll('dt');
    expect([...terms].map((t) => t.textContent)).toEqual(['Outstanding', 'Overdue', 'Paid this month']);
    expect(terms[0]!.nextElementSibling!.tagName).toBe('DD');
  });

  it('keeps each currency on its own line and never adds them together', () => {
    render(strip);
    const outstanding = screen.getByText('£9,340.00');
    const second = screen.getByText('€1,200.00');
    expect(outstanding).not.toBe(second);
    expect(outstanding.className).toContain('tabular-nums');
    expect(second.className).toContain('tabular-nums');
  });

  it('shows the marker before the label and announces loading figures', () => {
    render(strip);
    const overdue = screen.getByText('Overdue');
    expect(overdue.querySelector('.pixel-marker')?.getAttribute('aria-hidden')).toBe('true');
    const loading = screen.getByText('Paid this month').closest('div')!;
    expect(loading.getAttribute('aria-busy')).toBe('true');
    expect(within(loading).getByRole('status').textContent).toBe('Loading');
  });

  it('uses rules, not cards: no border radius, shadow or card surface', () => {
    const html = renderToStaticMarkup(strip);
    expect(html).toContain('border-y');
    expect(html).not.toMatch(/shadow|bg-card|rounded-(?:lg|xl|2xl|full)/);
  });

  it('uses the display size only when asked (Home)', () => {
    expect(renderToStaticMarkup(<Figure label="Revenue" value="£1" />)).toContain('text-title');
    expect(renderToStaticMarkup(<Figure label="Revenue" value="£1" size="display" />)).toContain('text-display');
  });

  it('says when a figure is not available to this person', () => {
    render(<FigureStrip><Figure label="Payroll" state="unavailable" unavailableText="You do not have access" /></FigureStrip>);
    expect(screen.getByText('You do not have access')).toBeTruthy();
  });
});

describe('SectionHeader variant="ruled"', () => {
  it('renders the heading, a decorative rule, meta and one action on one 40 px line', () => {
    render(<SectionHeader variant="ruled" title="Money" meta="This month · GBP" action={<Button variant="ghost" size="sm">Open Finance ›</Button>} />);
    const heading = screen.getByRole('heading', { level: 2, name: 'Money' });
    const row = heading.parentElement!;
    expect(row.className).toContain('h-row-default');
    expect(row.querySelector('[aria-hidden="true"]')?.className).toContain('border-t border-line');
    expect(screen.getByText('This month · GBP').className).toContain('text-fg-subtle');
    expect(screen.getByRole('button', { name: 'Open Finance ›' })).toBeTruthy();
  });

  it('keeps the default variant unchanged', () => {
    const html = renderToStaticMarkup(<SectionHeader title="Drafts" description="Not sent yet." />);
    expect(html).toContain('text-lg font-semibold tracking-tight');
    expect(html).toContain('Not sent yet.');
    expect(html).not.toContain('h-row-default');
  });

  it('supports h3', () => {
    render(<SectionHeader variant="ruled" as="h3" title="Tasks" />);
    expect(screen.getByRole('heading', { level: 3, name: 'Tasks' })).toBeTruthy();
  });
});

describe('ProgressSquares', () => {
  it('shows one decorative square per item and the value as words', () => {
    render(<ProgressSquares done={2} total={6} />);
    expect(screen.getByText('2 of 6 tasks done')).toBeTruthy();
    const squares = screen.getByTestId('progress-squares');
    expect(squares.getAttribute('aria-hidden')).toBe('true');
    const items = squares.querySelectorAll('.pixel-marker');
    expect(items).toHaveLength(6);
    expect([...items].filter((s) => s.className.includes('text-accent-solid'))).toHaveLength(2);
    expect([...items].filter((s) => s.hasAttribute('data-off'))).toHaveLength(4);
  });

  it(`switches to a square-ended bar above ${PROGRESS_SQUARES_MAX} items`, () => {
    render(<ProgressSquares done={10} total={40} label="10 of 40 items" />);
    expect(screen.queryByTestId('progress-squares')).toBeNull();
    const bar = screen.getByTestId('progress-bar');
    expect(bar.getAttribute('aria-hidden')).toBe('true');
    expect(bar.className).toContain('pixel-track');
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('25%');
    expect(screen.getByText('10 of 40 items')).toBeTruthy();
  });

  it('uses squares at exactly the limit', () => {
    render(<ProgressSquares done={0} total={PROGRESS_SQUARES_MAX} />);
    expect(screen.getByTestId('progress-squares').children).toHaveLength(PROGRESS_SQUARES_MAX);
  });

  it('clamps impossible values instead of drawing them', () => {
    render(<ProgressSquares done={9} total={3} />);
    expect(screen.getByText('3 of 3 tasks done')).toBeTruthy();
    render(<ProgressSquares done={-1} total={0} label="No tasks yet" />);
    expect(screen.getByText('No tasks yet')).toBeTruthy();
  });
});
