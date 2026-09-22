/** D-148 § A.4.2 — broadcast bus subscriber.
 *
 *  The webclient subscribes to the per-pair broadcast bus on connect.
 *  This module is a typed dispatcher over the inbound `server_event`
 *  envelope: parses the envelope, narrows on `kind`, dispatches to
 *  registered listeners. Adding a new kind subscription is a single-
 *  line change in the listener registry — the dispatcher itself
 *  doesn't grow.
 *
 *  The subscriber owns the `events.subscribe` rpc round-trip: at
 *  connect time it sends the `SubscribeRequest` envelope with the
 *  default kind set + the persisted `cursor_since` (read from
 *  sessionStorage's last-known position). The webclient never
 *  re-derives state; it asks the server for `state.snapshot` per
 *  surface and lets broadcast events fan out edits.
 */

import { BROADCAST_EVENT_KIND_SET } from '@recued/contracts';
import type {
  BroadcastEventKind,
  ServerEvent,
} from '@recued/contracts';

/** Default subscription set for a webclient. The server fans only the
 *  kinds a client names, so this list should follow webclient-owned
 *  UI consumers instead of blindly mirroring every bus kind.
 *  `DEFAULT_SUBSCRIPTIONS` remains the paired-client catch-all in
 *  contracts; this list is the webclient display surface. */
