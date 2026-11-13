# ADR 0003: Tenant in the URL

- Status: **Accepted**, 2026-11-13 (Regan's third architecture review on PR #1)
- Date: 2026-11-13
- Decision ID: D4 (architecture.md §10)

## Context

Users can belong to several businesses, so each request must identify which business it is for. The identifier must be resolved server-side and verified against the user's membership on every request (architecture.md §7.3, layer 1).

## Options considered

1. **Path: `/b/[businessSlug]/...`**. One origin and one session cookie; simple local development and preview deployments; easy business switching; links are shareable within a business.
2. **Subdomain: `[slug].app.example.com`**. Looks branded and separates cookies per tenant if desired. Needs wildcard DNS and TLS, cookie-domain decisions, more complex previews and local dev, and the slug becomes harder to change.
3. **No tenant in URL (session-held "active business")**. Shortest URLs, but links are ambiguous across businesses and multi-tab use with two businesses breaks.

## Decision

Use **path-based** `/b/[businessSlug]`. The slug is display and routing only: it is resolved to a `business_id` through the user's membership on every request, and a non-member gets a 404.

## Consequences

- Business switching is a navigation, and two businesses can be open in two tabs.
- Slug changes need a redirect from the old slug (store previous slugs) so saved links keep working.
- Moving to subdomains later is possible: the tenant resolver is one function in `core/tenant`.
