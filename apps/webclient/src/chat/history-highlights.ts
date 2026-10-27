/** Literal search emphasis, with offsets mapped back to the original text.
 * Prefix normalization handles case expansions and composed Unicode without
 * splitting a code point. Snippets are bounded; unknown large bodies stay plain. */
export const historyHighlightParts = (text: string, query: string): Array<{ text: string; match: boolean }> => {
  const normalize = (value: string) => value.normalize('NFKC').replace(/\s+/gu, ' ').toLowerCase();
  const needle = normalize(query.trim());
  if (!needle || text.length > 4096) return [{ text, match: false }];
  const haystack = normalize(text);
  const boundaries: Array<{ original: number; folded: number }> = [{ original: 0, folded: 0 }];
  let original = 0;
  for (const point of text) {
    original += point.length;
    boundaries.push({ original, folded: normalize(text.slice(0, original)).length });
  }
  const parts: Array<{ text: string; match: boolean }> = [];
  let cursor = 0;
  let searchFrom = 0;
  for (;;) {
    const at = haystack.indexOf(needle, searchFrom);
    if (at < 0) break;
    const end = at + needle.length;
    const from = boundaries.filter(point => point.folded <= at).at(-1)?.original ?? 0;
    const last = boundaries.find(point => point.folded >= end)?.folded;
    const to = boundaries.filter(point => point.folded === last).at(-1)?.original ?? text.length;
    if (to > from && from >= cursor) {
      if (from > cursor) parts.push({ text: text.slice(cursor, from), match: false });
      parts.push({ text: text.slice(from, to), match: true });
      cursor = to;
    }
    searchFrom = end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), match: false });
  return parts.length ? parts : [{ text, match: false }];
};

export const appendHistoryHighlights = (doc: Document, host: HTMLElement, text: string, query: string): void => {
  for (const part of historyHighlightParts(text, query)) {
    if (!part.match) host.appendChild(doc.createTextNode(part.text));
    else { const mark = doc.createElement('mark'); mark.textContent = part.text; host.appendChild(mark); }
  }
};
