import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserStorage, memoryStorage } from '../src';

afterEach(() => vi.unstubAllGlobals());

function fakeLocalStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k: string) => (k in data ? data[k]! : null),
    setItem: (k: string, v: string) => void (data[k] = v),
    removeItem: (k: string) => void delete data[k],
  };
}

describe('workspace storage (non-sensitive, never trusted)', () => {
  it('stores only the slug and a had-session flag', () => {
    const ls = fakeLocalStorage();
    vi.stubGlobal('localStorage', ls);
    const storage = browserStorage();
    storage.setSlug('acme');
    storage.setHadSession(true);
    expect(ls.data).toEqual({ 'bos.workspace': 'acme', 'bos.had-session': '1' });
    storage.clearSlug();
    storage.setHadSession(false);
    expect(ls.data).toEqual({});
  });

  it('ignores a tampered or malformed saved slug', () => {
    vi.stubGlobal('localStorage', fakeLocalStorage({ 'bos.workspace': '../../admin' }));
    expect(browserStorage().getSlug()).toBeNull();
    expect(memoryStorage({ slug: 'NOT VALID' }).getSlug()).toBeNull();
  });

  it('refuses to save a malformed slug', () => {
    const ls = fakeLocalStorage();
    vi.stubGlobal('localStorage', ls);
    browserStorage().setSlug('x y');
    expect(ls.data).toEqual({});
  });

  it('keeps working when storage is blocked or throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    });
    const storage = browserStorage();
    expect(() => { storage.setSlug('acme'); storage.clearSlug(); storage.setHadSession(true); }).not.toThrow();
    expect(storage.getSlug()).toBeNull();
    expect(storage.hadSession()).toBe(false);
  });

  it('works with no storage at all', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(browserStorage().getSlug()).toBeNull();
  });
});
