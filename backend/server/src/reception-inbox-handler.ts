/** D-173 P2 / P3-rpc — Reception Inbox handler (the working
 *  review-then-approve inbox over held `approval_required` operations).
 *
 *  The inbox is a VIEW over the D-157 gate's held operations (no new
 *  storage table per N.1): a held run carries an `'awaiting_approval'`
 *  run anchor + a persisted `Checkpoint`. `reception.inbox.list`
 *  enumerates those holds, FILTERS to incoming-trigger origin (the inbox
 *  shows ONLY reception-incoming-triggered holds, never arbitrary gated
 *  ops), joins the source record, and projects each to an `InboxItem`,
 *  filling `arg_schema` via the injected `resolveArgEditSchema` (the
 *  shared seam Lane P implements).
 *
 *  `reception.inbox.approve` is the editable-args gate driver (N.5): it
 *  validates the user's `edits` against the item's `ArgEditSchema`
 *  allowlist, writes them to `checkpoint.arg_overrides` THROUGH THE
 *  NARROW `CheckpointStore.setArgOverrides` WRITER (the N.5 security
 *  boundary — the ONLY write path for `arg_overrides`), recomputes
 *  `approved_target` from the merged args, audits the old→new diff via
 *  the exported `computeArgEditsDiff`, and releases the held op through
 *  the EXISTING preflight resume path (answers the `gateway.preflight`
 *  ask with `'approve'` — the engine then merges the overrides on
 *  resume; this module does NOT touch the engine or `preflight-resumer`).
 *
 *  `reception.inbox.reject` answers the same ask with `'deny'` (the
 *  existing deny path frees the hold), records a subview row (D10), and
 *  frees any slot hold.
 *
 *  Boot-wiring is DEFERRED to a consolidator integration step — this
 *  module exposes the deps shape + the handler functions + a slice
 *  factory ready to wire; it does NOT touch `wire-reception-substrate.ts`.
 *  The `resolveArgEditSchema` resolver is injected (Lane P's impl
 *  connects at the integration step; tests inject a stub).
 *
 *  Spec: D-173 § N.1 / N.2 / N.5 / N.6 / D10 + A.3 / A.6. */

import {
  RpcError,
  executionSourceContractId,
  type ArgEditField,
  type ArgEditSchema,
  type Checkpoint,
  type ExecutionSource,
  type InboxItem,
  type PreflightApprovedTarget,
  type ReceptionInboxApproveInput,
  type ReceptionInboxApproveResult,
  type ReceptionInboxListInput,
  type ReceptionInboxListResult,
  type ReceptionInboxRejectInput,
  type ReceptionInboxRejectResult,
  type ReceptionInboxRpcErrorCode,
  type ReceptionInboxScanStatus,
  type ReceptionInboxSourceKind,
  type ReceptionInboxStatus,
  type ReceptionInboxView,
  isReceptionInboxTopTierKind,
  type ReceptionInboxTopTierKind,
} from '@recued/contracts';
import type { ActivityAction, AuditEntry, AuditLogStore } from '@recued/storage';
import type { CheckpointStore } from '@recued/storage';
import { computeArgEditsDiff } from './preflight-resumer.js';
import {
  COMMITMENT_EVIDENCE_CAPTURE_EVENT_KIND,
  COMMITMENT_EVIDENCE_PROPOSAL_RECIPE_ID,
} from './commitment-evidence-capture.js';

// ────────────────────────────────────────────────────────────────
// The held-op summary the query recovers from one awaiting hold
// ────────────────────────────────────────────────────────────────

/** What the query recovers about one reception-incoming held op before
 *  it is projected to an `InboxItem`. The handler needs more than the
 *  `InboxItem` itself carries — the run anchor's `ask_id` (to drive the
 *  release on approve/reject) + the `Checkpoint` (to write
 *  `arg_overrides` + recompute `approved_target`). */
export interface ReceptionInboxHeldOp {
  /** The held run's anchor (`'awaiting_approval'`). */
  anchor: AuditEntry;
  /** The persisted checkpoint for the hold (`anchor.run_id`). */
  checkpoint: Checkpoint;
  /** The projected inbox item. */
  item: InboxItem;
}

// ────────────────────────────────────────────────────────────────
// Injectable seams (the resolver + source/origin/subview seams)
// ────────────────────────────────────────────────────────────────

/** The SHARED SEAM (D-173 N.6) — resolve the editable-args allowlist for
 *  one held operation. Lane P implements the concrete resolver
 *  (`preflight-arg-schema-resolver.ts`); this module is built against the
 *  signature + a test stub, and the real impl connects at the deferred
 *  integration step. Must be deterministic + side-effect-free. */
export type ResolveArgEditSchema = (
  operation_id: string,
  prefilled_args: Record<string, unknown>,
  deps: ReceptionInboxResolverDeps,
) => ArgEditSchema;

/** Opaque dep bag threaded to `resolveArgEditSchema` — Lane P owns its
 *  shape. Kept as an open record so this lane does not couple to Lane
 *  P's internals; the integration step passes the real bag. */
export type ReceptionInboxResolverDeps = Record<string, unknown>;

/** The redacted preview + the editable args + source context recovered
 *  from a held op's source record (N.1 — the join). Sealed visitor PII
 *  MUST stay sealed here (I-3); the card shows only the redacted
 *  preview. Returns `null` when the source record is gone (the hold is
 *  then skipped — a stranded hold with no source record is not shown). */
export interface ResolvedInboxSource {
  top_tier_kind: ReceptionInboxTopTierKind;
  source: InboxItem['source'];
  /** The operation's prefilled args (concrete values). */
  args: Record<string, unknown>;
  preview: InboxItem['preview'];
  proposed_action: string;
  attachment?: InboxItem['attachment'];
}

/** Join one held op to its source record + redacted preview (N.1). The
 *  default derives everything from the held op's checkpoint `step_state`
 *  / gated-step args (the projection prefilled them) so the inbox works
 *  before the projection ops + their source stores land; the integration
 *  step injects a richer resolver that joins the real per-kind reception
 *  source store. */
export type ResolveInboxSource = (
  held: { anchor: AuditEntry; checkpoint: Checkpoint },
) => ResolvedInboxSource | null;

/** D-173 P5 (scan-gate part B) — wrap a source resolver so a drop attachment's
 *  `scan_status` reflects the LIVE `data.file.received` verdict (the ClamAV pack
 *  writes it via `core.storage.file.set-scan-status`) instead of the static
 *  `unscanned` the source resolver stamps as its floor (the pure default has no
 *  warehouse access). `readFileScanStatus` is built by the boot wiring over the
 *  collection registry. A null wrapper (no reader), a result without an
 *  attachment, or a `readFileScanStatus` that returns undefined (a vanished
 *  record) all pass the base result through untouched — so a missing / down
 *  scanner leaves `unscanned` and the advisory gate still warns, never blocking
 *  review. Pure; only `scan_status` is overwritten — never bytes / path / size. */
export const withLiveAttachmentScanStatus = (
  base: ResolveInboxSource,
  readFileScanStatus: ((file_id: string) => ReceptionInboxScanStatus | undefined) | undefined,
): ResolveInboxSource =>
  readFileScanStatus === undefined
    ? base
    : (held) => {
        const resolved = base(held);
        if (resolved?.attachment !== undefined) {
          const live = readFileScanStatus(resolved.attachment.file_id);
          if (live !== undefined) {
            return { ...resolved, attachment: { ...resolved.attachment, scan_status: live } };
          }
        }
        return resolved;
      };

/** Decide whether one `'awaiting_approval'` anchor is a reception-
 *  incoming-triggered hold (N.1 — the inbox shows ONLY those, never
 *  arbitrary gated ops). Injectable so the exact `reception-<kind>-
 *  incoming` trigger naming (a D-170 N.18 compile artifact, unbuilt in
 *  this round) can be pinned at the integration step; the default
 *  recovers the origin from the anchor's `execution_source` provenance. */
export type IsReceptionOriginAnchor = (anchor: AuditEntry) => boolean;

/** The subview store (D10) — reject / expire move an item here (status
 *  `dismissed` / `expired`), NOT delete; `auto_cleanup_days` purges
 *  subview rows + their sealed visitor PII after X days. Injected (the
 *  concrete per-pair SQLite store lands at the integration step) so this
 *  lane stays in-fence. */
export interface ReceptionInboxSubviewStore {
  /** Record a dismissed / expired item in the subview (D10). `top_tier_kind`
   *  is the held item's real materialize target (task / calendar.event /
   *  commitment / …) so the subview labels it the same as the open list. */
  record(row: {
    hold_id: string;
    status: 'dismissed' | 'expired';
    top_tier_kind: ReceptionInboxTopTierKind;
    reason?: string;
    source_record_ref: string;
    dismissed_at: number;
    /** D-177 N.14.8 fork 3 — the DOOR this item was held under
     *  (`anchor.execution_source.contract_id`). Absent for a non-door hold.
     *  NOT PII (I-3): a door contract id names the owner's own form, never the
     *  visitor. Exists so a reject is countable against the door the learner
     *  suggests for — without it a reject is durable but UNKEYED, which is
     *  exactly what §N.14.8's v1 recorded as the blocker. */
    door_contract_id?: string;
  }): void;
  /** D-177 N.14.8 fork 3 — how many items this door had REJECTED since
   *  `since_ms`, and when the last one was.
   *
   *  🔑 WINDOWED, and the window is the CALLER'S: the suggestion evidence
   *  counts approvals over `DELEGATION_SUGGEST_LOOKBACK_MS`, so a reject count
   *  over any other range would put two different time ranges in one sentence.
   *  ⚠ Counts only RETAINED rows — the D10 `auto_cleanup_days` purge drops old
   *  ones, so this can only ever UNDERSTATE. It is evidence for a human, never
   *  a gate, so understating is the safe direction.
   *  `'expired'` rows are NOT rejects — an expiry is nobody's decision. */
  countRejectsForDoor(
    door_contract_id: string,
    since_ms: number,
  ): { count: number; last_rejected_at?: number };
  /** List subview items, newest first (`limit` bound). */
  list(limit: number): ReadonlyArray<{
    hold_id: string;
    status: 'dismissed' | 'expired';
    top_tier_kind: ReceptionInboxTopTierKind;
    reason?: string;
    source_record_ref: string;
    dismissed_at: number;
    door_contract_id?: string;
  }>;
  /** D10 — purge subview rows older than `cutoff_ms` (+ their sealed
   *  PII). Returns the count purged. */
  purgeOlderThan(cutoff_ms: number): number;
}

