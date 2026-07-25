/** Shared timeout helpers for HTTP and MCP ingredient executors.
 *
 *  Bounds are chosen to fit the Recued execution model:
 *  - Context recipes target a < 3s total render budget, so a single ingredient
 *    call should stay well under 30s in practice. The default 30s covers
 *    slow APIs without becoming a tail risk.
 *  - Action recipes can legitimately do longer calls (large searches, heavy
 *    aggregations), but 120s is a hard ceiling — beyond that, the operation
 *    should be restructured (prefetch, pagination, or scheduled execution).
 *  - Scheduled recipes with longer budgets pass their own timeout via the
 *    step input, which is clamped to MAX_TIMEOUT_MS at resolution time.
 *
 *  The cap is a defense-in-depth measure against runaway recipes; authors
 *  and users still see their configured value reflected in the audit log
 *  even when it's clamped. */

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MIN_TIMEOUT_MS = 100;       // 100ms — any less is unusable
export const MAX_TIMEOUT_MS = 120_000;   // 2 minutes — hard cap

/** Soft ceiling — manifests declaring a default above this get a validator
 *  warning (not an error). Most legitimate CRM API calls finish well under
 *  this, so values above are almost always a sign of a misconfigured default. */
export const SOFT_TIMEOUT_CEILING_MS = 60_000;

/** True when a failed call's outcome is fundamentally unknowable from the
 *  client side, so retrying is dangerous (risk of duplicate writes). This
 *  is the practical reflection of the at-least-once delivery impossibility:
 *  for any write/admin/destructive call, we cannot distinguish "request
 *  never arrived" from "request arrived, committed, but the acknowledgment
 *  was lost". The correct response is to tell the user to verify state in
 *  their CRM — NEVER silently retry.
 *
 *  The contract is at the risk_tier level, not the HTTP status level:
 *  a read-tier call can safely report NETWORK_ERROR and let the user retry,
 *  but a write-tier call with the same underlying failure must report
 *  ACTION_DELIVERY_UNCERTAIN instead. */
export const isWriteRiskTier = (riskTier: string): boolean =>
  riskTier === 'write' || riskTier === 'admin' || riskTier === 'destructive';

/** Resolve a raw timeout value to a usable number in [MIN, MAX].
 *
 *  - `null` / `undefined` → DEFAULT_TIMEOUT_MS
 *  - non-finite number (`NaN`, `Infinity`) → DEFAULT_TIMEOUT_MS
 *  - non-number (string, object, etc.) → DEFAULT_TIMEOUT_MS
 *  - negative / zero → MIN_TIMEOUT_MS
 *  - above MAX → MAX_TIMEOUT_MS
 *  - valid in range → returned unchanged
 *
 *  Never throws — this is the defensive path used at call time. Validation
 *  errors for manifest defaults are surfaced by the static validator. */
export const resolveTimeoutMs = (raw: unknown): number => {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return DEFAULT_TIMEOUT_MS;
  }
  if (raw < MIN_TIMEOUT_MS) return MIN_TIMEOUT_MS;
  if (raw > MAX_TIMEOUT_MS) return MAX_TIMEOUT_MS;
  return raw;
};
