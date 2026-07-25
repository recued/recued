/** D-138 P5 — `upstream_merge.*` rpc handlers + outbox driver.
 *
 *  Five rpc methods (local-UI only; namespace excluded from MCP catalog
 *  by the ratchet):
 *
 *    - `upstream_merge.describe` — render the modal preview
 *    - `upstream_merge.request`  — second-click confirm fires this;
 *                                  server creates outbox row + drives
 *                                  the state machine to terminal
 *    - `upstream_merge.retry`    — user-driven retry on a failed row;
 *                                  creates a fresh outbox row
 *    - `upstream_merge.discard`  — dismiss a failed row from the
 *                                  banner (deletes the row)
 *    - `upstream_merge.list`     — surface failed rows for the banner
 *
 *  Outbox driver: state machine transitions are persisted at every
 *  step. Vendor calls run with retry-with-backoff up to
 *  `UPSTREAM_MERGE_RETRY_BUDGET = 3` attempts; idempotency-keyed so
 *  duplicate dispatches collapse onto the same upstream operation.
 *  On vendor success, the local merge step runs idempotently
 *  (cascading through the existing `contact.merge.confirm` semantics
 *  with a synthetic candidate id when needed).
 *
 *  Server-boot recovery: on `runRecoverySweep()`, the driver picks up
 *  every recoverable row + replays the next state transition. Vendor
 *  calls are idempotent on the idempotency key; local steps are
 *  idempotent on `(survivor_email, loser_emails)` because the
 *  underlying contact-store's `setMergedInto` + `linkPlatformId` are
 *  idempotent.
 *
 *  Spec: `docs/d-138-spec.md` § A.7 + § Phase 5. */

import { createHash, randomUUID } from 'node:crypto';

import {
  RpcError,
  UPSTREAM_MERGE_RETRY_BUDGET,
  computeUpstreamMergeIdempotencyKey,
  isUpstreamMergeDispatchable,
  isUpstreamMergeTerminal,
  upstreamMergeBackoffMs,
  type ApprovalRequest,
  type ConnectionRecord,
  type ContactRecord,
  type HandlerSlice,
  type ServerRpcRegistry,
  type UpstreamMergeDescribeRequest,
  type UpstreamMergeDescribeResponse,
  type UpstreamMergeDiscardInput,
  type UpstreamMergeDiscardResponse,
  type UpstreamMergeError,
  type UpstreamMergeEvent,
  type UpstreamMergeListInput,
  type UpstreamMergeListResponse,
  type UpstreamMergeObjectType,
  type UpstreamMergeOutboxRow,
  type UpstreamMergeRequestInput,
  type UpstreamMergeRequestResponse,
  type UpstreamMergeRetryInput,
  type UpstreamMergeRetryResponse,
  type UpstreamMergeVendor,
  type UpstreamMergeVendorPair,
} from '@recued/contracts';

import type { WsClient } from './ws-server.js';
import type { ContactStore } from './storage/contact-store.js';
import type { UpstreamMergeStore } from './storage/upstream-merge-store.js';
import type { EventBus } from './events/bus.js';
import type {
  VendorMergeClient,
  VendorMergeResult,
} from './data/vendor-merge.js';

// ────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────

/** Vendor connection lookup — one entry per `(vendor, connection_name)`.
 *  Boot wire passes a closure over the `ConnectionStoreSqlite`; tests
 *  pass an in-memory map. */
export type VendorConnectionLookup = (
  vendor: UpstreamMergeVendor,
  connection_name: string,
) => ConnectionRecord | null;

/** One vendor-merge client per `UpstreamMergeObjectType`. The map is
 *  populated at boot with the HubSpot + Salesforce clients. */
export type VendorMergeRegistry = ReadonlyMap<UpstreamMergeObjectType, VendorMergeClient>;

/** Audit-log emit shape — the handler fires one entry per state
 *  transition. Boot wire writes through `@recued/storage`'s audit log;
 *  tests pass a recorder closure. */
export type UpstreamMergeAuditEmit = (entry: UpstreamMergeAuditEntry) => void;

export interface UpstreamMergeAuditEntry {
  outbox_id: string;
  approval_id: string;
  transition: string;          // e.g. 'pending → in_flight' | 'failed_terminal' | 'committed'
  state: string;
  attempt: number;
  vendor: string;
  object_type: string;
  candidate_ids: string[];
  survivor_email: string;
  loser_emails: string[];
  at: number;
  error?: UpstreamMergeError;
  vendor_response_excerpt?: string;
}

/** Approval-store integration — the handler creates a synthetic
 *  approval entry so the upstream merge surfaces in the existing D-113
 *  approval queue. Boot wire passes the real store; tests pass a
 *  recorder. */
export interface UpstreamMergeApprovalSink {
  /** Add a pending approval. Returns the approval_id assigned.
   *  When `sameUserAutoApprove` is true the handler skips the wait
   *  and treats the request itself as the approval; the sink is still
   *  called so audit + UI surfaces stay coherent. */
  addPending(input: { request: ApprovalRequest; outbox_id: string }): string;
  /** Mark the approval resolved. The handler calls this on terminal
   *  success or terminal failure so the queue clears. */
  markResolved(approval_id: string, decision: 'approve' | 'reject'): void;
}

export interface UpstreamMergeRpcDeps {
  store: UpstreamMergeStore;
  contactStore: ContactStore;
  vendorMergers: VendorMergeRegistry;
  vendorConnectionLookup: VendorConnectionLookup;
  eventBus?: EventBus;
  approvalSink?: UpstreamMergeApprovalSink;
  audit?: UpstreamMergeAuditEmit;
  /** Optional D-136 cascade hook — fired post local-merge step.
   *  Boot wire passes the cascade engine; tests pass a no-op. */
  onIdentityChanged?: (input: { survivor_email: string; loser_emails: string[] }) => void;
  now?: () => number;
  newId?: () => string;
  /** Optional sleep — used between retry attempts. Defaults to
   *  `setTimeout`. Tests pass a deterministic stub. */
  sleep?: (ms: number) => Promise<void>;
}

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

