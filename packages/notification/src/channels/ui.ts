/** D-158 P0 / D-163 P0 — the always-on `ui` channel (A.4 / A.7).
 *
 *  `ui` is the one channel that is always enabled and cannot be
 *  disabled (D-158 N.4). It renders in the webclient via the D-121
 *  broadcast bus.
 *
 *  D-163 N.7 unwinds the historical slice-4 UI/Bridge coupling — Bridge
 *  is now a first-class `'notify-only'` channel (`channels/bridge.ts`)
 *  with its own Settings row, install CTA, and readiness probe.
 *  `createUiChannel` becomes a clean inline-only adapter again.
 *
 *  Because nothing in `packages/` may import `backend/`, the bus is
 *  reached through an injected `UiBusSink` — `backend/server/` adapts
 *  each `UiNotificationEvent` to a D-121 `ServerEvent`. This is the same
 *  injected-narrow-seam pattern D-160's `ChatBusSink` uses.
 *
 *  Spec: D-158 § A.4 / A.7 + D-163 § N.7.
 */

import type { Channel } from './channel.js';
import type { AskOption, NotificationMessage } from '../types.js';

/** The `ui`-channel broadcast event (A.7). The `ui` channel emits one
 *  of these onto the injected bus sink; `backend/server/` adapts it to
 *  a D-121 `ServerEvent` at wire time.
 *
 *  A.7 fixes this *shape*; the D-121 wire-kind naming is O-1, a P0
 *  wiring decision. P0 resolves O-1 as a dedicated `notification.*`
 *  event family — NOT an overload of D-125's pre-existing `notification`
 *  `ServerEvent` kind, which is the `notification-send` ingredient's
 *  in-app delivery, a separate concern from this block. The three
 *  subkinds:
 *   - `notification.notify`      — a one-way card; no response affordance.
 *   - `notification.ask`         — an interactive card carrying `ask_id`
 *                                  + `options`; the webclient renders
 *                                  response buttons and posts the chosen
 *                                  option back as an inbound reply.
 *   - `notification.ask_closed`  — resolves a card once the ask is
 *                                  answered or closed on another channel. */
export type UiNotificationEvent =
  | { kind: 'notification.notify'; message: NotificationMessage }
  | {
      kind: 'notification.ask';
      ask_id: string;
      message: NotificationMessage;
      options: readonly AskOption[];
    }
  | { kind: 'notification.ask_closed'; ask_id: string };

/** Emits a `ui` event onto the D-121 broadcast bus. `backend/server/`
 *  supplies a sink that adapts each event to a `ServerEvent` and fans
 *  it out to every paired client. */
export type UiBusSink = (event: UiNotificationEvent) => void;

export interface UiChannelOptions {
  /** The D-121 bus seam — always present (`ui` is always-on). */
  busSink: UiBusSink;
}

/** Create the always-on `ui` channel. The webclient renders the bus
 *  events; an inbound `ui` reply (a webclient HID response) is funnelled
 *  into the block's `submitAnswer` by `backend/server/` over the pair-
 *  authenticated bus, not through this adapter.
 *
 *  D-163 N.7 — `ui` is `'inline'`: the webclient card renders both the
 *  ask body and the option buttons. Bridge OS notifications are a
 *  separate channel (`channels/bridge.ts`); they no longer ride
 *  underneath `ui`. */
export const createUiChannel = (opts: UiChannelOptions): Channel => {
  return {
    name: 'ui',
    capability: 'inline',
    // D-163 amendment / D-167 § "Channel ownership signal" — the
    // webclient renders the card and Recued performs restore-on-display,
    // so Recued owns the LLM↔user boundary here.
    owns_llm_egress: true,

    async deliverNotify(message) {
      opts.busSink({ kind: 'notification.notify', message });
    },

    async deliverAsk(ask_id, message, options) {
      opts.busSink({ kind: 'notification.ask', ask_id, message, options });
    },

    async closeAsk(ask_id) {
      opts.busSink({ kind: 'notification.ask_closed', ask_id });
    },
  };
};
