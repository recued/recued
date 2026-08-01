/** Audit log store.
 *
 *  Persists a redacted record of each recipe execution for the user's own
 *  review + compliance export. This log is FREE for all tiers (not Pro-
 *  gated) per the privacy-first pillar.
 *
 *  PRIVACY CONTRACT: the audit entry is the run-level execution-request
 *  envelope — recipe id/hash, config snapshot, overall status, errors.
 *  It NEVER carries raw step result payloads: those can contain CRM PII
 *  (contact names, deal amounts, emails) the user didn't consent to
 *  retain. Per-step / per-tool-call detail lives in the D-153 commit
 *  log, not here — D-145 slice 3b.4 retired `AuditEntry.steps[]`. The
 *  audit log is a ledger, not a debugger.
 *
 *  Error details ARE retained: code, message, source step id. These are
 *  diagnostic and don't typically contain user PII. Recipe authors should
 *  avoid interpolating PII into error messages (validator's job, not the
 *  storage layer's).
 *
 *  Export: the full log is exportable as JSON via `exportAll()` for
 *  compliance (GDPR Article 15 subject access, SOC2 evidence, etc.).
 */

import type { Collection } from './types.js';
import type {
  Actor,
  CommitKind,
  ContractSnapshot,
  ExecutionSource,
  HeavyOpErrorCategory,
  RecipeError,
  RunDegradation,
  RunAnchorStatus,
  RunMode,
  TimelineAxis,
} from '@recued/contracts';
// D-161 P3 — actor-lane filter for `listRecent` (the aggregate "Recent
// activity" feed). The predicate lives in contracts so the one D-153 actor
// model stays the single source of truth (I-6).
import { originActorPassesTimelineFilter } from '@recued/contracts';

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

/** One redacted entry per recipe run. Keyed by `run_id` in the backing
 *  Collection. */
export interface AuditEntry {
  /** Stable, unique identifier for this run. Format: ISO timestamp +
   *  short random suffix for collision-resistance inside the same
   *  millisecond. */
  run_id: string;
  recipe_id: string;
  /** FNV-1a hash of the canonical recipe form at the time of execution.
   *  Identifies the exact recipe version that ran — useful for
   *  correlating with published updates. */
  recipe_hash: string;
  started_at: number; // epoch ms
  finished_at: number; // epoch ms
  duration_ms: number;
  /** Lifecycle state of the recipe RUN — a `RunAnchorStatus`. D-153 P1
   *  replaced the pre-D-153 `success: boolean` with this field; callers
   *  map `true` → `'succeeded'` / `false` → `'failed'` at the engine
   *  boundary. D-157 P1 widens the type from `CommitStatus` to
   *  `RunAnchorStatus` — the run anchor also carries `'awaiting_approval'`
   *  when a preflight-approval gate has paused the run. (The field name
   *  `commit_status` is retained from the D-153 P1 `success` rename; the
   *  value is a run-anchor status, not a commit status.) The non-terminal
   *  + cancelled / in_doubt values come from the Gateway-driven dispatch
   *  outbox, `'awaiting_approval'` from the D-157 preflight gate; today's
   *  synchronous recipe-runner only emits the two terminal values. */
  commit_status: RunAnchorStatus;
  /** User-set variable overrides that were active for this run. Values
   *  are captured verbatim — audit consumers should assume these may be
   *  sensitive (e.g., enterprise deal-size thresholds) and handle
   *  accordingly when rendering. */
  config_snapshot: Record<string, unknown>;
  /** Targeting guard follow-on (design § 8 / codex HIGH fold) — the
   *  caller-supplied `context` of a run PAUSED at the preflight gate.
   *  Context is run-scoped input frozen at dispatch (the same principle
   *  as the checkpoint's seeded `step_state`): the resumer replays it so
   *  a gated step that resolves `{{context.entity_id}}` (or a reactive
   *  `{{context.event...}}`) dispatches against the approved values, not
   *  undefined. Set ONLY on `awaiting_approval` anchors — terminal rows
   *  never carry it (caller context can hold page text; no reason to
   *  copy it into every retained audit row). Same verbatim-capture
   *  sensitivity note as `config_snapshot`. */
  context_snapshot?: Record<string, unknown>;
  errors: RecipeError[];
  /** Post-execution observability degradation. The run may have
   *  succeeded while a follow-on audit/provenance write failed, so this
   *  marker lets memory/timeline/Runs render the incomplete record. */
  degraded?: RunDegradation[];
  /** Optional trigger info for context recipes — what page the recipe
   *  ran on, so the user can review "which recipes ran on which pages".
   *  May be omitted for scheduled/manual runs. */
  trigger_url: string | null;
  /** How the execution was triggered. Used to filter audit entries by
   *  source (manual, auto_run, scheduled, server_command). */
  trigger_source: string | null;
  /** Which instance executed this recipe. Identifies the device/server
   *  in the instance roster. Null for pre-instance audit entries. */
  instance_id: string | null;
  /** Reserve-class flag (Phase B). Reserve rows are excluded from the
   *  age/size-based retention pruner so the log always retains a ledger
   *  of reserve-class events (pressure transitions, kill-switch toggles,
   *  storage rejections). Default undefined = non-reserve. */
  reserve?: boolean;
  /** Declared wall-clock budget for the run (from
   *  `metadata.budget_ms`). When present, operators can tune it by
   *  cross-referencing against `duration_ms`: runs that consistently
   *  hit > 70% of budget are the ones to raise. Absent when the
   *  recipe didn't declare a budget. */
  budget_ms?: number;
  /** Smart Backfill metadata (Phase 5). Set when `trigger_source ===
   *  'backfill'` so the consolidated audit UI can render
   *  "47 cycles missed since 9:42am" inline without scanning two
   *  rows. `missed_cycles: 'unknown'` for the first catch-up after
   *  schedule creation when there's no observed-cadence sample yet. */
  backfill?: {
    missed_cycles: number | 'unknown';
    last_run_at_before: number;
  };
  /** D-115 — reactive recipe `process_id`. Set when the run was
   *  dispatched by the auto-run scheduler; groups every tick of one
   *  install under a stable UUID so the rollup UI collapses "248
   *  iterations, 3 fired, 245 skipped" into a single row. Null /
   *  undefined for manual + scheduled + server_command runs. */
  process_id?: string;
  /** D-179 P1 — dish attribution. A standing `dsh_…` id when the run
   *  was dispatched against a persisted dish, or the run-derived
   *  ephemeral `dsh:eph:<run_id>` id for dishless runs. Answers
   *  "which of my 10 repos failed" across runs of one recipe.
   *  Undefined on pre-D-179 rows + ext-routed writers. */
  dish_id?: string;
  /** D-120 — short post-run outcome summary (≤ AUDIT_OUTPUT_STRING_MAX
   *  chars). Captures approval outcome (`approval:allow` / `deny` /
   *  `edit` / `dismiss_unseen`), error code + brief fragment, or a
   *  short success summary. Distinct from per-step `result` (still
   *  redacted per the privacy contract above). Phase 1 lands the
   *  field; Phase 7 wires capture at run finish. */
  output_string?: string;
  /** D-120 — surrogate FK pointer into the new `recipe_insights`
   *  SQLite table. The existing `recipe_hash` field stays as the
   *  human-readable identifier (greppable in logs, exposed in MCP
   *  responses); `recipe_insight_id` is the fast-join key the L3+
   *  pattern queries hit. Phase 1 lands the field; Phase 2 wires
   *  population via `getOrCreateRecipeInsight`. */
  recipe_insight_id?: number;
  /** D-120 Phase 7.5 — bistemporal stamping. Distinguishes when the
   *  underlying real-world event occurred (`event_at`) from when
   *  Recued recorded the run (`started_at` / `ts`). Backfill recipes
   *  walking historical mail / calendar emit a per-link `event_at`
   *  matching the source record's `Date:` header so `data.timeline()`
   *  surfaces the actual chronology, not a phantom-recent spike at
   *  the moment the user kicked off backfill. Null means "no
   *  underlying world event" — manual annotation, runtime-inferred
   *  record, etc. — and queries fall back to ingestion time via
   *  `COALESCE(event_at, ts)` at the SQL boundary. */
  event_at?: number;
  /** D-120 Phase 7.5 — `'live'` for default reactive/cron firings;
   *  `'backfill'` for cursor-loop recipes intentionally walking
   *  historical data; `'manual'` for explicit user invocations from
   *  the UI / chat / Run-Now. Engine derives at run start from
   *  `recipe.run_mode` (declarative) ∨ trigger inference (default
   *  `'manual'` for chat/Run-Now/UI; default `'live'` for cron /
   *  reactive / auto_run). */
  run_mode?: RunMode;
  // ──────────────────────────────────────────────────────────────
  // D-153 P1 — Commit substrate substrate fields. All optional in
  // P1.A; the Engine substrate (D-145) is what populates them with
  // non-null values. Today's synchronous recipe-runner leaves them
  // undefined except where the engine wires them through.
  // Spec: D-153 § Commit substrate.
  // ──────────────────────────────────────────────────────────────
  /** Observable category — `'action'` (outbound side-effect),
   *  `'query'` (inbound read), or `'cognition_output'` (composition /
   *  plan / classification artifact). Legacy recipe-level rows leave
   *  this undefined; tool-level commits emitted by the engine populate
   *  it at write time. */
  commit_kind?: CommitKind;
  /** D-153 / D-145 engine-wiring slice 2 — the typed `(channel ×
   *  actor)` source that dispatched this run. Run-level by
   *  construction: a recipe run has exactly one dispatch origin, so —
   *  unlike `commit_kind`, which is per-tool-call — this field is
   *  coherent on the coarse recipe-run row. `channel_session_id` is the
   *  derived projection of this source; persisting the full
   *  `ExecutionSource` keeps `actor` + the channel-specific identifying
   *  fields (`cron` / `event_kind` / `task` / `agent_id` / …)
   *  recoverable for policy-replay + forensics. Populated from
   *  `ExecuteRequest.execution_source`; undefined on dispatch paths
   *  whose D-153 P2.C slice has not landed. */
  execution_source?: ExecutionSource;
  /** Channel-owned session boundary — Slack thread, chat conversation,
   *  MCP token lifetime, etc. Indexed via `json_extract` for "what
   *  happened in this channel session ever?" queries. */
  channel_session_id?: string;
  /** Engine-assigned per cognition window — the same context window /
   *  system prompt / cognition component. Multiple cognition sessions
   *  can coexist under one channel_session_id (mastermind +
   *  decentralisation pattern). Indexed via `json_extract`. */
  cognition_session_id?: string;
  /** Engine-assigned per intent burst (~1-min heuristic). The unit
   *  save-as-Recipe operates on. Indexed via `json_extract`. */
  correlation_id?: string;
  /** Gateway-generated UUID at dispatch time; passed to the tool's
   *  resume protocol as the dedup key when the external system
   *  supports one. Pre-dispatch persistence + idempotency_key + the
   *  `'in_doubt'` status are the substrate's crash-safety primitives. */
  idempotency_key?: string;
  /** Set when this commit is compensating a prior one — `schedule.delete`
   *  pointing at a prior `schedule.create`, etc. Single-predecessor by
   *  design; N-to-1 compensation is deliberately unsupported at the
   *  substrate level (bulk operations decompose into sub-tasks). */
  predecessor_commit_id?: string;
  /** Resolved contract scope inlined at Gateway dispatch time. Required
   *  on every commit whose `source` carries a `contract_id` (D-161 N.4 —
   *  a `'contracted_user'`, or a self-restricted `'user_self'`) so audit
   *  + save-as-Recipe remain interpretable after the contract is revoked
   *  or version-bumped. Undefined for an unrestricted `'user_self'` /
   *  `'system'` / `'anonymous'` source. */
  contract_snapshot?: ContractSnapshot;
  // ──────────────────────────────────────────────────────────────
  // D-157 P1 slice 4 — preflight pause fields. Both set together
  // when the run anchor's `commit_status === 'awaiting_approval'`
  // (a preflight-approval gate paused the run). Cleared on terminal
  // transitions — a fresh audit row at `Approve` / `Deny` mints a
  // new run row that pins to the same `run_id` but resets these
  // fields. Spec: D-157 § A.3.
  // ──────────────────────────────────────────────────────────────
  /** FK to the persisted `Checkpoint` whose `run_id` matches this
   *  anchor's. Set iff `commit_status === 'awaiting_approval'`; a
   *  boot sweep pairs an awaiting anchor with its checkpoint via
   *  `CheckpointStore.get(checkpoint_id)` to detect drift (a
   *  checkpoint reaped by the staleness guard while the anchor
   *  survives → the anchor is force-failed). */
  checkpoint_id?: string;
  /** FK to the D-158 `PendingAsk` whose answer resolves the gate.
   *  Set iff `commit_status === 'awaiting_approval'`. The
   *  `notification.ask` mints the id; this anchor records it so a
   *  boot sweep can confirm the ask is still `'open'` / `'answered'`
   *  before deciding to re-raise. */
  ask_id?: string;
  /** D-181 §12 — display category for a failed / killed long-op run, derived
   *  at the audit write from the in-flight registry's control-termination
   *  marker (`killed` / `cancelled_before_dispatch`) + any run error's
   *  structured stall telemetry (`details.heavy_op.kill_reason`). Persisted
   *  on the whole-entry blob (no schema column) so the Runs feed projects it
   *  verbatim. Absent on succeeded / awaiting / ordinary-failure rows. */
  error_category?: HeavyOpErrorCategory;
}

