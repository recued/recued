/** D-138 Phase 5 — Upstream-merge outbox substrate.
 *
 *  Upstream merge is a destructive vendor mutation (HubSpot Merge API
 *  / Salesforce SOAP `merge()`) chained with a local-side merge. Two
 *  writes against two systems cannot be wrapped in a single
 *  transaction; the outbox row carries a state machine across them
 *  with idempotent retry on the local step + crash-recovery sweep on
 *  server boot.
 *
 *  Spec: `docs/d-138-spec.md` § A.7 + § Phase 5. */

import type { ApprovalRequest } from './approval.js';

// ────────────────────────────────────────────────────────────────
// Vendor surface
// ────────────────────────────────────────────────────────────────

/** Vendors that expose an upstream-merge API at v1. The closed list
 *  drives the rpc handler's dispatch + the UI's vendor picker (the
 *  modal labels + the per-vendor wording). Future vendors widen here. */
export const UPSTREAM_MERGE_VENDORS = ['hubspot', 'salesforce'] as const;
export type UpstreamMergeVendor = (typeof UPSTREAM_MERGE_VENDORS)[number];

/** Vendor object types per vendor that carry an upstream-merge
 *  surface. HubSpot exposes Merge for `contacts` (and others — v1 is
 *  contacts only since D-138 is contact-substrate-bound). Salesforce
 *  exposes SOAP `merge()` for `lead` + `account` only — `contact` is
 *  NOT exposed in the standard API and routes through the degraded
 *  path. */
export type UpstreamMergeObjectType =
  | 'hubspot:contact'
  | 'salesforce:lead'
  | 'salesforce:account'
  | 'salesforce:contact'; // degraded — explained in modal; never dispatches

/** Object types that have a callable vendor-merge API. The
 *  `salesforce:contact` form intentionally falls outside this set —
 *  the rpc rejects it with a degraded-path message rather than
 *  pretending to dispatch. */
export const UPSTREAM_MERGE_DISPATCHABLE_OBJECT_TYPES: ReadonlySet<UpstreamMergeObjectType> =
  new Set<UpstreamMergeObjectType>([
    'hubspot:contact',
    'salesforce:lead',
    'salesforce:account',
  ]);

/** Returns true iff this object type has a callable vendor-merge API
 *  (v1 closed list). Used by the rpc handler to short-circuit
 *  Salesforce contact merges into the degraded-path response. */
export const isUpstreamMergeDispatchable = (
  object_type: UpstreamMergeObjectType,
): boolean => UPSTREAM_MERGE_DISPATCHABLE_OBJECT_TYPES.has(object_type);

// ────────────────────────────────────────────────────────────────
// State machine
// ────────────────────────────────────────────────────────────────

/** Outbox row state. The state machine lives on the row; transitions
 *  are durable + serialized through the storage layer. Terminal
 *  states (`local_merge_committed` / `vendor_merge_failed`) never
 *  rewind — re-attempting a failed merge requires a fresh outbox row. */
export type UpstreamMergeState =
  | 'pending_vendor_merge'         // approved but vendor call not yet attempted
  | 'vendor_merge_in_flight'       // vendor api call active; retry guard armed
  | 'vendor_merge_succeeded'       // vendor responded 200; local step pending
  | 'vendor_merge_local_pending'   // local step started; retry zone (idempotent)
  | 'local_merge_committed'        // terminal SUCCESS
  | 'vendor_merge_failed';         // terminal FAILURE (no auto-retry)

/** Closed enumeration — used for typed iteration + ratchet tests. */
export const UPSTREAM_MERGE_STATES: readonly UpstreamMergeState[] = [
  'pending_vendor_merge',
  'vendor_merge_in_flight',
  'vendor_merge_succeeded',
  'vendor_merge_local_pending',
  'local_merge_committed',
  'vendor_merge_failed',
];

/** Terminal state predicate — the driver halts further work when the
 *  row reaches one of these. */
export const isUpstreamMergeTerminal = (state: UpstreamMergeState): boolean =>
  state === 'local_merge_committed' || state === 'vendor_merge_failed';

/** States the boot-recovery sweep must replay. Mid-flight vendor calls
 *  (`vendor_merge_in_flight`) are also picked up — the idempotency key
 *  guarantees re-running the call yields the same upstream outcome
 *  (vendor merges are idempotent on the same `(survivor_id, loser_id)`
 *  pair). `pending_vendor_merge` is included only when paired with the
 *  per-row `same_user_auto_approve` flag (P5 fold-back F3); the store's
 *  `listRecoverable` applies the additional filter so non-auto-approved
 *  rows wait for their multi-surface approval. */
