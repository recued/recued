/** D-163 polish — Telegram `answerCallbackQuery` ack composer.
 *
 *  When a user presses an inline-keyboard button on a Telegram prompt,
 *  Telegram shows a spinner on that button until the bot calls
 *  `answerCallbackQuery` with the matching `callback_query_id`. The
 *  inbound-answer dispatcher (`composeInboundAnswerDispatcher`) already
 *  routes the press through `block.submitAnswer`, which records the
 *  answer + closes the prompt's buttons via `closeAsk` — but until the
 *  explicit ack lands on Telegram's side, the user's device keeps
 *  showing the spinner (the closeAsk strips the buttons, but the press
 *  itself stays "pending" in Telegram's UI for a few seconds before
 *  Telegram times it out).
 *
 *  This composer returns a thin function the dispatcher invokes
 *  best-effort after `submitAnswer` succeeds:
 *
 *    1. Extract `callback_query.id` from the inbound payload. The shape
 *       comes from the substrate slice's verified parse — the payload is
 *       a `{ update_id, callback_query: { id, data, from, ... } }`
 *       envelope. A payload that isn't a callback_query (a plain
 *       message update slipped through, malformed envelope) yields a
 *       null id and the ack no-ops.
 *
 *    2. Look up `connection.notification.<connection_name>` for the
 *       Telegram credential (same row the inbound webhook authenticated
 *       against via the D-148 P9 `lookupTelegramConnection` path —
 *       the row exists or the inbound would have 401'd upstream).
 *       Decode the bearer token via the existing
 *       `decodeAuthFromStorage` sub-DEK path so a mid-process unlock
 *       transition lands transparently.
 *
 *    3. POST to `https://api.telegram.org/bot<token>/answerCallbackQuery`
 *       with `{ callback_query_id }`. Default JSON body, no toast text
 *       (Telegram renders no visible message — the spinner just clears).
 *       3-second hard timeout matches Telegram's own callback-ack
 *       freshness window.
 *
 *  Best-effort contract — the dispatcher MUST catch any throw this
 *  function emits. An ack failure surfacing as a webhook 502 would
 *  cause Telegram to retry the entire callback delivery, which would
 *  re-fire `submitAnswer` (the block dedups, so the second answer is a
 *  no-op) AND retry the failed ack (cascade). Letting the ack stay
 *  best-effort means a transient API hiccup leaves the user with a
 *  brief spinner — annoying but harmless — while the answer is durably
 *  recorded.
 *
 *  Spec: D-163 § N.5 / A.1 + Telegram Bot API
 *  https://core.telegram.org/bots/api#answercallbackquery */

import { decodeAuthFromStorage } from '../../connection-handler.js';
import type { KeyManager } from '../../key-manager.js';
import type { ConnectionStoreSqlite } from '../../storage/connection-store.js';
import { discardResponseBody, fetchOriginPinned } from '@recued/ingredients';

/** Default ack timeout — Telegram callback acks should land within
 *  ~3-5s of the user press; longer than that and Telegram has already
 *  timed out the spinner client-side. */
const TELEGRAM_CALLBACK_ACK_TIMEOUT_MS = 3_000;

export interface ComposeTelegramCallbackAckDeps {
  /** Connection store for `connection.notification.<name>` lookup. */
  connectionStore: ConnectionStoreSqlite;
  /** Sub-DEK source. Re-read per call (NOT captured at compose time)
   *  so a mid-process boot → unlock transition lands transparently on
   *  the next ack — matches the per-call `keys.state()` re-read
   *  pattern `composeRemoteChannel` uses. */
  keys?: KeyManager;
  /** Test-only fetch override. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Test-only ack timeout override. Defaults to
   *  `TELEGRAM_CALLBACK_ACK_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/** Fire-and-await the Telegram `answerCallbackQuery` call for one
 *  inbound callback. Returns void on either success or any handled
 *  failure mode; the caller is responsible for not propagating throws
 *  past the webhook-port boundary. */
export type TelegramCallbackAck = (
  payload: unknown,
  connection_name: string,
) => Promise<void>;

/** Extract the `callback_query.id` from a verified inbound payload.
 *  Returns null when the payload isn't a callback_query update or the
 *  id field is missing / non-string. */
const extractCallbackQueryId = (payload: unknown): string | null => {
  if (payload === null || typeof payload !== 'object') return null;
  const cq = (payload as { callback_query?: unknown }).callback_query;
  if (cq === null || typeof cq !== 'object') return null;
  const id = (cq as { id?: unknown }).id;
  if (typeof id !== 'string' || id.length === 0) return null;
  return id;
};

export const composeTelegramCallbackAck = (
  deps: ComposeTelegramCallbackAckDeps,
): TelegramCallbackAck => {
  const { connectionStore } = deps;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? TELEGRAM_CALLBACK_ACK_TIMEOUT_MS;

  return async (payload, connection_name) => {
    const callback_query_id = extractCallbackQueryId(payload);
    if (callback_query_id === null) return;

    const row = connectionStore.get('notification', connection_name);
    if (row === null) return;

    // Re-read sub-DEK state per call — see ComposeTelegramCallbackAckDeps.keys.
    const keyProvider = deps.keys && deps.keys.state() !== 'uninitialized'
      ? deps.keys.keyProvider('connection')
      : undefined;

    const auth = await decodeAuthFromStorage(
      row.auth_ciphertext,
      { kind: row.kind, name: row.name },
      keyProvider,
    );
    if (auth.type !== 'bearer' || auth.token.length === 0) return;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response | undefined;
    try {
      const url = `https://api.telegram.org/bot${encodeURIComponent(auth.token)}/answerCallbackQuery`;
      response = await fetchOriginPinned(
        fetchImpl,
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ callback_query_id }),
          signal: controller.signal,
        },
        new URL(url).origin,
      );
      // Response body intentionally unread — the ack is fire-and-forget
      // from our side. Telegram's `ok: false` (e.g. callback_query_id
      // already answered) just means the spinner cleared by other means
      // and is not actionable here.
    } finally {
      if (response !== undefined) discardResponseBody(response);
      clearTimeout(timer);
    }
  };
};
