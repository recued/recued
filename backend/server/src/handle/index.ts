/** D-148 § A.5.6 + § P8 — handle governance state machine.
 *
 *  The server-local authority for the user's current handle and
 *  history. Composes:
 *
 *    - Local handle store (`HandleStateStore`) — current handle +
 *      historical entries + lifecycle state.
 *    - Cloud-side authority (`CloudHandleClient`) — first-come-first-
 *      served reservation, change, dual-signature transfer, abuse
 *      report. The cloud is the SOURCE OF TRUTH for collisions; the
 *      local store mirrors what the cloud confirmed.
 *    - Audit emission (`HandleAuditEmitter`) — every reservation /
 *      change / transfer / release flows through the high-assurance
 *      audit-log signing wrapper. The kind `handle_change` is in
 *      `HIGH_ASSURANCE_AUDIT_KINDS` so the wrapper signs it without
 *      caller intervention.
 *    - Broadcast bus (`HandleBroadcaster`) — `handle_changed` event
 *      fans out to every connected client so the webclient + bridge
 *      refresh their identity assumptions.
 *
 *  Why the local store at all. Cloud is source of truth, but the
 *  server needs an authoritative identity claim it can serve to
 *  paired clients (passport export, broadcast events) WITHOUT a
 *  cloud round-trip on every request — and the cloud might be
 *  unreachable for a Reachability Doctor cycle. The store mirrors
 *  the cloud's confirmed reservation; it never invents one.
 *
 *  Why dual-signature transfer. Spec § A.5.6 — handle ownership is
 *  load-bearing for marketplace publisher provenance, so a transfer
 *  needs both parties' explicit consent. The cloud verifies BOTH
 *  signatures; the user-facing flow on each side is just "accept the
 *  transfer" + signing happens locally with `server_identity_key`.
 */

import { randomUUID } from 'node:crypto';
import {
  canonicalizeHandle,
  HANDLE_RPC_REPLAY_WINDOW_MS,
  HANDLE_OLD_REDIRECT_WINDOW_MS,
  HANDLE_GRACE_PERIOD_MS,
  validateHandle,
  type HandleAbuseReportRequest,
  type HandleAbuseReportResponse,
  type HandleChangeRequest,
  type HandleChangeResponse,
  type HandleHistoryEntry,
  type HandleHistoryReason,
  type HandleReserveRequest,
  type HandleReserveResponse,
  type HandleRpcErrorCode,
  type HandleSubscriptionState,
  type HandleTransferRequest,
  type HandleTransferResponse,
  type HandleValidationCode,
} from '@recued/contracts';
import type { ActivityEntry } from '@recued/storage';
import { ed25519Sign, type Ed25519Keypair } from '../keys/index.js';
import { canonicalJSONStringify } from '@recued/crypto';

// ────────────────────────────────────────────────────────────────
// Local store (authoritative client-side mirror)
// ────────────────────────────────────────────────────────────────

export interface HandleState {
  /** Publisher id — `sha256:<hex>` of the server-identity SPKI-DER
   *  (`publisher_id == server_fingerprint`, the D-175 ratified
   *  identity contract). Immutable *per server-identity-key* (§ A.5.1):
   *  cert / session rotation never touches it, but a deliberate
   *  `server_identity_key` rotation (the heavyweight client-re-pair
   *  event) legitimately mints a NEW publisher_id, and `reReserve`
   *  re-anchors this field to it. */
  publisher_id: string;
  /** Current handle in canonical form. */
  current_handle: string;
  /** D-176 — short label of the DDNS zone the current handle is bound to
   *  (`DdnsZone.label`, e.g. `net`), mirrored from the cloud reserve/change
   *  response. Resolves to a suffix via `zoneByLabel` for `<handle>.<suffix>`
   *  synthesis; absent (older cloud / pre-D-176 state) ⇒ callers fall back to
   *  `defaultDdnsZone()`. */
  ddns_zone?: string;
  /** Historical entries — append-only. */
  handle_history: HandleHistoryEntry[];
  /** Reservation lifecycle stamp the cloud last confirmed. */
  subscription_state: HandleSubscriptionState;
  /** Unix-ms grace deadline; populated when state transitions to
   *  `'grace'` (subscription lapse). The cloud authority is the
   *  state machine; the local store mirrors. */
  grace_until?: number;
  /** Unix-ms timestamp of the last cloud-confirmed mutation. Cloud
   *  reads with `expected_state` use this for optimistic concurrency. */
  last_synced_at: number;
}

