import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChooseWorkspace, ROLE_LABEL } from '../src/shell/choose';
import { Startup } from '../src/shell/frame';
import { BusinessSetup, slugify, validateDetails } from '../src/shell/onboarding';
import { Failed, SessionExpiredNotice, Unreachable, Unverified } from '../src/shell/states';
import { ZoneHome } from '../src/shell/zone-home';

const user = { id: '0b8f9a9e-2f1c-4c7e-9a52-0c7f6d1b2a10', email: 'a@example.com', name: 'Ada', emailVerified: true };
const noop = () => {};
const businesses = [
  { slug: 'acme', name: 'Acme Plumbing', role: 'OWNER' as const },
  { slug: 'globex', name: 'Globex', role: 'MEMBER' as const },
];

describe('startup and error states', () => {
  it('startup is never blank: logo, name, attribution and status text are present from the first frame', () => {
    const html = renderToStaticMarkup(<Startup label="Starting Business OS…" />);
    expect(html).toContain('Business OS logo');
    expect(html).toContain('Business OS');
    expect(html).toContain('Powered by Pixakova');
    expect(html).toContain('Starting Business OS…');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
  });

  it('the loading animation is switched off for reduced-motion users', () => {
    expect(renderToStaticMarkup(<Startup />)).toContain('motion-reduce:animate-none');
  });

  it('offline and "service not responding" are different, announce themselves, and offer a retry', () => {
    const offline = renderToStaticMarkup(<Unreachable offline onRetry={noop} />);
    const down = renderToStaticMarkup(<Unreachable offline={false} onRetry={noop} />);
    expect(offline).toContain('offline');
    expect(down).toContain('Can&#x27;t reach Business OS');
    for (const html of [offline, down]) {
      expect(html).toContain('role="alert"');
      expect(html).toContain('Try again');
      expect(html).not.toMatch(/signed out/i);
    }
    expect(down).toContain('session is still saved');
  });

  it('a server failure says nothing was changed and offers retry and sign out', () => {
    const html = renderToStaticMarkup(<Failed onRetry={noop} onSignOut={noop} />);
    expect(html).toContain('Nothing was changed');
    expect(html).toContain('Try again');
    expect(html).toContain('Sign out');
  });

  it('an ended session and an unverified email are explained plainly', () => {
    expect(renderToStaticMarkup(<SessionExpiredNotice />)).toContain('Your session has ended');
    const html = renderToStaticMarkup(<Unverified user={user} onSignOut={noop} onRefresh={noop} />);
    expect(html).toContain('a@example.com');
    expect(html).toContain('Sign out');
  });
});

describe('workspace choice and onboarding', () => {
  it('lists exactly the businesses the server returned, with roles, as keyboard-focusable buttons', () => {
    const html = renderToStaticMarkup(<ChooseWorkspace businesses={businesses} onSelect={noop} onCreate={noop} onSignOut={noop} />);
    expect(html).toContain('Acme Plumbing');
    expect(html).toContain('Globex');
    expect(html).toContain(ROLE_LABEL.OWNER);
    expect(html).toContain(ROLE_LABEL.MEMBER);
    expect(html).toContain('Create another business');
    expect(html).toContain('focus-visible:outline-2');
  });

  it('the first-business wizard starts at step 1, mentions invitations and creates nothing yet', () => {
    const html = renderToStaticMarkup(<BusinessSetup onCreate={async () => ({ ok: true })} />);
    expect(html).toContain('Step 1 of 3');
    expect(html).toContain('Business name');
    expect(html).toContain('Workspace address');
    expect(html).toContain('invitation email');
    expect(html).not.toContain('Create workspace');
  });

  it('slug previews are lowercase, hyphenated, accent-free and within the server limit', () => {
    expect(slugify('Acme Plumbing & Co.')).toBe('acme-plumbing-co');
    expect(slugify('Café Müller')).toBe('cafe-muller');
    expect(slugify('x'.repeat(80)).length).toBeLessThanOrEqual(48);
    expect(slugify('  --  ')).toBe('');
  });

  it('details are checked against the same standards as the server before anything is sent', () => {
    const ok = { countryCode: 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency: 'AUD' };
    expect(validateDetails(ok)).toBeNull();
    expect(validateDetails({ ...ok, countryCode: 'Australia' })).toMatch(/two-letter/);
    expect(validateDetails({ ...ok, timeZone: 'Mars/Olympus' })).toMatch(/time zone/i);
    expect(validateDetails({ ...ok, currency: 'AU' })).toMatch(/currency/i);
    expect(validateDetails({ ...ok, currency: 'XYZ' })).toMatch(/currency/i);
    expect(validateDetails({ ...ok, locale: 'english' })).toMatch(/locale/i);
  });
});

describe('Zone home', () => {
  const html = renderToStaticMarkup(<ZoneHome business="Acme Plumbing" user={user} role="OWNER" onSwitch={noop} onSignOut={noop} />);

  it('shows the real business, person and role, with a switcher and sign out', () => {
    expect(html).toContain('Welcome to Acme Plumbing');
    expect(html).toContain('Ada');
    expect(html).toContain('Switch business, current business Acme Plumbing');
    expect(html).toContain('Sign out');
    expect(html).toContain('Powered by Pixakova');
  });

  it('every Zone is an honest, non-clickable "coming soon" card: no dead links, no invented data', () => {
    for (const zone of ['Customers', 'Sales', 'Projects', 'Finance', 'People', 'Operations', 'Insights', 'Settings']) {
      expect(html).toContain(`${zone} Zone — coming soon`);
    }
    expect(html).not.toMatch(/<a /);
    expect(html).not.toMatch(/href=/);
    expect(html).not.toMatch(/revenue|\$\d|notification|\b\d+ (new|open|overdue)/i);
  });
});

describe('branding', () => {
  const mark = readFileSync(resolve(__dirname, '../src/shell/business-os-mark.tsx'), 'utf8');
  it('uses the four-tile mark, not the Pixakova butterfly', () => {
    expect((mark.match(/<rect /g) ?? []).length).toBe(5); // frame + four tiles
    expect(mark).not.toMatch(/butterfly/i);
  });
});
