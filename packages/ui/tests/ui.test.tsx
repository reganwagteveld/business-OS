import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Atmosphere, Badge, Button, Card, Dialog, DialogTitle, Field, Input, Skeleton, Spinner, StatusIndicator, Surface, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn, glassClass } from '../src';

describe('@business-os/ui', () => {
  it('merges conflicting Tailwind classes', () => {
    const hidden = false as boolean;
    expect(cn('p-2', hidden && 'hidden', 'p-4')).toBe('p-4');
  });

  it('renders a card with consumer classes merged', () => {
    expect(renderToStaticMarkup(<Card className="p-2">x</Card>)).toContain('class="rounded-xl border bg-card text-card-foreground shadow-card p-2"');
  });

  it('always renders a text label with the status colour', () => {
    const html = renderToStaticMarkup(<StatusIndicator tone="error">Not reachable</StatusIndicator>);
    expect(html).toContain('Not reachable');
    expect(html).toContain('aria-hidden');
  });
});

describe('design system components', () => {
  it('buttons never submit by accident and keep a visible focus outline', () => {
    const html = renderToStaticMarkup(<Button variant="secondary">Save</Button>);
    expect(html).toContain('type="button"');
    expect(html).toContain('focus-visible:outline-ring');
    expect(renderToStaticMarkup(<Button type="submit">Go</Button>)).toContain('type="submit"');
  });

  it('cards are opaque by default and glass on request, with configurable translucency', () => {
    expect(renderToStaticMarkup(<Card>x</Card>)).toContain('bg-card');
    const glass = renderToStaticMarkup(<Card variant="glass" strength={0.3}>x</Card>);
    expect(glass).toContain('bos-glass');
    expect(glass).toContain('--glass-alpha:0.3');
    expect(renderToStaticMarkup(<Surface variant="glass" strength="strong">x</Surface>)).toContain('--glass-alpha:0.86');
  });

  it('clamps glass translucency to 0..1', () => {
    expect(glassClass(4).style).toEqual({ '--glass-alpha': '1' });
  });

  it('lets each screen choose its atmosphere', () => {
    expect(renderToStaticMarkup(<Atmosphere variant="calm" />)).toContain('data-atmosphere="calm"');
  });

  it('wires a field label, hint and error to its control', () => {
    const html = renderToStaticMarkup(
      <Field label="Email" hint="Work address" error="Required">{(p) => <Input {...p} />}</Field>,
    );
    const id = /<label[^>]*for="([^"]+)"/.exec(html)![1];
    expect(html).toContain(`id="${id}"`);
    expect(html).toContain(`aria-describedby="${id}-hint ${id}-error"`);
    expect(html).toContain('aria-invalid="true"');
  });

  it('renders a modal dialog only while open', () => {
    expect(renderToStaticMarkup(<Dialog open={false}>x</Dialog>)).toBe('');
    const html = renderToStaticMarkup(<Dialog open aria-labelledby="t"><DialogTitle id="t">Delete?</DialogTitle></Dialog>);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
  });

  it('announces a labelled spinner and hides skeletons from assistive tech', () => {
    expect(renderToStaticMarkup(<Spinner label="Loading" />)).toContain('role="status"');
    expect(renderToStaticMarkup(<Spinner />)).not.toContain('role=');
    expect(renderToStaticMarkup(<Skeleton />)).toContain('aria-hidden');
  });

  it('gives table headers column scope and badges a text label', () => {
    expect(renderToStaticMarkup(<Table><TableHeader><TableRow><TableHead>Name</TableHead></TableRow></TableHeader><TableBody><TableRow><TableCell>A</TableCell></TableRow></TableBody></Table>)).toContain('scope="col"');
    expect(renderToStaticMarkup(<Badge tone="success">Paid</Badge>)).toContain('Paid');
  });
});