/** D-173 D7 — count what is already on the owner's calendar at a held booking's
 *  proposed time. Injected; absent ⇒ the item carries no `calendar_overlap` and
 *  the surface renders nothing (never a bare 0 — see `InboxItem`).
 *
 *  This replaces `FreeSlotHold`, deleted 2026-07-16 along with the slot-hold
 *  model it served. The two are the same decision seen from opposite sides: the
 *  substrate USED to hold a slot and refuse the second booking (capacity 1,
 *  hard-coded — a one-table restaurant). It no longer does; concurrent bookings
 *  are legitimate and how many is too many is the owner's judgment. So there is
 *  no hold to free — and instead of refusing, the machine COUNTS and the owner
 *  decides at the gate. [[substrate_enforces_humans]]. */
export type CountCalendarOverlap = (
  window_start: number,
  window_end: number,
) => { count: number; calendars_read: number; unreadable: ReadonlyArray<string> };

/** A `reception_inbox` broadcast frame (D-121) — the bus assigns the
 *  cursor at emit time. Local to this lane (the global `ServerEvent`
 *  union's `reception_inbox` kind is folded in at the integration step,
 *  alongside the `ServerRpcRegistry` entries). */
export interface ReceptionInboxBroadcastEvent {
  kind: 'reception_inbox';
  op: 'approved' | 'rejected';
  hold_id: string;
}

/** Deps for the reception inbox handlers. Every external touch is a
 *  seam so the slice composes + tests fully before the deferred boot
 *  wiring. */
export interface ReceptionInboxDeps {
  /** Read the held runs (`'awaiting_approval'` anchors). */
  readonly auditLog: AuditLogStore;
  /** The checkpoint store — read holds + the NARROW `setArgOverrides`
   *  writer (the N.5 boundary). */
  readonly checkpointStore: CheckpointStore;
  /** SHARED SEAM (N.6) — resolve one held op's editable-args allowlist.
   *  Lane P's impl connects at the integration step. */
  readonly resolveArgEditSchema: ResolveArgEditSchema;
  /** Opaque dep bag threaded to `resolveArgEditSchema` (Lane P owns its
   *  shape). Defaults to `{}` when absent. */
  readonly resolverDeps?: ReceptionInboxResolverDeps;
  /** Join a held op to its source record + redacted preview (N.1). */
  readonly resolveSource: ResolveInboxSource;
  /** Owner-only reveal for a form_response hold. The source stays sealed for
   * every visitor/public surface; this admin RPC uses it only to prefill the
   * approve-time working-record editor. */
  readonly resolveFormResponseEdit?: (
    source: InboxItem['source'],
    args: Readonly<Record<string, unknown>>,
  ) => Promise<{
    values: Readonly<Record<string, unknown>>;
    visitor_email?: string;
  } | undefined>;
  /** The incoming-trigger-origin filter (N.1). */
  readonly isReceptionOrigin: IsReceptionOriginAnchor;
  /** Release a held op through the EXISTING preflight resume path —
   *  answers the `gateway.preflight` ask. `option_id` is `'approve'` /
   *  `'deny'`. Injected over `NotificationBlock.submitAnswer` (the same
   *  shape `history-handler.ts` wraps); absent in partially-composed boot
   *  so approve can fail closed instead of reporting a no-op release. */
  readonly submitAnswer?: (ask_id: string, option_id: string) => Promise<void>;
  /** D-210 Phase C — release a hold that carries NO durable ask, by
   *  driving the decorated `PreflightResumer` directly (see
   *  `reception-inbox-no-ask-release.ts`).
   *
   *  Reached only when the anchor has no `ask_id` — the two mechanisms
   *  are exclusive, never a fallback for a failed answer. In
   *  `inbox_fanout_mode: 'notify'` that is every held item; in
   *  `'approval'` it is only the raise-failed accident. Absent ⇒ an
   *  ask-less hold keeps the old `not_configured` refusal rather than
   *  silently reporting a release that did not happen. */
  readonly releaseWithoutAsk?: (
    checkpoint: Checkpoint,
    decision: { kind: 'approve'; approved_at: number } | { kind: 'deny' },
  ) => Promise<void>;
  /** D-177 N.14 — read the hold's ask and return its "allow for this
   *  form" offer bounds iff the ask is OPEN and actually carries the
   *  `allow_session` option (wired over `NotificationBlock.getAsk`).
   *  Feeds the `InboxItem.allow_offer` rendering hint AND the approve
   *  path's act-site re-verify — `submitAnswer` silently no-ops an
   *  un-offered option, so a blind `allow_session` submit would report
   *  released while the hold stayed open. Absent ⇒ no affordance and
   *  `allow: true` refuses (fail closed). */
  readonly readAskAllowOffer?: (
    ask_id: string,
  ) => Promise<{ ttl_ms: number; max_uses: number } | undefined>;
  /** The subview store (D10). */
  readonly subviewStore: ReceptionInboxSubviewStore;
  /** D-173 D7 — "confirmed at approval": count what else is on the owner's
   *  calendar at a booking's proposed time, so they can judge. Absent ⇒ no
   *  count is surfaced. */
  readonly countCalendarOverlap?: CountCalendarOverlap;
  /** Owner-side history enrichment for a scheduling source. The resolver owns
   *  PII opening and returns only an opaque-contact projection. */
  readonly lookupBookingHistory?: (
    source: InboxItem['source'],
    args: Readonly<Record<string, unknown>>,
  ) => Promise<InboxItem['booking_history']>;
  /** Emit the `reception_inbox` broadcast (D-121). */
  readonly broadcast: (event: ReceptionInboxBroadcastEvent) => void;
  /** Deterministic clock seam for tests. Production wires `Date.now`. */
  readonly now: () => number;
  /** How many awaiting-approval anchors to scan when enumerating holds.
   *  The audit store has no "list by `commit_status`" query, so the
   *  enumeration is an app-side filter over the most-recent `scanLimit`
   *  anchors (flagged in the report). Defaults to a generous ceiling. */
  readonly scanLimit?: number;
}

// ────────────────────────────────────────────────────────────────
// Constants + small helpers
// ────────────────────────────────────────────────────────────────

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
/** Fallback slot length when a held booking carries no resolvable
 *  `duration_minutes`. Mirrors the projection's own fallback
 *  (`reception-projection.ts` `DEFAULT_EVENT_DURATION_MS`) so the window the
 *  owner is shown is the window the event will actually occupy. */
const DEFAULT_SLOT_DURATION_MS = 30 * 60_000;

/** The `[start, end)` the held item proposes to occupy, or null when it is not
 *  time-framed (every non-booking kind) or carries no usable start.
 *
 *  Reads the PREFILLED args — the slot as it stands right now. An owner editing
 *  the start in the inbox form is not reflected until the list is re-read; the
 *  count describes what is on offer, not an in-flight edit. */
const proposedSlotWindow = (
  top_tier_kind: ReceptionInboxTopTierKind,
  args: Record<string, unknown>,
): { start: number; end: number } | null => {
  if (top_tier_kind !== 'calendar.event') return null;
  const start = args.start_at;
  if (typeof start !== 'number' || !Number.isFinite(start)) return null;
  const minutes = args.duration_minutes;
  const durationMs =
    typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0
      ? minutes * 60_000
      : DEFAULT_SLOT_DURATION_MS;
  return { start, end: start + durationMs };
};
/** Default depth of the awaiting-anchor scan (the app-side held-op
 *  enumeration). Generous — a real inbox rarely holds more than a
 *  handful at once, but the scan must reach past interleaved terminal
 *  runs to find them. */
const DEFAULT_SCAN_LIMIT = 1000;

const PROTO_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** The `gateway.preflight` ask option ids (mirrors
 *  `PREFLIGHT_ASK_OPTIONS` in `@recued/gateway`). The release path
 *  answers the held op's ask with one of these. */
const ASK_APPROVE = 'approve';
/** D-177 N.14 — the "allow for this form" answer (the `allow_session`
 *  option the door seed put on the ask; the existing answer path threads
 *  it into the door-bound session-grant mint on resume). */
const ASK_ALLOW_SESSION = 'allow_session';
const ASK_DENY = 'deny';

/** Audit action codes (D-120). Not in the closed `ActivityAction` union,
 *  so cast at the boundary — the established pattern for diagnostic action
 *  codes fed through `logActivity` (`RESERVE_ACTIONS` is a `Set<string>`;
 *  cf. `wire-housekeeping-substrate.ts`). Both are reserve-class (the
 *  approve/reject of a held visitor request is a forensic event). */
const ACTION_APPROVED = 'reception.inbox.approved' as ActivityAction;
const ACTION_REJECTED = 'reception.inbox.rejected' as ActivityAction;

const rpcError = (
  code: ReceptionInboxRpcErrorCode,
  message: string,
  status: number,
): RpcError => new RpcError(code, message, status);

/** Admin-only gate — mirrors `requireCallerInstance` in
 *  `reception-rpc-handler.ts`. `reception.inbox.*` exposes held visitor
 *  requests + drives boundary-crossing materialize ops; an unpaired /
 *  MCP-channel caller must never reach it. */
const requireAdmin = (
  caller: { instance_id: string | null | undefined } | undefined,
  method: string,
): string => {
  if (!caller?.instance_id) {
    throw rpcError(
      'permission_denied',
      `${method}: requires a paired admin client (D-121); dispatched from an unregistered connection`,
      403,
    );
  }
  return caller.instance_id;
};

/** D-210 A.8 3d-2c — who is approving.
 *
 *  TWO authorities reach `reception.inbox.approve`, and they are NOT the
 *  same one wearing different clothes:
 *
 *    - `paired_admin` — the rpc path. A D-121 paired client with an
 *      `instance_id`; `requireAdmin` is the gate.
 *    - `ask_landing`  — the D-210 3d-2c `/ask` page. Possession of the
 *      ask's unguessable 122-bit id is the capability, and there is NO
 *      instance. Owner-ruled (2026-07-19): the link is the owner's private
 *      link over public transport, and possession already carried the
 *      approve — the edit rides the same possession.
 *
 *  ⛔ The landing path must NEVER be expressed by synthesising an
 *  `instance_id`. That satisfies the predicate by writing a paired admin
 *  client into the record that was never there — provenance that lies is
 *  worse than provenance that is absent. It gets its own arm, and
 *  `describeApprover` puts it in the audit detail. */
