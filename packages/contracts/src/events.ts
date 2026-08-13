/** D-121 Phase 6 — realtime broadcast bus.
 *
 *  Server-to-client typed event stream. Events are fanned out via the
 *  existing pair-WS push channel (same transport as `approval_changed`
 *  / `instance_revoked` / `server_heartbeat` — see
 *  `backend/server/src/ws-server.ts`); clients opt in per kind via
 *  `events.subscribe`, and reconnects replay missed events from the
 *  server's bounded ring buffer (cursor-since semantics on top of
 *  `project_cache_architecture.md`).
 *
 *  Wire envelope used over WS: `{ type: 'server_event', event: ServerEvent }`.
 *  Cursor is server-assigned at emit time and monotonic per `EventBus`
 *  instance — clients track the last value they applied and pass it
 *  back as `cursor_since` on reconnect.
 *
 *  Failure semantics: emits are best-effort. A bus / push failure
 *  never aborts the underlying domain operation — a missed event is
 *  recovered on the next reconnect-replay (or, if the cursor falls
 *  off the ring, by a full collection re-sync). At-least-once
 *  delivery; idempotency at the cache layer (warehouse upsert,
 *  memory insert with hash dedup) handles duplicates. */

// ────────────────────────────────────────────────────────────────
// Server-to-client event union
// ────────────────────────────────────────────────────────────────

import type { NotificationSubtype } from './connection.js';
import type { ExecutionLane } from './execution-lane.js';
import type { HousekeepingYieldReason } from './housekeeping.js';
import type {
  ChatDataDiagnosisResolution,
  ChatDispatchReason,
  ChatModelHint,
  ChatModelRoutingLayer,
  ChatModelSourceId,
  ChatPlanProposal,
  ChatRunHeld,
} from './chat.js';
import type { SessionLifecycleState } from './session-routing.js';
import type { RecipeRunnabilityEntry } from './recipe-runnability.js';
import type {
  DerivedPresetLabel,
  PathResolution,
  PathRole,
  PublicMcpAcknowledgement,
} from './network.js';

/** Server-to-client realtime event union. Discriminated by `kind`;
 *  every variant carries a server-assigned `cursor` (monotonic int)
 *  used for replay-on-reconnect. */
