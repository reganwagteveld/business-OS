/**
 * Architectural boundaries (docs/architecture.md §4, §5.2, §5.3; ADR 0005).
 * Paths are matched on resolved file paths relative to the repository root, so aliases (`@/…`),
 * workspace packages (`@business-os/*`, symlinked to their real paths) and relative imports are
 * treated the same. The same rules run against the fixture trees in tests/architecture.
 * @type {import('dependency-cruiser').IConfiguration}
 */
// Two patterns each (hoisted and pnpm store paths) to keep every regex free of nested quantifiers.
const inNodeModules = (names) => [
  `(^|/)node_modules/(${names})/`,
  `(^|/)node_modules/\\.pnpm/[^/]+/node_modules/(${names})/`,
];
const API = '(^|/)apps/api/src/';
const CLIENTS = ['(^|/)apps/(web|desktop)/', '(^|/)packages/'];
const DB_PACKAGES = inNodeModules('@prisma/client|@prisma/adapter-pg|pg');
const VENDOR_SDKS = inNodeModules('@vercel|@aws-sdk|@upstash|@neondatabase|@supabase');
// Anything that can reach PostgreSQL or only runs on the server.
const SERVER_ONLY_PACKAGES = inNodeModules(
  '@prisma/client|@prisma/adapter-pg|@prisma/engines|prisma|pg|postgres|@neondatabase|@vercel/postgres|server-only|next|dotenv',
);

module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Modules, layers and packages must not depend on each other in a cycle (architecture §5.2 rule 4).',
      from: {},
      to: { circular: true },
    },

    // ── Clients (desktop, web, shared packages) ─────────────────────────────────────────────
    {
      name: 'clients-not-to-api',
      severity: 'error',
      comment: 'Desktop, web and shared packages never import API code; they call it over HTTPS (ADR 0005).',
      from: { path: CLIENTS },
      to: { path: ['(^|/)apps/api/', ...inNodeModules('@business-os/api')] },
    },
    {
      name: 'clients-no-database-or-server-packages',
      severity: 'error',
      comment: 'Clients never connect to PostgreSQL or load server-only packages (ADR 0005).',
      from: { path: CLIENTS },
      to: { path: SERVER_ONLY_PACKAGES },
    },
    {
      name: 'apps-are-independent',
      severity: 'error',
      comment: 'The desktop and web apps share code only through packages/*.',
      from: { path: '(^|/)apps/(web|desktop)/' },
      to: { path: '(^|/)apps/', pathNot: '(^|/)apps/$2/' },
    },
    {
      name: 'packages-not-to-apps',
      severity: 'error',
      comment: 'Shared packages never depend on an app.',
      from: { path: '(^|/)packages/' },
      to: { path: '(^|/)apps/' },
    },
    {
      name: 'contracts-is-a-leaf',
      severity: 'error',
      comment: 'API contracts depend only on zod: no UI, no client app, no server code.',
      from: { path: '(^|/)packages/contracts/' },
      to: { path: '(^|/)packages/(ui|app)/' },
    },
    {
      name: 'ui-is-presentational',
      severity: 'error',
      comment: 'The design system does not fetch data or know the API (architecture §6.5).',
      from: { path: '(^|/)packages/ui/' },
      to: { path: '(^|/)packages/(app|contracts)/' },
    },
    {
      name: 'api-uses-contracts-only',
      severity: 'error',
      comment: 'The API shares only contracts with the clients, never client UI code.',
      from: { path: API },
      to: { path: '(^|/)packages/(ui|app)/' },
    },

    // ── API (apps/api/src) ──────────────────────────────────────────────────────────────────
    {
      name: 'module-public-api-only',
      severity: 'error',
      comment: 'Another module may only be imported through its index.ts (architecture §5.2 rule 1).',
      from: { path: `${API}modules/([^/]+)/` },
      to: {
        path: `${API}modules/[^/]+/.+`,
        pathNot: [`${API}modules/$2/`, `${API}modules/[^/]+/index\\.tsx?$`],
      },
    },
    {
      name: 'routes-use-module-public-api',
      severity: 'error',
      comment: 'Route handlers use modules only through their index.ts.',
      from: { path: `${API}app/` },
      to: { path: `${API}modules/[^/]+/.+`, pathNot: `${API}modules/[^/]+/index\\.tsx?$` },
    },
    {
      name: 'modules-not-to-app',
      severity: 'error',
      comment: 'Domain modules never depend on the routing layer.',
      from: { path: `${API}modules/` },
      to: { path: `${API}app/` },
    },
    {
      name: 'core-is-the-kernel',
      severity: 'error',
      comment: 'core depends on nothing else in the API (architecture §5.1).',
      from: { path: `${API}core/` },
      to: { path: `${API}(app|modules)/` },
    },
    {
      name: 'database-access-only-in-core-db',
      severity: 'error',
      comment: 'Only apps/api/src/core/db may import Prisma, the generated client or the pg driver (architecture §5.2 rule 6).',
      from: { path: '.', pathNot: `${API}(core/db|generated)/` },
      to: { path: [...DB_PACKAGES, `${API}generated/prisma/`] },
    },
    {
      name: 'no-vendor-sdk-in-modules',
      severity: 'error',
      comment: 'Platform services are reached through adapters in core (architecture §13.3).',
      from: { path: `${API}modules/` },
      to: { path: VENDOR_SDKS },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    // Generated code is not cruised, but imports *into* it are still recorded,
    // so the database-access rule sees them (an `exclude` would hide them).
    doNotFollow: { path: ['node_modules', '(^|/)apps/api/src/generated/'] },
    exclude: { path: ['(^|/)dist/', '(^|/)src-tauri/'] },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.css', '.d.ts'],
    },
  },
};