export type ReceptionInboxCaller =
  | { instance_id: string | null | undefined }
  | { ask_landing: { ask_id: string } };

export type ReceptionInboxApprover =
  | { kind: 'paired_admin'; instance_id: string }
  | { kind: 'ask_landing'; ask_id: string };

const resolveApprover = (
  caller: ReceptionInboxCaller | undefined,
  method: string,
): ReceptionInboxApprover => {
  if (caller !== undefined && 'ask_landing' in caller) {
    const ask_id = caller.ask_landing?.ask_id;
    if (typeof ask_id !== 'string' || ask_id.length === 0) {
      throw rpcError(
        'permission_denied',
        `${method}: ask-landing approval requires the ask capability it was raised for`,
        403,
      );
    }
    return { kind: 'ask_landing', ask_id };
  }
  return { kind: 'paired_admin', instance_id: requireAdmin(caller, method) };
};

/** How the approver reads in the durable audit row.
 *
 *  🔴 Until 3d-2c the approve audit recorded WHAT changed and never WHO:
 *  `auditApprovedWithEdits` took an `actor_instance_id` and never used it,
 *  and `ActivityEntry` has no actor field — so the parameter was accepted
 *  and dropped. With two authorities now able to approve, "which one" is a
 *  fact the record has to carry, and `detail` is the slot that exists.
 *  ⇒ the declared actor is now a backed one. */
/** ⛔ D-210 audit finding 16 — the `ask_id` IS the bearer credential, so it must
 *  not be written verbatim into a durable, reserve-class audit row that outlives
 *  the ask and travels with `server.archive.export`.
 *
 *  This is the same rule the SIBLING public door already states for itself
 *  (`ports/reception/handler.ts`: "redact the path explicitly, else the live
 *  single-use link would sit in the access log in plaintext") — the ask door
 *  simply inverted it. It is also the same class as finding 3b, where a sealed
 *  recipient reached the `mail_send` audit detail.
 *
 *  A short prefix is kept deliberately: the row must still DISTINGUISH two
 *  approvals from different asks (that is the whole point of 3d-2c's "an audit
 *  that finally says who"), and a 122-bit id is not recoverable from 8 hex
 *  characters. Attribution survives; the capability does not. */
const ASK_CAPABILITY_AUDIT_PREFIX_LEN = 8;
const describeApprover = (approver: ReceptionInboxApprover): string =>
  approver.kind === 'ask_landing'
    ? `ask-landing capability ${approver.ask_id.slice(0, ASK_CAPABILITY_AUDIT_PREFIX_LEN)}… (redacted)`
    : `paired admin ${approver.instance_id}`;

// ────────────────────────────────────────────────────────────────
// Default origin filter (N.1) — recover reception-incoming provenance
// from the anchor's execution_source
// ────────────────────────────────────────────────────────────────

/** `true` when a string looks like a reception-incoming provenance
 *  token — a `recued-core/reception-*` recipe id or a `reception`-
 *  prefixed reactive `event_kind`. Substring-tolerant so the exact
 *  `reception-<kind>-incoming` naming (a D-170 N.18 compile artifact,
 *  unbuilt this round) does not have to be pinned here. */
const looksLikeReceptionToken = (s: string | null | undefined): boolean =>
  typeof s === 'string' && /reception[-_]/i.test(s);

/** D-192 F1 — the commitment-evidence capture producer's provenance
 *  tokens, matched EXACTLY (codex MEDIUM: a substring match would let
 *  any user-authored recipe whose id merely CONTAINS
 *  "commitment-evidence" surface its arbitrary gated ops in the inbox;
 *  the producer's identity is a kernel constant, so exact equality is
 *  free). Its held proposals are review-then-approve items by design
 *  (spec § Commitment evidence (F1) step 4: "the proposal surfaces in
 *  the D-173 inbox") — a DELIBERATE widening of the inbox's scope to a
 *  second review-by-default family, never a leak of arbitrary gated
 *  ops. */
const isCommitmentEvidenceToken = (s: string | null | undefined): boolean =>
  s === COMMITMENT_EVIDENCE_PROPOSAL_RECIPE_ID
  || s === COMMITMENT_EVIDENCE_CAPTURE_EVENT_KIND;

/** Default incoming-trigger-origin filter (N.1). Recovers the origin
 *  from the anchor's `execution_source`:
 *
 *  - a `reception` channel (a contracted / anonymous reception visitor
 *    that drove the gated op directly) — always reception-origin;
 *  - a `reactive` / `schedule` system trigger whose `source_recipe`
 *    (or reactive `event_kind`) names a `recued-core/reception-*`
 *    recipe — the `reception-<kind>-incoming` trigger that materializes
 *    a pending submission;
 *  - a `reactive` system trigger carrying the D-192 F1
 *    commitment-evidence capture token (the second review-by-default
 *    family — see `isCommitmentEvidenceToken`).
 *
 *  Everything else (a `user` / `chat` / `mcp` / `housekeeping` gated op,
 *  an unrelated reactive recipe) is NOT shown — the inbox never leaks
 *  arbitrary gated ops (N.1). The integration step may inject a stricter
 *  filter once the exact trigger ids exist. */
/** D-210 Phase C — the same test over a bare `ExecutionSource`.
 *
 *  Extracted so the raise sites can ask "is this a reception hold?" BEFORE
 *  the audit anchor exists, without deriving a second answer. The fanout
 *  branch and the inbox's own visibility filter have to agree exactly: a
 *  hold the raise site treats as reception (and so notifies about
 *  passively) but the inbox does not list is a hold the owner is told
 *  about and then cannot find. Two hand-written predicates would drift on
 *  the first new reception trigger.
 *
 *  ⛔ This predicate is also the SCOPE FENCE for `inbox_fanout_mode`
 *  (owner ruling, 2026-07-18). The setting silences the actionable card
 *  for reception-origin holds only — an MCP / chat / agent write keeps
 *  raising its approve-deny ask no matter how the reception page is
 *  configured. A Reception page setting must not quietly change the
 *  approval surface for the AI agent. */
export const isReceptionOriginSource = (
  src: ExecutionSource | undefined,
): boolean => {
  if (src === undefined) return false;
  if (src.channel === 'reception') return true;
  if (src.channel === 'reactive') {
    return looksLikeReceptionToken(src.source_recipe)
      || looksLikeReceptionToken(src.event_kind)
      || isCommitmentEvidenceToken(src.source_recipe)
      || isCommitmentEvidenceToken(src.event_kind);
  }
  if (src.channel === 'schedule') {
    return looksLikeReceptionToken(src.source_recipe);
  }
  return false;
};

/** The anchor-shaped filter the inbox list uses. One derivation, two
 *  callers — see `isReceptionOriginSource`. */
export const defaultIsReceptionOriginAnchor: IsReceptionOriginAnchor = (anchor) =>
  isReceptionOriginSource(anchor.execution_source);

// ────────────────────────────────────────────────────────────────
// Default source-record join (N.1) — derive a redacted preview from the
// held op's checkpoint (works before the projection source stores land)
// ────────────────────────────────────────────────────────────────

/** A conservative reception destination recovery from a held op's
 *  `operation_id` / step_state — used only by the default source
 *  resolver. The integration-step resolver derives it authoritatively
 *  from the projection op's destination Source (D5). */
const COMMITMENT_KIND: ReceptionInboxTopTierKind = 'commitment';

/** Map a held op's `execution_source` reception channel / recipe id to
 *  the originating `ReceptionInboxSourceKind`. Best-effort; the
 *  integration-step resolver pins it from the trigger. */
/** True for a hold minted by the `/reception/manage` reschedule door.
 *
 *  🔑 Kept SEPARATE from `recoverSourceKind`, which flattens this to
 *  `scheduling_link`. Both facts are true and both are needed: it IS a
 *  scheduling-link continuation for labelling, AND it is the one reception
 *  origin whose gated step is a KERNEL op (`core.work-entity.booking.update`),
 *  so its args are keyed `id` rather than the drain-stamped
 *  `booking_request_id` / `booking_id` the other reception kinds carry. Reading
 *  it as a plain scheduling link silently took the checkpoint fallback. */
const isManageOrigin = (anchor: AuditEntry): boolean => {
  const src = anchor.execution_source;
  return src?.channel === 'reception' && src.reception_id === '__manage__';
};

const recoverSourceKind = (anchor: AuditEntry): ReceptionInboxSourceKind => {
  const src = anchor.execution_source;
  // The possession-based manage door is a scheduling-link continuation: it
  // proposes a new slot for an existing reception booking. Its recipe id does
  // not contain `scheduling_link`, so recognize the dedicated reception id
  // before the best-effort token scan below.
  if (isManageOrigin(anchor)) {
    return 'scheduling_link';
  }
  const token =
    (src && 'source_recipe' in src ? src.source_recipe : undefined)
    ?? anchor.recipe_id
    ?? '';
  // D-192 F1 — a commitment-evidence capture originates from an
  // external-venue platform record (the CRM field the evidence
  // snapshot points at), which is exactly the `'vendor'` sentinel.
  if (isCommitmentEvidenceToken(token)) return 'vendor';
  for (const kind of [
    'scheduling_link',
    'intake_form',
    'drop_link',
    'approval_link',
    'status_link',
    'reception_page',
  ] as const) {
    if (token.includes(kind) || token.includes(kind.replace('_link', '').replace('_', '-'))) {
      return kind;
    }
  }
  return 'intake_form';
};

/** Default source-record join (N.1). Derives the redacted preview +
 *  prefilled args from the held op's checkpoint `step_state` / gated
 *  step + the anchor. Deliberately conservative — it surfaces NO sealed
 *  visitor PII (only a generic redacted title), so a missing
 *  integration-step resolver cannot leak (I-3). The integration step
 *  injects a resolver that joins the real per-kind reception source
 *  store + reveals on open. */
