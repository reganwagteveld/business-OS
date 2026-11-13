import 'server-only';
// All runtime database clients are constructed in core/db (architecture §5.3). Tenant data is
// reached only through withTenant (./with-tenant.ts); the auth library's client lives in
// ./auth-client.ts and may be imported only by the identity module's auth adapter.
export { createWithTenant, TenantContextError, TenantScopeError } from './with-tenant';
export type { TenantContext, TenantDb, TenantRole } from './with-tenant';
