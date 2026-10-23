/** D-163 P0 — the Browser Bridge channel adapter.
 *
 *  D-163 N.4 promotes Bridge from a slice-4 UI sub-component to a
 *  first-class `Channel` with
 *  `name: 'bridge'`, `capability: 'notify-only'`. The block's I-2 filter
 *  keeps `deliverAsk` from ever reaching this adapter; instead, when an
 *  ask is raised, the block fires a passive `deliverNotify` carrying the
 *  webclient ask URL so the user knows an approval is pending and where
 *  to act on it.
 *
 *  The narrow seam: `bridgeSink` — a callback the host injects that
 *  signs + dispatches a `BridgeCommand` to the paired Bridge in
 *  `apps/bridge/`. The adapter never holds engine state and never reads
 *  pair-store state — pair presence is checked separately by the
 *  `ChannelReadinessProbe` the host supplies to Settings (D-163 N.5).
 *
 *  Spec: D-163 § A.3 / N.3-N.4.
 */

import type { Channel } from './channel.js';
import type { AskOption, NotificationMessage } from '../types.js';
import type { NotificationSettings } from '../types.js';
import type { AskDeliveryDestination, AskDeliveryEnvelope, AskDeliveryOutcome, AskDeliveryReceipt } from '../ask-delivery-store.js';

export interface BridgeReminderPort {
  ready(): Promise<boolean>;
  /** Whether a connected bridge is a release from before notification receipts.
   *  It shows plain notifications but never answers the probe `ready` sends, so
   *  it can never confirm a reminder. */
  legacyConnected(): boolean;
  /** The `client_token_id` of every bridge holding a live connection now. */
  connectedIds(): ReadonlySet<string>;
  destinations(settings: NotificationSettings): Promise<AskDeliveryDestination[]>;
  deliver(envelope: AskDeliveryEnvelope): Promise<AskDeliveryOutcome>;
  withdraw(receipt: AskDeliveryReceipt, closed_ask_ids: readonly string[]): Promise<boolean>;
}
export interface BridgeChannel extends Channel {
  bindReminderPort(port: BridgeReminderPort): void;
  reminderReady(): Promise<boolean>;
  /** Whether plain notifications can be switched on: a bridge confirmed it can
   *  show them, or a connected bridge predates that confirmation. Reminders still
   *  need `reminderReady`. */
  notifyReady(): Promise<boolean>;
  /** The paired bridges connected right now, for Settings' Online / Offline.
   *  Empty until the host binds its port. */
  connectedBridgeIds(): ReadonlySet<string>;
  reminderDestinations(settings: NotificationSettings): Promise<AskDeliveryDestination[]>;
}

/** Sink the host injects to dispatch an OS notification through a paired
 *  Browser Bridge. The host signs a `BridgeCommand` from the message
 *  and writes it onto the bridge-bound channel; absent a paired Bridge,
 *  the host's sink should no-op (the readiness probe gates user-side
 *  toggling already — see D-163 § A.4 / N.5). */
export type BridgeSink = (message: NotificationMessage) => void;

export interface BridgeChannelDeps {
  /** Signs + dispatches a `BridgeCommand` to the paired Bridge. */
  bridgeSink: BridgeSink;
}

/** Create the Bridge channel. `'notify-only'` capability — the block's
 *  D-163 N.3 filter excludes this adapter from `ask` fan-out. The
 *  defensive `deliverAsk` body covers the case where a future routing
 *  bug reaches this adapter anyway: rather than silently dropping the
 *  ask, the adapter fires a passive notify so the user at least learns
 *  approval is required. */
export const createBridgeChannel = (deps: BridgeChannelDeps): BridgeChannel => {
  let reminders: BridgeReminderPort | undefined;
  return {
    bindReminderPort(port) { reminders = port; },
    reminderReady: () => reminders?.ready() ?? Promise.resolve(false),
    notifyReady: async () => reminders?.legacyConnected() === true || await (reminders?.ready() ?? false),
    connectedBridgeIds: () => reminders?.connectedIds() ?? new Set<string>(),
    reminderDestinations: settings => reminders?.destinations(settings) ?? Promise.resolve([]),
    deliverAskDelivery: envelope => reminders?.deliver(envelope) ?? Promise.resolve({ outcome: 'not_delivered', error: 'No live OS notification adapter' }),
    withdrawAskDelivery: (receipt, closed) => reminders?.withdraw(receipt, closed) ?? Promise.resolve(false),
    restoreAskDelivery: () => {},
    name: 'bridge',
    capability: 'notify-only',
    // D-163 amendment / D-167 § "Channel ownership signal" — the OS
    // renders the notification body; Recued has no restore-on-display
    // hook, so it does not own the LLM↔user boundary here.
    owns_llm_egress: false,

    async deliverNotify(message) {
      deps.bridgeSink(message);
    },

    async deliverAsk(_ask_id, message, _options) {
      // D-163 N.3 / I-2: the block's filter should never route an ask
      // here. Defense-in-depth fallback — surface a passive notify so a
      // hypothetical routing bug doesn't strand the ask on a one-way
      // surface with no inbound-reply path.
      deps.bridgeSink({
        ...(message.title !== undefined ? { title: message.title } : {}),
        text: `${message.text} — open Recued to approve`,
      });
    },

    async closeAsk(_ask_id) {
      // OS notifications self-dismiss; no inline state to clear.
    },
  };
};