export const defaultResolveInboxSource: ResolveInboxSource = ({ anchor, checkpoint }) => {
  // D-182 §8 — reception inbox holds are recipe-based (the `review-then-approve`
  // workflow); a raw-op door checkpoint (recipe-less, no `gated_step_id`) never
  // reaches here. Guard the index for the recipe-less type.
  const gated =
    checkpoint.gated_step_id !== undefined
      ? checkpoint.step_state?.[checkpoint.gated_step_id]
      : undefined;
  const gatedObj =
    gated && typeof gated === 'object' && !Array.isArray(gated)
      ? (gated as Record<string, unknown>)
      : {};
  // The held op's prefilled args come from the gated step's recorded
  // input where the projection stamped them; fall back to the recorded
  // step output's `input` facet, else `{}`.
  const argsRaw = (gatedObj.input ?? gatedObj.args ?? {}) as unknown;
  const args =
    argsRaw && typeof argsRaw === 'object' && !Array.isArray(argsRaw)
      ? (argsRaw as Record<string, unknown>)
      : {};
  const kind = recoverSourceKind(anchor);
  const rawMetadata = args.metadata;
  const metadata =
    rawMetadata !== null && typeof rawMetadata === 'object' && !Array.isArray(rawMetadata)
      ? rawMetadata as Record<string, unknown>
      : {};
  // `record_ref` names the Reception source, not the gate checkpoint. Drains
  // stamp these ids after visitor content, so a visitor field cannot spoof
  // them. The checkpoint fallback preserves honest degraded behaviour for a
  // legacy/custom held op that carries no Reception provenance at all.
  // ⚠ The manage door is checked FIRST and separately. It flattens to
  // `scheduling_link` above, but its gated step is the kernel op
  // `core.work-entity.booking.update`, whose args are keyed `id` — the
  // SERVER-resolved booking id (the manage handler derives the target from the
  // credential's scope; the visitor supplies only a slot). The scheduling-link
  // arm's `booking_request_id`/`booking_id` are absent on this path, so without
  // this branch the record ref silently degraded to the gate checkpoint id.
  const manage = isManageOrigin(anchor);
  // 🔑 The manage door reads a PRE-GATE STEP OUTPUT, not the gated step's args,
  // and that is the whole reason it works.
  //
  // Its gated step is the KERNEL op `core.work-entity.booking.update`. Kernel
  // ops dispatch through the engine's simple-form branch, which — unlike the
  // catalog branch — records nothing under the gated step id when it holds. So
  // `args` is `{}` on this path and always was; reading `args.booking_id` here
  // would look right and resolve nothing, silently degrading to the checkpoint
  // id. `reschedule-booking-managed` therefore publishes the server-resolved
  // target as its own pre-gate step, whose OUTPUT the checkpoint already
  // captures like any other completed step.
  //
  // ⛔ Deliberately NOT fixed by teaching the engine to capture kernel-op args:
  // that would push every held kernel op's resolved input into the inbox LIST,
  // and `d-192-e3-propose-inbox-mint-e2e` pins that the list stays PII-free
  // (D-173 I-3) — a held commitment's args carry a counterparty email and an
  // evidence snippet. The list is currently PII-free partly BECAUSE this
  // capture is absent, so widening it there trades one defect for a leak. The
  // general kernel-op prefill gap is real and stays open; deciding it means
  // deciding where the list redacts args, which is a separate change.
  const manageTargetRaw = checkpoint.step_state?.manage_target_booking_id;
  const recordRefCandidate =
    manage
      ? (typeof manageTargetRaw === 'string' && manageTargetRaw.length > 0
        ? manageTargetRaw
        : undefined)
      : kind === 'scheduling_link'
        ? args.booking_request_id ?? args.booking_id
        : kind === 'intake_form'
          ? metadata.reception_form_submission_id
          : kind === 'drop_link'
            ? metadata.reception_drop_blob_id
            : kind === 'approval_link'
              ? metadata.reception_approval_intent_id
              : undefined;
  const record_ref =
    typeof recordRefCandidate === 'string' && recordRefCandidate.length > 0
      ? recordRefCandidate
      : checkpoint.checkpoint_id;
  // The projection payload the drain stamped into the gated step carries the
  // real materialize destination (`top_tier_kind`) — a drop → `task`, a
  // scheduling reservation → `booking`, and an intake → its configured target.
  // Surface it verbatim (when it's a valid kind) so the inbox list honestly
  // labels WHAT each held item will materialize into; fall back to
  // `commitment` only when the payload doesn't carry one. `top_tier_kind` is a
  // non-PII destination class (never a sealed visitor field), so reading it
  // here does not weaken the I-3 redaction the generic preview enforces.
  const argTopTierKind = (args as { top_tier_kind?: unknown }).top_tier_kind;
  // ⚠ A manage hold moves an EXISTING booking, so it carries no projection
  // payload and no `top_tier_kind` to read. Falling through to the
  // `commitment` default mislabelled the item AND — because `projectInboxItem`
  // gates the counterparty-history lookup on `top_tier_kind === 'booking'` —
  // silently suppressed the prior-booking history panel on the one surface the
  // owner most needs it: deciding whether to accept a visitor's new time.
  const top_tier_kind = isReceptionInboxTopTierKind(argTopTierKind)
    ? argTopTierKind
    : manage
      ? 'booking'
      : COMMITMENT_KIND;
  // D-173 P5 — surface a drop's file as the item `attachment` so the scan gate
  // (N.2) + the inbox warning can act on it. The review payload the drain
  // stamped carries `file_id` + the file metadata under `metadata.reception_*`
  // (drop-link-processor); `buildDropAttachment` maps them through.
  const attachment = buildDropAttachment(args);
  // D-192 F1 — a `vendor`-kind hold is a CAPTURED signal, not an
  // incoming request; label it honestly. Its args carry no sealed
  // visitor PII (the statement is CRM field content the warehouse
  // already holds), so the generic-title discipline (I-3) is about the
  // RECEPTION kinds, not this one.
  if (kind === 'vendor') {
    return {
      top_tier_kind,
      source: { kind, record_ref },
      args,
      preview: { title: 'Captured commitment proposal' },
      proposed_action: 'Create the commitment (evidence-captured) as edited',
    };
  }
  return {
    top_tier_kind,
    source: { kind, record_ref },
    args,
    ...(attachment !== undefined ? { attachment } : {}),
    // Redacted by construction — no sealed visitor PII (I-3). The
    // integration-step resolver renders a richer, reveal-on-open preview.
    preview: { title: 'Incoming request' },
    proposed_action: top_tier_kind === 'form_response'
      ? 'Accept and keep this form response in Data'
      : `Run ${anchor.recipe_id}`,
  };
};

/** Map a drop review payload's `file_id` + `metadata.reception_*` file fields
 *  to the InboxItem `attachment` (N.1). Returns undefined for a non-file held
 *  op (no `file_id`). `scan_status` is stamped `'unscanned'` as the FLOOR — the
 *  pure resolver has no warehouse access. When the ClamAV pack (D-173 P5 part B)
 *  is installed, the boot wiring's `readFileScanStatus` seam overrides this with
 *  a LIVE read of the `data.file.received` record's scan_status in
 *  `composeReceptionInboxDeps` (so a `clean` / `flagged` verdict surfaces here);
 *  absent a scanner the `'unscanned'` floor stands and the gate stays advisory. */
const buildDropAttachment = (
  args: Record<string, unknown>,
): InboxItem['attachment'] => {
  const fileId = args.file_id;
  if (typeof fileId !== 'string' || fileId.length === 0) return undefined;
  const metaRaw = args.metadata;
  const meta =
    metaRaw && typeof metaRaw === 'object' && !Array.isArray(metaRaw)
      ? (metaRaw as Record<string, unknown>)
      : {};
  const asString = (v: unknown): string => (typeof v === 'string' ? v : '');
  const asSize = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
  return {
    file_id: fileId,
    filename: asString(meta.reception_filename),
    mime_type: asString(meta.reception_mime_type),
    size: asSize(meta.reception_size_bytes),
    scan_status: 'unscanned',
  };
};

// ────────────────────────────────────────────────────────────────
// I-2 — Held-op query → InboxItem[]
// ────────────────────────────────────────────────────────────────

/** Recover the operation identity for a held op — prefer the resolved
 *  `approved_target` (the catalog gate's `operation_id` / fallback
 *  `ingredient_slug`), else a synthetic `<recipe>.<gated_step>` id. The
 *  resolver keys the editable-args allowlist on this. */
const heldOperationId = (anchor: AuditEntry, checkpoint: Checkpoint): string =>
  checkpoint.approved_target?.operation_id
  ?? checkpoint.approved_target?.ingredient_slug
  ?? `${anchor.recipe_id}.${checkpoint.gated_step_id}`;

/** Derive an item's open-view status from its (optional) attachment
 *  scan-state — an unfinished / flagged scan surfaces it as
 *  `requires_review`; otherwise `pending`. */
const itemStatusFromScan = (
  attachment: ResolvedInboxSource['attachment'],
): ReceptionInboxStatus =>
  attachment?.scan_status === 'flagged'
  || attachment?.scan_status === 'pending'
  || attachment?.scan_status === 'unscanned'
    ? 'requires_review'
    : 'pending';

/** The single inbox-item projection (used by both the list query + the
 *  per-hold re-derive), so the two never drift. `arg_schema` is filled
 *  via the injected `resolveArgEditSchema` seam (N.6). */
/** D-177 N.14 — the "allow for this form" offer off the hold's REAL ask
 *  (as raised — never recomputed), best-effort: a missing dep / ask_id /
 *  throwing read yields no hint (the approve path re-verifies at the act
 *  site regardless). */
const resolveAllowOffer = async (
  deps: ReceptionInboxDeps,
  anchor: AuditEntry,
): Promise<{ ttl_ms: number; max_uses: number } | undefined> => {
  const ask_id = anchor.ask_id;
  if (
    typeof deps.readAskAllowOffer !== 'function'
    || typeof ask_id !== 'string'
    || ask_id.length === 0
  ) {
    return undefined;
  }
  try {
    return await deps.readAskAllowOffer(ask_id);
  } catch {
    return undefined;
  }
};