export interface HandleStateStore {
  load(): Promise<HandleState | null>;
  save(state: HandleState): Promise<void>;
}

export const createInMemoryHandleStateStore = (
  initial?: HandleState,
): HandleStateStore => {
  let state: HandleState | null = initial ?? null;
  return {
    async load() {
      return state ? cloneState(state) : null;
    },
    async save(next) {
      state = cloneState(next);
    },
  };
};

const cloneState = (state: HandleState): HandleState => ({
  ...state,
  handle_history: state.handle_history.map((h) => ({ ...h })),
});

// ────────────────────────────────────────────────────────────────
// Cloud client seam
// ────────────────────────────────────────────────────────────────

export type CloudHandleResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: HandleRpcErrorCode; message?: string };

/** Cloud-side rpc seam. The substrate doesn't know how to talk
 *  HTTP / Workers; tests inject a synchronous fake, production wires
 *  through the cloud-API client. */
export interface CloudHandleClient {
  reserveHandle(req: HandleReserveRequest): Promise<CloudHandleResult<HandleReserveResponse>>;
  changeHandle(req: HandleChangeRequest): Promise<CloudHandleResult<HandleChangeResponse>>;
  transferHandle(req: HandleTransferRequest): Promise<CloudHandleResult<HandleTransferResponse>>;
  abuseReport(req: HandleAbuseReportRequest): Promise<CloudHandleResult<HandleAbuseReportResponse>>;
  /** Optional availability check — the cloud surfaces it as a free
   *  endpoint that does NOT require a signature, so the UI can poll
   *  during typing. */
  checkAvailability?(handle: string): Promise<CloudHandleResult<{ available: boolean }>>;
}

// ────────────────────────────────────────────────────────────────
// Audit + broadcast seams
// ────────────────────────────────────────────────────────────────

export interface HandleAuditEmitter {
  log(entry: ActivityEntry): Promise<void> | void;
}

export interface HandleChangedBroadcastEvent {
  type: 'handle_changed';
  publisher_id: string;
  previous_handle: string;
  current_handle: string;
  changed_at: number;
  /** Set when the change came from a transfer (in or out); carries
   *  the counterparty's publisher_id so the client UI can render the
   *  context. */
  transfer_counterparty_publisher_id?: string;
}

export interface HandleBroadcaster {
  broadcast(event: HandleChangedBroadcastEvent): Promise<void> | void;
}

// ────────────────────────────────────────────────────────────────
// State-machine API
// ────────────────────────────────────────────────────────────────

export type HandleErrorCode = HandleRpcErrorCode | HandleValidationCode | 'handle_state_missing';

/** Codex P8 contract fold #4 — `state` is optional on success because
 *  ops like `reportAbuse` don't mutate the local store + shouldn't
 *  fabricate a placeholder. Consumers branch on `state !== undefined`
 *  rather than relying on a sentinel. */
export type HandleStateMachineResult<T> =
  | { ok: true; state?: HandleState; data: T }
  | { ok: false; error: HandleErrorCode; message?: string };

export interface ReserveHandleArgs {
  /** Initial reservation — the server has no `publisher_id` yet, so
   *  this surface is reachable only at first-boot bootstrap. After
   *  the publisher_id mints, all further calls go through
   *  `changeHandle`. */
  publisher_id: string;
  handle: string;
  publisher_identity_fingerprint: string;
  changed_by_client_id: string;
  reason?: string;
  now?: number;
}

export interface ChangeHandleArgs {
  next_handle: string;
  changed_by_client_id: string;
  reason?: string;
  now?: number;
}

export interface ReReserveHandleArgs {
  /** The rotated-to publisher_id — ALWAYS the live server-identity
   *  fingerprint (`sha256:<hex>`). The provisioner derives it from
   *  `serverFingerprint()` and never accepts a caller value; the
   *  substrate signs the reserve request with the LIVE identity key
   *  (`opts.serverIdentity()`), so the cloud only ever sees a request
   *  carrying the live fingerprint AND signed by the live key —
   *  mirroring `reserveInitial`'s structural guarantee. */
  publisher_id: string;
  /** The handle to (re-)anchor — the binding's `publisher_handle`. */
  handle: string;
  /** Audit provenance id. Recorded for call-site parity with
   *  `reserveInitial` / `changeHandle`; the `ActivityEntry` shape has no
   *  client-id slot, so the human-readable provenance rides in `detail`
   *  (same as the sibling ops). */
  changed_by_client_id: string;
  reason?: string;
  now?: number;
}

