/** D-148 § A.3.1 + § A.3.2 — server-side bridge command dispatcher
 *  (D-169 P0 Slice 2A amends per-command authority signing;
 *  D-169 P0 Slice 4 § N.9 / A.8 widens to multi-bridge dispatch).
 *
 *  Per bridge command:
 *
 *   1. Build a `BridgeCommand` carrying the action + target domain
 *      pattern as unsigned envelope fields. Per-command authority
 *      signing retires (D-169 § N.3 / DL-1); the bridge gates per
 *      action via the two-way grant intersection (§ A.7) — ingredient's
 *      signed `domain_allowlist` × user's per-ingredient grant.
 *   2. **Multi-bridge eligibility + iteration order (D-169 § N.9):**
 *      - Filter the connected bridge set by
 *        `BridgeCapabilityProfile.granted_origins` — only bridges whose
 *        granted origins include a pattern matching the resolved
 *        target domain pattern are eligible.
 *      - Order by recency of last successful dispatch for the SAME
 *        `(bridge_client_token_id, target_pattern)` tuple, with WS
 *        attachment recency as a tiebreaker. The "last successful
 *        dispatch" lookup is a thin read against the activity log —
 *        no separate per-pair success-history table (spec § A.8 / DL-7).
 *   3. **Sequential fall-through with capacity_gap accumulation:**
 *      try eligible bridges one at a time. On a `BridgeResult` whose
 *      `error.code` is one of `capacity_gap_*`, record the per-bridge
 *      `gap_reason` and continue to the next eligible bridge. On
 *      success, log a `bridge_dispatch_succeeded` activity (informs
 *      next dispatch's iteration order) and return immediately. On
 *      non-gap error or transport failure, return immediately.
 *   4. **Aggregate capacity_gap** when every eligible bridge returned
 *      a capacity_gap result: surface
 *      `{ kind: 'aggregate_capacity_gap', bridges: [{ bridge_id,
 *      bridge_label, gap_reason }] }` so the user-visible remediation
 *      surface (D-169 P2 side-panel display-only cards) can render
 *      per-bridge actionable detail.
 *   5. On `429 queue_full` from the bridge, retry with exponential
 *      backoff (200 ms initial, doubling to 5 s max) — the bridge's
 *      FIFO is the rate-limiter; the server's scheduler is the
 *      queue-of-queues. 429 retries stay within a single bridge
 *      attempt; the fall-through only kicks in on capacity_gap_*.
 *   6. On bridge offline / no connected bridge / no eligible bridge,
 *      return the legacy `bridge_online` capacity-gap signal so
 *      existing engine paths don't have to special-case multi-bridge
 *      vs single-bridge gap shapes when no bridges can serve at all.
 *
 *  This dispatcher does not own the WS transport — it composes with
 *  whatever per-bridge send hook the WS rpc layer provides. The
 *  result-correlation lookup is also injected so the rpc layer can
 *  wire it to its inbound message router. The audit log dependency
 *  is optional; absent it the iteration order degrades to WS recency
 *  alone (no success-history input).
 *
 *  Pure async; tests inject in-memory transport + clocks + audit log.
 */

import {
  BRIDGE_COMMAND_DEFAULT_TIMEOUT_MS,
  BRIDGE_COMMAND_MAX_TIMEOUT_MS,
  isPatternWithinGrantedOrigins,
  RpcError,
  type AggregateCapacityGap,
  type BridgeAction,
  type BridgeCancelCommand,
  type BridgeCapacityGap,
  type BridgeCommand,
  type BridgeDocumentIdentity,
  type BridgeErrorCode,
  type BridgeIngredientRef,
  type BridgeResult,
  type BridgeWireEnvelope,
} from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';
import { assertPreapprovalOrdinaryRun } from '../preapproval-io-context.js';
import type { BridgeConnectionRecord, BridgeRegistry } from './registry.js';

export interface BridgeSendResult {
  ok: boolean;
  /** When `ok === false`, one of the closed-list reasons.
   *
   *   - `bridge_offline` — no transport for the requested bridge.
   *   - `queue_full` — bridge returned 429.
   *   - `transport_error` — write to transport threw. */
  reason?: 'bridge_offline' | 'queue_full' | 'transport_error';
  detail?: string;
}

