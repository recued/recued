/** D-158 P2b inbound-email-answer funnel — the reply-by-email path.
 *
 *  The companion to `wire-inbound-answer-dispatcher.ts` (Slack / Telegram)
 *  for the email channel. Slack / Telegram inbound replies arrive as
 *  verified vendor WEBHOOK payloads; email has no webhook — a reply lands
 *  in the user's OWN mirrored mailbox (`data.mail.<slug>`), which Recued
 *  already syncs. So this funnel is WATCHER-driven, not webhook-driven: it
 *  subscribes to the warehouse-event bus and, for each newly-synced mail
 *  record in the notification account's mailbox, tries to decode it as an
 *  answer to an open `ask`.
 *
 *  Per-event path (each guard falls through to a silent skip — one bad /
 *  irrelevant mail must never break the funnel or the bus emit):
 *    1. `event_kind === 'created'` — a reply is a NEW message; `updated`
 *       (an is-read flip, a re-sync) is not a fresh reply.
 *    2. `event.slug === the notification.email account's send-capable mail
 *       instance` — inbound replies land in THAT mailbox; ignore every
 *       other mail account. Re-resolved per event so a re-enrollment is
 *       picked up without a restart (mirrors the outbound sender seam).
 *    3. re-read the record — the warehouse event leaves `record` absent for
 *       adapter emits (mail / calendar / file), so the boot site supplies a
 *       reader over the mail collection + blob store.
 *    4. folder discrimination — skip the server's OWN sent ask-copy (the
 *       mail mirror also holds it when the Sent folder is synced). The leaf
 *       (`channels/email.ts`) flags this as a MUST; `parseEmailReply` is
 *       the correctness backstop (the sent copy's body is the prompt, which
 *       exact-match rejects), the folder filter is the intent-honoring one.
 *    5. `extractAskId(subject)` — no `[#ask-…]` tag ⇒ not a reply to an
 *       emailed ask.
 *    6. `block.getAsk(ask_id)` — load the ask to get its `options`
 *       (`parseEmailReply` needs them; unlike Slack/Telegram's self-
 *       contained `parseInboundReply`, email inbound needs external data).
 *       Unknown ask, or an ask no longer `open`, ⇒ skip (a late reply to a
 *       resolved ask is a no-op anyway).
 *    7. `parseEmailReply({subject, body_text}, options)` — exact-match the
 *       reply text to one option (safe for approvals: "do not approve"
 *       never matches `approve`). No usable answer ⇒ skip; the ask stays
 *       open, answerable on the always-on `ui` channel.
 *    8. `block.submitAnswer(reply)` — first-answer-wins dedup (I-6) makes a
 *       duplicate (a bus re-emit, a boot re-scan, the same reply seen
 *       twice) a no-op, so the funnel needs no idempotency ledger of its
 *       own; the block validates the option against the persisted ask and
 *       dispatches `on_answer`.
 *
 *  Trust (I-9): a reply is trusted because it arrived in the user's own
 *  mirrored inbox — authentication is the mail sync path's concern,
 *  upstream of this funnel (the same contract Slack/Telegram's webhook
 *  signature verification holds for their inbound).
 *
 *  Degraded paths (any required dep absent ⇒ the funnel is inert, never a
 *  partial wire): no `block` (notification block not composed — dbless
 *  harness), no `bus`, no `resolveEmailAccountSlug` / `readInboundMail`
 *  (no connection store / mail collection). `start()` logs + no-ops; the
 *  bus is never subscribed, so nothing fires.
 *
 *  Spec: D-158 § P2 / A.4 / I-9; leaf: `channels/email.ts`
 *  (`extractAskId` / `parseEmailReply`); outbound peer: `wire-email-channel.ts`. */

import {
  extractAskId,
  parseEmailReply,
  type NotificationBlock,
} from '@recued/notification';
import type {
  WarehouseEvent,
  WarehouseEventBus,
} from '@recued/warehouse-events';

/** The minimal inbound-mail projection the funnel needs, re-read from the
 *  warehouse by `(slug, record_id)`. The `WarehouseEvent` leaves `record`
 *  absent on mail adapter emits, so the boot site wires this reader over
 *  the mail collection (`hot_fields` → subject / folder / from) + the blob
 *  store (`materializeMailBody` → the reply text). */
export interface InboundMailRecord {
  /** The reply subject — carries the `[#ask-…]` tag through `Re:`. */
  subject: string;
  /** Primary folder / label (`INBOX` / `SENT` / …). Used to skip the
   *  server's own sent ask-copy. Empty when the adapter reports none. */
  folder: string;
  /** The bare sender address (no display name), per the adapter contract. */
  from: string;
  /** The materialized reply body (inline ≤64 KB or hydrated from CAS). */
  body_text: string;
}

