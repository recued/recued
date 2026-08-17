/** D-238 — the Microsoft Teams transport (Microsoft Graph).
 *
 *  ⛔ **The base `Transport`, deliberately NOT `InteractiveTransport`, and that
 *  is the whole point of the vendor.** Teams' button primitive is an Adaptive
 *  Card `Action.Submit`, and a card action is delivered to a Bot Framework bot's
 *  messaging endpoint — Graph message polling returns *messages*, never
 *  interactions. So poll-based ingress and native in-Teams buttons are mutually
 *  exclusive, and this vendor declares `capability: 'notify-only'` rather than
 *  pretending to a `sendPrompt` it cannot resolve. See D-238 § 0b.
 *
 *  🔑 **Why plain text rather than HTML.** Graph accepts
 *  `body.contentType: 'html'`, and it is tempting for a clickable `link_url`.
 *  It is refused here: an ask body is composed from AGENT-AUTHORED argument
 *  values, and the D-157/D-177 rendering invariants say a value must never
 *  author its document. Slack needed a dedicated escaper (`escapeSlackText`)
 *  precisely because it INTERPRETS the body — `<url|label>` URL-disguise,
 *  `<!channel>` pings, and an ordinary `Dana <dana@x.com>` mail header being
 *  eaten. `contentType: 'text'` sidesteps that entire class the way Telegram's
 *  absent `parse_mode` does. Teams still auto-links a bare URL, so the deep
 *  link stays tappable without handing markup control to the payload.
 *
 *  Auth is an OAuth2 delegated Graph token, renewed by the
 *  `kind: 'notification'` refresher (D-238 § 2a) before it reaches `send` —
 *  every other declared transport takes a static bot token. */

import {
  classifyHttpError,
  DEFAULT_TIMEOUT_MS,
  postJson,
  type HttpPostOutcome,
} from './http.js';
import { fitText } from './fit-text.js';
import type {
  OutboundMessage,
  ParsedInbound,
  Transport,
  TransportSendResult,
} from './types.js';

/** Graph REST v1.0 root. */
const GRAPH_API_BASE = 'https://graph.microsoft.com/v1.0';

/** Graph rejects a `chatMessage` body over 28 KB. The margin covers the JSON
 *  envelope and any multi-byte expansion in the body we are measuring in chars. */
const TEAMS_CONTENT_LIMIT = 28_000;
const TEAMS_TEXT_BUDGET = TEAMS_CONTENT_LIMIT - 512;

const fitTeams = (text: string): string =>
  fitText(text, TEAMS_TEXT_BUDGET, 'Teams');

/** Compose the body. No markup — see the header. A title becomes its own line
 *  and the deep link its own trailing line, which is what makes both readable
 *  in a client that is not interpreting anything. */
const composeTeamsText = (msg: {
  text: string;
  title?: string;
  link_url?: string;
}): string => {
  const head = msg.title ? `${msg.title}\n\n` : '';
  const tail = msg.link_url ? `\n\n${msg.link_url}` : '';
  return `${head}${msg.text}${tail}`;
};

interface GraphErrorEnvelope {
  error?: { code?: unknown; message?: unknown };
}

interface GraphMessageEnvelope {
  id?: unknown;
}

/** Graph errors are `{ error: { code, message } }`. Both halves are surfaced —
 *  the code is what a search finds (`InvalidAuthenticationToken`), the message
 *  is what a human reads. */
const describeGraphError = (json: unknown): string => {
  if (json === null || typeof json !== 'object') return 'unknown_error';
  const err = (json as GraphErrorEnvelope).error;
  if (err === undefined || err === null || typeof err !== 'object') return 'unknown_error';
  const code = typeof err.code === 'string' && err.code.length > 0 ? err.code : null;
  const message =
    typeof err.message === 'string' && err.message.length > 0 ? err.message : null;
  if (message === null) return code ?? 'unknown_error';
  return code === null ? message : `${message} (code ${code})`;
};

const handleTeamsOutcome = (outcome: HttpPostOutcome): TransportSendResult => {
  if (!outcome.ok) {
    const kind =
      outcome.kind === 'http_error' ? classifyHttpError(outcome.status) : outcome.kind;
    const detail =
      outcome.kind === 'http_error'
        ? `${describeGraphError(outcome.json)} [http ${outcome.status}]`
        : outcome.detail;
    return { ok: false, error: { kind, detail: `Teams: ${detail}` } };
  }
  const env = (outcome.json ?? {}) as GraphMessageEnvelope;
  return typeof env.id === 'string' && env.id.length > 0
    ? { ok: true, vendor_message_id: env.id }
    : { ok: true };
};