export interface TransferHandleArgs {
  /** Direction-specific shape; the substrate is symmetric: the
   *  outgoing side calls `transferHandleOut` with the incoming
   *  publisher's signature attached, the incoming side mints that
   *  signature via `signTransferAcceptance`. The transport between
   *  the two publishers is out-of-band (Slack / email / shared
   *  paste). */
  incoming_publisher_id: string;
  /** The incoming side's signature over the canonical-JSON of the
   *  transfer payload `{ outgoing_publisher_id, incoming_publisher_id,
   *  handle, nonce, timestamp }`. Produced by the incoming side via
   *  `signTransferAcceptance` (Codex P8 correctness fold #6). */
  incoming_signature: string;
  /** Per-request unique identifier produced at the outgoing side +
   *  copied by the incoming side when it mints `incoming_signature`.
   *  Both signatures cover the same nonce + timestamp. */
  nonce: string;
  /** Unix-ms timestamp shared by both signatures. */
  transfer_timestamp: number;
  changed_by_client_id: string;
  reason?: string;
  now?: number;
}

/** Codex P8 correctness fold #6 — the incoming publisher's substrate
 *  signs the transfer-acceptance payload with its `server_identity_key`
 *  via this rpc. The signature is then handed back to the outgoing
 *  publisher (out-of-band) who attaches it to the `transferHandleOut`
 *  call. */
export interface SignTransferAcceptanceArgs {
  outgoing_publisher_id: string;
  /** The local publisher_id of the incoming side (the side calling
   *  this rpc). */
  incoming_publisher_id: string;
  handle: string;
  nonce: string;
  timestamp: number;
}

export interface SignTransferAcceptanceResult {
  signature: string;
  /** Echo of the canonical signing payload for round-trip
   *  verification by the outgoing side. */
  payload: {
    outgoing_publisher_id: string;
    incoming_publisher_id: string;
    handle: string;
    nonce: string;
    timestamp: number;
  };
}

export interface AbuseReportArgs extends Omit<HandleAbuseReportRequest, 'reporter_publisher_id' | 'signature' | 'nonce' | 'timestamp'> {
  /** The reporter's publisher_id is filled by the substrate at call
   *  time so callers can't impersonate a different publisher. The
   *  state machine looks the publisher up from the local store +
   *  signs the report payload (Codex P8 security fold #3). */
  changed_by_client_id: string;
  /** Override clock — tests pin `timestamp`. */
  now?: number;
}

export interface HandleStateMachine {
  /** Read the current state. Lazy-loads + initializes from the cloud
   *  when the local store is empty + the cloud has a record. */
  current(): Promise<HandleState | null>;
  /** Reserve the initial handle. Used at first boot only — Codex P8
   *  correctness fold #1: refuses when local state already exists so
   *  a second call can't overwrite the publisher_id + history. */
  reserveInitial(args: ReserveHandleArgs): Promise<HandleStateMachineResult<HandleReserveResponse>>;
  /** Change the current handle. Validates locally, posts to cloud,
   *  audits + broadcasts on cloud confirmation. */
  changeHandle(args: ChangeHandleArgs): Promise<HandleStateMachineResult<HandleChangeResponse>>;
  /** Corrective re-anchor after a `server_identity_key` rotation — the
   *  deliberate, audited path the Pro provisioner drives when the
   *  persisted `publisher_id` no longer matches the live identity (the
   *  binding has been re-minted under the new fingerprint, so the old
   *  reservation no longer represents this server). Re-reserves the
   *  binding handle under the LIVE fingerprint via a fresh cloud reserve
   *  (the live identity owns nothing at the cloud yet — `changeHandle`'s
   *  ownership precondition can't be met across an identity change).
   *  Requires existing reserved state (refuses with `handle_state_missing`
   *  on a fresh server — that's `reserveInitial`'s job). Mutates local
   *  state ONLY after cloud confirmation (never invents a reservation),
   *  then audits (high-assurance) + broadcasts. */
  reReserve(args: ReReserveHandleArgs): Promise<HandleStateMachineResult<HandleReserveResponse>>;
  /** Transfer the handle to a new publisher. Calls the cloud with
   *  the dual signatures; on confirmation, the local store records
   *  the release with `transferred_out` reason. */
  transferHandleOut(args: TransferHandleArgs): Promise<HandleStateMachineResult<HandleTransferResponse>>;
  /** Codex P8 correctness fold #6 — the incoming side mints its
   *  `incoming_signature` via this rpc. Pure signing primitive; no
   *  cloud round-trip + no local state mutation (the local state
   *  changes when the outgoing side's `transferHandleOut` lands at
   *  the cloud + the broadcast bus fires `handle_changed` for the
   *  incoming publisher). */
  signTransferAcceptance(args: SignTransferAcceptanceArgs): SignTransferAcceptanceResult;
  /** Submit an abuse report against another publisher's handle.
   *  When local state exists + carries a publisher_id, the rpc
   *  signs the report so the cloud can attest reporter identity. */
  reportAbuse(args: AbuseReportArgs): Promise<HandleStateMachineResult<HandleAbuseReportResponse>>;
  /** Apply a cloud-broadcast lifecycle update (subscription lapsed,
   *  grace started, grace ended). Idempotent. */
  applyLifecycleUpdate(update: { state: HandleSubscriptionState; grace_until?: number; now?: number }): Promise<HandleState>;
}

