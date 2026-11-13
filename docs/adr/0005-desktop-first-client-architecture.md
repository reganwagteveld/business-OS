# ADR 0005: Desktop-first clients (Tauri 2) with a shared React app and a cloud API

- Status: **Accepted**, 2026-11-13, decided by Regan. The sub-decisions listed under "Open decisions" stay open until the phase named.
- Date: 2026-11-13
- Decision ID: D9 (architecture.md §10)
- Supersedes: the "one Next.js app, web only" parts of architecture.md §1 (principle 1), §3, §4 and §11. Everything about data, tenancy and isolation (ADR 0001 to 0004, data-model.md) is unchanged.

## Context

Business OS is now a **desktop-first** product: native Windows and macOS applications are the primary experience, with a **companion browser app** for access from any machine. The Phase 0 architecture assumed a single Next.js application that rendered the UI with React Server Components and Server Actions, talking to PostgreSQL from the same process.

A native client changes three things:

1. The UI no longer runs on our servers. A desktop app is distributed to customers' machines, so **anything shipped in it is public**: it must hold no database credentials, no secrets and no server-only code, and it must be treated as an untrusted client exactly like a browser.
2. Server Components and Server Actions are not available to a native shell. The client needs an explicit, versioned **HTTP API**.
3. Two clients (desktop and web) must look and behave the same, so the UI and design system must be **shared code**, not two implementations.

The accepted security design must survive the change intact: server-side authentication, permission-key authorisation, the seven tenant-isolation layers (architecture §7.3), RLS with least-privilege roles (ADR 0004), and the modular domain boundaries (§5).

## Options considered

1. **Keep the web-only Next.js app; wrap it in a desktop shell that loads the hosted site.** Least work. But the "desktop app" is a browser tab with extra steps: no offline-capable shell later, every screen depends on server rendering, and the native/web boundary is blurred (a remote site with native capabilities is a larger attack surface). Rejected.
2. **Electron with a shared React app.** Mature ecosystem. Ships a full Chromium and Node.js runtime (large installers, more memory), and Node in the main process makes it easy to put privileged code, or even a database driver, in the client by mistake. Rejected in favour of a smaller, default-deny runtime.
3. **Tauri 2 desktop shell + Vite/React shared client + Next.js API (chosen).** Small native binaries using the OS web view (WebView2 on Windows, WKWebView on macOS), a capability system that is deny-by-default, and a Rust core we do not need to extend. The same Vite/React app is built for the browser. Next.js stays as the backend, keeping route handlers, middleware-free auth checks, Prisma and the Vercel deployment model already decided.
4. **Tauri + a different backend framework (e.g. Hono or Fastify).** Viable, but Next.js is already accepted, deployed and integrated with Better Auth (ADR 0001) and Vercel (ADR 0002). Changing the backend framework adds risk without a security or product gain. Revisit only if the API outgrows route handlers.

## Decision

### Shape