const sha256Hex = (canonical: string): string =>
  createHash('sha256').update(canonical).digest('hex');

// D-138 P5 fold-back (Codex F9) — `unref()` so a stranded retry sleep
// doesn't keep the event loop alive past server shutdown. Tests still
// inject a deterministic stub via `deps.sleep`.
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const handle = setTimeout(resolve, ms);
    if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
      (handle as { unref: () => void }).unref();
    }
  });

// D-138 P5 fold-back (Codex F1) — in-process dispatch lock keyed on
// outbox_id. Two concurrent same-pair requests (e.g. user double-click
// past the second-click guard, or recovery sweep racing a live request)
// MUST NOT both fire `client.merge`. Vendors are idempotent on the
// idempotency key but firing twice still doubles network cost + audit
// noise + makes failure replay racy. The lock is server-process-local;
// concurrent server processes are out-of-scope (recued-server is one
// process per pair).
const inFlightOutboxLocks = new Set<string>();
const claimDispatchLock = (outbox_id: string): boolean => {
  if (inFlightOutboxLocks.has(outbox_id)) return false;
  inFlightOutboxLocks.add(outbox_id);
  return true;
};
const releaseDispatchLock = (outbox_id: string): void => {
  inFlightOutboxLocks.delete(outbox_id);
};

/** Test-only — used by acceptance tests to assert the lock state. */
export const __upstreamMergeDispatchLockSize = (): number => inFlightOutboxLocks.size;

const summarizeError = (e: UpstreamMergeError | undefined): string =>
  e === undefined ? '' : `${e.code}: ${e.message}`.slice(0, 256);

const summarizeResponse = (vendor_response: Record<string, unknown> | undefined): string => {
  if (vendor_response === undefined) return '';
  try {
    return JSON.stringify(vendor_response).slice(0, 256);
  } catch {
    return '';
  }
};

const emitAudit = (
  audit: UpstreamMergeAuditEmit | undefined,
  row: UpstreamMergeOutboxRow,
  transition: string,
  extras?: { error?: UpstreamMergeError; vendor_response_excerpt?: string },
  now?: () => number,
): void => {
  if (audit === undefined) return;
  audit({
    outbox_id: row.id,
    approval_id: row.approval_id,
    transition,
    state: row.state,
    attempt: row.attempts,
    vendor: row.vendor,
    object_type: row.object_type,
    candidate_ids: row.candidate_ids,
    survivor_email: row.survivor_email,
    loser_emails: row.loser_emails,
    at: now ? now() : Date.now(),
    ...(extras?.error !== undefined ? { error: extras.error } : {}),
    ...(extras?.vendor_response_excerpt !== undefined
      ? { vendor_response_excerpt: extras.vendor_response_excerpt }
      : {}),
  });
};

const emitFailureBus = (
  eventBus: EventBus | undefined,
  row: UpstreamMergeOutboxRow,
  failed_at: number,
): void => {
  if (eventBus === undefined) return;
  if (row.last_error === undefined) return;
  eventBus.emit({
    kind: 'upstream_merge_failed',
    outbox_id: row.id,
    approval_id: row.approval_id,
    vendor: row.vendor,
    survivor_email: row.survivor_email,
    error_code: row.last_error.code,
    error_message: row.last_error.message,
  } as Parameters<EventBus['emit']>[0]);
  // (Augment the cast because the event-bus's distributive Omit drops
  // `cursor` from the variant; the assigned cursor is filled by emit.)
  void failed_at;
};

// D-138 P5 fold-back (Codex F7) — centralized "apply event + audit +
// bus + approval resolve" so every state transition fires the same
// observability bundle. Previous code did these separately at each
// call site, which introduced gaps (degraded path missing audit on
// the implicit `vendor_call_succeeded` step, recovery catch missing
// bus emit on terminal failure). Use this helper for ALL store
// transitions in this handler.
interface TransitionExtras {
  attempts_delta?: number;
  last_error?: UpstreamMergeError | null;
  pre_merge_snapshot?: Record<string, unknown>;
  mark_attempt?: boolean;
  audit_extras?: { error?: UpstreamMergeError; vendor_response_excerpt?: string };
}

const applyTransitionAndEmit = (
  deps: UpstreamMergeRpcDeps,
  outbox_id: string,
  event: UpstreamMergeEvent,
  audit_transition: string,
  extras?: TransitionExtras,
): UpstreamMergeOutboxRow => {
  const patch: Parameters<UpstreamMergeStore['applyEvent']>[2] = {};
  if (extras?.attempts_delta !== undefined) patch.attempts_delta = extras.attempts_delta;
  if (extras?.last_error !== undefined) patch.last_error = extras.last_error;
  if (extras?.pre_merge_snapshot !== undefined) patch.pre_merge_snapshot = extras.pre_merge_snapshot;
  if (extras?.mark_attempt !== undefined) patch.mark_attempt = extras.mark_attempt;

  const row = deps.store.applyEvent(outbox_id, event, patch);
  emitAudit(deps.audit, row, audit_transition, extras?.audit_extras, deps.now);
  if (row.state === 'vendor_merge_failed') {
    emitFailureBus(deps.eventBus, row, (deps.now ?? Date.now)());
    if (deps.approvalSink) {
      try { deps.approvalSink.markResolved(row.approval_id, 'reject'); } catch { /* */ }
    }
  } else if (row.state === 'local_merge_committed' && deps.approvalSink) {
    try { deps.approvalSink.markResolved(row.approval_id, 'approve'); } catch { /* */ }
  }
  return row;
};

// ────────────────────────────────────────────────────────────────
// Driver — runs the state machine for one outbox row to terminal.
// ────────────────────────────────────────────────────────────────

interface DriveContext {
  deps: UpstreamMergeRpcDeps;
  outbox_id: string;
  /** When true, the driver runs the local-merge step idempotently +
   *  the row was already at `vendor_merge_succeeded` (boot recovery
   *  path). */
  recovered?: boolean;
}

