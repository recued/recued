/** D-160 P0 — the stream `Channel` contract (continuous / bidirectional).
 *
 *  A `Channel` is the *surface* a conversation is carried over. D-160's
 *  channel is the continuous sibling of D-158's discrete notification
 *  channel: a transparency out-stream flows OUT, user messages arrive
 *  IN, turns iterate. P0 ships the contract + two channels (`chat`,
 *  `messenger`); the framework (`@recued/middleware`) that drives turns
 *  over a channel is D-160 P1.
 *
 *  The contract lives in `@recued/chat` because `chat` is the always-on
 *  surface; `@recued/messenger` type-imports it. Neither names the other
 *  at runtime — `messenger` imports these as `import type` only.
 *
 *  Spec: D-160 § N.2 / N.5 / N.6 / A.5.
 */

import type { ChatMessageAttachment, ExecutionSource } from '@recued/contracts';

/** Identifies which surface a conversation entry / out-stream event
 *  belongs to. One conversation, many windows — `chat` is the in-app
 *  webclient surface; `messenger-<vendor>` is the same conversation
 *  seen over an external app (D-160 N.5 / A.5).
 *
 *  D-192 CORE #6: the messenger arm is the open template
 *  `` `messenger-${string}` `` rather than a closed `messenger-slack |
 *  messenger-telegram` union, so a new chat transport (Discord / Teams /
 *  …) needs no edit here — the surface is built from the vendor slug at
 *  `createMessengerChannel`, and the `<vendor>` is validated at runtime
 *  against the messenger-vendor registry (`isDeclaredMessengerVendor`,
 *  `@recued/contracts`) by the consumers that dispatch on it. `chat` stays
 *  a distinct literal so `surface === 'chat'` still narrows. `email` is a
 *  D-158 discrete channel, never a messenger surface. */
export type SurfaceTag = 'chat' | `messenger-${string}`;

/** Extract the vendor slug from a `messenger-<vendor>` surface tag, or
 *  `null` for the `chat` surface (or any non-`messenger-` tag). Pairs with
 *  the `` `messenger-${vendor}` `` construction in `createMessengerChannel`.
 *  A pure string split with NO registry coupling (keeps `@recued/chat` free
 *  of the contracts registry import) — the caller validates the returned
 *  slug against the registry (`isDeclaredMessengerVendor`). */
export const surfaceMessengerVendor = (surface: SurfaceTag): string | null => {
  const prefix = 'messenger-';
  return surface.startsWith(prefix) && surface.length > prefix.length
    ? surface.slice(prefix.length)
    : null;
};

/** One event the framework hands a channel to carry OUT to the user.
 *  A turn is internal (D-160 N.2); what reaches the user is this
 *  selective projection over turns — the transparency out-stream (N.6).
 *  Each channel decides which kinds its surface can render. */
export type ChannelOutbound =
  | { kind: 'token'; session_id: string; turn_id: string; delta: string }
  | { kind: 'transparency'; session_id: string; turn_id: string; note: string }
  | { kind: 'message'; session_id: string; turn_id: string; text: string }
  | { kind: 'done'; session_id: string; turn_id: string };

/** A user message arriving IN on a channel. The channel is the producer
 *  of the `(channel × actor)` `ExecutionSource` — the carrier the
 *  gateway's policy matrix keys on (D-153).
 *
 *  `dispatch_depth` is the D-160 I-7 / D-145 #22 loop-bound hop token,
 *  threaded onto channel ingress by D-160 P3. It rides as a *sibling*
 *  of `source` — deliberately NOT folded into the `ExecutionSource`
 *  policy-matrix key — mirroring how `dispatch_depth` already sits
 *  beside `source` on `Commit` and `CommitRunIdentity`: policy identity
 *  and dispatch-tree depth stay orthogonal. */
export interface ChannelInbound {
  session_id: string;
  surface: SurfaceTag;
  text: string;
  /** Sender identity on the surface — a `user_id` for `chat`, a
   *  vendor-surface sender id for `messenger`. */
  from: string;
  source: ExecutionSource;
  /** File refs carried by this inbound turn. The bytes stay in
   *  `data.file.received`; the turn only carries refs. */
  media?: ChatMessageAttachment[];
  /** Dispatch-tree depth of the run this inbound triggers — the I-7
   *  loop-bound hop token. `0` for a genuine top-level user message; a
   *  re-entrant hop — a `messenger` post that re-enters as a trigger —
   *  carries `nextDispatchDepth(parent)`. The run's `CommitRunIdentity`
   *  inherits it, and the Gateway refuses dispatch once it passes
   *  `MAX_DISPATCH_DEPTH`, bounding a `messenger`→trigger→`messenger`
   *  loop (D-160 I-7 / TR-6, D-145 #22). */
  dispatch_depth: number;
  ts: number;
}

/** The sink the framework's turn loop registers on a channel; invoked
 *  once per inbound user message. */
export type InboundHandler = (message: ChannelInbound) => void | Promise<void>;

/** The D-160 continuous channel. `deliver` carries one out-stream event
 *  to the user; `onInbound` registers the handler the framework runs
 *  when a user message arrives. The channel-specific *entry point* that
 *  feeds an inbound message (`chat`'s `receiveUserMessage`, `messenger`'s
 *  `ingest`) is each channel's own surface. */
export interface Channel {
  readonly surface: SurfaceTag;
  deliver(event: ChannelOutbound): Promise<void>;
  onInbound(handler: InboundHandler): void;
}
