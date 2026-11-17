import { SectionHeader } from '@business-os/ui';
import { ZonePage } from '../../shell/zone-page';
import type { SettingsPageEnv } from './business-profile';
import { zoneLinksFor } from './zone-links';

/**
 * Business › Zone configuration. A hub of links to configuration that already lives inside each Zone, so
 * it is found in one place without being duplicated. Nothing here is editable and nothing is listed
 * for a Zone the person cannot open.
 */
export function ZoneConfigurationPage({ env }: { env: SettingsPageEnv & { open: (route: import('../../shell/registry').ShellRoute) => void } }) {
  const links = zoneLinksFor(env.me.permissions);
  const zones = [...new Set(links.map((l) => l.zone))];
  const held = new Set(env.me.permissions);
  return (
    <ZonePage title="Zone configuration" description="Where each part of Pixa OS keeps its own settings.">
      {zones.map((zone) => (
        <section key={zone} aria-labelledby={`zc-${zone}`} className="space-y-1">
          <SectionHeader variant="ruled" as="h2" title={<span id={`zc-${zone}`}>{zone}</span>} />
          <ul>
            {links.filter((l) => l.zone === zone).map((l) => (
              <li key={l.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-line py-3">
                <div className="min-w-0">
                  <p className="text-body font-medium">{l.label}</p>
                  <p className="text-small text-muted-foreground">{l.description}{l.editKey && !held.has(l.editKey) ? ' You can view it but not change it.' : ''}</p>
                </div>
                <button type="button" className="font-medium underline focus-ring rounded-sm" aria-label={`Open ${l.label} in ${l.zone}`} onClick={() => env.open(l.route)}>Open in {l.zone}</button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </ZonePage>
  );
}