/** Activity action code. Phase B adds `pressure_eviction_run` +
 *  `audit_retention_prune`. Phase C adds 12 lifecycle codes covering
 *  boot / shutdown / restart / crash / drain / signal / crash-loop /
 *  lock-conflict / config-hot-reload. Phase D adds 9 warehouse-
 *  collection codes (sync lifecycle, record churn, retention, webhook
 *  inbound + auth rejection). */
export type ActivityAction =
  | 'install' | 'uninstall' | 'vault_set' | 'vault_clear' | 'approval_allow' | 'approval_deny'
  | 'schedule_create' | 'schedule_update' | 'schedule_delete'
  | 'sync_connect' | 'sync_disconnect' | 'sync_push' | 'sync_pull'
  | 'mcp_dispatch'
  | 'account_set' | 'account_clear'
  // D-103 Phase A additions.
  | 'shared_write' | 'shared_delete' | 'shared_delete_prefix'
  | 'pressure_state_change' | 'crash_halt_toggle'
  // D-188 — master "Pause server" engage/release (control action; reserve-class).
  | 'server_pause_toggle'
  // D-202 — Switch A/B quality kill-switch engage/release (control action;
  // reserve-class). Distinct from the master pause: it only suppresses the
  // delegation shortcuts (quality, or both axes), returning sends to review.
  | 'quality_gate_switch_toggle'
  | 'account_mismatch_rejected' | 'quota_exceeded' | 'tier_limit_exceeded'
  // Phase B additions.
  | 'pressure_eviction_run' | 'audit_retention_prune'
  // D-157 N.8 — one summary row per stale-checkpoint retention pass
  // that did work (staleness-guard expiries + checkpoint garbage
  // collection). Reserve-class: low-volume, and the forensic record of
  // "this paused run was expired unanswered" must survive eviction.
  | 'checkpoint_retention_prune'
  // D-105 Phase C additions — lifecycle + supervisor.
  | 'server_boot' | 'server_shutdown' | 'server_restart' | 'server_crashed'
  | 'drain_started' | 'drain_completed' | 'drain_aborted'
  | 'crash_loop_detected' | 'crash_loop_reset'
  | 'lock_conflict' | 'signal_received' | 'config_hot_reloaded'
  // D-106 Phase D additions — warehouse collections (mail / file / webhook).
  // Sync-loop lifecycle (adapter state transitions — medium volume, non-reserve).
  | 'collection_sync_start' | 'collection_sync_complete' | 'collection_sync_error'
  // Per-record churn (high-volume; sample via log level when debugging).
  | 'collection_record_created' | 'collection_record_updated' | 'collection_record_deleted'
  // Retention pruner — forensic ledger, reserve-class.
  | 'collection_retention_prune'
  // D-172 P1 — content bytes read from data.file received warehouse records.
  | 'file_content_read'
  // Webhook inbound — high-volume success, reserve-class auth rejection.
  | 'webhook_received' | 'webhook_rejected_auth'
  // D-109 Phase G additions — event triggers + archive flow + audit export.
  // `trigger_fired` stays user-class (high-volume: every matched event).
  // `trigger_auto_disabled` is reserve (operator needs the record).
  // Archive lifecycle + audit export are reserve — forensic events that
  // a compliance audit specifically asks for.
  | 'trigger_fired' | 'trigger_auto_disabled'
  // Event-trigger binder — distinguishes warehouse-event-bound triggers
  // from the generic `trigger_*` codes above. Backpressure fires when
  // the dedup / dispatch pipeline drops an event under load; auto-disable
  // fires when a binding crosses the error-count threshold.
  | 'event_trigger_backpressure' | 'event_trigger_auto_disabled'
  | 'archive_export_start' | 'archive_export_complete'
  | 'archive_import_start' | 'archive_import_complete'
  | 'audit_export'
  // D-118 Phase 8 additions — `data.service` lifecycle events. One
  // ActivityEntry per ServiceAuditEvent; `target = slug`, `detail`
  // carries the JSON-encoded `{ binary, event_name, argv, error }`
  // tail. The Phase 6 service-logs kernel ingredient filters by
  // `target = slug` then parses each detail blob back into
  // `ServiceAuditEvent` for the recipe-facing shape.
  | 'service_event'
  // D-119 Phase 13 additions — annotation + link warehouse writes.
  // User-class (recipe authors fire these on every reactive tick);
  // not reserve. Target carries `<collection>/<id>#<key>` for
  // annotations and `<from> <role> <to>` for links so the audit feed
  // renders the cross-collection relationship without re-fetching.
  | 'annotation_write' | 'annotation_delete'
  | 'link_write' | 'link_delete'
  // D-124 Phase 2.4 — single sync-level row per drain completion.
  // Target carries `<platform>:<slug>`; `detail` is JSON-encoded
  // `BackfillAuditDetail` (status / duration_ms / records_imported /
  // records_failed / earliest+latest event_at / run_mode='backfill').
  // Steady-state delta sync emits NO row — Phase 2.4 only fires once
  // when the adapter's initial drain transitions from cursor-unstable
  // to cursor-stable. Non-reserve: low-volume (< 10 per server-month),
  // not forensically critical.
  | 'collection_backfill'
  // D-125 Phase 3.2 — one row per connection adapter dispatch, faceted
  // by transport kind so list / filter queries scope without parsing
  // the JSON detail. Target carries the connection record's `name`;
  // `detail` is JSON-encoded `ConnectionAuditDetail` (subtype / status /
  // duration_ms / bytes_in? / bytes_out? / error? / intent — the
  // wrapper ingredient's `permission` field). Volume tracks call rate
  // per connection (mid-tier user: ~100s/day across all wrappers); not
  // reserve — retention pruner reclaims like every other adapter call
  // breadcrumb.
  | 'connection_api' | 'connection_mcp' | 'connection_notification'
  // D-218 — a refreshed credential could not be written back to the connection
  // store. ⛔ **An own row because for a SINGLE-USE rotating token the swallow
  // is not free.** The exchange already invalidated the stored credential, so
  // the durable row now holds a dead token: the next call pays an extra
  // round trip to discover that and log in again. That is recoverable — which
  // is why the call is NOT failed (D-218 § 7.5d) — but it signals a storage
  // problem, and a silently swallowed write leaves nothing to notice it by.
  // `target` = `<connection_name>`; `detail` carries the auth type + the
  // non-secret error text.
  | 'connection_credential_persist_failed'
  // D-165 P0 — one row per gateway-routed catalog-form operation call
  // (Invariant 5), emitted on success, execution failure, AND gate
  // denial. Target carries the connection record `name`; `detail` is
  // JSON-encoded with `source: 'connection.gateway'` plus the resolved
  // (catalog-derived) operation policy — operation_id / operation_group /
  // effective risk_tier / approval / outcome / failure_mode? /
  // surface_kind? / duration_ms? / recipe_id? / step_id?. Distinct from
  // `connection_api`: that captures the TRANSPORT call (method / bytes /
  // status); this captures the POLICY decision (what risk was derived +
  // approved). Non-reserve — volume tracks catalog-operation call rate.
  | 'connection_gateway'
  // D-127 Phase 1.7 — one row per `MailCollection.send` call. Target
  // carries the sender mail instance (`<platform>:<slug>`); `detail`
  // is JSON-encoded `MailSendAuditDetail` (recipient_count / subject /
  // message_id / body_bytes / success / warnings? / error? /
  // recipients?). Body content is excluded for privacy; recipient
  // addresses are listed when the count is ≤
  // `MAIL_SEND_AUDIT_RECIPIENT_REDACTION_THRESHOLD` and redacted to
  // count-only above that. Distinct from `connection_notification`:
  // mail-send is a recipe-driven deliverable while notification is the
  // fan-out channel — the audit feed surfaces them separately.
  | 'mail_send'
  // D-123 Phase 7 — one row per housekeeping cycle. Target is
  // `'system'`; `detail` is JSON-encoded
  // `{ preset, duration_ms, tasks_stepped, tasks_complete,
  //    tasks_yielded, tasks_errored, per_task }`. Volume tracks
  // preset cadence (balanced default fires every 15 min when idle),
  // not reserve — retention pruner reclaims like every other
  // operational breadcrumb. Per-task durations + yield reasons let
  // the Settings panel + post-launch tuning identify slow tasks.
  | 'housekeeping_cycle'
  // D-136 §A.12 P7 — `housekeeping.topic.reset` rpc confirm path.
  // `target` is the topic name; `detail` carries scope_filter / psi
  // flag / row counts / pinned-skipped count / paired-client id.
  | 'housekeeping_topic_reset'
  // D-145 PA11 — `housekeeping.cache.clear` rpc. `target` empty;
  // `detail` carries `rows_deleted` + paired-client `instance_id`.
  // Reversible (cache refills from producer runs), but the audit row
  // makes the deliberate user action reconstructable.
  | 'housekeeping_cache_clear'
  // D-148 § A.6.5 — one row per `tls-cert-renewal` task attempt.
  // Target is `'tls_private_key'`; `detail` carries
  // `{ ok, new_fingerprint?, rotated_at?, error?, cert_valid_until }`.
  // Settings → Key Health filters on this action to surface auto-renew
  // outcomes distinct from operator-initiated `tls.renew` rpc rows
  // (which land under `key_rotation` via the rotation engine's effects).
  // Codex P2 #2 fold — pre-fold the housekeeping sink squashed every
  // task's audit row under `'housekeeping_cycle'`, so this action would
  // not have been queryable; the sink now honours `row.action`.
  | 'tls_auto_renew_attempted'
  // D-148 § A.2.5 — high-assurance audit kinds. Each row carries an
  // Ed25519 `signature` field populated by the signing audit-log
  // wrapper at emit time using `server_identity_key`. The verifier
  // rejects rows whose `action` is in this set but whose signature
  // is missing or invalid. The closed list is mirrored on the
  // contracts side as `HIGH_ASSURANCE_AUDIT_KINDS`.
  //
  // W3.5 path-routing amendment retires `exposure_profile_change` and
  // adds the per-path kinds `exposure_path_resolution_change` +
  // `exposure_preset_apply`. Pre-launch zero-installs → no compat
  // shim (the legacy kind is dropped outright).
  | 'key_rotation'
  | 'exposure_path_resolution_change'
  | 'exposure_preset_apply'
  | 'handle_change'
  | 'pair_revoke'
  | 'cert_renewal'
  | 'passport.exported'
  // R26.4 Delta 5 — passport import commit on a new server (migration
  // provenance). High-assurance on the contracts side.
  | 'passport.imported'
  | 'public_mcp_acknowledged'
  | 'public_mcp_revoked'
  // D-148 W3.10 — `--reset-exposure` boot-flag failsafe. Operator-
  // initiated CLI recovery from a lockout state (e.g. /ws fully off
  // with no other admin channel). Discards the persisted
  // `exposure_state` row and re-derives from the W3.5b bootstrap.
  // High-assurance: same signing discipline as other exposure
  // actions; reserve-class so the recovery audit trail survives
  // retention pruning.
  | 'exposure_reset_via_cli'
  // D-148 follow-up #5 — `pro_acme.unbind` rpc tears down a Pro
  // `<handle>.recued.cloud` DDNS subdomain + removes the auto-managed
  // cert in one transaction. High-assurance: signed with
  // `server_identity_key` so the cloud-side release's authoritative
  // provenance is preserved; reserve-class so the release audit trail
  // survives retention pruning. Closed-list parity with
  // `HIGH_ASSURANCE_AUDIT_KINDS` on the contracts side.
  | 'pro_acme_unbound'
  // D-175 P5 — account ↔ server binding lifecycle. High-assurance:
  // signed with `server_identity_key` so the ownership ledger (who
  // owned this server, the confirmed rebind, the unbind, the contention
  // conflict, the failed-exchange attack trail) is non-repudiable;
  // reserve-class so it survives retention pruning. Closed-list parity
  // with `HIGH_ASSURANCE_AUDIT_KINDS` + `ACCOUNT_BINDING_AUDIT_ACTIONS`
  // on the contracts side.
  | 'account_bind'
  | 'account_rebind'
  | 'account_unbind'
  | 'account_bind_conflict'
  | 'account_bind_exchange_failed'
  | 'credential_rotate'
  // D-145 PB1.5 — capacity_spec walker emission. `capacity_check.ok`
  // is non-reserve (high-volume; one row per successful walk).
  // `capacity_check.gap` is reserve-class so the operator/user audit
  // trail of capability gaps survives retention pruning.
  | 'capacity_check.ok'
  | 'capacity_check.gap'
  // D-145 PB7 — Transparency Stream substrate emission. One row per
  // wire envelope the composer emits. Target is the plan run id;
  // detail is JSON-encoded `TransparencyAuditDetail` carrying the
  // raw event + resolved chat-log redaction tier + emitted_at +
  // closed-list source (`'ai_emitted' | 'engine_brokering' |
  // 'failure' | 'orchestration'` — D-164 P6.7 retired `'two_stage'`
  // alongside the Stage 1 / Stage 2 events).
  // Non-reserve at PB7 — high volume in busy chats (multiple events
  // per turn); retention pruner reclaims like other user-class
  // operational breadcrumbs. The `source: 'failure'` discriminator
  // surfaces user-must-see failure events (privacy.hard_fail /
  // cost_ceiling.halted / standing_instruction_conflict / etc.) for
  // post-incident replay; reserve-class promotion of those rows can
  // happen post-launch if the user-class default proves too
  // aggressive on truthful-failure retention.
  | 'transparency_stream'
  // D-145 PB12 — `redacted_packet` substrate emission. One row per
  // `s2s_preview.build` (`redacted_packet.built`) + one row per
  // `s2s_preview.consume` (`redacted_packet.accessed`). `target`
  // carries the `access_token` digest (so the linkage between
  // build + access rows is queryable without leaking the raw
  // token); `detail` is JSON-encoded `RedactedPacketBuildAuditDetail`
  // / `RedactedPacketAccessAuditDetail` (packet_kind /
  // fields_visible / created_at / expires_at / consumer? /
  // audit_target_id?). Both are non-reserve — high volume on busy
  // peer-MCP / D-149 reception surfaces; the build event ledger
  // doubles as the consumer-side trace via `audit_target_id`.
  | 'redacted_packet.built' | 'redacted_packet.accessed'
  // D-137 P1 — AI Chat substrate audit. Closed taxonomy covering
  // session lifecycle + per-turn dispatch + plan-approval. The
  // `channel` discriminator (internal_function_call vs mcp_wire)
  // is carried in the JSON-encoded `detail`.
  // All rows non-reserve at P1 — chat volume tracks per-user
  // cadence (busy chat sessions emit dozens of rows per minute) and
  // the lifecycle codes below are operational breadcrumbs, not
  // forensically critical events. Plan-approval rows
  // (`chat_plan_proposed` / `chat_plan_approved` / `chat_plan_-
  // cancelled`) are deliberately non-reserve because the underlying
  // approval substrate (D-052) emits its own reserve-class rows;
  // chat-side rows are renderer-attribution breadcrumbs.
  //
  // - `chat_session_created` — new ChatSession row. `target` =
  //   `<session_id>`; `detail` carries `{title?, picker, model_layer}`.
  // - `chat_session_deleted` — session row deleted. `target` =
  //   `<session_id>`; `detail` carries `{message_count_deleted}`.
  // - `chat_message_sent` — one row per turn (user + assistant +
  //   tool roles). `target` = `<session_id>:<message_id>`; `detail`
  //   carries `{role, target_server, model_used, tool_call_count}`.
  // - `chat_tool_call` — one row per `InternalToolRegistry.dispatch`
  //   completion (both internal-channel and mcp_wire). `target` =
  //   `<session_id>:<turn_id>:<tool_name>`; `detail` carries
  //   `{channel, tier, classification, status, reason?, duration_ms}`.
  // - `chat_plan_proposed` — write tool routed to plan-approval.
  //   `target` = `<session_id>:<turn_id>:<plan_id>`; `detail`
  //   carries `{tool, tier, args_digest}`. Body args NEVER reach
  //   the audit row — only a hash digest.
  // - `chat_plan_approved` — Mary confirmed the plan; tool executes
  //   downstream. `target` = `<plan_id>`; `detail` carries
  //   `{edited: boolean}`.
  // - `chat_plan_cancelled` — Mary rejected the plan OR the turn
  //   timed out / picker changed. `target` = `<plan_id>`; `detail`
  //   carries `{reason: 'user_rejected' | 'timeout' | 'session_-
  //   deleted'}`.
  // - `chat_plan_consumed` — the orchestrator gate dispatched a
  //   write on a previously-approved plan (§ A.11 single-use
  //   consumption; the approval is spent and a later re-issue
  //   re-proposes). `target` = `<session_id>:<turn_id>:<tool>`
  //   (the CONSUMING dispatch); `detail` carries
  //   `{plan_id, tier, approved_turn_id}` — the cross-turn
  //   provenance (approved in turn X, consumed in turn Y) is the
  //   forensically interesting bit.
  // - `chat_export` — Mary triggered `chat.session.export`.
  //   `target` = `<session_id>`; `detail` carries
  //   `{message_count, format: 'json'}`.
  | 'chat_session_created' | 'chat_session_deleted'
  | 'chat_message_sent' | 'chat_tool_call'
  | 'chat_plan_proposed' | 'chat_plan_approved' | 'chat_plan_cancelled'
  | 'chat_plan_consumed'
  | 'chat_export'
  // D-137 W2.2 § A.1.1 — Mary toggled her per-kind chat catalog scope.
  // `target` = `'chat_tool_catalog_scope'` (singleton); `detail`
  // carries `{enabled_kinds}` so the audit feed can render "Mary
  // enabled mail / disabled connection". Non-reserve: settings-style
  // event, not forensically critical.
  | 'chat_tool_catalog_scope_set'
  // D-167 chat provider-threading — the per-pair global chat-model default
  // changed. `target` = `'chat_default_model_pref'` (singleton); `detail`
  // carries `{layer}` so the audit feed can render "set chat model to BYOK".
  // Non-reserve: settings-style breadcrumb.
  | 'chat_default_model_pref_set'
  // D-137 W2.3 § A.1.1 + § A.10 — Mary saved a per-connection MCP tool
  // annotation. `target` = `<connection_name>`; `detail` carries
  // `{topic_tag_count, override_count, classified_count, cached_tool_-
  // count}` so the audit feed can render "Mary classified 3 tools on
  // exa" without leaking individual tool names or descriptions.
  // Non-reserve: settings-style breadcrumb.
  | 'chat_connection_mcp_annotation_set'
  // D-137 P4 § A.7.1 — Mary's `chat.picker.refresh` rpc re-probed a
  // peer (refresh of recued_signature + tools_list_cache).
  // `target` = `<connection_name>`; `detail` carries
  // `{recued_signature_present, cached_tool_count, entry_count}` so
  // the audit feed can render "Mary refreshed Bob's catalog — 8
  // tools, Recued v2.1" without leaking individual tool names.
  // Non-reserve: settings-style breadcrumb.
  | 'chat_picker_refreshed'
  // D-137 P5 § A.9 — Bob issued a new inbound MCP token for a peer.
  // `target` = `<token_id>` (sha256-16 prefix; non-secret); `detail`
  // carries `{label, peer_handle, concurrency_tier, expires_at,
  // grants_total, grants_allowed_count, chat_mode_offered}` so the
  // audit feed can render "Bob issued token to Mary — 14 tools
  // granted, 1y expiry" without leaking the bearer plaintext. Reserve-
  // class (forensically critical — token issuance changes the access
  // surface; survives audit retention prune).
  | 'chat_inbound_token_issued'
  // D-137 P5 § A.9 — Bob updated per-tool grants on an existing token
  // (Settings → MCP Tokens → toggle checkbox). `target` =
  // `<token_id>`; `detail` carries `{grants_total, grants_allowed_-
  // count, grants_added_count, grants_removed_count}` so the audit
  // feed can render "Bob granted 2 / revoked 1 tool on Mary's token"
  // without leaking individual tool names. Non-reserve: settings-style
  // breadcrumb (token already exists; this is a permission edit).
  | 'chat_inbound_token_grants_updated'
  // D-171 slice 3 — Bob rebound an inbound token's `contract_id` (Settings →
  // Permissions → MCP door → Advanced → cap/expiry toggle). `target` =
  // `<token_id>`; `detail` carries `{bound, contract_id?}` — `bound: true` when
  // a cap/expiry was turned on (a minted contract_definition is now the live
  // kill-switch envelope), `bound: false` when the limit was turned off (token
  // rebound to unbound). No bearer / grant leakage. Non-reserve: a settings-
  // style edit on an existing token (the contract mint/revoke is the lifecycle
  // event; this is the binding breadcrumb).
  | 'chat_inbound_token_contract_updated'
  // D-137 P5 § A.9 — Bob revoked an inbound token. `target` =
  // `<token_id>`; `detail` carries `{label, peer_handle, revoked_at}`
  // so the audit feed can render "Bob revoked Mary's token" + the
  // exact revocation time. Reserve-class (forensically critical —
  // revocation IS the access surface change that closed an outstanding
  // contract; survives audit retention prune).
  | 'chat_inbound_token_revoked'
  // D-177 P3 § N.5 — the approval layer minted a session grant from an
  // `allow_session` preflight answer. `target` = `<contract_id>`; `detail`
  // carries `{ingredient_slug, operation_id?, connection_name?, risk_tier,
  // recipe_id, channel, channel_session_id, expiry_at, max_uses,
  // approved_action_ref}` — the bound envelope axes, never arg values (the
  // grant row itself carries the hashes; the approved payload stays in
  // checkpoint + audit per D8). Reserve-class: a session grant is a bounded
  // LOOSENING of the ask gate — an access-surface change with the same
  // forensic posture as inbound-token issuance; the ledger of "what did the
  // human delegate, when, bounded how" survives retention pruning. (Manual
  // revoke rides the existing `collection.contract.revokeContract` rpc; the
  // revoked row's `revoked_at`/`revocation_reason` is that side's record.)
  | 'session_grant_minted'
  // D-177 N.13 (P6c) — the owner ACCEPTED a staged-trust suggestion and the
  // accept rpc minted the `grant_kind: 'delegation'` rule from the stored
  // snapshot. `target` = `<contract_id>`; `detail` carries `{ingredient_id,
  // operation_id?, connection_name?, risk_tier, recipe_id, channel,
  // grant_mode, expiry_at, max_uses, suggestion_key_hash}` — the bound
  // envelope axes + the suggestion anchor, never arg values (the rule row
  // carries the hashes). Reserve-class: a delegation rule is STANDING
  // cross-session authority (ladder 7 — strictly broader than a session
  // grant's loosening), the clearest access-surface change in this family;
  // the ledger of "what standing rule did the human mint, from which
  // suggestion, bounded how" survives retention pruning. (Revoke rides
  // `collection.contract.revokeContract`, as with session grants.)
  | 'delegation_rule_minted'
  // D-202 — a minted QUALITY delegation (the owner accepted a quality-axis
  // suggestion). A standing auto-accept of a (recipe, op)'s output quality —
  // reserve-class for the same access-surface-change rationale as the
  // delegation rule (revoke rides `collection.contract.revokeQualityDelegation`).
  | 'quality_delegation_minted'
  // D-177 N.11 rule 5 (5.c, slice C) — a minted SCOPED session grant: the
  // utterance-derived session-scope overlay the owner accepted. Bounded
  // session authority, but grant-mint class like its siblings — the ledger
  // of "what did the human approve, from which utterance, bounded how"
  // survives retention pruning.
  | 'scoped_grant_minted'
  // D-211 — the owner wrote / deleted an actorless exact-operation row (the
  // global owner-default plane: `approval` REPLACES the authored default,
  // clamped to
  // `[floor(effective_risk), always]`; `risk` may reclassify DOWNWARD behind a
  // warned confirm). `target` = `<operation_id>`; `detail` carries
  // `{ingredient_id, operation_id, policy, prior_policy|null, declared_risk?,
  // effective_risk?, floor_before?, floor_after?, op_hash?}` — the ruling +
  // its floor/grantability consequences, never arg values. Reserve-class: a
  // standing override is a durable re-ruling of the ask gate (an
  // `approval:'never'` silences a held op durably — the same access-surface
  // class as the grant-mint family); the delete restoring the authored
  // default is the other half of that ledger.
  | 'owner_operation_override_written' | 'owner_operation_override_deleted'
  // D-149 P3 § A.3 + § N.3 — Reception substrate high-assurance audit
  // kinds. Mirrors `RECEPTION_HIGH_ASSURANCE_AUDIT_KINDS` from
  // `@recued/contracts/src/reception.ts` verbatim. The signing audit-
  // log wrapper auto-signs every kind in `HIGH_ASSURANCE_AUDIT_KINDS`
  // (which P3 extends to include this set). `target` carries the
  // `endpoint_id` (or `'reception'` for `reception.emergency_disabled`);
  // `detail` is a free-form string the rpc handler composes (kind, packet
  // kind, expiry, rotation reason, etc.). Reserve-class so the audit
  // trail of public-surface mutations survives retention pruning — a
  // ledger of who created / revoked / rotated which endpoint is
  // forensically critical.
  | 'endpoint.created'
  | 'endpoint.enabled'
  | 'endpoint.disabled'
  | 'endpoint.revoked'
  | 'endpoint.extended'
  | 'endpoint.expired'
  | 'endpoint.token_rotated'
  | 'form_submission.received'
  | 'drop_blob.received'
  | 'approval_intent.consumed'
  | 'reception.listener.started'
  | 'reception.listener.stopped'
  | 'reception.emergency_disabled'
  // D-149 P4 § A.5.1 — reception_page singleton config upsert. Mary's
  // edits to the front-door page alter the visitor-facing surface
  // server-wide; reserve-class so the forensic ledger of "who changed
  // the contact card on this date" survives retention pruning.
  | 'reception_page.config_updated'
  // D-200 Slices 6g.3/6g.11 — owner-authored exact intake/recipe pair
  // mutations alter the anonymous visitor path; reserve their provenance.
  | 'reception.intake_recipe_pair.bound'
  | 'reception.intake_recipe_pair.configured'
  | 'reception.intake_recipe_pair.cleared'
  // D-149 P12 § A.20.5 — Abuse Inbox IP ban / unban. Banning a source
  // IP (endpoint-scoped hash) appends to the per-server block list the
  // path-listener enforces; unbanning lifts it. Both alter who can
  // reach the public surface — reserve-class so the forensic ledger of
  // "who banned which IP on this endpoint" survives retention pruning.
  | 'reception.ip_blocked'
  | 'reception.ip_unblocked'
  // D-169 P0 Slice 4 § N.9 / A.8 — one row per successful multi-bridge
  // dispatch. Target carries `<bridge_client_token_id>`; `detail`
  // carries the resolved `target_domain_pattern` (Chrome match
  // pattern). The dispatcher's `lastSuccessfulBridgeDispatch` reads
  // these to drive the iteration-order recency input (no separate
  // success-history table — spec § A.8 / DL-7). Non-reserve — volume
  // tracks recipe-driven bridge dispatch rate; pruning is fine because
  // older rows naturally age out of the iteration-order signal.
  | 'bridge_dispatch_succeeded'
  // D-169 P2 — one row per D-158 notification-block `notify` the server
  // fired. `target` is empty (notify is not entity-scoped); `detail` is
  // JSON-encoded `{ title?, text, link_url? }` (the `NotificationMessage`
  // body). Backs the bridge side panel section #3 (N.5 #3) historical
  // view via `notification.recent` — notify was previously bus-only /
  // ephemeral, so this row is what makes the historical slice durable
  // across a server restart. Non-reserve: notifications are high-volume
  // breadcrumbs the retention pruner reclaims like every other adapter
  // call (a fired notification is not a forensic-critical event).
  | 'notification_fired'
  // D-178 slice 4b — release self-update lifecycle, replayed into the
  // audit log from the out-of-SQLite update ledger on boot (I-3). Target
  // carries the release identity (`<channel>:<version>`); `detail` is the
  // ledger entry's free-form note (revert reason / restore-snapshot flag).
  // Reserve-class: an operator forensically reconstructing "what version
  // ran when, and which update reverted it" must keep these past retention.
  | 'update_applied' | 'update_rolled_back'
  // D-212 follow-on — the keyfile's sealing changed: `rotate-passphrase` or
  // `recover-keyfile`. Both run with the server STOPPED, so the row cannot be
  // written when it happens; it is replayed at the next boot from the
  // append-only `keyfile-events.log` beside the database, idempotent on the
  // ledger entry id. `target` carries the keyfile path; `detail` is JSON
  // `{kind, posture, previous_keyfile?, server_identity_fingerprint?,
  // recorded_at_boot}`. ONE action rather than one per command because the
  // question it answers — "when did the sealing factor last change?" — is one
  // filter, and `kind` inside the detail is what separates a rotation (identity
  // preserved) from a regeneration (identity replaced). Reserve-class: it is
  // asked months later, after a compromise.
  | 'keyfile_sealing_changed'
  // D-182 §7.2 — the owner granted / revoked a per-contract cli reachability
  // cell (the `cli.reachability.set` grid write). `target` carries the cli
  // ingredient slug (`whisper` / `ffmpeg` / …); `detail` is JSON
  // `{principal, risk_tier}` (the grid cell). Granting reachability authorizes a
  // local binary for Gateway-dispatched invocation under that principal — an
  // access-surface change in the same class as a connection grant, so
  // reserve-class: the ledger of "which principal did the owner grant reach to
  // which cli ingredient at which risk tier, when" must survive retention
  // pruning.
  | 'cli_reachability_granted' | 'cli_reachability_revoked'
  // Supervision feature — the cli-daemon keep-alive supervisor's process
  // lifecycle. One row per daemon state TRANSITION (boot reconciliation of a
  // daemon that never ran this boot is suppressed — see setState); `target`
  // carries `<ingredient_slug>/<op>`, `detail` is JSON `{ op, state, pid,
  // last_exit_code, consecutive_crashes }`. Succeeds the D-118 `service_event`
  // row for the retired `kind: service` supervised templates. Reserve-class
  // like the Phase C lifecycle block: an operator diagnosing a daemon
  // crash-loop after the fact needs the full started/crashed sequence (and a
  // supervised daemon — the cloudflared DDNS ingress, ollama serve — dying is
  // operationally critical), while volume stays low (the crash ceiling bounds
  // the burst; a healthy daemon emits one `started` and stays running).
  | 'supervised_daemon_started' | 'supervised_daemon_crashed'
  | 'supervised_daemon_stopped' | 'supervised_daemon_permanently_crashed'
  // Supervision feature — the owner's `supervision.set` ENROLLMENT decision
  // (distinct from the autonomous lifecycle rows above): enrolling / reconfiguring
  // a daemon to manual|auto, or un-enrolling it (mode -> off). `target` carries
  // `<ingredient_slug>/<op>`, `detail` is JSON `{ mode, prior_mode, enabled,
  // restart_policy, restart_on_server_start }`. Reserve-class + symmetric with
  // `cli_reachability_granted/revoked`: configuring a daemon to auto-restart (a
  // persistent background process the owner authorized) is an access-surface
  // change the forensic ledger must keep past retention — "who set this daemon to
  // auto, when". Pure start/stop (mode unchanged) is NOT audited here — that
  // surfaces as the autonomous `supervised_daemon_started/_stopped` lifecycle row.
  | 'supervised_daemon_enrolled' | 'supervised_daemon_unenrolled'
  // D-192 source-data-removal — the opt-in "also remove the mirrored data"
  // teardown on connection removal. `target` = the connection name; `detail`
  // is JSON `{ kind, vendor?, sources_purged, sources_skipped, records_deleted,
  // annotations_deleted, links_deleted, enrichments_deleted, edges_deleted }`.
  // Reserve-class: the record that a user hard-removed a connection's mirrored
  // data is teardown provenance the ledger must keep past retention (spec § 3
  // "Never" tier preserves audit/memory even as the live data is purged).
  | 'source_data_purged';

