/** D-153 P1 — commit-substrate identity (D-145 engine-wiring).
 *
 *  D-153 keys every commit into a three-tier session hierarchy:
 *
 *    channel_session_id  — the channel's own boundary (Slack thread,
 *                          chat conversation, MCP token lifetime, …)
 *      └─ cognition_session_id  — engine-assigned per cognition window
 *           └─ correlation_id   — engine-assigned per ~1-min intent burst
 *                └─ commit       — one atomic action / query
 *
 *  P1 + P1.B already shipped the storage substrate: `AuditEntry`
 *  carries the three optional fields, `memory-schema.ts` indexes them
 *  via `json_extract`, and `AuditLogStore` exposes the tier-scoped
 *  `listBy*` query methods over them. But until the engine *populates*
 *  the fields every index sits empty. This module is that wiring — the two
 *  primitives `execute-handler.ts` calls when it builds a commit/audit
 *  row from a typed `ExecutionSource`:
 *
 *   - `deriveChannelSessionId` — pure projection of an `ExecutionSource`
 *     onto its channel-owned session boundary.
 *   - `createCorrelationTracker` — the deterministic ~1-min intent-burst
 *     heuristic that groups successive dispatches in one channel session
 *     under a shared `correlation_id` (the unit save-as-Recipe operates
 *     on).
 *
 *  `cognition_session_id` is deliberately NOT derived here: cognition
 *  ships pluggable + DEFAULT DISABLED (D-153 § Cognition layer / D-145
 *  § B.16 scope update 2026-05-19), so the recipe-runner never opens a
 *  cognition window and the field stays undefined until a cognition
 *  component is wired into a policy cell.
 *
 *  Spec: D-153 § Three-tier session IDs.
 */

import type { ExecutionSource } from '@recued/contracts';

// ────────────────────────────────────────────────────────────────
// channel_session_id — the channel's own session boundary
// ────────────────────────────────────────────────────────────────

/** Project a typed `ExecutionSource` onto its `channel_session_id` —
 *  the channel-owned boundary the spec's first tier-query ("what
 *  happened in this Slack thread / chat / MCP token ever?") scopes to.
 *
 *  Every result is prefixed with the channel name so values can't
 *  collide across channels: a `schedule` source keyed on a short human
 *  `source_recipe` slug and a `chat` session keyed on a UUID share one
 *  indexed column, and the prefix keeps the `json_extract` channel-
 *  session query unambiguous.
 *
 *  Per-channel boundary choice:
 *   - `user`         → `client_token_id`  (the paired client / device)
 *   - `chat`         → `chat_session_id`  (the conversation)
 *   - `mcp`          → `mcp_token_id`     (the token lifetime — spec § Three-tier session IDs)
 *   - `messenger`    → `vendor` + `from`  (the Slack / Telegram / email thread)
 *   - `reception`    → `reception_id` (+ `visitor_id` when the visitor is identified)
 *   - `webhook`      → `webhook_secret_id` (the registered inbound source)
 *   - `schedule`     → `source_recipe`   (every tick of one scheduled recipe)
 *   - `reactive`     → `source_recipe`   (every reactive fire of one recipe)
 *   - `housekeeping` → `cycle_id`        (the housekeeping cycle)
 *
 *  Pure + total: the switch is exhaustive over the 9-channel closed
 *  list, so a new `Channel` raises a compile error here (the function
 *  would no longer return on all paths). */
export const deriveChannelSessionId = (source: ExecutionSource): string => {
  switch (source.channel) {
    case 'user':
      return `user:${source.client_token_id}`;
    case 'chat':
      return `chat:${source.chat_session_id}`;
    case 'mcp':
      return `mcp:${source.mcp_token_id}`;
    case 'messenger':
      return `messenger:${source.vendor}:${source.from}`;
    case 'reception':
      return source.visitor_id !== undefined
        ? `reception:${source.reception_id}:${source.visitor_id}`
        : `reception:${source.reception_id}`;
    case 'webhook':
      return `webhook:${source.webhook_secret_id}`;
    case 'schedule':
      return `schedule:${source.source_recipe}`;
    case 'reactive':
      return `reactive:${source.source_recipe}`;
    case 'housekeeping':
      return `housekeeping:${source.cycle_id}`;
  }
};