export interface BridgeTransport {
  /** Send a typed envelope to a specific bridge. Returns 429-shape
   *  on queue_full + offline-shape on no-connection. */
  send(client_token_id: string, envelope: BridgeWireEnvelope): Promise<BridgeSendResult>;
  /** Cancel an in-flight command on a specific bridge. */
  cancel(client_token_id: string, cancel: BridgeCancelCommand): Promise<BridgeSendResult>;
}

export type { BridgeWireEnvelope };

export interface BridgeResultListener {
  /** Resolves when the bridge returns a BridgeResult for the given
   *  command_id. Caller times out via `timeout_ms`. The wire layer
   *  routes inbound result frames to this resolver. */
  awaitResult(command_id: string, timeout_ms: number): Promise<BridgeResult | null>;
  /** Inbound — call when a result frame arrives. */
  resolveResult(result: BridgeResult): void;
  /** Cancel a pre-registered awaitResult slot before the timeout
   *  fires — used by the dispatcher to clean up after a transport
   *  failure prevents the command from ever being sent. The
   *  pre-registered promise resolves to null. */
  cancelAwait?(command_id: string): void;
  /** D-169 P0 follow-on — drain every pending await on shutdown
   *  (Codex 2026-05-28 Angle 2 fold). Each pending promise resolves
   *  to null so callers see a clean "no result" outcome rather than
   *  hanging up to `timeout_ms + 5000` (up to ~65s with the max
   *  BRIDGE_COMMAND_MAX_TIMEOUT_MS = 60s). Wired into the ws-server's
   *  `close()` alongside the legacy `aiDelegations.clear` / chat /
   *  kernel cleanup. */
  clear?(): void;
}

export interface DispatchRequest {
  recipe_run_id: string;
  step_id: string;
  ingredient: BridgeIngredientRef;
  action: BridgeAction;
  args: Record<string, unknown>;
  expects_output_keys: string[];
  /** Time budget for the bridge to execute. Default
   *  `BRIDGE_COMMAND_DEFAULT_TIMEOUT_MS` (30 s); max
   *  `BRIDGE_COMMAND_MAX_TIMEOUT_MS` (60 s). Server clamps. */
  timeout_ms?: number;
  /** Stable idempotency key — typically `(recipe_run_id, step_id)`
   *  hash so retries route to the same key. */
  idempotency_key: string;
  /** Optional preferred bridge label. */
  preferred_bridge_label?: string;
  /** Codex P2 #5 fold (D-169 P0 Slice 2A amends — was "BridgeAuthority
   *  binds"; per-command authority signing retires). Explicit Chrome
   *  match-pattern the dispatched command targets; must be a member
   *  of the ingredient's signed allowlist; otherwise the dispatcher
   *  short-circuits with capacity_gap before send. When omitted, the
   *  dispatcher tries `args.target_url` → first allowlist entry. */
  target_domain_pattern?: string;
}

export type CapacityGapReason =
  | 'bridge_online'
  | 'bridge_label_unavailable';

export type DispatchOutcome =
  | {
      kind: 'completed';
      result: BridgeResult;
      bridge_client_token_id: string;
      attempts: number;
    }
  | {
      kind: 'capacity_gap';
      capacity_gap: { kind: 'bridge_online' };
      reason: CapacityGapReason;
      attempts: number;
    }
  | {
      kind: 'timeout';
      command_id: string;
      attempts: number;
    }
  /** D-169 P0 Slice 4 § N.9 / A.8 — aggregate gap variant emitted
   *  when 1+ eligible bridges all return per-bridge `capacity_gap_*`
   *  results. Sibling to the legacy `'capacity_gap'` variant — that
   *  one stays the wire shape when *zero* bridges are eligible (no
   *  bridge connected, preferred label missing, no granted origin
   *  match). The two surfaces are mutually exclusive: zero-eligible
   *  → `'capacity_gap'`; non-zero-eligible-all-gap → `'aggregate_capacity_gap'`. */
  | {
      kind: 'aggregate_capacity_gap';
      aggregate: AggregateCapacityGap;
      attempts: number;
    };