export const WEBCLIENT_DEFAULT_SUBSCRIPTIONS: ReadonlyArray<BroadcastEventKind> = [
  // D-174 — #approvals deep queue. The route also opens the legacy
  // `approval.subscribe` push path, but the D-121 bus emits per-id
  // `approval` pending/resolved invalidations; subscribe so paired
  // clients refresh `approval.list` without a manual reload.
  'approval',
  // Reactive-substrate slice 1 — automation rule mutations (trigger
  // CRUD / auto-run toggle / dispatcher auto-disable). The #automation
  // route + the recipes route's in-context panel both re-list off it;
  // without this entry the server never fans the kind to webclients
  // (D-169 TR-10: only named kinds fan) — codex MEDIUM fold.
  'automation_rule_changed',
  // D-148 § A.6.5 — TLS cert rotation pre-notice + revert. The
  // webclient's pinned `current_fingerprint` + `next_fingerprint`
  // track the server's two-pin overlap protocol; the notice replay
  // window covers offline clients catching up.
  'cert.rotation_notice',
  'cert.rotation_reverted',
  // D-137 P1.4 — chat surface lives on the webclient PWA per D-148
  // § A.4. The full 7-kind chat-event family per § Wire A:
  //   token_streamed / tool_call_started / tool_call_completed /
  //   plan_proposed / transparency / message_complete / session_changed
  // Each fans out via the per-pair D-121 broadcast bus so a turn that
  // lands on Mary's laptop also surfaces on her phone PWA.
  'chat.message_complete',
  'chat.plan_proposed',
  'chat.session_changed',
  'chat.token_streamed',
  'chat.tool_call_completed',
  'chat.tool_call_started',
  // ⛔ ADDED 2026-08-11 — the reducer had handled this since 2026-07-24 and
  // never received it. `chat/state.ts` carries it in `CHAT_THREAD_EVENT_KINDS`
  // and branches on it (`patch an owner-confirmed safe-check resolution`), but
  // the server fans only the kinds a client NAMES, so the handler was
  // unreachable for two and a half weeks: written, typed, tested in isolation,
  // dead on the wire. Nothing failed — an owner who resolved a safe-check on
  // one device simply never saw it clear on another.
  //
  // 🔑 The hand-written `.toContain()` list in `__tests__/subscriber.test.ts`
  // could not catch it: an assertion list only covers the kinds someone
  // remembered to add. The ratchet there now DERIVES the requirement from
  // `isChatThreadEvent`, so the next appended chat kind fails until subscribed.
  'chat.data_diagnosis_resolved',
  // D-137 W2.2 § A.1.1 — Mary's per-kind catalog scope. Fans to every
  // paired client so Settings → Chat → Tool Catalog Scope stays in
  // sync across devices without a manual refresh.
  'chat.tool_catalog_scope_changed',
  // ⛔ D-228 slice 4 — `chat.connection_mcp_annotation_changed` REMOVED. Its
  // stated job was fanning "Settings → Connections → <name> → Tools" edits so
  // the Tier 3 catalog projection refreshed. That panel is deleted (it had zero
  // importers — it was never mounted) and the tier is retired, and a sweep of
  // `apps/webclient/src` finds NO consumer: the kind appeared only in this list.
  //
  // ⚠ The event still FIRES server-side (topic tags / peer signature / chat mode
  // ride it) — this only stops the server fanning it to a client that ignores it.
  //
  // 🔑 THE ZERO IS TRUSTED BECAUSE IT WAS CHECKED AGAINST KNOWN POSITIVES. A
  // literal sweep is exactly the kind that reads the same whether a consumer is
  // absent or merely named differently — so the same sweep was run over four
  // other subscribed `chat.*` kinds first: `chat.tool_catalog_scope_changed`
  // (2 consumer files) and `chat.inbound_token_changed` (4) both surfaced, which
  // is what proves the method can see a consumer when there is one. There is no
  // `onAny` listener in this app, so a kind absent from a literal sweep is
  // absent, full stop.
  //
  // 🔑 The ratchet in `subscriber.test.ts` derives "handled ⇒ subscribed" from
  // the reducer's own predicate; it does NOT check the reverse, so a
  // subscribed-but-unhandled kind like this one is invisible to it. Found by
  // inventory, not by a test.
  // D-171 slice-2c follow-on #2 — the inbound MCP token registry mutated
  // (`chat.inbound_token.{issue,update_grants,update_contract,revoke,delete}`).
  // Subscribed so the #contracts **mcp door** (token reveal + grant
  // checklist + Chat row + Advanced cap/expiry) live-syncs across paired clients:
  // a door edit on Bob's laptop re-renders on his phone without a manual refresh.
  // Per D-169 TR-10 the server fans only the kinds each client names here, so
  // this entry is what makes the panels' `chat.inbound_token_changed` listeners
  // actually fire. (The door's bound `contract_definition` caps/expiry live-sync
  // off the dedicated `contract.contract_definition_changed` kind below — D-171
  // dropped the token proxy that previously stood in for it.)
  'chat.inbound_token_changed',
  'chat.transparency',
  // M-CHAT-1 — chat broadcast kinds that drifted out of this list while
  // staying in the canonical `DEFAULT_SUBSCRIPTIONS`. The server fans only
  // the kinds each client names (D-169 TR-10), so their webclient consumers
  // silently never fired until re-subscribed here:
  //   - `chat.default_model_pref_changed` (D-167) — per-pair global chat-
  //     model default; reduced by `apps/webclient/src/chat/state.ts`.
  //   - `chat.disambiguation_proposed` (D-137 P3 § A.5) — scope-search
  //     disambiguation chips / open-question surface.
  //   - `chat.plan_resolved` (D-137 P3 § A.11) — write-plan approve/cancel
  //     resolution; re-renders the per-message approval card.
  // A lockstep ratchet (`__tests__/subscriber.test.ts`) now pins this list
  // to the closed enum so the class can't silently drift again.
  //
  // ⛔ D-228 slice 5 — `chat.picker_entries_changed` REMOVED with the MCP
  // scope-picker itself. It fanned a `PickerEntry[]` so a client could re-render
  // the Self/peer dropdown; no client ever consumed it, and the surface behind it
  // was dead on both ends (`PeerDispatcher` had zero implementors). A peer's
  // tools now reach chat as ordinary `recued_op_*` pack operations governed by
  // the contract, so there is nothing to switch between.
  //
  // ⚠ Removing it, I also took `chat.default_model_pref_changed` and
  // `chat.disambiguation_proposed` out by anchoring the cut on a comment block
  // that spanned more than its own kind. THE RATCHET BELOW CAUGHT IT — "the
  // reducer handles this and the client never asks for it" is precisely the
  // 2½-week outage it was written for, and it fired within the minute.
  'chat.default_model_pref_changed',
  'chat.disambiguation_proposed',
  'chat.plan_resolved',
  // D-165 slice 3 — vendor OAuth completion. The server fans only the kinds
  // each client subscribes to (D-169 TR-10), so the Settings → Connections
  // enrollment dialog must name this kind for its `{ flow_id }`-only completion
  // frame to arrive: when the user-server finishes the code exchange at
  // `/oauth/complete`, the dialog that started the flow (holding the
  // `claim_secret`) claims the credential point-to-point. Carries no token.
  'connection.vendor_oauth_completed',
  // D-171 — `contract_definition` lifecycle (mint / revoke). The authoritative
  // signal the Privacy → Contracts inspector AND the MCP door's Advanced
  // cap/expiry summary re-list off, so a peer minting / revoking a limit (or
  // this client's own trailing revoke of a prior limit) reflects live without
  // a manual refresh. Replaces the `chat.inbound_token_changed` proxy, which
  // missed the trailing bare `revokeContract` (no token op) — the stale window
  // logged as the slice-2c follow-on #2 residual.
  'contract.contract_definition_changed',
  // D-177 N.13 (P6c) — staged-trust suggestions. The #contracts "Suggested
  // rules" panel re-lists when the housekeeping learner surfaces a NEW
  // suggestion (`suggested` fires on row creation only) and drops/refreshes
  // a card when the owner resolves one on ANY paired client (`resolved` —
  // a dismissal on the laptop must not keep offering standing authority on
  // the phone). Deliberately NOT subscribed until this panel existed (P6b
  // kept the kind out — the ratchet keeps dead kinds out of this list).
  'contract.delegation_rule_suggested',
  'contract.delegation_rule_suggestion_resolved',
  // D-177 N.11 rule 5 — scoped session-grant proposals. The #contracts
  // "Scoped grant proposals" panel (`contracts/scoped-grant-panel.ts`) re-lists
  // when the learner surfaces a NEW proposal (`scoped_grant_suggested`, fired on
  // row creation) and drops/refreshes a card when the owner accepts or dismisses
  // one on ANY paired client (`scoped_grant_suggestion_resolved`). The server
  // fans only the kinds each client names (D-169 TR-10), so these entries are
  // what make the panel's listeners fire. NOTE: a DIFFERENT family from the
  // `contract.delegation_rule_*` block directly above — that's the N.13
  // staged-trust "Suggested rules" panel (`suggested-rules-panel.ts`); these two
  // are the N.11 scoped grants. Pinned ⊆ subs by
  // `SCOPED_GRANT_PANEL_BROADCAST_KINDS` in that panel's own test.
  'contract.scoped_grant_suggested',
  'contract.scoped_grant_suggestion_resolved',
  'enrichment_drift_detected',
  'enrichment_promotion_suggested',
  'entitlement',
  // D-181 slice 5b — the Runs "Active" section. The long-op governor fans
  // queue / slot / kill transitions on the `execution` kind (D-181 §4/§7a:
  // `queued` / `slot_acquired` / `stalled` / `promoted` / `cancelled` /
  // `killed`, alongside the pre-D-181 run-lifecycle ops). The server fans
  // only the kinds each client names (D-169 TR-10), so the webclient must
  // subscribe here for the Active section to re-list off live deltas instead
  // of polling. Previously a deliberately-excluded "dead" kind (no webclient
  // listener) — slice 5b adds the listener, so the subscriber ratchet flips
  // it from the excluded set to the required set.
  'execution',
  // M-XSURF-1 — exposure transition broadcast. The Settings → Server →
  // Exposure grid + "matches preset / Custom" badge re-render off it; the
  // bootstrap consumes it and updates the Reception shell's out-of-band
  // `/reception` public status.
  'exposure_changed',
  'housekeeping_cycle',
  'merge_candidate',
  'merge_scan_progress',
  // D-169 P2 Slice 3b — the webclient D-158 ask (approval) surface
  // (`approvals/asks-panel.ts`). The server fans only the kinds each
  // client subscribes to (D-169 TR-10), so the webclient must name the
  // two interactive-ask bus frames here for them to arrive: a raised ask
  // (`notification.ask`) seeds a card into the Approvals section; a
  // close-broadcast (`notification.ask_closed`, fired once the block
  // records an answer on ANY surface) drops it. Both trigger a re-fetch
  // of the authoritative `notification.pending_asks` list. The legacy
  // `notification` approval-bus kind is intentionally not subscribed here:
  // the webclient has no listener for it.
  'notification.ask',
  'notification.ask_closed',
  // D-169 P2 Slice 4 follow-on — per-bridge notification mode change.
  // The server fans only the kinds each client subscribes to (D-169
  // TR-10), so the webclient must name this kind for the Settings →
  // Notifications per-bridge rows to live-update when another paired
  // client (or this one) toggles a bridge's notification / approval mode
  // via `notifications.set_bridge_mode`. The panel splices the event's
  // inline post-change `modes` into the matching per-bridge row in place
  // — no `notifications.describe_bridges` round-trip.
  'notification.bridge_mode_changed',
  // D-169 P2 Slice 5 — one-way notify frame (`notify-toasts.ts`). The block's
  // `ui`-channel `notify` fans out as this fire-and-forget frame (title? +
  // text, no response affordance); the webclient names it so a notify fired on
  // the server pops an ephemeral toast. (The durable notify feed was retired in
  // R31 delta D — a one-way notice is not audit-log material.)
  'notification.notify',
  // D-145 PA10 follow-on Slice D — bulk-pack install / uninstall
  // completion. Subscribed so the Settings → Packs panel refreshes
  // live when another paired client (or a foundation-pack pre-install
  // at boot) lands or removes a pack. Per-pair fan-out via the
  // D-121 bus; the panel ignores both kinds when its `subscribe?`
  // option isn't wired (test harness path).
  'pack_installed',
  'pack_uninstalled',
  // D-156 follow-on — paired-device roster changed (pair add / revoke).
  // The server fans only the kinds each client names (D-169 TR-10), so the
  // Settings → Devices mount (`devices-page-mount.ts`) must name this kind
  // for its `pair.list_changed` subscriber to fire: a pair on Mary's phone
  // or a revoke on her laptop re-lists the roster on every other open
  // client. The mount re-calls `pair.list` on the event (no single-row
  // reducer — the server-resolved roster stays authoritative).
  'pair.list_changed',
  'reactive_fire',
  // D-149 follow-on § A.9 — the Reception management page (Settings →
  // Server → Reception) lives on the webclient. Both reception broadcast
  // kinds fan to every paired client so Mary's other devices re-render
  // the endpoint list / status header without a manual refresh:
  //   - `reception.endpoint_changed` — per-mutation signal; carries only
  //     `{ op, endpoint_id }`, so the page shell refetches
  //     `reception.endpoints.list` (no single-row reducer).
  //   - `reception.emergency_disabled` — the bulk-kill roll-up; carries
  //     `disabled_count` + `reason`, enough for the shell to apply
  //     `reduceReceptionEmergencyDisabled` optimistically.
  'reception.endpoint_changed',
  'reception.emergency_disabled',
  // D-173 Reception Inbox — the review-then-approve queue
  // (`reception/inbox-panel.ts`). A held inbound operation arriving, or an
  // approve / reject landing on ANY paired client, fans this kind; the panel
  // re-fetches its list off it. The server fans only the kinds each client
  // names (D-169 TR-10), so without this entry the inbox never live-refreshed —
  // it only updated on a manual reload. Distinct from the `reception.*`
  // management-page kinds above (Reception, pinned by
  // `RECEPTION_PAGE_SHELL_BROADCAST_KINDS`). Pinned ⊆ subs by
  // `RECEPTION_INBOX_BROADCAST_KINDS` in that panel's own test.
  'reception_inbox',
  // R2 build step 4c.4 + webclient consumer — derived recipe runnability
  // moved (connection connect/disconnect, operation-group grant change,
  // pack install/uninstall). The #recipes route's per-recipe status pills
  // re-render from the carried full snapshot (identical to the
  // `recipe.runnability` rpc response) without a follow-up read. Closes
  // the live-refresh loop the 4c.4 server emit opened.
  'recipe_runnability_changed',
  'remerge_prompt',
  'schedule',
  'service',
  // D-153 P7 — session lifecycle transition. The webclient is a paired
  // client with session UI (spinner while `executing`, done badge on
  // `closed`); subscribed so it refreshes from the bus without polling.
  'session_lifecycle',
  // Supervision feature — a supervised cli daemon's runtime state moved
  // (crash / auto-restart / ceiling). The pack-detail supervised-daemon
  // controls (`supervision-controls.ts`) re-list off it via `supervision.list`,
  // so a daemon crashing on the server surfaces on every paired client without
  // a Refresh click. (Per D-169 TR-10 the server fans only the kinds named
  // here, so this entry is what makes the controller's listener fire.)
  'supervision',
  // D-148 § A.4.4 — webclient bearer rotation push. The targeted
  // client wraps + persists + applies; sibling clients ignore on
  // `target_token_id` mismatch. Subscribed by default so seamless
  // re-auth works without the user re-pairing.
  'token.rotated',
  // ⛔ D-257 — WITHOUT THIS LINE THE HANDLER IS DEAD ON THE WIRE. The server
  // fans only the kinds a client NAMES, so a reducer case for an unsubscribed
  // kind is unreachable; `chat.data_diagnosis_resolved` sat handled-but-
  // unsubscribed for two and a half weeks.
  'update.progress',
  'upstream_merge_failed',
  // R18 — Data warehouse live-update. The server EMITS these on every warehouse
  // write (contact / work-entity / mirror sync — `kind: 'warehouse'`) + memory
  // write (audit / insight / link — `kind: 'memory'`), but fans only the kinds
  // each client names (D-169 TR-10), so they were "intentionally dead" until the
  // #data route's listener: it re-fetches the current list (warehouse) + any open
  // timeline (memory), debounced, so the explorer reflects background AI /
  // housekeeping writes instead of going stale until a manual refresh.
  // D-282 B4 — a row in a PACK'S OWN Records store changed. The packs route re-runs
  // the open Use-tab view off this; without the entry the server fans nothing and that
  // listener is dead on the wire.
  'records',
  'warehouse',
  'memory',
] as const;

