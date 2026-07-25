/** D-160 P0 — the `messenger` channel: the conversation over an external
 *  app (Slack / Telegram).
 *
 *  `messenger` is the same conversation as `chat`, seen through a
 *  different window — it shares the one `SessionStateStore`, tagging
 *  every entry `messenger-<vendor>`. Outbound rides `@recued/transport`
 *  (the shared raw Slack/Telegram plumbing — D-160 N.7); inbound is fed
 *  an already-verified webhook payload (D-148 P9 verifies the HMAC /
 *  secret-token server-side — this channel only parses + routes).
 *
 *  BYO credential — the vendor token is handed in already decrypted; no
 *  app-registration, no setup wizard (D-160 I-10). The `chat` contracts
 *  (`Channel`, `SessionStateStore`, …) are `import type` only — no
 *  runtime edge from this leaf block to its sibling.
 *
 *  Spec: docs/d-160-spec.md § N.5 / A.5 / I-10.
 */

import type { Buffer } from 'node:buffer';
import type { ExecutionSource } from '@recued/contracts';
import type {
  Channel,
  ChannelInbound,
  ChannelOutbound,
  InboundHandler,
  SessionStateStore,
  SurfaceTag,
} from '@recued/chat';
import type { MediaRef, Transport } from '@recued/transport';

export interface MessengerMediaFileSink {
  /** Persist one downloaded media item. The transport streamed it to
   *  `temp_path` (never buffered whole in memory); the sink hands that path to
   *  `BlobStore.putFile` and DELETES the temp after. `head_bytes` carries the
   *  leading bytes so the sink can magic-byte-detect the stored mime (D-172
   *  N.1) rather than trusting the vendor-reported `mime_type` (the fallback). */
  ingest(input: {
    temp_path: string;
    head_bytes: Buffer;
    size: number;
    filename: string;
    mime_type: string;
    source_id: string;
  }): Promise<{ file_id: string; media_class: string }>;
}

export interface MessengerChannelOptions {
  /** The vendor transport — `createSlackTransport()` /
   *  `createTelegramTransport()` from `@recued/transport`. */
  transport: Transport;
  /** The store shared with the `chat` channel — pass the SAME instance
   *  so the two surfaces see one conversation. */
  sessionStore: SessionStateStore;
  /** BYO bearer credential, already decrypted by the caller. */
  token: string;
  /** Vendor-surface recipient the conversation is delivered to (a Slack
   *  channel id, a Telegram chat id). */
  recipient: string;
  /** The conversation this messenger surface is bound to. */
  sessionId: string;
  /** Clock — injectable for deterministic tests; defaults to `Date.now`. */
  now?: () => number;
  /** Optional backend-owned media ingest seam. `@recued/messenger` stays
   *  backend-agnostic; callers inject the data.file.received writer. */
  fileSink?: MessengerMediaFileSink;
}

/** The `messenger` channel plus its inbound entry point. */
export interface MessengerChannel extends Channel {
  /** Feed an already-verified inbound Slack/Telegram payload into the
   *  channel. Wired by `backend/server/`'s D-148 P9 webhook dispatch.
   *  A payload that is not a user text message is silently dropped.
   *  Resolves once the registered inbound handler has been invoked.
   *
   *  `dispatch_depth` is the D-160 I-7 loop-bound hop token stamped onto
   *  the produced `ChannelInbound`. A genuine inbound user message is a
   *  top-level dispatch — depth `0`, the default. A `messenger` post
   *  that re-enters as a trigger (the `messenger`→trigger→`messenger`
   *  hop, TR-6) is re-ingested at `nextDispatchDepth(parent)`; the
   *  Gateway then refuses once the threaded depth passes
   *  `MAX_DISPATCH_DEPTH`, bounding the loop. */
  ingest(payload: unknown, dispatch_depth?: number): Promise<void>;
}

