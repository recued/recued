/** Chat answer text, with its record citations made clickable.
 *
 *  A work investigation cites each claim as a Markdown link to the exact
 *  `source_url` a mail tool returned (`#data/mail/record/<slug>/<id>`). Chat
 *  paints plain text, so owners saw the raw `[claim](#data/…)` and could not
 *  open the message it cited.
 *
 *  ⛔ ONE SHAPE ONLY, AND NEVER HTML. `[label](#target)` becomes a link only
 *  when the webclient's own route parser reads `#target` as a record address.
 *  Everything else stays literal text: external and script URLs, other in-app
 *  routes, malformed targets, nested or escaped brackets. The label is set as
 *  text, so markup inside it is shown and never parsed. The answer comes from
 *  a model that read mail other people wrote; it must not choose where a link
 *  leads beyond a record in this app. */
import { parseShellRoute, parseSourceRecordAddress } from '../shell/route.js';

export type AnswerTextSegment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'link'; readonly label: string; readonly href: string };

/** A one-line label without brackets, then a fragment with no whitespace,
 *  brackets, parentheses, quotes or angle brackets. The server percent-encodes
 *  parentheses in `source_url` so the address cannot end a link early. */
const RECORD_LINK = /\[([^[\]\n]+)\]\((#[^\s()[\]<>"'`]+)\)/gu;

export const answerTextSegments = (text: string): AnswerTextSegment[] => {
  const segments: AnswerTextSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(RECORD_LINK)) {
    const whole = match[0];
    const label = match[1] ?? '';
    const href = match[2] ?? '';
    const start = match.index ?? 0;
    // `\[` is a literal bracket in Markdown, not the start of a link.
    if (text[start - 1] === '\\' || label.trim().length === 0) continue;
    if (parseSourceRecordAddress(parseShellRoute(href)) === null) continue;
    if (start > cursor) segments.push({ kind: 'text', text: text.slice(cursor, start) });
    segments.push({ kind: 'link', label, href });
    cursor = start + whole.length;
  }
  if (cursor < text.length) segments.push({ kind: 'text', text: text.slice(cursor) });
  return segments;
};

/** Paint answer text into `host`. Text without a citation is assigned exactly
 *  as before, one text node; a citation becomes an in-app `<a>`. */
export const renderAnswerText = (
  doc: Document,
  host: HTMLElement,
  text: string,
): void => {
  const segments = answerTextSegments(text);
  if (!segments.some((segment) => segment.kind === 'link')) {
    host.textContent = text;
    return;
  }
  while (host.firstChild) host.removeChild(host.firstChild);
  for (const segment of segments) {
    if (segment.kind === 'text') {
      host.appendChild(doc.createTextNode(segment.text));
      continue;
    }
    const link = doc.createElement('a');
    link.setAttribute('href', segment.href);
    link.textContent = segment.label;
    host.appendChild(link);
  }
};
