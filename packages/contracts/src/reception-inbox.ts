/** D-173 N.1 / N.2 — Reception Inbox contracts (the review-then-approve
 *  inbox over held `approval_required` operations).
 *
 *  D-173 reframes the D-149 reception "engine half" from auto-materialize
 *  to review-by-default. An incoming visitor request fires a reactive
 *  trigger that invokes an operation marked `approval_required`, so the
 *  D-157 Gateway gate HOLDS the call pending (a `Checkpoint` is minted,
 *  the run anchor carries `'awaiting_approval'`). The Reception Inbox is
 *  the rich view over those held operations, where the user approves
 *  (editing the operation's args first) or rejects.
 *
 *  No new storage table — the inbox is a *view* over the gate's held
 *  operations (filtered to incoming-trigger origin) joined to the source
 *  record (N.1). This file is contracts-only: the `InboxItem` shape +
 *  the `reception.inbox.*` rpc request/result types + the closed error
 *  set. The query / handler / the `checkpoint.arg_overrides` narrow
 *  writer (the N.5 security boundary) live in `recued-server`
 *  (`reception-inbox-handler.ts`).
 *
 *  The editable-args contract this surface drives — `Checkpoint.
 *  arg_overrides` (the boundary), the engine resume merge, and the
 *  `approved_target` recompute — already exists from D-157 N.5 (Round
 *  1). This surface is the ONLY writer of `arg_overrides` (N.5 MUST):
 *  `reception.inbox.approve` validates the user's `edits` against the
 *  operation's `ArgEditSchema` allowlist, writes them to the checkpoint,
 *  and releases the held op through the EXISTING preflight resume path.
 *
 *  Spec: D-173 § N.1 / N.2 / N.5 / N.6 / D10. */

import type { ArgEditField } from './bulk-pack.js';
import {
  isSourceTopTierKind,
  type SourceTopTierKind,
} from './source-primitive.js';
import type { BookingHistorySummary } from './work-entities.js';

/** Reception review destinations include every Source-routed top-tier kind
 * plus the canonical `form_response` terminal, which deliberately creates no
 * second entity after approval. */
export type ReceptionInboxTopTierKind = SourceTopTierKind | 'form_response';

export const isReceptionInboxTopTierKind = (
  value: unknown,
): value is ReceptionInboxTopTierKind =>
  value === 'form_response' || isSourceTopTierKind(value);

// ────────────────────────────────────────────────────────────────
// N.6 — ArgEditSchema (the edit-form contract / allowlist)
// ────────────────────────────────────────────────────────────────

/** D-173 N.6 — the resolved edit-form contract for one held operation:
 *  the **allowlist** of args the inbox lets the user edit at approval
 *  time. ONLY the args named here are editable; every other authored /
 *  prefilled arg is immutable (the projection-prefilled value stands).
 *
 *  This is the shared seam between the inbox (`reception.inbox.approve`
 *  validates `edits` against this allowlist before writing them to the
 *  checkpoint) and the resolver Lane (`resolveArgEditSchema`, which
 *  projects `editable_args` ∩ `request_schema` ∩ the materialize
 *  target's entity-field types/privacy into this shape). The element
 *  shape `ArgEditField` is the D-170 operation-family `editable_args`
 *  field (already in `@recued/contracts`); `ArgEditSchema` is the
 *  resolved wrapper.
 *
 *  Security note (N.5 MUST). The allowlist is load-bearing for the
 *  editable-args boundary: `reception.inbox.approve` REJECTS any edit
 *  key absent from `fields` BEFORE writing `checkpoint.arg_overrides`,
 *  so the engine resume merge (which merges `arg_overrides` wholesale)
 *  never sees a non-allowlisted override. The allowlist gate is upstream
 *  of the merge, not in the engine. */
export interface ArgEditSchema {
  /** The editable-arg allowlist. Empty ⇒ the operation exposes no
   *  editable args (approve runs the held op exactly as prefilled; any
   *  non-empty `edits` is rejected). */
  fields: ArgEditField[];
}

// ────────────────────────────────────────────────────────────────
// N.1 — InboxItem (a held approval-required operation)
// ────────────────────────────────────────────────────────────────