export type ServerEvent =
  | {
      kind: 'warehouse';
      /** Warehouse collection slug (`mail`, `calendar`, `contact`,
       *  `files`, …). Clients filter on this against their own
       *  display routes. */
      collection: string;
      op: 'insert' | 'update' | 'delete';
      /** Record `_id` (canonical for the collection — email-canonical
       *  for `contact`, message-id for `mail`, etc.). */
      id: string;
      cursor: number;
    }
  | {
      kind: 'memory';
      /** Which memory sub-axis fired:
       *    - `audit`   → audit_entries row inserted
       *    - `insight` → recipe_insights row inserted
       *    - `link`    → links row inserted
       *    - `user`    → D-198 owner-authored `user_memory` row written /
       *                  updated / deleted (drives the Memory-lens refresh) */
      subkind: 'audit' | 'insight' | 'link' | 'user';
      id: string;
      cursor: number;
    }
  | {
      kind: 'approval';
      /** `pending` = newly-requested approval; `resolved` = first-write-
       *  wins resolution recorded. Drives the Attention counter +
       *  inline approval card refresh. */
      subkind: 'pending' | 'resolved';
      id: string;
      cursor: number;
    }
  | {
      /** Recipe-run execution lifecycle + (D-181 slice 4) the live
       *  active-list deltas. The pre-D-181 ops (`start` / `progress` /
       *  `complete` / `error`) carry run-lifecycle signals; the added
       *  ops carry the long-op governor's queue/slot/kill transitions so a
       *  subscribed client reconstructs the active list from an
       *  `execution.active` snapshot + these live deltas (D-181 §4/§7a):
       *    - `queued`        — a heavy call blocked on slot acquisition
       *      (`waiting_slot`); carries `queued_call_id` + `lane`.
       *    - `slot_acquired` — the queued call won a slot and is now running.
       *    - `stalled`       — progress-stall flag raised (attended) or
       *      auto-kill imminent (unattended).
       *    - `promoted`      — a queued call moved to its lane's head.
       *    - `cancelled`     — a queued call was cancelled before dispatch.
       *    - `killed`        — a running op was killed by the owner.
       *    - `retired`       — (slice-4 follow-up #2) the run left the
       *      active list (the in-flight registry `completeRun`'d it). The
       *      ONLY membership-removal signal on the durable-pause /
       *      trigger-skipped exit paths, which emit no `complete`/`error`
       *      lifecycle terminal; on the ordinary terminal paths it follows
       *      the `complete`/`error` (a harmless extra re-list, debounced).
       *      A pure membership signal — NOT a lifecycle outcome, so a
       *      consumer that reads run *status* (the Bridge result list)
       *      ignores it. */
      kind: 'execution';
      recipe_id: string;
      run_id: string;
      op:
        | 'start'
        | 'progress'
        | 'complete'
        | 'error'
        | 'queued'
        | 'slot_acquired'
        | 'stalled'
        | 'promoted'
        | 'cancelled'
        | 'killed'
        | 'retired';
      /** Present on the queue-lifecycle ops (`queued` / `slot_acquired` /
       *  `promoted` / `cancelled`) so a delta can identify the queued entry
       *  without a full re-list. Absent on the run-lifecycle ops. */
      queued_call_id?: string;
      /** The governor lane the entry occupies / waits on; present on the
       *  long-op ops, absent on the run-lifecycle ops. */
      lane?: ExecutionLane;
      cursor: number;
    }
  | {
      kind: 'service';
      service_id: string;
      /** `enrolled` = new instance row; `lifecycle` = status change
       *  (start / stop / crash); `error` = lifecycle error. */
      op: 'enrolled' | 'lifecycle' | 'error';
      cursor: number;
    }
  | {
      /** Supervision feature — a supervised cli daemon's runtime state moved
       *  (launched → running / crashed / restarted / stopped /
       *  permanently_crashed). Fired by the server supervisor on the ASYNC
       *  transitions a client can't see — a crash, an auto-restart, the
       *  consecutive-crash ceiling — so the pack-detail supervised-daemon
       *  controls re-list live on every paired client without a Refresh click.
       *  Payload is intentionally narrow (no runtime blob): subscribers re-list
       *  via `supervision.list` so server-resolved state stays authoritative
       *  (the `schedule` / `automation_rule_changed` pattern). Distinct from
       *  `kind: 'service'` — that is the D-118 `data.service.*` collection;
       *  these are the `(ingredient_slug, op)`-keyed supervision daemons. */
      kind: 'supervision';
      ingredient_slug: string;
      op: string;
      cursor: number;
    }
  | {
      kind: 'schedule';
      /** `updated` = create / edit / delete; `fired` = scheduled
       *  recipe just executed. */
      op: 'updated' | 'fired';
      cursor: number;
    }
  | {
      /** Reactive-substrate slice 1 — an automation rule (an
       *  event-trigger row or a recipe's auto-run arm/disarm state)
       *  mutated. Drives the Automation governance surface + the
       *  per-recipe execution panels on every paired client without
       *  polling. Fires on `triggers.{create,update,delete}`, on
       *  `auto_run.update`, AND on the dispatcher's error-cap
       *  auto-disable (the one mutation that happens server-side with
       *  no rpc in sight — exactly the case a governance surface must
       *  not miss). Schedules keep their existing `kind: 'schedule'`
       *  event; subscribers listening for "any automation rule moved"
       *  watch both kinds. Payload is intentionally narrow — no row
       *  blob; subscribers re-list via `triggers.list` /
       *  `auto_run.list` so server-resolved state stays
       *  authoritative.
       *
       *  Reactive-substrate slice 2 (poll-manager / G6) adds
       *  `mechanism: 'watch'` — fires on `watch.update`
       *  (pause/resume), on the poll-manager's error-cap auto-disable,
       *  and when a recompute arms or drops a watch key (a new
       *  subscriber demanded a poll loop / the last one left).
       *  Subscribers re-list via `watch.list`. */
      kind: 'automation_rule_changed';
      mechanism: 'event_trigger' | 'auto_run' | 'watch';
      cursor: number;
    }
  | {
      /** D-145 PA10 follow-on — bulk-pack install transaction completed
       *  successfully on the server. Fans out so every paired client's
       *  Settings → Packs panel refreshes the per-pair pack roster
       *  without polling (installed badges flip + counts update on the
       *  Bridge / webclient that didn't initiate the install).
       *
       *  Emitted by `pack-install-handler.ts` after
       *  `installBulkPackOnServer` returns `ok: true` — failed installs
       *  (permission_denied / version_mismatch / unresolved /
       *  validator_rejected / unexpected) do NOT emit, so subscribers
       *  never react to a no-op transaction. Best-effort: bus emit
       *  failure does not abort the rpc result. */
      kind: 'pack_installed';
      /** Pack slug — matches `manifest.slug`; lets a future per-slug
       *  filter avoid refresh churn on packs not currently visible. */
      pack_slug: string;
      /** Pack display name — forwarded so a future install toast can
       *  surface "Installed: <name>" without a follow-up rpc. */
      pack_name: string;
      /** Pack manifest version pinned at install time. */
      pack_version: number;
      /** Count of recipes the engine actually wrote (`fresh_install:
       *  true` entries on the install result). May be < manifest.recipes
       *  length when some slugs were already at the same version
       *  pre-install (idempotent re-install path). */
      installed_recipe_count: number;
      cursor: number;
    }
  | {
      /** D-145 PA10 follow-on Slice B — bulk-pack uninstall transaction
       *  completed successfully on the server. Same fan-out rationale
       *  as `pack_installed` — refreshes the Settings → Packs panel on
       *  every paired client so the just-uninstalled pack's `installed`
       *  badge flips back to the Install affordance.
       *
       *  Emitted by `pack-uninstall-handler.ts` only after the full
       *  uninstall transaction returns `ok: true`. Skips emit on
       *  `not_found` (manifest gone — nothing happened) AND on
       *  `unexpected` mid-transaction throws (a partial-rollback
       *  state isn't a coherent "pack is gone" signal for
       *  subscribers; the panel's next refresh resolves the actual
       *  per-pair state). Best-effort: bus emit failure does
       *  not abort the rpc result. */
      kind: 'pack_uninstalled';
      pack_slug: string;
      pack_name: string;
      /** Pack manifest version forwarded for symmetry with
       *  `pack_installed`. */
      pack_version: number;
      /** Count of recipe rows the per-pair store actually dropped
       *  (`recipeStore.delete()` returned `true`). Recipes the manifest
       *  references but that weren't in the stored set (concurrent
       *  uninstall, pre-existing drift) do not count. */
      removed_recipe_count: number;
      cursor: number;
    }
  | {
      kind: 'entitlement';
      /** Pro state after the change. Cloud → server propagation
       *  per Stripe webhook; clients invalidate the entitlements
       *  cache + refresh feature gates. */
      isPro: boolean;
      /** Epoch ms the entitlement state was determined at the
       *  cloud — clients dedupe out-of-order pushes by comparing. */
      since: number;
      cursor: number;
    }
  | {
      kind: 'reactive_fire';
      recipe_id: string;
      cursor: number;
    }
  | {
      /** D-125 P4.3 — `connection.notification` outbound delivery.
       *  Emitted by the notification handler's in-app subtype after a
       *  successful broadcast and (optionally) by the slack/telegram
       *  subtypes when their wrapper recipes opt to mirror the alert
       *  to paired clients. Fans out to every subscribed client of the
       *  emitting server — there is no per-client targeting at the bus
       *  layer; "target: <pair>" in the spec language refers to the
       *  natural fan-out of the bus, which is scoped to the pair. */
      kind: 'notification';
      /** Which subtype produced the emit. `in-app` is the only one the
       *  P4.3 handler emits today; the field is reserved so a future
       *  wrapper can mirror slack/telegram alerts without re-shaping
       *  the event. */
      subtype: NotificationSubtype;
      body: { text: string; title?: string; link_url?: string };
      cursor: number;
    }
  | {
      /** D-158 § A.7 / D-157 server-wiring — `ui` channel fire-and-
       *  forget notification card. The notification block's `notify`
       *  call resolves the fan-out set, calls `Channel.deliverNotify`
       *  on each, and the `ui` channel adapts it to this event for the
       *  D-121 broadcast bus. Webclients render a one-way card; no
       *  response affordance. */
      kind: 'notification.notify';
      title?: string;
      text: string;
      cursor: number;
    }
  | {
      /** D-158 § A.7 / D-157 server-wiring — `ui` channel interactive
       *  ask card. Carries `ask_id` + the closed option list so the
       *  webclient renders the response buttons; the client posts the
       *  chosen option back as an inbound reply (the `notification.
       *  ask_reply` rpc, wired in a downstream slice). The card
       *  resolves on a matching `notification.ask_closed` event. */
      kind: 'notification.ask';
      ask_id: string;
      title?: string;
      text: string;
      /** The user-facing option set the block accepted at `ask` time.
       *  Mirrors `AskOption` from `@recued/notification` so the
       *  webclient can render `{ id, label }` pairs without dragging
       *  the notification package in. */
      options: readonly { id: string; label: string }[];
      /** D-234 § 234.3 — "read the thing this is about", already absolute.
       *  ⛔ ABSENT FROM THIS FRAME SINCE § 234.3 SHIPPED, so a LIVE ask carried
       *  no link on any surface that renders off the bus — it appeared only
       *  after the next `pending_asks` re-fetch replaced the row. Mirrors
       *  `ServerPendingAsk.link_url`; the two must be named together or the same
       *  ask reads differently depending on which path delivered it. */
      link_url?: string;
      /** D-234 § 234.4e — this ask invites a written reason. ⛔ NAMED HERE OR THE
       *  LIVE CARD CANNOT COLLECT ONE: a surface that renders off this frame
       *  (Bridge's bus buffer) would show a note-less card until its next
       *  history re-fetch, and a `'required'` ask answered from it would no-op
       *  server-side with nothing on screen to say why. */
      note_prompt?: 'optional' | 'required';
      /** D-234 § 234.4f — the document behind the question.
       *  ⛔ ON THIS FRAME BUT NEVER ON A CHANNEL PAYLOAD. The bus reaches the
       *  owner's own paired clients; Slack / Telegram / email and the bearer
       *  `/ask/<ask_id>` landing render `NotificationMessage`, which the body is
       *  deliberately not part of. Bounded at 16 KB so it can ride here at all —
       *  a larger body would have forced a second fetch for the live card, and a
       *  field carried on one path and not another is the drop this arc has
       *  already paid for twice. */
      body?: string;
      cursor: number;
    }
  | {
      /** D-158 § A.7 / D-157 server-wiring — resolves a `notification.
       *  ask` card on every surface it was delivered to. Fires once the
       *  block records an answer (regardless of channel); idempotent at
       *  the channel layer (a second close on an already-closed card
       *  is a no-op). */
      kind: 'notification.ask_closed';
      ask_id: string;
      cursor: number;
    }
  | {
      /** D-169 P2 Slice 4 (live-mode propagation) — a paired bridge's
       *  per-bridge notification mode flags changed (a Settings →
       *  Notifications toggle landed via `notifications.set_bridge_mode`).
       *  Fans out so the affected bridge flips its side-panel approval
       *  gate live (interactive ⇄ read-only) instead of waiting for its
       *  periodic `notifications.my_bridge_mode` re-poll. The bridge
       *  treats this purely as a signal to re-read its OWN (self-scoped)
       *  mode — it never trusts another client's view of its flags; the
       *  inline payload additionally lets a Settings surface on another
       *  paired client refresh the matching per-bridge row without a full
       *  `notifications.describe_bridges` round-trip. Emitted only on a
       *  successful set (an unknown bridge id changed nothing, so no
       *  event). Best-effort like every bus emit — a fan-out failure
       *  never fails the underlying `set_bridge_mode` rpc. */
      kind: 'notification.bridge_mode_changed';
      /** Durable `client_tokens.token_id` of the bridge whose mode
       *  changed — the key the per-pair bridge roster + the self-scoped
       *  `notifications.my_bridge_mode` rpc are both keyed on. */
      client_token_id: string;
      /** The post-change mode flags (mirrors `NotificationBridgeModeRow`;
       *  inlined to keep the event self-contained). */
      modes: { notification: boolean; approval: boolean };
      cursor: number;
    }
  | {
      /** D-123 Phase 5 — housekeeping cycle completion. Emitted by the
       *  scheduler's `onCycleComplete` listener after every cycle
       *  (including `runOnce` cycles fired from the Settings UI's
       *  *Run now* button). Drives the live status-table refresh on
       *  every paired client's Settings → Server → Housekeeping panel.
       *  Carries the per-task summary inline so the UI doesn't need a
       *  follow-up `housekeeping.status.read` round-trip on every
       *  cycle. */
      kind: 'housekeeping_cycle';
      /** Cycle completion epoch ms. */
      at: number;
      /** Total wall-clock duration of the cycle, summed over all
       *  task steps that ran. Empty cycles (preset=='off' bypasses
       *  emit; idle-gated no-op cycles never reach the listener) carry
       *  `duration_ms: 0`. */
      duration_ms: number;
      /** Tasks that finished with `status: 'complete'` this cycle. */
      tasks_complete: number;
      /** Tasks that yielded mid-step (budget / no-work / dependency). */
      tasks_yielded: number;
      /** Tasks that threw — error counter incremented; auto-disable
       *  after 3 consecutive failures. */
      tasks_errored: number;
      /** Per-task outcomes — UI renders one row each. `yield_reason`
       *  surfaces only on yields. */
      per_task: ReadonlyArray<{
        task_id: string;
        status: 'complete' | 'yield' | 'error';
        duration_ms: number;
        yield_reason?: HousekeepingYieldReason;
      }>;
      cursor: number;
    }
  | {
      /** D-132 P4 — non-blocking promotion banner for an AI-surface
       *  enrichment producer the user has manually run
       *  `MANUAL_RUN_THRESHOLD` (3) times under `trust_state: 'manual'`.
       *  The system never auto-flips trust state; this event drives
       *  the banner UI offering Promote / Don't ask again. Fires once
       *  per `(topic, manual_run_count_milestone)` — re-arming
       *  requires user-side dismissal + manual flip back to `'manual'`,
       *  or a future higher milestone (post-launch). */
      kind: 'enrichment_promotion_suggested';
      /** Topic key as registered in `ENRICHMENT_REGISTRY`. */
      topic: string;
      /** Count at the moment the banner fires. Equal to the threshold
       *  on the first crossing — surfaced so the banner copy can read
       *  "You've run X 3 times manually". */
      manual_run_count: number;
      /** Token-cost preview for the would-be auto-cycle. Mirrors the
       *  `Run now` dialog's preview so the user can compare manual vs
       *  auto cost before promoting. Pass-through from
       *  `HousekeepingEnrichmentInfo.estimated_cycle_cost_tokens` —
       *  zero / unknown when the producer hasn't materialized an
       *  estimate yet. */
      estimated_idle_cycle_cost_tokens: number;
      cursor: number;
    }
  | {
      /** D-133 — Population Stability Index on an AI-surface
       *  producer's confidence distribution crossed a severity
       *  threshold. State-transition firing only — once per
       *  `'none'` → `'moderate'` and once per `'moderate'` →
       *  `'significant'` crossing per source topic. PSI bouncing
       *  within the same severity bucket does NOT re-fire. The drift
       *  banner reads this event; dismissed banners re-arm only on
       *  the next severity transition.
       *
       *  Payload is intentionally narrow — full window provenance +
       *  histograms live on the persisted `confidence_drift_signal`
       *  row. The drawer pulls those when the user clicks Review. */
      kind: 'enrichment_drift_detected';
      /** AI-surface topic whose confidence distribution shifted. */
      source_topic: string;
      /** PSI scalar at the crossing. */
      psi: number;
      /** Severity at the crossing — never `'none'` on this event
       *  (transitions OUT of moderate/significant don't fire). */
      severity: 'moderate' | 'significant';
      /** Producer's `computed_at` for the row that crossed. */
      computed_at: number;
      cursor: number;
    }
  | {
      /** D-138 P1 — merge-candidate queue mutation. Drives the top-bar
       *  badge + Settings → Contacts badge + the live count refresh
       *  in the review dialog. `subkind` discriminates the mutation
       *  shape:
       *    - `inserted` — new candidate added (inline detection /
       *      housekeeping scan / enrollment-time review)
       *    - `resolved` — candidate's `status` flipped off `'pending'`
       *      via merge or reject (drives count decrement)
       *
       *  Payload is intentionally narrow — the dialog re-fetches via
       *  `contact.merge.list` when the user opens it; the event just
       *  signals "queue changed, refresh the badge." */
      kind: 'merge_candidate';
      subkind: 'inserted' | 'resolved';
      candidate_id: string;
      pair_key: string;
      cursor: number;
    }
  | {
      /** D-138 P1 (A.10) — upstream-re-merge prompt fired. Generated
       *  inside a housekeeping cycle when a vendor record's deletion
       *  + a partner's same-vendor `linked_at` both fall inside the
       *  cycle window. UI surfaces a "Re-merge in Recued too?" prompt
       *  with [Re-merge] / [Treat as deletion] actions, dispatched
       *  via `contact.merge.resolve_remerge_prompt`. */
      kind: 'remerge_prompt';
      prompt_id: string;
      /** Canonical email of the row that lost a platform_id. */
      affected_email: string;
      /** Canonical email of the rejected partner whose row gained a
       *  same-vendor link in the same cycle. */
      partner_email: string;
      vendor: string;
      cursor: number;
    }
  | {
      /** D-138 P3 — `contact-merge-candidate-scan` progress event.
       *  Fired by the housekeeping scan task at iteration boundaries
       *  + at scan completion. The Settings → Contacts → Scan now
       *  flow + the enrollment focus page consume it to drive the
       *  resolving-duplicates stage's `Comparing X/N` counter +
       *  sample-gated ETA (per the P2 renderer contract).
       *
       *  `op: 'progress'` — incremental update during a running scan
       *  (`iterated` and `total` reflect the cycle's current cursor;
       *  `total` may be null when full-scan total isn't known yet —
       *  the renderer falls back to "Comparing X" without the
       *  denominator). `iterated` and `total` count CONTACTS examined,
       *  not pairs.
       *
       *  `op: 'complete'` — scan cycle finished. `surfaced_count`
       *  carries the number of `enqueueMergeCandidate` insertions that
       *  were new this cycle (resolved or pre-rejected pairs aren't
       *  counted), so the UI can render a closing summary line. The
       *  scan-now full-scan path drives `mode: 'full'`; the
       *  housekeeping cycle drives `mode: 'delta'`.
       *
       *  Payload is best-effort — emits past the cursor ring still
       *  reach the renderer on reconnect; missed events are idempotent
       *  (the scan-now flow re-fetches the queue via
       *  `contact.merge.list` on close). */
      kind: 'merge_scan_progress';
      op: 'progress' | 'complete';
      mode: 'delta' | 'full';
      iterated: number;
      total: number | null;
      surfaced_count?: number;
      cursor: number;
    }
  | {
      /** D-138 P5 — upstream-merge outbox row settled into terminal
       *  failure (`vendor_merge_failed`). Drives the failure banner in
       *  Settings → Contacts. The banner hydrates the full failure
       *  list via `upstream_merge.list` on click; this event just
       *  signals "a failure landed, refresh the badge." */
      kind: 'upstream_merge_failed';
      outbox_id: string;
      approval_id: string;
      vendor: 'hubspot' | 'salesforce';
      survivor_email: string;
      error_code: string;
      error_message: string;
      cursor: number;
    }
  | {
      /** D-137 P1 — AI Chat streaming token delta. Emitted per
       *  Stage-2-decode chunk by the server-side chat orchestrator;
       *  drives the assistant-turn type-out renderer. Multi-client
       *  coherence: every paired client renders the same stream
       *  because D-121's bus fans out by default. The `delta` field
       *  is the raw token text; the renderer concatenates per
       *  `(session_id, turn_id)` until `chat.message_complete`
       *  arrives. */
      kind: 'chat.token_streamed';
      session_id: string;
      turn_id: string;
      delta: string;
      cursor: number;
    }
  | {
      /** D-137 P1 — AI Chat tool-call started. Emitted when the
       *  orchestrator dispatches a Tier 1/2/3 tool through
       *  `InternalToolRegistry.dispatch` OR through outbound MCP via
       *  `connection.mcp.<peer>`. Drives the per-message provenance
       *  display ("Calling contact.search…"). `tier` lets the
       *  renderer style each tier consistently (e.g., Tier 3 carries
       *  the connection name prefix). */
      kind: 'chat.tool_call_started';
      session_id: string;
      turn_id: string;
      tool_name: string;
      tier: 1 | 2 | 3;
      args: unknown;
      /** Present only when this dispatch consumed the exact reviewed
       *  write-plan approval. Links the live tool lifecycle back to the
       *  original approval card; absence means the call was not authorised
       *  through the plan gate. */
      plan_id?: string;
      cursor: number;
    }
  | ({
      /** D-137 P1 — AI Chat tool-call completed. Status-discriminated
       *  shape so the renderer + audit consumer never see a malformed
       *  envelope: `status: 'ok'` MUST carry a `result_ref` (lookup id
       *  into chat-side ephemeral storage; renderer fetches the full
       *  payload via the session's message history rpc when expanding
       *  the provenance affordance); `status: 'error'` MUST carry a
       *  `reason` from the closed `ChatDispatchReason` list (so the
       *  renderer maps to the user-facing failure copy per D-145 PB7
       *  templates). TypeScript catches misshapen producers at compile
       *  time; the wire validator rejects malformed payloads at the
       *  bus boundary. */
      kind: 'chat.tool_call_completed';
      session_id: string;
      turn_id: string;
      tool_name: string;
      tier: 1 | 2 | 3;
      /** Same approval-consumption link as `chat.tool_call_started`.
       *  A client must not infer execution from `chat.send` acceptance;
       *  this field is the authoritative correlation for the receipt. */
      plan_id?: string;
      /** Exact durable run address on the host that executed this call.
       * Present only when an audit anchor was confirmed written. Clients must
       * not infer it from `result_ref`. */
      run_id?: string;
      cursor: number;
    } & (
      | {
          status: 'ok';
          result_ref: string;
          /** An `ok` dispatch can still be paused behind a deeper
           *  confirmation gate. When present, the approved action did not
           *  complete and clients must render it as held rather than done. */
          run_held?: ChatRunHeld['kind'];
        }
      | { status: 'error'; reason: ChatDispatchReason; detail?: string }
    ))
  | {
      /** D-137 P1 § A.11 — AI Chat plan proposed for a write tool.
       *  Drives the inline plan-approval card. `plan_id` is the
       *  approval-substrate handle used by `chat.plan.approve` /
       *  `chat.plan.cancel` rpc. Reads never emit this event;
       *  writes (any tool whose `classification` is `'write'` OR
       *  `'unknown'` and the resolved underlying is write) always
       *  pause behind plan-approval per § A.11. */
      kind: 'chat.plan_proposed';
      session_id: string;
      turn_id: string;
      plan_id: string;
      /** Durable retry lineage. Its presence means this proposal came from
       * an owner-sent verify-before-retry turn for the named consumed plan;
       * it does not imply that verification found or did not find an effect. */
      retry_of_plan_id?: string;
      tool: string;
      tier: 1 | 2 | 3;
      args: unknown;
      /** Exact reviewed-payload hash. Optional for wire compatibility with
       * older paired clients; current producers include it so the UI can say
       * whether a fresh proposal matches the prior action without comparing
       * presentation strings. */
      args_hash?: string;
      /** Server proposal time. Optional for compatibility with older paired
       * clients; current producers include it so global approval queues keep
       * stable ordering across reloads and devices. */
      created_at?: number;
      cursor: number;
    }
  | {
      /** D-137 P1 — AI Chat transparency-stream passthrough. The
       *  orchestrator forks every D-145 PB7 transparency event onto
       *  the bus so paired clients render the per-turn transparency
       *  drawer without polling the audit log. `event` carries the
       *  full PB7 envelope (per `TransparencyEventEnvelope`); the
       *  renderer applies the same redaction tier the audit-store
       *  resolved at emit time. Closed-list `TransparencyEventKind`
       *  upstream gates exhaustivity here. */
      kind: 'chat.transparency';
      session_id: string;
      turn_id: string;
      event: unknown;
      cursor: number;
    }
  | {
      /** D-137 P1 — AI Chat message complete. Final per-turn event.
       *  Carries the fully-shaped `ChatMessage` row the renderer
       *  swaps in over the streamed token buffer + tool-call
       *  provenance list. Idempotent: a re-emit on reconnect is a
       *  no-op because the row is content-addressed by
       *  `(session_id, message_id)`. */
      kind: 'chat.message_complete';
      session_id: string;
      turn_id: string;
      final: unknown;
      cursor: number;
    }
  | {
      /** Owner-confirmed closure of a completed, read-only safe check. The
       * named assistant message is patched in place across paired clients;
       * this carries no approval, execution, or retry authority. */
      kind: 'chat.data_diagnosis_resolved';
      session_id: string;
      message_id: string;
      resolution: ChatDataDiagnosisResolution;
      cursor: number;
    }
  | {
      /** D-137 P1 — AI Chat session metadata changed. Drives the
       *  session-list refresh + per-session header re-render (picker
       *  switch, model-pref switch, title update, archive toggle).
       *  `field` is the closed `ChatSessionChangedField` list; `value`
       *  is the new value (renderer reads the field tag to interpret
       *  the shape). */
      kind: 'chat.session_changed';
      session_id: string;
      field: 'picker' | 'model_pref' | 'title' | 'archived';
      value: unknown;
      cursor: number;
    }
  | {
      /** D-137 W2.2 § A.1.1 — Mary's per-kind chat catalog scope
       *  changed. NOT session-scoped (the scope is per-pair, applied
       *  to every chat session uniformly) — `session_id` is
       *  deliberately absent on this variant. Carries the new
       *  enabled-kind list so paired clients (laptop, phone PWA)
       *  refresh the Settings UI + the chat catalog without an rpc
       *  round-trip. */
      kind: 'chat.tool_catalog_scope_changed';
      enabled_kinds: readonly string[];
      updated_at: number;
      cursor: number;
    }
  | {
      /** D-167 chat provider-threading — the per-pair global chat-model
       *  default changed. NOT session-scoped (the default applies to
       *  every non-overridden chat session uniformly, resolved at read
       *  time) — `session_id` is deliberately absent on this variant.
       *  Mirrors `chat.tool_catalog_scope_changed`'s per-pair-setting shape. */
      kind: 'chat.default_model_pref_changed';
      /** D-174 R28 Slice A — the persisted form: which configured source
       *  (`slot_1` | `slot_2` | `free_pool`) every non-overridden session now
       *  inherits. Paired clients select the Settings picker by exact
       *  `source_id === option.id`. */
      source_id: ChatModelSourceId;
      /** D-174 R28 Slice A — resolved-AT-EMIT snapshot of the source's routing
       *  layer + § A.14 slot hint (`'fast'` = slot_1, `'quality'`/`'thinking'`
       *  = slot_2; absent for free_pool). Lets paired clients patch already-
       *  open inherited sessions' header badges without re-resolving against
       *  their own config view. TRANSIENT — `source_id` is the source of truth;
       *  turn-time routing always re-resolves live, never off this snapshot. */
      layer: ChatModelRoutingLayer;
      model_hint?: ChatModelHint;
      updated_at: number;
      cursor: number;
    }
  | {
      /** D-137 W2.3 § A.1.1 + § A.10 — Mary's per-connection MCP tool
       *  annotation changed. NOT session-scoped (the annotation
       *  applies uniformly to every chat session that touches this
       *  connection) — `session_id` is deliberately absent. Carries
       *  the connection_name + the canonical annotation shape so
       *  paired clients refresh the Tier 3 catalog projection +
       *  Settings → Connections page without an rpc round-trip.
       *
       *  Wire shape stays opaque (`annotation: unknown`) at the event
       *  contract layer because the inner JSON blob carries Mary's
       *  per-tool classifications which the renderer treats as opaque
       *  ad-hoc data (parsed by the webclient settings reducer). */
      kind: 'chat.connection_mcp_annotation_changed';
      connection_name: string;
      annotation: unknown;
      cursor: number;
    }
  | {
      /** D-137 P3 § A.5 Pattern 3 — disambiguation surface. The
       *  scope-search returned plausible-but-ambiguous candidates and
       *  the renderer should paint disambiguation chips (when
       *  `candidates.length` ≤ 5 and entries carry stable display
       *  identifiers) OR an open question (when ambiguity is more
       *  abstract — closed-list `prompt_kind` discriminator). Session-
       *  scoped; one per ambiguous tool call.
       *
       *  Closed `prompt_kind`:
       *    - `'chips'`           — render `candidates` as clickable
       *      chips. The closed shape lets the renderer paint without
       *      parsing arbitrary candidate body.
       *    - `'open_question'`   — render `prompt` as a free-text
       *      clarification. No chips. */
      kind: 'chat.disambiguation_proposed';
      session_id: string;
      turn_id: string;
      tool: string;
      prompt_kind: 'chips' | 'open_question';
      /** When `prompt_kind === 'chips'`: candidate display payload.
       *  Each entry carries the per-candidate `target_id` (for the
       *  follow-up disambiguation rpc) + a `label` (the human-
       *  readable string the renderer paints onto the chip).
       *  Empty / absent on `'open_question'`. */
      candidates?: ReadonlyArray<{ target_id: string; label: string }>;
      /** When `prompt_kind === 'open_question'`: the clarification
       *  question text. Absent on `'chips'`. */
      prompt?: string;
      cursor: number;
    }
  | {
      /** D-137 P3 § A.11 — plan resolved. Fires when Mary approves OR
       *  cancels a previously-proposed write plan via
       *  `chat.plan.approve` / `chat.plan.cancel` rpc. Carries the
       *  post-resolution `ChatPlanProposal` shape so paired clients
       *  re-render the per-message approval card with the final
       *  state. */
      kind: 'chat.plan_resolved';
      session_id: string;
      turn_id: string;
      plan: ChatPlanProposal;
      cursor: number;
    }
  | {
      /** D-137 P4 § A.7.1 — picker entries changed. Fires when:
       *    (a) a `chat.picker.refresh` rpc updates an annotation row's
       *        `recued_signature` + `tools_list_cache`, OR
       *    (b) a `chat.connection_mcp.set` write modifies any field
       *        that could shift picker visibility (annotation
       *        creation, classification flips, signature changes).
       *  Carries the post-write `PickerEntry[]` array so paired
       *  clients re-render the picker dropdown without a follow-up
       *  `chat.picker.entries` round-trip. NOT session-scoped —
       *  picker entries are per-pair, applied uniformly across every
       *  chat session. */
      kind: 'chat.picker_entries_changed';
      entries: ReadonlyArray<{
        id: 'self' | string;
        label: string;
        kind: 'self' | 'peer_data' | 'peer_chat';
        signature?: {
          server_kind: 'recued';
          version: string;
          instance_id: string;
        };
        version_delta?: 'same' | 'older' | 'newer' | 'unknown';
        available_tool_count: number;
      }>;
      cursor: number;
    }
  | {
      /** D-137 P5 follow-on § A.9 — inbound-token registry mutated.
       *  Fires on every `chat.inbound_token.{issue, update_grants,
       *  revoke, delete}` write so paired clients (Bob's other
       *  devices) re-render the Settings → MCP Tokens table without a
       *  follow-up `list` round-trip.
       *
       *  `op` discriminates the mutation kind so the renderer can
       *  animate row insert / update / revoke / removal appropriately.
       *  The `record` carries every persisted field — but **never the
       *  bearer plaintext**. The plaintext is only ever surfaced via
       *  the `chat.inbound_token.issue` rpc's `IssuedMcpInboundToken`
       *  response envelope, returned exactly once at issuance.
       *  `record: null` on `op: 'delete'` since the row no longer
       *  exists; carry `token_id` so the renderer can drop the right
       *  row.
       *
       *  NOT session-scoped — token registry is per-pair, applied
       *  uniformly across every chat session AND every external MCP
       *  agent. Wire shape stays opaque (`record: unknown`) at the
       *  event contract layer because the inner blob carries Bob's
       *  per-tool grants which the renderer treats as opaque ad-hoc
       *  data (parsed by the webclient settings reducer). */
      kind: 'chat.inbound_token_changed';
      op: 'issue' | 'update_grants' | 'update_contract' | 'revoke' | 'delete';
      token_id: string;
      record: unknown;
      cursor: number;
    }
  | {
      /** D-171 — `contract_definition` lifecycle mutated. Fires on every
       *  `collection.contract.{mintContract, revokeContract}` write so paired
       *  clients re-render the Settings → Privacy → Contracts inspector (the
       *  active-limits / kill-switch list) AND the MCP door's Advanced
       *  cap/expiry summary without a follow-up `listContracts` round-trip.
       *
       *  Pre-D-171 these writes rode pair-sync only (no bus event); the
       *  webclient proxied contract changes off `chat.inbound_token_changed`
       *  because the MCP-door Advanced sub-panel — the only minter/revoker —
       *  pairs each cap/expiry edit with a token `update_contract` op. That
       *  proxy missed the trailing bare `revokeContract` of a prior limit
       *  (which carries no token op), leaving a just-revoked limit briefly
       *  shown as active. THIS kind is the authoritative signal: every mint +
       *  revoke fires it, so the inspector + door key their re-list off it
       *  directly (dropping the token proxy for contracts).
       *
       *  `op` discriminates mint vs revoke vs in-place update (D-187 §6 step 7 —
       *  `setDoorTypes` edits an existing row's level-1 door types); `contract_id`
       *  names the row that changed. NOT session-scoped — the `contract_definition`
       *  store is per-pair, applied uniformly across every paired client. The
       *  payload is intentionally narrow (no row blob): subscribers re-list via
       *  `collection.contract.listContracts` so the server-resolved
       *  `lifecycle_state` stays authoritative (every subscriber re-lists on ANY
       *  op, so the discriminant is informational — a new op never strands a
       *  client). */
      kind: 'contract.contract_definition_changed';
      op: 'mint' | 'revoke' | 'update';
      contract_id: string;
      cursor: number;
    }
  | {
      /** D-177 N.13 (P6b) — the staged-trust learner surfaced a NEW open
       *  delegation-rule suggestion (or re-fired one whose prior row had
       *  been superseded). Drives the D-174 `#contracts` "Suggested rules"
       *  badge + the Home cockpit affordance; fires on row CREATION only —
       *  idempotent evidence refreshes of an already-open suggestion are
       *  silent (the panel re-lists when opened). Payload is intentionally
       *  narrow: `key_hash` names the row (subscribers re-list via the P6c
       *  rpc — suggestions are NEVER serialized into model-visible context,
       *  N.9.1); `ingredient_id` + optional `operation_id` let the badge
       *  render "Suggested rule for <op>" without a round-trip. NOT
       *  session-scoped — the suggestion store is per-pair. */
      kind: 'contract.delegation_rule_suggested';
      key_hash: string;
      ingredient_id: string;
      operation_id?: string;
      cursor: number;
    }
  | {
      /** D-177 N.13 (P6c) — the owner resolved a delegation-rule suggestion
       *  (accept → the rule minted; dismiss → per-key permanent). Fans so
       *  the "Suggested rules" panel on EVERY paired client drops/refreshes
       *  the card — a dismissal on the laptop must not keep offering
       *  standing authority on the phone. (The accept path additionally
       *  fires `contract.contract_definition_changed` for the minted rule
       *  itself.) Narrow payload (N.9.1 posture — suggestions are never
       *  model-visible): `key_hash` names the suggestion row; `resolution`
       *  discriminates so a subscriber can drop the card without a re-list
       *  round-trip. NOT session-scoped — the suggestion store is per-pair. */
      kind: 'contract.delegation_rule_suggestion_resolved';
      key_hash: string;
      resolution: 'accepted' | 'dismissed';
      cursor: number;
    }
  | {
      /** D-177 N.11 rule 5 (5.c, slice C) — the parse middleware filed a NEW
       *  open scoped-grant proposal from the user's own utterance. Drives
       *  the accept-card surface; fires on row CREATION only (an idempotent
       *  re-utterance refresh of an already-open proposal is silent). Narrow
       *  payload, same N.9.1 posture as the delegation kinds — proposals are
       *  never model-visible; subscribers re-list via the owner rpc.
       *  `chat_session_id` lets the card render inline in the right chat. */
      kind: 'contract.scoped_grant_suggested';
      key_hash: string;
      chat_session_id: string;
      ingredient_id: string;
      operation_id: string;
      cursor: number;
    }
  | {
      /** D-177 N.11 rule 5 (5.c, slice C) — the owner resolved a scoped
       *  proposal (accept → the scoped session grant minted; dismiss →
       *  per-key permanent for the session). Fans so every paired client
       *  drops/refreshes the card. The accept path additionally fires
       *  `contract.contract_definition_changed` for the minted grant. */
      kind: 'contract.scoped_grant_suggestion_resolved';
      key_hash: string;
      resolution: 'accepted' | 'dismissed';
      cursor: number;
    }
  | {
      /** D-165 enroll-host #1 (vendor OAuth popup) — a server-side
       *  `/oauth/complete` code exchange finished and stashed the
       *  exchanged credential in the per-pair result store. Fans ONLY
       *  the `flow_id` — NEVER the refresh_token — because the bus
       *  reaches every paired client: the open enrollment dialog that
       *  started this flow matches on its own `flow_id` and claims the
       *  secret point-to-point off a consume-once rpc response (the
       *  owner-bound `takeVendorOAuthResult`, landing in slice 3 with the
       *  webclient consumer); the broadcast alone never carries enough to
       *  retrieve the secret.
       *
       *  Emitted by the `/oauth/complete` port handler's `onCompleted`
       *  seam AFTER the success response is written (D-165 slice 2b
       *  Piece W). The payload is intentionally minimal — the dialog
       *  re-reads the authoritative credential off the claim rpc, so no
       *  row blob rides the bus. */
      kind: 'connection.vendor_oauth_completed';
      flow_id: string;
      cursor: number;
    }
  | {
       /** D-149 P3 § A.3 — reception endpoint registry mutated. Fires on
        *  every `reception.endpoint.{create, enable, disable, revoke,
       *  extend, rotate_token}` write plus D-200 pair bind/configure/clear so paired
       *  clients (Mary's other devices viewing Settings → Server → Reception) re-render
       *  without a follow-up `endpoints.list` round-trip AND so the
       *  reception listener's in-memory registry cache invalidates
       *  within 60s per Must Hold I-5 (revocation propagation).
       *
       *  `op` discriminates the mutation kind so the renderer can
       *  animate row insert / update / revoke / removal appropriately.
       *  The `endpoint_id` carries the row that changed; the listener
       *  uses it to evict the cached entry (full row reloaded on next
       *  request). NOT session-scoped — endpoint registry is per-pair,
       *  applied uniformly across every paired client. */
      kind: 'reception.endpoint_changed';
      op:
        | 'create'
        | 'enable'
        | 'disable'
        | 'revoke'
        | 'extend'
        | 'rotate_token'
        | 'pair_bind'
        | 'pair_configure'
        | 'pair_clear';
      endpoint_id: string;
      cursor: number;
    }
  | {
      /** D-149 P3 § A.3 — Reception emergency disable-all fired. Fan-
       *  out signal letting every paired client refresh Settings →
       *  Server → Reception in one go, even though each endpoint row
       *  ALSO emits a `reception.endpoint_changed` event with
       *  `op: 'disable'`. The single roll-up keeps the renderer from
       *  re-rendering once per disabled row + carries the reason for
       *  display in the audit summary. */
      kind: 'reception.emergency_disabled';
      disabled_count: number;
      reason: string | null;
      cursor: number;
    }
  | {
      /** D-173 N.2 — Reception Inbox item resolved. Fires on every
       *  `reception.inbox.{approve,reject}` so paired clients viewing the
       *  inbox drop the resolved item without a follow-up
       *  `reception.inbox.list` round-trip. `op` discriminates the
       *  resolution; `hold_id` is the held run's `Checkpoint.checkpoint_id`
       *  the item was keyed on. Per-pair (the inbox is admin-only,
       *  `reception.` reserved-prefix), applied uniformly across paired
       *  clients. Best-effort like every emit — a fan-out failure never
       *  aborts the approve/reject (the high-assurance audit row + the
       *  `arg_overrides` write land BEFORE the broadcast). */
      kind: 'reception_inbox';
      op: 'approved' | 'rejected';
      hold_id: string;
      cursor: number;
    }
  | {
      /** D-148 § A.4.4 — webclient/bridge bearer rotation push.
       *  Server emits when it issues a fresh bearer for a single
       *  paired client + invalidates the old one. The targeted
       *  client filters on `target_token_id === stored.token_id`,
       *  wraps the plaintext `bearer` under a fresh AAD built from
       *  `new_token_id` + the stored `server_url` + `server_public_key`,
       *  persists the wrapped `WebclientTokenRecord` to local storage,
       *  then calls `ws.applyRotatedBearer()` so the reconnect loop
       *  picks up the fresh credential. Sibling clients (the user's
       *  other paired surfaces) see the same broadcast but ignore on
       *  `target_token_id` mismatch.
       *
       *  Trust model: the broadcast bus is pair-scoped — every
       *  subscriber is already authenticated as a paired client of
       *  the same user. The plaintext bearer on the wire is therefore
       *  bounded to the same-user trust domain (paired devices). The
       *  TLS-pinned, pair-authenticated WS is the same channel that
       *  delivers warehouse contents and approval responses — the
       *  bearer rides the same trust boundary as the data it
       *  protects. A future hardening could envelope-encrypt the
       *  bearer to the targeted client's wrap key (the per-pair AES
       *  key is non-extractable, so this would require an ECDH-
       *  derived shared secret); the current shape is forward-
       *  compatible because every consumer routes through the
       *  `target_token_id` filter. */
      kind: 'token.rotated';
      /** Token_id of the bearer being invalidated. Targeted client
       *  filters against its stored `webclient_token.token_id`. */
      target_token_id: string;
      /** New token_id — public projection of the freshly-issued
       *  bearer. Persisted in the wrapped record's `token_id` field
       *  after the client wraps; surfaced in Settings + audit rows. */
      new_token_id: string;
      /** Plaintext bearer the targeted client wraps with its local
       *  AES-GCM key. Never persists in plaintext; the wrap happens
       *  inline in the broadcast handler and the plaintext is
       *  discarded after the `WebclientTokenRecord` is written. */
      bearer: string;
      /** Unix-ms when the server issued the new bearer. Persisted as
       *  `WebclientTokenRecord.issued_at` so Settings + audit rows
       *  reflect server-side issue time, not client wrap time. */
      issued_at: number;
      cursor: number;
    }
  | {
      /** D-156 follow-on — the paired-device roster changed. Emitted when a
       *  new device completes the `/auth/pair` pairing ceremony
       *  (`op: 'added'`) or an existing device is revoked via the
       *  `pair.revoke` rpc (`op: 'revoked'`). Drives the Settings → Devices
       *  roster's live refresh so a pair / revoke on one client reflects on
       *  every other paired client without a manual reload (closes the
       *  `devices-page-mount` DD#4 "future polish: a broadcast subscriber on
       *  `pair.list_changed`" note).
       *
       *  Payload is intentionally narrow — no row blob; subscribers re-call
       *  `pair.list` so the server-resolved roster (durable rows joined with
       *  live WS presence) stays authoritative. The WS `intent: 'replace'`
       *  registration (atomic revoke-old + add-new) fans a single `op:
       *  'added'` — its headline; the re-fetched roster reflects both deltas.
       *  Deliberately NOT emitted on the WS `register` reconnect-upsert (a
       *  reconnect is a `connected`-flag change, not a roster-membership
       *  change) nor on the no-caller `revokeAllActive` store path. Best-
       *  effort like every emit: a fan-out failure never aborts the pair /
       *  revoke / replace it follows. */
      kind: 'pair.list_changed';
      op: 'added' | 'revoked';
      cursor: number;
    }
  | {
      /** D-148 § A.6.5 — TLS cert rotation pre-notice. Server emits
       *  at T-rotation_lead_time (default 7d) after staging a fresh
       *  cert via the ACME helper; clients verify the Ed25519 signature
       *  against their pinned `server_public_key` and persist
       *  `next_fingerprint` alongside `current_fingerprint` so the
       *  T-time handshake transition is seamless even for clients
       *  that miss the notice replay window. Mirrors the
       *  `CertRotationNotice` shape in `d-148-rotation.ts` — the
       *  rotation event surface and the broadcast bus carry the same
       *  fields. */
      kind: 'cert.rotation_notice';
      /** `sha256:<hex>` fingerprint of the cert the server is
       *  currently serving. Receiving client uses this to confirm the
       *  notice describes the same cert it had pinned. */
      current_fingerprint: string;
      /** `sha256:<hex>` fingerprint of the cert the server has
       *  staged for the rotation. Persisted as
       *  `WebclientCertPinState.next_fingerprint`. */
      next_fingerprint: string;
      /** Unix-ms when the new cert takes over (server-side TLS
       *  reload). Clients accept either fingerprint between this and
       *  `T + rotation_overlap_ms`. */
      rotation_at: number;
      /** Ed25519 signature over canonical JSON of the unsigned
       *  notice payload (`current_fingerprint` + `next_fingerprint` +
       *  `rotation_at` + `signer_fingerprint` + `emitted_at`), signed
       *  with the server's CURRENT `server_identity_key`. Verified at
       *  the client against the pinned `server_public_key`;
       *  signature_invalid → notice ignored. */
      signature: string;
      /** Public-key fingerprint of the signer (`sha256:<hex>`). Lets
       *  the receiver pick the right pubkey from rotation history if
       *  identity has rotated since pairing. */
      signer_fingerprint: string;
      /** Unix-ms. */
      emitted_at: number;
      cursor: number;
    }
  | {
      /** D-148 § A.6.5 — TLS cert rotation rollback. Server emits
       *  when a rotation is reverted (post-bind regression detected
       *  via Reachability Doctor or admin manual revert). Clients
       *  verify the signature + restore the previous fingerprint as
       *  the active pin without forcing re-pair. */
      kind: 'cert.rotation_reverted';
      /** `sha256:<hex>` of the cert the server is now serving (the
       *  one the rotation rolled back to). Targeted clients update
       *  `current_fingerprint` to this value + clear
       *  `next_fingerprint`. */
      reverted_to_fingerprint: string;
      /** Operator-supplied reason — surfaces in audit / key-health UI. */
      reason?: string;
      /** Unix-ms. */
      reverted_at: number;
      /** Ed25519 signature over canonical JSON of the unsigned
       *  revert payload (`reverted_to_fingerprint` + `reason` +
       *  `reverted_at` + `signer_fingerprint`), signed with the
       *  server's CURRENT `server_identity_key`. */
      signature: string;
      /** Public-key fingerprint of the signer (`sha256:<hex>`). */
      signer_fingerprint: string;
      cursor: number;
    }
  | {
      /** D-153 P7 — session lifecycle transition. Emitted by the
       *  Engine (D-145, deferred) each time a session enters a new
       *  lifecycle state (`intent_forming → intent_committed →
       *  executing → intent_satisfied → closed`). Drives paired
       *  clients' session UI — a spinner while `executing`, a done
       *  badge on `closed` — without polling.
       *
       *  Resolves D-153 spec open question #19 (closed-list of session
       *  lifecycle events): every state transition is one event, so
       *  the closed list of lifecycle events IS the closed list of
       *  lifecycle states (`SESSION_LIFECYCLE_STATES`). A session
       *  *opening* carries `prev_state: null`; a session *closing*
       *  carries `state: 'closed'`. A "transfer" (the spec's
       *  `session.transferred` example) is not a separate kind — a
       *  transferred-in session simply opens, and the "from whom"
       *  data lives on P5's `predecessor_session_id` / P6's
       *  `derived_from_session_id` link.
       *
       *  Payload is intentionally narrow — clients key their session
       *  UI on `session_id`; richer session metadata is fetched via
       *  the session rpc (D-145). */
      kind: 'session_lifecycle';
      /** The session whose lifecycle changed. */
      session_id: string;
      /** The lifecycle state the session just entered. */
      state: SessionLifecycleState;
      /** The state the session left, or `null` when the session just
       *  opened (entered `intent_forming` from nothing). */
      prev_state: SessionLifecycleState | null;
      cursor: number;
    }
  | {
      /** D-148 § A.7 — exposure transition broadcast. The exposure state
       *  machine fans one of these per path-resolution flip OR public-MCP
       *  sub-toggle so paired clients refresh their connection assumptions
       *  without re-fetching the passport: the webclient's Settings →
       *  Server → Exposure grid + "matches preset / Custom" badge re-render
       *  off the inline `resolution` + `derived_preset_label`. Mirrors the
       *  `ExposureChangedEvent` shape in `d-148-rotation.ts` (the rotation-
       *  event surface and the broadcast bus carry the same fields) — `kind`
       *  + the bus-stamped `cursor` replace `type` for this envelope.
       *
       *  Best-effort like every emit: a fan-out failure never aborts the
       *  underlying state-machine transition (the machine emits its high-
       *  assurance audit row BEFORE the broadcast + listener bind, so a
       *  broadcast throw can't roll back a committed transition). */
      kind: 'exposure_changed';
      /** Full per-path toggle grid post-transition. Mirrors
       *  `ExposureState.resolution`. */
      resolution: Record<PathRole, PathResolution>;
      /** Recomputed UI label — the matching preset name or `'custom'`
       *  when the toggle grid drifts off every preset shape. */
      derived_preset_label: DerivedPresetLabel;
      /** Public-MCP acknowledgement state at the time of the transition,
       *  carried in full so clients render the gate status without a
       *  follow-up rpc. */
      public_mcp_acknowledgement: PublicMcpAcknowledgement;
      /** Unix-ms the transition was applied. */
      changed_at: number;
      /** Client id that drove the transition (audit provenance). */
      changed_by_client_id: string;
      cursor: number;
    }
  /** R2 build step 4c.4 — derived recipe runnability moved. Emitted
   *  (best-effort) after any mutation that can change a recipe's
   *  runnability: connection connect/disconnect, operation-group
   *  grant/revoke, pack install/uninstall. Carries the FULL recomputed
   *  per-recipe snapshot — identical to the `recipe.runnability` rpc
   *  response — so a subscriber re-renders the new status without a
   *  follow-up read (mirrors `exposure_changed`). Recompute-on-emit; the
   *  snapshot IS the authoritative current state — never a diff, never
   *  persisted (recoverable by construction). DISCLOSURE over the D-157
   *  gate, not enforcement. */
  | {
      kind: 'recipe_runnability_changed';
      recipes: readonly RecipeRunnabilityEntry[];
      cursor: number;
    };
