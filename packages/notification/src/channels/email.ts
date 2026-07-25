/** D-158 P2b-i — the email notification `Channel` (BYO mail account).
 *
 *  The third remote channel, after P2a's `slack` / `telegram`. Unlike
 *  those it is NOT transport-backed — D-160's `@recued/transport`
 *  deliberately excludes email (email is not raw HTTP send/poll
 *  plumbing). Email rides the user's own BYO mail account, both ways:
 *
 *    outbound — an injected `EmailSender` seam. The server wires it to
 *      `connection.notification` email → `mailRpc.send` → the user's
 *      BYO SMTP. The block is a leaf and cannot reach the connection
 *      store; the seam is the boundary (mirrors P2a's `resolveCredential`).
 *
 *    inbound — a reply lands in that SAME account's `data.mail` mirror
 *      (every send-capable mail account is an IMAP/Gmail/Graph mailbox
 *      Recued already mirrors). `deliverAsk` stamps the `ask_id` into
 *      the subject as a `[#<ask_id>]` tag; a `Re:` reply preserves it,
 *      so `extractAskId` reads the `ask_id` straight off the reply
 *      subject — stateless, no correlation map, survives a restart
 *      trivially. `parseEmailReply` keyword-matches the chosen option
 *      from the reply body against the ask's options.
 *
 *  The two inbound-parse functions are standalone (not `Channel`
 *  methods, unlike P2a's self-contained `parseInboundReply`): email
 *  inbound needs the ask's `options` — external data — so the server-
 *  wiring funnel reads the `ask_id` via `extractAskId`, loads the
 *  `PendingAsk`, then calls `parseEmailReply` with its options.
 *
 *  Leaf posture (mirrors P0 / P1 / P2a): this ships the `Channel`
 *  adapter + the parse functions. The `data.mail`-watcher →
 *  `parseEmailReply` → `block.submitAnswer` funnel, and the real
 *  `EmailSender` wiring, are the later server-wiring slice.
 *
 *  Inbound auth (I-9): a reply is trusted because it arrived in the
 *  user's own mirrored inbox — authentication is the inbound path's
 *  responsibility, upstream of `parseEmailReply` (the contract P2a's
 *  `parseInboundReply` also holds). The wiring MUST feed only genuine
 *  inbound replies — not the server's own sent ask-copy, which the
 *  mail mirror also holds (discriminate by folder).
 *
 *  Free-text caveat: an email reply is unstructured. To stay safe for
 *  approval asks the option match is *exact* — the user's reply text
 *  (above the quoted original, normalized) must EQUAL an option's id
 *  or label. A substring match would read "do not approve" as the
 *  `approve` option; an exact match cannot. A reply that is not exactly
 *  an option — extra words, a negation, anything ambiguous — yields no
 *  answer and the ask stays `open`, answerable on the always-on `ui`
 *  channel. The emailed ask instructs the user to reply with only the
 *  option.
 *
 *  One-link affordance (D-158 P2b-ii): on a *public-reachable* server an
 *  `answerLink` builder is injected. When present, `deliverAsk`
 *  additionally carries a one-click link to the `ask` landing page (a
 *  `body_html` link + a `body_text` line) — structured radio-button
 *  input, no free-text parsing. The reply-by-email path above is ALWAYS
 *  present regardless; the link is purely additive. Absent `answerLink`
 *  (a non-public deployment) → text-only, exactly as before. The landing
 *  page itself is `channels/ask-landing.ts`.
 *
 *  `closeAsk` is a genuine no-op: email cannot recall or edit a sent
 *  message. A stale reply-request email is harmless — a late reply
 *  re-correlates to the same `ask_id`, and the block's first-answer-
 *  wins dedup (I-6) makes the second answer a no-op.
 *
 *  Self-loop note (for the wiring author): D-127's `MailCollection.send`
 *  rejects a `to` equal to the sender account's own address
 *  (`MAIL_SEND_SELF_LOOP_TO`). The email channel therefore needs a
 *  delivery address distinct from the `sender_mail_instance` account's
 *  own address — a `connection.notification` email enrollment concern,
 *  surfaced by the wiring, not this leaf.
 *
 *  Spec: D-158 § P2 / A.4 / N.4 / I-9.
 */

