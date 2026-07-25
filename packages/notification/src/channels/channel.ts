/** D-158 P0 / D-163 P0 — the `Channel` adapter interface (A.4).
 *
 *  A channel is a delivery surface. The block *composes* channels — it
 *  never *contains* channel logic (D-158 N.1). Adding a channel is one
 *  `Channel` implementation + one `ChannelName` value; the `notify` /
 *  `ask` interface and every caller stay unchanged (D-158 N.4).
 *
 *  D-163 widens the interface with a `capability` declaration. The block
 *  uses it to route `ask` fan-out — `'notify-only'` channels are filtered
 *  out (they have no inbound-reply path) and instead receive a passive
 *  `deliverNotify` so the user still knows an approval is pending. The
 *  capability is a STRUCTURAL property of the medium (D-163 I-1): it MUST
 *  NOT vary at runtime; a different mode is a different adapter with a
 *  different `name`.
 *
 *  Spec: D-158 § A.4 / N.4 + D-163 § N.1-N.3.
 */

import type { AskOption, ChannelName, NotificationMessage } from '../types.js';

/** D-163 N.1 — three capability classes. The medium declares which one
 *  applies at construction time; the block reads it once per `ask` /
 *  `notify` to route.
 *
 *  - `'inline'`       — channel renders the ask body AND the option
 *                       buttons in its own surface. UI (D-121 webclient
 *                       cards), Slack (Block Kit `actions` blocks),
 *                       Telegram (inline keyboard).
 *  - `'landing-page'` — channel can deliver a message containing a
 *                       clickable URL but cannot render inline buttons;
 *                       the adapter appends a one-link ask-landing URL
 *                       and the user submits the answer there. Email.
 *  - `'notify-only'`  — channel can deliver a message but cannot reliably
 *                       embed clickable URLs OR action buttons. Bridge
 *                       (OS notifications); future class-3: WeChat,
 *                       iMessage, Signal. The block filters these out of
 *                       `ask` fan-out and fires a passive `deliverNotify`
 *                       instead, carrying the webclient ask URL.
 */
export type ChannelCapability = 'inline' | 'landing-page' | 'notify-only';

/** Closed list constant for iteration / runtime gates. */
export const CHANNEL_CAPABILITIES = [
  'inline',
  'landing-page',
  'notify-only',
] as const satisfies readonly ChannelCapability[];

export const isChannelCapability = (s: unknown): s is ChannelCapability =>
  typeof s === 'string'
  && (CHANNEL_CAPABILITIES as readonly string[]).includes(s);

/** A delivery surface. The block calls every channel uniformly — a
 *  channel adapter names its vendor by construction (a leaf, not a flow
 *  controller), but the block treats them all the same. */
export interface Channel {
  /** Which channel this is. */
  readonly name: ChannelName;

  /** D-163 N.1 — the capability class this medium implements. Set at
   *  construction time, never mutated. */
  readonly capability: ChannelCapability;

  /** D-163 amendment (filed by D-167 § "Channel ownership signal") —
   *  does Recued own the LLM↔user boundary on this medium? `true` iff the
   *  LLM-generated text reaches the user through a Recued-controlled
   *  surface that can restore aliases on the way out (and, for asks, owns
   *  the reply path back). `true` for `ui` (the webclient renders the
   *  card and Recued performs restore-on-display); `false` for `bridge`
   *  (OS notifications the operating system renders), `email` (an
   *  external mail client renders the body), and `slack` / `telegram`
   *  (external apps own downstream presentation).
   *
   *  This is the *no-op seam* the D-167 chat-mode PII-aliasing middleware
   *  reads at hook time — `channel.owns_llm_egress === false` lets that
   *  middleware short-circuit on external-egress channels with no
   *  per-call branching inside its transform logic (D-167 P1 wires the
   *  read; this declaration lands ahead of it per D-167 P0). Like
   *  `capability`, it is a STRUCTURAL, readonly property of the medium —
   *  it MUST NOT vary at runtime. Recipe-mode `pii-protect` /
   *  `pii-restore` are explicit steps unaffected by this flag.
   *
   *  Spec: D-167 § "Channel ownership signal" + P0/P1. */
  readonly owns_llm_egress: boolean;

  /** Deliver a fire-and-forget `notify` to this surface. Collects no
   *  reply. */
  deliverNotify(message: NotificationMessage): Promise<void>;

  /** Deliver an interactive `ask` — the surface renders response
   *  affordances keyed on `ask_id`. MUST be idempotent per `ask_id`:
   *  the boot re-delivery sweep (A.2) may deliver the same ask again
   *  after a crash, and the surface must reconcile onto the existing
   *  prompt rather than double-render.
   *
   *  D-163 N.3 / I-2: the block MUST NOT call this on a `'notify-only'`
   *  adapter. A `'notify-only'` adapter's `deliverAsk` is reachable only
   *  as defensive fallback (e.g. a future routing bug) and should fall
   *  back to a passive notify body — never silently strand the ask. */
  deliverAsk(
    ask_id: string,
    message: NotificationMessage,
    options: readonly AskOption[],
  ): Promise<void>;

  /** Resolve a delivered ask prompt — because it was answered here, or
   *  closed after being answered on another channel (I-6 multi-channel
   *  close). MUST be idempotent: closing an already-closed or unknown
   *  prompt is a no-op. */
  closeAsk(ask_id: string): Promise<void>;
}