/** The reception kind an inbox item originated from, or `'vendor'` for
 *  an external-venue (D8) platform-reference origin. Mirrors the D-149
 *  reception endpoint kinds + the vendor sentinel. The inbox shows ONLY
 *  reception-incoming-triggered holds (N.1) — never arbitrary gated ops
 *  — so this discriminator is recovered from the held op's provenance
 *  (the incoming-trigger origin the gate recorded), not authored. */
export type ReceptionInboxSourceKind =
  | 'reception_page'
  | 'scheduling_link'
  | 'intake_form'
  | 'drop_link'
  | 'approval_link'
  | 'status_link'
  | 'vendor';

/** Attachment scan-status (D-172 N.1). A scanner pack (ClamAV / Windows Defender,
 *  D-173 P5 part B) writes `clean` / `flagged`; absent one, drops stay `unscanned`.
 *  The inbox `approve` gate is ADVISORY (N.2): `clean` passes silently; `pending`
 *  is a brief self-clearing hold (a scan is mid-flight, not acknowledgeable);
 *  `unscanned` (not yet scanned) and `flagged` are refused only until the admin
 *  passes `acknowledge_attachment_risk` (warn-and-confirm, not a hard block). */
export type ReceptionInboxScanStatus = 'pending' | 'clean' | 'flagged' | 'unscanned';

/** Lifecycle of an inbox item. `pending` / `requires_review` are the
 *  open view; `dismissed` / `expired` are the subview (D10 — reject →
 *  dismissed; a past-slot booking → expired). */
export type ReceptionInboxStatus = 'pending' | 'requires_review' | 'dismissed' | 'expired';

/** D-173 N.1 — one inbox item = one held `approval_required` operation,
 *  rendered with the operation's prefilled args + the source record for
 *  context. NOT a stored row — the inbox reads the gate's held
 *  operations (filtered to incoming-trigger origin) joined to the source
 *  record. */
