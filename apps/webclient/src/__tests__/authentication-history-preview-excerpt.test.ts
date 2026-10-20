import { describe, expect, it, vi } from 'vitest';
import { normalizePreviewSearch, previewMatchedText } from '../connections/authentication-history-preview-excerpt.js';

const marks = (value: ReturnType<typeof previewMatchedText>): string[] => value.highlights.map(range => value.text.slice(range.start, range.end));
const checkOffsets = (value: ReturnType<typeof previewMatchedText>): void => {
  let end = 0;
  for (const range of value.highlights) {
    expect(range.start).toBeGreaterThanOrEqual(end); expect(range.end).toBeGreaterThan(range.start); expect(range.end).toBeLessThanOrEqual(value.text.length);
    expect(value.text.slice(range.start, range.end)).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u); end = range.end;
  }
};

describe('captured history match excerpts', () => {
  it.each(['start', 'middle', 'end'] as const)('shows the first hit at the %s of a long value with bounded nearby saved text', position => {
    const before = position === 'start' ? '' : 'before '.repeat(45); const after = position === 'end' ? '' : ' after'.repeat(45);
    const result = previewMatchedText(before + 'NeEdLe' + after, 'needle', true);
    expect(marks(result)).toEqual(['NeEdLe']); expect(Array.from(result.text).length).toBeLessThanOrEqual(182);
    expect(result.text.startsWith('…')).toBe(position !== 'start'); expect(result.text.endsWith('…')).toBe(position !== 'end'); checkOffsets(result);
    if (position === 'middle') { expect(result.highlights[0]!.start).toBeGreaterThan(50); expect(result.highlights[0]!.end).toBeLessThan(130); }
  });
  it('highlights every visible non-overlapping hit while centering on the first', () => {
    const result = previewMatchedText('x'.repeat(250) + ' Needle, NEEDLE, needle ' + 'z'.repeat(250), 'needle', true);
    expect(marks(result)).toEqual(['Needle', 'NEEDLE', 'needle']); expect(result.text).not.toContain('x'.repeat(180)); checkOffsets(result);
  });
  it.each([
    ['Cafe\u0301', 'CAFÉ', 'Cafe\u0301'], ['oﬃce', 'FFI', 'ﬃ'], ['ＡＢＣ　１２３', 'abc 123', 'ＡＢＣ　１２３'],
    ['İstanbul', 'i\u0307st', 'İst'], ['ΟΣΟΣ', 'ΟΣ', 'ΟΣ'], ['ㄱㅏ', '가', 'ㄱㅏ'], ['a\u0315\u0300b', 'à', 'a\u0315\u0300'],
    ['before 👩‍👩‍👧‍👦 after', '👩', '👩‍👩‍👧‍👦'], ['before 𐐀 after', '𐐨', '𐐀'],
  ])('maps Unicode-equivalent %s back to its original saved characters', (text, query, expected) => {
    expect(normalizePreviewSearch(text)).toContain(normalizePreviewSearch(query)); const result = previewMatchedText(text, query, true);
    expect(result.text).toBe(text); expect(marks(result)).toEqual([expected]); checkOffsets(result);
    if (text === 'ΟΣΟΣ') expect(result.highlights[0]!.start).toBe(2);
  });
  it('merges repeated hits inside a compatibility glyph without duplicating saved characters', () => {
    const result = previewMatchedText('ﬃ', 'f'); expect(result.text).toBe('ﬃ'); expect(marks(result)).toEqual(['ﬃ']); checkOffsets(result);
  });
  it.each([['needleneedle', 'needle', ['needle', 'needle']], ['aaaa', 'a', ['a', 'a', 'a', 'a']], ['ﬃﬃ', 'f', ['ﬃ', 'ﬃ']]] as const)(
    'keeps adjacent source hits in %s separate for navigation without splitting a glyph', (text, query, expected) => {
      for (const excerpt of [true, false]) { const result = previewMatchedText(text, query, excerpt); expect(result.text).toBe(text); expect(marks(result)).toEqual(expected); checkOffsets(result); }
    });
  it('keeps normalized search keys stable when lowercasing introduces a combining mark', () => {
    const text = 'İ\u0f73'; const folded = normalizePreviewSearch(text);
    expect(normalizePreviewSearch(folded)).toBe(folded);
    const result = previewMatchedText(text, folded, true); expect(result.text).toBe(text); expect(marks(result)).toEqual([text]); checkOffsets(result);
  });
  it('uses the point budget when a short hit ends in an oversized combining cluster', () => {
    const result = previewMatchedText('x'.repeat(190) + 'needle' + '\u0315'.repeat(300), 'needle', true);
    expect(result.text).toBe('…needle' + '\u0315'.repeat(174) + '…'); expect(marks(result)).toEqual(['needle' + '\u0315'.repeat(174)]); checkOffsets(result);
  });
  it('preserves literal punctuation, markup, decomposed marks and emoji around a late hit', () => {
    const needle = '<img [100%_].* Cafe\u0301 👩‍👩‍👧‍👦>'; const text = '🚀'.repeat(190) + needle + ' tail';
    const result = previewMatchedText(text, '<img [100%_].* CAFÉ 👩‍👩‍👧‍👦>', true);
    expect(result.text.startsWith('…')).toBe(true); expect(result.text.endsWith(' tail')).toBe(true); expect(marks(result)).toEqual([needle]);
    expect(result.text).not.toContain('\ufffd'); expect(Array.from(result.text).length).toBeLessThanOrEqual(182); checkOffsets(result);
  });
  it.each(['', 'missing'])('keeps unmatched text unmarked for query %s and retains the ordinary prefix excerpt', query => {
    const text = '🚀'.repeat(200); const result = previewMatchedText(text, query, true);
    expect(result.text).toBe('🚀'.repeat(180) + '…'); expect(result.highlights).toEqual([]); expect(previewMatchedText('abc', query).text).toBe('abc');
  });
  it('keeps long original matches bounded even when normalization composes many source code points', () => {
    const result = previewMatchedText('start ' + 'e\u0301'.repeat(128) + ' end', 'é'.repeat(128), true);
    expect(Array.from(result.text).length).toBeLessThanOrEqual(182); expect(marks(result).length).toBe(1); expect(marks(result)[0]).toMatch(/^(?:e\u0301)+$/u); checkOffsets(result);
  });
  it('bounds a single oversized combining cluster without splitting surrogate pairs', () => {
    const result = previewMatchedText('🚀' + '\u0301'.repeat(300), '🚀', true);
    expect(Array.from(result.text).length).toBeLessThanOrEqual(182); expect(result.text).not.toContain('\ufffd'); checkOffsets(result);
  });
  it('keeps original text and valid offsets when the browser has no grapheme segmenter', async () => {
    vi.stubGlobal('Intl', { Segmenter: undefined }); vi.resetModules();
    try {
      const fallback = await import('../connections/authentication-history-preview-excerpt.js');
      for (const [text, query, expected] of [['Cafe\u0301', 'CAFÉ', 'Cafe\u0301'], ['oﬃce', 'ffi', 'ﬃ'], ['🚀'.repeat(190) + 'needle', 'needle', 'needle']]) {
        const result = fallback.previewMatchedText(text!, query!, true); expect(marks(result)).toEqual([expected]); expect(Array.from(result.text).length).toBeLessThanOrEqual(182); checkOffsets(result);
      }
    } finally { vi.unstubAllGlobals(); vi.resetModules(); }
  });
});