export interface CreateHandleStateMachineOptions {
  store: HandleStateStore;
  cloud: CloudHandleClient;
  audit: HandleAuditEmitter;
  broadcaster: HandleBroadcaster;
  /** Server identity key — signs cloud rpc envelopes + transfer
   *  payloads. */
  serverIdentity: () => Ed25519Keypair;
  /** Set of canonicalized existing handles for confusable detection
   *  + early `handle_taken` rejection. The state machine layers a
   *  pre-flight validate on top of the cloud's authoritative check;
   *  for the local check we only need a snapshot — fed through this
   *  resolver because production may want to consult a recent cache. */
  existingHandles?: () => Promise<ReadonlySet<string>> | ReadonlySet<string>;
  clock?: () => number;
  /** Optional listener invoked synchronously after every state mutation
   *  (reserve / change / transfer / lifecycle update). Production wires
   *  this in bin.ts to mirror the current publisher_id into the
   *  `PublisherIdResolver` ref consumed by the ACME factory — every
   *  reservation / re-reservation / transfer-in propagates on the next
   *  renewal cycle without rebooting. Tests can use it to assert
   *  persistence ordering. Errors are swallowed so a listener bug never
   *  aborts the mutation. */
  onStateChanged?: (state: HandleState) => void;
}

export const createHandleStateMachine = (
  opts: CreateHandleStateMachineOptions,
): HandleStateMachine => {
  const clock = opts.clock ?? Date.now;
  let cached: HandleState | null = null;

  const loadOrInit = async (): Promise<HandleState | null> => {
    if (cached) return cached;
    const persisted = await opts.store.load();
    cached = persisted ?? null;
    return cached;
  };

  const persist = async (state: HandleState): Promise<HandleState> => {
    await opts.store.save(state);
    cached = state;
    if (opts.onStateChanged) {
      try {
        opts.onStateChanged(state);
      } catch {
        // Listener errors must not abort a successful mutation — the
        // state is already persisted + the next loadOrInit will read
        // the fresh row. Swallow so the rpc surface stays clean.
      }
    }
    return state;
  };

  const mintNonce = (): string => randomUUID();

  const buildSignedReserveRequest = (
    publisher_id: string,
    handle: string,
    timestamp: number,
  ): HandleReserveRequest => {
    const nonce = mintNonce();
    const payload = { publisher_id, handle, nonce, timestamp };
    const signature = ed25519Sign(opts.serverIdentity(), canonicalJSONStringify(payload));
    return { ...payload, signature };
  };

  const buildSignedChangeRequest = (
    publisher_id: string,
    current_handle: string,
    new_handle: string,
    timestamp: number,
  ): HandleChangeRequest => {
    const nonce = mintNonce();
    const payload = { publisher_id, current_handle, new_handle, nonce, timestamp };
    const signature = ed25519Sign(opts.serverIdentity(), canonicalJSONStringify(payload));
    return { ...payload, signature };
  };

  const validateLocally = async (
    candidate: string,
  ): Promise<{ ok: true; canonical: string } | { ok: false; error: HandleErrorCode; message?: string }> => {
    const existing = opts.existingHandles ? await opts.existingHandles() : new Set<string>();
    const result = validateHandle(candidate, { existing_handles: existing });
    if (!result.ok) {
      // Issue precedence: prefer the more specific impersonation /
      // collision errors when present. The validator accumulates all
      // issues without short-circuiting, but a non-ASCII confusable
      // (e.g. 'alicé') trips both `handle_format` AND
      // `handle_confusable_to_existing` — the second is the more
      // informative surface for the user, so we hoist it above
      // format. Reserved-name + taken get the same hoist treatment
      // because they're definitive collisions.
      const ranked = ['handle_taken', 'handle_confusable_to_existing', 'handle_reserved'] as const;
      for (const code of ranked) {
        const match = result.issues.find((i) => i.code === code);
        if (match) {
          return { ok: false, error: match.code, message: match.message };
        }
      }
      const first = result.issues[0];
      if (first === undefined) {
        return { ok: false, error: 'handle_validation_error' as const };
      }
      return { ok: false, error: first.code, message: first.message };
    }
    return { ok: true, canonical: result.canonical };
  };

  const reserveInitial: HandleStateMachine['reserveInitial'] = async (args) => {
    // Codex P8 correctness fold #1 — refuse when local state already
    // exists. A second `reserveInitial` would otherwise overwrite the
    // publisher_id + history with a fresh one-row history. Subsequent
    // reservations after the initial one go through `changeHandle`.
    const existing = await loadOrInit();
    if (existing && existing.publisher_id !== '') {
      return {
        ok: false,
        error: 'handle_already_reserved',
        message: 'reserveInitial called with non-empty local state — use changeHandle instead',
      };
    }
    const localCheck = await validateLocally(args.handle);
    if (!localCheck.ok) {
      return { ok: false, error: localCheck.error, ...(localCheck.message ? { message: localCheck.message } : {}) };
    }
    const handle = localCheck.canonical;
    const ts = args.now ?? clock();
    const req = buildSignedReserveRequest(args.publisher_id, handle, ts);
    const result = await opts.cloud.reserveHandle(req);
    if (!result.ok) {
      return { ok: false, error: result.error, ...(result.message ? { message: result.message } : {}) };
    }
    const historyRow: HandleHistoryEntry = {
      handle,
      reserved_at: result.data.reserved_at,
      reason: 'reserved',
      ...(args.reason ? { note: args.reason } : {}),
    };
    const next: HandleState = {
      publisher_id: args.publisher_id,
      current_handle: handle,
      handle_history: [historyRow],
      subscription_state: result.data.state,
      last_synced_at: result.data.reserved_at,
      ...(result.data.zone !== undefined ? { ddns_zone: result.data.zone } : {}),
    };
    await persist(next);
    await opts.audit.log({
      activity_id: '',
      timestamp: result.data.reserved_at,
      action: 'handle_change',
      target: handle,
      detail: handleAuditDetail({
        kind: 'reserved',
        previous_handle: undefined,
        next_handle: handle,
        note: args.reason,
      }),
    });
    return { ok: true, state: next, data: result.data };
  };

  const changeHandle: HandleStateMachine['changeHandle'] = async (args) => {
    const state = await loadOrInit();
    if (!state) {
      return { ok: false, error: 'handle_state_missing' };
    }
    const localCheck = await validateLocally(args.next_handle);
    if (!localCheck.ok) {
      return { ok: false, error: localCheck.error, ...(localCheck.message ? { message: localCheck.message } : {}) };
    }
    const next_handle = localCheck.canonical;
    if (next_handle === state.current_handle) {
      return { ok: false, error: 'handle_validation_error', message: 'next_handle equals current_handle' };
    }
    const ts = args.now ?? clock();
    const req = buildSignedChangeRequest(state.publisher_id, state.current_handle, next_handle, ts);
    const result = await opts.cloud.changeHandle(req);
    if (!result.ok) {
      return { ok: false, error: result.error, ...(result.message ? { message: result.message } : {}) };
    }
    const releasedAt = result.data.reserved_at;
    const previous = state.current_handle;
    const updatedHistory = state.handle_history.map((h, idx) => {
      // Mark the existing current-handle row as released.
      if (idx === state.handle_history.length - 1 && h.handle === previous && h.released_at === undefined) {
        return { ...h, released_at: releasedAt };
      }
      return h;
    });
    const newRow: HandleHistoryEntry = {
      handle: next_handle,
      reserved_at: releasedAt,
      reason: 'changed',
      ...(args.reason ? { note: args.reason } : {}),
    };
    updatedHistory.push(newRow);
    const next: HandleState = {
      ...state,
      current_handle: next_handle,
      handle_history: updatedHistory,
      last_synced_at: releasedAt,
      // The cloud carries the handle's zone across a change; mirror it when
      // present, else `...state` retains the prior label (older cloud).
      ...(result.data.zone !== undefined ? { ddns_zone: result.data.zone } : {}),
    };
    await persist(next);
    await opts.audit.log({
      activity_id: '',
      timestamp: releasedAt,
      action: 'handle_change',
      target: next_handle,
      detail: handleAuditDetail({
        kind: 'changed',
        previous_handle: previous,
        next_handle,
        note: args.reason,
      }),
    });
    await opts.broadcaster.broadcast({
      type: 'handle_changed',
      publisher_id: state.publisher_id,
      previous_handle: previous,
      current_handle: next_handle,
      changed_at: releasedAt,
    });
    return { ok: true, state: next, data: result.data };
  };

  const reReserve: HandleStateMachine['reReserve'] = async (args) => {
    const state = await loadOrInit();
    // Corrective re-anchor ONLY — there must be an EXISTING reserved
    // state to re-anchor. A fresh server (empty publisher_id) has nothing
    // to correct and goes through `reserveInitial`. Refuse rather than
    // silently fabricate a reservation under a rotated identity.
    if (!state || state.publisher_id === '') {
      return {
        ok: false,
        error: 'handle_state_missing',
        message: 'reReserve requires an existing reserved state — use reserveInitial',
      };
    }
    const localCheck = await validateLocally(args.handle);
    if (!localCheck.ok) {
      return { ok: false, error: localCheck.error, ...(localCheck.message ? { message: localCheck.message } : {}) };
    }
    const handle = localCheck.canonical;
    const ts = args.now ?? clock();
    // Sign with the LIVE server identity, claiming the live fingerprint as
    // publisher_id. The cloud verifies the signature against
    // `auth:<args.publisher_id>` — the authority row the auth-worker
    // (re)created at the post-rotation rebind — so only a request that
    // BOTH carries the live fingerprint AND is signed by the live key can
    // land. The old reservation strands cloud-side under the rotated-away
    // publisher_id until the rebind / grace flow migrates or releases it
    // (an auth-worker concern); a stranded old reservation surfaces here
    // as a cloud `handle_taken`, which the caller retries.
    const req = buildSignedReserveRequest(args.publisher_id, handle, ts);
    const result = await opts.cloud.reserveHandle(req);
    if (!result.ok) {
      return { ok: false, error: result.error, ...(result.message ? { message: result.message } : {}) };
    }
    const reservedAt = result.data.reserved_at;
    const previous = state.current_handle;
    const previousPublisherId = state.publisher_id;
    // Provenance is load-bearing (the history row never auto-truncates),
    // so preserve prior rows: close the current one + append the
    // re-anchor row. `publisher_id` flips to the rotated-to identity —
    // immutability is scoped "per server-identity-key" (§ A.5.1), so a
    // `server_identity_key` rotation legitimately mints a new one.
    const updatedHistory = state.handle_history.map((h, idx) =>
      idx === state.handle_history.length - 1 && h.released_at === undefined
        ? { ...h, released_at: reservedAt }
        : h,
    );
    const reanchorNote = args.reason ?? 'identity rotation re-anchor';
    const newRow: HandleHistoryEntry = {
      handle,
      reserved_at: reservedAt,
      // No dedicated `rotation` reason in the closed list — classify as a
      // change (the active reservation changed) + carry the rotation
      // detail in the free-text note.
      reason: 'changed',
      note: reanchorNote,
    };
    updatedHistory.push(newRow);
    // Mirror `reserveInitial`: take the lifecycle stamp from the cloud's
    // authoritative reserve response (a fresh reserve is `active`), NOT the
    // pre-correction local state. A stale `grace` / `released`
    // `subscription_state` (or a lingering `grace_until`) carried forward
    // via `...state` would keep the DDNS poller + cert-stack snapshot
    // helpers treating the freshly re-anchored handle as lapsed — the
    // provisioner would log `corrected` while DDNS/ACME stayed disabled. A
    // fresh active reserve has no grace deadline, so `grace_until` is
    // dropped (not spread).
    // The re-anchor reserves the SAME handle, so its zone is continuous —
    // prefer the cloud's fresh label, fall back to the prior local one (older
    // cloud omits it). Unlike `subscription_state`, the zone is a stable handle
    // attribute, not lifecycle state, so carrying it forward is correct.
    const reReservedZone = result.data.zone ?? state.ddns_zone;
    const next: HandleState = {
      publisher_id: args.publisher_id,
      current_handle: handle,
      handle_history: updatedHistory,
      subscription_state: result.data.state,
      last_synced_at: reservedAt,
      ...(reReservedZone !== undefined ? { ddns_zone: reReservedZone } : {}),
    };
    await persist(next);
    await opts.audit.log({
      activity_id: '',
      timestamp: reservedAt,
      action: 'handle_change',
      target: handle,
      detail: handleAuditDetail({
        kind: 'changed',
        previous_handle: previous,
        next_handle: handle,
        note: `${reanchorNote} (publisher_id ${previousPublisherId} → ${args.publisher_id})`,
      }),
    });
    await opts.broadcaster.broadcast({
      type: 'handle_changed',
      publisher_id: args.publisher_id,
      previous_handle: previous,
      current_handle: handle,
      changed_at: reservedAt,
    });
    return { ok: true, state: next, data: result.data };
  };

  const signTransferAcceptance: HandleStateMachine['signTransferAcceptance'] = (
    args,
  ) => {
    const payload = {
      outgoing_publisher_id: args.outgoing_publisher_id,
      incoming_publisher_id: args.incoming_publisher_id,
      handle: args.handle,
      nonce: args.nonce,
      timestamp: args.timestamp,
    };
    const signature = ed25519Sign(
      opts.serverIdentity(),
      canonicalJSONStringify(payload),
    );
    return { signature, payload };
  };

  const transferHandleOut: HandleStateMachine['transferHandleOut'] = async (args) => {
    const state = await loadOrInit();
    if (!state) {
      return { ok: false, error: 'handle_state_missing' };
    }
    const transferPayload = {
      outgoing_publisher_id: state.publisher_id,
      incoming_publisher_id: args.incoming_publisher_id,
      handle: state.current_handle,
      nonce: args.nonce,
      timestamp: args.transfer_timestamp,
    };
    const outgoing_signature = ed25519Sign(
      opts.serverIdentity(),
      canonicalJSONStringify(transferPayload),
    );
    const req: HandleTransferRequest = {
      ...transferPayload,
      outgoing_signature,
      incoming_signature: args.incoming_signature,
    };
    const result = await opts.cloud.transferHandle(req);
    if (!result.ok) {
      return { ok: false, error: result.error, ...(result.message ? { message: result.message } : {}) };
    }
    const transferredAt = result.data.transferred_at;
    const previous = state.current_handle;
    const updatedHistory = state.handle_history.map((h, idx) => {
      if (idx === state.handle_history.length - 1 && h.handle === previous && h.released_at === undefined) {
        const next: HandleHistoryEntry = {
          ...h,
          released_at: transferredAt,
          transfer_counterparty_publisher_id: args.incoming_publisher_id,
          reason: 'transferred_out',
        };
        if (args.reason !== undefined) next.note = args.reason;
        return next;
      }
      return h;
    });
    const next: HandleState = {
      ...state,
      // The outgoing publisher's handle becomes empty after transfer;
      // the local store represents this as `current_handle === ''`.
      // The substrate refuses to mint reservations on an empty handle,
      // so this is a correct terminal state until the user reserves
      // anew.
      current_handle: '',
      handle_history: updatedHistory,
      last_synced_at: transferredAt,
    };
    await persist(next);
    await opts.audit.log({
      activity_id: '',
      timestamp: transferredAt,
      action: 'handle_change',
      target: previous,
      detail: handleAuditDetail({
        kind: 'transferred_out',
        previous_handle: previous,
        next_handle: undefined,
        note: args.reason,
        counterparty: args.incoming_publisher_id,
      }),
    });
    await opts.broadcaster.broadcast({
      type: 'handle_changed',
      publisher_id: state.publisher_id,
      previous_handle: previous,
      current_handle: '',
      changed_at: transferredAt,
      transfer_counterparty_publisher_id: args.incoming_publisher_id,
    });
    return { ok: true, state: next, data: result.data };
  };

  const reportAbuse: HandleStateMachine['reportAbuse'] = async (args) => {
    const state = await loadOrInit();
    const detailBytes = Buffer.byteLength(args.detail, 'utf8');
    if (detailBytes > 4 * 1024) {
      return { ok: false, error: 'handle_abuse_detail_too_large', message: 'detail > 4 KB' };
    }
    const reported_handle = canonicalizeHandle(args.reported_handle);
    // Codex P8 security fold #3 — when the local publisher has a
    // server identity, sign the report so the cloud can attest the
    // reporter id. Anonymous reports omit publisher_id + signature
    // + nonce + timestamp entirely; cloud accepts but does not stamp
    // a reporter id.
    let req: HandleAbuseReportRequest;
    if (state && state.publisher_id !== '') {
      const ts = args.now ?? clock();
      const nonce = mintNonce();
      const signedPayload = {
        reported_handle,
        kind: args.kind,
        detail: args.detail,
        reporter_publisher_id: state.publisher_id,
        nonce,
        timestamp: ts,
      };
      const signature = ed25519Sign(
        opts.serverIdentity(),
        canonicalJSONStringify(signedPayload),
      );
      req = {
        ...signedPayload,
        signature,
      };
    } else {
      req = {
        reported_handle,
        kind: args.kind,
        detail: args.detail,
      };
    }
    const result = await opts.cloud.abuseReport(req);
    if (!result.ok) {
      return { ok: false, error: result.error, ...(result.message ? { message: result.message } : {}) };
    }
    // Codex P8 contract fold #4 — abuse report doesn't mutate state;
    // we omit `state` from the success envelope rather than fabricate
    // a sentinel.
    return state
      ? { ok: true, state, data: result.data }
      : { ok: true, data: result.data };
  };

  const applyLifecycleUpdate: HandleStateMachine['applyLifecycleUpdate'] = async (update) => {
    const state = await loadOrInit();
    if (!state) {
      throw new Error('applyLifecycleUpdate: no local handle state');
    }
    const ts = update.now ?? clock();
    const next: HandleState = {
      ...state,
      subscription_state: update.state,
      ...(update.grace_until !== undefined ? { grace_until: update.grace_until } : {}),
      last_synced_at: ts,
    };
    if (update.state === 'released') {
      // Append a history row marking the release.
      const updatedHistory: HandleHistoryEntry[] = state.handle_history.map((h, idx) => {
        if (idx === state.handle_history.length - 1 && h.released_at === undefined) {
          const closed: HandleHistoryEntry = {
            ...h,
            released_at: ts,
            reason: 'released_after_grace',
          };
          return closed;
        }
        return h;
      });
      next.handle_history = updatedHistory;
      next.current_handle = '';
    }
    await persist(next);
    return next;
  };

  return {
    current: loadOrInit,
    reserveInitial,
    changeHandle,
    reReserve,
    transferHandleOut,
    signTransferAcceptance,
    reportAbuse,
    applyLifecycleUpdate,
  };
};

