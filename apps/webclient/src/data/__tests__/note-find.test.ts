import { describe, expect, it } from 'vitest';
import { findNoteMatches } from '../note-find.js';

describe('Note find matching', () => {
  it('finds literal punctuation rather than interpreting the query as a regular expression', () => {
    const text = 'Use [a.*] then [A.*], a plain word, and a/b?';
    expect(findNoteMatches(text, '[a.*]').matches.map(match => text.slice(match.start, match.end))).toEqual(['[a.*]', '[A.*]']);
    expect(findNoteMatches(text, 'a/b?').matches.map(match => text.slice(match.start, match.end))).toEqual(['a/b?']);
    expect(findNoteMatches(text, '^$(){}+|\\').matches).toEqual([]);
  });

  it('keeps original UTF-16 offsets when text includes emoji and characters with expanding lowercase forms', () => {
    const text = 'İ 😀 Café CAFÉ and 😀.';
    expect(findNoteMatches(text, 'café').matches.map(match => text.slice(match.start, match.end))).toEqual(['Café', 'CAFÉ']);
    expect(findNoteMatches(text, '😀').matches.map(match => text.slice(match.start, match.end))).toEqual(['😀', '😀']);
    expect(findNoteMatches('aaaa', 'aa').matches).toEqual([{ start: 0, end: 2 }, { start: 2, end: 4 }]);
  });

  it('distinguishes an exact cap from an incomplete result and keeps empty searches empty', () => {
    expect(findNoteMatches('word word word', 'word', 3)).toMatchObject({ limited: false, matches: [{ start: 0, end: 4 }, { start: 5, end: 9 }, { start: 10, end: 14 }] });
    const result = findNoteMatches('word '.repeat(1001), 'word');
    expect(result.limited).toBe(true); expect(result.matches).toHaveLength(1000);
    expect(result.matches.at(-1)).toEqual({ start: 4995, end: 4999 });
    expect(findNoteMatches('a real note', '')).toEqual({ matches: [], limited: false });
  });
});
