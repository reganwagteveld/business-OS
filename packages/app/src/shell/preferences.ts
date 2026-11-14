import { useCallback, useSyncExternalStore } from 'react';

/**
 * Per-device display preferences: the colour theme and the sidebar mode. Not tenant data, never
 * sent to the server, and safe to lose (every read falls back to a default). There is no
 * account-settings API yet; when there is, the theme can move there without changing callers.
 */

export type ThemePreference = 'system' | 'light' | 'dark';
export type SidebarMode = 'expanded' | 'compact';

const THEME_KEY = 'bos.theme';
const SIDEBAR_KEY = 'bos.sidebar';

function read(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function write(key: string, value: string) {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    /* storage unavailable: the preference lasts until reload */
  }
}

export function readTheme(): ThemePreference {
  const value = read(THEME_KEY);
  return value === 'light' || value === 'dark' ? value : 'system';
}

export function readSidebar(): SidebarMode {
  return read(SIDEBAR_KEY) === 'compact' ? 'compact' : 'expanded';
}

/**
 * Applies a theme with the classes the design system already understands (PR #32): no class follows
 * the OS, `.dark` or `.light` on <html> overrides it.
 */
export function applyTheme(preference: ThemePreference, root: HTMLElement | undefined = globalThis.document?.documentElement) {
  if (!root) return;
  root.classList.toggle('dark', preference === 'dark');
  root.classList.toggle('light', preference === 'light');
}

/** Call once before the first render so a chosen theme does not flash the OS one. */
export function applyStoredTheme() {
  applyTheme(readTheme());
}

// A tiny store so every component reading a preference updates together.
const listeners = new Set<() => void>();
let version = 0;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const notify = () => {
  version += 1;
  for (const listener of listeners) listener();
};

export function useThemePreference(): [ThemePreference, (next: ThemePreference) => void] {
  const value = useSyncExternalStore(subscribe, () => `${version}:${readThemeCached()}`, () => '0:system');
  const set = useCallback((next: ThemePreference) => {
    write(THEME_KEY, next);
    memo.theme = next;
    applyTheme(next);
    notify();
  }, []);
  return [value.slice(value.indexOf(':') + 1) as ThemePreference, set];
}

export function useSidebarPreference(): [SidebarMode, (next: SidebarMode) => void] {
  const value = useSyncExternalStore(subscribe, () => `${version}:${readSidebarCached()}`, () => '0:expanded');
  const set = useCallback((next: SidebarMode) => {
    write(SIDEBAR_KEY, next);
    memo.sidebar = next;
    notify();
  }, []);
  return [value.slice(value.indexOf(':') + 1) as SidebarMode, set];
}

// Storage may be unavailable, so the last chosen value is also kept in memory for this page.
const memo: { theme?: ThemePreference; sidebar?: SidebarMode } = {};
const readThemeCached = () => memo.theme ?? readTheme();
const readSidebarCached = () => memo.sidebar ?? readSidebar();

/** Tests only: forget in-memory choices so each test starts from storage. */
export function resetPreferenceMemory() {
  delete memo.theme;
  delete memo.sidebar;
  notify();
}