const fetchConnection = (
  deps: UpstreamMergeRpcDeps,
  vendor: UpstreamMergeVendor,
  connection_name: string,
): ConnectionRecord => {
  const conn = deps.vendorConnectionLookup(vendor, connection_name);
  if (conn === null) {
    throw new RpcError(
      'not_found',
      `upstream_merge: connection ${vendor}/${connection_name} not found`,
    );
  }
  return conn;
};

const runVendorAttempts = async (
  ctx: DriveContext,
  client: VendorMergeClient,
  connection: ConnectionRecord,
): Promise<UpstreamMergeOutboxRow> => {
  const sleep = ctx.deps.sleep ?? defaultSleep;
  let row = ctx.deps.store.get(ctx.outbox_id);
  if (row === null) {
    throw new Error(`upstream_merge_driver: row ${ctx.outbox_id} disappeared`);
  }
  // Vendor-pair invariant — v1 supports a single survivor + loser pair
  // per outbox row (matches the modal preview shape; multi-pair is a
  // future enhancement).
  if (row.vendor_pairs.length === 0) {
    return applyTransitionAndEmit(
      ctx.deps,
      row.id,
      { type: 'vendor_call_failed_terminal', reason: 'no_vendor_pair' },
      'vendor_call_failed_terminal',
      {
        last_error: {
          code: 'no_vendor_pair',
          message: 'Outbox row carries no vendor_pairs to merge',
        },
        audit_extras: {
          error: { code: 'no_vendor_pair', message: 'Outbox row carries no vendor_pairs to merge' },
        },
      },
    );
  }
  const pair = row.vendor_pairs[0]!;

  // D-138 P5 fold-back (Codex F6) — budget pre-check. Recovery may
  // resume an in-flight row that already exhausted attempts; we must
  // NOT increment + dispatch in that case.
  if (row.state === 'vendor_merge_in_flight' && row.attempts >= UPSTREAM_MERGE_RETRY_BUDGET) {
    const exhausted: UpstreamMergeError = {
      code: 'retry_budget_exhausted',
      message: `Vendor merge already at ${row.attempts} attempts on resume; refusing to dispatch a fresh call`,
    };
    return applyTransitionAndEmit(
      ctx.deps,
      row.id,
      { type: 'vendor_call_failed_terminal', reason: 'retry_budget_exhausted' },
      'vendor_call_failed_terminal',
      { last_error: exhausted, audit_extras: { error: exhausted } },
    );
  }

  // Transition to in_flight before the call so a crash mid-call is
  // recoverable (the boot sweep finds the row in_flight + replays).
  if (row.state === 'pending_vendor_merge') {
    row = applyTransitionAndEmit(
      ctx.deps,
      row.id,
      { type: 'vendor_call_started' },
      'vendor_call_started',
      { mark_attempt: true, attempts_delta: 1, last_error: null },
    );
  } else if (row.state === 'vendor_merge_in_flight') {
    // Recovery path — DO NOT bump attempts (Codex F6). Treat as
    // continuation of the existing attempt; the row's `attempts`
    // counter already covers the call we're resuming.
    row = applyTransitionAndEmit(
      ctx.deps,
      row.id,
      { type: 'vendor_call_started' },
      'vendor_call_resumed',
      { mark_attempt: true },
    );
  }

  for (;;) {
    const result: VendorMergeResult = await client.merge(connection, pair, row.idempotency_key);
    if (result.ok) {
      return applyTransitionAndEmit(
        ctx.deps,
        row.id,
        { type: 'vendor_call_succeeded' },
        'vendor_call_succeeded',
        {
          last_error: null,
          pre_merge_snapshot: result.vendor_response ?? undefined,
          audit_extras: {
            vendor_response_excerpt: summarizeResponse(result.vendor_response),
          },
        },
      );
    }

    if (!result.retryable) {
      return applyTransitionAndEmit(
        ctx.deps,
        row.id,
        { type: 'vendor_call_failed_terminal', reason: result.error.code },
        'vendor_call_failed_terminal',
        { last_error: result.error, audit_extras: { error: result.error } },
      );
    }

    // Retryable failure — record the error, check budget, possibly
    // transition to terminal, otherwise sleep + loop.
    row = applyTransitionAndEmit(
      ctx.deps,
      row.id,
      { type: 'vendor_call_failed_retryable', attempt: row.attempts },
      'vendor_call_failed_retryable',
      { last_error: result.error, audit_extras: { error: result.error } },
    );

    if (row.attempts >= UPSTREAM_MERGE_RETRY_BUDGET) {
      const exhausted: UpstreamMergeError = {
        code: 'retry_budget_exhausted',
        message: `Vendor merge failed after ${row.attempts} attempts: ${result.error.message}`,
        ...(result.error.http_status !== undefined ? { http_status: result.error.http_status } : {}),
      };
      return applyTransitionAndEmit(
        ctx.deps,
        row.id,
        { type: 'vendor_call_failed_terminal', reason: 'retry_budget_exhausted' },
        'vendor_call_failed_terminal',
        { last_error: exhausted, audit_extras: { error: exhausted } },
      );
    }

    const delayMs = upstreamMergeBackoffMs(row.attempts + 1);
    if (delayMs > 0) await sleep(delayMs);

    // D-138 P5 fold-back (Codex F9) — re-fetch the row after the
    // sleep + check it's still ours to drive. A concurrent terminal
    // (e.g. discard rpc) could have flipped state; releasing the
    // lock is the dispatcher's responsibility but defensive checks
    // here prevent a wake-up from re-entering a terminal row.
    const refreshed = ctx.deps.store.get(row.id);
    if (refreshed === null) {
      throw new Error(`upstream_merge_driver: row ${row.id} disappeared during retry sleep`);
    }
    if (isUpstreamMergeTerminal(refreshed.state)) {
      return refreshed;
    }
    row = refreshed;

    // Re-attempt — increment attempts via vendor_call_started's
    // mark_attempt path. The state stays in_flight (idempotent).
    row = applyTransitionAndEmit(
      ctx.deps,
      row.id,
      { type: 'vendor_call_started' },
      'vendor_call_retry',
      { mark_attempt: true, attempts_delta: 1 },
    );
  }
};