/** Accept a Teams chat id OR a pasted Teams link, and yield the id.
 *
 *  ⛔ The friction this removes is real and got worse. Teams used to expose the
 *  thread id in the address bar; it no longer does, so "take the 19:…@thread.v2
 *  value from the web URL" — which the enrol card said — is now WRONG advice for
 *  a work account and impossible for anyone following it literally. What the
 *  client still gives you is **Copy link**, and that link carries the id
 *  percent-encoded, exactly as Graph's own `chat.webUrl` does:
 *
 *    https://teams.microsoft.com/l/chat/19%3Aabc%40thread.v2/0?tenantId=…
 *
 *  So the field accepts either form and normalises here. A raw id passes
 *  through untouched, which keeps every existing config working.
 *
 *  ⚠ Deliberately NOT a general URL parser. It looks for the one segment shape a
 *  Teams thread id has (`19:…@thread.v2` / `@unq.gbl.spaces`), so a link to
 *  something else yields null rather than a plausible-looking wrong id — sending
 *  an owner's approval to the wrong conversation is the failure to avoid here. */
export const normalizeTeamsChatId = (raw: string): string | null => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // A decoded id, pasted directly.
  if (/^19:[^\s]+@(thread\.v2|unq\.gbl\.spaces)$/u.test(trimmed)) return trimmed;
  // Otherwise look for the encoded (or decoded) id anywhere in the string, which
  // covers a full link, a bare path, and a copy that dropped the scheme.
  let candidate = trimmed;
  try {
    candidate = decodeURIComponent(trimmed);
  } catch {
    // A malformed escape — fall back to the raw text rather than refusing, since
    // the id may still be present verbatim.
  }
  const match = /19:[^\s/?#]+@(?:thread\.v2|unq\.gbl\.spaces)/u.exec(candidate);
  return match === null ? null : match[0];
};

export interface TeamsTransportOptions {
  /** Inject for testing; defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout; defaults to `DEFAULT_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/** Build the Teams transport.
 *
 *  `recipient` is a Graph chat id (`19:…@thread.v2`). Channel posts address
 *  `/teams/{team}/channels/{channel}/messages` instead and are NOT wired here:
 *  posting to a channel is user-consentable (`ChannelMessage.Send`), but the
 *  bound-conversation recipient shape would have to carry the team+channel pair
 *  rather than one id — a widening with no consumer until channel delivery is
 *  actually specified. */
export const createTeamsTransport = (
  options: TeamsTransportOptions = {},
): Transport => {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const send = async (message: OutboundMessage): Promise<TransportSendResult> => {
    const outcome = await postJson(
      `${GRAPH_API_BASE}/chats/${encodeURIComponent(message.recipient)}/messages`,
      {
        headers: {
          authorization: `Bearer ${message.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          body: { contentType: 'text', content: fitTeams(composeTeamsText(message)) },
        }),
        timeoutMs,
        fetchImpl,
      },
    );
    return handleTeamsOutcome(outcome);
  };

  /** Parse a Graph `chatMessage` delivered by the poll runner.
   *
   *  🔑 **`body.content` is HTML even when we posted `contentType: 'text'`** —
   *  Teams stores what the CLIENT sent, and a person typing in Teams sends
   *  HTML. So a reply reading `approve` arrives as `<p>approve</p>`, and a
   *  typed-answer matcher comparing that to an option label would never match.
   *  Stripping tags here rather than at the matcher keeps the vendor's wire
   *  shape in the vendor's leaf, which is the same reason `parseConversationId`
   *  lives here and not in a shared composer.
   *
   *  ⚠ Entity decoding is deliberately limited to the five XML predefined
   *  entities. A general HTML decoder would turn `&lt;approve&gt;` into
   *  something that looks like markup and invite a second parse; the answer
   *  matcher wants plain text, not rendered text. */
  const parseInbound = (payload: unknown): ParsedInbound | null => {
    if (payload === null || typeof payload !== 'object') return null;
    const msg = payload as Record<string, unknown>;
    const id = typeof msg.id === 'string' ? msg.id : undefined;
    const body = msg.body;
    const content = body !== null && typeof body === 'object'
      ? (body as Record<string, unknown>).content
      : undefined;
    if (typeof content !== 'string') return null;

    const text = content
      // A block boundary is a line break, not a word join: `<p>a</p><p>b</p>`
      // must not become `ab`.
      .replace(/<br\s*\/?>/giu, '\n')
      .replace(/<\/(p|div)>/giu, '\n')
      .replace(/<[^>]*>/gu, '')
      .replace(/&lt;/gu, '<')
      .replace(/&gt;/gu, '>')
      .replace(/&quot;/gu, '"')
      .replace(/&#39;/gu, "'")
      // Ampersand LAST — decoding it first would let `&amp;lt;` become `<`.
      .replace(/&amp;/gu, '&')
      .trim();

    const from = msg.from;
    const user = from !== null && typeof from === 'object'
      ? (from as Record<string, unknown>).user
      : undefined;
    const senderId = user !== null && typeof user === 'object'
      && typeof (user as Record<string, unknown>).id === 'string'
      ? String((user as Record<string, unknown>).id)
      : '';

    return { from: senderId, text, ...(id !== undefined ? { vendor_message_id: id } : {}) };
  };

  /** The bound conversation is the message's own `chatId`. */
  const parseConversationId = (payload: unknown): string | null => {
    if (payload === null || typeof payload !== 'object') return null;
    const chatId = (payload as Record<string, unknown>).chatId;
    return typeof chatId === 'string' && chatId.length > 0 ? chatId : null;
  };

  return { vendor: 'teams', send, parseInbound, parseConversationId };
};
