/** ⛔⛔ A BYTE BUDGET CUT WITH `String.slice` IS NOT A BUDGET.
 *
 *  `slice` counts UTF-16 code units; every `MAX_*_BYTES` in this tree counts
 *  UTF-8 bytes. The two agree only for ASCII, and the check is usually written
 *  correctly — `Buffer.byteLength(s) > CAP` — so the guard fires at the right
 *  moment and then cuts in the wrong unit. Measured against a 64 KB cap:
 *
 *      ascii         65,536 bytes   1.00x
 *      accented é   131,072 bytes   2.00x
 *      emoji 😀     131,072 bytes   2.00x
 *      CJK 中       196,608 bytes   3.00x
 *
 *  ⛔ AND THE ELLIPSIS IS THREE BYTES, NOT ONE. `s.slice(0, CAP - 1) + '…'`
 *  reads as "leave room for the marker" and overshoots a 1 KB cap by two bytes
 *  on PURE ASCII, before any multi-byte input is involved. `…` is U+2026:
 *  one code unit, three UTF-8 bytes. Budget the marker by its ENCODED size or
 *  do not budget it at all.
 *
 *  ⚠ `slice` also cuts between the halves of a surrogate pair whenever the
 *  offset lands mid-pair, leaving a lone surrogate that the next UTF-8 encoder
 *  turns into U+FFFD. The functions here cut on a code-point boundary, so a
 *  character is either wholly kept or wholly dropped.
 *
 *  🔑 The sibling rule, from `chat-context-slice.ts`: *"A safety limit that is
 *  only approximately respected is not one."* */

/** UTF-8 byte length of a string. Mirrors `Buffer.byteLength(s, 'utf8')`
 *  without pulling Node `Buffer` into contracts, which is dep-free and runs in
 *  browsers. */
export const byteLengthUtf8 = (s: string): number =>
  new TextEncoder().encode(s).length;

/** `text` cut to at most `maxBytes` UTF-8 bytes, on a code-point boundary.
 *
 *  Encodes once and backs the cut off any continuation byte (`10xxxxxx`), which
 *  is at most three steps — rather than re-encoding per character, which turns
 *  a 100 KB body into 100k encoder calls. Returns `''` for a non-positive
 *  budget, and `text` unchanged when it already fits. */
export const truncateUtf8 = (text: string, maxBytes: number): string => {
  if (maxBytes <= 0 || text.length === 0) return '';
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  // A continuation byte at `end` means the code point starting before it is
  // only half-included; drop back to its lead byte.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return new TextDecoder().decode(bytes.subarray(0, end));
};

/** `text` cut to at most `maxBytes` UTF-8 bytes INCLUDING `marker`'s own bytes,
 *  with `marker` appended when anything was dropped.
 *
 *  ⚠ THE TOTAL IS WHAT IS BOUNDED. The caller asked for a budget; a result that
 *  is the budget plus a marker is over it, which is the bug this replaces.
 *  When the marker alone cannot fit, the marker itself is cut — the budget wins
 *  over the decoration. */
export const truncateUtf8WithMarker = (
  text: string,
  maxBytes: number,
  marker = '…',
): string => {
  if (maxBytes <= 0) return '';
  if (byteLengthUtf8(text) <= maxBytes) return text;
  const markerBytes = byteLengthUtf8(marker);
  if (markerBytes >= maxBytes) return truncateUtf8(marker, maxBytes);
  return truncateUtf8(text, maxBytes - markerBytes) + marker;
};