export type BroadcastListener<K extends BroadcastEventKind = BroadcastEventKind> = (
  event: Extract<ServerEvent, { kind: K }>,
) => void;

export interface BroadcastSubscriber {
  /** Register a listener for a specific kind. Returns an unsubscribe
   *  fn. Multiple listeners per kind are allowed; ordering matches
   *  registration order. */
  on<K extends BroadcastEventKind>(kind: K, listener: BroadcastListener<K>): () => void;
  /** Wildcard listener — fires on every inbound event regardless of
   *  kind. Useful for the audit/log surface. */
  onAny(listener: (event: ServerEvent) => void): () => void;
  /** Dispatch a single inbound message into the subscriber. The
   *  message is validated as a `ServerEvent` (kind is in
   *  `BROADCAST_EVENT_KIND_SET`); malformed payloads are dropped
   *  silently — the WS client logs at the transport layer. */
  dispatch(message: unknown): void;
  /** Listener count for diagnostics + tests. */
  size(kind?: BroadcastEventKind): number;
}

/** ⛔⛔ THE MEMBERSHIP CHECK IS THE `ServerEvent` PART OF THE NARROWING, AND IT
 *  WAS MISSING WHILE `dispatch`'s own doc PROMISED IT ("kind is in
 *  `BROADCAST_EVENT_KIND_SET`"). `typeof kind === 'string'` alone asserts
 *  `m is ServerEvent` for any `{ kind: 'anything' }`, so the predicate was
 *  wider than its return type — a lie the compiler cannot see, because a type
 *  predicate is an assertion, not a check.
 *
 *  🔑 HARMLESS ONLY BY ACCIDENT TODAY: the per-kind `Map` lookup misses an
 *  unknown kind anyway, and this app registers no `onAny` listener. The bridge's
 *  copy — which calls itself "a near-verbatim replica of the webclient's
 *  `createBroadcastSubscriber`" — DOES check membership, and it DOES have an
 *  `onAny` listener feeding its bus buffer. So the surface with a wildcard
 *  consumer validates and the surface without one does not, which is backwards
 *  from how the two files describe themselves. Pinned by a parity test. */
