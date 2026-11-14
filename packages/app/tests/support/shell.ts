import { screen, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';

/** Ways out of a screen through the application shell, for tests. */

/** The "Home" breadcrumb (shown on every Zone page). */
export const homeCrumb = () => within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByRole('button', { name: 'Home' });

/** The business switcher button (its name always includes the active business). */
export const switcher = () => screen.getByRole('button', { name: /Switch business/ });

/** Opens the business switcher and picks a listed business by name. */
export async function switchBusiness(user: UserEvent, name: string | RegExp) {
  await user.click(switcher());
  await user.click(await screen.findByRole('menuitemradio', { name }));
}

/** Opens the business switcher and chooses "All businesses…" (the full chooser). */
export async function chooseAllBusinesses(user: UserEvent) {
  await user.click(switcher());
  await user.click(await screen.findByRole('menuitem', { name: 'All businesses…' }));
}

/** Opens the account menu and signs out. */
export async function signOutViaMenu(user: UserEvent) {
  await user.click(screen.getByRole('button', { name: /Account menu/ }));
  await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
}