export interface DispatcherOptions {
  registry: BridgeRegistry;
  transport: BridgeTransport;
  listener: BridgeResultListener;
  /** Generates the `command_id` for a fresh dispatch. Defaults to a
   *  cryptographically random helper. Tests inject a deterministic
   *  generator. */
  generateCommandId?: () => string;
  /** Wall-clock — used for the inflight bookkeeping clock only after
   *  D-169 P0 Slice 2A retired the authority `issued_at` field. */
  now?: () => number;
  /** Sleep helper for retry backoff. */
  sleep?: (ms: number) => Promise<void>;
  /** Initial backoff ms when retrying after 429. Default 200. */
  initial_backoff_ms?: number;
  /** Max backoff ms. Default 5000. */
  max_backoff_ms?: number;
  /** Max retry attempts before giving up. Default 6 (≈ 6 sec total
   *  with exponential backoff). */
  max_attempts?: number;
  /** D-169 P0 Slice 4 § A.8 — optional audit log. Drives two roles:
   *  (a) `lastSuccessfulBridgeDispatch` reads on each dispatch supply
   *  the per-(bridge, pattern) recency input for `orderForDispatch`;
   *  (b) on success, the dispatcher emits a
   *  `'bridge_dispatch_succeeded'` activity row so the *next* dispatch
   *  sees the success in its iteration order. When absent, iteration
   *  order degrades to WS attachment recency alone — useful in tests
   *  and acceptable in production paths that don't yet inject a log. */
  auditLog?: AuditLogStore;
}