/** Activity log entry for non-execution events (install, vault, approval, etc.). */
export interface ActivityEntry {
  activity_id: string;
  timestamp: number;
  action: ActivityAction;
  /** What was acted on — recipe_id, vault key, schedule id, etc. */
  target: string;
  /** Optional detail for context. */
  detail?: string;
  /** Reserve-class flag (Phase B). Reserve rows persist past retention
   *  so the activity log always keeps a ledger of pressure-transition,
   *  kill-switch-toggle, and storage-rejection events — even when quota
   *  or retention reclaim would otherwise evict them.
   *  Auto-set by `logActivity` when the action is in `RESERVE_ACTIONS`;
   *  callers can pass an explicit `{ reserve }` to override. */
  reserve?: boolean;
  /** D-148 § A.2.5 — Ed25519 signature (base64) over the canonical
   *  JSON of this entry minus this field + `signer_fingerprint`,
   *  signed with the server's `server_identity_key`. Populated by
   *  the audit-signing wrapper (`createSigningAuditLog`) at emit
   *  time when `action` is in `HIGH_ASSURANCE_AUDIT_KINDS`. Verifier
   *  (`verifyActivityEntry`) rejects rows whose action requires a
   *  signature but where this field is missing, malformed, or fails
   *  Ed25519 verify against the public key keyed on
   *  `signer_fingerprint`. Absent for non-high-assurance rows. */
  signature?: string;
  /** D-148 § A.2.5 — public-key fingerprint (`sha256:<hex>`) of the
   *  `server_identity_key` that produced `signature`. The verifier
   *  uses this to look up the right public key from a key-history
   *  store, so rows signed by a pre-rotation key still verify after
   *  `server_identity_rotate`. Populated alongside `signature`. */
  signer_fingerprint?: string;
}