const runLocalMergeStep = (
  ctx: DriveContext,
): UpstreamMergeOutboxRow => {
  let row = ctx.deps.store.get(ctx.outbox_id);
  if (row === null) {
    throw new Error(`upstream_merge_driver: row ${ctx.outbox_id} disappeared during local step`);
  }

  // Transition succeeded → local_pending (idempotent on local_pending).
  if (row.state === 'vendor_merge_succeeded') {
    row = applyTransitionAndEmit(
      ctx.deps,
      row.id,
      { type: 'local_step_started' },
      'local_step_started',
    );
  } else if (row.state === 'vendor_merge_local_pending') {
    // Recovery — already mid-local-step. Keep going. Audit the resume
    // explicitly so the timeline carries the boot-replay event.
    emitAudit(ctx.deps.audit, row, 'local_step_resumed', undefined, ctx.deps.now);
  } else if (row.state === 'local_merge_committed') {
    // Replay-on-already-committed — emit audit for forensics, return.
    emitAudit(ctx.deps.audit, row, 'local_step_replay_noop', undefined, ctx.deps.now);
    return row;
  } else {
    throw new Error(
      `upstream_merge_driver: cannot run local step from state ${row.state}`,
    );
  }

  // Idempotent local merge — survivor + losers come from the row.
  // The contact-store's setMergedInto + linkPlatformId are idempotent
  // (UNIQUE constraints + JSON-array dedup), so re-running yields the
  // same final state.
  const survivor = ctx.deps.contactStore.get(row.survivor_email);
  if (survivor === null) {
    // D-138 P5 fold-back (Codex F5) — survivor missing after vendor
    // success is a real local-step failure. Use the dedicated
    // `local_step_failed` event (added in this fold-back) so the
    // reducer cleanly transitions `local_pending → vendor_merge_failed`
    // + the centralized helper fires audit + bus + approval-resolve.
    const error: UpstreamMergeError = {
      code: 'survivor_missing_locally',
      message: `Survivor canonical email ${row.survivor_email} not found in local contacts after vendor merge succeeded; manual reconciliation required`,
    };
    return applyTransitionAndEmit(
      ctx.deps,
      row.id,
      { type: 'local_step_failed', reason: error.code },
      'local_step_failed',
      { last_error: error, audit_extras: { error } },
    );
  }

  // Apply per-loser absorption identical to contact.merge.confirm.
  const losersAbsorbed: ContactRecord[] = [];
  for (const loserEmail of row.loser_emails) {
    const loser = ctx.deps.contactStore.get(loserEmail);
    if (loser === null) continue;
    if (loser.merged_into) continue; // already merged
    losersAbsorbed.push(loser);
    for (const entry of loser.platform_ids ?? []) {
      ctx.deps.contactStore.linkPlatformId({
        canonical_email: row.survivor_email,
        vendor: entry.vendor,
        platform_id: entry.platform_id,
        state: entry.state,
        linked_at: entry.linked_at,
        linked_by: entry.linked_by,
      });
    }
  }
  if (losersAbsorbed.length > 0) {
    ctx.deps.contactStore.setMergedInto(
      losersAbsorbed,
      row.survivor_email,
      (ctx.deps.now ?? Date.now)(),
    );
  }
  if (ctx.deps.onIdentityChanged) {
    try {
      ctx.deps.onIdentityChanged({
        survivor_email: row.survivor_email,
        loser_emails: losersAbsorbed.map((c) => c.email),
      });
    } catch {
      // Cascade is best-effort from the rpc layer; never abort the
      // outbox transition because an enrichment recompute failed.
    }
  }

  // applyTransitionAndEmit handles audit + approval-resolve.
  row = applyTransitionAndEmit(
    ctx.deps,
    row.id,
    { type: 'local_step_committed' },
    'local_step_committed',
  );
  return row;
};

const driveOutbox = async (
  deps: UpstreamMergeRpcDeps,
  outbox_id: string,
): Promise<UpstreamMergeOutboxRow> => {
  let row = deps.store.get(outbox_id);
  if (row === null) {
    throw new RpcError('not_found', `upstream_merge: outbox row ${outbox_id} not found`);
  }
  if (isUpstreamMergeTerminal(row.state)) return row;

  // Degraded path — `salesforce:contact` doesn't dispatch. Skip
  // straight to local merge so the user-side merge still proceeds.
  if (!isUpstreamMergeDispatchable(row.object_type)) {
    if (row.state === 'pending_vendor_merge') {
      row = deps.store.applyEvent(row.id, { type: 'vendor_call_started' }, {
        mark_attempt: true, attempts_delta: 1,
      });
      row = deps.store.applyEvent(row.id, { type: 'vendor_call_succeeded' });
      emitAudit(deps.audit, row, 'vendor_call_skipped_degraded_path', undefined, deps.now);
    }
    return runLocalMergeStep({ deps, outbox_id });
  }

  const client = deps.vendorMergers.get(row.object_type);
  if (client === undefined) {
    const error: UpstreamMergeError = {
      code: 'vendor_merger_unregistered',
      message: `No vendor merger registered for ${row.object_type}`,
    };
    row = deps.store.applyEvent(row.id, {
      type: 'vendor_call_failed_terminal',
      reason: error.code,
    }, { last_error: error });
    emitAudit(deps.audit, row, 'vendor_call_failed_terminal', { error }, deps.now);
    emitFailureBus(deps.eventBus, row, (deps.now ?? Date.now)());
    if (deps.approvalSink) {
      try { deps.approvalSink.markResolved(row.approval_id, 'reject'); } catch { /* */ }
    }
    return row;
  }

  // Vendor connection lookup — the rpc carried a connection_name on
  // request; the row stores it in vendor_pairs as a vendor-side
  // logical entity. We re-load via the row's vendor + the
  // connection name parsed from the lookup. Simpler: stash on the
  // row via the request rpc — but the row contract didn't add a
  // connection_name column. Workaround: vendor_connection_lookup
  // takes (vendor, connection_name); the rpc threading carries the
  // name. The driver gets the name from the immediate caller (rpc
  // request) — pass it via DriveContext for fresh dispatches; for
  // the boot recovery sweep we pull from the audit memory or fall
  // back to the first matching connection.

  // The simplest approach for v1: store connection_name as part of
  // the vendor_pairs by appending a `_connection_name` field. To
  // avoid contract churn, we widen the storage layer to keep a
  // connection_name column, but that's bigger than needed; instead,
  // pass connection_name as part of the driveOutbox call and
  // require the boot-recovery sweep callers to look it up via the
  // first enrolled connection of the row's vendor.
  throw new Error('upstream_merge_driver: connection lookup must be passed via dispatch helper');
};