const projectInboxItem = async (
  deps: ReceptionInboxDeps,
  anchor: AuditEntry,
  checkpoint: Checkpoint,
  resolved: ResolvedInboxSource,
  allowOffer?: { ttl_ms: number; max_uses: number },
): Promise<InboxItem> => {
  const operation_id = heldOperationId(anchor, checkpoint);
  // A store-only acceptance has no materialized title/body/destination to
  // edit. The shared intake operation exposes those fields for entity targets,
  // so suppress them here rather than accepting edits that cannot take effect.
  let arg_schema = resolved.top_tier_kind === 'form_response'
    ? { fields: [] }
    : deps.resolveArgEditSchema(
        operation_id,
        resolved.args,
        deps.resolverDeps ?? {},
      );
  let itemArgs = resolved.args;
  if (
    resolved.top_tier_kind === 'form_response'
    && deps.resolveFormResponseEdit !== undefined
  ) {
    try {
      const editable = await deps.resolveFormResponseEdit(resolved.source, resolved.args);
      if (editable !== undefined) {
        itemArgs = {
          ...resolved.args,
          form_response_values: editable.values,
          form_response_visitor_email: editable.visitor_email ?? '',
        };
        arg_schema = {
          fields: [
            {
              key: 'form_response_values',
              type: 'json',
              label: 'Answers',
              required: true,
              privacy: 'content',
              affects_target: false,
            },
            {
              key: 'form_response_visitor_email',
              type: 'string',
              label: 'Visitor email',
              required: false,
              privacy: 'email',
              affects_target: false,
            },
          ],
        };
      }
    } catch {
      // Fail closed: an unreadable source means no editable fields. Approve can
      // still persist the exact sealed original through the promotion hook.
    }
  }
  // D-173 D7 "confirmed at approval" — what else is on the calendar then. Only
  // for time-framed items, only when a counter is wired. A throw is swallowed to
  // absent (never to 0): the count is a claim, and no claim beats a false one.
  const window = proposedSlotWindow(resolved.top_tier_kind, resolved.args);
  let calendar_overlap: InboxItem['calendar_overlap'];
  if (window !== null && deps.countCalendarOverlap !== undefined) {
    try {
      const counted = deps.countCalendarOverlap(window.start, window.end);
      calendar_overlap = {
        count: counted.count,
        window_start: window.start,
        window_end: window.end,
        calendars_read: counted.calendars_read,
        unreadable_calendars: counted.unreadable.length,
      };
    } catch {
      calendar_overlap = undefined;
    }
  }
  let booking_history: InboxItem['booking_history'];
  if (
    resolved.top_tier_kind === 'booking'
    && deps.lookupBookingHistory !== undefined
  ) {
    try {
      booking_history = await deps.lookupBookingHistory(resolved.source, resolved.args);
    } catch {
      // Enrichment failure is unknown, never an empty-history claim.
      booking_history = undefined;
    }
  }
  return {
    hold_id: checkpoint.checkpoint_id,
    operation_id,
    top_tier_kind: resolved.top_tier_kind,
    source: resolved.source,
    args: itemArgs,
    arg_schema,
    preview: resolved.preview,
    ...(resolved.attachment !== undefined ? { attachment: resolved.attachment } : {}),
    ...(allowOffer !== undefined ? { allow_offer: allowOffer } : {}),
    proposed_action: resolved.proposed_action,
    ...(calendar_overlap !== undefined ? { calendar_overlap } : {}),
    ...(booking_history !== undefined ? { booking_history } : {}),
    status: itemStatusFromScan(resolved.attachment),
  };
};

/** Enumerate the held `approval_required` operations (N.1): scan the
 *  most-recent `scanLimit` audit anchors, keep the `'awaiting_approval'`
 *  ones, FILTER to incoming-trigger origin, pair each with its
 *  checkpoint, join the source record, and project to an `InboxItem`
 *  (filling `arg_schema` via the injected resolver). Newest-anchor-first.
 *
 *  The audit store has no "list by `commit_status`" query, so this is an
 *  app-side filter over `listRecent(scanLimit)` (a thin index is a
 *  future optimization — flagged in the report). */
export const queryReceptionInboxHeldOps = async (
  deps: ReceptionInboxDeps,
): Promise<ReceptionInboxHeldOp[]> => {
  const scanLimit = deps.scanLimit ?? DEFAULT_SCAN_LIMIT;
  const recent = await deps.auditLog.listRecent(scanLimit);
  const held: ReceptionInboxHeldOp[] = [];
  for (const anchor of recent) {
    // (1) only paused runs.
    if (anchor.commit_status !== 'awaiting_approval') continue;
    // (2) ONLY reception-incoming-triggered holds (N.1) — never an
    //     arbitrary gated op. The single most important filter.
    if (!deps.isReceptionOrigin(anchor)) continue;
    // (3) pair with the checkpoint (the held call's resumable state).
    const checkpoints = await deps.checkpointStore.listByRun(anchor.run_id);
    const checkpoint = checkpoints[0];
    if (checkpoint === undefined) continue;
    // (4) join the source record + redacted preview (N.1). A stranded
    //     hold with no source record is skipped.
    const resolved = deps.resolveSource({ anchor, checkpoint });
    if (resolved === null) continue;
    // (5) resolve the editable-args allowlist (N.6) via the seam + project
    //     (+ the N.14 allow-offer rendering hint off the hold's real ask).
    const allowOffer = await resolveAllowOffer(deps, anchor);
    held.push({
      anchor,
      checkpoint,
      item: await projectInboxItem(deps, anchor, checkpoint, resolved, allowOffer),
    });
  }
  return held;
};

/** Find one held op by `hold_id` (= `checkpoint_id`), or `null`. Used by
 *  approve / reject — they re-derive the full held op (with its anchor +
 *  checkpoint + resolved `arg_schema`) so the allowlist + ask_id are
 *  authoritative server-side, never trusted from the caller. */
const findHeldOp = async (
  deps: ReceptionInboxDeps,
  hold_id: string,
): Promise<ReceptionInboxHeldOp | null> => {
  // The checkpoint is addressable by id directly; re-derive the rest
  // through the same projection the list uses so the `arg_schema`
  // allowlist + the origin filter are re-applied (never trust a stale
  // client view).
  const checkpoint = await deps.checkpointStore.get(hold_id);
  if (checkpoint === null) return null;
  const anchor = await deps.auditLog.get(checkpoint.run_id);
  if (anchor === null) return null;
  if (anchor.commit_status !== 'awaiting_approval') return null;
  if (!deps.isReceptionOrigin(anchor)) return null;
  const resolved = deps.resolveSource({ anchor, checkpoint });
  if (resolved === null) return null;
  const allowOffer = await resolveAllowOffer(deps, anchor);
  return {
    anchor,
    checkpoint,
    item: await projectInboxItem(deps, anchor, checkpoint, resolved, allowOffer),
  };
};

/** D-210 A.8 3d-2b — the `/ask` landing page's read of one held op.
 *
 *  The ONLY thing outside this module that needs a hold-by-id read, and it
 *  needs strictly less than `findHeldOp` returns: the projected `InboxItem`,
 *  never the anchor or the checkpoint. Handing out the item alone keeps the
 *  gate's own handles (the run anchor, the resumable checkpoint) inside the
 *  module that owns the boundary — a read surface has no business holding
 *  either.
 *
 *  Every fence `findHeldOp` applies applies here unchanged, and one of them
 *  is load-bearing for the landing page: `isReceptionOrigin`. A hold raised
 *  by an AI agent's MCP write resolves to `null` here, so a URL-bearer page
 *  can never surface a non-reception operation's arguments. The caller
 *  addresses the hold by `checkpoint_id`, which is what `PendingAsk.
 *  handler_payload.checkpoint_id` carries for a `gateway.preflight` ask
 *  (`buildPreflightAsk`) — `hold_id === checkpoint_id`.
 *
 *  Returns null for an unknown / consumed / non-reception hold. */
export const findReceptionHoldItem = async (
  deps: ReceptionInboxDeps,
  hold_id: string,
): Promise<InboxItem | null> => {
  const held = await findHeldOp(deps, hold_id);
  return held === null ? null : held.item;
};

// ────────────────────────────────────────────────────────────────
// N.6 allowlist validation (THE BOUNDARY MUST, step 1)
// ────────────────────────────────────────────────────────────────

/** Validate `edits` against the operation's `ArgEditSchema` allowlist
 *  (N.6) — THE FIRST HALF OF THE BOUNDARY MUST. Returns the validated
 *  override object (a fresh plain object — never the caller's, and never
 *  carrying a prototype-pollution key) ready to hand to the NARROW
 *  `setArgOverrides` writer. THROWS `edit_not_allowed` on the FIRST key
 *  that is not in the allowlist — so a non-allowlisted edit never reaches
 *  the checkpoint (and thus never reaches the engine's wholesale merge).
 *
 *  An empty / absent `edits` returns `{}` (approve-as-prefilled).
 *  Prototype-sensitive keys are rejected as `edit_not_allowed` even if
 *  the allowlist somehow named one (defense in depth — they are also
 *  dropped by the engine merge + `computeArgEditsDiff`). */
/** D-210 step 2c — enforce ONE field's declared shape.
 *
 *  ⛔ Mirrors what the webclient already enforces (`inbox-panel.ts:459-524`) rather than
 *  inventing a second rule set: type coercion per `MetaFieldType`, `required`, and
 *  `validation.min` / `max` / `pattern`. Two rule sets would let the two surfaces disagree
 *  about what a valid edit is, and the SERVER's answer is the one that reaches the op.
 *
 *  ⚠ Why this exists at all: until now `ArgEditField.validation` was **client-side-only in
 *  practice** — the server checked the KEY and passed the VALUE through verbatim, so an
 *  admin rpc client could put a string in a `datetime` and it reached `mergeArgOverrides`
 *  untouched. Admin-only, so never a privilege hole — but D-210 §4's model makes every
 *  declared field editable, and "editable" has to mean "editable to its declared shape" or
 *  the declaration is decoration. [[declared_is_not_backed]]
 *
 *  ⛔ Type only — NEVER value semantics. This says a `datetime` is a number; it does not say
 *  the slot is free, in the future, or yours. Those are the projection's and the gate's, and
 *  a validator that reached for them would be the wrong layer holding the wrong rule. */