export interface InboxItem {
  /** The D-157 gate hold this item represents — the held run's
   *  `Checkpoint.checkpoint_id`. The stable handle `reception.inbox.
   *  {approve,reject}` address the hold by. */
  hold_id: string;
  /** `<ingredient>.<op>` — the projection / write-back operation the
   *  gate is holding. Drives the `ArgEditSchema` resolution (the edit
   *  form) + the audit attribution. */
  operation_id: string;
  /** Destination class → inbox grouping (D2) + Source routing (D5). */
  top_tier_kind: ReceptionInboxTopTierKind;
  /** Where the held op came from — the incoming-trigger origin the gate
   *  recorded. `record_ref` points at the source record (the pending
   *  visitor submission / booking / drop) for the join + open-on-demand
   *  PII reveal. */
  source: {
    kind: ReceptionInboxSourceKind;
    endpoint_id?: string;
    vendor?: string;
    record_ref: string;
  };
  /** The operation's prefilled args (by the projection), editable at
   *  approval per the `arg_schema` allowlist (D4). Concrete values —
   *  what the held op will dispatch with absent any edit. */
  args: Record<string, unknown>;
  /** The edit-form allowlist (N.6) — which `args` keys the user may
   *  edit + their edit-facets. Resolved from the core-pack composition's
   *  `editable_args` (D4). An empty `fields` ⇒ approve-as-prefilled. */
  arg_schema: ArgEditSchema;
  /** The card preview — REDACTED (sealed visitor PII stays sealed until
   *  the user opens the item; I-3). Never carries un-revealed PII. */
  preview: {
    title: string;
    subtitle?: string;
    /** Unix-ms — e.g. a booking's proposed slot time. */
    when?: number;
  };
  /** Present iff the held op carries a drop / upload_doc attachment
   *  (D-172 N.1). `approve` gates on `scan_status` (N.2). */
  attachment?: {
    file_id: string;
    filename: string;
    mime_type: string;
    size: number;
    scan_status: ReceptionInboxScanStatus;
  };
  /** Human-readable summary of what approve will do (e.g. "Create a
   *  commitment", "Add a contact"). */
  proposed_action: string;
  /** D-173 D7 — what else is already on the owner's calendar at this item's
   *  proposed time. Present only for time-framed items (a booking); absent for
   *  every other kind, and absent when the calendar cannot be reached.
   *
   *  **This is a safety mechanism, not a decoration.** Since the overlap
   *  refusal was retired (2026-07-16), the substrate no longer decides how many
   *  bookings may share an instant — capacity is a judgment only the owner can
   *  make (a 100-table restaurant holds 100 at once). The machine counts; the
   *  owner decides. This field is the count they decide on, and D7's
   *  *"confirmed at approval"* is the decision.
   *
   *  Structured, never a pre-rendered string, and never a bare number: a count
   *  is a CLAIM about the world, and a claim built on a partial read must be
   *  able to say so. `unreadable_calendars > 0` ⇒ `count` is a FLOOR, and the
   *  renderer must not present it as a total — an owner who reads "2" and acts
   *  on it when the truth is "2 that I could see" was misled by a check that
   *  looked like assurance. Absent ⇒ render nothing; never render 0 for
   *  "unknown". */
  calendar_overlap?: {
    /** Non-cancelled events overlapping `[start, end)` of the proposed slot,
     *  across every readable calendar. EXCLUDES this item itself — it has not
     *  been approved, so it is not on the calendar yet. */
    count: number;
    /** The window counted, echoed so the surface can name the span it is
     *  talking about ("12:00–14:00") rather than restating the slot and hoping
     *  they match. */
    window_start: number;
    window_end: number;
    /** How many calendars were successfully read. */
    calendars_read: number;
    /** How many could NOT be read. `> 0` ⇒ `count` is a floor; the surface must
     *  disclose the gap rather than imply completeness. */
    unreadable_calendars: number;
  };
  /** Owner-only prior completed/no-show history for the opaque contact linked
   *  to a scheduling request. Never projected onto visitor/public surfaces. */
  booking_history?: BookingHistorySummary;
  /** How many calls approving this item runs, when that is more than one: the
   *  run paused a loop (`foreach`) at this item, and one approval runs it and
   *  every remaining item of the step on the same account. Absent ⇒ one call.
   *
   *  A count, never a string, and it says whether it is exact. `exact: false` is
   *  an UPPER BOUND — the items could not be listed, and one aimed at another
   *  account is asked about on its own — so the surface words it "up to", as the
   *  hold's ask does. Such an item offers no edits (`arg_schema.fields` is
   *  empty): an edit would be applied to every one of the items. */
  approval_covers?: { count: number; exact: boolean };
  /** D-177 N.14 — the "allow for this form" offer AS RAISED on the hold's
   *  ask (the `(reception, anonymous)` seed's bounds), read off the real
   *  ask row — a rendering hint for the "Approve & allow" affordance.
   *  Absent ⇒ no affordance (unseeded cell / partially-composed boot /
   *  the ask never carried the option). The approve rpc RE-VERIFIES at
   *  the act site regardless — this field never authorizes anything. */
  allow_offer?: { ttl_ms: number; max_uses: number };
  /** Lifecycle — `pending` / `requires_review` are open; `dismissed` /
   *  `expired` are the subview (D10). */
  status: ReceptionInboxStatus;
}

// ────────────────────────────────────────────────────────────────
// N.2 — reception.inbox.* rpc (closed set)
// ────────────────────────────────────────────────────────────────

/** Which inbox slice `reception.inbox.list` returns — `'open'`
 *  (`pending` / `requires_review`, default) or `'subview'`
 *  (`dismissed` / `expired`, D10). */
export type ReceptionInboxView = 'open' | 'subview';

/** `reception.inbox.list` request. */
export interface ReceptionInboxListInput {
  /** Which slice — defaults to `'open'`. */
  view?: ReceptionInboxView;
  /** Optional filter by originating reception kind. */
  source?: ReceptionInboxSourceKind;
  /** Opaque forward cursor returned by a prior page. */
  cursor?: string;
  /** Page size cap. The handler clamps to a sane ceiling. */
  limit?: number;
}

/** `reception.inbox.list` result — the projected items + an optional
 *  next-page cursor. */
