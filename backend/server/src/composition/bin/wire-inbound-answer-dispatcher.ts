/** D-163 inbound-answer-dispatcher slice — replaces the log-and-drop
 *  stubs in `composeVendorWebhookPort` with handlers that route the
 *  registry-declared messenger callback payloads
 *  through the matching `RemoteChannel.parseInboundReply` into
 *  `block.submitAnswer`.
 *
 *  Background: D-148 P9 § A.13 lands the verified vendor webhook port
 *  (HMAC-SHA256 for Slack, constant-time secret-token compare for
 *  Telegram, ±5-minute replay window, idempotency ledger). After
 *  verification the port hands the parsed payload to
 *  `dispatchSlackEvent` / `dispatchTelegramEvent`. The substrate slice
 *  shipped log-and-drop stubs because the downstream `block.submitAnswer`
 *  funnel had no boot-time composition yet — D-158 P2's
 *  `RemoteChannel.parseInboundReply` was the seam, but the seam wasn't
 *  wired. This slice closes that gap.
 *
 *  Routing path per event:
 *    1. `parseInboundReply(payload)` on the matching channel. Returns
 *       null for any payload that is not a recognizable option
 *       selection (plain message events, control events,
 *       malformed envelopes — all fall through to log-and-drop).
 *    2. On a non-null reply, `await block.submitAnswer(reply)`. The
 *       block dedups (first-answer-wins, I-6), validates the option
 *       against the persisted ask, and dispatches `on_answer`. Per the
 *       documented contract: a reply to an unknown / already-answered
 *       ask, or an option the ask never offered, is an internal no-op
 *       — `submitAnswer` resolves cleanly without throwing. A handler
 *       throw is also caught inside the block (boot sweep retries
 *       dispatch). So the only path that surfaces as a rejection is a
 *       storage-layer failure (`ask_store.get` / `recordAnswer` reject,
 *       channel `closeAsk` reject). Those failures SHOULD propagate
 *       through `await deps.dispatchEvent(...)` in the vendor provider,
 *       which converts the throw to `{ ok: false }` ⇒ webhook returns
 *       502 ⇒ vendor retries (Slack 3× exponential / Telegram until
 *       acknowledged). The retry budget is the self-healing window: if
 *       the storage hiccup clears, the next retry succeeds and the
 *       answer lands. Silently swallowing the throw + returning 200
 *       would forfeit that recovery for a real bug.
 *
 *  Degraded paths:
 *    - `block === undefined`: the notification block was never
 *      constructed (no db / no auditLog / no checkpointStore /
 *      no annotationStore — pre-storage harness). Dispatch logs +
 *      drops; no submitAnswer call possible.
 *    - `messengerChannels[vendor] === undefined`: the matching
 *      `RemoteChannel` was never built (no connectionStoreRef ⇒ an empty
 *      registry, or the vendor has no transport/recipient leaf). Same log +
 *      drop posture; the substrate stays present but inert.
 *      `composeVendorWebhookPort` already degrades to undefined when no
 *      connection store is wired, so this path is reachable only in the narrow
 *      window between "connection store present, channel substrate not" — kept
 *      for defense-in-depth.
 *
 *  Lock-step invariant: the channel handles this composer receives are
 *  the SAME instances `composeNotificationBlock` registered in the
 *  block's `channels` array. The `RemoteChannel` keeps an in-memory
 *  `ask_id → vendor_message_id` map (D-158 P2a `delivered`), and
 *  `parseInboundReply` does not consult that map — it decodes the
 *  vendor's callback payload self-sufficiently. Shared identity matters
 *  for `closeAsk` (the block calls it on the same instance), not for
 *  parseInboundReply, but threading the same handle keeps composition
 *  reasoning simple.
 *
 *  Spec: D-163 § N.5 / A.1 + D-158 § A.4 /
 *  I-9 + D-148 § A.13. */

import { createHash } from 'node:crypto';
import {
  MESSENGER_EVENT_PLATFORM,
  getMessengerVendorDeclaration,
  listMessengerVendors,
} from '@recued/contracts';
import type {
  NotificationBlock,
  RemoteChannel,
} from '@recued/notification';
import type { ParsedInbound } from '@recued/transport';
import type { WarehouseEventBus } from '@recued/warehouse-events';
import { messengerSourceKey } from '../../watch/source-registry.js';
import type { MessengerLiveControl } from './wire-messenger-live-control.js';
import type { MessengerTurnIngest } from './wire-messenger-turn.js';