/** Entry point for the rpc handler — dispatches with explicit
 *  connection_name. D-138 P5 fold-back (Codex F1, F4): in-process
 *  dispatch lock prevents same-pair concurrent dispatch; post-vendor
 *  states (succeeded/local_pending) skip the connection lookup
 *  entirely so a removed connection doesn't block local replay. */
const driveOutboxWithConnection = async (
  deps: UpstreamMergeRpcDeps,
  outbox_id: string,
  connection_name: string,
): Promise<UpstreamMergeOutboxRow> => {
  let row = deps.store.get(outbox_id);
  if (row === null) {
    throw new RpcError('not_found', `upstream_merge: outbox row ${outbox_id} not found`);
  }
  if (isUpstreamMergeTerminal(row.state)) return row;

  // D-138 P5 fold-back (Codex F1) — claim the dispatch lock before
  // any state mutation. A second concurrent caller bails out + returns
  // the current row state; the user-visible effect is "the first
  // request is in flight" rather than a duplicate vendor call.
  if (!claimDispatchLock(outbox_id)) {
    return row;
  }
  try {
    // Re-fetch under the lock so we don't act on a stale snapshot.
    row = deps.store.get(outbox_id);
    if (row === null) {
      throw new RpcError('not_found', `upstream_merge: outbox row ${outbox_id} not found`);
    }
    if (isUpstreamMergeTerminal(row.state)) return row;

    // Degraded path — salesforce:contact. Surface the implicit pre-
    // vendor + post-vendor transitions through the centralized helper
    // so audit + approval-resolve fire on EACH transition (Codex F7).
    if (!isUpstreamMergeDispatchable(row.object_type)) {
      if (row.state === 'pending_vendor_merge') {
        row = applyTransitionAndEmit(
          deps,
          row.id,
          { type: 'vendor_call_started' },
          'vendor_call_skipped_degraded_path_started',
          { mark_attempt: true, attempts_delta: 1 },
        );
        row = applyTransitionAndEmit(
          deps,
          row.id,
          { type: 'vendor_call_succeeded' },
          'vendor_call_skipped_degraded_path_succeeded',
        );
      }
      return runLocalMergeStep({ deps, outbox_id });
    }

    const client = deps.vendorMergers.get(row.object_type);
    if (client === undefined) {
      const error: UpstreamMergeError = {
        code: 'vendor_merger_unregistered',
        message: `No vendor merger registered for ${row.object_type}`,
      };
      return applyTransitionAndEmit(
        deps,
        row.id,
        { type: 'vendor_call_failed_terminal', reason: error.code },
        'vendor_call_failed_terminal',
        { last_error: error, audit_extras: { error } },
      );
    }

    // D-138 P5 fold-back (Codex F4) — post-vendor states only need
    // the local step. Don't fetch the vendor connection; a removed /
    // unreachable connection should NOT block a local replay.
    if (row.state === 'vendor_merge_succeeded' || row.state === 'vendor_merge_local_pending') {
      return runLocalMergeStep({ deps, outbox_id });
    }

    // Pre-vendor / mid-vendor states — fetch the connection + drive
    // the vendor call to terminal.
    const connection = fetchConnection(deps, row.vendor, connection_name);
    row = await runVendorAttempts({ deps, outbox_id }, client, connection);
    if (isUpstreamMergeTerminal(row.state)) return row;
    if (row.state === 'vendor_merge_succeeded' || row.state === 'vendor_merge_local_pending') {
      return runLocalMergeStep({ deps, outbox_id });
    }
    return row;
  } finally {
    releaseDispatchLock(outbox_id);
  }
};

// ────────────────────────────────────────────────────────────────
// rpc handlers
// ────────────────────────────────────────────────────────────────

const newId = (deps: UpstreamMergeRpcDeps): string =>
  (deps.newId ?? randomUUID)();

const ensureSurvivor = (deps: UpstreamMergeRpcDeps, email: string): ContactRecord => {
  const row = deps.contactStore.get(email);
  if (row === null) {
    throw new RpcError('not_found', `upstream_merge: survivor ${email} not found`);
  }
  if (row.merged_into) {
    throw new RpcError(
      'bad_request',
      `upstream_merge: survivor ${email} is already merged into ${row.merged_into}`,
    );
  }
  return row;
};

export const handleUpstreamMergeDescribe = async (
  deps: UpstreamMergeRpcDeps,
  args: UpstreamMergeDescribeRequest,
): Promise<UpstreamMergeDescribeResponse> => {
  if (!args || typeof args !== 'object') {
    throw new RpcError('bad_request', 'upstream_merge.describe: missing args');
  }
  const client = deps.vendorMergers.get(args.object_type);
  if (client === undefined) {
    return {
      field_outcomes: [],
      vendor_semantics_summary: `No upstream-merge client registered for ${args.object_type}`,
      dispatchable: false,
    };
  }
  const connection = fetchConnection(deps, args.vendor, args.connection_name);
  const preview = await client.describe(connection, {
    survivor_platform_id: args.survivor_platform_id,
    loser_platform_id: args.loser_platform_id,
  });
  const out: UpstreamMergeDescribeResponse = {
    field_outcomes: preview.field_outcomes,
    vendor_semantics_summary: preview.vendor_semantics_summary,
    dispatchable: preview.dispatchable,
  };
  if (preview.survivor_last_modified !== undefined) {
    out.survivor_last_modified = preview.survivor_last_modified;
  }
  if (preview.loser_last_modified !== undefined) {
    out.loser_last_modified = preview.loser_last_modified;
  }
  return out;
};