const enforceFieldShape = (
  field: ArgEditField,
  value: unknown,
  method: string,
): unknown => {
  const refuse = (why: string): never => {
    throw rpcError(
      'edit_invalid',
      `${method}: edit '${field.key}' ${why}`,
      400,
    );
  };
  // An explicit `null`/`undefined` on a NON-required field clears it — the same thing the
  // webclient's `raw.trim() === '' && field.required === false` arm does. On a required
  // field it is a refusal rather than a silent pass-through.
  if (value === undefined || value === null) {
    if (field.required === true) refuse('is required');
    return value;
  }
  switch (field.type) {
    case 'string':
      if (typeof value !== 'string') refuse(`must be a string (got ${typeof value})`);
      if (field.required === true && (value as string).trim() === '') refuse('is required');
      if (field.validation?.pattern !== undefined) {
        let re: RegExp;
        try {
          re = new RegExp(field.validation.pattern);
        } catch {
          // A malformed pack pattern must not become an accidental allow-all NOR an
          // un-editable field with no stated cause. Refuse and name it.
          return refuse(`declares an invalid pattern (${field.validation.pattern})`);
        }
        if (!re.test(value as string)) refuse(`does not match ${field.validation.pattern}`);
      }
      return value;
    case 'number':
    case 'datetime': {
      // ⚠ `datetime` IS a number on the wire (unix ms) — the webclient converts at the
      // control (`new Date(raw).getTime()`), so by the time it reaches the rpc the two types
      // are the same shape. Validating them together is the truth, not a shortcut.
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        refuse(`must be a finite number (got ${typeof value})`);
      }
      const n = value as number;
      if (field.validation?.min !== undefined && n < field.validation.min) {
        refuse(`must be >= ${field.validation.min}`);
      }
      if (field.validation?.max !== undefined && n > field.validation.max) {
        refuse(`must be <= ${field.validation.max}`);
      }
      return value;
    }
    case 'boolean':
      if (typeof value !== 'boolean') refuse(`must be a boolean (got ${typeof value})`);
      return value;
    case 'json':
      // Already-parsed JSON on the wire. Bound it to what the arg can actually carry: a
      // plain object or array. A bare scalar is a `string`/`number` field mis-declared, and
      // a class instance / cycle would not survive the checkpoint's JSON round-trip.
      if (typeof value !== 'object') refuse('must be an object or array');
      try {
        JSON.parse(JSON.stringify(value));
      } catch {
        return refuse('must be JSON-serializable');
      }
      return value;
  }
};

export const validateEditsAgainstSchema = (
  edits: Record<string, unknown> | undefined,
  schema: ArgEditSchema,
  method: string,
): Record<string, unknown> => {
  if (edits === undefined || edits === null) return {};
  if (typeof edits !== 'object' || Array.isArray(edits)) {
    throw rpcError('bad_request', `${method}: edits must be an object when present`, 400);
  }
  const byKey = new Map<string, ArgEditField>(
    schema.fields.map((f: ArgEditField) => [f.key, f]),
  );
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(edits)) {
    if (PROTO_KEYS.has(key)) {
      throw rpcError(
        'edit_not_allowed',
        `${method}: edit key '${key}' is not editable (prototype-sensitive)`,
        400,
      );
    }
    const field = byKey.get(key);
    if (field === undefined) {
      throw rpcError(
        'edit_not_allowed',
        `${method}: edit key '${key}' is not in the operation's editable-args allowlist`,
        400,
      );
    }
    // D-210 step 2c — the VALUE, not just the key. Was `out[key] = edits[key]` verbatim.
    out[key] = enforceFieldShape(field, (edits as Record<string, unknown>)[key], method);
  }
  return out;
};

// ────────────────────────────────────────────────────────────────
// approved_target recompute (N.5 §3)
// ────────────────────────────────────────────────────────────────

/** Recompute `approved_target` from the MERGED args (N.5 §3). When the
 *  user edited a target-affecting field (`ArgEditField.affects_target`),
 *  the destination/connection the human consciously chose at approve time
 *  becomes the approved target — the inbox edit is the opposite of a
 *  silent `{{config.*}}` drift, so approve-with-edits approves THAT
 *  resolved target. Maps an edited `affects_target` field's value onto
 *  the matching `PreflightApprovedTarget` axis (`connection_name` /
 *  `operation_id` / `ingredient_slug`) where the field key names it;
 *  otherwise the field's concrete value replaces the connection axis (the
 *  common case: `calendar_id` / `source_id` picks the destination
 *  connection).
 *
 *  Returns `undefined` when no target-affecting edit was made — the
 *  checkpoint's existing `approved_target` (the recipe-gate-resolved
 *  identity) stands, and the un-edited drift guard keeps full strength.
 *  Sound precisely because the same admin approve action authored the
 *  edits (N.5 MUST). */
export const recomputeApprovedTarget = (
  existing: PreflightApprovedTarget | undefined,
  validatedEdits: Record<string, unknown>,
  schema: ArgEditSchema,
): PreflightApprovedTarget | undefined => {
  const targetFields = schema.fields.filter((f) => f.affects_target === true);
  const edited = targetFields.filter((f) =>
    Object.prototype.hasOwnProperty.call(validatedEdits, f.key),
  );
  if (edited.length === 0) return undefined;
  const next: PreflightApprovedTarget = { ...(existing ?? {}) };
  for (const f of edited) {
    const v = validatedEdits[f.key];
    if (typeof v !== 'string') continue; // identity axes are strings
    if (f.key === 'operation_id') next.operation_id = v;
    else if (f.key === 'ingredient_slug') next.ingredient_slug = v;
    else if (f.key === 'connection_name' || f.key === 'connection') next.connection_name = v;
    else next.connection_name = v; // destination picker (calendar_id / source_id / …)
  }
  return next;
};

// ────────────────────────────────────────────────────────────────
// Audit (D-120) — "approved with edits" + the changed-key diff
// ────────────────────────────────────────────────────────────────

/** Record the D-120 "approved with edits" audit row + the changed-key
 *  diff (N.5 §4), reusing the exported `computeArgEditsDiff`. Attributable
 *  to the same admin approve action that authored the edits + reversible.
 *  Best-effort over `logActivity` — a signed activity row keyed on the
 *  hold + actor. Sealed-PII values follow N.6 reveal rules (the diff's
 *  raw old/new is recorded only for the operator's own audit, never
 *  surfaced to a visitor). */
const auditApprovedWithEdits = async (
  deps: ReceptionInboxDeps,
  held: ReceptionInboxHeldOp,
  approver: ReceptionInboxApprover,
  validatedEdits: Record<string, unknown>,
  allowedForForm = false,
): Promise<void> => {
  const diff = computeArgEditsDiff(held.item.args, validatedEdits);
  const editedKeys = diff.map((d) => d.key);
  const auditDiff = held.item.top_tier_kind === 'form_response'
    ? diff.map((entry) => ({
        key: entry.key,
        old_value: '<redacted form response content>',
        new_value: '<redacted form response content>',
      }))
    : diff;
  // N.14 — allow never combines with edits (the rpc refuses upstream), so
  // the detail vocabulary stays a closed three-way.
  const what = allowedForForm
    ? `approved & allowed for this form on ${held.item.operation_id}`
    : editedKeys.length > 0
      ? `approved with edits on ${held.item.operation_id}: ${JSON.stringify(auditDiff)}`
      : `approved (no edits) on ${held.item.operation_id}`;
  // WHO, not just what — see `describeApprover`. `ActivityEntry` has no
  // actor column, so `detail` is where it can live at all.
  const detail = `${what} [by ${describeApprover(approver)}]`;
  await deps.auditLog.logActivity({
    activity_id: `reception.inbox.approved-${deps.now()}-${held.checkpoint.checkpoint_id}`,
    timestamp: deps.now(),
    action: ACTION_APPROVED,
    target: held.checkpoint.checkpoint_id,
    detail,
    reserve: true,
  });
};

// ────────────────────────────────────────────────────────────────
// Attachment scan-gate (N.2 / D-172 Q2)
// ────────────────────────────────────────────────────────────────

/** Gate approve on a held op's attachment scan-state (N.2 / D-172 Q2) — an
 *  ADVISORY warn-and-confirm, NOT a hard block: the human reviewing the drop is
 *  the gate, and an unscanned file is a risk to SURFACE, not forbid. `clean`
 *  (or no attachment) passes silently; `unscanned` (not yet scanned — no scanner
 *  pack installed, or the scan hasn't run) and `flagged` (scanner found malware)
 *  are refused only until the admin clears the warning with
 *  `acknowledge_attachment_risk`; `pending` is a brief self-clearing hold (a scan
 *  is mid-flight — don't let approve race a verdict seconds away; without a
 *  scanner pack installed, files stay `unscanned`, never `pending`). A scanner
 *  pack (ClamAV / Windows Defender, D-173 P5 part B) writes `clean` / `flagged`
 *  via `core.storage.file.set-scan-status`. The real egress boundary stays the
 *  gated `file.read` (D-172 A.8 / F2) — attaching ≠ exposing the bytes. */
const enforceAttachmentScanGate = (
  item: InboxItem,
  input: ReceptionInboxApproveInput,
  method: string,
): void => {
  const att = item.attachment;
  if (att === undefined || att.scan_status === 'clean') return;
  if (att.scan_status === 'pending') {
    throw rpcError(
      'attachment_scan_pending',
      `${method}: attachment '${att.filename}' is being scanned — try again in a moment`,
      409,
    );
  }
  // `unscanned` / `flagged` — advisory: proceed once the admin acknowledges.
  if (input.acknowledge_attachment_risk !== true) {
    const flagged = att.scan_status === 'flagged';
    throw rpcError(
      flagged ? 'attachment_flagged' : 'attachment_unscanned',
      `${method}: attachment '${att.filename}' ${
        flagged ? 'was flagged by the scanner' : 'has not been virus-scanned'
      } — pass acknowledge_attachment_risk to attach it anyway`,
      409,
    );
  }
};

// ────────────────────────────────────────────────────────────────
// Handlers
// ────────────────────────────────────────────────────────────────