/** Activity actions classified as reserve-class (Phase B). A write
 *  carrying one of these actions is admitted against the gate's reserve
 *  region even when user-class writes are blocked. Reserve rows are
 *  skipped by the retention pruner so the ledger of pressure / halt /
 *  quota events survives the eviction cascade.
 *
 *  Kept as a `Set<string>` (not a narrow type of `ActivityAction`) so
 *  adapters that feed additional diagnostic action codes through
 *  `logActivity` can still contribute reserve classification without
 *  widening the enum. */
export const RESERVE_ACTIONS: ReadonlySet<string> = new Set<string>([
  'pressure_state_change',
  'pressure_eviction_run',
  'crash_halt_toggle',
  // D-188 — the record of "the owner paused/resumed the server" is a
  // control action worth surviving eviction (forensic + audit invariant).
  'server_pause_toggle',
  // D-202 — "the owner engaged/released a quality kill-switch" is likewise a
  // control action worth surviving eviction.
  'quality_gate_switch_toggle',
  // D-192 — the teardown-purge record is provenance that outlives the data it
  // removed; it must survive retention pruning.
  'source_data_purged',
  'quota_exceeded',
  'tier_limit_exceeded',
  'account_mismatch_rejected',
  'audit_retention_prune',
  // D-157 N.8 — the stale-checkpoint sweep's summary row: the record
  // that a paused run was expired unanswered (or its crash-residue
  // checkpoint reclaimed) is exactly what a "where did my pending
  // approval go?" investigation needs months later.
  'checkpoint_retention_prune',
  // D-210 — the record that the OWNER answered an approval, by the same
  // reasoning as the row above: "did I approve that, when, and from
  // where?" is a months-later question. It is also now the ONLY durable
  // record of the decision — the terminal `PendingAsk` row it used to
  // live on is pruned (`AskStore.pruneHandled`), and the run anchor's
  // `ask_id` back-pointer is overwritten when the answer resumes the run.
  // Evictable would mean the prune is lossy after all.
  // Volume is human-rate (one row per decision the owner actually made),
  // and each row is far smaller than the ask row it replaces.
  'approval_allow',
  'approval_deny',
  // Phase C: lifecycle events must persist past retention so the
  // ledger of boot / shutdown / restart / crash / drain / crash-loop
  // always survives eviction. These are low-volume but forensically
  // critical — an operator diagnosing a crash-loop after the fact
  // needs the full sequence, not a truncated recent window.
  'server_boot',
  'server_shutdown',
  'server_restart',
  'server_crashed',
  'drain_started',
  'drain_completed',
  'drain_aborted',
  'crash_loop_detected',
  'crash_loop_reset',
  'lock_conflict',
  'config_hot_reloaded',
  // D-178 slice 4b — release self-update lifecycle (replayed from the
  // out-of-SQLite update ledger). The record of which version applied /
  // rolled back must survive eviction for forensic version-history.
  'update_applied',
  'update_rolled_back',
  // D-212 follow-on — "when did the sealing factor last change, and did I do
  // it?" is a months-later question asked after a compromise, and this row is
  // the only structured answer (the `.pre-rotate-<ms>` backup's filename is the
  // alternative). Evictable would mean the record expires before the question
  // is asked. Volume is a handful over a realm's lifetime.
  'keyfile_sealing_changed',
  // D-182 §7.2 — cli reachability grant/revoke. Granting a cell authorizes a
  // local binary for Gateway-dispatched invocation under a principal
  // (access-surface change, grant class); the forensic ledger of "which
  // principal did the owner grant reach to which cli ingredient at which risk
  // tier, when" must survive retention pruning.
  'cli_reachability_granted',
  'cli_reachability_revoked',
  // Supervision feature — daemon lifecycle, same forensic rationale as the
  // Phase C server lifecycle: the full started / crashed / permanently_crashed
  // sequence must survive retention so a daemon crash-loop is reconstructable.
  'supervised_daemon_started',
  'supervised_daemon_crashed',
  'supervised_daemon_stopped',
  'supervised_daemon_permanently_crashed',
  // Supervision enrollment — the owner's persistent "auto-restart this daemon"
  // decision, an access-surface change in the same class as a cli reachability
  // grant; the ledger of who enrolled/un-enrolled which daemon, when, must
  // survive retention.
  'supervised_daemon_enrolled',
  'supervised_daemon_unenrolled',
  // `signal_received` intentionally NOT reserve — high-volume (every
  // SIGHUP, SIGUSR1 debug dump) and redundant with the higher-level
  // codes that follow from any action-taking signal.
  // Phase D: collection retention prunes survive eviction so the
  // forensic ledger keeps the record of what got dropped and when,
  // even after the retention pruner itself would otherwise prune
  // the row. Auth-rejected webhook deliveries are reserve because
  // they're the security signal — low-volume and high-value for
  // spotting credential stuffing / HMAC probing.
  'collection_retention_prune',
  'webhook_rejected_auth',
  // `collection_sync_*` stays user-class — medium-volume across a
  // working day; a crash-loop diagnosis can lean on the lifecycle
  // codes already reserved above.
  // `collection_record_*` + `webhook_received` stay user-class —
  // these are the high-volume churn codes; reserve would starve the
  // retention floor.
  // Phase G (D-109) — trigger auto-disable + archive lifecycle + audit
  // export. `trigger_fired` deliberately NOT reserve (volume mirrors
  // `webhook_received`); archive start/complete pairs stay reserve so
  // the ledger of restore events survives a long retention window.
  'trigger_auto_disabled',
  'event_trigger_auto_disabled',
  'archive_export_start',
  'archive_export_complete',
  'archive_import_start',
  'archive_import_complete',
  'audit_export',
  // D-148 § A.2.5 — high-assurance audit kinds always reserve. Key
  // rotations, exposure path-resolution changes / preset applies,
  // handle changes, pair revokes, cert renewals, passport exports,
  // and public-MCP acknowledgements are forensically critical and
  // never surrender to retention pruning. The signing-wrapper writes
  // these with a signature attached; reserve discipline keeps the
  // signed ledger intact across the server's full lifetime. W3.5
  // path-routing amendment swaps `exposure_profile_change` for the
  // two per-path kinds.
  'key_rotation',
  'exposure_path_resolution_change',
  'exposure_preset_apply',
  'handle_change',
  'pair_revoke',
  'cert_renewal',
  'passport.exported',
  // R26.4 Delta 5 — passport import provenance; reserve-class so the
  // migration ledger survives retention pruning (mirrors
  // `HIGH_ASSURANCE_AUDIT_KINDS` membership on the contracts side).
  'passport.imported',
  'public_mcp_acknowledged',
  'public_mcp_revoked',
  // D-148 W3.10 — operator CLI recovery; reserve-class so the
  // forensic trail of the reset survives retention pruning.
  'exposure_reset_via_cli',
  // D-148 follow-up #5 — Pro handle release; reserve-class so the
  // release audit trail survives retention pruning. Mirrors
  // `HIGH_ASSURANCE_AUDIT_KINDS` membership on the contracts side.
  'pro_acme_unbound',
  // D-145 PB1.5 — capability-gap rows are reserve so the operator
  // audit retains the gap history even when retention pruning would
  // otherwise reclaim user-class breadcrumbs. `capacity_check.ok`
  // stays user-class (one row per successful walk; volume tracks
  // primitive cadence).
  'capacity_check.gap',
  // D-137 P5 § A.9 — inbound-token issuance + revocation are forensic-
  // ally critical access-surface events. Issuance grants a new credential
  // to a peer; revocation closes an outstanding contract. Both must
  // survive retention pruning so Bob's ledger always carries the full
  // credential history (matches the spec § A.9 acceptance: "Bob can
  // issue token to Mary, see exposure per tool, revoke"). `chat_inbound_-
  // token_grants_updated` stays user-class — settings-style permission
  // edits on an existing token.
  'chat_inbound_token_issued',
  'chat_inbound_token_revoked',
  // D-177 P3 § N.5 — a minted session grant is a bounded loosening of the
  // ask gate: an access-surface change in the same forensic class as
  // inbound-token issuance. The ledger of "what did the human delegate,
  // when, bounded how" survives retention pruning.
  'session_grant_minted',
  // D-177 N.13 (P6c) — a minted delegation rule is STANDING cross-session
  // authority (ladder 7), strictly broader than a session grant's bounded
  // loosening — same reserve rationale, stronger case.
  'delegation_rule_minted',
  // D-202 — a minted quality delegation is a standing auto-accept surface; the
  // ledger of "what (recipe, op) quality did the owner delegate" survives pruning.
  'quality_delegation_minted',
  // D-177 N.11 rule 5 (5.c, slice C) — same reserve rationale, session-bound.
  'scoped_grant_minted',
  // D-211 Slice 1 — an owner override is a STANDING re-ruling of an op's
  // approval/risk: `approval:'never'` on a held op is a standing loosening of
  // the ask gate, the same reserve rationale as `session_grant_minted` below
  // (a loosening of the ask gate whose ledger — "what did the human silence /
  // reclassify, when" — must survive retention pruning), and it is UNBOUNDED
  // in time where a session grant is bounded, so the case is stronger. The
  // delete that restores the authored default is the other half of that
  // ledger and must survive with it.
  'owner_operation_override_written',
  'owner_operation_override_deleted',
  // D-175 P5 — account ↔ server binding lifecycle. Reserve-class so the
  // forensic ledger of who owned this server (bind / rebind / unbind),
  // the ownership-contention conflicts, and the failed-exchange attack
  // trail survive retention pruning. Mirrors the high-assurance kinds in
  // `@recued/contracts` `keys.ts` (`ACCOUNT_BINDING_AUDIT_ACTIONS`); the
  // signing wrapper writes these with a signature attached and reserve
  // discipline keeps the signed ledger intact across the server's
  // lifetime — same posture as `pair_revoke` / `key_rotation` above.
  'account_bind',
  'account_rebind',
  'account_unbind',
  'account_bind_conflict',
  'account_bind_exchange_failed',
  'credential_rotate',
]);