export const createMessengerChannel = (
  options: MessengerChannelOptions,
): MessengerChannel => {
  const now = options.now ?? Date.now;
  const surface: SurfaceTag = `messenger-${options.transport.vendor}`;
  let inboundHandler: InboundHandler | null = null;

  const mediaLabel = (refs: readonly MediaRef[]): string =>
    refs.length === 1 ? refs[0]?.type ?? 'media' : `${refs.length} media attachments`;

  const mediaNote = (note: string): string => `[${note}]`;

  const appendVisibleMediaNote = (
    text: string,
    notes: readonly string[],
  ): string => {
    if (notes.length === 0) return text;
    const suffix = notes.map(mediaNote).join('\n');
    return text.length > 0 ? `${text}\n${suffix}` : suffix;
  };

  return {
    surface,

    async deliver(event: ChannelOutbound): Promise<void> {
      // A messenger surface carries only completed messages — token
      // deltas, transparency notes and done markers are webclient-grain
      // and are not posted to an external app (D-160 N.6 — the
      // out-stream is a selective projection, per channel).
      if (event.kind !== 'message') return;
      // This channel is bound to one conversation; an event for a
      // different session is a wiring mistake — drop it rather than
      // misroute it to this surface's recipient.
      if (event.session_id !== options.sessionId) return;
      // Send first, record only on success: an undelivered turn must not
      // appear in history as if it reached the user. Surfacing the
      // failure upward (retry / an explicit delivery-failed state) is a
      // later-phase concern — `Channel.deliver` carries no error channel.
      const result = await options.transport.send({
        recipient: options.recipient,
        text: event.text,
        token: options.token,
      });
      if (!result.ok) return;
      options.sessionStore.append({
        session_id: options.sessionId,
        surface,
        role: 'assistant',
        text: event.text,
        ts: now(),
      });
    },

    onInbound(handler: InboundHandler): void {
      inboundHandler = handler;
    },

    async ingest(payload: unknown, dispatch_depth = 0): Promise<void> {
      const parsed = options.transport.parseInbound(payload);
      if (parsed === null) return;
      const ts = now();
      const mediaRefs = parsed.media ?? [];
      const media: NonNullable<ChannelInbound['media']> = [];
      const notes: string[] = [];
      if (mediaRefs.length > 0) {
        if (!options.fileSink) {
          notes.push(
            `${mediaLabel(mediaRefs)} received, but file ingest is not configured`,
          );
        } else if (!options.transport.fetchMedia) {
          notes.push(
            `${mediaLabel(mediaRefs)} received, but media fetch is not configured`,
          );
        } else {
          for (const [idx, ref] of mediaRefs.entries()) {
            try {
              const fetched = await options.transport.fetchMedia(ref, options.token);
              const stored = await options.fileSink.ingest({
                temp_path: fetched.temp_path,
                head_bytes: fetched.head_bytes,
                size: fetched.size,
                filename: fetched.filename,
                mime_type: fetched.mime_type,
                source_id: `${parsed.vendor_message_id ?? ts}:${idx}`,
              });
              media.push({
                file_id: stored.file_id,
                media_class: stored.media_class,
              });
            } catch (err) {
              const detail = err instanceof Error ? err.message : String(err);
              notes.push(`${ref.type} media could not be stored: ${detail}`);
            }
          }
        }
      }
      const text = appendVisibleMediaNote(parsed.text, notes);
      options.sessionStore.append({
        session_id: options.sessionId,
        surface,
        role: 'user',
        text,
        ts,
      });
      const source: ExecutionSource = {
        channel: 'messenger',
        actor: 'user_self',
        vendor: options.transport.vendor,
        from: parsed.from,
      };
      const inbound: ChannelInbound = {
        session_id: options.sessionId,
        surface,
        text,
        from: parsed.from,
        source,
        ...(media.length > 0 ? { media } : {}),
        // `0` for a genuine inbound user message; a re-entrant hop — a
        // bot post that re-enters as a trigger — is re-ingested at
        // `nextDispatchDepth(parent)` so the I-7 ceiling bounds the
        // `messenger`→trigger→`messenger` loop (D-160 P3).
        dispatch_depth,
        ts,
      };
      await inboundHandler?.(inbound);
    },
  };
};