import { htmlEscape, safeHttpUrl } from '../html.js';
import type { Channel } from './channel.js';
import type {
  AskOption,
  ChannelName,
  InboundReply,
  NotificationMessage,
} from '../types.js';

/** A composed outbound email handed to the `EmailSender` seam. The leaf
 *  composes content only; the recipient + the sending mail instance are
 *  resolved by the server-wired sender from the `connection.notification`
 *  email record. */
export interface OutboundEmail {
  subject: string;
  body_text: string;
  /** Optional HTML body — populated by `deliverAsk` only when an
   *  `answerLink` is injected (D-158 P2b-ii), to carry the clickable
   *  one-link affordance. A plain `notify` and a non-public-server
   *  `ask` send `body_text` only. */
  body_html?: string;
}

/** Sends one composed email through the user's BYO mail account.
 *  Injected — the block is a leaf and cannot reach
 *  `connection.notification` / `mailRpc`. MUST throw on a send failure:
 *  the channel's deliver methods are best-effort at the block's fan-out
 *  boundary (which catches), and a throwing `deliverAsk` is what leaves
 *  the ask retryable by the boot sweep. */
export type EmailSender = (email: OutboundEmail) => Promise<void>;

export interface EmailChannelDeps {
  /** Sends a composed email through the BYO mail account. */
  sendEmail: EmailSender;
  /** Builds the public `ask` landing-page URL for an `ask_id` (D-158
   *  P2b-ii). Injected ONLY on a public-reachable server — when present,
   *  `deliverAsk` additionally carries a one-click answer link (a
   *  `body_html` link + a `body_text` line) alongside the always-present
   *  reply-by-email path. Absent → text-only. The block is a leaf and
   *  cannot know the server's public base URL or the landing route;
   *  `backend/server` injects this builder. */
  answerLink?: (ask_id: string) => string;
}

/** The minimal inbound shape `parseEmailReply` needs — the subject (it
 *  carries the `[#<ask_id>]` tag through `Re:`) and the body (the
 *  free-text reply the option is matched from). The server-wiring slice
 *  maps a `data.mail` record onto this; the leaf does not import the
 *  warehouse record shape. */
export interface EmailReplyInput {
  subject: string;
  body_text: string;
}

const EMAIL_CHANNEL_NAME: ChannelName = 'email';
const DEFAULT_NOTIFY_SUBJECT = 'Recued';
const DEFAULT_ASK_SUBJECT = 'Recued — your input is needed';

/** The `ask_id` subject tag — `[#<ask_id>]`. The `ask_id` is already
 *  `ask-`-prefixed (the P0 minter), so the tag reads `[#ask-…]`; the
 *  brackets + `#` make a recognizable token that survives a `Re:`
 *  prefix and round-trips on the reply subject. */
const composeAskTag = (ask_id: string): string => `[#${ask_id}]`;

/** Pull an `ask_id` out of a (possibly `Re:`-prefixed) subject. Matches
 *  the `[#<ask_id>]` tag anywhere in the string. Returns null when the
 *  subject carries no tag — the record is not a reply to an emailed ask
 *  (or a mail client dropped the tag; the ask stays answerable on the
 *  `ui` channel). */
export const extractAskId = (subject: string): string | null => {
  const match = /\[#(ask-[A-Za-z0-9-]+)\]/.exec(subject);
  return match === null ? null : match[1];
};

/** The first line that begins quoted history — everything from here on
 *  is the original message, not the user's typed reply. */
const QUOTE_LINE = /^\s*>/;
const ATTRIBUTION_LINE =
  /^\s*(On .+ wrote:|-+\s*Original Message\s*-+|From:\s)/i;

/** The user's typed reply text — the lines above the quoted original.
 *  An email reply carries the full original below an attribution line /
 *  `>`-quoted block; the original lists every option, so matching the
 *  whole body would match them all. Best-effort: a bottom-posted reply
 *  (typed below the quote) yields empty text → no answer → `ui`
 *  fallback. */
const replyTextOf = (body: string): string => {
  const kept: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (QUOTE_LINE.test(line) || ATTRIBUTION_LINE.test(line)) break;
    kept.push(line);
  }
  return kept.join('\n').trim();
};

/** Normalize a reply or an option token for an exact comparison —
 *  lowercase, trim, drop trailing sentence punctuation, collapse inner
 *  whitespace. */