/** `reception.inbox.list` — the held-op view, open or subview (N.2). */
export const handleReceptionInboxList = async (
  deps: ReceptionInboxDeps,
  args: ReceptionInboxListInput | undefined,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<ReceptionInboxListResult> => {
  const method = 'reception.inbox.list';
  requireAdmin(caller, method);
  const view: ReceptionInboxView = args?.view === 'subview' ? 'subview' : 'open';
  const limit = Math.min(
    Math.max(1, typeof args?.limit === 'number' ? Math.floor(args.limit) : DEFAULT_LIST_LIMIT),
    MAX_LIST_LIMIT,
  );
  const sourceFilter = args?.source;

  if (view === 'subview') {
    // D10 — the dismissed / expired subview. Projects the subview store's
    // rows into the same `InboxItem` shape (terminal — no live checkpoint,
    // so `arg_schema` is empty + args are not editable).
    const rows = deps.subviewStore.list(limit);
    const items: InboxItem[] = rows.map((r) => ({
      hold_id: r.hold_id,
      operation_id: '',
      // The real materialize target persisted at reject time (legacy rows
      // predating the column fall back to `commitment` in the store's narrow).
      top_tier_kind: r.top_tier_kind,
      source: { kind: 'intake_form', record_ref: r.source_record_ref },
      args: {},
      arg_schema: { fields: [] },
      preview: { title: r.status === 'expired' ? 'Expired request' : 'Dismissed request' },
      proposed_action: r.reason ?? '',
      status: r.status,
    }));
    return { items };
  }

  const held = await queryReceptionInboxHeldOps(deps);
  let items = held.map((h) => h.item);
  if (sourceFilter !== undefined) {
    items = items.filter((it) => it.source.kind === sourceFilter);
  }
  // The query is already newest-anchor-first; clamp to the page size.
  return { items: items.slice(0, limit) };
};

/** `reception.inbox.approve` — the editable-args gate driver (N.2 / N.5).
 *
 *  THE BOUNDARY MUST is implemented here, in order:
 *    1. re-derive the held op server-side (never trust the client view);
 *    2. scan-gate the attachment (N.2 / D-172 Q2);
 *    3. VALIDATE `edits` against the item's `ArgEditSchema` allowlist
 *       (N.6) — reject any non-allowlisted key BEFORE any write;
 *    4. WRITE the validated overrides to `checkpoint.arg_overrides`
 *       through the NARROW `CheckpointStore.setArgOverrides` writer (the
 *       ONLY write path for `arg_overrides`), recomputing
 *       `approved_target` from the merged args (N.5 §3);
 *    5. audit the old→new diff (N.5 §4);
 *    6. RELEASE through the EXISTING preflight resume path (answer the
 *       `gateway.preflight` ask with `'approve'`) — the engine merges the
 *       overrides on resume; this module never touches the engine. */
export const handleReceptionInboxApprove = async (
  deps: ReceptionInboxDeps,
  args: ReceptionInboxApproveInput,
  caller: ReceptionInboxCaller | undefined,
): Promise<ReceptionInboxApproveResult> => {
  const method = 'reception.inbox.approve';
  const approver = resolveApprover(caller, method);
  if (!args || typeof args.hold_id !== 'string' || args.hold_id.length === 0) {
    throw rpcError('bad_request', `${method}: hold_id is required`, 400);
  }

  // (1) re-derive the held op server-side — the `arg_schema` allowlist +
  //     ask_id are authoritative here, never trusted from the caller.
  const held = await findHeldOp(deps, args.hold_id);
  if (held === null) {
    throw rpcError(
      'hold_not_found',
      `${method}: hold '${args.hold_id}' is not an open reception-incoming hold (consumed / unknown / not reception-origin)`,
      404,
    );
  }

  // (2) attachment scan-gate (N.2 / D-172 Q2).
  enforceAttachmentScanGate(held.item, args, method);

  // (3) validate edits against the allowlist (BOUNDARY MUST, step 1).
  const validatedEdits = validateEditsAgainstSchema(args.edits, held.item.arg_schema, method);

  // (3b) D-177 N.14 — "Approve & allow for this form". Refused with edits:
  //      an edited approval is proof the pipe's output wasn't right — it
  //      earns no standing trust (and the grant would mint from the edited
  //      dispatch, contradicting the next unedited fire).
  const wantsAllow = args.allow === true;
  if (wantsAllow && Object.keys(validatedEdits).length > 0) {
    throw rpcError(
      'bad_request',
      `${method}: 'allow' cannot combine with edits — an edited approval earns no standing trust (N.14)`,
      400,
    );
  }

  // (3b-ii) D-210 Phase C — pick the release MECHANISM before any write.
  //
  //   - a hold WITH an ask releases by answering it (the existing chain:
  //     submitAnswer → on_answer → resumer.resumeRun);
  //   - a hold WITHOUT one releases through the resumer directly.
  //
  // The second is not an edge case any more. `inbox_fanout_mode: 'notify'`
  // deliberately raises no ask, so in that mode EVERY held item arrives
  // here ask-less. (It also unsticks the pre-existing accident: a raise
  // that threw after the checkpoint write leaves an `awaiting_approval`
  // anchor with no `ask_id`, which used to report `not_configured` and
  // wait for a boot sweep.)
  const ask_id = held.anchor.ask_id;
  // ⛔ D-210 audit finding 10 — BIND the presented capability to THIS hold.
  //
  // `resolveApprover` runs before `held` is resolved, so it can only check the
  // `ask_id` is non-empty. `args.hold_id` is caller-supplied and `findHeldOp`
  // resolves ANY open reception hold, so nothing compared the two: the capability
  // raised for ask A could name hold B, and the audit row would then attribute
  // B's release to A. Not exploitable through the one caller that exists today
  // (the landing port derives `hold_id` from `ask.handler_payload.checkpoint_id`),
  // but `handleReceptionInboxApprove` is a public export and the invariant lived
  // one module away in its only caller rather than in the handler that enforces
  // authority. A second call site would inherit the hole silently.
  //
  // ⇒ [[a_capability_derives_its_target]] — a bearer capability must derive its
  // target from itself, and where it cannot, the act site must re-check the pair.
  if (approver.kind === 'ask_landing' && approver.ask_id !== ask_id) {
    throw rpcError(
      'permission_denied',
      `${method}: the ask capability was not raised for this held operation`,
      403,
    );
  }
  const hasAsk = typeof ask_id === 'string' && ask_id.length > 0;
  const canAnswerAsk = typeof deps.submitAnswer === 'function' && hasAsk;
  const canReleaseWithoutAsk =
    !hasAsk && typeof deps.releaseWithoutAsk === 'function';
  if (!canAnswerAsk && !canReleaseWithoutAsk) {
    return {
      hold_id: held.checkpoint.checkpoint_id,
      released: false,
      reason: 'not_configured',
      edited_keys: [],
    };
  }

  // (3c) N.14 act-site re-verify — the ask must ACTUALLY carry the
  //      allow_session offer: `submitAnswer` silently no-ops an option the
  //      ask never offered, so a blind submit would report `released` while
  //      the hold stayed open. Re-derive from the real ask, never the
  //      client's rendering hint.
  //
  //      ⛔ An ask-less hold can NEVER take this option. A session grant is
  //      minted from the bounds the ask OFFERED, and an offer the owner was
  //      never shown is not an offer. Fail closed rather than inventing
  //      default bounds — "allow for this form" has to mean the owner saw
  //      what they were widening. (D-177 N.14 + the P3 fail-closed posture:
  //      absent offer ⇒ the option is simply absent.)
  let releaseOption: string = ASK_APPROVE;
  if (wantsAllow) {
    if (!canAnswerAsk) {
      throw rpcError(
        'bad_request',
        `${method}: this hold has no ask, so it carries no allow-for-this-form offer to accept`,
        400,
      );
    }
    const offer =
      typeof deps.readAskAllowOffer === 'function'
        ? await deps.readAskAllowOffer(ask_id as string)
        : undefined;
    if (offer === undefined) {
      throw rpcError(
        'bad_request',
        `${method}: this hold's ask carries no allow-for-this-form offer`,
        400,
      );
    }
    releaseOption = ASK_ALLOW_SESSION;
  }

  // (4) write to checkpoint.arg_overrides through the NARROW writer
  //     (BOUNDARY MUST, step 2) + recompute approved_target from the
  //     merged args (N.5 §3). The writer is the ONLY arg_overrides write
  //     path; the engine resume merge reads it ONLY off the consumed
  //     checkpoint, never off caller input.
  const recomputedTarget = recomputeApprovedTarget(
    held.checkpoint.approved_target,
    validatedEdits,
    held.item.arg_schema,
  );
  await deps.checkpointStore.setArgOverrides(held.checkpoint.checkpoint_id, {
    arg_overrides: validatedEdits,
    ...(recomputedTarget !== undefined ? { approved_target: recomputedTarget } : {}),
  });

  // (5) audit the old→new diff (N.5 §4; the N.14 allow answer is named in
  //     the detail — the durable record must read what actually happened).
  await auditApprovedWithEdits(deps, held, approver, validatedEdits, wantsAllow);

  // (6) release through the EXISTING preflight resume path. Answer the
  //     held op's `gateway.preflight` ask with `'approve'` — or, N.14, with
  //     `'allow_session'` (the existing answer path threads the session-
  //     grant marker; the resume's commit-gate mint stamps the door
  //     binding). The existing on_answer → resumer.resumeRun reads the
  //     checkpoint (now carrying `arg_overrides`) and the engine merges
  //     them on resume. This module never touches the engine /
  //     preflight-resumer.
  //
  //     D-210 Phase C — an ask-less hold takes the direct leg instead. It
  //     runs the SAME decorated resumer (so the intake acceptance hook and
  //     every other pre-resume effect fire identically), and it stamps the
  //     approval moment off this handler's own clock — the same `now()` the
  //     audit row above used, so the durable record and the promotion
  //     hook's `accepted_at` cannot disagree.
  if (canAnswerAsk) {
    await deps.submitAnswer!(ask_id as string, releaseOption);
  } else {
    await deps.releaseWithoutAsk!(held.checkpoint, {
      kind: 'approve',
      approved_at: deps.now(),
    });
  }

  deps.broadcast({ kind: 'reception_inbox', op: 'approved', hold_id: held.checkpoint.checkpoint_id });

  return {
    hold_id: held.checkpoint.checkpoint_id,
    released: true,
    edited_keys: Object.keys(validatedEdits),
  };
};

/** `reception.inbox.reject` — move to the subview + free any slot hold
 *  (N.2 / D7 / D10). Answers the held op's ask with `'deny'` (the
 *  existing deny path consumes the checkpoint + fails the run), records a
 *  `dismissed` subview row (D10 — not delete), and frees any slot hold.
 *  reject NEVER writes `arg_overrides` — only approve does. */
export const handleReceptionInboxReject = async (
  deps: ReceptionInboxDeps,
  args: ReceptionInboxRejectInput,
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<ReceptionInboxRejectResult> => {
  const method = 'reception.inbox.reject';
  requireAdmin(caller, method);
  if (!args || typeof args.hold_id !== 'string' || args.hold_id.length === 0) {
    throw rpcError('bad_request', `${method}: hold_id is required`, 400);
  }
  const reason =
    typeof args.reason === 'string' && args.reason.length > 0 ? args.reason : undefined;

  const held = await findHeldOp(deps, args.hold_id);
  if (held === null) {
    throw rpcError(
      'hold_not_found',
      `${method}: hold '${args.hold_id}' is not an open reception-incoming hold (consumed / unknown / not reception-origin)`,
      404,
    );
  }

  // NOTE (2026-07-16): a `freeSlotHold` seam used to be called here, to release
  // the booking's slot on reject (D7 / I-5). It was a no-op in production and is
  // now deleted along with the hold model it served: the substrate no longer
  // refuses an overlapping booking, so a booking holds nothing and a reject has
  // nothing to free. (While the hold model stood, this seam's absence WAS a live
  // defect — a rejected booking burned its slot forever, because the row stayed
  // non-'rejected' and the overlap query read every such row as a hold. Deleting
  // the query retired the defect at the root.)

  // Record the dismissal in the subview (D10 — not delete).
  //
  // D-177 N.14.8 fork 3 — stamp the DOOR this hold ran under. §N.14.8's v1
  // recorded that "rejects aren't durably keyed" and named reject durability as
  // the follow-on: the row below was already durable, it just named no door, so
  // nothing could count it against the key the learner suggests for. The door is
  // the right unit (not the op): a D-173 reject declines the whole SUBMISSION,
  // and the evidence sentence it feeds reads "on this form".
  //
  // ⛔ SURFACE, NEVER SUPPRESS (owner, 2026-07-17): this count is EVIDENCE the
  // owner reads on the suggestion card, never a gate. A machine "suppress after
  // N rejects" would be the substrate judging — and it would be WRONG here: a
  // reception owner reviews STRANGERS, so rejecting spam is the normal case, not
  // distrust of the recipe. Any door that ever saw spam would stop suggesting
  // forever. [[feedback_substrate_enforces_humans_judge]]
  // ⚠ `ExecutionSource` is a UNION and only some members carry `contract_id`
  // (the typechecker caught a hand-rolled property read here). Go through the
  // one exported accessor — it is also what decides `contract_snapshot`
  // presence (D-161 N.4), so the door this reject names is the same door the
  // dispatch was gated under, never a parallel derivation.
  const rejectedSource = held.anchor.execution_source;
  const rejectedDoorId =
    rejectedSource !== undefined ? executionSourceContractId(rejectedSource) : undefined;
  deps.subviewStore.record({
    hold_id: held.checkpoint.checkpoint_id,
    status: 'dismissed',
    // Carry the real materialize target so the subview labels the dismissed
    // item the same way the open list did (drop → task, booking →
    // calendar.event) — not a generic 'commitment'.
    top_tier_kind: held.item.top_tier_kind,
    ...(reason !== undefined ? { reason } : {}),
    source_record_ref: held.item.source.record_ref,
    dismissed_at: deps.now(),
    ...(typeof rejectedDoorId === 'string' && rejectedDoorId.length > 0
      ? { door_contract_id: rejectedDoorId }
      : {}),
  });

  // Audit (D-120, signed/reserve).
  await deps.auditLog.logActivity({
    activity_id: `reception.inbox.rejected-${deps.now()}-${held.checkpoint.checkpoint_id}`,
    timestamp: deps.now(),
    action: ACTION_REJECTED,
    target: held.checkpoint.checkpoint_id,
    detail: reason !== undefined ? `rejected: ${reason}` : 'rejected',
    reserve: true,
  });

  // Release the hold via the EXISTING deny path — answer `'deny'`.
  // D-210 Phase C — an ask-less hold denies through the resumer directly
  // (`denyRun` writes the policy-deny audit row + moves the paused anchor
  // to `failed`, exactly as the answer path's deny leg does). Without this
  // a notify-mode reject would record the dismissal in the subview while
  // leaving the run awaiting approval forever.
  const ask_id = held.anchor.ask_id;
  const hasAsk = typeof ask_id === 'string' && ask_id.length > 0;
  if (typeof deps.submitAnswer === 'function' && hasAsk) {
    await deps.submitAnswer(ask_id as string, ASK_DENY);
  } else if (!hasAsk && typeof deps.releaseWithoutAsk === 'function') {
    await deps.releaseWithoutAsk(held.checkpoint, { kind: 'deny' });
  } else {
    await deps.auditLog.logActivity({
      activity_id: `reception.inbox.rejected-not-configured-${deps.now()}-${held.checkpoint.checkpoint_id}`,
      timestamp: deps.now(),
      action: ACTION_REJECTED,
      target: held.checkpoint.checkpoint_id,
      detail: 'rejected locally; deny not delivered: not_configured',
      reserve: true,
    });
  }

  deps.broadcast({ kind: 'reception_inbox', op: 'rejected', hold_id: held.checkpoint.checkpoint_id });

  return { hold_id: held.checkpoint.checkpoint_id, status: 'dismissed' };
};

// ────────────────────────────────────────────────────────────────
// D10 — auto_cleanup_days purge
// ────────────────────────────────────────────────────────────────

/** D10 — purge subview items (+ their sealed visitor PII) older than
 *  `auto_cleanup_days`. `decline → delete` is just `auto_cleanup_days =
 *  0` (a 0-day cutoff is `now`, purging everything dismissed before this
 *  instant). Returns the count purged. Intended to run on the
 *  housekeeping cadence; exposed here so the integration step wires it. */
export const purgeReceptionInboxSubview = (
  deps: ReceptionInboxDeps,
  auto_cleanup_days: number,
): number => {
  const days = Math.max(0, auto_cleanup_days);
  const cutoff = deps.now() - days * 24 * 60 * 60 * 1000;
  return deps.subviewStore.purgeOlderThan(cutoff);
};

// ────────────────────────────────────────────────────────────────
// I-4 — the "N waiting" inbox ping (D-158)
// ────────────────────────────────────────────────────────────────

/** Raise an `ask` — the `NotificationBlock.ask` shape (D-158 N.2). The
 *  ping injects this; production wires the block's `ask`, tests inject a
 *  recording stub. The ping is a REGULAR ask with a `link_url` → inbox
 *  (D-158) — no new substrate (it is the ping, never the carrier; the
 *  inbox itself is the review surface). */
export type RaiseInboxPingAsk = (
  message: { title?: string; text: string; link_url?: string },
  options: ReadonlyArray<{ id: string; label: string }>,
  handler: { kind: string; payload: Record<string, unknown> },
) => Promise<{ ask_id: string }>;

/** D-173 A.10 / I-4 — the "N waiting → inbox" ping. Counts the open
 *  held ops and, when ≥ 1, raises a single informational ask linking to
 *  the inbox. A no-op when nothing is waiting. The `link_url` lands the
 *  user on the inbox; the `dismiss` option is the only affordance (the
 *  real review happens in the inbox, not the ping — D-158 N.1). Returns
 *  the raised `ask_id` (or `null` when nothing waiting). */
export const pingReceptionInbox = async (
  deps: ReceptionInboxDeps,
  raiseAsk: RaiseInboxPingAsk,
  inbox_link_url: string,
): Promise<{ ask_id: string } | null> => {
  const held = await queryReceptionInboxHeldOps(deps);
  const count = held.length;
  if (count === 0) return null;
  return raiseAsk(
    {
      title: 'Reception inbox',
      text:
        count === 1
          ? '1 incoming request is waiting for your review.'
          : `${count} incoming requests are waiting for your review.`,
      link_url: inbox_link_url,
    },
    [{ id: 'dismiss', label: 'Open inbox' }],
    { kind: 'reception.inbox.ping', payload: { count } },
  );
};

// ────────────────────────────────────────────────────────────────
// Slice factory (ready-to-wire; boot wiring DEFERRED to integration)
// ────────────────────────────────────────────────────────────────

/** The `reception.inbox.*` handler map, keyed by method name. Returned
 *  by `makeReceptionInboxHandlers` for the deferred integration step to
 *  compose into the server rpc registry (alongside folding the three
 *  method specs into `ServerRpcRegistry` + `SERVER_RPC_METHOD_SET`).
 *  `Ctx` is the dispatcher's per-call client (`WsClient`-shaped — only
 *  `instance_id` is read here). */
export interface ReceptionInboxHandlers<Ctx extends { instance_id?: string | null }> {
  'reception.inbox.list': (
    args: ReceptionInboxListInput | undefined,
    client: Ctx | undefined,
  ) => Promise<ReceptionInboxListResult>;
  'reception.inbox.approve': (
    args: ReceptionInboxApproveInput,
    client: Ctx | undefined,
  ) => Promise<ReceptionInboxApproveResult>;
  'reception.inbox.reject': (
    args: ReceptionInboxRejectInput,
    client: Ctx | undefined,
  ) => Promise<ReceptionInboxRejectResult>;
}

/** Build the `reception.inbox.*` handler map. Returns `undefined` when
 *  deps are absent (the integration step drops the slice — matching the
 *  reception / history slice posture). Boot-wiring is DEFERRED: this
 *  factory does NOT touch `wire-reception-substrate.ts`; the integration
 *  step calls it once `receptionInboxDeps` (incl. Lane P's
 *  `resolveArgEditSchema`) is composed. */
export const makeReceptionInboxHandlers = <
  Ctx extends { instance_id?: string | null },
>(
  deps: ReceptionInboxDeps | undefined,
):
  | {
      methods: ReadonlyArray<keyof ReceptionInboxHandlers<Ctx>>;
      handlers: ReceptionInboxHandlers<Ctx>;
    }
  | undefined => {
  if (!deps) return undefined;
  const toCaller = (client: Ctx | undefined) =>
    client ? { instance_id: client.instance_id ?? null } : undefined;
  return {
    methods: ['reception.inbox.list', 'reception.inbox.approve', 'reception.inbox.reject'],
    handlers: {
      'reception.inbox.list': (args, client) =>
        handleReceptionInboxList(deps, args, toCaller(client)),
      'reception.inbox.approve': (args, client) =>
        handleReceptionInboxApprove(deps, args, toCaller(client)),
      'reception.inbox.reject': (args, client) =>
        handleReceptionInboxReject(deps, args, toCaller(client)),
    },
  };
};
