import { useSyncExternalStore } from 'react';

/**
 * How much room the window gives a Zone. Drives which information is shown as columns and which
 * moves under the name, so nothing is ever dropped (it only moves). Measured on the viewport so a
 * resized desktop window re-lays-out live.
 *  - wide (>= 1024px): full table
 *  - medium (640-1023px): fewer columns, type and location under the name
 *  - narrow (< 640px): a compact record list instead of a table
 */
export type Layout = 'wide' | 'medium' | 'narrow';

const WIDE = '(min-width: 1024px)';
const MEDIUM = '(min-width: 640px)';

function subscribe(onChange: () => void) {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const lists = [window.matchMedia(WIDE), window.matchMedia(MEDIUM)];
  for (const list of lists) list.addEventListener('change', onChange);
  return () => {
    for (const list of lists) list.removeEventListener('change', onChange);
  };
}

function read(): Layout {
  if (typeof window === 'undefined' || !window.matchMedia) return 'wide';
  if (window.matchMedia(WIDE).matches) return 'wide';
  return window.matchMedia(MEDIUM).matches ? 'medium' : 'narrow';
}

export function useLayout(): Layout {
  return useSyncExternalStore(subscribe, read, () => 'wide');
}
