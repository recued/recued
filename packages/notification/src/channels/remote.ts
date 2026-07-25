/** D-158 P2 — the transport-backed remote `Channel` (slack / telegram).
 *
 *  Slack and Telegram are structurally one channel — both wrap a
 *  `@recued/transport` `Transport` and differ only in which vendor
 *  transport is injected. `createRemoteChannel` is that one adapter; the
 *  channel's `name` is the transport's `vendor`. (The spec's A.1 sketch
 *  lists `channels/slack.ts` + `channels/telegram.ts`; one factory keyed
 *  on `transport.vendor` is the DRY realization — the two adapters would
 *  be byte-identical but for that one value.)
 *
 *  Outbound: `deliverNotify` → `transport.send`; `deliverAsk` →
 *  `transport.sendPrompt` (interactive option buttons — the `ask_id`
 *  rides as the prompt `correlation_id`); `closeAsk` →
 *  `transport.closePrompt` (best-effort — strips a still-open prompt's
 *  buttons).
 *  Inbound: `parseInboundReply` decodes an already-authenticated vendor
 *  callback payload into an `InboundReply` for the block's `submitAnswer`.
 *
 *  Leaf posture (mirrors P0 / P1): the block is a leaf and cannot reach
 *  the connection store or the D-148 P9 webhook port. The BYO credential
 *  is an injected `CredentialResolver` seam; inbound *authentication* is
 *  the server's webhook port (D-148 P9 `verifySignature`), upstream of
 *  `parseInboundReply` — this adapter only ever parses an already-
 *  verified payload (the I-9 contract: an `InboundReply` is trusted,
 *  authentication is the inbound path's responsibility — see types.ts).
 *
 *  P2a limitation (→ D-158 P3 hardening): the `ask_id → vendor message`
 *  map is in-memory and process-scoped. Within a process it makes
 *  `deliverAsk` idempotent (a re-delivery is a no-op, not a second
 *  message) and lets `closeAsk` strip the buttons. Across a restart the
 *  map is empty: the boot re-delivery sweep re-posts the prompt, and
 *  `closeAsk` no-ops. Both are harmless — the block's first-answer-wins
 *  dedup makes a stale button safe — but persisting the vendor message
 *  id is D-158 P3.
 *
 *  Spec: D-158 § P2 / A.4 / I-9.
 */

import type {
  InteractiveTransport,
  ParsedInbound,
  TransportSendResult,
} from '@recued/transport';
import type { Channel } from './channel.js';
import type {
  ChannelName,
  InboundReply,
  NotificationMessage,
} from '../types.js';
import { isChannelName } from '../types.js';

/** The BYO credential a remote channel sends with — resolved fresh per
 *  delivery from `connection.notification` (D-125). */
export interface RemoteChannelCredential {
  /** The send token, already decrypted — resolved through the messenger
   *  send-credential seam (`resolveMessengerSendToken`), never read off a raw
   *  `auth.token` field. */
  token: string;
  /** The vendor-surface destination — a Slack channel id, a Telegram
   *  chat id. */
  recipient: string;
}

/** Resolves the remote channel's current `connection.notification`
 *  credential, or `null` when none is enrolled (the channel was
 *  enabled, then its credential later deleted). Injected — the block is
 *  a leaf and cannot reach the connection store. */
export type CredentialResolver = () => Promise<RemoteChannelCredential | null>;

/** A remote `Channel` plus its inbound parsers. The block consumes the
 *  `Channel` surface; the server's webhook port uses
 *  `parseInboundReply` to funnel an authenticated vendor callback into
 *  `block.submitAnswer`, and `parseInboundMessage` to surface a regular
 *  user message (the WatchSource messenger push source). */
export interface RemoteChannel extends Channel {
  /** Decode an already-authenticated (I-9) inbound vendor callback
   *  payload into an `InboundReply`, or `null` when the payload is not
   *  a recognizable option selection. */
  parseInboundReply(payload: unknown): InboundReply | null;
  /** Decode an already-authenticated (I-9) inbound vendor payload into
   *  a plain user message, or `null` for anything that is not one
   *  (control events, bot echoes, button presses — the vendor payload
   *  shapes are disjoint from `parseInboundReply`'s, but call this on
   *  the reply-null fall-through anyway so a press is never
   *  double-classified). Delegates to `transport.parseInbound`. */
  parseInboundMessage(payload: unknown): ParsedInbound | null;
}

export interface RemoteChannelDeps {
  /** The vendor transport — `createSlackTransport()` /
   *  `createTelegramTransport()`, which return the interactive superset.
   *  The channel's `name` is the transport's `vendor`. */
  transport: InteractiveTransport;
  /** Resolves the BYO `connection.notification` credential, per call. */
  resolveCredential: CredentialResolver;
}

/** The text a closed (button-stripped) prompt is left showing — the
 *  original message, with the title inlined since the option buttons
 *  that carried the visual structure are gone. */
