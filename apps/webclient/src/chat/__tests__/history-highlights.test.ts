import { describe, expect, it } from 'vitest';
import { historyHighlightParts } from '../history-highlights.js';

describe('retained-message search highlights', () => {
  it('matches punctuation literally and keeps the exact surrounding text', () => {
    const text = 'Use [a.b] twice: [A.B].';
    const parts = historyHighlightParts(text, '[a.b]');
    expect(parts.filter(part => part.match).map(part => part.text)).toEqual(['[a.b]', '[A.B]']);
    expect(parts.map(part => part.text).join('')).toBe(text);
  });

  it('maps compatibility forms, composed accents, whitespace and case expansion back to whole characters', () => {
    for (const [text, query, expected] of [
      ['Saved ＰＡＳＳＰＯＲＴ 🛂', 'passport', 'ＰＡＳＳＰＯＲＴ'],
      ['A cafe\u0301 note', 'café', 'cafe\u0301'],
      ['Read İ now', 'i', 'İ'],
      ['First\n  second', 'first second', 'First\n  second'],
    ]) {
      const parts = historyHighlightParts(text!, query!);
      expect(parts.filter(part => part.match).map(part => part.text).join('')).toBe(expected);
      expect(parts.map(part => part.text).join('')).toBe(text);
    }
  });

  it('keeps markup as text and bounds work on unknown oversized snippets', () => {
    const text = '<img src=x onerror=alert(1)> needle';
    expect(historyHighlightParts(text, '<img').map(part => part.text).join('')).toBe(text);
    expect(historyHighlightParts('x'.repeat(4097), 'x')).toEqual([{ text: 'x'.repeat(4097), match: false }]);
    expect(historyHighlightParts(text, '  ')).toEqual([{ text, match: false }]);
  });
});
