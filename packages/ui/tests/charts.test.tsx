import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BarChart, KpiCard, LineChart, niceScale } from '../src';

// Reporting R1: shared charts and KPI cards. Values arrive as exact strings and are shown with the
// caller's formatter; the chart only uses numbers to draw.
const props = {
  title: 'Amount invoiced (AUD)',
  summary: 'Amount invoiced in AUD, month by month',
  categories: ['Sep 2026', 'Oct 2026', 'Nov 2026'],
  series: [
    { key: 'AUD', label: 'Amount invoiced (AUD)', values: ['100.00', null, '0.10'] },
    { key: 'prev', label: 'Previous period', values: ['80.00', '20.00', '0.00'], variant: 'comparison' as const },
  ],
  formatValue: (v: string) => `$${v}`,
};

describe('charts', () => {
  it('picks round axis bounds that include zero', () => {
    expect(niceScale(0, 97)).toEqual({ min: 0, max: 100, ticks: [0, 25, 50, 75, 100] });
    expect(niceScale(-30, 70).min).toBeLessThanOrEqual(-30);
    expect(niceScale(0, 0)).toEqual({ min: 0, max: 1, ticks: [0, 1] });
  });

  for (const [name, Chart] of [['line', LineChart], ['bar', BarChart]] as const) {
    it(`${name}: is a captioned figure with a named image, a text legend and a data table with exact values`, () => {
      const html = renderToStaticMarkup(<Chart {...props} />);
      expect(html).toContain('<figure');
      expect(html).toContain('role="img" aria-label="Amount invoiced in AUD, month by month"');
      expect(html).toContain('aria-label="Legend"');
      expect(html).toContain('Previous period');
      expect(html).toContain('stroke-dasharray'); // the comparison is told apart by shape, not colour alone
      expect(html).toContain('<td>$0.10</td>');
      expect(html).toContain('<td>Not shown</td>'); // a null (suppressed) value is never drawn as zero
    });
  }
});

describe('KpiCard', () => {
  it('lists one value per currency and states the change in words', () => {
    const html = renderToStaticMarkup(
      <KpiCard label="Amount invoiced" values={[{ key: 'AUD', text: '$350.50', caption: 'AUD' }, { key: 'USD', text: 'USD 75.00', caption: 'USD' }]}
        change="+12.5% vs previous period" trend="up" note="Issue date" />,
    );
    expect(html).toContain('$350.50');
    expect(html).toContain('USD 75.00');
    expect(html).toContain('+12.5% vs previous period');
  });

  it('has loading, unavailable and no-data states', () => {
    expect(renderToStaticMarkup(<KpiCard label="X" state="loading" />)).toContain('aria-busy="true"');
    expect(renderToStaticMarkup(<KpiCard label="X" state="unavailable" unavailableText="You do not have access." />)).toContain('You do not have access.');
    expect(renderToStaticMarkup(<KpiCard label="X" values={[]} />)).toContain('No data');
  });
});
