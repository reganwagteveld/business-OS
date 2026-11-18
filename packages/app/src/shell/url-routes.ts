import { HOME, ZONES, type ShellRoute, type ZoneDefinition } from './registry';

/**
 * Shell URL routing: the registry's `route` values become real addresses.
 *
 * Only the Zone and its section are ever written to the address: no business slug, record id, token or
 * intent. Reading an address proves nothing about access, so a parsed route is only a request: the shell
 * still checks it against the server's permissions (`canOpen`) and the active business before showing it.
 */

/** Path ("/finance/invoices") for a route. Zone-level routes and unknown sections map to the Zone's own path. */
export function routeToPath(route: ShellRoute, zones: readonly ZoneDefinition[] = ZONES): string {
  if (route.zone === 'home') return '/';
  const zone = zones.find((z) => z.id === route.zone);
  if (!zone) return '/';
  const child = route.child ? zone.children?.find((c) => c.id === route.child) : undefined;
  return child ? child.route : zone.route;
}

/**
 * The route for a path, or HOME for anything that is not exactly a built Zone or one of its sections
 * (planned Zones, unknown paths, extra segments). One trailing slash is tolerated; query and hash are ignored.
 */
export function pathToRoute(path: string, zones: readonly ZoneDefinition[] = ZONES): ShellRoute {
  const clean = path.split(/[?#]/, 1)[0] ?? '';
  const normal = clean.length > 1 && clean.endsWith('/') ? clean.slice(0, -1) : clean;
  for (const zone of zones) {
    if (zone.availability !== 'built') continue;
    // Child routes first: the first child often shares the Zone's own path and then means "the Zone's default".
    const child = zone.children?.find((c) => c.route === normal && c.route !== zone.route);
    if (child) return { zone: zone.id, child: child.id };
    if (zone.route === normal) return { zone: zone.id };
  }
  return HOME;
}