export interface ComposeInboundEmailAnswerDeps {
  /** D-158 notification block — `getAsk(ask_id)` supplies the ask's
   *  `options`, `submitAnswer(reply)` is the funnel target. Absent ⇒ the
   *  funnel is inert. */
  block?: NotificationBlock;
  /** Warehouse-event bus — the funnel subscribes to `data.mail.**` and
   *  filters to `created`. Absent ⇒ inert. */
  bus?: WarehouseEventBus;
  /** Resolve the enrolled `connection.notification.email` account's
   *  send-capable mail instance slug — the mailbox inbound replies land
   *  in. Called PER EVENT so a re-enrollment / removal is picked up
   *  without a restart. Null ⇒ not enrolled ⇒ the event is ignored.
   *  Absent ⇒ inert. */
  resolveEmailAccountSlug?: () => string | null;
  /** Re-read one mail record's reply fields by `(slug, record_id)`. Null ⇒
   *  the record is missing / unreadable (a race with a delete, an
   *  unresolvable CAS blob). Absent ⇒ inert. */
  readInboundMail?: (
    slug: string,
    record_id: string,
  ) => Promise<InboundMailRecord | null>;
  /** Optional logger — mirrors `composeInboundAnswerDispatcher`'s contract. */
  log?: (
    level: 'info' | 'warn',
    msg: string,
    data?: Record<string, unknown>,
  ) => void;
}

export interface InboundEmailAnswerFunnel {
  /** Subscribe to `data.mail.**` created events. Idempotent (a second
   *  `start()` is a no-op); inert when a required dep is absent. */
  start(): void;
  /** Unsubscribe. Idempotent. */
  dispose(): void;
}

/** Skip the server's own sent ask-copy: a genuine inbound reply lands in
 *  INBOX (never matches), while a synced Sent copy carries a `sent`-like
 *  folder / label across every provider (Gmail `SENT`, IMAP `Sent` /
 *  `Sent Items`, Graph `Sent Items`). Best-effort by design — a Graph
 *  `parentFolderId` GUID won't match, but `parseEmailReply` is the
 *  correctness backstop there (the sent copy's body is the prompt, which
 *  exact-match rejects). Case-insensitive; only excludes sent-like folders,
 *  so a real INBOX reply is never a false skip. */
const isSentFolder = (folder: string): boolean => /sent/i.test(folder);

export const composeInboundEmailAnswer = (
  deps: ComposeInboundEmailAnswerDeps,
): InboundEmailAnswerFunnel => {
  const { block, bus, resolveEmailAccountSlug, readInboundMail, log } = deps;
  let unsubscribe: (() => void) | null = null;

  const handle = async (event: WarehouseEvent): Promise<void> => {
    // A reply is a fresh message; ignore is-read flips / re-sync `updated`.
    if (event.event_kind !== 'created') return;
    // Only the notification account's mailbox carries inbound replies.
    const accountSlug = resolveEmailAccountSlug!();
    if (accountSlug === null || event.slug !== accountSlug) return;
    // Re-read: the mail adapter emit leaves `event.record` absent.
    const rec = await readInboundMail!(event.slug, event.record_id);
    if (rec === null) return;
    // Skip the server's own sent ask-copy (the leaf's MUST).
    if (isSentFolder(rec.folder)) return;
    const ask_id = extractAskId(rec.subject);
    if (ask_id === null) return;
    // Load the ask for its options; skip an unknown / already-resolved ask.
    const ask = await block!.getAsk(ask_id);
    if (ask === null || ask.status !== 'open') return;
    const reply = parseEmailReply(
      { subject: rec.subject, body_text: rec.body_text },
      ask.options,
    );
    if (reply === null) return;
    // First-answer-wins dedup (I-6) inside the block makes a re-seen reply
    // a no-op; the block validates the option + dispatches `on_answer`.
    await block!.submitAnswer(reply);
    log?.('info', 'inbound email reply recorded', {
      ask_id,
      option: reply.option,
    });
  };

  return {
    start(): void {
      if (
        block === undefined ||
        bus === undefined ||
        resolveEmailAccountSlug === undefined ||
        readInboundMail === undefined
      ) {
        log?.('info', 'inbound email answer funnel inert — missing deps');
        return;
      }
      if (unsubscribe !== null) return; // idempotent
      unsubscribe = bus.subscribe('data.mail.**', (event) => {
        // Fire-and-forget: a warehouse-bus listener must NEVER throw into the
        // emit path (it would break every other subscriber, incl. the reactive
        // trigger dispatcher). `handle` is async, so EVERY throw it can raise —
        // including one from its pre-await prefix (an injected seam that throws)
        // — surfaces as a promise rejection, so this single `.catch` is a
        // complete guard; there is no synchronous throw path to guard.
        void handle(event).catch((error) => {
          log?.('warn', 'inbound email answer funnel — handler threw', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      });
    },
    dispose(): void {
      if (unsubscribe !== null) {
        unsubscribe();
        unsubscribe = null;
      }
    },
  };
};
