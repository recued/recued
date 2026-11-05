/** D-338 §11 — a notification's text with the names it links in the app.
 *
 *  The server sends the text and, beside it, the records its words name (`mentions`: a
 *  birthday's name and its contact). Each name, found in order, becomes a link to where that
 *  record opens; the rest stays text. Built from DOM nodes, never parsed as HTML, so a name is
 *  never markup. A name the text does not hold is passed over, and a client before it shows
 *  the text alone. */

export interface TextMention {
  text: string;
  ref: { collection: string; id: string };
}

/** The mentions a frame or a stored run carries, or none when it carries anything else. */
export const safeMentions = (value: unknown): TextMention[] | undefined => {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) return undefined;
  const mentions = value.filter((entry): entry is TextMention => {
    const mention = entry as Partial<TextMention> | null;
    return typeof mention?.text === 'string' && mention.text.length > 0 && mention.text.length <= 200
      && typeof mention.ref?.collection === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(mention.ref.collection)
      && typeof mention.ref.id === 'string' && mention.ref.id.length > 0 && mention.ref.id.length <= 2000;
  });
  return mentions.length ? mentions : undefined;
};

/** Set `element` to `text`, each mention's words a link to `hrefOf(its ref)`. With no mention
 *  the text holds, it is exactly `textContent = text`, as before mentions. */
export const setTextWithMentions = (
  doc: Document,
  element: Node & { textContent: string | null },
  text: string,
  mentions: readonly TextMention[] | undefined,
  hrefOf: (ref: TextMention['ref']) => string,
): void => {
  const parts: Array<string | TextMention> = [];
  let at = 0;
  for (const mention of mentions ?? []) {
    const found = text.indexOf(mention.text, at);
    if (found < 0) continue;
    if (found > at) parts.push(text.slice(at, found));
    parts.push(mention);
    at = found + mention.text.length;
  }
  if (!parts.some(part => typeof part !== 'string')) { element.textContent = text; return; }
  if (at < text.length) parts.push(text.slice(at));
  element.textContent = '';
  for (const part of parts) {
    if (typeof part === 'string') { element.appendChild(doc.createTextNode(part)); continue; }
    const link = doc.createElement('a');
    link.setAttribute('href', hrefOf(part.ref));
    link.setAttribute('data-recued-mention', part.ref.collection);
    link.textContent = part.text;
    element.appendChild(link);
  }
};
