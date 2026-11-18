import type { CurrentUser } from '@business-os/contracts';
import type { AccountClient } from '../../api/account';

/** What every Account › page needs. Nothing here names a business: account changes apply across all of them. */
export interface AccountPageEnv {
  client: AccountClient;
  user: CurrentUser;
  markDraft: (key: string, dirty: boolean) => void;
  onSessionEnded: () => void;
  /** The signed-in person's details changed (their name), so the shell re-reads who is signed in. */
  onUserChanged: () => void;
  /** For showing dates and times only. */
  locale: string;
  timeZone: string;
}
