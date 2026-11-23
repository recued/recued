export interface SearchTextMatch {
  start: number;
  end: number;
  term: string;
}

const fold = (value: string): string => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Presentation only: the search service still owns matching and ranking.
 * Offsets refer to the original text, preserving case and combining accents. */
export const findSearchTextMatches = (text: string, query: string): SearchTextMatch[] => {
  const terms = [...new Set(fold(query).match(/[\p{L}\p{N}]+/gu) ?? [])];
  if (!terms.length) return [];
  let folded = '', offset = 0;
  const starts: number[] = [], ends: number[] = [];
  for (const point of text) {
    const part = fold(point), end = offset + point.length;
    if (!part && ends.length) ends[ends.length - 1] = end;
    for (let i = 0; i < part.length; i++) { starts.push(offset); ends.push(end); }
    folded += part;
    offset = end;
  }
  // Terms contain only letters and numbers, never regular-expression syntax.
  const pattern = new RegExp(terms.sort((a, b) => b.length - a.length).join('|'), 'gu');
  return Array.from(folded.matchAll(pattern), hit => ({
    start: starts[hit.index]!, end: ends[hit.index + hit[0].length - 1]!, term: hit[0],
  }));
};

/** Prefer more distinct query terms, then the tighter passage. Repeated
 * boilerplate must not hide a later passage containing the rest of the query. */
const bestPassage = (matches: readonly SearchTextMatch[], max: number): { start: number; end: number } => {
  const counts = new Map<string, number>();
  let left = 0, score = 0, best = { start: 0, end: 0 };
  for (const [right, match] of matches.entries()) {
    counts.set(match.term, (counts.get(match.term) ?? 0) + 1);
    while (left < right && match.end - matches[left]!.start > max) {
      const term = matches[left++]!.term, count = counts.get(term)! - 1;
      if (count) counts.set(term, count); else counts.delete(term);
    }
    while (left < right && counts.get(matches[left]!.term)! > 1) {
      const term = matches[left++]!.term;
      counts.set(term, counts.get(term)! - 1);
    }
    const start = matches[left]!.start;
    if (counts.size > score || counts.size === score && match.end - start < best.end - best.start) {
      score = counts.size; best = { start, end: match.end };
    }
  }
  return best;
};

/** Select a bounded passage without markup. A title-only or stemmed match may
 * have no literal occurrence; keep an opening passage in that case. */
export const selectSearchPassage = (body: string, query: string, max = 160): {
  text: string; start: number; end: number; matches: SearchTextMatch[];
} => {
  const text = body.replace(/\s+/gu, ' ').trim();
  const matches = findSearchTextMatches(text, query), passage = bestPassage(matches, max);
  const context = Math.max(0, Math.floor((max - (passage.end - passage.start)) / 2));
  let start = Math.max(0, Math.min(passage.start - context, text.length - max));
  let end = Math.min(text.length, start + max);
  // Trim cut words where there is room, without dropping the chosen match.
  const nextSpace = text.indexOf(' ', start), previousSpace = text.lastIndexOf(' ', end);
  if (start > 0 && nextSpace >= start && nextSpace < passage.start) start = nextSpace + 1;
  if (end < text.length && previousSpace >= passage.end && previousSpace > start) end = previousSpace;
  // A window boundary must not strand half of an emoji or a combining accent.
  while (start > 0 && /\p{M}/u.test(text.charAt(start))) start--;
  while (end < text.length && /\p{M}/u.test(text.charAt(end))) end++;
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(text.charAt(start))) start--;
  if (/[\uDC00-\uDFFF]/u.test(text.charAt(end))) end++;
  return { text, start, end, matches };
};