export const handleUpstreamMergeRequest = async (
  deps: UpstreamMergeRpcDeps,
  args: UpstreamMergeRequestInput,
): Promise<UpstreamMergeRequestResponse> => {
  if (!args || typeof args !== 'object') {
    throw new RpcError('bad_request', 'upstream_merge.request: missing args');
  }
  if (!Array.isArray(args.vendor_pairs) || args.vendor_pairs.length === 0) {
    throw new RpcError(
      'bad_request',
      'upstream_merge.request: vendor_pairs must be a non-empty array',
    );
  }
  if (!Array.isArray(args.candidate_ids) || args.candidate_ids.length === 0) {
    throw new RpcError(
      'bad_request',
      'upstream_merge.request: candidate_ids must be a non-empty array',
    );
  }
  ensureSurvivor(deps, args.survivor_email);

  // Idempotency-keyed insert — duplicate request rpcs collapse onto
  // the same row. The handler treats the row's existing state as
  // authoritative + only drives further if the row is non-terminal.
  const idempotency_key = computeUpstreamMergeIdempotencyKey(
    {
      vendor: args.vendor,
      object_type: args.object_type,
      candidate_ids: args.candidate_ids,
      survivor_email: args.survivor_email,
      vendor_pairs: args.vendor_pairs,
    },
    sha256Hex,
  );

  const now = (deps.now ?? Date.now)();
  const id = newId(deps);
  const approval_id = newId(deps);

  // Resolve loser_emails from the candidate_ids by reading the queue
  // rows. The queue already pairs `(email_a, email_b)`; the survivor
  // is `args.survivor_email` so the loser is whichever side isn't.
  const loser_set = new Set<string>();
  for (const cand_id of args.candidate_ids) {
    const cand = deps.contactStore.getMergeCandidate(cand_id);
    if (cand === null) continue;
    const partner = cand.email_a === args.survivor_email ? cand.email_b : cand.email_a;
    loser_set.add(partner);
  }
  if (loser_set.size === 0) {
    throw new RpcError(
      'bad_request',
      'upstream_merge.request: no losers resolved from candidate_ids',
    );
  }

  const sameUserAutoApprove = args.same_user_auto_approve !== false;
  const initialRow: UpstreamMergeOutboxRow = {
    id,
    approval_id,
    vendor: args.vendor,
    object_type: args.object_type,
    candidate_ids: args.candidate_ids,
    survivor_email: args.survivor_email,
    loser_emails: [...loser_set],
    vendor_pairs: args.vendor_pairs,
    idempotency_key,
    state: 'pending_vendor_merge',
    attempts: 0,
    connection_name: args.connection_name,
    same_user_auto_approve: sameUserAutoApprove,
    created_at: now,
    updated_at: now,
  };

  const { row: persistedRow, inserted } = deps.store.insertIfAbsent(initialRow);
  emitAudit(
    deps.audit,
    persistedRow,
    inserted ? 'outbox_inserted' : 'outbox_idempotent_replay',
    undefined,
    deps.now,
  );

  // D-138 P5 fold-back (Codex F8) — only register a fresh approval
  // for newly-inserted rows. An idempotent replay against a terminal
  // row already had its approval resolved on the first attempt; a
  // second `addPending` call would queue a phantom approval that
  // never resolves. Idempotent replay against a non-terminal row
  // (rare; means the first attempt is still mid-flight) re-uses the
  // existing approval id.
  if (deps.approvalSink && inserted) {
    try {
      const description =
        `Upstream merge: ${persistedRow.vendor} ${persistedRow.object_type} ` +
        `(${persistedRow.loser_emails.length} loser → ${persistedRow.survivor_email})`;
      deps.approvalSink.addPending({
        request: {
          request_id: persistedRow.approval_id,
          recipe_id: 'recued/upstream-merge',
          step_id: persistedRow.id,
          ingredient_slug: 'recued/upstream-merge',
          risk_tier: 'destructive',
          description,
          resolved_input: {
            vendor: persistedRow.vendor,
            object_type: persistedRow.object_type,
            survivor_email: persistedRow.survivor_email,
            loser_emails: persistedRow.loser_emails,
            candidate_ids: persistedRow.candidate_ids,
          },
          timestamp: new Date(now).toISOString(),
          trigger_source: 'manual',
        },
        outbox_id: persistedRow.id,
      });
    } catch { /* approval sink failures don't block the request */ }
  }

  // Drive the row when the request itself constitutes the approval
  // (v1 default). The driver returns the row after terminal state.
  let degraded_path: UpstreamMergeRequestResponse['degraded_path'] = undefined;
  if (!isUpstreamMergeDispatchable(args.object_type)) {
    degraded_path = 'vendor_not_dispatchable';
  }
  if (sameUserAutoApprove && !isUpstreamMergeTerminal(persistedRow.state)) {
    await driveOutboxWithConnection(deps, persistedRow.id, args.connection_name);
  }

  const finalRow = deps.store.get(persistedRow.id);
  if (finalRow === null) {
    throw new RpcError('internal_error', 'upstream_merge.request: row disappeared');
  }
  const out: UpstreamMergeRequestResponse = {
    outbox_id: finalRow.id,
    approval_id: finalRow.approval_id,
    state: finalRow.state,
  };
  if (degraded_path !== undefined) out.degraded_path = degraded_path;
  return out;
};