/** The vendor-normalized inbound event the unified `dispatchMessengerEvent`
 *  consumes (D-192 CORE #6 seam 2). Each vendor's provider event
 *  (`SlackInboundEvent` / `TelegramInboundUpdate`) maps onto this at the thin
 *  wrapper boundary; the per-vendor id field NAME rides along so log lines stay
 *  byte-identical across the dedup. */
export interface MessengerInboundEvent {
  connection_name: string;
  payload: unknown;
  /** The vendor's native id field name — `'event_id'` (Slack) / `'update_id'`
   *  (Telegram) — reproduced verbatim in log detail. */
  id_field: string;
  /** The id value, or null when the payload carried none. */
  id_value: string | null;
}

/** A vendor's declared post-press ack (Telegram `answerCallbackQuery`) — called
 *  best-effort after a live-control press and after an ask `submitAnswer` to
 *  clear the inline-keyboard spinner. Absent for vendors needing no ack (Slack);
 *  never allowed to propagate (a 502 would re-fire the callback). */
export type MessengerCallbackAck = (
  payload: unknown,
  connection_name: string,
) => Promise<void>;

export interface ComposeInboundAnswerDispatcherDeps {
  /** Host-only D-261 interceptor. This dispatcher receives signature-verified
   * vendor events; offer protected owner reviews before generic replies and
   * model routing can drop sender/message identity. */
  preapprovalReview?: (vendor: string, event: MessengerInboundEvent) => Promise<boolean>;
  /** D-158 notification block — `submitAnswer(reply)` is the funnel
   *  every recognized callback lands at. Absent ⇒ both dispatchers
   *  degrade to log + drop. */
  block?: NotificationBlock;
  /** D-192 CORE #6 seam 7 (Group D) — the `vendor → RemoteChannel` messenger
   *  registry, threaded in whole (the SAME instances the notification block
   *  registered, so `closeAsk` and `parseInboundReply` share identity — D-163
   *  lock-step). `dispatchMessengerEvent` looks up `messengerChannels[vendor]`;
   *  its `parseInboundReply` decodes the vendor's callback envelope into an
   *  `InboundReply`. A vendor absent from the map ⇒ that vendor's dispatch
   *  degrades to log + drop. Replaces the per-vendor `slackChannel` /
   *  `telegramChannel`. */
  messengerChannels?: Record<string, RemoteChannel>;
  /** D-163 polish — Telegram `answerCallbackQuery` ack. Called
   *  best-effort AFTER `submitAnswer` succeeds so the inline-keyboard
   *  spinner on the user's device clears. Absent ⇒ press is recorded
   *  but the spinner sits until Telegram's own ~5-second client-side
   *  timeout — annoying-not-broken. Failures are caught + logged here;
   *  they MUST NOT propagate (a 502 would cause Telegram to retry the
   *  entire callback, re-firing submitAnswer + the failed ack in
   *  cascade). */
  telegramAck?: (payload: unknown, connection_name: string) => Promise<void>;
  /** Optional logger — mirrors `composeVendorWebhookPort`'s contract so
   *  the substrate slice's log lines stay consistent when the
   *  dispatcher takes over. */
  log?: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void;
  /** WatchSource messenger push source — when present, a verified
   *  inbound payload that is NOT an ask callback but IS a plain user
   *  message (`parseInboundMessage`) emits a canonical
   *  `data.messenger.<vendor>.message.created` warehouse event so
   *  `event_triggers` recipes can subscribe to inbound messages (the
   *  D-096 remote-trigger idea, re-slotted onto the one bus). Absent ⇒
   *  the pre-slice log + drop posture. The event `record` carries the
   *  parsed message (`from` / `text` — server-local; the realtime
   *  bridge forwards only `(collection, op, id)` to paired clients).
   *
   *  Deliberately UNGATED (owner-ratified 2026-06-10): the event emits
   *  for EVERY signature-verified user message the bot can see — any
   *  conversation, any named connection row — because the trigger
   *  substrate's job is "messages the bot observes" (e.g. a recipe
   *  watching a #support channel the bot sits in), and per-message
   *  auth is the webhook port's signature verification. The messenger
   *  TURN path applies the canonical-row + conversation-binding gates
   *  (`wire-messenger-turn.ts`); the two consumers are different
   *  products with different boundaries. Recipes consuming these
   *  events treat `record.text` as untrusted external data — do NOT
   *  re-flag this as a missing gate. */
  warehouseBus?: WarehouseEventBus;
  /** WatchSource registry liveness hook — called with the messenger
   *  `source_key` after each bus emit. */
  markSourceEvent?: (source_key: string, at: number) => void;
  /** D-160 A.8 step 6 downstream consumer — when present, a verified
   *  inbound payload that is NOT an ask callback is offered for a
   *  `messenger` TURN (`wire-messenger-turn.ts`: parse → credential →
   *  conversation-binding gate → queue `runMessengerTurn`; the reply
   *  posts back over the vendor transport). The call only parses +
   *  gates + enqueues — the turn runs on the composer's per-vendor
   *  queue, so the webhook response is never held open across an LLM
   *  turn. Runs ALONGSIDE the warehouse-bus emit (orthogonal
   *  consumers: the event is the trigger substrate, the turn is the
   *  conversation). Absent ⇒ the pre-slice posture (event + log). */
  messengerTurnIngest?: MessengerTurnIngest;
  /** D-181 slice 6b — the messenger live-control surface. When present, a
   *  verified inbound payload is offered to it FIRST: a live-control button
   *  press (our `LIVE_CONTROL_CORRELATION_ID`) routes to `execution.{kill,
   *  cancel,promote}` before the ask-reply path, and a `/recued …` command in
   *  the bound conversation renders the active list before the messenger turn.
   *  A press on an ask prompt / a non-command message ⇒ not consumed → the
   *  existing paths run unchanged. Absent ⇒ the pre-slice posture (no `/recued`
   *  command, no control buttons). */
  messengerLiveControl?: MessengerLiveControl;
  /** Test seam — event timestamps. Defaults to `Date.now`. */
  now?: () => number;
}