/** True when `action` is in the Phase B reserve-class set. Exposed so
 *  callers (audit-store gate wiring in Commit 6e) can decide
 *  `canWrite(bytes, { reserve })` without re-importing the set. */
export const isReserveAction = (action: string): boolean =>
  RESERVE_ACTIONS.has(action);

/** Per-append override for reserve classification (Phase B). Auto-
 *  classification based on the entry's action / run shape is the default;
 *  pass `{ reserve: true }` to force reserve on edge cases the classifier
 *  misses (e.g. recovery-key-unlock audit rows), or `{ reserve: false }`
 *  to explicitly opt out. */
export interface AppendOptions {
  reserve?: boolean;
}

/** Public interface of the audit log store. */
export interface AuditLogStore {
  /** Append a new entry. The entry's `run_id` is the storage key.
   *  `options.reserve` overrides the entry-level `reserve` field. */
  append(entry: AuditEntry, options?: AppendOptions): Promise<void>;
  /** List the most recent `limit` entries, newest first.
   *
   *  D-161 P3 — `opts.origin_actors` filters by the entry's write-actor
   *  lane (`execution_source.actor`; absent → `'system'`) BEFORE the
   *  `limit` slice, so the result is `limit` *matching* rows, not `limit`
   *  rows then narrowed down. Omitted / empty → no filtering: behavior is
   *  byte-identical to pre-P3, so callers that want the whole feed
   *  (`memory.search`, audit export, the `recued_getAudit` MCP tool) stay
   *  unchanged (I-9). The aggregate "Recent activity" handler supplies the
   *  default foreground set (`TIMELINE_DEFAULT_ORIGIN_ACTORS`). */
  listRecent(
    limit: number,
    opts?: { origin_actors?: readonly Actor[] },
  ): Promise<AuditEntry[]>;
  /** List all entries for a specific recipe_id, newest first. */
  listByRecipe(recipe_id: string, limit?: number): Promise<AuditEntry[]>;
  /** D-153 P1.B — list entries that share a `channel_session_id` —
   *  the "what happened in this Slack thread ever?" programmatic
   *  query. Empty result when `id` is empty or matches no rows.
   *
   *  `axis` controls ordering (default `'ingestion'`): `'ingestion'`
   *  sorts by `started_at` DESC (engine-record chronology),
   *  `'event'` sorts by `COALESCE(event_at, started_at)` DESC so
   *  backfilled rows surface in real-world chronology. Sort happens
   *  over the full scope-matched set before the slice — there is no
   *  hidden window-truncation: a backfill burst cannot push live rows
   *  out of the top results no matter the scope size. */
  listByChannelSession(
    channel_session_id: string,
    limit?: number,
    axis?: TimelineAxis,
  ): Promise<AuditEntry[]>;
  /** D-153 P1.B — list entries that share a `cognition_session_id` —
   *  the "what did cognition do in this conversation arc?"
   *  programmatic query. Empty result when `id` is empty or matches no
   *  rows. `axis` follows the same rules as `listByChannelSession`. */
  listByCognitionSession(
    cognition_session_id: string,
    limit?: number,
    axis?: TimelineAxis,
  ): Promise<AuditEntry[]>;
  /** D-153 P1.B — list entries that share a `correlation_id` — the
   *  "what was the dentist task?" programmatic query. Empty result
   *  when `id` is empty or matches no rows. `axis` follows the same
   *  rules as `listByChannelSession`. */
  listByCorrelation(
    correlation_id: string,
    limit?: number,
    axis?: TimelineAxis,
  ): Promise<AuditEntry[]>;
  /** D-215 slice 2 — list entries produced by one DISH: the "what has
   *  this queued item actually done?" query behind the dish detail's
   *  history. Empty result when `id` is empty or matches no rows.
   *  `axis` follows the same rules as `listByChannelSession`.
   *
   *  A RETIRED dish still matches — `dish_id` outlives the dish row by
   *  design (an auto-run config change dissolves the prior dish and a
   *  one-shot retires itself on success, both leaving audit intact), so
   *  callers render an unresolvable id as *retired*, never as an error. */
  listByDish(
    dish_id: string,
    limit?: number,
    axis?: TimelineAxis,
  ): Promise<AuditEntry[]>;
  /** D-215 slice 2 — the NEWEST entry for each of many dishes, in ONE
   *  pass. The dish LIST needs a last-outcome cell per row; calling
   *  `listByDish` per dish would be N full scans of the log, so this
   *  buckets a single scan instead. Dishes with no runs are absent from
   *  the map (callers render "never run"), and an empty/duplicate-laden
   *  input is tolerated.
   *
   *  Ordering is `started_at` (ingestion) — "the last time this dish
   *  ran" is a question about the engine's record, not about real-world
   *  event time, so it deliberately does NOT take a `TimelineAxis`. */
  latestByDishes(
    dish_ids: readonly string[],
  ): Promise<Map<string, AuditEntry>>;
  /** Fetch one entry by run_id, or null if missing. */
  get(run_id: string): Promise<AuditEntry | null>;
  /** Delete entries older than the cutoff (epoch ms). Returns count deleted.
   *  Reserve-class entries are skipped. */
  clearOlderThan(cutoff_ms: number): Promise<number>;
  /** Delete all entries for a given recipe_id. Used when the user
   *  uninstalls a recipe and wants to purge its audit trail. Reserve
   *  entries are deleted too — this is explicit user intent. */
  clearByRecipe(recipe_id: string): Promise<number>;
  /** Export the entire log as a JSON-serializable array. Callers should
   *  stream this to a download; for very large logs, prefer paginated
   *  listRecent calls to avoid loading everything into memory. */
  exportAll(): Promise<AuditEntry[]>;
  /** Total number of entries in the log. */
  size(): Promise<number>;
  /** Delete all entries. Use only for explicit user action (reset). */
  clearAll(): Promise<void>;
  /** Append an activity event (non-execution). Auto-classifies reserve
   *  based on `entry.action` when the action is in `RESERVE_ACTIONS`.
   *  `options.reserve` overrides the entry-level `reserve` field. */
  logActivity(entry: ActivityEntry, options?: AppendOptions): Promise<void>;
  /** List recent activity entries, newest first. */
  listActivities(limit?: number): Promise<ActivityEntry[]>;
  /** Export all activities. */
  exportActivities(): Promise<ActivityEntry[]>;
  /** Delete the oldest non-reserve activity entries (Phase B retention
   *  pruner, size-based pass). Reserve rows are never returned. */
  clearOldestActivities(limit: number): Promise<number>;
  /** Delete the oldest non-reserve audit entries (Phase B retention
   *  pruner, size-based pass). Reserve rows are never returned. */
  clearOldestEntries(limit: number): Promise<number>;
  /** Count reserve-class entries + activities. Used by the pruner to
   *  enforce the reserve floor (never drop non-reserve below the
   *  remaining reserve count). */
  countReserveEntries(): Promise<number>;
  countReserveActivities(): Promise<number>;
  /** D-169 P0 Slice 4 § A.8 — thin read over `bridge_dispatch_succeeded`
   *  activity rows. Returns the `timestamp` of the most recent matching
   *  row, or null when no match. Used by the multi-bridge dispatcher's
   *  iteration-order to rank bridges by recency-of-success for the
   *  same `(bridge_client_token_id, target_pattern)` tuple. No
   *  separate per-pair success-history table — the activity log is
   *  the single source of truth (spec § A.8 / DL-7). */
  lastSuccessfulBridgeDispatch(
    bridge_client_token_id: string,
    target_pattern: string,
  ): Promise<number | null>;
}