export const handleUpstreamMergeRetry = async (
  deps: UpstreamMergeRpcDeps,
  args: UpstreamMergeRetryInput,
): Promise<UpstreamMergeRetryResponse> => {
  if (typeof args?.failed_outbox_id !== 'string' || args.failed_outbox_id === '') {
    throw new RpcError('bad_request', 'upstream_merge.retry: failed_outbox_id is required');
  }
  const failed = deps.store.get(args.failed_outbox_id);
  if (failed === null) {
    throw new RpcError('not_found', `upstream_merge.retry: row ${args.failed_outbox_id} not found`);
  }
  if (failed.state !== 'vendor_merge_failed') {
    throw new RpcError(
      'conflict',
      `upstream_merge.retry: row ${args.failed_outbox_id} state is ${failed.state}; only vendor_merge_failed rows may retry`,
    );
  }
  // D-138 P5 fold-back (Codex F2) — resolve the connection_name. The
  // failed row almost always carries one (every D-138 P5 row does);
  // the rpc accepts an explicit override for callers wanting to
  // re-dispatch against a different enrolled connection.
  const connection_name = args.connection_name ?? failed.connection_name;
  if (typeof connection_name !== 'string' || connection_name === '') {
    throw new RpcError(
      'bad_request',
      `upstream_merge.retry: row ${args.failed_outbox_id} has no connection_name and none was supplied in the rpc`,
    );
  }
  // Create a fresh row with the same vendor pair + candidates. The
  // idempotency key is RECOMPUTED — we widen the seed by appending
  // the ms timestamp so the new key differs from the failed row's key.
  const now = (deps.now ?? Date.now)();
  const new_idempotency_seed = computeUpstreamMergeIdempotencyKey(
    {
      vendor: failed.vendor,
      object_type: failed.object_type,
      candidate_ids: failed.candidate_ids,
      survivor_email: failed.survivor_email,
      vendor_pairs: failed.vendor_pairs,
    },
    sha256Hex,
  );
  const fresh_idempotency_key = sha256Hex(`${new_idempotency_seed}|retry:${now}`);
  const id = newId(deps);
  const approval_id = newId(deps);
  const sameUserAutoApprove = args.same_user_auto_approve !== false;

  const freshRow: UpstreamMergeOutboxRow = {
    id,
    approval_id,
    vendor: failed.vendor,
    object_type: failed.object_type,
    candidate_ids: failed.candidate_ids,
    survivor_email: failed.survivor_email,
    loser_emails: failed.loser_emails,
    vendor_pairs: failed.vendor_pairs,
    idempotency_key: fresh_idempotency_key,
    state: 'pending_vendor_merge',
    attempts: 0,
    connection_name,
    same_user_auto_approve: sameUserAutoApprove,
    created_at: now,
    updated_at: now,
  };
  deps.store.insert(freshRow);
  emitAudit(deps.audit, freshRow, 'outbox_retry_inserted', undefined, deps.now);

  // D-138 P5 fold-back (Codex F2) — synthetic approval + drive,
  // mirroring the request rpc's same-user path. Without this the
  // retry rpc previously left the row stuck in `pending_vendor_-
  // merge` with no approval queued + no driver tick.
  if (deps.approvalSink) {
    try {
      const description =
        `Upstream merge (retry): ${freshRow.vendor} ${freshRow.object_type} ` +
        `(${freshRow.loser_emails.length} loser → ${freshRow.survivor_email})`;
      deps.approvalSink.addPending({
        request: {
          request_id: freshRow.approval_id,
          recipe_id: 'recued/upstream-merge',
          step_id: freshRow.id,
          ingredient_slug: 'recued/upstream-merge',
          risk_tier: 'destructive',
          description,
          resolved_input: {
            vendor: freshRow.vendor,
            object_type: freshRow.object_type,
            survivor_email: freshRow.survivor_email,
            loser_emails: freshRow.loser_emails,
            candidate_ids: freshRow.candidate_ids,
            retry_of: failed.id,
          },
          timestamp: new Date(now).toISOString(),
          trigger_source: 'manual',
        },
        outbox_id: freshRow.id,
      });
    } catch { /* approval sink failures don't block the retry */ }
  }

  if (sameUserAutoApprove) {
    await driveOutboxWithConnection(deps, freshRow.id, connection_name);
  }
  const finalRow = deps.store.get(freshRow.id);
  if (finalRow === null) {
    throw new RpcError('internal_error', 'upstream_merge.retry: row disappeared');
  }
  return {
    outbox_id: finalRow.id,
    approval_id: finalRow.approval_id,
    state: finalRow.state,
  };
};

export const handleUpstreamMergeDiscard = async (
  deps: UpstreamMergeRpcDeps,
  args: UpstreamMergeDiscardInput,
): Promise<UpstreamMergeDiscardResponse> => {
  if (typeof args?.failed_outbox_id !== 'string' || args.failed_outbox_id === '') {
    throw new RpcError('bad_request', 'upstream_merge.discard: failed_outbox_id is required');
  }
  const failed = deps.store.get(args.failed_outbox_id);
  if (failed === null) {
    return { discarded: false };
  }
  if (failed.state !== 'vendor_merge_failed') {
    throw new RpcError(
      'conflict',
      `upstream_merge.discard: row ${args.failed_outbox_id} state is ${failed.state}; only vendor_merge_failed rows may be discarded`,
    );
  }
  const removed = deps.store.delete(args.failed_outbox_id);
  emitAudit(deps.audit, failed, 'outbox_discarded', undefined, deps.now);
  return { discarded: removed };
};

export const handleUpstreamMergeList = async (
  deps: UpstreamMergeRpcDeps,
  args: UpstreamMergeListInput | undefined,
): Promise<UpstreamMergeListResponse> => {
  const query: { state?: UpstreamMergeOutboxRow['state']; limit?: number } = {};
  if (args?.state !== undefined) query.state = args.state;
  if (args?.limit !== undefined) query.limit = args.limit;
  // Default — show failed rows; the banner uses this to hydrate.
  if (query.state === undefined) query.state = 'vendor_merge_failed';
  return { rows: deps.store.list(query) };
};

