/** D-318 — what the HTML of an email request shows as the owner's own part:
 *  the quoted history and the signature left out, the owner's text as lines.
 *
 *  ⛔ THE HTML IS THE BETTER SOURCE OF THE OWNER'S WORDS WHEN THERE IS ONE. A
 *  mail app marks its signature and its quoted history in the HTML (Gmail's
 *  `gmail_signature` / `gmail_quote`, Outlook's `divRplyFwdMsg`, Apple Mail's
 *  `AppleMailSignature`, Thunderbird's `moz-signature`), while its plain text
 *  often marks nothing — an Outlook or Apple Mail signature has no `-- ` line.
 *  And the Microsoft (Graph) sync keeps no plain text at all: it stores the
 *  HTML with its tags stripped, on one line, where no line-based reading finds
 *  a quote, a signature or a footer (found by the D-318 audit: every word of an
 *  Outlook reply, the quoted email and the signature's phone number included,
 *  reached the model as the owner's).
 *
 *  Two shapes of quoted history, read differently:
 *  - **A container** (`<blockquote>`, Gmail's `gmail_quote`, Thunderbird's
 *    "On … wrote:" line) holds the quote and nothing else. A reply's are
 *    removed wherever they are, so an owner who answers below the quote, or
 *    between its parts, keeps those words.
 *  - **A divider** (Outlook's, or the head the mail parser writes above an
 *    attached email) has the original after it, to the end, in no container:
 *    the owner's part ends there, as it does at a signature.
 *
 *  ⛔ A FORWARD ENDS AT ITS FIRST CONTAINER. Nothing of the owner's follows the
 *  mail they forward, and that mail may itself quote: removing only its quotes
 *  would leave the forwarded email's own words as the owner's.
 *
 *  ⛔ LINEAR TIME, ON MAIL FROM ANYONE. The door reads an email's HTML as it
 *  lands, before the proof says whose it is, so a stranger chooses it. Every
 *  pattern here keeps inside one tag (`[^<>]`, never `[^>]`) and bounds what it
 *  repeats, each is searched forward only, however many containers there are,
 *  and only the first `MAIL_CHAT_HTML_MAX` characters are read: the audit
 *  measured the first cut of these patterns at 37 s for 320 KB.
 *
 *  Spec: D-318 §4.4, §8 steps 4, the audit and §8.12. */

/** How much of an email's HTML is read. A longer email's own part is in its
 *  first half-megabyte, as its signature and quote markers are. */
export const MAIL_CHAT_HTML_MAX = 512 * 1024;

/** Where a signature begins: Gmail, Outlook (on the web and on the desktop),
 *  Apple Mail on iOS, Thunderbird, Proton and others name it; a `-- ` line marks
 *  one too. Nothing of the owner's follows it. */
