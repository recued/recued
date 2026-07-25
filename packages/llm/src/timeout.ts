/** LLM timeout policy.
 *
 *  Rationale (why LLM is different from HTTP/MCP):
 *  -------------------------------------------------
 *  HTTP/MCP executors use a 2-minute hard cap because the adapter owns
 *  the cost: a runaway call ties up a browser socket and blows the
 *  context-recipe render budget. Aborting early is safe and usually right.
 *
 *  LLM calls are economically backwards: the *user* owns the cost (BYOK).
 *  The provider starts billing the moment it begins token generation. If
 *  we abort mid-stream, the tokens are still generated server-side and
 *  the charge is still on the user's card — we just don't get the result.
 *  Aggressively aborting LLM calls is equivalent to setting money on fire.
 *
 *  Policy: NO auto-timeout for LLM by default.
 *  - `resolveLLMTimeoutMs(undefined)` returns `null` — no setTimeout is
 *    installed. The adapter still creates an AbortController so the user
 *    or engine can cancel the call explicitly, but the timer itself is
 *    absent. A truly stuck socket is eventually released by the OS-level
 *    TCP keepalive.
 *  - Callers may opt in to a timer by passing a concrete value, which
 *    gets clamped to [LLM_MIN, LLM_HARD_CAP].
 *
 *  Zero-retry policy (DO NOT change without re-reading):
 *  - The adapter NEVER retries on its own. Ever.
 *  - The executor does NOT retry on contracted-output parse failure
 *    either — one call = one billing event. If a contracted AI function
 *    returns invalid JSON, the recipe fails fast and the user re-runs
 *    at their discretion.
 *  - Recipe authors handle LLM failures via `skip_when` / `fail_on` in
 *    the recipe — the engine does not silently replay AI steps.
 *  - Action ingredients (write/admin/destructive) are gated by the
 *    approval layer. It requires fresh user consent for every
 *    invocation, which makes silent replay impossible by
 *    construction. Retrying a half-completed write would be dangerous
 *    (duplicate records, double charges, re-deletions) — the approval
 *    UX forces the user to verify state before re-approving.
 *
 *  Partial-response recovery:
 *  - Not implemented today. Non-streaming `response.json()` is all-or-
 *    nothing: if the TCP connection drops mid-body, there is literally no
 *    partial JSON to salvage.
 *  - Streaming support (SSE for Anthropic, deltas for OpenAI) would let
 *    us buffer tokens as they arrive and return the partial content on
 *    abort, tagged with `{ partial: true, reason: "connection_dropped" }`.
 *    That's a substantial refactor of every adapter and is deferred to a
 *    future task. Until then: expect all-or-nothing.
 */

/** Opt-in bounds for callers that do supply an explicit timeout. */
export const LLM_MIN_TIMEOUT_MS = 1_000;      // 1 second — sanity floor
export const LLM_HARD_CAP_MS    = 7_200_000;  // 2 hours — truly-stuck-socket cap

/** Resolve a raw LLM timeout to a clamped value OR `null` for no timer.
 *
 *  - `undefined` / `null` → `null` (NO timer — the default, honoring the
 *    policy that LLM calls should not be auto-aborted)
 *  - non-finite number / non-number (NaN, Infinity, string, object) → `null`
 *  - numeric in range → returned unchanged
 *  - below MIN → MIN (callers who opt in at least want a real timer)
 *  - above HARD_CAP → HARD_CAP
 *
 *  The adapter is responsible for skipping setTimeout when this returns null. */
export const resolveLLMTimeoutMs = (raw: unknown): number | null => {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  if (raw < LLM_MIN_TIMEOUT_MS) return LLM_MIN_TIMEOUT_MS;
  if (raw > LLM_HARD_CAP_MS) return LLM_HARD_CAP_MS;
  return raw;
};
