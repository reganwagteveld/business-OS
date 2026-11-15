import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChooseWorkspace, ROLE_LABEL } from '../src/shell/choose';
import { Startup } from '../src/shell/frame';
import { BusinessSetup, slugify, validateDetails } from '../src/shell/onboarding';
import { Failed, SessionExpiredNotice, Unreachable, Unverified } from '../src/shell/states';
import { Home } from '../src/shell/home';
import { resolveNavigation } from '../src/shell/registry';

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

describe('Home', () => {
  const all = ['business:read', 'customers:read', 'customers:write', 'sales:read', 'sales:write', 'projects:read', 'projects:create'];
  const render = (permissions: string[]) => renderToStaticMarkup(
    <Home business="Acme Plumbing" timeZone="Australia/Sydney" user={user} role="OWNER" permissions={permissions}
      navigation={resolveNavigation({ state: 'ready', permissions })} onOpen={noop} />,
  );
  const html = render(all);

  it('greets the person and shows the real business and role', () => {
    expect(html).toContain('Welcome to Acme Plumbing');
    expect(html).toMatch(/Good (morning|afternoon|evening), Ada/);
    expect(html).toContain('owner');
  });

  it('launches only the Zones the role can open; Zones not built yet are honest, non-clickable "coming soon" cards', () => {
    for (const zone of ['Customers', 'Sales', 'Projects']) expect(html).toContain(`Open the ${zone} Zone`);
    for (const zone of ['People', 'Operations', 'Settings']) expect(html).toContain(`${zone} Zone — coming soon`);
    // Reporting R1 is built (it replaced the planned Insights card) and needs reporting:read.
    expect(html).not.toContain('Reporting Zone — coming soon');
    expect(render(['business:read', 'reporting:read'])).toContain('Open the Reporting Zone');
    // Finance is built (F3): shown only to roles holding finance:read, never as coming soon.
    expect(html).not.toContain('Finance Zone — coming soon');
    expect(render(['business:read', 'finance:read'])).toContain('Open the Finance Zone');
    const limited = render(['business:read', 'customers:read']);
    expect(limited).not.toContain('Open the Sales Zone');
    expect(limited).not.toContain('Sales Zone — coming soon');
  });

  it('offers common actions only where the role may act', () => {
    expect(html).toContain('Add customer');
    expect(html).toContain('Add opportunity');
    expect(html).toContain('New project');
    const reader = render(['business:read', 'customers:read', 'sales:read', 'projects:read']);
    expect(reader).not.toMatch(/Add customer|Add opportunity|New project/);
  });

  it('invents nothing: no links, no figures, and recent activity says it is not available yet', () => {
    expect(html).not.toMatch(/<a /);
    expect(html).not.toMatch(/href=/);
    expect(html).not.toMatch(/revenue|\$\d|\b\d+ (new|open|overdue)/i);
    expect(html).toContain('No combined activity feed yet');
  });
});

describe('branding', () => {
  const mark = readFileSync(resolve(__dirname, '../src/shell/business-os-mark.tsx'), 'utf8');
  it('uses the four-tile mark, not the Pixakova butterfly', () => {
    expect((mark.match(/<rect /g) ?? []).length).toBe(5); // frame + four tiles
    expect(mark).not.toMatch(/butterfly/i);
  });
});