export const isUpstreamMergeRecoverable = (state: UpstreamMergeState): boolean =>
  state === 'pending_vendor_merge' ||
  state === 'vendor_merge_in_flight' ||
  state === 'vendor_merge_succeeded' ||
  state === 'vendor_merge_local_pending';

/** Driver event — the discrete signals that move the state machine
 *  forward. The reducer is exhaustive over the (state, event) cross-
 *  product so unsupported transitions surface as compile-time errors. */
export type UpstreamMergeEvent =
  | { type: 'approval_granted' }
  | { type: 'vendor_call_started' }
  | { type: 'vendor_call_succeeded' }
  | { type: 'vendor_call_failed_retryable'; attempt: number }
  | { type: 'vendor_call_failed_terminal'; reason: string }
  | { type: 'local_step_started' }
  | { type: 'local_step_committed' }
  /** D-138 P5 fold-back (Codex F5) — local-step failure after vendor
   *  success. The reducer maps `vendor_merge_local_pending →
   *  vendor_merge_failed`. Used for survivor-missing-locally + any
   *  future "vendor merged but local commit blocked" path. */
  | { type: 'local_step_failed'; reason: string };

/** Pure reducer. Returns the next state OR throws on invalid
 *  transitions — the storage layer + driver call this and rely on the
 *  throw for invariant enforcement (no silent state corruption). */
export const nextUpstreamMergeState = (
  current: UpstreamMergeState,
  event: UpstreamMergeEvent,
): UpstreamMergeState => {
  switch (event.type) {
    case 'approval_granted':
      // Idempotent re-fire: callers may grant approval more than once
      // (e.g. the user clicks "Confirm" and the rpc is replayed). We
      // accept it from `pending_vendor_merge` (no-op) only.
      if (current === 'pending_vendor_merge') return 'pending_vendor_merge';
      throw new Error(`upstream_merge_invalid_transition: approval_granted from ${current}`);
    case 'vendor_call_started':
      if (current === 'pending_vendor_merge') return 'vendor_merge_in_flight';
      // Boot recovery may re-enter `vendor_merge_in_flight` directly;
      // accept it as idempotent.
      if (current === 'vendor_merge_in_flight') return 'vendor_merge_in_flight';
      throw new Error(`upstream_merge_invalid_transition: vendor_call_started from ${current}`);
    case 'vendor_call_succeeded':
      if (current === 'vendor_merge_in_flight') return 'vendor_merge_succeeded';
      // Boot recovery may find the row already at `vendor_merge_-
      // succeeded` (we crashed between transition write and local
      // step start) — accept idempotently.
      if (current === 'vendor_merge_succeeded') return 'vendor_merge_succeeded';
      throw new Error(`upstream_merge_invalid_transition: vendor_call_succeeded from ${current}`);
    case 'vendor_call_failed_retryable':
      // Retryable failure stays in_flight — the driver bumps `attempts`
      // + waits for the backoff. If `attempts` reaches the budget the
      // driver fires a terminal event instead.
      if (current === 'vendor_merge_in_flight') return 'vendor_merge_in_flight';
      throw new Error(`upstream_merge_invalid_transition: vendor_call_failed_retryable from ${current}`);
    case 'vendor_call_failed_terminal':
      if (current === 'vendor_merge_in_flight') return 'vendor_merge_failed';
      // Allow direct transition from pending_vendor_merge for synchronous
      // vendor errors that exhaust the budget on first call shape errors
      // (e.g. invalid pair before any retry attempt).
      if (current === 'pending_vendor_merge') return 'vendor_merge_failed';
      throw new Error(`upstream_merge_invalid_transition: vendor_call_failed_terminal from ${current}`);
    case 'local_step_started':
      if (current === 'vendor_merge_succeeded') return 'vendor_merge_local_pending';
      // Boot recovery may re-enter `vendor_merge_local_pending` — accept.
      if (current === 'vendor_merge_local_pending') return 'vendor_merge_local_pending';
      throw new Error(`upstream_merge_invalid_transition: local_step_started from ${current}`);
    case 'local_step_committed':
      if (current === 'vendor_merge_local_pending') return 'local_merge_committed';
      // Idempotent re-fire — replay produces the same terminal state.
      if (current === 'local_merge_committed') return 'local_merge_committed';
      throw new Error(`upstream_merge_invalid_transition: local_step_committed from ${current}`);
    case 'local_step_failed':
      if (current === 'vendor_merge_local_pending') return 'vendor_merge_failed';
      // Idempotent re-fire — replay stays terminal.
      if (current === 'vendor_merge_failed') return 'vendor_merge_failed';
      throw new Error(`upstream_merge_invalid_transition: local_step_failed from ${current}`);
  }
};