const composeCloseText = (message: NotificationMessage): string =>
  message.title !== undefined
    ? `${message.title}\n\n${message.text}`
    : message.text;

/** Create a transport-backed remote channel. */
export const createRemoteChannel = (
  deps: RemoteChannelDeps,
): RemoteChannel => {
  const { transport, resolveCredential } = deps;
  // D-192 CORE #6 — `Transport.vendor` widened to an open slug; a transport-
  // backed remote channel's name IS its vendor and must be a registered
  // notification `ChannelName`. Fail loud if a transport is wired whose vendor
  // isn't a known channel (a new messenger transport must be added to
  // CHANNEL_NAMES first — seam 10).
  if (!isChannelName(transport.vendor)) {
    throw new Error(
      `createRemoteChannel: transport vendor '${transport.vendor}' is not a registered notification channel`,
    );
  }
  const name: ChannelName = transport.vendor;

  /** ask_id → what `closeAsk` needs to strip a delivered prompt's
   *  buttons. In-memory, process-scoped (see the file header for the
   *  restart limitation). */
  const delivered = new Map<
    string,
    { vendor_message_id: string; close_text: string }
  >();

  const credentialOrThrow = async (
    op: string,
  ): Promise<RemoteChannelCredential> => {
    const credential = await resolveCredential();
    if (credential === null) {
      throw new Error(
        `${name} channel: ${op} — no connection.notification credential enrolled`,
      );
    }
    return credential;
  };

  /** A `Channel` signals a failed delivery by throwing — the block's
   *  fan-out / notify paths are best-effort and catch. Bridge the
   *  transport's discriminated `{ ok: false }` to that contract. */
  const throwOnFailure = (result: TransportSendResult, op: string): void => {
    if (!result.ok) {
      throw new Error(
        `${name} channel: ${op} — ${result.error.kind}: ${result.error.detail}`,
      );
    }
  };

  return {
    name,
    capability: 'inline',
    // D-163 amendment / D-167 § "Channel ownership signal" — Slack /
    // Telegram are external apps that own downstream presentation;
    // Recued has no restore-on-display hook, so it does not own the
    // LLM↔user boundary here.
    owns_llm_egress: false,

    async deliverNotify(message) {
      const { token, recipient } = await credentialOrThrow('deliverNotify');
      const result = await transport.send({
        recipient,
        token,
        text: message.text,
        ...(message.title !== undefined ? { title: message.title } : {}),
        ...(message.link_url !== undefined ? { link_url: message.link_url } : {}),
      });
      throwOnFailure(result, 'deliverNotify');
    },

    async deliverAsk(ask_id, message, options) {
      // Within-process idempotency — the boot re-delivery sweep, or any
      // double call, must not post a second prompt for an ask already
      // delivered this process.
      if (delivered.has(ask_id)) return;
      const { token, recipient } = await credentialOrThrow('deliverAsk');
      const result = await transport.sendPrompt({
        recipient,
        token,
        text: message.text,
        ...(message.title !== undefined ? { title: message.title } : {}),
        // The ask_id IS the transport correlation token — it round-
        // trips through the vendor callback and comes back on the press.
        correlation_id: ask_id,
        options: options.map((option) => ({
          id: option.id,
          label: option.label,
        })),
      });
      throwOnFailure(result, 'deliverAsk');
      // result.ok holds past throwOnFailure. Record the vendor message
      // id for closeAsk; a success that omits the id leaves the prompt
      // uncloseable — stored as '' so a re-delivery is still suppressed
      // and closeAsk no-ops on it.
      delivered.set(ask_id, {
        vendor_message_id:
          result.ok && result.vendor_message_id !== undefined
            ? result.vendor_message_id
            : '',
        close_text: composeCloseText(message),
      });
    },

    async closeAsk(ask_id) {
      const entry = delivered.get(ask_id);
      // Unknown ask — never delivered this process, or delivered before
      // a restart — or delivered with no vendor message id: a no-op,
      // per the `Channel.closeAsk` contract.
      if (entry === undefined || entry.vendor_message_id === '') return;
      // Best-effort throughout — a credential that has since vanished,
      // or a failed close, leaves a stale (but, per the block's first-
      // answer-wins dedup, harmless) button; `closeAsk` never throws.
      const credential = await resolveCredential();
      if (credential === null) return;
      await transport.closePrompt({
        recipient: credential.recipient,
        token: credential.token,
        vendor_message_id: entry.vendor_message_id,
        text: entry.close_text,
      });
    },

    parseInboundReply(payload) {
      const choice = transport.parseInboundChoice(payload);
      if (choice === null) return null;
      // correlation_id IS the ask_id (deliverAsk set it); option_id IS
      // the chosen AskOption.id. The block's `submitAnswer` re-validates
      // the option against the persisted ask and dedups.
      return {
        ask_id: choice.correlation_id,
        option: choice.option_id,
        via: name,
      };
    },

    parseInboundMessage(payload) {
      return transport.parseInbound(payload);
    },
  };
};
