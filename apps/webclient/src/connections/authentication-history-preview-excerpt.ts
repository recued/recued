// Lowercase can introduce combining marks that need canonical ordering again.
export const normalizePreviewSearch = (value: string): string => value.normalize('NFKC').toLowerCase().normalize('NFKC');
export interface PreviewHighlight { start: number; end: number }
export interface PreviewMatchedText { text: string; highlights: readonly PreviewHighlight[] }
const EXCERPT_POINTS = 180;
let segmenter: Intl.Segmenter | null | undefined;

/** Map folded offsets back to saved text. Compatibility expansion, combining
 * marks and contextual lowercase must not change the text shown to the owner. */
const textMap = (text: string) => {
  if (segmenter === undefined) {
    try { segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' }); } catch { segmenter = null; }
  }
  const chunks = segmenter ? Array.from(segmenter.segment(text), part => part.segment) : text.match(/\P{M}\p{M}*|\p{M}+/gu) ?? [];
  const offsets = [0]; const foldedOffsets = [0]; const foldedChunks: string[] = [];
  for (const chunk of chunks) {
    offsets.push(offsets[offsets.length - 1]! + chunk.length); const folded = normalizePreviewSearch(chunk); foldedChunks.push(folded);
    foldedOffsets.push(foldedOffsets[foldedOffsets.length - 1]! + folded.length);
  }
  const folded = normalizePreviewSearch(text); const direct = foldedChunks.join('') === folded;
  const cache = new Map<number, number>();
  const prefix = (index: number): number => {
    if (direct) return foldedOffsets[index]!;
    let length = cache.get(index);
    if (length === undefined) { length = normalizePreviewSearch(text.slice(0, offsets[index]!)).length; cache.set(index, length); }
    return length;
  };
  const after = (position: number): number => {
    let low = 0; let high = offsets.length;
    while (low < high) { const middle = (low + high) >>> 1; if (prefix(middle) <= position) low = middle + 1; else high = middle; }
    return low;
  };
  const range = (start: number, end: number): PreviewHighlight => {
    const first = Math.max(0, after(start) - 1); let last = Math.max(0, after(end) - 1);
    if (prefix(last) < end) last++;
    return { start: offsets[first]!, end: offsets[Math.min(last, offsets.length - 1)]! };
  };
  return { folded, offsets, range };
};

/** The first hit selects the excerpt. All visible non-overlapping hits are
 * marked; overlapping source ranges from an expanded glyph become one mark. */
export const previewMatchedText = (text: string, query: string, excerpt = false): PreviewMatchedText => {
  const needle = normalizePreviewSearch(query.trim()); const mapped = textMap(text); const first = needle ? mapped.folded.indexOf(needle) : -1;
  const points = Array.from(text); const pointOffsets = [0];
  for (const point of points) pointOffsets.push(pointOffsets[pointOffsets.length - 1]! + point.length);
  let start = 0; let end = text.length;
  if (excerpt && points.length > EXCERPT_POINTS) {
    const firstRange = first >= 0 ? mapped.range(first, first + needle.length) : undefined;
    const hitStart = firstRange ? pointOffsets.indexOf(firstRange.start) : 0; const hitEnd = firstRange ? pointOffsets.indexOf(firstRange.end) : 0;
    const context = Math.floor(Math.max(0, EXCERPT_POINTS - (hitEnd - hitStart)) / 2);
    const pointStart = Math.max(0, Math.min(hitStart - context, points.length - EXCERPT_POINTS));
    start = pointOffsets[pointStart]!; end = pointOffsets[pointStart + EXCERPT_POINTS]!;
    // Prefer whole graphemes at excerpt edges, while keeping the strict point
    // budget. An oversized single cluster still uses code-point-safe clipping.
    const safeStart = mapped.offsets.find(offset => offset >= start && (!firstRange || offset <= firstRange.start));
    let safeEnd: number | undefined;
    for (let index = mapped.offsets.length - 1; index >= 0; index--) {
      const offset = mapped.offsets[index]!; if (offset <= end && (!firstRange || offset > firstRange.start)) { safeEnd = offset; break; }
    }
    if (safeStart !== undefined) start = safeStart;
    if (safeEnd !== undefined && safeEnd > start && (!firstRange || safeEnd >= Math.min(end, firstRange.end))) end = safeEnd;
  }
  const leading = start > 0 ? '…' : ''; const output = leading + text.slice(start, end) + (end < text.length ? '…' : '');
  const highlights: PreviewHighlight[] = [];
  if (first >= 0) for (let at = first; at >= 0; at = mapped.folded.indexOf(needle, at + needle.length)) {
    const range = mapped.range(at, at + needle.length); if (range.start >= end) break;
    const from = Math.max(start, range.start); const through = Math.min(end, range.end); if (through <= from) continue;
    const next = { start: leading.length + from - start, end: leading.length + through - start }; const previous = highlights[highlights.length - 1];
    if (previous && previous.end > next.start) previous.end = Math.max(previous.end, next.end); else highlights.push(next);
  }
  return { text: output, highlights };
};