export interface ReceptionInboxListResult {
  items: InboxItem[];
  cursor?: string;
}

/** `reception.inbox.approve` request. Validates `edits` against the
 *  item's `arg_schema` allowlist (N.6) → writes them to
 *  `checkpoint.arg_overrides` (the N.5 boundary) → recomputes
 *  `approved_target` from the merged args → releases the held op through
 *  the EXISTING preflight resume path. */
export interface ReceptionInboxApproveInput {
  /** The hold to approve — an `InboxItem.hold_id`. */
  hold_id: string;
  /** Optional arg edits. Every key MUST be in the item's `arg_schema`
   *  allowlist (a non-allowlisted key is REJECTED before any write). */
  edits?: Record<string, unknown>;
  /** D-172 Q2 — the admin's explicit acknowledgement to attach an attachment
   *  whose scan is not `clean`: `unscanned` (no scanner wired) or `flagged`
   *  (the scanner flagged it). The scan gate is ADVISORY — it warns + requires
   *  this ack, never a hard block (the human reviewing the drop IS the gate).
   *  Ignored for `clean` items; a `pending` item (scan mid-flight) is briefly
   *  held regardless (not acknowledgeable — the verdict is imminent). */
  acknowledge_attachment_risk?: boolean;
  /** D-177 N.14 — "Approve & allow for this form": answer the hold's ask
   *  with `allow_session` instead of `approve`, minting the door-bound
   *  session grant that absorbs this form's subsequent fires until its
   *  TTL / uses run out. REFUSED when combined with non-empty `edits` (an
   *  edited approval is proof the pipe's output wasn't right — it earns
   *  no standing trust) and when the hold's ask carries no offer
   *  (re-verified at the act site; `submitAnswer` would otherwise
   *  silently no-op an un-offered option). */
  allow?: boolean;
}

/** `reception.inbox.approve` result. */
export interface ReceptionInboxApproveResult {
  /** Echoes the approved hold. */
  hold_id: string;
  /** `true` only once the held op was released through the resume path. */
  released: boolean;
  /** Why the held op could not be released. Present only when
   *  `released` is `false`. */
  reason?: 'not_configured';
  /** The arg keys the user edited (allowlist-validated) — the changed
   *  set the D-120 "approved with edits" audit row recorded. Empty when
   *  approve carried no edits or release was not configured. */
  edited_keys: string[];
}

/** `reception.inbox.reject` request. Moves the item to the subview
 *  (status `dismissed`) + frees any slot hold (D7). */
export interface ReceptionInboxRejectInput {
  /** The hold to reject — an `InboxItem.hold_id`. */
  hold_id: string;
  /** Optional free-text reason recorded on the audit row. */
  reason?: string;
}

/** `reception.inbox.reject` result. */
export interface ReceptionInboxRejectResult {
  hold_id: string;
  /** `'dismissed'` — the subview status the item moved to (D10). */
  status: 'dismissed';
}

// ────────────────────────────────────────────────────────────────
// Closed error set
// ────────────────────────────────────────────────────────────────

/** D-173 N.2 — the closed `reception.inbox.*` rpc error set. */
export type ReceptionInboxRpcErrorCode =
  /** Caller is not a paired admin client (D-121). */
  | 'permission_denied'
  /** The `hold_id` resolves to no held operation (consumed / never
   *  existed / not a reception-incoming hold). */
  | 'hold_not_found'
  /** An `edits` key is absent from the item's `ArgEditSchema` allowlist
   *  (N.6) — the editable-args boundary rejection. */
  | 'edit_not_allowed'
  /** D-210 step 2c — the key IS editable, but the VALUE does not match the field's declared
   *  shape (`type`, `required`, `validation.min` / `max` / `pattern`).
   *
   *  ⛔ DISTINCT from `edit_not_allowed` on purpose. That one is a CAPABILITY answer — "you
   *  may not edit this key". This is a DATA FACT — "that value is the wrong shape". Folding
   *  them together would tell an owner they lack permission when they made a typo, which is
   *  the wrong sentence AND the wrong next action. */
  | 'edit_invalid'
  /** The held op's attachment is being scanned (`pending`) — approve is held
   *  briefly until the verdict lands (self-clearing; N.2 / D-172 Q2). */
  | 'attachment_scan_pending'
  /** The held op's attachment has not been virus-scanned (`unscanned` — no
   *  scanner is wired) and `acknowledge_attachment_risk` was not supplied: the
   *  advisory warn-and-confirm gate (N.2 / D-172 Q2). */
  | 'attachment_unscanned'
  /** The held op carries a `flagged` attachment and `acknowledge_attachment_risk`
   *  was not supplied (N.2 / D-172 Q2). */
  | 'attachment_flagged'
  /** Malformed request shape. */
  | 'bad_request';