export const MAIL_CHAT_SIGNATURE_START: readonly RegExp[] = [
  /<[a-z][a-z0-9]{0,15}\b[^<>]{0,2000}?\b(?:class|id)\s*=\s*["']?[^"'<>]{0,200}?signature/i,
  /<a\s[^<>]{0,2000}?\bname\s*=\s*["']?_MailAutoSig/i,
  /(?<=^|>|\n)[ \t]{0,20}--(?:[ \t]|&nbsp;)?[ \t]{0,20}<br\s{0,5}\/?>/i,
];

/** The quoted history's containers: Gmail's `gmail_quote` (its "On … wrote:"
 *  line and the quote), any `<blockquote>` (Gmail's, Apple Mail's,
 *  Thunderbird's, Zoho's `blockquote_zmail`, …), and Thunderbird's "On …
 *  wrote:" line above its blockquote. Each ends where its tag closes. */
export const MAIL_CHAT_QUOTE_CONTAINERS: readonly { readonly start: RegExp; readonly tag: 'div' | 'blockquote' }[] = [
  { start: /<div\b[^<>]{0,2000}?\bclass\s*=\s*["']?[^"'<>]{0,200}?\bgmail_quote/i, tag: 'div' },
  { start: /<blockquote\b/i, tag: 'blockquote' },
  { start: /<div\b[^<>]{0,2000}?\bclass\s*=\s*["']?[^"'<>]{0,200}?\bmoz-cite-prefix/i, tag: 'div' },
];

/** Where quoted history begins that runs to the end: Outlook writes a divider
 *  and a header block, then the original, in no container. */
export const MAIL_CHAT_QUOTE_START: readonly RegExp[] = [
  /<div\b[^<>]{0,2000}?\bid\s*=\s*["']?(?:appendonsend|divRplyFwdMsg|mail-editor-reference-message-container)/i,
  /<div\b[^<>]{0,2000}?border-top:\s*solid\s*#E1E1E1/i,
  /<hr\b/i,
];

/** Where the mail parser wrote an attached email into the HTML: an email sent
 *  inline as a `message/rfc822` part is no attachment to it, and it writes that
 *  email's From, Subject and Date as a `mp_head` table, then its text — with
 *  no marker any mail app writes. Everything after it is that email. */
export const MAIL_CHAT_EMBEDDED_START = /<table\b[^<>]{0,2000}?\bclass\s*=\s*["']?mp_head\b/i;

/** What the HTML's own part left out, by the words it left out:
 *  - `mail` — an attached email the mail parser wrote into it: mail, even in a
 *    conversation;
 *  - `quote` — quoted history, or what a forward forwards: the conversation
 *    itself when it continues, else mail;
 *  - `signature` — a signature, and nothing after it that is marked as quoted;
 *  - `none` — no words. */
export type MailChatHtmlCut = 'none' | 'signature' | 'quote' | 'mail';

/** The HTML read, at most `MAIL_CHAT_HTML_MAX` characters of it. */
export const mailChatHtmlRead = (html: string): string =>
  html.length > MAIL_CHAT_HTML_MAX ? html.slice(0, MAIL_CHAT_HTML_MAX) : html;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'",
  ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  euro: '€', pound: '£', copy: '©', reg: '®', bull: '•', middot: '·',
};

const decodeEntities = (text: string): string =>
  text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8}|#39);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
  });

/** Remove every span from an opening to its closing text, the rest of the HTML
 *  when one is never closed. A loop of `indexOf`, so an opening with no closing,
 *  repeated, stays linear — a lazy `[\s\S]*?` would rescan to the end each time. */
const removeSpans = (html: string, open: RegExp, close: string): string => {
  const lower = html.toLowerCase();
  let out = '';
  let from = 0;
  const opening = new RegExp(open.source, 'gi');
  for (let match = opening.exec(html); match !== null; match = opening.exec(html)) {
    if (match.index < from) continue;
    out += html.slice(from, match.index);
    const closing = lower.indexOf(close, match.index + match[0].length);
    // `</style` ends at its `>`; `-->` already includes it.
    const end = closing === -1 ? -1 : close.endsWith('>') ? closing + close.length - 1 : html.indexOf('>', closing);
    from = end === -1 ? html.length : end + 1;
    opening.lastIndex = from;
  }
  return out + html.slice(from);
};

/** The HTML a reader shows: at most `MAIL_CHAT_HTML_MAX` characters, without
 *  its comments, styles, scripts and title. Not without its `<head>`: HTML may
 *  leave `</head>` out, and the rest of the email would go with it. */
export const mailChatHtmlReadable = (html: string): string => {
  let read = removeSpans(mailChatHtmlRead(html), /<!--/, '-->');
  for (const name of ['style', 'script', 'title']) {
    read = removeSpans(read, new RegExp(`<${name}\\b`), `</${name}`);
  }
  return read;
};

/** HTML to text, a line where the HTML breaks one: `<br>`, and the end of a
 *  paragraph, a block or a list item. */
export const mailChatHtmlToText = (html: string): string => {
  const text = mailChatHtmlReadable(html)
    .replace(/<br\b[^<>]*>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|h[1-6]|blockquote|table|ul|ol|pre|section|article|header|footer)\s*>/gi, '\n')
    .replace(/<li\b[^<>]*>/gi, '\n')
    .replace(/<[^<>]*>/g, '');
  return decodeEntities(text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

const hasWords = (html: string): boolean => mailChatHtmlToText(html).length > 0;

/** The next match of a pattern at or after a position that only grows: the
 *  pattern is searched again only once the position passes its last match, so
 *  it reads the HTML once, however many containers are removed. */
const nextMatch = (html: string, pattern: RegExp): ((from: number) => number) => {
  const search = new RegExp(pattern.source, 'gi');
  let found = -1;
  let searched = false;
  return (from) => {
    if (searched && (found === -1 || found >= from)) return found;
    search.lastIndex = from;
    found = search.exec(html)?.index ?? -1;
    searched = true;
    return found;
  };
};

/** Where the container opening at `at` ends: after the close of its tag that
 *  the containers of that tag nested in it leave; the end when it never closes. */
const containerEnd = (html: string, at: number, tag: string): number => {
  const tokens = new RegExp(`<(/?)${tag}\\b`, 'gi');
  tokens.lastIndex = at + 1;
  let depth = 1;
  for (let token = tokens.exec(html); token !== null; token = tokens.exec(html)) {
    depth += token[1] === '/' ? -1 : 1;
    if (depth === 0) {
      const close = html.indexOf('>', token.index);
      return close === -1 ? html.length : close + 1;
    }
  }
  return html.length;
};

const QUOTED_STARTS: readonly RegExp[] = [...MAIL_CHAT_QUOTE_START, ...MAIL_CHAT_QUOTE_CONTAINERS.map(({ start }) => start)];

/** What the HTML after the own part's end holds. */
const tailCut = (tail: string): MailChatHtmlCut => {
  if (!hasWords(tail)) return 'none';
  const embedded = tail.search(MAIL_CHAT_EMBEDDED_START);
  if (embedded >= 0 && hasWords(tail.slice(embedded))) return 'mail';
  for (const start of QUOTED_STARTS) {
    const at = tail.search(start);
    if (at >= 0 && hasWords(tail.slice(at))) return 'quote';
  }
  return 'signature';
};

const CUT_RANK: Readonly<Record<MailChatHtmlCut, number>> = { none: 0, signature: 1, quote: 2, mail: 3 };

/** The owner's own part of an email's HTML, and what was left out. A reply's
 *  quote containers are removed wherever they are; a signature, a divider or an
 *  attached email ends it, and — in an email that `forwarded` mail — so does
 *  the first container. */
export const mailChatHtmlOwnPart = (
  html: string,
  options: { readonly forwarded?: boolean } = {},
): { readonly html: string; readonly cut: MailChatHtmlCut } => {
  const read = mailChatHtmlReadable(html);
  const containers = MAIL_CHAT_QUOTE_CONTAINERS.map(({ start, tag }) => ({ next: nextMatch(read, start), tag }));
  const ends = [...MAIL_CHAT_SIGNATURE_START, ...MAIL_CHAT_QUOTE_START, MAIL_CHAT_EMBEDDED_START]
    .map((pattern) => nextMatch(read, pattern));
  let own = '';
  let removed = '';
  for (let from = 0; ;) {
    let end = read.length;
    for (const next of ends) {
      const at = next(from);
      if (at !== -1 && at < end) end = at;
    }
    let container: { at: number; tag: string } | null = null;
    for (const { next, tag } of containers) {
      const at = next(from);
      if (at !== -1 && at < end && (container === null || at < container.at)) container = { at, tag };
    }
    if (container !== null && options.forwarded === true) end = container.at;
    else if (container !== null) {
      const after = containerEnd(read, container.at, container.tag);
      // A container is a block: the words on either side of it are two lines.
      own += `${read.slice(from, container.at)}<br>`;
      removed += read.slice(container.at, after);
      from = after;
      continue;
    }
    own += read.slice(from, end);
    const tail = tailCut(read.slice(end));
    const quoted: MailChatHtmlCut = hasWords(removed) ? 'quote' : 'none';
    return { html: own, cut: CUT_RANK[tail] >= CUT_RANK[quoted] ? tail : quoted };
  }
};

/** The owner's own part of an email's HTML, as text, and what was left out. */
export const mailChatHtmlOwnText = (
  html: string,
  options: { readonly forwarded?: boolean } = {},
): { readonly text: string; readonly cut: MailChatHtmlCut } => {
  const own = mailChatHtmlOwnPart(html, options);
  return { text: mailChatHtmlToText(own.html), cut: own.cut };
};