/** Build an AuditLogStore on top of backing Collections.
 *  `backing` stores execution entries keyed by run_id.
 *  `activityBacking` stores activity entries keyed by activity_id.
 *  If `activityBacking` is omitted, activities go to an in-memory store. */
/** Default maximum audit entries before auto-trim kicks in. Callers
 *  can override via the `maxEntries` option. At 5-minute scheduled
 *  execution, 10000 entries ≈ 35 days of history. */
export const DEFAULT_MAX_AUDIT_ENTRIES = 10_000;

/** Phase B options for the audit store. `onBytesChanged` feeds signed
 *  deltas into the `audit` surface gate so retention + pressure
 *  stay accurate. */
export interface CreateAuditLogStoreOptions {
  maxEntries?: number;
  onBytesChanged?: (delta: number) => void;
}

export const createAuditLogStore = (
  backing: Collection<AuditEntry>,
  activityBacking?: Collection<ActivityEntry>,
  options: CreateAuditLogStoreOptions = {},
): AuditLogStore => {
  // Fallback in-memory activity store if no IDB collection provided
  const activities = activityBacking ?? createInMemoryActivityStore();
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_AUDIT_ENTRIES;
  const onBytesChanged = options.onBytesChanged;
  const reportDelta = (delta: number): void => {
    if (!onBytesChanged || delta === 0) return;
    try { onBytesChanged(delta); } catch (_err) { /* never break writes */ }
  };
  const entrySize = (entry: AuditEntry | ActivityEntry): number =>
    JSON.stringify(entry).length;
  const sortByStartedAtDesc = (a: AuditEntry, b: AuditEntry): number =>
    b.started_at - a.started_at;
  // D-153 P1 follow-on (Codex adversarial-review finding #4) —
  // event-axis ordering for the tier-scope listBy* methods. Sort key
  // is COALESCE(event_at, started_at) so backfilled rows whose
  // `event_at` predates ingestion still surface in real-world
  // chronology. The sort runs over the full scope-matched set, so a
  // recent backfill batch can't drown out older-ingestion live rows
  // with newer event time — no window-truncation, no over-fetch
  // required at the rpc layer.
  const eventAxisTs = (e: AuditEntry): number => e.event_at ?? e.started_at;
  const sortByEventAxisDesc = (a: AuditEntry, b: AuditEntry): number =>
    eventAxisTs(b) - eventAxisTs(a);
  const sortForAxis = (axis: TimelineAxis | undefined) =>
    axis === 'event' ? sortByEventAxisDesc : sortByStartedAtDesc;

  /** Auto-trim: if the log exceeds maxEntries, remove the oldest non-
   *  reserve excess. Reserve rows never count toward the trim budget —
   *  the Phase B retention pruner is the only thing that evaluates them
   *  (and even there, reserve rows are skipped). */
  const autoTrim = async (): Promise<void> => {
    const all = await backing.list();
    if (all.length <= maxEntries) return;
    const trimmable = all.filter((e) => e.reserve !== true).sort(sortByStartedAtDesc);
    const excess = trimmable.slice(maxEntries);
    let freed = 0;
    for (const entry of excess) {
      freed += entrySize(entry);
      await backing.delete(entry.run_id);
    }
    if (freed > 0) reportDelta(-freed);
  };

  return {
    async append(entry, options) {
      if (!entry.run_id) throw new Error('AuditEntry.run_id is required');
      // Explicit options.reserve wins over entry.reserve so callers can
      // override the entry-level default (incl. forcing reserve=false).
      const reserve =
        options && hasOwn(options, 'reserve') ? options.reserve : entry.reserve;
      const stored: AuditEntry =
        reserve === undefined ? entry : { ...entry, reserve };
      const prev = await backing.get(entry.run_id);
      const prevBytes = prev ? entrySize(prev) : 0;
      await backing.set(entry.run_id, stored);
      reportDelta(entrySize(stored) - prevBytes);
      // Non-blocking auto-trim — don't block the recipe run on cleanup
      autoTrim().catch(() => {});
    },

    async listRecent(limit, opts) {
      if (limit <= 0) return [];
      const all = await backing.list();
      // D-161 P3 — narrow to the requested actor lane(s) BEFORE the slice
      // so the page is `limit` matching rows. No filter (undefined / empty)
      // keeps `matched === all`, so the sort + slice are byte-identical to
      // pre-P3 (I-9). `execution_source?.actor` undefined → treated as
      // `'system'` inside the predicate (P1 column-default semantics).
      const filter = opts?.origin_actors;
      const matched =
        filter !== undefined && filter.length > 0
          ? all.filter((e) =>
              originActorPassesTimelineFilter(e.execution_source?.actor, filter),
            )
          : all;
      matched.sort(sortByStartedAtDesc);
      return matched.slice(0, limit);
    },

    async listByRecipe(recipe_id, limit) {
      const all = await backing.list();
      const filtered = all
        .filter((e) => e.recipe_id === recipe_id)
        .sort(sortByStartedAtDesc);
      return limit !== undefined && limit >= 0
        ? filtered.slice(0, limit)
        : filtered;
    },

    async listByChannelSession(channel_session_id, limit, axis) {
      if (channel_session_id === '') return [];
      const all = await backing.list();
      const filtered = all
        .filter((e) => e.channel_session_id === channel_session_id)
        .sort(sortForAxis(axis));
      return limit !== undefined && limit >= 0
        ? filtered.slice(0, limit)
        : filtered;
    },

    async listByCognitionSession(cognition_session_id, limit, axis) {
      if (cognition_session_id === '') return [];
      const all = await backing.list();
      const filtered = all
        .filter((e) => e.cognition_session_id === cognition_session_id)
        .sort(sortForAxis(axis));
      return limit !== undefined && limit >= 0
        ? filtered.slice(0, limit)
        : filtered;
    },

    async listByCorrelation(correlation_id, limit, axis) {
      if (correlation_id === '') return [];
      const all = await backing.list();
      const filtered = all
        .filter((e) => e.correlation_id === correlation_id)
        .sort(sortForAxis(axis));
      return limit !== undefined && limit >= 0
        ? filtered.slice(0, limit)
        : filtered;
    },

    // D-215 slice 2 — app-side filter, matching every sibling above.
    // ⚠ A `json_extract(data,'$.dish_id')` INDEX was specced and then
    // DROPPED: `Collection` exposes no predicate query (get/set/list/
    // listByPrefix only), so every `listBy*` here scans `backing.list()`
    // in JS and an index would have had no reader. The only raw-SQL
    // consumer of `audit_entries` is the retention pruner. The house
    // posture is already stated at `reception-inbox-handler.ts:952` —
    // "the audit store has no 'list by commit_status' query, so this is
    // an app-side filter … (a thin index is a future optimization)".
    async listByDish(dish_id, limit, axis) {
      if (dish_id === '') return [];
      const all = await backing.list();
      const filtered = all
        .filter((e) => e.dish_id === dish_id)
        .sort(sortForAxis(axis));
      return limit !== undefined && limit >= 0
        ? filtered.slice(0, limit)
        : filtered;
    },

    async latestByDishes(dish_ids) {
      const wanted = new Set(dish_ids.filter((id) => id !== ''));
      const latest = new Map<string, AuditEntry>();
      if (wanted.size === 0) return latest;
      // ONE scan, keep the newest per dish — the whole reason this is not
      // `dish_ids.map(listByDish)`.
      for (const entry of await backing.list()) {
        const id = entry.dish_id;
        if (id === undefined || !wanted.has(id)) continue;
        const held = latest.get(id);
        if (held === undefined || entry.started_at > held.started_at) {
          latest.set(id, entry);
        }
      }
      return latest;
    },

    async get(run_id) {
      return backing.get(run_id);
    },

    async clearOlderThan(cutoff_ms) {
      const all = await backing.list();
      let deleted = 0;
      let freed = 0;
      for (const entry of all) {
        if (entry.started_at < cutoff_ms && entry.reserve !== true) {
          freed += entrySize(entry);
          await backing.delete(entry.run_id);
          deleted++;
        }
      }
      if (freed > 0) reportDelta(-freed);
      return deleted;
    },

    async clearByRecipe(recipe_id) {
      const all = await backing.list();
      let deleted = 0;
      let freed = 0;
      for (const entry of all) {
        if (entry.recipe_id === recipe_id) {
          freed += entrySize(entry);
          await backing.delete(entry.run_id);
          deleted++;
        }
      }
      if (freed > 0) reportDelta(-freed);
      return deleted;
    },

    async exportAll() {
      const all = await backing.list();
      all.sort(sortByStartedAtDesc);
      return all;
    },

    async size() {
      return backing.size();
    },

    async clearAll() {
      let freed = 0;
      if (onBytesChanged) {
        for (const e of await backing.list()) freed += entrySize(e);
        for (const a of await activities.list()) freed += entrySize(a);
      }
      await backing.clear();
      await activities.clear();
      if (freed > 0) reportDelta(-freed);
    },

    async logActivity(entry, options) {
      if (!entry.activity_id) {
        entry.activity_id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      }
      // Resolution order (explicit wins over auto-classification):
      //   1. options.reserve   — caller's explicit override (incl. false)
      //   2. entry.reserve     — caller set the field on the entry directly
      //   3. isReserveAction   — auto-classify based on action code
      let reserve: boolean | undefined;
      if (options && hasOwn(options, 'reserve')) {
        reserve = options.reserve;
      } else if (entry.reserve !== undefined) {
        reserve = entry.reserve;
      } else if (isReserveAction(entry.action)) {
        reserve = true;
      }
      const stored: ActivityEntry =
        reserve === undefined ? entry : { ...entry, reserve };
      const prev = await activities.get(entry.activity_id);
      const prevBytes = prev ? entrySize(prev) : 0;
      await activities.set(entry.activity_id, stored);
      reportDelta(entrySize(stored) - prevBytes);
    },

    async listActivities(limit) {
      const all = await activities.list();
      all.sort((a, b) => b.timestamp - a.timestamp);
      return limit ? all.slice(0, limit) : all;
    },

    async exportActivities() {
      const all = await activities.list();
      all.sort((a, b) => b.timestamp - a.timestamp);
      return all;
    },

    async clearOldestActivities(limit) {
      if (limit <= 0) return 0;
      const all = await activities.list();
      const nonReserve = all
        .filter((e) => e.reserve !== true)
        .sort((a, b) => a.timestamp - b.timestamp);
      const victims = nonReserve.slice(0, limit);
      let freed = 0;
      for (const v of victims) {
        freed += entrySize(v);
        await activities.delete(v.activity_id);
      }
      if (freed > 0) reportDelta(-freed);
      return victims.length;
    },

    async clearOldestEntries(limit) {
      if (limit <= 0) return 0;
      const all = await backing.list();
      const nonReserve = all
        .filter((e) => e.reserve !== true)
        .sort((a, b) => a.started_at - b.started_at);
      const victims = nonReserve.slice(0, limit);
      let freed = 0;
      for (const v of victims) {
        freed += entrySize(v);
        await backing.delete(v.run_id);
      }
      if (freed > 0) reportDelta(-freed);
      return victims.length;
    },

    async countReserveEntries() {
      const all = await backing.list();
      return all.filter((e) => e.reserve === true).length;
    },

    async countReserveActivities() {
      const all = await activities.list();
      return all.filter((e) => e.reserve === true).length;
    },

    async lastSuccessfulBridgeDispatch(bridge_client_token_id, target_pattern) {
      // D-169 P0 Slice 4 § A.8 — exact-match scan over
      // `bridge_dispatch_succeeded` activity rows. Activities are
      // already pruned by the retention sweep + the gate ceiling;
      // we read the (possibly windowed) snapshot and return the
      // newest matching timestamp. Empty / mismatched inputs return
      // null without scanning further than the action filter.
      if (!bridge_client_token_id || !target_pattern) return null;
      const all = await activities.list();
      let newest: number | null = null;
      for (const a of all) {
        if (a.action !== 'bridge_dispatch_succeeded') continue;
        if (a.target !== bridge_client_token_id) continue;
        if (a.detail !== target_pattern) continue;
        if (newest === null || a.timestamp > newest) {
          newest = a.timestamp;
        }
      }
      return newest;
    },
  };
};

