## Verification

- [ ] Typecheck, lint, boundaries and tests pass
- [ ] Tenant boundaries reviewed (if applicable)
- [ ] No US-only assumptions in the shared data model (field names, formats, units)
- [ ] Evidence or screenshots added for relevant acceptance criteria
- [ ] Clients (desktop, web, shared packages) still reach data only through the API; no new Tauri capability, plugin or CSP source without an architecture note (ADR 0005)
- [ ] API changes are declared in `packages/contracts` and are additive within `/api/v1`
