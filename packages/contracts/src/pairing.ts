import type { BroadcastEventKind } from './events.js';
import type { ServerCapabilityProfile } from './passport.js';

/** D-121 direct pairing contracts.
 *
 *  The active pair path is the CLI-issued code plus recovery-key POST
 *  to `/auth/pair`. The former D-121 cloud pair-blob relay was retired
 *  by D-156 and deleted in 2026-06; only the direct pairing-code
 *  parameters and paired-client subscription defaults remain here.
 */

// ────────────────────────────────────────────────────────────────
// Pairing-code generation parameters
// ────────────────────────────────────────────────────────────────

/** Pairing-code character set. URL-safe, no ambiguous glyphs
 *  (excludes 0/O, 1/l/I to prevent typo-from-display when shown
 *  to user via path 1). Length 8 = ~46 bits entropy, ~10^14
 *  search space — adequate when paired with cloud-side rate-limit. */
export const PAIRING_CODE_CHARSET =
  '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';

/** Length of a pairing code in characters. */
export const PAIRING_CODE_LENGTH = 8;

/** Validation regex for the public-facing pairing code shape. */
export const PAIRING_CODE_REGEX = /^[2-9A-HJ-NP-Za-km-z]{8}$/;

// ────────────────────────────────────────────────────────────────
// D-121 Phase 6 — paired-client lifecycle constants
// ────────────────────────────────────────────────────────────────

/** The catch-all paired-client subscription CONCEPT — every bus kind, listed
 *  alphabetically for diffability. Pinned equal to `ALL_BROADCAST_EVENT_KINDS`
 *  by `apps/webclient/src/__tests__/subscriber.test.ts`, so the two cannot
 *  drift.
 *
 *  ⚠ NO CLIENT SUBSCRIBES TO THIS, and that is correct, not a gap. Each surface
 *  names its own set sized to its live UI consumers — `WEBCLIENT_DEFAULT_
 *  SUBSCRIPTIONS` (54) and `BRIDGE_DEFAULT_SUBSCRIPTIONS` (5, the Bridge being
 *  a deliberately narrow DOM + notification surface). The zero-consumer export
 *  audit reports this constant for exactly that reason; it is answered here
 *  rather than re-investigated. Blanket-subscribing a client to every kind
 *  would hand it traffic it has no listener for.
 *
 *  ⛔ THE COROLLARY THAT COST TIME: the server fans only the kinds a client
 *  NAMES, so a handler for an unnamed kind is dead on the wire — no error, no
 *  event, just a branch that never runs. `chat.data_diagnosis_resolved` was
 *  handled by the webclient reducer from 2026-07-24 and unsubscribed until
 *  2026-08-11. Adding a broadcast handler is not done until the kind is in that
 *  client's list. */