const defaultGenerateCommandId = (): string => {
  // 16-byte random hex; 32 chars; collision-safe for the per-bridge
  // command space.
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const clamp = (timeout_ms: number | undefined): number => {
  if (typeof timeout_ms !== 'number' || !Number.isFinite(timeout_ms) || timeout_ms <= 0) {
    return BRIDGE_COMMAND_DEFAULT_TIMEOUT_MS;
  }
  if (timeout_ms > BRIDGE_COMMAND_MAX_TIMEOUT_MS) {
    return BRIDGE_COMMAND_MAX_TIMEOUT_MS;
  }
  return timeout_ms;
};

/** Resolve which `target_domain_pattern` the BridgeCommand carries
 *  (D-169 P0 Slice 2A — was "the BridgeAuthority binds"; per-command
 *  signing retires). Caller may pass `target_domain_pattern` directly
 *  OR encode the target via `args.target_url`; otherwise we use the
 *  first allowlist entry as the conservative default. The selected
 *  pattern must appear in the ingredient's signed `domain_allowlist`
 *  — if not, return null so the dispatcher emits a capacity_gap
 *  before send.
 *
 *  This is the server-side mirror of the bridge's two-way grant
 *  intersection (§ A.7): the bridge will reject a command whose
 *  target_domain_pattern is outside the user's grant. Validating
 *  server-side saves a round-trip + denies an attacker who controls
 *  `request.args.target_url` from manipulating the scope. */
const resolveTargetDomainPattern = (request: DispatchRequest): string | null => {
  const allowlist = request.ingredient.domain_allowlist;
  if (allowlist.length === 0) return null;

  // Explicit caller-supplied pattern wins.
  const explicit = (request as { target_domain_pattern?: string }).target_domain_pattern;
  if (typeof explicit === 'string' && explicit.length > 0) {
    return allowlist.includes(explicit) ? explicit : null;
  }

  // target_url fallback — match against allowlist entries by host
  // prefix; pick the first matching pattern.
  const target_url = request.args.target_url;
  if (typeof target_url === 'string' && target_url.length > 0) {
    const matched = allowlist.find((pattern) => urlMatchesPattern(target_url, pattern));
    if (matched) return matched;
    return null; // explicit target that doesn't match → reject
  }

  // Conservative default: first allowlist entry.
  return allowlist[0];
};

/** Naive Chrome-match-pattern check for resolveTargetDomainPattern.
 *  The bridge does the rigorous version; this server-side helper
 *  just needs to map a target_url to the right allowlist pattern. */
const urlMatchesPattern = (url: string, pattern: string): boolean => {
  // Pattern format: <scheme>://<host>/<path>
  const m = pattern.match(/^([\w*]+):\/\/([^/]+)(\/.*)?$/);
  if (!m) return false;
  const [, scheme, host] = m;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (scheme !== '*' && scheme !== parsed.protocol.slice(0, -1)) return false;
  if (host === '*') return true;
  if (host.startsWith('*.')) {
    const rest = host.slice(2);
    return parsed.hostname === rest || parsed.hostname.endsWith('.' + rest);
  }
  return parsed.hostname === host;
};

export interface BridgeDispatcher {
  dispatch(request: DispatchRequest, reviewed?: ReviewedBridgeDispatch): Promise<DispatchOutcome>;
  describeDocument?(request: DispatchRequest): ReviewedBridgeBinding | null;
  cancel(command_id: string, reason: string): Promise<BridgeSendResult>;
  /** D-169 P0 follow-on — ownership query for inbound `{kind: 'result'}`
   *  frame routing. The wire layer routes result frames by `command_id`
   *  alone; a malicious authenticated bridge could otherwise resolve
   *  another bridge's in-flight command by guessing the id (32-char
   *  random hex makes blind guessing infeasible, but a bridge that
   *  observes egress traffic in a shared environment could replay
   *  command_ids). The wire layer calls this BEFORE
   *  `listener.resolveResult(...)`; a `false` return drops the frame
   *  silently — the same posture the listener uses when no matching
   *  pending slot exists. Returns `true` iff the dispatcher's inflight
   *  map currently has an entry for `command_id` owned by
   *  `client_token_id` (the bridge attempting to resolve). The inflight
   *  map is populated BEFORE the transport send + cleared on result
   *  resolve / timeout / send-failure, so the check sees the right
   *  owner during the result's in-flight window. */
  canResolve(command_id: string, client_token_id: string): boolean;
}

export interface ReviewedBridgeBinding {
  client_token_id: string;
  document: BridgeDocumentIdentity;
}
/** Passed only by the host's claimed invocation context. It is not an RPC or
 * a BridgeCommand permission field. Every queue-full retry rechecks it. */
export interface ReviewedBridgeDispatch {
  binding: ReviewedBridgeBinding;
  beforeSend(): Promise<void>;
}

// ────────────────────────────────────────────────────────────────
// D-169 P0 Slice 4 § A.8 — multi-bridge helpers
// ────────────────────────────────────────────────────────────────

/** Closed list of `BridgeErrorCode` values that count as capacity gaps
 *  for the multi-bridge fall-through algorithm. A bridge returning one
 *  of these signals "I accepted the command but can't serve it" — the
 *  dispatcher records the gap reason and tries the next eligible
 *  bridge. Non-gap errors (`selector_not_found`, `tab_navigation_blocked`,
 *  `idempotency_violation`, etc.) bubble up directly because a different
 *  bridge can't help. */
const CAPACITY_GAP_ERROR_CODES: ReadonlySet<BridgeErrorCode> = new Set<BridgeErrorCode>([
  'capacity_gap_logged_in',
  'capacity_gap_tab_unavailable',
  'capacity_gap_permission_missing',
]);

/** WS transport writes complete before the remote bridge can inspect
 *  its queue. The bridge therefore reports the HTTP-429-equivalent as
 *  a transient rejected result; this predicate keeps that control
 *  signal out of normal completed-result handling. */
const isQueueFullResult = (result: BridgeResult): boolean =>
  result.status === 'rejected' && result.error?.code === 'queue_full';

/** True iff the `BridgeResult` represents a capacity gap (status:
 *  'error' AND error.code is one of the `capacity_gap_*` codes). The
 *  multi-bridge dispatcher branches on this to decide
 *  iterate-to-next-bridge vs return-to-caller. */
export const isCapacityGapResult = (result: BridgeResult): boolean => {
  if (result.status !== 'error') return false;
  const code = result.error?.code;
  return code !== undefined && CAPACITY_GAP_ERROR_CODES.has(code);
};

/** Map a `capacity_gap_*` BridgeErrorCode + the request's
 *  target_domain_pattern to the user-facing `BridgeCapacityGap`
 *  variant. The `code` parameter is the bridge's reported gap reason;
 *  `target_pattern` is the resolved Chrome match pattern the command
 *  carried. Falls back to `{ kind: 'bridge_online' }` for unmappable
 *  codes — defense against future variants the helper hasn't been
 *  updated for. */
const mapToCapacityGap = (
  code: BridgeErrorCode | undefined,
  target_pattern: string,
): BridgeCapacityGap => {
  if (code === 'capacity_gap_tab_unavailable') {
    return { kind: 'tab_unavailable', url_pattern: target_pattern };
  }
  if (code === 'capacity_gap_logged_in') {
    return { kind: 'logged_in', site: target_pattern };
  }
  if (code === 'capacity_gap_permission_missing') {
    return { kind: 'permission_missing', permission: target_pattern };
  }
  return { kind: 'bridge_online' };
};

/** D-169 § A.8 — eligibility pre-filter. Returns the subset of
 *  connected bridges whose capability profile's `granted_origins`
 *  list includes a pattern matching the resolved
 *  `target_domain_pattern`. Today the match is exact-membership: the
 *  command's target pattern must appear in the bridge's granted
 *  origins. A future amendment can widen to Chrome-match-pattern
 *  overlap (`'*://*.hubspot.com/*'` granted covers `'*://app.hubspot.com/*'`
 *  command) without changing the call site here. */
export const filterEligible = (
  bridges: BridgeConnectionRecord[],
  target_pattern: string,
): BridgeConnectionRecord[] =>
  bridges.filter((b) =>
    b.capabilities.granted_origins.includes(target_pattern),
  );

/** D-169 § A.8 — iteration ordering. Sorts eligible bridges by:
 *    (a) recency of last successful dispatch for the SAME
 *        `(bridge_client_token_id, target_pattern)` tuple (audit-log-
 *        driven; null when no prior success → ranks last),
 *    (b) WS attachment recency as a tiebreaker.
 *
 *  The audit-log read is a thin per-bridge query through the
 *  optional `auditLog.lastSuccessfulBridgeDispatch` accessor. When
 *  no audit log is wired, every bridge's last-success defaults to
 *  null and the order collapses to WS-recency alone — useful in
 *  tests and any production path that hasn't yet plumbed the log. */
export const orderForDispatch = async (
  bridges: BridgeConnectionRecord[],
  target_pattern: string,
  auditLog: AuditLogStore | undefined,
): Promise<BridgeConnectionRecord[]> => {
  const lastSuccess = new Map<string, number>();
  if (auditLog) {
    for (const b of bridges) {
      try {
        const ts = await auditLog.lastSuccessfulBridgeDispatch(
          b.client_token_id,
          target_pattern,
        );
        if (ts !== null) lastSuccess.set(b.client_token_id, ts);
      } catch {
        // Best-effort — a single read failure doesn't drop the
        // bridge from ordering, just from the success-history input.
      }
    }
  }
  return [...bridges].sort((a, b) => {
    const aHist = lastSuccess.get(a.client_token_id) ?? 0;
    const bHist = lastSuccess.get(b.client_token_id) ?? 0;
    if (aHist !== bHist) return bHist - aHist;
    return b.online_since - a.online_since;
  });
};

/** Outcome of a single per-bridge dispatch attempt. Internal to the
 *  dispatcher — the outer `dispatch` flow translates this into the
 *  exported `DispatchOutcome`. */
type SingleBridgeOutcome =
  | { kind: 'completed'; result: BridgeResult; attempts: number }
  | {
      kind: 'send_failed';
      reason: 'bridge_offline' | 'queue_full' | 'transport_error';
      attempts: number;
    }
  | { kind: 'timeout'; command_id: string; attempts: number };

/** D-148 § A.3 — server-side dispatcher.
 *  D-169 P0 Slice 4 § N.9 / A.8 — multi-bridge eligibility + iteration. */
export const createBridgeDispatcher = (options: DispatcherOptions): BridgeDispatcher => {
  const generateCommandId = options.generateCommandId ?? defaultGenerateCommandId;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const initial_backoff_ms = options.initial_backoff_ms ?? 200;
  const max_backoff_ms = options.max_backoff_ms ?? 5_000;
  const max_attempts = options.max_attempts ?? 6;

  /** Per-command tracking: `command_id → bridge_client_token_id`.
   *  Lets `cancel()` route the cancel envelope to the right bridge
   *  even if the registry's selection changes between dispatch +
   *  cancel. */
  const inflight = new Map<string, string>();

  /** Per-bridge attempt. Owns the command_id mint, listener
   *  pre-registration, 429 retry loop, and result correlation. The
   *  outer `dispatch` flow calls this once per eligible bridge during
   *  the sequential fall-through. The 429 retries stay within a
   *  single bridge — exhausting `max_attempts` returns `send_failed`
   *  with `'queue_full'`, which the outer flow surfaces as the legacy
   *  `bridge_online` capacity gap (consistent with single-bridge
   *  pre-Slice-4 behavior). */
  const dispatchToBridge = async (
    bridge_client_token_id: string,
    command_template: Omit<BridgeCommand, 'command_id'>,
    timeout_ms: number,
    beforeSend?: () => Promise<void>,
  ): Promise<SingleBridgeOutcome> => {
    const command_id = generateCommandId();
    const command: BridgeCommand = { ...command_template, command_id };

    let attempt = 0;
    let backoff = initial_backoff_ms;
    while (attempt < max_attempts) {
      attempt++;

      try { if (beforeSend) await beforeSend(); assertPreapprovalOrdinaryRun(); }
      catch (error) { options.listener.cancelAwait?.(command_id); inflight.delete(command_id); throw error; }

      // Register a fresh waiter BEFORE every send. A remote queue_full
      // result consumes the prior slot, and the retry can itself return
      // synchronously on a same-host transport.
      const result_p = options.listener.awaitResult(command_id, timeout_ms + 5_000);
      inflight.set(command_id, bridge_client_token_id);
      let send_result: BridgeSendResult;
      try {
        send_result = await options.transport.send(bridge_client_token_id, {
          kind: 'command',
          command,
        });
      } catch {
        options.listener.cancelAwait?.(command_id);
        inflight.delete(command_id);
        return { kind: 'send_failed', reason: 'transport_error', attempts: attempt };
      }

      if (!send_result.ok) {
        options.listener.cancelAwait?.(command_id);
        if (send_result.reason === 'queue_full' && attempt < max_attempts) {
          await sleep(backoff);
          backoff = Math.min(backoff * 2, max_backoff_ms);
          continue;
        }
        // queue_full exhaustion / bridge_offline / transport_error /
        // unknown → release listener slot + bubble up.
        inflight.delete(command_id);
        return {
          kind: 'send_failed',
          reason: send_result.reason ?? 'transport_error',
          attempts: attempt,
        };
      }

      const result = await result_p;
      if (!result) {
        inflight.delete(command_id);
        return { kind: 'timeout', command_id, attempts: attempt };
      }
      if (isQueueFullResult(result)) {
        if (attempt < max_attempts) {
          await sleep(backoff);
          backoff = Math.min(backoff * 2, max_backoff_ms);
          continue;
        }
        inflight.delete(command_id);
        return { kind: 'send_failed', reason: 'queue_full', attempts: attempt };
      }

      inflight.delete(command_id);
      return { kind: 'completed', result, attempts: attempt };
    }

    // Defensive — every loop path returns or continues.
    inflight.delete(command_id);
    options.listener.cancelAwait?.(command_id);
    return { kind: 'send_failed', reason: 'transport_error', attempts: attempt };
  };

  /** Best-effort emit of the `bridge_dispatch_succeeded` activity row
   *  that drives the *next* dispatch's iteration order through
   *  `orderForDispatch` / `lastSuccessfulBridgeDispatch`. Failure to
   *  log doesn't break the dispatch — the success result still
   *  returns to the caller. */
  const recordSuccess = async (
    bridge_client_token_id: string,
    target_pattern: string,
  ): Promise<void> => {
    if (!options.auditLog) return;
    try {
      await options.auditLog.logActivity({
        activity_id: '',
        timestamp: now(),
        action: 'bridge_dispatch_succeeded',
        target: bridge_client_token_id,
        detail: target_pattern,
      });
    } catch {
      // Best-effort.
    }
  };

  return {
    describeDocument(request) {
      const pattern = resolveTargetDomainPattern(request);
      if (!pattern || !options.registry.documents) return null;
      const candidates: ReviewedBridgeBinding[] = [];
      for (const bridge of options.registry.list()) {
        if (request.preferred_bridge_label && bridge.client_label !== request.preferred_bridge_label) continue;
        if (!isPatternWithinGrantedOrigins(pattern, bridge.capabilities.granted_origins)) continue;
        for (const document of options.registry.documents(bridge.client_token_id)) {
          if (isPatternWithinGrantedOrigins(document.url, [pattern])) candidates.push({ client_token_id: bridge.client_token_id, document });
        }
      }
      // Preparation never selects an arbitrary tab among matching documents.
      return candidates.length === 1 ? candidates[0]! : null;
    },
    async dispatch(request, reviewed) {
      // Resolve the target domain pattern first — a missing /
      // out-of-allowlist pattern short-circuits before any bridge
      // selection (Codex P2 #5 fold; D-169 P0 Slice 2A — was
      // BridgeAuthority's binding).
      const target_domain_pattern = resolveTargetDomainPattern(request);
      if (!target_domain_pattern) {
        return {
          kind: 'capacity_gap',
          capacity_gap: { kind: 'bridge_online' },
          reason: 'bridge_online',
          attempts: 0,
        };
      }
      const timeout_ms = clamp(request.timeout_ms);
      const command_template: Omit<BridgeCommand, 'command_id'> = {
        recipe_run_id: request.recipe_run_id,
        step_id: request.step_id,
        ingredient: request.ingredient,
        action: request.action,
        target_domain_pattern,
        args: request.args,
        expects_output_keys: request.expects_output_keys,
        timeout_ms,
        idempotency_key: request.idempotency_key,
        ...(reviewed ? { reviewed_document: structuredClone(reviewed.binding.document) } : {}),
      };

      if (reviewed) {
        const binding = structuredClone(reviewed.binding);
        const beforeSend = async () => {
          await reviewed.beforeSend();
          const bridge = options.registry.get(binding.client_token_id);
          if (!bridge || !isPatternWithinGrantedOrigins(target_domain_pattern, bridge.capabilities.granted_origins)
            || !isPatternWithinGrantedOrigins(binding.document.url, [target_domain_pattern])
            || (request.preferred_bridge_label && request.preferred_bridge_label !== bridge.client_label)
            || !options.registry.documents?.(binding.client_token_id).some(document => document.tab_id === binding.document.tab_id
              && document.document_id === binding.document.document_id && document.url === binding.document.url)) {
            throw new RpcError('preapproval_stale', 'The reviewed browser document changed or disconnected.', 409);
          }
        };
        const out = await dispatchToBridge(binding.client_token_id, command_template, timeout_ms, beforeSend);
        if (out.kind === 'send_failed') return { kind: 'capacity_gap', capacity_gap: { kind: 'bridge_online' },
          reason: 'bridge_online', attempts: out.attempts };
        if (out.kind === 'timeout') return { kind: 'timeout', command_id: out.command_id, attempts: out.attempts };
        if (out.result.status === 'ok') await recordSuccess(binding.client_token_id, target_domain_pattern);
        return { kind: 'completed', result: out.result, bridge_client_token_id: binding.client_token_id, attempts: out.attempts };
      }

      // ──────────────────────────────────────────────────────────
      // Preferred-label strict path — single-bridge passthrough.
      // The user asked for a specific bridge by label; the
      // multi-bridge fall-through doesn't apply. Result (including
      // any `capacity_gap_*` error code) returns directly so callers
      // who opt into a specific bridge see its exact response.
      // ──────────────────────────────────────────────────────────
      if (request.preferred_bridge_label) {
        const labeled = options.registry.byLabel(request.preferred_bridge_label);
        if (!labeled) {
          return {
            kind: 'capacity_gap',
            capacity_gap: { kind: 'bridge_online' },
            reason: 'bridge_label_unavailable',
            attempts: 0,
          };
        }
        const out = await dispatchToBridge(
          labeled.client_token_id,
          command_template,
          timeout_ms,
        );
        if (out.kind === 'send_failed') {
          return {
            kind: 'capacity_gap',
            capacity_gap: { kind: 'bridge_online' },
            reason: 'bridge_online',
            attempts: out.attempts,
          };
        }
        if (out.kind === 'timeout') {
          return { kind: 'timeout', command_id: out.command_id, attempts: out.attempts };
        }
        if (out.result.status === 'ok') {
          await recordSuccess(labeled.client_token_id, target_domain_pattern);
        }
        return {
          kind: 'completed',
          result: out.result,
          bridge_client_token_id: labeled.client_token_id,
          attempts: out.attempts,
        };
      }

      // ──────────────────────────────────────────────────────────
      // Multi-bridge sequential fall-through (D-169 § N.9 / A.8).
      // ──────────────────────────────────────────────────────────
      const allBridges = options.registry.list();
      if (allBridges.length === 0) {
        return {
          kind: 'capacity_gap',
          capacity_gap: { kind: 'bridge_online' },
          reason: 'bridge_online',
          attempts: 0,
        };
      }
      const eligible = filterEligible(allBridges, target_domain_pattern);
      if (eligible.length === 0) {
        return {
          kind: 'capacity_gap',
          capacity_gap: { kind: 'bridge_online' },
          reason: 'bridge_online',
          attempts: 0,
        };
      }
      const ordered = await orderForDispatch(
        eligible,
        target_domain_pattern,
        options.auditLog,
      );

      const accumulated: Array<{
        bridge_id: string;
        bridge_label: string;
        gap_reason: BridgeCapacityGap;
      }> = [];
      let total_attempts = 0;
      for (const bridge of ordered) {
        const out = await dispatchToBridge(
          bridge.client_token_id,
          command_template,
          timeout_ms,
        );
        total_attempts += out.attempts;
        if (out.kind === 'send_failed') {
          // Transport failure on the current bridge — bail. A
          // different bridge might serve, but a transport failure on
          // one is more likely a server-side issue + we don't want
          // to mask it by silently trying the next.
          return {
            kind: 'capacity_gap',
            capacity_gap: { kind: 'bridge_online' },
            reason: 'bridge_online',
            attempts: total_attempts,
          };
        }
        if (out.kind === 'timeout') {
          return {
            kind: 'timeout',
            command_id: out.command_id,
            attempts: total_attempts,
          };
        }
        // out.kind === 'completed'
        if (isCapacityGapResult(out.result)) {
          accumulated.push({
            bridge_id: bridge.client_token_id,
            bridge_label: bridge.client_label ?? bridge.client_token_id,
            gap_reason: mapToCapacityGap(out.result.error?.code, target_domain_pattern),
          });
          continue;
        }
        // Success or non-gap error — return immediately.
        if (out.result.status === 'ok') {
          await recordSuccess(bridge.client_token_id, target_domain_pattern);
        }
        return {
          kind: 'completed',
          result: out.result,
          bridge_client_token_id: bridge.client_token_id,
          attempts: total_attempts,
        };
      }
      // All eligible bridges returned capacity_gap_* — surface the
      // aggregate so the caller can render per-bridge remediation.
      return {
        kind: 'aggregate_capacity_gap',
        aggregate: { kind: 'aggregate_capacity_gap', bridges: accumulated },
        attempts: total_attempts,
      };
    },
    async cancel(command_id, reason) {
      const target = inflight.get(command_id);
      if (!target) {
        return { ok: false, reason: 'bridge_offline', detail: 'no in-flight command' };
      }
      return options.transport.cancel(target, { command_id, reason });
    },
    canResolve(command_id, client_token_id) {
      return inflight.get(command_id) === client_token_id;
    },
  };
};

/** Helper for the rpc layer — build a result-listener with the
 *  promise-resolver pattern. Inbound result frames call
 *  `resolveResult`; the dispatcher's `awaitResult` resolves the
 *  matching pending promise. */
export const createBridgeResultListener = (
  options: { now?: () => number } = {},
): BridgeResultListener => {
  const now = options.now ?? Date.now;
  const pending = new Map<
    string,
    {
      resolve: (r: BridgeResult | null) => void;
      expires_at: number;
      handle: ReturnType<typeof setTimeout>;
    }
  >();

  return {
    awaitResult(command_id, timeout_ms) {
      return new Promise<BridgeResult | null>((resolve) => {
        const expires_at = now() + timeout_ms;
        const handle = setTimeout(() => {
          const entry = pending.get(command_id);
          if (entry) {
            pending.delete(command_id);
            entry.resolve(null);
          }
        }, timeout_ms);
        pending.set(command_id, { resolve, expires_at, handle });
        // Defensively unref the handle if the runtime supports it
        // (node has unref; browser setTimeout doesn't). Keeps the
        // process from blocking on a stuck promise.
        const maybeUnref = (handle as unknown as { unref?: () => void }).unref;
        if (typeof maybeUnref === 'function') maybeUnref.call(handle);
      });
    },
    resolveResult(result) {
      const entry = pending.get(result.command_id);
      if (!entry) return;
      pending.delete(result.command_id);
      clearTimeout(entry.handle);
      entry.resolve(result);
    },
    cancelAwait(command_id) {
      const entry = pending.get(command_id);
      if (!entry) return;
      pending.delete(command_id);
      clearTimeout(entry.handle);
      entry.resolve(null);
    },
    clear() {
      // Snapshot entries before draining so a `resolve()` callback
      // that synchronously triggers more awaits doesn't mutate the
      // map mid-iteration. Each pending promise resolves to null —
      // the same shape callers see on timeout.
      const snapshot = [...pending.values()];
      pending.clear();
      for (const entry of snapshot) {
        clearTimeout(entry.handle);
        entry.resolve(null);
      }
    },
  };
};