/** D-192 seam 11 — what a vendor's webhook descriptor hands its dispatcher. The
 *  base shape only: the connection + the raw payload. The vendor's native id
 *  rides on the SAME object under its DECLARED `ingress.id_field` key, read
 *  dynamically below — which is why this is not typed per-vendor.
 *
 *  Assignable to each provider's `Dispatch<Vendor>Event` by contravariance (a
 *  function accepting the supertype is usable where one accepting the subtype is
 *  expected), so the descriptor boundary stays type-checked. */
export type MessengerWebhookDispatch = (event: {
  connection_name: string;
  payload: unknown;
}) => Promise<void>;

export interface InboundAnswerDispatcherBundle {
  /** D-192 seam 11 — vendor → dispatcher. Replaces the named
   *  `dispatchSlackEvent` / `dispatchTelegramEvent` pair, which were the LAST
   *  per-vendor bridge Groups B and D deliberately left standing. */
  messengerDispatchers: Record<string, MessengerWebhookDispatch>;
}

/** Compose the Slack + Telegram inbound-answer dispatchers. Always
 *  returns both — degraded inputs (absent block, absent channel) flip
 *  the corresponding dispatcher to log + drop, NOT to undefined, so the
 *  webhook port has a stable seam regardless of which substrates are
 *  wired. */
