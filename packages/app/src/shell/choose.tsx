import type { BusinessSummary } from '../api/tenancy';
import { Frame, secondaryClass } from './frame';

export const ROLE_LABEL = { OWNER: 'Owner', ADMIN: 'Admin', MANAGER: 'Manager', MEMBER: 'Member' } as const;

/** Lists exactly the businesses the server says you belong to. The server re-checks access when one is opened. */
export function ChooseWorkspace({ businesses, onSelect, onCreate, onSignOut }: {
  businesses: BusinessSummary[];
  onSelect: (slug: string) => void;
  onCreate: () => void;
  onSignOut: () => void;
}) {
  return (
    <Frame title="Choose your workspace" subtitle="Select a business to continue, or create a new one. Your access is always verified by the server.">
      <ul className="space-y-3">
        {businesses.map((business) => (
          <li key={business.slug}>
            <button
              type="button"
              className="flex w-full items-center justify-between rounded-xl border border-border p-4 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => onSelect(business.slug)}
            >
              <span><strong className="block">{business.name}</strong><span className="text-xs text-muted-foreground">{business.slug}</span></span>
              <span className="text-xs text-muted-foreground">{ROLE_LABEL[business.role]} →</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-6 flex gap-3">
        <button type="button" className={secondaryClass} onClick={onCreate}>Create another business</button>
        <button type="button" className={secondaryClass} onClick={onSignOut}>Sign out</button>
      </div>
    </Frame>
  );
}