// ────────────────────────────────────────────────────────────────
// Audit detail helpers
// ────────────────────────────────────────────────────────────────

interface HandleAuditDetailArgs {
  kind: HandleHistoryReason;
  previous_handle?: string;
  next_handle?: string;
  /** Free-text user-supplied note (Codex P8 contract fold #1 split
   *  the substrate's closed-list reason from this user-facing
   *  string). */
  note?: string;
  counterparty?: string;
}

const handleAuditDetail = (args: HandleAuditDetailArgs): string => {
  const parts: string[] = [`kind=${args.kind}`];
  if (args.previous_handle !== undefined) parts.push(`prev=${args.previous_handle || '<none>'}`);
  if (args.next_handle !== undefined) parts.push(`next=${args.next_handle || '<none>'}`);
  if (args.counterparty !== undefined) parts.push(`counterparty=${args.counterparty}`);
  if (args.note !== undefined && args.note.length > 0) parts.push(`note=${args.note}`);
  return parts.join('; ');
};

// ────────────────────────────────────────────────────────────────
// Re-exports for callers
// ────────────────────────────────────────────────────────────────

export { HANDLE_RPC_REPLAY_WINDOW_MS, HANDLE_OLD_REDIRECT_WINDOW_MS, HANDLE_GRACE_PERIOD_MS };