export const composeInboundAnswerDispatcher = (
  deps: ComposeInboundAnswerDispatcherDeps,
): InboundAnswerDispatcherBundle => {
  const { block, telegramAck, log, messengerTurnIngest, messengerLiveControl } = deps;
  const now = deps.now ?? (() => Date.now());

  // D-192 CORE #6 seam 7 (Group D) — the vendor→RemoteChannel registry is now
  // threaded in whole (built ONCE in compose-execution-context and shared with
  // the notification block, so `closeAsk` + `parseInboundReply` hit the same
  // instances). The single dispatch body below looks up `channels[vendor]`.
  // `acks` is the "declared post-press hook": a vendor with an entry acks after
  // a press / answer, one without (Slack) does not. (`telegramAck` stays a named
  // dep — the acks registry is a separate seam.)
  const channels: Record<string, RemoteChannel> = deps.messengerChannels ?? {};
  const acks: Record<string, MessengerCallbackAck> = {
    ...(telegramAck ? { telegram: telegramAck } : {}),
  };

  /** Offer a payload to the live-control surface. Defensive catch: a seam bug
   *  must not 502 the webhook into a vendor redelivery loop. `kind: 'press'`
   *  routes a button press, `kind: 'command'` a `/recued …` text command. */
  const offerLiveControl = async (
    kind: 'press' | 'command',
    vendor: string,
    connection_name: string,
    payload: unknown,
  ): Promise<boolean> => {
    if (!messengerLiveControl) return false;
    try {
      return kind === 'press'
        ? await messengerLiveControl.handleControlPress(vendor, connection_name, payload)
        : await messengerLiveControl.handleCommand(vendor, connection_name, payload);
    } catch (e) {
      log?.('warn', `messenger inbound (${vendor}) — live-control ${kind} threw`, {
        connection_name,
        error: e instanceof Error ? e.message : String(e),
      });
      return false;
    }
  };

  /** A transient durable-admission failure must reach the vendor acknowledgement
   * boundary. Stable native IDs make a retry safe after an uncertain local ack. */
  const offerMessengerTurn = async (vendor: string, connection_name: string, payload: unknown): Promise<boolean> =>
    messengerTurnIngest ? messengerTurnIngest(vendor, connection_name, payload) : false;

  /** WatchSource messenger push source — emit a verified non-callback
   *  user message as a canonical bus event. Returns true when an event
   *  emitted (a recognizable user message + a bus to emit on). */
  const emitInboundMessage = (
    vendor: string,
    connection_name: string,
    channel: RemoteChannel,
    payload: unknown,
  ): boolean => {
    if (!deps.warehouseBus) return false;
    let message: ParsedInbound | null;
    try {
      message = channel.parseInboundMessage(payload);
    } catch (e) {
      // A parser throw on an exotic payload must never 502 the webhook
      // (the vendor would retry a payload that can never parse).
      log?.('warn', `messenger inbound (${vendor}) — parseInboundMessage threw`, {
        connection_name,
        error: e instanceof Error ? e.message : String(e),
      });
      return false;
    }
    if (message === null) return false;
    const at = now();
    // Fallback id is an OPAQUE digest — record_id crosses the realtime
    // bridge to paired clients (emit-sites forwards (collection, op,
    // id)), so it must never carry sender identity (codex HIGH fold).
    // Deterministic over the payload so a vendor redelivery mints the
    // same id.
    const record_id =
      message.vendor_message_id !== undefined && message.vendor_message_id.length > 0
        ? message.vendor_message_id
        : createHash('sha256')
            .update([vendor, connection_name, message.from, message.text, String(at)].join('\n'))
            .digest('hex')
            .slice(0, 24);
    deps.warehouseBus.emit({
      platform: MESSENGER_EVENT_PLATFORM,
      slug: vendor,
      entity_type: 'message',
      event_kind: 'created',
      record_id,
      at,
      record: {
        from: message.from,
        text: message.text,
        vendor,
        connection_name,
        media_count: message.media?.length ?? 0,
      },
    });
    deps.markSourceEvent?.(messengerSourceKey(vendor), at);
    return true;
  };

  // D-192 CORE #6 (seam 2) — ONE vendor-generic dispatch over the `channels` /
  // `acks` registries, replacing the two ~130-line near-duplicate
  // `dispatchSlackEvent` / `dispatchTelegramEvent` bodies. A new chat transport
  // adds a `channels` entry (+ an `acks` entry if it needs a post-press ack) and
  // a thin wrapper below — never a third near-dup dispatcher.
  const dispatchMessengerEvent = async (
    vendor: string,
    event: MessengerInboundEvent,
  ): Promise<void> => {
    const { connection_name, payload, id_field, id_value } = event;
    const channel = channels[vendor];
    const ack = acks[vendor];
    // Per-vendor id field name preserved in logs (Slack `event_id`, Telegram
    // `update_id`); omitted when the payload carried none.
    const idLog: Record<string, string> = id_value !== null ? { [id_field]: id_value } : {};

    if (await deps.preapprovalReview?.(vendor, event)) {
      if (ack) {
        try { await ack(payload, connection_name); }
        catch (error) { log?.('warn', `messenger inbound (${vendor}) — review callback ack failed`, {
          connection_name, error: error instanceof Error ? error.message : String(error),
        }); }
      }
      return;
    }

    // D-181 slice 6b — a live-control button press (our correlation id) routes to
    // the registry BEFORE the ask-reply path, so it is never mis-classified as a
    // stale ask. A press on another prompt is not consumed → falls through. A
    // vendor with a declared post-press ack (Telegram) clears its inline-keyboard
    // spinner afterward, best-effort (a 502 would re-fire the whole callback).
    if (await offerLiveControl('press', vendor, connection_name, payload)) {
      if (ack) {
        try {
          await ack(payload, connection_name);
        } catch (e) {
          log?.('warn', `messenger inbound (${vendor}) — live-control ack failed`, {
            connection_name,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      log?.('info', `messenger inbound (${vendor}) — live-control press handled`, {
        connection_name,
        ...idLog,
      });
      return;
    }
    // A `/recued …` command in the bound conversation renders the active list and
    // is consumed BEFORE the messenger turn (the LLM never sees it). Self-
    // guarding: returns false for any non-command message / callback shape.
    if (await offerLiveControl('command', vendor, connection_name, payload)) {
      log?.('info', `messenger inbound (${vendor}) — live-control command handled`, {
        connection_name,
        ...idLog,
      });
      return;
    }
    if (!channel) {
      log?.('info', `messenger inbound (${vendor}) — no channel adapter wired`, {
        connection_name,
        ...idLog,
      });
      return;
    }
    const reply = channel.parseInboundReply(payload);
    if (reply === null) {
      // Not an interactive callback. A plain user message emits onto the
      // warehouse bus (WatchSource messenger push source) AND is offered for a
      // messenger turn (D-160 A.8 step 6 — orthogonal consumers); anything else
      // (`url_verification`, bot echoes, control events) preserves the log + drop
      // shape so trace continuity holds.
      //
      // ⛔⛔ D-238 — BOTH consumers are gated on the vendor's DECLARED
      // `messenger` role, and neither used to be. A vendor declaring
      // `messenger: false` is saying its conversation is not Recued's business:
      // it is an approval surface, not a chat one. Emitting anyway would make
      // ordinary office chatter a recipe TRIGGER
      // (`data.messenger.<vendor>.message.created`) and route it into an LLM
      // turn — precisely the trigger-source and warehouse non-goals D-238 § 6
      // records, and precisely why the seat was declined in § 0. The role was
      // declared and then not consulted, which is the worst of both.
      //
      // 🔑 Read from the declaration, never a vendor list: the next
      // approval-only vendor is covered with no edit here.
      const conversational =
        getMessengerVendorDeclaration(vendor)?.roles.messenger === true;
      if (!conversational) {
        log?.('info', `messenger inbound (${vendor}) — not a conversational vendor; dropped`, {
          connection_name,
          ...idLog,
        });
        return;
      }
      const turnQueued = await offerMessengerTurn(vendor, connection_name, payload);
      const emitted = emitInboundMessage(vendor, connection_name, channel, payload);
      log?.('info', emitted ? `messenger inbound (${vendor}) — message event emitted` : `messenger inbound (${vendor})`, {
        connection_name,
        ...idLog,
        ...(turnQueued ? { messenger_turn: 'queued' } : {}),
      });
      return;
    }
    if (!block) {
      log?.('info', `messenger inbound (${vendor}) — ask callback dropped, no block wired`, {
        ask_id: reply.ask_id,
        option: reply.option,
      });
      return;
    }
    // Per the contract, submitAnswer no-ops on stale press / unknown / option-
    // mismatch + handler throws internally. The only reject path is a storage-
    // layer failure; let it propagate so the vendor provider converts it to
    // `{ ok: false }` ⇒ 502 ⇒ vendor retries.
    await block.submitAnswer(reply);
    // Best-effort post-answer ack (Telegram `answerCallbackQuery`) — clears the
    // inline-keyboard spinner. A failure is logged + dropped: an ack failure must
    // never propagate (a 502 would re-fire submitAnswer + the ack in cascade).
    if (ack) {
      try {
        await ack(payload, connection_name);
      } catch (e) {
        log?.('warn', `messenger inbound (${vendor}) — answerCallbackQuery failed`, {
          ask_id: reply.ask_id,
          connection_name,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  };

  // D-192 seam 11 — ONE normalizer, over the registry. The two per-vendor
  // wrappers this replaces were identical apart from which key held the inbound
  // id and what name to reproduce in the log line (Slack `event_id`, Telegram
  // `update_id`) — and that key is now a DECLARED fact (`ingress.id_field`), so
  // there is nothing left for a wrapper to know. A new chat transport dispatches
  // with no wrapper of its own.
  const messengerDispatchers: Record<string, MessengerWebhookDispatch> = {};
  for (const vendor of listMessengerVendors()) {
    const id_field = getMessengerVendorDeclaration(vendor)?.ingress.id_field;
    if (id_field === undefined) continue;
    messengerDispatchers[vendor] = (event) => {
      // The id rides on the provider event under its declared key; the read is
      // dynamic BECAUSE the key is data, so narrow it back to the contract here.
      const raw = (event as unknown as Record<string, unknown>)[id_field];
      return dispatchMessengerEvent(vendor, {
        connection_name: event.connection_name,
        payload: event.payload,
        id_field,
        id_value: typeof raw === 'string' ? raw : null,
      });
    };
  }

  return { messengerDispatchers };
};
