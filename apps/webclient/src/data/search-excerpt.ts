import { findSearchTextMatches, selectSearchPassage, type SearchTextMatch } from '@recued/contracts';
import { e } from '@recued/ui-shared';

const renderPassage = (text: string, matches: readonly SearchTextMatch[], start: number, end: number): string => {
  let html = '', cursor = start;
  for (const match of matches) {
    if (match.end <= cursor) continue;
    if (match.start >= end) break;
    const from = Math.max(cursor, match.start), to = Math.min(end, match.end);
    html += e(text.slice(cursor, from)) + `<mark>${e(text.slice(from, to))}</mark>`;
    cursor = to;
  }
  return html + e(text.slice(cursor, end));
};

/** Highlight a server-selected title or excerpt without truncating it again. */
export const renderSearchHighlights = (text: string, query: string): string =>
  renderPassage(text, findSearchTextMatches(text, query), 0, text.length);

/** A bounded, escaped relevance preview. It never replaces the source record
 * opened through the row's existing destination. */
export const renderSearchExcerpt = (body: string, query: string, truncated = false, max = 160): string => {
  const { text, matches, start, end } = selectSearchPassage(body, query, max);
  if (!text) return '';
  return (start > 0 ? '…' : '') + renderPassage(text, matches, start, end)
    + (end < text.length || truncated ? '…' : '');
};