/** Simple in-memory activity store fallback. */
const createInMemoryActivityStore = (): Collection<ActivityEntry> => {
  const map = new Map<string, ActivityEntry>();
  return {
    async get(key) { return map.get(key) ?? null; },
    async set(key, value) { map.set(key, value); },
    async delete(key) { map.delete(key); },
    async has(key) { return map.has(key); },
    async list() { return [...map.values()]; },
    async listKeys() { return [...map.keys()]; },
    async listByPrefix(prefix) {
      const r: Array<{ key: string; value: ActivityEntry }> = [];
      for (const [k, v] of map) { if (k.startsWith(prefix)) r.push({ key: k, value: v }); }
      return r;
    },
    async deleteByPrefix(prefix) {
      let c = 0; for (const k of map.keys()) { if (k.startsWith(prefix)) { map.delete(k); c++; } }
      return c;
    },
    async clear() { map.clear(); },
    async size() { return map.size; },
  };
};

/** Generate a stable, collision-resistant run_id. Format:
 *  `YYYYMMDDTHHMMSSmmm-<6-char random>` — timestamp is ISO-like without
 *  delimiters, suffix protects against intra-millisecond collisions. */
export const newRunId = (now: number = Date.now()): string => {
  const d = new Date(now);
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  const ts =
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    'T' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    pad(d.getUTCMilliseconds(), 3);
  // 6-char base36 random suffix — ~2B possibilities, plenty for
  // intra-millisecond dedup
  const rand = Math.floor(Math.random() * 36 ** 6).toString(36).padStart(6, '0');
  return `${ts}-${rand}`;
};

