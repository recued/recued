export interface TextFindMatch { start: number; end: number }

/** Literal Unicode case-insensitive matching, with original UTF-16 offsets.
 * The cap bounds highlights while distinguishing a complete result from more. */
export const findTextMatches = (text: string, query: string, limit = 1000): { matches: TextFindMatch[]; limited: boolean } => {
  const matches: TextFindMatch[] = [];
  if (!query || limit <= 0) return { matches, limited: false };
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  for (const hit of text.matchAll(pattern)) {
    if (matches.length === limit) return { matches, limited: true };
    matches.push({ start: hit.index, end: hit.index + hit[0].length });
  }
  return { matches, limited: false };
};
