/** Recovery-key word codec.
 *
 *  Pure string helpers shared by every UI that touches the 24-slot
 *  recovery-key grid: options/sync import, options/sync pair-recovery,
 *  recovery/setup challenge, recovery/entry prompt, and sidebar's
 *  challenge grid. The 24-word form is the canonical UI shape; the
 *  joined string is the canonical storage/transport shape.
 *
 *  No UI, no state, no deps — just `string <-> string[24]` conversions
 *  and a paste-fanout helper.
 */

/** Split a joined recovery-key string into 24 slot values, padding
 *  with empty strings. A single-field paste can then fan out across
 *  slots via `distributeTokens` below. */
export const toRecoveryWords = (key: string): string[] => {
  const toks = key.split(/\s+/).filter((w) => w.length > 0);
  const out: string[] = [];
  for (let i = 0; i < 24; i++) out.push(toks[i] ?? '');
  return out;
};

/** Rebuild the canonical joined string from the 24 slot values.
 *  Collapses multiple spaces so a half-filled form doesn't round-trip
 *  into a fragile "word  word   word" shape. */
export const fromRecoveryWords = (words: string[]): string =>
  words.map((w) => w.trim()).join(' ').replace(/\s{2,}/g, ' ').trim();

/** Place tokens into `words` starting at `fromIndex`, clamping to 24
 *  total. Returns a new array — existing entries after `fromIndex`
 *  are overwritten for the length of `tokens`. Entries before
 *  `fromIndex` are preserved; entries after the pasted range are
 *  preserved too. Empty tokens are skipped (collapsed whitespace). */
export const distributeTokens = (
  words: string[],
  tokens: string[],
  fromIndex: number,
): string[] => {
  const next = [...words];
  let writeAt = Math.max(0, Math.min(23, fromIndex));
  for (const tok of tokens) {
    const w = tok.trim();
    if (!w) continue;
    if (writeAt >= 24) break;
    next[writeAt] = w;
    writeAt++;
  }
  return next;
};