const normalizeToken = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[.!,;:]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Match the user's reply to exactly one option. The match is *exact*,
 *  not substring: the normalized reply text must EQUAL an option's
 *  normalized `id` or `label`. Exactness is what keeps the channel safe
 *  for approval asks — a substring match would read "do not approve" as
 *  the `approve` option. A reply that is not exactly an option (extra
 *  words, a negation, anything ambiguous) → null: no answer, the ask
 *  stays open, answerable on `ui`. Zero or (degenerate) multiple
 *  matches → null. */
const matchOption = (
  replyText: string,
  options: readonly AskOption[],
): string | null => {
  const norm = normalizeToken(replyText);
  if (norm.length === 0) return null;
  const hits = options.filter(
    (option) =>
      normalizeToken(option.id) === norm ||
      normalizeToken(option.label) === norm,
  );
  return hits.length === 1 ? hits[0].id : null;
};

/** Decode an inbound email reply into an `InboundReply`, or null when
 *  it is not a usable answer. Stateless — the `ask_id` rides in the
 *  subject tag; the option is exact-matched from the reply body
 *  against `options` (the loaded ask's options, supplied by the
 *  server-wiring slice, which reads the `ask_id` via `extractAskId`
 *  first and loads the `PendingAsk`).
 *
 *  Null when: the subject carries no tag; or the reply text matches no
 *  option, or matches more than one. The block re-validates the option
 *  against the persisted ask and dedups in `submitAnswer` regardless. */
export const parseEmailReply = (
  input: EmailReplyInput,
  options: readonly AskOption[],
): InboundReply | null => {
  const ask_id = extractAskId(input.subject);
  if (ask_id === null) return null;
  const option = matchOption(replyTextOf(input.body_text), options);
  if (option === null) return null;
  return { ask_id, option, via: EMAIL_CHANNEL_NAME };
};

/** Append an optional deep link as its own trailing line. */
const withLink = (body: string, link_url?: string): string =>
  link_url === undefined ? body : `${body}\n\n${link_url}`;

/** Compose the `notify` email — no tag (a notify collects no reply). */
const composeNotify = (message: NotificationMessage): OutboundEmail => ({
  subject: message.title ?? DEFAULT_NOTIFY_SUBJECT,
  body_text: withLink(message.text, message.link_url),
});

/** The trailing one-click answer line — appended to `body_text` below
 *  the always-present reply-by-text instruction when a public-reachable
 *  server supplies an answer URL. Last in the body: it is the
 *  call-to-action. */
const composeAnswerLine = (answerUrl: string): string =>
  `\n\nOr answer in one click: ${answerUrl}`;

/** The `ask` email's optional HTML body — a minimal, mail-client-robust
 *  document carrying the prompt, the message's optional `link_url`
 *  context link, the prominent one-click answer link, and the
 *  reply-by-text fallback. Composed only when an `answerLink` is
 *  injected; every interpolation is `htmlEscape`d, and `link_url` passes
 *  the `safeHttpUrl` scheme guard before it becomes an `<a href>`. The
 *  `link_url` line keeps the HTML body at parity with `body_text` (which
 *  appends it via `withLink`) — a mail client that renders the HTML
 *  alternative must not lose the decision context. */
const composeAskHtml = (
  message: NotificationMessage,
  options: readonly AskOption[],
  answerUrl: string,
): string => {
  const optionItems = options
    .map((option) => `<li>${htmlEscape(option.label)}</li>`)
    .join('');
  const safeLink =
    message.link_url !== undefined ? safeHttpUrl(message.link_url) : null;
  const linkLine =
    safeLink !== null
      ? `<p>More information: <a href="${htmlEscape(safeLink)}">${htmlEscape(safeLink)}</a></p>`
      : '';
  return (
    '<!doctype html><html><body>' +
    '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;font-size:15px;color:#18181b">' +
    // `white-space:pre-wrap` — an ask body is a structured document (one
    // labeled line per argument, a numbered member list). Without it HTML
    // collapses every newline and indent, so the same message renders
    // correctly in `body_text` below and as one run-on smear here — and a
    // mail client shown both prefers THIS one. Inline style, not a
    // stylesheet: mail clients strip <style> blocks.
    '<p style="white-space:pre-wrap;margin:0 0 16px">' +
    htmlEscape(message.text) +
    '</p>' +
    linkLine +
    `<p><a href="${htmlEscape(answerUrl)}" style="display:inline-block;background:#18181b;color:#ffffff;padding:10px 18px;border-radius:8px;text-decoration:none">Answer now</a></p>` +
    '<p>Or reply to this email with just one of these options:</p>' +
    `<ul>${optionItems}</ul>` +
    '</div></body></html>'
  );
};

