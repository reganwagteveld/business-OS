/**
 * Where the shell's address lives. The browser app uses the real path (the host rewrites every non-API
 * path to index.html); the desktop app uses the URL fragment, because its bundled files have no server
 * to answer a reload of "/finance/invoices". Both give back/forward and survive a reload.
 */
export interface ShellHistory {
  /** The current shell path, always starting with "/". */
  read(): string;
  push(path: string): void;
  replace(path: string): void;
  /** Called when the person uses back/forward. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

/** Subset of `window` the adapters use, so tests can pass a fake. */
export type HistoryWindow = Pick<Window, 'location' | 'history' | 'addEventListener' | 'removeEventListener'>;

export function createPathHistory(win: HistoryWindow = window): ShellHistory {
  return {
    read: () => win.location.pathname,
    push: (path) => win.history.pushState(null, '', path),
    replace: (path) => win.history.replaceState(null, '', path),
    subscribe: (listener) => {
      win.addEventListener('popstate', listener);
      return () => win.removeEventListener('popstate', listener);
    },
  };
}

export function createHashHistory(win: HistoryWindow = window): ShellHistory {
  const hashPath = (path: string) => `#${path}`;
  return {
    read: () => {
      const hash = win.location.hash.startsWith('#/') ? win.location.hash.slice(1) : '/';
      return hash;
    },
    push: (path) => win.history.pushState(null, '', hashPath(path)),
    replace: (path) => win.history.replaceState(null, '', hashPath(path)),
    subscribe: (listener) => {
      win.addEventListener('popstate', listener);
      return () => win.removeEventListener('popstate', listener);
    },
  };
}
