import { expect, financeSection, h1, openHome, settle, shot, test, zone } from './harness';

// Accessibility-state captures (spec §14 B2-1, §15.1 item 3): keyboard focus, forced colours and
// reduced motion. Reduced motion is on for every capture; these add the states it matters for.

test.describe('focus', () => {
  for (const theme of ['light', 'dark'] as const) {
    test.describe(theme, () => {
      test.use({ viewport: { width: 1440, height: 900 }, colorScheme: theme });

      test('skip link', async ({ page }) => {
        await openHome(page);
        await page.keyboard.press('Tab');
        await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
        await shot(page, `focus-${theme}-01-skip-link`);
      });

      test('sidebar zone', async ({ page }) => {
        await openHome(page);
        await page.keyboard.press('Tab');
        const finance = page.getByRole('navigation', { name: 'Zones' }).getByRole('button', { name: 'Finance', exact: true });
        await finance.focus();
        await shot(page, `focus-${theme}-02-sidebar-zone`);
      });

      test('form field', async ({ page }) => {
        await openHome(page);
        await zone(page, 'Customers');
        await h1(page, 'Customers');
        await page.getByRole('button', { name: 'Add customer' }).first().click();
        await h1(page, 'Add customer');
        await page.keyboard.press('Tab');
        await page.getByRole('textbox').first().focus();
        await shot(page, `focus-${theme}-03-form-field`);
      });
    });
  }

  test.describe('min-900', () => {
    test.use({ viewport: { width: 900, height: 600 }, colorScheme: 'light' });
    test('invoice row', async ({ page }) => {
      await openHome(page);
      await zone(page, 'Finance');
      await financeSection(page, 'Invoices');
      await page.keyboard.press('Tab');
      await page.getByRole('button', { name: /INV-0001/ }).first().focus();
      await shot(page, 'focus-min-900-light-04-invoice-row');
    });
  });
});

test.describe('forced colours', () => {
  test.use({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', forcedColors: 'active' });
  test('home', async ({ page }) => {
    await openHome(page);
    await shot(page, 'forced-colors-01-home');
  });
  test('invoices', async ({ page }) => {
    await openHome(page);
    await zone(page, 'Finance');
    await financeSection(page, 'Invoices');
    await shot(page, 'forced-colors-11-finance-invoices');
  });
  test('focus', async ({ page }) => {
    await openHome(page);
    await page.keyboard.press('Tab');
    await page.getByRole('navigation', { name: 'Zones' }).getByRole('button', { name: 'Finance', exact: true }).focus();
    await shot(page, 'forced-colors-02-focus');
  });
});

test.describe('reduced motion', () => {
  test.describe('desktop', () => {
    test.use({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
    test('account menu open', async ({ page }) => {
      await openHome(page);
      await page.getByRole('button', { name: /Account menu/ }).click();
      await page.getByRole('menu').waitFor();
      await settle(page);
      await shot(page, 'reduced-motion-01-account-menu');
    });
  });
  test.describe('mobile', () => {
    test.use({ viewport: { width: 390, height: 844 }, colorScheme: 'light', isMobile: true, hasTouch: true });
    test('navigation drawer open', async ({ page }) => {
      await openHome(page);
      await page.getByRole('button', { name: 'Open navigation' }).click();
      await page.getByRole('dialog', { name: 'Navigation' }).waitFor();
      await shot(page, 'reduced-motion-02-drawer');
    });
  });
});