```
┌──────── Desktop app (Windows, macOS) ────────┐   ┌──────── Browser app ────────┐
│ Tauri 2 shell (Rust, no custom commands)     │   │ Static Vite build           │
│  └ OS web view → shared React app            │   │  └ shared React app         │
└──────────────────────┬───────────────────────┘   └──────────────┬──────────────┘
                       │ HTTPS only, JSON, /api/v1/... (contracts) │
┌──────────────────────▼───────────────────────────────────────────▼──────────────┐
│ Cloud API: Next.js route handlers on Vercel (iad1)                               │
│ authentication · authorisation · tenant context · modules · core/db             │
└──────────────────────────────────────┬──────────────────────────────────────────┘
                                       │ Prisma, bos_app role, RLS (ADR 0004)
┌──────────────────────────────────────▼──────────────────────────────────────────┐
│ Neon PostgreSQL (aws-us-east-1)                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

- **apps/desktop**: Tauri 2 shell for Windows and macOS. It renders the shared client app in a native window and has no custom IPC commands, no plugins and only `core:default` permissions.
- **apps/web**: the companion browser app. A static Vite build of the same shared client app.
- **apps/api**: Next.js, used **only as the cloud API** (route handlers under `/api/v1`). It is the only code that can reach PostgreSQL and contains all business logic, authentication, authorisation and tenant isolation. It renders no UI.
- **packages/app**: the shared React client (Home, Zones, typed API client). **packages/ui**: the shared design system (tokens, Tailwind theme, shadcn/ui-style components). **packages/contracts**: zod schemas and endpoint definitions shared by the API and the clients.
- Data: Neon PostgreSQL with Prisma, as before. Hosting: Vercel for the API (and for the static browser app), region `iad1`, as ADR 0002.

### Security rules (enforced, not conventions)

1. **The desktop app never connects to PostgreSQL.** It holds no database URL or credentials and has no database driver. Enforced by: client package manifests may not depend on any database driver, Prisma, `next`, `server-only` or the API package; the Tauri `Cargo.toml` may depend only on `tauri` and `tauri-build` (no `sqlx`, `postgres`, `diesel`, SQL plugin); the desktop Content Security Policy allows network connections only to the configured API origin (`connect-src`), generated per build from `VITE_API_BASE_URL`; CI greps the built client bundles for database configuration. (`tests/architecture/clients.test.ts`, `pnpm boundaries`, CI.)
2. **Clients cannot access server-only code.** The API is a separate workspace package that no client depends on. dependency-cruiser forbids any import from desktop, web or `packages/*` into `apps/api` or server-only packages; the source rules forbid server imports and database configuration in client source; only `VITE_*` variables reach a client bundle. Contracts contain schemas only.
3. **Business logic, authentication, authorisation and tenant isolation are enforced server-side.** Clients are untrusted. Hiding a button in a Zone is UX only; every API route re-authenticates, resolves the tenant and checks a permission. The client never sends a `business_id`: the tenant comes from the path and is verified against membership on the server (architecture §7.3, layer 1).
4. **Least-privilege native shell.** `withGlobalTauri: false` (page scripts cannot reach the Tauri API), `freezePrototype: true`, no shell, filesystem, HTTP, process or SQL plugins, a strict CSP (`default-src 'self'`, `script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`). Adding a capability or plugin is an architecture change that needs a reason in review.
5. **CORS is an exact allowlist** from validated configuration (`CORS_ALLOWED_ORIGINS`: desktop origins `tauri://localhost` on macOS and `http://tauri.localhost` on Windows, plus the browser app origin). No wildcards. CORS is a browser courtesy, not access control.
6. **The desktop app is online-only in Phase 1.** No local database, offline cache or sync. Any future offline mode is a separate decision with its own threat model (tenant data at rest on a laptop).

### API

- Versioned under `/api/v1`. Tenant-scoped routes live under `/api/v1/b/{businessSlug}/...` (ADR 0003 addendum).
- Every endpoint is declared once in `packages/contracts` (method, path, request and response schemas). The API validates its responses against the contract in tests, clients parse every response with it, and CI checks that every contract has a route handler and that the published JSON Schema snapshot is current. Breaking changes require a new version path.
- **Server Actions are no longer an entry point.** The `tenantAction` wrapper from architecture §7.3 layer 2 becomes a `tenantRoute` wrapper for route handlers with the same responsibilities (authenticate, resolve tenant, authorise, validate input with the contract schema, open the unit of work). The CI check that every Server Action is wrapped becomes a check that every route handler under `/api/v1/b/` is wrapped (Phase 1b).
- Responses with tenant data are `Cache-Control: private, no-store`.

### Authentication for two kinds of client

Better Auth stays the provider, with sessions stored in our database (ADR 0001 addendum). Phase 1b implements:

- **Browser app:** HTTP-only, `Secure`, `SameSite=Lax` session cookie. The browser app is served from the same site as the API (for example `app.<domain>` and `api.<domain>`, or one origin), so the cookie is first-party. Mutating requests require a matching `Origin` (CSRF defence).
- **Desktop app:** sign-in happens in the **system browser** (so passwords, passkeys and future SSO never pass through the app), which hands a one-time, short-lived code back to the app through a registered deep link or loopback redirect; the app exchanges it with PKCE for a session token. The token is sent as `Authorization: Bearer`, stored only in the OS credential store (macOS Keychain, Windows Credential Manager), and is revocable server-side like any session. The exact mechanism and the Tauri plugin needed for the credential store are decided in Phase 1b and recorded here.
- Both kinds of session resolve to the same server-side session record, so membership checks, revocation and audit are identical.
- The pre-tenant `SECURITY DEFINER` functions take the session token (data-model §5.5); for the desktop app the API reads it from the bearer header instead of the cookie. The function contract does not change.

### Zones and navigation

Zone manifests (architecture §6.2) move to the shared client app (`packages/app`) because navigation is a client concern. Which Zones and actions a user sees is derived from the permissions the API returns for the current membership; the API remains the only place permissions are enforced. Client-side routes mirror ADR 0003 (`/b/{slug}/...`). The client router library is chosen in Phase 1c.

## Consequences

- **Easier:** a real native app on Windows and macOS with small installers; one UI codebase for desktop and web; a hard, tool-enforced line between untrusted clients and the server; an explicit API that a future AI assistant and integrations can also use under the same authorisation.
- **Harder:** an explicit API contract to maintain (mitigated by the shared contracts package and CI checks); cross-origin concerns (CORS, cookie site, CSRF); native sign-in flow; code signing, notarisation and update delivery for desktop releases; two client build targets in CI.
- **Unchanged:** the data model, RLS and roles, region and colocation (the API and database stay together in us-east-1), module boundaries inside the API, ADRs 0001 to 0004.
- **Revisit if:** offline work becomes a product requirement; the API needs long-running connections that route handlers cannot serve; or a mobile app is planned (Tauri 2 supports mobile, but that is a separate decision).

## Open decisions (sub-decisions of D9)

| ID | Decision | Needed by |
|---|---|---|
| D9a | Desktop sign-in mechanism (deep link vs loopback redirect) and credential-store plugin | **Accepted 2026-11-13:** loopback + PKCE S256 + OS credential store (`keyring` crate); see addendum |
| D9b | Browser app hosting and domains (same origin vs `app.`/`api.` subdomains), which fixes the cookie and CORS configuration | **Accepted 2026-11-13:** same origin as the API; see addendum |
| D9c | Application identifier (currently the placeholder `com.business-os.desktop`), Apple Developer ID signing and notarisation, Windows code signing | Before the first build given to anyone outside the team. The identifier cannot change after release without losing the app's stored data and update path |
| D9d | Auto-update channel (Tauri updater with signed update manifests) | Before the first external release |
| D9e | Offline mode or local cache | Not planned; only on a product requirement |

## Verification in Phase 1a

- `apps/desktop` builds a working Tauri 2 shell that renders the shared app and reports the real API status.
- CI builds the desktop app on Windows and macOS (and compiles it on Linux), builds the API and browser app, runs the contract checks, and runs all existing security checks plus the client rules above.

## Addendum 2026-11-13: D9a and D9b accepted (Phase 1b, PR 4)

**Accepted by Regan on 2026-11-13.**

**D9a, desktop sign-in: loopback redirect (RFC 8252 §7.3) + PKCE S256 + OS credential store.**
- The app opens the system browser at `GET /api/v1/auth/desktop/authorize` with a PKCE challenge, a random `state` and `redirect_uri=http://127.0.0.1:<random port>/callback`. The API accepts only that loopback form.
- The browser signs in with the normal web flow; the person confirms on a page served by the API. Confirmation is a same-origin `POST` (Origin checked), so another site cannot trigger it. The API then stores a one-time code (hashed, 2 minutes) and redirects to the loopback address.
- The shared client exchanges code + verifier at `POST /api/v1/auth/desktop/token` for a new, separate session, returned once. The native shell stores it with the `keyring` crate (macOS Keychain, Windows Credential Manager) and the app sends it as `Authorization: Bearer`.
- Native surface added: four app commands (`await_browser_sign_in`, `load_session_token`, `store_session_token`, `forget_session_token`) and three crates (`keyring`, `open`, `serde`), enforced by `tests/architecture/clients.test.ts`. Still no Tauri plugins, no shell/fs/http access, no global Tauri API; the window CSP is unchanged. The browser-opening command refuses any URL other than the API's authorisation page.
- Deep links (`business-os://`) are not used for sign-in; they remain an option for opening shared links later.

**D9b, browser app hosting: same origin as the API.** Two `*.vercel.app` hosts are different sites, so a session cookie would be third-party between them. The browser app is therefore served on the same origin as the API (the web deployment forwards `/api/*` to the API), with a host-only `HttpOnly`, `Secure`, `SameSite=Lax` cookie (`__Secure-bos.session_token` on https) and an `Origin` check on every authentication `POST`. A custom domain with `app.`/`api.` subdomains of one registrable domain would also satisfy this later without code changes.
