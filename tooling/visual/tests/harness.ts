import { test as base, expect, type Locator, type Page } from '@playwright/test';

/**
 * Every capture runs with a guard: a request that leaves the local harness server (a client the
 * harness forgot to answer with a fake) or an uncaught page error fails the test, so a golden can
 * never record an error state by accident. Requests to anything but the harness are aborted.
 */
export const test = base.extend<{ guard: void }>({
  guard: [
    async ({ page, baseURL }, use) => {
      const problems: string[] = [];
      const origin = new URL(baseURL!).origin;
      await page.route('**/*', (route) => {
        const url = route.request().url();
        if (url.startsWith(origin) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
        problems.push(`request left the harness: ${route.request().method()} ${url}`);
        return route.abort('blockedbyclient');
      });
      page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
      await use();
      expect(problems, 'the harness must answer every request with a fake and render without errors').toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };

// Fixed clock for every capture: Tuesday 17 November 2026, 9:00 in Perth (the sample business's time zone).
// Date.now() is frozen; timers still run, so the app behaves normally.
export const NOW = new Date('2026-11-17T01:00:00.000Z');

/** Opens the harness on Home and waits until it is fully rendered with the bundled Inter loaded. */
export async function openHome(page: Page): Promise<void> {
  await page.clock.setFixedTime(NOW);
  await page.goto('/');
  await page.getByRole('heading', { level: 1, name: /Welcome/ }).waitFor();
  await settle(page);
}

/** Waits for fonts, pending requests and two animation frames, so the capture is of a still page. */
export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}

export const h1 = (page: Page, name: string | RegExp): Promise<void> => page.getByRole('heading', { level: 1, name }).waitFor();

/** Opens a Zone from the sidebar, or from the drawer on narrow widths. */
export async function zone(page: Page, name: string): Promise<void> {
  const menu = page.getByRole('button', { name: 'Open navigation' });
  if (await menu.isVisible()) {
    await menu.click();
    await page.getByRole('dialog', { name: 'Navigation' }).getByRole('button', { name, exact: true }).click();
  } else {
    await page.getByRole('navigation', { name: 'Zones' }).getByRole('button', { name, exact: true }).click();
  }
}

export async function financeSection(page: Page, name: string): Promise<void> {
  await page.getByRole('navigation', { name: 'Finance sections' }).getByRole('button', { name }).click();
  await h1(page, name);
}

/** Takes the golden. Everything that changes by itself is already fixed: clock, ids, fonts, motion. */
export async function shot(page: Page, name: string, options: { fullPage?: boolean; mask?: Locator[] } = {}): Promise<void> {
  await settle(page);
  await expect(page).toHaveScreenshot(`${name}.png`, options);
}