// ────────────────────────────────────────────────────────────────
// Boot-recovery sweep — replays every recoverable row.
// ────────────────────────────────────────────────────────────────

/** Replay the recoverable rows. D-138 P5 fold-back (Codex F4) — post-
 *  vendor states (`vendor_merge_succeeded` / `vendor_merge_local_-
 *  pending`) skip the connection lookup entirely; their replay is
 *  pure local-merge. Pre-vendor / mid-vendor states use the row's
 *  stored `connection_name` first + fall back to the supplied
 *  `recoveryConnectionName` callback (boot wire's "first enrolled
 *  connection of the vendor"). When neither resolves, the row settles
 *  into `vendor_merge_failed` with a `recovery_connection_missing`
 *  error. */
export const runUpstreamMergeRecoverySweep = async (
  deps: UpstreamMergeRpcDeps,
  recoveryConnectionName: (vendor: UpstreamMergeVendor, object_type: UpstreamMergeObjectType) => string | null,
): Promise<{ replayed: number; succeeded: number; failed: number }> => {
  const rows = deps.store.listRecoverable();
  let succeeded = 0;
  let failed = 0;
  for (const row of rows) {
    // D-138 P5 fold-back (Codex F4) — post-vendor states need no
    // connection. Skip the lookup + the connection-missing failure
    // path entirely; drive the local step directly.
    const skipConnectionLookup =
      row.state === 'vendor_merge_succeeded' ||
      row.state === 'vendor_merge_local_pending';

    if (skipConnectionLookup) {
      try {
        // Use a sentinel connection_name; the driver will skip the
        // fetchConnection call for these states.
        const result = await driveOutboxWithConnection(deps, row.id, '');
        if (result.state === 'local_merge_committed') succeeded += 1;
        else if (result.state === 'vendor_merge_failed') failed += 1;
      } catch (e) {
        const error: UpstreamMergeError = {
          code: 'recovery_unexpected_error',
          message: e instanceof Error ? e.message : String(e),
        };
        try {
          // Use the dedicated `local_step_failed` event so the reducer
          // accepts the transition from local_pending; for non-local-
          // pending states it'll surface as an invalid-transition
          // throw caught by the outer try.
          if (row.state === 'vendor_merge_local_pending') {
            applyTransitionAndEmit(
              deps,
              row.id,
              { type: 'local_step_failed', reason: error.code },
              'recovery_unexpected_error',
              { last_error: error, audit_extras: { error } },
            );
          } else {
            // vendor_merge_succeeded — failed before local_step_started;
            // transition to local_pending then fail.
            applyTransitionAndEmit(
              deps,
              row.id,
              { type: 'local_step_started' },
              'recovery_local_step_started_pre_failure',
            );
            applyTransitionAndEmit(
              deps,
              row.id,
              { type: 'local_step_failed', reason: error.code },
              'recovery_unexpected_error',
              { last_error: error, audit_extras: { error } },
            );
          }
        } catch { /* swallow — already terminal */ }
        failed += 1;
      }
      continue;
    }

    // Pre-vendor / mid-vendor states. Pick the connection_name in
    // priority order: row-stored value (Codex F2 — every D-138 P5 row
    // carries one) → boot wire fallback ("first enrolled connection
    // of the vendor").
    const connection_name = row.connection_name ?? recoveryConnectionName(row.vendor, row.object_type);
    if (connection_name === null || connection_name === undefined) {
      const error: UpstreamMergeError = {
        code: 'recovery_connection_missing',
        message: `Recovery sweep could not find an enrolled ${row.vendor} connection for ${row.object_type}`,
      };
      try {
        applyTransitionAndEmit(
          deps,
          row.id,
          { type: 'vendor_call_failed_terminal', reason: error.code },
          'recovery_failed_no_connection',
          { last_error: error, audit_extras: { error } },
        );
      } catch { /* row already terminal */ }
      failed += 1;
      continue;
    }
    try {
      const result = await driveOutboxWithConnection(deps, row.id, connection_name);
      if (result.state === 'local_merge_committed') succeeded += 1;
      else if (result.state === 'vendor_merge_failed') failed += 1;
    } catch (e) {
      const error: UpstreamMergeError = {
        code: 'recovery_unexpected_error',
        message: e instanceof Error ? e.message : String(e),
      };
      try {
        applyTransitionAndEmit(
          deps,
          row.id,
          { type: 'vendor_call_failed_terminal', reason: error.code },
          'recovery_unexpected_error',
          { last_error: error, audit_extras: { error } },
        );
      } catch { /* swallow — already terminal */ }
      failed += 1;
    }
  }
  return { replayed: rows.length, succeeded, failed };
};

// ────────────────────────────────────────────────────────────────
// Handler registration
// ────────────────────────────────────────────────────────────────

type UpstreamMergeMethods =
  | 'upstream_merge.describe'
  | 'upstream_merge.request'
  | 'upstream_merge.retry'
  | 'upstream_merge.discard'
  | 'upstream_merge.list';

export const makeUpstreamMergeHandlers = (
  deps: UpstreamMergeRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, UpstreamMergeMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: [
      'upstream_merge.describe',
      'upstream_merge.request',
      'upstream_merge.retry',
      'upstream_merge.discard',
      'upstream_merge.list',
    ],
    handlers: {
      'upstream_merge.describe': async (args) =>
        handleUpstreamMergeDescribe(deps, args as UpstreamMergeDescribeRequest),
      'upstream_merge.request': async (args) =>
        handleUpstreamMergeRequest(deps, args as UpstreamMergeRequestInput),
      'upstream_merge.retry': async (args) =>
        handleUpstreamMergeRetry(deps, args as UpstreamMergeRetryInput),
      'upstream_merge.discard': async (args) =>
        handleUpstreamMergeDiscard(deps, args as UpstreamMergeDiscardInput),
      'upstream_merge.list': async (args) =>
        handleUpstreamMergeList(deps, args as UpstreamMergeListInput),
    },
  };
};

// Avoid unused-import lint when the inner helper isn't called via boot.
void driveOutbox;
void summarizeError;
