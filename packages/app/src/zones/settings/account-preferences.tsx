import type { CurrentUser } from '@business-os/contracts';
import { SectionHeader } from '@business-os/ui';
import { useSidebarPreference, useThemePreference, type SidebarMode, type ThemePreference } from '../../shell/preferences';
import { ZonePage } from '../../shell/zone-page';
import { Facts, Segmented } from './parts';

const THEMES: readonly { value: ThemePreference; label: string }[] = [{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }];
const SIDEBARS: readonly { value: SidebarMode; label: string }[] = [{ value: 'expanded', label: 'Expanded' }, { value: 'compact', label: 'Compact' }];

/**
 * Account › Preferences. The identity is read from the signed-in session (read-only: no name or email
 * change exists on the server yet). Theme and sidebar are per-device preferences that never leave this
 * device, and apply immediately: there is nothing to save.
 */
export function AccountPreferences({ user }: { user: CurrentUser }) {
  const [theme, setTheme] = useThemePreference();
  const [sidebar, setSidebar] = useSidebarPreference();
  return (
    <ZonePage title="Preferences" description="Your account, and how Pixa OS looks on this device.">
      <section aria-labelledby="signed-in" className="space-y-3">
        <SectionHeader variant="ruled" as="h2" title={<span id="signed-in">Signed in as</span>} meta="Across every business" />
        <Facts items={[
          { label: 'Name', value: user.name },
          { label: 'Email', value: user.email, hint: user.emailVerified ? 'Verified' : 'Not verified yet' },
        ]} />
      </section>
      <section aria-labelledby="appearance" className="space-y-4">
        <SectionHeader variant="ruled" as="h2" title={<span id="appearance">Appearance</span>} meta="Saved on this device only" />
        <Segmented legend="Theme" name="theme" value={theme} options={THEMES} onChange={setTheme} />
        <Segmented legend="Sidebar" name="sidebar" value={sidebar} options={SIDEBARS} onChange={setSidebar} />
      </section>
    </ZonePage>
  );
}