// D-156 P9 retired the `pair_required` ServerEvent variant. Recovery
// from `server_identity_key` rotation now flows through the natural
// disconnect → unpaired-state → pair-form remount path (per the D-156
// spec § Q2 resolution + the webclient's `onReauthRequired` funnel).

/** Discriminator type — derived for filter lists + default-subscription
 *  arrays. Adding a new `ServerEvent` variant here automatically
 *  widens this union. */
export type BroadcastEventKind = ServerEvent['kind'];

/** Closed enumeration of the kinds. Useful for runtime validation
 *  (`SubscribeRequest.kinds` filtering / wire-shape rejection) and
 *  for tests that need to enumerate every kind. Kept alphabetised
 *  for diffability; order doesn't matter functionally. */
export const ALL_BROADCAST_EVENT_KINDS = [
  'approval',
  'automation_rule_changed',
  'cert.rotation_notice',
  'cert.rotation_reverted',
  'chat.connection_mcp_annotation_changed',
  'chat.data_diagnosis_resolved',
  'chat.default_model_pref_changed',
  'chat.disambiguation_proposed',
  'chat.inbound_token_changed',
  'chat.message_complete',
  'chat.picker_entries_changed',
  'chat.plan_proposed',
  'chat.plan_resolved',
  'chat.session_changed',
  'chat.token_streamed',
  'chat.tool_call_completed',
  'chat.tool_call_started',
  'chat.tool_catalog_scope_changed',
  'chat.transparency',
  'connection.vendor_oauth_completed',
  'contract.contract_definition_changed',
  'contract.delegation_rule_suggested',
  'contract.delegation_rule_suggestion_resolved',
  'contract.scoped_grant_suggested',
  'contract.scoped_grant_suggestion_resolved',
  'enrichment_drift_detected',
  'enrichment_promotion_suggested',
  'entitlement',
  'execution',
  'exposure_changed',
  'housekeeping_cycle',
  'memory',
  'merge_candidate',
  'merge_scan_progress',
  'notification',
  'notification.ask',
  'notification.ask_closed',
  'notification.bridge_mode_changed',
  'notification.notify',
  'pack_installed',
  'pack_uninstalled',
  'pair.list_changed',
  'reactive_fire',
  'reception.emergency_disabled',
  'reception.endpoint_changed',
  'reception_inbox',
  'recipe_runnability_changed',
  'remerge_prompt',
  'schedule',
  'service',
  'session_lifecycle',
  'supervision',
  'token.rotated',
  'upstream_merge_failed',
  'warehouse',
] as const satisfies readonly BroadcastEventKind[];