// ────────────────────────────────────────────────────────────────
// Retry budget + backoff
// ────────────────────────────────────────────────────────────────

/** Per-spec § A.7 § Phase 5 — vendor-call attempt budget before the
 *  row settles into `vendor_merge_failed`. First attempt counts as 1;
 *  the driver fires `vendor_call_failed_terminal` once `attempts >=
 *  UPSTREAM_MERGE_RETRY_BUDGET`. */
export const UPSTREAM_MERGE_RETRY_BUDGET = 3;

/** Exponential backoff base in ms. Delay between attempt N and N+1 is
 *  `UPSTREAM_MERGE_RETRY_BACKOFF_BASE_MS * 2^N` (1s, 2s, 4s for the
 *  three-attempt budget). Bounded at 60s for paranoia. */
export const UPSTREAM_MERGE_RETRY_BACKOFF_BASE_MS = 1_000;
export const UPSTREAM_MERGE_RETRY_BACKOFF_CAP_MS = 60_000;

/** Pure helper — computes the backoff delay before attempt `attemptNumber`
 *  (1-indexed). Returns 0 for the first attempt (no wait). */
export const upstreamMergeBackoffMs = (attemptNumber: number): number => {
  if (attemptNumber <= 1) return 0;
  const exponent = Math.max(0, attemptNumber - 2);
  const raw = UPSTREAM_MERGE_RETRY_BACKOFF_BASE_MS * 2 ** exponent;
  return Math.min(raw, UPSTREAM_MERGE_RETRY_BACKOFF_CAP_MS);
};

// ────────────────────────────────────────────────────────────────
// Idempotency key
// ────────────────────────────────────────────────────────────────

/** Inputs the idempotency key derives from. Re-running a vendor call
 *  with the same inputs MUST hit the same vendor record on the vendor
 *  side, so the key includes the survivor + loser platform-native ids
 *  in addition to the canonical `candidate_ids[]`. The vendor sees the
 *  key as a request idempotency hint where supported (HubSpot honors
 *  `Idempotency-Key` header on the merge endpoint; Salesforce SOAP
 *  surfaces it as a tracking id we log). */
export interface UpstreamMergeIdempotencyInput {
  vendor: UpstreamMergeVendor;
  object_type: UpstreamMergeObjectType;
  /** D-138 `contact_merge_candidate_queue` row ids — the user-visible
   *  candidate identifier(s). Stable across retries; re-running with
   *  the same set yields the same key. */
  candidate_ids: readonly string[];
  /** Canonical email of the survivor (Recued-side). */
  survivor_email: string;
  /** Vendor-side merge pairs. One entry per loser-vs-survivor on the
   *  vendor side. The vendor's own merge call shape varies (HubSpot
   *  takes both ids in body; Salesforce SOAP takes one master + many
   *  victims), but the key is wire-shape-independent. */
  vendor_pairs: readonly UpstreamMergeVendorPair[];
}

/** One survivor-vs-loser pair on the vendor side. The platform-native
 *  ids come from the loser/survivor `PlatformIdEntry` rows on the
 *  Recued canonical contacts. */
export interface UpstreamMergeVendorPair {
  /** Vendor-native id of the survivor record (the master). */
  survivor_platform_id: string;
  /** Vendor-native id of the loser record (the victim). */
  loser_platform_id: string;
}

/** Pure deterministic key derivation — sorts the inputs lexicographic-
 *  ally before hashing so callers don't have to. Re-running with the
 *  inputs in any order yields the same key. The hash is SHA256 over a
 *  canonical JSON shape to keep the algorithm portable across server +
 *  test runtimes; callers pass a `hashHex` shim (the backend wires the
 *  Node `crypto.createHash`; pure unit tests stub with a fixed-output
 *  fake). */
