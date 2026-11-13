/**
 * Architectural boundaries (docs/architecture.md §4, §5.2, §5.3).
 * Paths are matched on resolved file paths, so aliases (`@/…`) and relative
 * imports are treated the same. Patterns start with `(^|/)src/` so the same
 * rules apply to the fixture trees in tests/fixtures/boundaries.
 * @type {import('dependency-cruiser').IConfiguration}
 */
// Two patterns each (hoisted and pnpm store paths) to keep every regex free of nested quantifiers.
const inNodeModules = (names) => [
  `(^|/)node_modules/(${names})/`,
  `(^|/)node_modules/\\.pnpm/[^/]+/node_modules/(${names})/`,
];
const DB_PACKAGES = inNodeModules('@prisma/client|@prisma/adapter-pg|pg');
const VENDOR_SDKS = inNodeModules('@vercel|@aws-sdk|@upstash|@neondatabase|@supabase');

module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Modules and layers must not depend on each other in a cycle (architecture §5.2 rule 4).',
      from: {},
      to: { circular: true },
    },
    {
      name: 'module-public-api-only',
      severity: 'error',
      comment: 'Another module may only be imported through its index.ts (architecture §5.2 rule 1).',
      from: { path: '(^|/)src/modules/([^/]+)/' },
      to: {
        path: '(^|/)src/modules/[^/]+/.+',
        pathNot: ['(^|/)src/modules/$2/', '(^|/)src/modules/[^/]+/index\\.tsx?$'],
      },
    },
    {
      name: 'layers-use-module-public-api',
      severity: 'error',
      comment: 'app, zones and ui use modules only through their index.ts.',
      from: { path: '(^|/)src/(app|zones|ui)/' },
      to: {
        path: '(^|/)src/modules/[^/]+/.+',
        pathNot: '(^|/)src/modules/[^/]+/(index\\.tsx?|ui/.+)$',
      },
    },
    {
      name: 'modules-not-to-app',
      severity: 'error',
      comment: 'Domain modules never depend on the routing layer.',
      from: { path: '(^|/)src/modules/' },
      to: { path: '(^|/)src/app/' },
    },
    {
      name: 'core-is-the-kernel',
      severity: 'error',
      comment: 'core depends on nothing else in src (architecture §5.1).',
      from: { path: '(^|/)src/core/' },
      to: { path: '(^|/)src/(app|zones|modules|ui)/' },
    },
    {
      name: 'ui-is-presentational',
      severity: 'error',
      comment: 'The design system does not depend on app, zones, modules or the database.',
      from: { path: '(^|/)src/ui/' },
      to: { path: ['(^|/)src/(app|zones|modules)/', '(^|/)src/core/(db|tenant)/'] },
    },
    {
      name: 'database-access-only-in-core-db',
      severity: 'error',
      comment: 'Only src/core/db may import Prisma, the generated client or the pg driver (architecture §5.2 rule 6).',
      from: { path: '(^|/)src/', pathNot: '(^|/)src/(core/db|generated)/' },
      to: { path: [...DB_PACKAGES, '(^|/)src/generated/prisma/'] },
    },
    {
      name: 'no-vendor-sdk-in-modules',
      severity: 'error',
      comment: 'Platform services are reached through adapters in core (architecture §13.3).',
      from: { path: '(^|/)src/modules/' },
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
    doNotFollow: { path: ['node_modules', '(^|/)src/generated/'] },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
    },
  },
};