/** Compose the `ask` email — the subject carries the `[#<ask_id>]` tag
 *  for stateless reply correlation; the body lists the options and asks
 *  the user to reply with one. When `answerUrl` is supplied (a public-
 *  reachable server injected an `answerLink`), a one-click answer link
 *  rides additionally — in `body_text` as a trailing line, in
 *  `body_html` as a clickable link. Absent `answerUrl` → byte-identical
 *  to the P2b-i text-only ask (no answer line, no `body_html`). */
const composeAsk = (
  ask_id: string,
  message: NotificationMessage,
  options: readonly AskOption[],
  answerUrl?: string,
): OutboundEmail => {
  const optionLines = options
    .map((option) => `- ${option.label}`)
    .join('\n');
  const coreBody =
    `${message.text}\n\n` +
    'To answer, reply to this email with just one of these options:\n' +
    `${optionLines}\n\n` +
    'Reply with only the option text and nothing else — Recued reads ' +
    'your reply and records your answer.';
  const body_text =
    withLink(coreBody, message.link_url) +
    (answerUrl !== undefined ? composeAnswerLine(answerUrl) : '');
  return {
    subject:
      `${message.title ?? DEFAULT_ASK_SUBJECT} ${composeAskTag(ask_id)}`,
    body_text,
    ...(answerUrl !== undefined
      ? { body_html: composeAskHtml(message, options, answerUrl) }
      : {}),
  };
};

/** Create the email notification channel. */
export const createEmailChannel = (deps: EmailChannelDeps): Channel => {
  const { sendEmail, answerLink } = deps;

  /** ask_ids delivered (or in-flight) this process — `deliverAsk` is
   *  idempotent per ask_id (the `Channel` contract): the boot re-
   *  delivery sweep, a double call, or a concurrent call must not send
   *  a second email this process. An id is reserved here BEFORE the
   *  send and released only if the send fails (so the boot sweep can
   *  still retry). In-memory and process-scoped: across a restart the
   *  set is empty, so the boot sweep may re-email an open ask once —
   *  harmless, since a reply to either copy carries the same tag and
   *  the block's first-answer-wins dedup (I-6) makes a duplicate a
   *  no-op. Persisting it is D-158 P3, as for P2a's slack/telegram
   *  delivered-map. */
  const delivered = new Set<string>();

  return {
    name: EMAIL_CHANNEL_NAME,
    capability: 'landing-page',
    // D-163 amendment / D-167 § "Channel ownership signal" — an external
    // mail client renders the body; Recued has no restore-on-display
    // hook, so it does not own the LLM↔user boundary here.
    owns_llm_egress: false,

    async deliverNotify(message) {
      await sendEmail(composeNotify(message));
    },

    async deliverAsk(ask_id, message, options) {
      if (delivered.has(ask_id)) return;
      // Reserve the id BEFORE the await — a concurrent second
      // deliverAsk for the same ask_id then observes it and does not
      // send a duplicate email.
      delivered.add(ask_id);
      try {
        // The one-link affordance rides only on a public-reachable
        // server (an `answerLink` builder was injected); absent → a
        // text-only ask, exactly as a non-public deployment.
        const answerUrl = answerLink?.(ask_id);
        await sendEmail(composeAsk(ask_id, message, options, answerUrl));
      } catch (error) {
        // Failed send — release the reservation so the boot sweep can
        // re-deliver; re-throw so the block's fan-out records it.
        delivered.delete(ask_id);
        throw error;
      }
    },

    closeAsk(): Promise<void> {
      // Email cannot recall or edit a sent message — there is nothing
      // to close. A no-op satisfies the idempotent `Channel.closeAsk`
      // contract; a stale reply-request email is harmless (see header).
      return Promise.resolve();
    },
  };
};
