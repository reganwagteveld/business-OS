import type { BusinessSummary } from '../api/tenancy';
import { Frame, secondaryClass } from './frame';

export const ROLE_LABEL = { OWNER: 'Owner', ADMIN: 'Admin', MANAGER: 'Manager', MEMBER: 'Member' } as const;

/** Lists exactly the businesses the server says you belong to. The server re-checks access when one is opened. */
export function ChooseWorkspace({ businesses, onSelect, onCreate, onSignOut, onBack, revoked }: {
  businesses: BusinessSummary[];
  onSelect: (slug: string) => void;
  onCreate: () => void;
  onSignOut: () => void;
  /** A business the person just tried to open but no longer belongs to. */
  revoked?: string;
  /** Returns to the business that is already open (when there is one). */
  onBack?: () => void;
}) {
  return (
    <Frame title="Choose your workspace" subtitle="Select a business to continue, or create a new one. Your access is always verified by the server.">
      {revoked ? (
        <p role="alert" className="mb-5 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
          You no longer have access to {revoked}, or to the business you had open. Choose one of the businesses you still belong to.
        </p>
      ) : null}
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
      <div className="mt-6 flex flex-wrap gap-3">
        {onBack ? <button type="button" className={secondaryClass} onClick={onBack}>Back</button> : null}
        <button type="button" className={secondaryClass} onClick={onCreate}>Create another business</button>
        <button type="button" className={secondaryClass} onClick={onSignOut}>Sign out</button>
      </div>
    </Frame>
  );
}