// ────────────────────────────────────────────────────────────────
// correlation_id — the ~1-min intent-burst heuristic
// ────────────────────────────────────────────────────────────────

/** Width of the intent-burst window. Two dispatches in the same
 *  `channel_session_id` less than this far apart share a
 *  `correlation_id`; a gap at or beyond it starts a fresh burst.
 *  Spec § Three-tier session IDs: "~1-min". */
export const CORRELATION_WINDOW_MS = 60_000;

/** Soft cap on tracked channel sessions before an opportunistic prune
 *  of stale entries. A stale entry (last dispatch ≥ one full window
 *  ago) can never be reused — the next `assign` for that session mints
 *  fresh regardless — so dropping it is semantically free and bounds
 *  memory on a long-lived process. */
const MAX_TRACKED_SESSIONS = 10_000;

/** Mint a fresh `correlation_id`. UUID with the same browserless
 *  fallback shape as `capacity/walker.ts` `mintWalkId`. */
const mintCorrelationId = (): string => {
  const g = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof g?.randomUUID === 'function') return `corr-${g.randomUUID()}`;
  // Browserless fallback — same shape as capacity/walker.ts.
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `corr-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** Engine-owned, process-lived assignment of `correlation_id` to
 *  dispatches. One tracker per server process. */
export interface CorrelationTracker {
  /** Resolve the `correlation_id` for a dispatch in `channel_session_id`
   *  at `now_ms`. Reuses the session's current id when the prior
   *  dispatch was less than `CORRELATION_WINDOW_MS` ago; mints + stores
   *  a fresh id otherwise. Mutates the tracker (advances the session's
   *  last-dispatch clock). */
  assign(channel_session_id: string, now_ms: number): string;
  /** Drop all tracked state. Test-isolation hook — production never
   *  calls it. */
  reset(): void;
}

/** Create a `CorrelationTracker`. `genId` is injectable for
 *  deterministic tests (matches the engine's `crypto.randomUUID()`
 *  injection convention); production omits it for the UUID default.
 *
 *  The heuristic implements the spec's time-window half — "same
 *  `correlation_id` if `now - last_dispatch < 1min`". The spec's
 *  second clause, "AND no user message arrived between", needs a
 *  user-message event stream the synchronous recipe-runner does not
 *  have; the chat-channel cognition path is where that boundary is
 *  observed, and a future slice extends the tracker with an explicit
 *  burst-break signal once that path is engine-wired. */
export const createCorrelationTracker = (
  opts?: { genId?: () => string },
): CorrelationTracker => {
  const genId = opts?.genId ?? mintCorrelationId;
  const sessions = new Map<
    string,
    { correlation_id: string; last_dispatch_ms: number }
  >();

  /** Drop sessions whose last dispatch is a full window old — they can
   *  never be reused, so eviction is lossless. */
  const pruneStale = (now_ms: number): void => {
    for (const [key, entry] of sessions) {
      if (now_ms - entry.last_dispatch_ms >= CORRELATION_WINDOW_MS) {
        sessions.delete(key);
      }
    }
  };

  return {
    assign(channel_session_id, now_ms) {
      const prior = sessions.get(channel_session_id);
      if (
        prior !== undefined &&
        now_ms - prior.last_dispatch_ms < CORRELATION_WINDOW_MS
      ) {
        prior.last_dispatch_ms = now_ms;
        return prior.correlation_id;
      }
      if (sessions.size >= MAX_TRACKED_SESSIONS) pruneStale(now_ms);
      const correlation_id = genId();
      sessions.set(channel_session_id, {
        correlation_id,
        last_dispatch_ms: now_ms,
      });
      return correlation_id;
    },
    reset() {
      sessions.clear();
    },
  };
};