export const DEFAULT_SUBSCRIPTIONS: BroadcastEventKind[] = [
  'approval',
  // Reactive-substrate slice 1 — automation rule mutations (trigger
  // CRUD / auto-run toggle / dispatcher auto-disable). Paired clients
  // subscribe by default so the Automation governance surface stays
  // live across devices.
  'automation_rule_changed',
  // D-148 § A.6.5 — TLS cert rotation pre-notice + revert. Every
  // paired client subscribes by default so the two-pin overlap
  // protocol works for clients that come online during the rotation
  // notice replay window.
  'cert.rotation_notice',
  'cert.rotation_reverted',
  'chat.connection_mcp_annotation_changed',
  'chat.data_diagnosis_resolved',
  'chat.default_model_pref_changed',
  'chat.disambiguation_proposed',
  'chat.inbound_token_changed',
  'chat.message_complete',
  'chat.plan_proposed',
  'chat.plan_resolved',
  'chat.session_changed',
  'chat.token_streamed',
  'chat.tool_call_completed',
  'chat.tool_call_started',
  'chat.tool_catalog_scope_changed',
  'chat.transparency',
  // D-165 enroll-host #1 — vendor OAuth completion signal. Every paired
  // client opts in by default (DEFAULT_SUBSCRIPTIONS covers every kind);
  // the client that started the flow claims the credential point-to-point
  // off the `flow_id`, siblings ignore on flow_id mismatch.
  'connection.vendor_oauth_completed',
  // D-171 — `contract_definition` lifecycle (mint / revoke). Paired
  // clients subscribe by default so the Settings → Privacy → Contracts
  // inspector + the MCP door's Advanced cap/expiry summary live-sync
  // across devices off the authoritative bus event.
  'contract.contract_definition_changed',
  // D-177 N.13 (P6b) — staged-trust suggestion surfaced. Paired clients
  // subscribe by default so the D-174 `#contracts` "Suggested rules" badge
  // refreshes live; the suggestion content itself is re-listed via the P6c
  // rpc (owner-surface only, never model-visible — N.9.1).
  'contract.delegation_rule_suggested',
  'contract.delegation_rule_suggestion_resolved',
  // D-177 N.11 rule 5 (5.c, slice C) — scoped-grant proposal surfaced /
  // resolved. Same default-subscribe + re-list-via-owner-rpc posture as the
  // delegation suggestion kinds.
  'contract.scoped_grant_suggested',
  'contract.scoped_grant_suggestion_resolved',
  'enrichment_drift_detected',
  'enrichment_promotion_suggested',
  'entitlement',
  'execution',
  // D-148 § A.7 — exposure transition. Paired clients refresh their
  // connection assumptions (per-path toggle grid + preset badge) off
  // the bus without re-fetching the passport.
  'exposure_changed',
  'housekeeping_cycle',
  'memory',
  'merge_candidate',
  'merge_scan_progress',
  'notification',
  // D-157 server-wiring — `notification.*` events back the `ui` channel
  // of the D-158 notification block. Paired webclients render notify
  // cards (`notification.notify`), interactive ask cards
  // (`notification.ask`), and close-broadcasts that resolve a card on
  // every surface (`notification.ask_closed`). Subscribed by default
  // so a webclient that comes online during an outstanding ask
  // re-renders it from the bus replay.
  'notification.ask',
  'notification.ask_closed',
  // D-169 P2 Slice 4 (live-mode propagation) — per-bridge notification
  // mode change. Default-subscribed so the bus ratchet (DEFAULT_SUBSCRIPTIONS
  // covers every kind) holds; the bridge opts in via its own
  // BRIDGE_DEFAULT_SUBSCRIPTIONS to flip its approval gate live.
  'notification.bridge_mode_changed',
  'notification.notify',
  // D-145 PA10 follow-on — bulk-pack install / uninstall completion.
  // Subscribed by default so every paired client's Settings → Packs
  // panel refreshes when another client (or the server's foundation-
  // pack pre-install at boot) lands or removes a pack. Per-pair
  // fan-out only — pack installs are scoped to the pair.
  'pack_installed',
  'pack_uninstalled',
  // D-156 follow-on — paired-device roster changed (pair add / revoke).
  // Subscribed by default so every paired client's Settings → Devices
  // roster live-refreshes when another client pairs a new device or
  // revokes one, without a manual reload.
  'pair.list_changed',
  'reactive_fire',
  // D-149 P3 § A.3 — reception broadcast kinds; paired clients
  // re-render Settings → Server → Reception and the listener's
  // in-memory registry cache invalidates per Must Hold I-5.
  'reception.emergency_disabled',
  'reception.endpoint_changed',
  // D-173 N.2 — Reception Inbox item resolved (approve / reject). Paired
  // clients drop the resolved held item from the inbox view off the bus
  // without a follow-up `reception.inbox.list`.
  'reception_inbox',
  // R2 build step 4c.4 — derived recipe runnability changed. Every paired
  // client subscribes by default (DEFAULT_SUBSCRIPTIONS covers every kind) so
  // the recipes view live-refreshes each recipe's runnable/degraded/blocked
  // status after a connection / grant / pack mutation, off the bus snapshot.
  'recipe_runnability_changed',
  'remerge_prompt',
  'schedule',
  'service',
  // D-153 P7 — session lifecycle transition. Paired clients refresh
  // their session UI (spinner / done badge) from the bus without
  // polling the session rpc.
  'session_lifecycle',
  // Supervision feature — a supervised cli daemon's runtime state moved
  // (crash / auto-restart / ceiling). Paired clients subscribe by default so
  // the pack-detail supervised-daemon controls re-list live; subscribers
  // re-list via `supervision.list` (narrow payload, no runtime blob).
  'supervision',
  // D-148 § A.4.4 — webclient/bridge bearer rotation push. Every
  // paired client subscribes by default; non-target subscribers
  // filter on `target_token_id` mismatch so a rotation for the
  // user's laptop bearer is a no-op on the user's phone PWA.
  'token.rotated',
  // D-257 — update-run phases, mirrored from the ledger.
  'update.progress',
  'upstream_merge_failed',
  'warehouse',
];
