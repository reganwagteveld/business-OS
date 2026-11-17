/**
 * Audit viewer A-AUD-1 unit and source-rule tests (docs/administration-audit-viewer.md §4, §5, §11): the view
 * rules (default-deny metadata and targets), the dotted-prefix pattern, the 92-day window, the query contract,
 * and a coverage scan that makes every audited action in the source resolve to a family rule.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ListAuditEventsQuery } from '@business-os/contracts';
import {
  FALLBACK_LABEL, FALLBACK_TARGET_TYPE, MAX_WINDOW_MS, matchFamily, prefixLikePattern, resolveRule, resolveWindow, SAFE_TARGET_TYPES, sanitizeMetadata, VIEW_RULES, viewTarget,
} from '@/core/audit/view-rules';

const SRC = resolve(__dirname, '../../src');
const PRIVILEGED = resolve(__dirname, '../../prisma/privileged');
const U = '11111111-1111-4111-8111-111111111111';

function files(dir: string, pattern: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'generated' ? [] : files(path, pattern);
    return pattern.test(name) ? [path] : [];
  });
}

describe('view rules', () => {
  it('labels an action from its family noun and the rest of the name', () => {
    expect(resolveRule('invitation.created')).toMatchObject({ label: 'Invitation created', group: 'team' });
    expect(resolveRule('membership.ownership_transferred').label).toBe('Member ownership transferred');
    expect(resolveRule('finance.document_pdf.downloaded')).toMatchObject({ label: 'Document PDF downloaded', group: 'finance' });
    expect(resolveRule('communications.erasure.requested').group).toBe('communications');
  });

  it('picks the longest matching family and never a partial word', () => {
    expect(matchFamily('finance.document_pdf.generated')?.prefix).toBe('finance.document_pdf');
    expect(matchFamily('finance.document.issued')?.prefix).toBe('finance');
    expect(matchFamily('sales.pipeline.created')?.prefix).toBe('sales.pipeline');
    expect(matchFamily('messages.imported')?.prefix).toBe('messages');
    expect(matchFamily('salesforce.import')).toBeUndefined();
    expect(matchFamily('customers.created')).toBeUndefined();
  });

  it('gives any other string the fixed fallback: no metadata, at most a fixed target type', () => {
    for (const action of ['brand_new.thing', 'x', '', 'Customer.created', 'customer created', '<script>alert(1)</script>', 'a'.repeat(200)]) {
      const rule = resolveRule(action);
      expect(rule, action).toMatchObject({ label: FALLBACK_LABEL, group: 'other', unknown: true, target: 'type_only' });
      expect(rule.keys.size).toBe(0);
      expect(viewTarget(rule, 'secret_type', U)).toEqual({ type: FALLBACK_TARGET_TYPE });
    }
  });

  it('keeps only allow-listed keys and plain values, truncating strings and lists', () => {
    const keys = new Set(['fields', 'role', 'count', 'flag']);
    expect(sanitizeMetadata({ fields: ['a', 'b'], role: 'ADMIN', count: 3, flag: false, email: 'x@y.z', token: 't', nested: { a: 1 } }, keys)).toEqual({ fields: ['a', 'b'], role: 'ADMIN', count: 3, flag: false });
    expect(sanitizeMetadata({ role: 'x'.repeat(500) }, keys).role).toHaveLength(200);
    expect((sanitizeMetadata({ fields: Array.from({ length: 50 }, (_, i) => `f${i}`) }, keys).fields as string[]).length).toBe(20);
    expect(sanitizeMetadata({ fields: ['a', 1] }, keys)).toEqual({});
    expect(sanitizeMetadata({ role: null, count: Number.NaN, flag: 'yes' }, keys)).toEqual({ flag: 'yes' });
    expect(sanitizeMetadata({ __proto__: { role: 'x' } }, keys)).toEqual({});
    for (const raw of [null, undefined, 'text', 4, ['role']]) expect(sanitizeMetadata(raw, keys)).toEqual({});
  });

  it('never allows keys that carry ids of people, contact details, amounts, hashes or free text', () => {
    const forbidden = /(^|[a-z])(userid|email|phone|token|hash|sha256|amount|total|subtotal|subject|body|note|name|address)$/i;
    for (const rule of VIEW_RULES) {
      for (const key of rule.keys.filter((k) => !k.startsWith('has'))) expect(forbidden.test(key), `${rule.prefix}.${key}`).toBe(false);
    }
    // from/to only where they are status or role codes (exact additions), never in a family that holds ids.
    for (const rule of VIEW_RULES.filter((r) => r.prefix !== 'membership')) expect(rule.keys, rule.prefix).not.toContain('from');
    expect(resolveRule('projects.project.assigned').keys.has('from')).toBe(false);
    expect(resolveRule('people.employee.department_changed').keys.has('from')).toBe(false);
    expect(resolveRule('projects.task.status_changed').keys.has('from')).toBe(true);
    expect(resolveRule('membership.removed').keys.has('userId')).toBe(false);
    expect(resolveRule('membership.ownership_transferred').keys.has('toUserId')).toBe(false);
  });

  it('shows a target as the rule allows: id for show, type for type_only, nothing for hidden or absent', () => {
    expect(viewTarget(resolveRule('customer.created'), 'customer', U)).toEqual({ type: 'customer', id: U });
    expect(viewTarget(resolveRule('customer.created'), 'weird_type', U)).toEqual({ type: 'record', id: U });
    expect(viewTarget(resolveRule('people.employee.updated'), 'people_employee', U)).toEqual({ type: 'people_employee' });
    expect(viewTarget(resolveRule('communications.erasure.requested'), 'erasure', U)).toBeNull();
    expect(viewTarget(resolveRule('conversation.created'), 'conversation', U)).toBeNull();
    expect(viewTarget(resolveRule('customer.created'), null, null)).toBeNull();
  });
});

describe('action prefix', () => {
  it('escapes LIKE metacharacters and appends the dot boundary', () => {
    expect(prefixLikePattern('sales')).toBe('sales.%');
    expect(prefixLikePattern('a_b.c')).toBe('a\\_b.c.%');
    expect(prefixLikePattern('100%')).toBe('100\\%.%');
    expect(prefixLikePattern('a\\b')).toBe('a\\\\b.%');
  });
});

describe('time window', () => {
  const now = new Date('2026-11-17T12:00:00.000Z');
  const days = (n: number) => n * 86_400_000;
  it('is always at most 92 days', () => {
    const none = resolveWindow({}, now)!;
    expect(none.to.getTime()).toBe(now.getTime());
    expect(none.to.getTime() - none.from.getTime()).toBe(MAX_WINDOW_MS);
    const onlyTo = resolveWindow({ to: '2026-06-01T00:00:00.000Z' }, now)!;
    expect(onlyTo.to.getTime() - onlyTo.from.getTime()).toBe(MAX_WINDOW_MS);
    const onlyFrom = resolveWindow({ from: '2026-01-01T00:00:00.000Z' }, now)!;
    expect(onlyFrom.to.getTime() - onlyFrom.from.getTime()).toBe(MAX_WINDOW_MS);
    const recent = resolveWindow({ from: new Date(now.getTime() - days(5)).toISOString() }, now)!;
    expect(recent.to.getTime()).toBe(now.getTime());
    const both = resolveWindow({ from: '2026-10-01T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z' }, now)!;
    expect(both.to.getTime() - both.from.getTime()).toBe(days(1));
  });
  it('has nothing to show for a start in the future', () => {
    expect(resolveWindow({ from: '2026-12-01T00:00:00.000Z' }, now)).toBeNull();
  });
});

describe('query contract', () => {
  const parse = (q: Record<string, unknown>) => ListAuditEventsQuery.safeParse(q);
  it('accepts the documented parameters and defaults the limit', () => {
    expect(parse({})).toMatchObject({ success: true, data: { limit: 50 } });
    expect(parse({ actionPrefix: 'sales.opportunity', actorUserId: U, from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z', limit: '100' }).success).toBe(true);
    expect(parse({ actorKind: 'system' }).success).toBe(true);
  });
  it('refuses target filters, unknown keys, bad prefixes, bad limits and impossible combinations', () => {
    for (const q of [
      { targetId: U }, { targetType: 'customer' }, { business: U }, { actionPrefix: 'Sales' }, { actionPrefix: 'sales%' }, { actionPrefix: 'a'.repeat(61) },
      { actorUserId: 'not-a-uuid' }, { actorKind: 'member' }, { actorKind: 'system', actorUserId: U }, { limit: '0' }, { limit: '101' }, { limit: 'x' },
      { from: '2026-02-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }, { from: '2026-01-01T00:00:00Z', to: '2026-06-01T00:00:00Z' }, { from: 'yesterday' },
      { cursor: 'has space' },
    ]) expect(parse(q).success, JSON.stringify(q)).toBe(false);
  });
});

describe('coverage: every audited action resolves to a family rule', () => {
  const found = new Map<string, string>();
  for (const path of files(SRC, /\.ts$/)) {
    const text = readFileSync(path, 'utf8');
    for (const m of text.matchAll(/(?:recordAudit|recordSystemAudit|\baudit)\(\s*db\s*,\s*(?:[A-Za-z_.]+\s*,\s*)?'([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)'/g)) found.set(m[1]!, path);
  }
  for (const path of files(PRIVILEGED, /\.sql$/)) {
    const text = readFileSync(path, 'utf8');
    for (const m of text.matchAll(/'((?:business|invitation|communications)\.[a-z_]+(?:\.[a-z_]+)*)'/g)) found.set(m[1]!, path);
  }

  it('finds the actions the plan lists (a guard against the scan going blind)', () => {
    for (const action of ['membership.suspended', 'customer.created', 'finance.document.issued', 'communications.erasure.requested', 'business.created', 'invitation.accepted']) {
      expect(found.has(action), action).toBe(true);
    }
    expect(found.size).toBeGreaterThan(120);
  });

  it('has no audited action without a family rule (add a rule, or an explicit decision, in the PR that adds the action)', () => {
    const unknown = [...found.keys()].filter((action) => resolveRule(action).unknown).sort();
    expect(unknown).toEqual([]);
  });

  it('only names target types from the safe list in the rules it can show', () => {
    expect(SAFE_TARGET_TYPES.has('customer')).toBe(true);
    expect(SAFE_TARGET_TYPES.has('mail_connection_credential')).toBe(false);
  });
});
