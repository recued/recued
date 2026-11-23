import { describe, expect, it } from 'vitest';
import { createRecentSearches, type RecentSearchStorage } from '../recent-searches.js';

const memory = () => {
  const data = new Map<string, string>();
  const storage: RecentSearchStorage = { getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); }, removeItem: key => { data.delete(key); } };
  return { data, storage };
};

describe('Recent searches', () => {
  it('keeps five distinct trimmed queries in recency order and reruns promote their current spelling', () => {
    const { storage } = memory(); const recent = createRecentSearches({ scope: 'work', storage });
    for (const query of ['one', 'two', 'three', 'four', 'five', 'six', '  THREE  ']) recent.remember(query);
    expect(recent.list()).toEqual(['THREE', 'six', 'five', 'four', 'two']);
    for (const invalid of ['', '  ', 'a'.repeat(2049), 'query\u0000tail']) recent.remember(invalid);
    expect(createRecentSearches({ scope: 'work', storage }).list()).toEqual(recent.list());
    const snapshot = recent.list() as string[]; snapshot.length = 0;
    expect(recent.list()).toHaveLength(5);
  });

  it('separates pairing scopes, persists individual removal, and clears only the selected history', () => {
    const { data, storage } = memory();
    const office = createRecentSearches({ scope: 'office/pair-1', storage });
    const home = createRecentSearches({ scope: 'home/pair-1', storage });
    office.remember('customer'); office.remember('launch'); home.remember('holiday');
    expect(office.remove('launch')).toBe(true);
    expect(createRecentSearches({ scope: 'office/pair-1', storage }).list()).toEqual(['customer']);
    expect(createRecentSearches({ scope: 'office/pair-2', storage }).list()).toEqual([]);
    expect(office.clear()).toBe(true);
    expect(createRecentSearches({ scope: 'office/pair-1', storage }).list()).toEqual([]);
    expect(home.list()).toEqual(['holiday']);
    expect([...data.values()]).toEqual(['["holiday"]']);
  });

  it('bounds and validates stored content without letting malformed history prevent searching', () => {
    const { data, storage } = memory();
    const recent = createRecentSearches({ scope: 'work', storage }); recent.remember('initial');
    const key = [...data.keys()][0]!;
    data.set(key, JSON.stringify(['valid', {}, 'VALID', 'bad\u0000query', ...Array.from({ length: 20 }, (_, i) => `search ${i}`)]));
    expect(createRecentSearches({ scope: 'work', storage }).list()).toEqual(['valid', 'search 0', 'search 1', 'search 2', 'search 3']);
    for (const raw of ['{broken', '{}', 'x'.repeat(65_537)]) {
      data.set(key, raw); const restored = createRecentSearches({ scope: 'work', storage });
      expect(restored.list()).toEqual([]); restored.remember('new query');
      expect(restored.list()).toEqual(['new query']);
    }
  });

  it('retains retryable removal after storage fails and supports an in-memory session', () => {
    const { storage } = memory(); let fail = false;
    const recent = createRecentSearches({ scope: 'work', storage: { ...storage,
      setItem: (key, value) => { if (fail) throw new Error('Storage blocked'); storage.setItem(key, value); },
      removeItem: key => { if (fail) throw new Error('Storage blocked'); storage.removeItem(key); } } });
    recent.remember('first'); recent.remember('second'); fail = true;
    expect(recent.remove('second')).toBe(false); expect(recent.clear()).toBe(false);
    expect(recent.list()).toEqual(['second', 'first']);
    fail = false; expect(recent.clear()).toBe(true); expect(recent.list()).toEqual([]);
    const transient = createRecentSearches({ scope: 'work', storage: null }); transient.remember('private question');
    expect(transient.list()).toEqual(['private question']); expect(transient.clear()).toBe(true);
  });
});
