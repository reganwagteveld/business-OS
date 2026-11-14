import { Slug } from '@business-os/contracts';

/**
 * Non-sensitive local memory: which business the person last used, and whether they had a session
 * (so an expired session can be told apart from a first visit). Never a token, never an id, and never
 * trusted: the slug is re-checked against the server's membership list on every start.
 */
export interface WorkspaceStorage {
  getSlug(): string | null;
  setSlug(slug: string): void;
  clearSlug(): void;
  hadSession(): boolean;
  setHadSession(value: boolean): void;
}

const SLUG_KEY = 'bos.workspace';
const SESSION_KEY = 'bos.had-session';

/** localStorage-backed; every access is guarded because storage can be blocked or full. */
export function browserStorage(): WorkspaceStorage {
  const read = (key: string) => {
    try {
      return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  };
  const write = (key: string, value: string | null) => {
    try {
      if (value === null) globalThis.localStorage?.removeItem(key);
      else globalThis.localStorage?.setItem(key, value);
    } catch {
      /* storage unavailable: the app works without it */
    }
  };
  return {
    getSlug() {
      const value = read(SLUG_KEY);
      return value !== null && Slug.safeParse(value).success ? value : null;
    },
    setSlug: (slug) => write(SLUG_KEY, Slug.safeParse(slug).success ? slug : null),
    clearSlug: () => write(SLUG_KEY, null),
    hadSession: () => read(SESSION_KEY) === '1',
    setHadSession: (value) => write(SESSION_KEY, value ? '1' : null),
  };
}

export function memoryStorage(initial: { slug?: string | null; hadSession?: boolean } = {}): WorkspaceStorage {
  let slug = initial.slug ?? null;
  let had = initial.hadSession ?? false;
  return {
    getSlug: () => (slug !== null && Slug.safeParse(slug).success ? slug : null),
    setSlug: (s) => void (slug = s),
    clearSlug: () => void (slug = null),
    hadSession: () => had,
    setHadSession: (v) => void (had = v),
  };
}