export const computeUpstreamMergeIdempotencyKey = (
  input: UpstreamMergeIdempotencyInput,
  hashHex: (canonical: string) => string,
): string => {
  const candidate_ids = [...input.candidate_ids].sort();
  const vendor_pairs = [...input.vendor_pairs]
    .map((p) => ({
      survivor_platform_id: p.survivor_platform_id,
      loser_platform_id: p.loser_platform_id,
    }))
    .sort((a, b) => {
      const c = a.survivor_platform_id.localeCompare(b.survivor_platform_id);
      if (c !== 0) return c;
      return a.loser_platform_id.localeCompare(b.loser_platform_id);
    });
  const canonical = JSON.stringify({
    v: 1,
    vendor: input.vendor,
    object_type: input.object_type,
    candidate_ids,
    survivor_email: input.survivor_email.toLowerCase(),
    vendor_pairs,
  });
  return hashHex(canonical);
};

// ────────────────────────────────────────────────────────────────
// Outbox row
// ────────────────────────────────────────────────────────────────

/** The persistent outbox row. Server-internal — no cross-cloud sync
 *  (D-097 / D-168). The D-113 approval row's existence is asserted via
 *  `approval_id`; the outbox row is the durable artifact that survives
 *  the in-memory approval store turning over on restart. */
export interface UpstreamMergeOutboxRow {
  /** ULID — primary key. */
  id: string;
  /** Linked D-113 approval id. The approval row may have already
   *  resolved (it's in-memory) but the linkage drives audit-trail
   *  joins via `data.timeline()`. */
  approval_id: string;
  vendor: UpstreamMergeVendor;
  object_type: UpstreamMergeObjectType;
  /** Recued-side candidate ids being resolved by this merge. */
  candidate_ids: string[];
  survivor_email: string;
  /** Loser canonical emails resolved at the moment of approval — frozen
   *  on the row so the local-step replay after vendor success uses the
   *  same set even if the queue has shifted. */
  loser_emails: string[];
  /** Vendor-side merge pairs. Frozen at approval time. */
  vendor_pairs: UpstreamMergeVendorPair[];
  /** SHA256 of the canonical idempotency input — UNIQUE column on the
   *  outbox table. Vendor calls dedupe on this key so duplicate
   *  approvals (rare; user double-clicks past the second-click guard)
   *  collapse onto one row. */
  idempotency_key: string;
  state: UpstreamMergeState;
  /** Vendor-call attempts so far. 0 before the first attempt; bumped
   *  to 1 on `vendor_call_started`. */
  attempts: number;
  last_attempt_at?: number;
  /** Pre-merge vendor record snapshot, captured at the
   *  `pending_vendor_merge → vendor_merge_in_flight` transition. The
   *  shape is vendor-specific; stored as opaque JSON for `data.timeline()`
   *  forensics. Optional — not every vendor exposes a pre-fetch
   *  (Salesforce SOAP merge() doesn't). */
  pre_merge_snapshot?: Record<string, unknown>;
  /** Last error captured — populated on retryable failures + on the
   *  terminal failure transition. Cleared on the next successful
   *  attempt. */
  last_error?: UpstreamMergeError;
  /** D-138 P5 fold-back — vendor connection_name resolved at request
   *  time. Frozen on the row so boot-recovery + retry can re-dispatch
   *  without depending on caller-supplied input. Recovery uses this as
   *  the connection target when present; fallback is the first
   *  enrolled connection of the row's vendor (legacy v1 path). */
  connection_name?: string;
  /** D-138 P5 fold-back — set when the request rpc treated the
   *  caller's second-click as the approval (v1 default). When `true`,
   *  the boot-recovery sweep replays `pending_vendor_merge` rows so
   *  same-user requests don't get stuck if the server crashed between
   *  insert and first dispatch. When `false`, the row stays in
   *  `pending_vendor_merge` waiting for a multi-surface approval
   *  through the gossip protocol. */
  same_user_auto_approve?: boolean;
  created_at: number;
  updated_at: number;
}

/** Structured error payload — the rpc + audit log surface this
 *  verbatim. */
