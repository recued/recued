/** How an approval's "what will happen" rows name a field (D-270).
 *
 *  Moved here from the shared approval card (2026-10-10) because the server now
 *  names fields inside a row's VALUE too: the card's `Not set` and `Empty` rows
 *  list the fields that carry nothing, and a row's value is final display text
 *  that no client rewrites. One rule, so a field reads the same as a row's label
 *  and inside one of those lists. */

/** An arg key as words: `in_reply_to` → "In reply to". The `metadata.` prefix is
 *  producer bookkeeping and is dropped. */
export const humanizeAskField = (key: string): string => {
  const withoutMetadata = key.replace(/^metadata\./, '');
  const words = withoutMetadata.replace(/[._-]+/g, ' ');
  return words.charAt(0).toLocaleUpperCase() + words.slice(1);
};

/** The label a D-270 detail row is shown under, on every surface that shows one.
 *  A pack-declared label stands as written; the raw arg key a server falls back
 *  to is humanized. ⚠ ONLY an identifier-shaped label: humanizing splits on
 *  `[._-]`, which would mangle a real label like "e-mail" into "E mail". Shared
 *  so the Approvals card and the top-bar tray cannot name one value two ways. */
export const askDetailLabel = (label: string): string =>
  /^[a-z][a-z0-9._]*$/.test(label) ? humanizeAskField(label) : label;
