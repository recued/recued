import { describe, expect, it, vi } from 'vitest';
import { FILE_PREVIEW_TEXT_CHARACTERS } from '@recued/contracts';
import { buildPdfText, createPdfSearch, findPdfMatches, type PdfSearchPage } from '../files/pdf-search.js';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const page = (text: string): PdfSearchPage => ({ text, truncated: false });
const defaults = { changed: () => {}, selected: () => {}, yieldPage: async () => {} };

describe('PDF search text', () => {
  it('finds phrases across font runs and line breaks without inserting spaces into words', () => {
    const model = buildPdfText([{ str: 'rene' }, { str: 'wal', hasEOL: true }, { str: 'deadline' }]);
    expect(model.text).toBe('renewal\ndeadline');
    const matches = findPdfMatches(model.text, 'RENEWAL deadline', 10);
    expect(matches.map(match => model.text.slice(match.start, match.end))).toEqual(['renewal\ndeadline']);
  });

  it('maps canonical Unicode and compatibility expansions back to the original text', () => {
    const text = '😀 Cafe\u0301 \nﬁle 😀';
    expect(findPdfMatches(text, 'CAFÉ file', 10).map(match => text.slice(match.start, match.end))).toEqual(['Cafe\u0301 \nﬁle']);
    const markup = '<img.*> <img.*>';
    expect(findPdfMatches(markup, '<img.*>', 10).map(match => markup.slice(match.start, match.end))).toEqual(['<img.*>', '<img.*>']);
    const greek = 'ΟΣ ος Οσ';
    expect(findPdfMatches(greek, 'ΟΣ', 10).map(match => greek.slice(match.start, match.end))).toEqual(['ΟΣ', 'ος', 'Οσ']);
  });

  it('bounds page text without stranding an emoji or altering the source text runs', () => {
    const str = 'x'.repeat(FILE_PREVIEW_TEXT_CHARACTERS - 1) + '😀 tail', source = [{ str }];
    const model = buildPdfText(source);
    expect(model.truncated).toBe(true);
    expect(model.text).toHaveLength(FILE_PREVIEW_TEXT_CHARACTERS - 1);
    expect(source[0]!.str).toBe(str);
    expect(model.text).not.toMatch(/[\uD800-\uDFFF]/u);
  });

  it('remains usable in browsers without Intl.Segmenter, preserving combining-mark offsets', async () => {
    vi.stubGlobal('Intl', new Proxy(Intl, { get: (target, key) => key === 'Segmenter' ? undefined : Reflect.get(target, key) }));
    vi.resetModules();
    try {
      const { findPdfMatches: fallback } = await import('../files/pdf-search.js');
      const text = '😀 Cafe\u0301 ﬁle';
      expect(fallback(text, 'CAFÉ file', 10).map(match => text.slice(match.start, match.end))).toEqual(['Cafe\u0301 ﬁle']);
    } finally { vi.unstubAllGlobals(); vi.resetModules(); }
  });
});

describe('PDF search ownership and coverage', () => {
  it('counts occurrences across pages and wraps selection in both directions', async () => {
    const selected = vi.fn();
    const search = createPdfSearch({ ...defaults, total: 3, selected,
      read: async number => page(number === 2 ? 'No matching word.' : 'Renewal and renewal.') });
    search.setQuery('renewal'); await search.start();
    expect(search.state()).toMatchObject({ phase: 'done', searched: 3, textPages: 3, limited: false });
    expect(search.state().matches.map(match => match.page)).toEqual([1, 1, 3, 3]);
    search.previous(); expect(selected.mock.lastCall?.[0].page).toBe(3);
    search.next(); expect(search.state().active).toBe(0);
    search.previous(); expect(search.state().active).toBe(3);
  });

  it('retires an old reply even when the query changes away and back before the reply arrives', async () => {
    const old = deferred<PdfSearchPage>(); let first = true;
    const search = createPdfSearch({ ...defaults, total: 1, read: () => { if (first) { first = false; return old.promise; } return Promise.resolve(page('alpha current')); } });
    search.setQuery('alpha'); const pending = search.start();
    search.setQuery('beta'); search.setQuery('alpha');
    old.resolve(page('alpha retired')); await pending;
    expect(search.state()).toMatchObject({ query: 'alpha', phase: 'idle', matches: [] });
    await search.start(); expect(search.state().matches).toHaveLength(1);
  });

  it('stops with partial results and ignores the page that finishes after stopping', async () => {
    const second = deferred<PdfSearchPage>(), reached = deferred<void>();
    const search = createPdfSearch({ ...defaults, total: 2, read: number => {
      if (number === 1) return Promise.resolve(page('renewal'));
      reached.resolve(); return second.promise;
    } });
    search.setQuery('renewal'); const pending = search.start(); await reached.promise;
    search.stop(); second.resolve(page('renewal')); await pending;
    expect(search.state()).toMatchObject({ phase: 'stopped', searched: 1 });
    expect(search.state().matches.map(match => match.page)).toEqual([1]);
  });

  it('publishes nothing after the preview is disposed', async () => {
    const pending = deferred<PdfSearchPage>(), changed = vi.fn();
    const search = createPdfSearch({ ...defaults, total: 1, changed, read: () => pending.promise });
    search.setQuery('renewal'); const running = search.start(); search.dispose(); changed.mockClear();
    pending.resolve(page('renewal')); await running;
    expect(changed).not.toHaveBeenCalled();
  });

  it('keeps successful results while exposing unreadable pages and search limits', async () => {
    const search = createPdfSearch({ ...defaults, total: 4, limits: { pages: 3 }, read: async number => {
      if (number === 2) throw new Error('Unreadable page');
      return page('renewal');
    } });
    search.setQuery('renewal'); await search.start();
    expect(search.state()).toMatchObject({ phase: 'done', searched: 3, unreadable: 1, limited: true });
    expect(search.state().matches.map(match => match.page)).toEqual([1, 3]);
  });

  it('does not claim partial coverage when the complete document exactly fits the text budget', async () => {
    const search = createPdfSearch({ ...defaults, total: 1, limits: { characters: 5 }, read: async () => page('alpha') });
    search.setQuery('alpha'); await search.start();
    expect(search.state()).toMatchObject({ phase: 'done', searched: 1, limited: false });
    expect(search.state().matches).toHaveLength(1);
  });

  it('reports partial coverage when occurrences or text exceed the budget', async () => {
    for (const limits of [{ matches: 1 }, { characters: 6 }]) {
      const search = createPdfSearch({ ...defaults, total: 1, limits, read: async () => page('alpha alpha') });
      search.setQuery('alpha'); await search.start();
      expect(search.state()).toMatchObject({ phase: 'done', searched: 1, limited: true });
      expect(search.state().matches).toEqual([{ page: 1, start: 0, end: 5 }]);
    }
  });
});