// Compile-time coverage check — every `ServerEvent['kind']` literal must
// appear in `ALL_BROADCAST_EVENT_KINDS`. If a future `ServerEvent` variant
// lands without its kind added here, the `Exclude<>` resolves to a non-empty
// union and `_broadcastKindsCovered` fails to compile — turning the drift the
// lockstep ratchet (`apps/webclient` subscriber test) guards at runtime into a
// build error at its source. The `satisfies` above already rejects a stray /
// mistyped kind (the reverse direction), so together they pin the array to the
// `ServerEvent` union as a bijection.
type _BroadcastKindsCovered =
  Exclude<BroadcastEventKind, (typeof ALL_BROADCAST_EVENT_KINDS)[number]> extends never
    ? true
    : [
        'ALL_BROADCAST_EVENT_KINDS missing ServerEvent kinds',
        Exclude<BroadcastEventKind, (typeof ALL_BROADCAST_EVENT_KINDS)[number]>,
      ];
const _broadcastKindsCovered: _BroadcastKindsCovered = true;
// Reference to silence unused-binding lints; the static-failure posture is
// the load-bearing behavior, not runtime use.
void _broadcastKindsCovered;

/** O(1) membership check for incoming wire payloads. */
export const BROADCAST_EVENT_KIND_SET: ReadonlySet<BroadcastEventKind> =
  new Set(ALL_BROADCAST_EVENT_KINDS);