export interface UpstreamMergeError {
  code: string;          // 'vendor_http_500' | 'vendor_auth_expired' | 'vendor_invalid_pair' | …
  message: string;       // Human-readable; user-visible in the failure banner.
  /** Vendor http status when applicable — null for SOAP / non-HTTP
   *  failures (Salesforce SOAP carries fault codes instead). */
  http_status?: number;
  /** Vendor-specific fault code or response body excerpt — kept short
   *  (≤ 512 chars) to avoid unbounded growth on the row. */
  vendor_detail?: string;
}

// ────────────────────────────────────────────────────────────────
// Approval-bridge surface
// ────────────────────────────────────────────────────────────────

/** Shape the upstream-merge handler emits when it surfaces an approval
 *  through the existing D-113 approval store. The handler creates the
 *  outbox row first (state `pending_vendor_merge`) and ALSO creates an
 *  in-memory approval pending — the user sees the same surface as any
 *  other admin-tier approval. The two are linked by `approval_id`. */
export interface UpstreamMergeApprovalBridge {
  /** D-138 P5 — synthetic approval request emitted to the in-memory
   *  store. The `recipe_id` is the synthetic value
   *  `'recued/upstream-merge'` so it's distinguishable in
   *  `approval.list` UI. */
  request: ApprovalRequest;
  /** Outbox row id — written so the resolver knows which outbox row
   *  to advance on `approve` / `reject`. */
  outbox_id: string;
}

// ────────────────────────────────────────────────────────────────
// rpc surface
// ────────────────────────────────────────────────────────────────

/** D-138 P5 — server-internal upstream-merge rpc namespaces. Listed
 *  here so the MCP-catalog ratchet references a single source of
 *  truth. The namespace is `upstream_merge.*` — local-UI only;
 *  excluded from the MCP catalog by the ratchet
 *  (`MCP_RESERVED_RPC_PREFIXES` in `mcp-tool-catalog.ts`). */
export const UPSTREAM_MERGE_RPC_METHODS = [
  'upstream_merge.describe',
  'upstream_merge.request',
  'upstream_merge.retry',
  'upstream_merge.discard',
  'upstream_merge.list',
] as const;
export type UpstreamMergeRpcMethod = (typeof UPSTREAM_MERGE_RPC_METHODS)[number];

/** `upstream_merge.describe` — render the modal preview. Reads vendor-
 *  side state via the connection adapter (loser + survivor records,
 *  per-field outcome) so the user can review before second-click
 *  confirm. Does NOT mutate. */
export interface UpstreamMergeDescribeRequest {
  vendor: UpstreamMergeVendor;
  object_type: UpstreamMergeObjectType;
  /** Vendor-native id of the survivor (master). */
  survivor_platform_id: string;
  /** Vendor-native id of one loser. v1 supports a single victim per
   *  describe call; the modal renders one preview per pair. */
  loser_platform_id: string;
  /** Connection name the vendor records belong to. */
  connection_name: string;
}

export interface UpstreamMergeDescribeResponse {
  /** Side-by-side per-field preview. Each entry: `{ field, survivor_value,
   *  loser_value, winner }`. `winner` is whichever value the vendor's
   *  documented merge rules will keep (HubSpot has these documented;
   *  Salesforce best-effort with `winner: 'unknown'`). */
  field_outcomes: UpstreamMergeFieldOutcome[];
  /** Vendor's documented merge semantics in plain text — e.g. *"HubSpot
   *  will absorb contact A into contact B. All deals, engagements, notes,
   *  custom properties from A move to B. A is deleted in HubSpot. This
   *  cannot be undone."* Surfaced verbatim in the modal. */
  vendor_semantics_summary: string;
  /** True when the object type has an upstream-merge API; false for
   *  the Salesforce contact degraded path. The modal renders a "merge
   *  locally only" explanation when false. */
  dispatchable: boolean;
  /** Per-record fetch timestamp — surfaced in the modal so the user
   *  knows the preview is `last_modified`-stamped. */
  survivor_last_modified?: string;
  loser_last_modified?: string;
}

/** Per-field outcome. `winner` indicates which value persists post-
 *  merge per vendor-documented merge rules. `'unknown'` is honest —
 *  Salesforce's per-field merge semantics aren't exposed as a stable
 *  API contract, so the modal labels these as "Salesforce decides at
 *  merge time" rather than guessing. */
export interface UpstreamMergeFieldOutcome {
  field: string;
  survivor_value: unknown;
  loser_value: unknown;
  winner: 'survivor' | 'loser' | 'unknown';
  /** Optional human-readable rationale — populated for HubSpot per the
   *  documented "most-recent value wins" rule. */
  reason?: string;
}