const isServerEvent = (m: unknown): m is ServerEvent => {
  if (!m || typeof m !== 'object') return false;
  const e = m as { kind?: unknown };
  return typeof e.kind === 'string'
    && BROADCAST_EVENT_KIND_SET.has(e.kind as BroadcastEventKind);
};

export const createBroadcastSubscriber = (): BroadcastSubscriber => {
  const byKind = new Map<BroadcastEventKind, Set<BroadcastListener>>();
  const wildcard = new Set<(event: ServerEvent) => void>();

  return {
    on<K extends BroadcastEventKind>(kind: K, listener: BroadcastListener<K>) {
      let set = byKind.get(kind);
      if (!set) {
        set = new Set();
        byKind.set(kind, set);
      }
      set.add(listener as unknown as BroadcastListener);
      return () => {
        set?.delete(listener as unknown as BroadcastListener);
        if (set && set.size === 0) byKind.delete(kind);
      };
    },
    onAny(listener) {
      wildcard.add(listener);
      return () => wildcard.delete(listener);
    },
    dispatch(message) {
      if (!isServerEvent(message)) return;
      const set = byKind.get(message.kind);
      if (set) {
        for (const listener of [...set]) {
          try {
            (listener as unknown as (e: ServerEvent) => void)(message);
          } catch {
            // Listener errors are isolated — one broken renderer
            // doesn't take down the dispatch loop.
          }
        }
      }
      for (const w of [...wildcard]) {
        try {
          w(message);
        } catch {
          // Same isolation discipline.
        }
      }
    },
    size(kind) {
      if (kind === undefined) {
        let total = wildcard.size;
        for (const s of byKind.values()) total += s.size;
        return total;
      }
      return byKind.get(kind)?.size ?? 0;
    },
  };
};