// ────────────────────────────────────────────────────────────────
// Subscription wire shapes
// ────────────────────────────────────────────────────────────────

/** Sent by the client over `events.subscribe` rpc on WS connect (and
 *  any time the active filter changes). Empty `kinds` is a server-
 *  side error — clients that want everything pass the full list from
 *  `DEFAULT_SUBSCRIPTIONS` (per `pairing.ts`). */
export interface SubscribeRequest {
  kinds: BroadcastEventKind[];
  /** Last cursor the client has applied. Server replays everything
   *  with `cursor > cursor_since` from its ring buffer, then streams
   *  new emits live. Omit on first connect. */
  cursor_since?: number;
}

/** Server response to `events.subscribe`. Replayed events arrive
 *  immediately after the ack via the same `server_event` push
 *  envelope; `replay_count` lets the client confirm the count
 *  matches what landed (gap → full re-sync). */
export interface SubscribeAck {
  /** Current bus cursor at subscribe time — clients persist this so
   *  they can resume from here on the next reconnect. */
  cursor: number;
  /** Number of events the server is about to replay. `0` = nothing
   *  buffered or no `cursor_since` was supplied. */
  replay_count: number;
  /** True when the supplied `cursor_since` predates the ring window;
   *  in that case `replay_count` is 0 and the client should fall back
   *  to a full collection re-sync (warehouse `since` + audit cursor +
   *  approvals snapshot). */
  fell_off_ring: boolean;
}

// ────────────────────────────────────────────────────────────────
// Server-side bus configuration
// ────────────────────────────────────────────────────────────────

/** Default ring-buffer size for `EventBus`. ~10K events comfortably
 *  covers tens of minutes of normal activity (warehouse + memory
 *  emits dominate); short enough that a stale client triggering
 *  replay doesn't pin meaningful RAM. Configurable per-instance for
 *  hosted setups with longer reconnect windows. */
export const DEFAULT_EVENT_RING_SIZE = 10_000;
