import type { Page } from '@playwright/test';
import { financeSection, h1, openHome, shot, test, zone } from './harness';

// One golden per screen, theme and width (spec §14 B2-1): 1440 × 900 desktop, 900 × 600 (the Tauri
// minimum window), 834 tablet and 390 phone, in both themes where the layout differs.

type Screen = { name: string; go: (page: Page) => Promise<void> };

const SCREENS: Record<string, Screen> = {
  home: { name: '01-home', go: async () => {} },
  customers: {
    name: '03-customers-list',
    go: async (p) => { await zone(p, 'Customers'); await h1(p, 'Customers'); await p.getByText('Kelp & Co Seafood').first().waitFor(); },
  },
  customer: {
    name: '04-customer-detail',
    go: async (p) => { await SCREENS.customers!.go(p); await p.getByRole('button', { name: 'Kelp & Co Seafood' }).click(); await h1(p, 'Kelp & Co Seafood'); },
  },
  salesBoard: {
    name: '07-sales-board',
    go: async (p) => { await zone(p, 'Sales'); await p.getByRole('button', { name: /Board/ }).first().click(); await p.getByText('Website redesign').first().waitFor(); },
  },
  projects: {
    name: '08-projects-list',
    go: async (p) => { await zone(p, 'Projects'); await p.getByText('Tidewater brand refresh').first().waitFor(); },
  },
  project: {
    name: '09-project-detail',
    go: async (p) => { await SCREENS.projects!.go(p); await p.getByRole('button', { name: 'Tidewater brand refresh' }).first().click(); await h1(p, 'Tidewater brand refresh'); await p.getByText('Label system').first().waitFor(); },
  },
  finance: { name: '10-finance-overview', go: async (p) => { await zone(p, 'Finance'); await h1(p, 'Finance'); } },
  invoices: {
    name: '11-finance-invoices',
    go: async (p) => { await SCREENS.finance!.go(p); await financeSection(p, 'Invoices'); await p.getByText('INV-0001').first().waitFor(); },
  },
  invoice: {
    name: '12-finance-invoice-detail',
    go: async (p) => { await SCREENS.invoices!.go(p); await p.getByRole('button', { name: /INV-0001/ }).first().click(); await h1(p, 'INV-0001'); },
  },
  people: { name: '14-people', go: async (p) => { await zone(p, 'People'); await p.getByText('Priya Nair').first().waitFor(); } },
};

const MATRIX: { size: string; width: number; height: number; themes: ('light' | 'dark')[]; screens: (keyof typeof SCREENS)[]; mobile?: boolean }[] = [
  { size: 'desktop', width: 1440, height: 900, themes: ['light', 'dark'], screens: ['home', 'customers', 'customer', 'salesBoard', 'projects', 'project', 'finance', 'invoices', 'invoice', 'people'] },
  { size: 'min-900', width: 900, height: 600, themes: ['light', 'dark'], screens: ['home', 'customers', 'project', 'invoices'] },
  { size: 'tablet-834', width: 834, height: 1112, themes: ['light'], screens: ['home', 'invoices'] },
  { size: 'mobile', width: 390, height: 844, themes: ['light', 'dark'], screens: ['home', 'customers', 'invoices'], mobile: true },
];

for (const m of MATRIX) {
  for (const theme of m.themes) {
    test.describe(`${m.size} ${theme}`, () => {
      test.use({ viewport: { width: m.width, height: m.height }, colorScheme: theme, ...(m.mobile ? { isMobile: true, hasTouch: true } : {}) });
      for (const key of m.screens) {
        const s = SCREENS[key]!;
        test(s.name, async ({ page }) => {
          await openHome(page);
          await s.go(page);
          await shot(page, `${m.size}-${theme}-${s.name}`);
        });
      }
    });
  }
}