/** Structural input for `buildAuditEntry`. The run-level fields of
 *  `@recued/engine`'s `ExecutionResult` plus extra context the engine
 *  doesn't know about (config snapshot, trigger url). Per-step detail
 *  is not accepted — D-145 slice 3b.4 retired `AuditEntry.steps[]`;
 *  per-call detail is the D-153 commit log's concern. */
export interface AuditEntryInput {
  recipe_id: string;
  recipe_hash: string;
  /** Run-anchor lifecycle state — a `RunAnchorStatus` (D-157 P1 widened
   *  it from `CommitStatus`). The engine maps the legacy
   *  `ExecutionResult.success: boolean` to one of the terminal values
   *  (`'succeeded'` / `'failed'`) at the boundary; the non-terminal +
   *  cancelled / in_doubt values come from the Gateway-driven dispatch
   *  outbox, and `'awaiting_approval'` from the D-157 preflight gate
   *  (both later substrate). */
  commit_status: RunAnchorStatus;
  duration_ms: number;
  errors: RecipeError[];
  /** Post-execution observability degradation carried onto the durable
   *  audit row when the row itself was written. */
  degraded?: RunDegradation[];
  /** Snapshot of user-visible variables active at the time of the run. */
  config_snapshot?: Record<string, unknown>;
  /** Caller-supplied context of a PAUSED run — see `AuditEntry.context_snapshot`. */
  context_snapshot?: Record<string, unknown>;
  /** Page URL the recipe ran against, for context recipes. Null for
   *  scheduled or manual runs. */
  trigger_url?: string | null;
  /** How the execution was triggered. */
  trigger_source?: string | null;
  /** Which instance executed this. */
  instance_id?: string | null;
  /** Optional — auto-generated if omitted. */
  run_id?: string;
  /** Optional — for testability. Defaults to Date.now(). Represents the
   *  run's finish time; started_at is computed as now - duration_ms. */
  now?: number;
  /** Declared budget for the run, from `recipe.metadata.budget_ms`.
   *  Persist for post-launch tuning — cross-reference against
   *  `duration_ms`. Absent when the recipe didn't declare one. */
  budget_ms?: number;
  /** Smart Backfill metadata — Phase 5. Set by the scheduler when
   *  this execution is a catch-up fire. */
  backfill?: {
    missed_cycles: number | 'unknown';
    last_run_at_before: number;
  };
  /** D-115 — reactive recipe `process_id`. Copied verbatim to the
   *  persisted audit entry; the rollup UI groups rows by this field. */
  process_id?: string;
  /** D-179 P1 — dish attribution; copied verbatim. */
  dish_id?: string;
  /** D-120 Phase 3 — surrogate FK pointer into `recipe_insights`.
   *  Set by `handleExecute` when a DB-backed runtime resolves
   *  `recipe_insights.id` pre-execution; absent on ext-routed runs
   *  (extension audit storage is hash-keyed IDB and doesn't carry
   *  the surrogate). */
  recipe_insight_id?: number;
  /** D-120 Phase 7 — short post-run outcome summary (≤
   *  AUDIT_OUTPUT_STRING_MAX chars). Phase 3 plumbs the input field
   *  through `buildAuditEntry`; the runtime capture site lands in
   *  Phase 7. */
  output_string?: string;
  /** D-120 Phase 7.5 — bistemporal stamping. Caller derives via
   *  `deriveRunMode(recipe.run_mode, request.trigger_source)` and
   *  passes the result here so the audit row carries the run's mode.
   *  Defaults to undefined so legacy callers stay valid; the SQL
   *  json_extract index treats missing as `'live'` for consistency
   *  with new writes. */
  run_mode?: RunMode;
  /** D-120 Phase 7.5 — when the underlying real-world event predates
   *  the run (backfill recipe processing a 3-year-old email), pass
   *  the event's date here so `data.timeline()` event-axis ordering
   *  surfaces it on the right historical date. Null = no underlying
   *  event date; queries fall back to ingestion time via
   *  `COALESCE(event_at, ts)`. */
  event_at?: number;
  // D-153 P1 — Commit substrate input fields. All optional; the
  // engine wires them when present, otherwise the resulting
  // `AuditEntry` carries undefined for the same key. See AuditEntry
  // for the per-field doc.
  commit_kind?: CommitKind;
  execution_source?: ExecutionSource;
  channel_session_id?: string;
  cognition_session_id?: string;
  correlation_id?: string;
  idempotency_key?: string;
  predecessor_commit_id?: string;
  contract_snapshot?: ContractSnapshot;
  // D-157 P1 slice 4 — preflight pause inputs. The host passes these
  // when writing an `awaiting_approval` anchor; the build helper
  // passes them through verbatim. See `AuditEntry` for per-field doc.
  checkpoint_id?: string;
  ask_id?: string;
  /** D-181 §12 — long-op display category for a failed / killed run. The
   *  host derives it via `deriveHeavyOpErrorCategory` and passes it here;
   *  the build helper passes it through. See `AuditEntry` for per-field doc. */
  error_category?: HeavyOpErrorCategory;
}

/** Convert an `ExecutionResult`-derived input into an `AuditEntry` —
 *  the run-level execution-request envelope. Per-step detail is not
 *  carried (D-145 slice 3b.4 retired `steps[]`); the engine's D-153
 *  commit log is the per-call record.
 *
 *  Typical engine caller:
 *  ```
 *  await auditLog.append(buildAuditEntry({
 *    recipe_id, recipe_hash, commit_status, duration_ms, errors,
 *    config_snapshot, trigger_url,
 *  }));
 *  ```
 */
export const buildAuditEntry = (input: AuditEntryInput): AuditEntry => {
  const finished_at = input.now ?? Date.now();
  const started_at = finished_at - input.duration_ms;
  const run_id = input.run_id ?? newRunId(finished_at);

  return {
    run_id,
    recipe_id: input.recipe_id,
    recipe_hash: input.recipe_hash,
    started_at,
    finished_at,
    duration_ms: input.duration_ms,
    commit_status: input.commit_status,
    config_snapshot: { ...(input.config_snapshot ?? {}) },
    ...(input.context_snapshot !== undefined
      && Object.keys(input.context_snapshot).length > 0
      ? { context_snapshot: { ...input.context_snapshot } }
      : {}),
    errors: input.errors,
    ...(input.degraded && input.degraded.length > 0 ? { degraded: [...input.degraded] } : {}),
    trigger_url: input.trigger_url ?? null,
    trigger_source: input.trigger_source ?? null,
    instance_id: input.instance_id ?? null,
    ...(input.budget_ms != null ? { budget_ms: input.budget_ms } : {}),
    ...(input.backfill ? { backfill: input.backfill } : {}),
    ...(input.process_id ? { process_id: input.process_id } : {}),
    ...(input.dish_id ? { dish_id: input.dish_id } : {}),
    ...(input.recipe_insight_id != null ? { recipe_insight_id: input.recipe_insight_id } : {}),
    ...(input.output_string != null ? { output_string: input.output_string } : {}),
    // D-120 Phase 7.5 — bistemporal stamps. Both nullable; pass-through.
    ...(input.run_mode != null ? { run_mode: input.run_mode } : {}),
    ...(input.event_at != null ? { event_at: input.event_at } : {}),
    // D-153 P1 — Commit substrate fields. Pass-through; engine fills
    // when wired (D-145), undefined otherwise.
    ...(input.commit_kind != null ? { commit_kind: input.commit_kind } : {}),
    ...(input.execution_source != null ? { execution_source: input.execution_source } : {}),
    ...(input.channel_session_id != null ? { channel_session_id: input.channel_session_id } : {}),
    ...(input.cognition_session_id != null ? { cognition_session_id: input.cognition_session_id } : {}),
    ...(input.correlation_id != null ? { correlation_id: input.correlation_id } : {}),
    ...(input.idempotency_key != null ? { idempotency_key: input.idempotency_key } : {}),
    ...(input.predecessor_commit_id != null ? { predecessor_commit_id: input.predecessor_commit_id } : {}),
    ...(input.contract_snapshot != null ? { contract_snapshot: input.contract_snapshot } : {}),
    // D-157 P1 slice 4 — preflight pause anchor pointers. Both set
    // together when `commit_status === 'awaiting_approval'`.
    ...(input.checkpoint_id != null ? { checkpoint_id: input.checkpoint_id } : {}),
    ...(input.ask_id != null ? { ask_id: input.ask_id } : {}),
    // D-181 §12 — long-op display category (failed / killed runs only).
    ...(input.error_category != null ? { error_category: input.error_category } : {}),
  };
};