/** Compile-time exhaustive keying of the union above. `ReadonlyArray<Union>`
 *  happily accepts a SUBSET, so a hand-maintained list rots silently — and did:
 *  `edit_invalid` (D-210 step 2c) was in the union and had authored webclient
 *  copy, but was missing from the list, so `isReceptionInboxRpcErrorCode`
 *  rejected it and the surface fell through to the raw server message. A
 *  `Record` refuses to compile with a member missing; the list derives from it,
 *  so the two cannot disagree again. */
const RECEPTION_INBOX_RPC_ERROR_CODE_MAP: Readonly<
  Record<ReceptionInboxRpcErrorCode, true>
> = {
  permission_denied: true,
  hold_not_found: true,
  edit_not_allowed: true,
  edit_invalid: true,
  attachment_scan_pending: true,
  attachment_unscanned: true,
  attachment_flagged: true,
  bad_request: true,
};

export const RECEPTION_INBOX_RPC_ERROR_CODES: ReadonlyArray<ReceptionInboxRpcErrorCode> =
  Object.keys(RECEPTION_INBOX_RPC_ERROR_CODE_MAP) as ReadonlyArray<ReceptionInboxRpcErrorCode>;

export const RECEPTION_INBOX_RPC_ERROR_CODE_SET: ReadonlySet<ReceptionInboxRpcErrorCode> =
  new Set(RECEPTION_INBOX_RPC_ERROR_CODES);

export const isReceptionInboxRpcErrorCode = (
  value: unknown,
): value is ReceptionInboxRpcErrorCode =>
  typeof value === 'string'
  && RECEPTION_INBOX_RPC_ERROR_CODE_SET.has(value as ReceptionInboxRpcErrorCode);

// ────────────────────────────────────────────────────────────────
// Local rpc-registry fragment (the slice's typed method map)
// ────────────────────────────────────────────────────────────────

/** The `reception.inbox.*` method map — an `RpcRegistry`-shaped fragment
 *  the `recued-server` inbox handler slice types against directly.
 *
 *  Why a local fragment, not entries on the global `ServerRpcRegistry`:
 *  the inbox is wired into server boot by a DEFERRED consolidator
 *  integration step (D-173 P2/P3 ship the substrate + handlers
 *  ready-to-wire, not the boot wiring). Keeping the typed method map
 *  local lets the slice compile + test fully now; the integration step
 *  folds these three entries into `ServerRpcRegistry` +
 *  `SERVER_RPC_METHOD_SET` (so the dispatcher routes them) at wire time.
 *  Reserved for local-UI only — `reception.` is in
 *  `MCP_RESERVED_RPC_PREFIXES`. */
export interface ReceptionInboxRpcRegistry {
  'reception.inbox.list': {
    request: ReceptionInboxListInput | undefined;
    response: ReceptionInboxListResult;
  };
  'reception.inbox.approve': {
    request: ReceptionInboxApproveInput;
    response: ReceptionInboxApproveResult;
  };
  'reception.inbox.reject': {
    request: ReceptionInboxRejectInput;
    response: ReceptionInboxRejectResult;
  };
}

/** The three method names, for the slice's `methods` tuple + the
 *  integration step's `ServerRpcRegistry` / `SERVER_RPC_METHOD_SET`
 *  fold. */
export const RECEPTION_INBOX_RPC_METHODS = [
  'reception.inbox.list',
  'reception.inbox.approve',
  'reception.inbox.reject',
] as const satisfies ReadonlyArray<keyof ReceptionInboxRpcRegistry>;
