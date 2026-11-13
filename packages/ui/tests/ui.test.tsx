import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Card, StatusIndicator, cn } from '../src';

describe('@business-os/ui', () => {
  it('merges conflicting Tailwind classes', () => {
    const hidden = false as boolean;
    expect(cn('p-2', hidden && 'hidden', 'p-4')).toBe('p-4');
  });

  it('renders a card with consumer classes merged', () => {
    expect(renderToStaticMarkup(<Card className="p-2">x</Card>)).toContain('class="rounded-xl border bg-card text-card-foreground shadow-sm p-2"');
  });

  it('always renders a text label with the status colour', () => {
    const html = renderToStaticMarkup(<StatusIndicator tone="error">Not reachable</StatusIndicator>);
    expect(html).toContain('Not reachable');
    expect(html).toContain('aria-hidden');
  });
});