/** `upstream_merge.request` — second-click confirm fires this. Server
 *  creates the outbox row + the linked approval. The handler waits
 *  for the approval to resolve before driving the state machine; v1
 *  same-user flow auto-approves since the user is already at the UI
 *  (the second-click IS the approval). */
export interface UpstreamMergeRequestInput {
  vendor: UpstreamMergeVendor;
  object_type: UpstreamMergeObjectType;
  candidate_ids: string[];
  survivor_email: string;
  /** v1 closed list — the UI passes the resolved pairs verbatim. */
  vendor_pairs: UpstreamMergeVendorPair[];
  /** Connection name (drives the vendor merger client lookup). */
  connection_name: string;
  /** When `true`, the handler skips the gossip-protocol approval
   *  surface and treats the request itself as the approval (the
   *  user has clicked the second-click confirm). v1 default is `true`;
   *  Pro-tier multi-surface approval flips this to `false`. */
  same_user_auto_approve?: boolean;
}

export interface UpstreamMergeRequestResponse {
  outbox_id: string;
  approval_id: string;
  state: UpstreamMergeState;
  /** When `dispatchable: false` (e.g. Salesforce contact), the row
   *  short-circuits the vendor call and immediately drives the local
   *  step — the vendor remains untouched but the local merge proceeds.
   *  The response surfaces this so the UI can render the degraded-
   *  path receipt. */
  degraded_path?: 'vendor_not_dispatchable';
}

/** `upstream_merge.retry` — user-driven retry on a `vendor_merge_failed`
 *  row. Per spec, this CREATES A FRESH approval + outbox row (the old
 *  row stays terminal). The substrate never silently re-runs a failed
 *  merge. */
export interface UpstreamMergeRetryInput {
  /** The failed outbox row id. The handler reads it, copies the
   *  vendor + pairs into a fresh row, and returns the new outbox_id. */
  failed_outbox_id: string;
  /** D-138 P5 fold-back (Codex F2) — connection_name to dispatch
   *  against. Defaults to the failed row's stored `connection_name`
   *  when omitted (every D-138 P5 row carries this since the request
   *  rpc persists it). The handler errors out if neither source
   *  provides a value. */
  connection_name?: string;
  /** D-138 P5 fold-back (Codex F2) — when `true` (v1 default), the
   *  retry rpc behaves like the request rpc: synthetic approval,
   *  immediate drive. Set to `false` to surface the retry through the
   *  multi-surface approval flow first. */
  same_user_auto_approve?: boolean;
}

export interface UpstreamMergeRetryResponse {
  /** New outbox row id; old row is unchanged. */
  outbox_id: string;
  approval_id: string;
  /** D-138 P5 fold-back (Codex F2) — terminal state of the fresh
   *  row at the moment the retry rpc returned. When `same_user_auto-
   *  _approve` was `true`, the driver ran inline + this is one of
   *  the terminal states; when `false`, the row is `pending_vendor_-
   *  merge` waiting for multi-surface approval. */
  state: UpstreamMergeState;
}

/** `upstream_merge.discard` — user dismisses a failed row from the
 *  banner. No-op on the row's terminal state, just hides it from the
 *  active-failures view. */
export interface UpstreamMergeDiscardInput {
  failed_outbox_id: string;
}

export interface UpstreamMergeDiscardResponse {
  discarded: boolean;
}

/** `upstream_merge.list` — Settings → Contacts → Failed merges
 *  surface. Defaults to `state: 'vendor_merge_failed'` so the banner
 *  hydrates from the failure-only view. */
export interface UpstreamMergeListInput {
  state?: UpstreamMergeState;
  limit?: number;
}

export interface UpstreamMergeListResponse {
  rows: UpstreamMergeOutboxRow[];
}

// ────────────────────────────────────────────────────────────────
// Failure-event payload
// ────────────────────────────────────────────────────────────────

/** Broadcast bus payload for `kind: 'upstream_merge_failed'`. The
 *  banner subscribes + renders one entry per pending failure. */
export interface UpstreamMergeFailedEventDetail {
  outbox_id: string;
  approval_id: string;
  vendor: UpstreamMergeVendor;
  object_type: UpstreamMergeObjectType;
  candidate_ids: string[];
  survivor_email: string;
  error: UpstreamMergeError;
  failed_at: number;
}
