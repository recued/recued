import type { AvailabilityStatus, FreePoolEntry } from './types.js';

/** Serializable snapshot the caller persists and rehydrates.
 *
 *  `tokens_today` is the only value that survives service-worker restarts —
 *  the RPM window is in-memory only (documented limitation; RPM is advisory
 *  and a fresh window after a restart degrades gracefully).
 *
 *  `cursor` is the round-robin pointer per source-key (e.g. `"free_pool:fast"`).
 *  Persisting it means the round-robin sequence is preserved across restarts,
 *  which matters for fairness across ingredients.
 *
 *  D-131 — `embeddings_tokens_today` breaks out the embeddings-surface
 *  contribution to `tokens_today`. The two share the daily cap (per
 *  `docs/launch-sequence-2026-04-30.md` open-question §3 — "share
 *  QuotaTracker entries by key"); the breakout exists for visibility in
 *  the cost-preview UI and for telemetry on the embeddings-vs-chat
 *  starvation risk. Invariant: for any entryId,
 *  `embeddings_tokens_today[id] <= tokens_today[id]`. */
export interface QuotaSnapshot {
  /** UTC date bucket, `YYYY-MM-DD`. Usage rolls when this changes. */
  daily_reset_at: string;
  /** Per-entry tokens consumed today, keyed by entry id. Chat + embeddings combined. */
  tokens_today: Record<string, number>;
  /** D-131 — per-entry embeddings-only tokens consumed today. Subset of
   *  `tokens_today`. Empty when no embeddings call has fired against
   *  the entry today. */
  embeddings_tokens_today?: Record<string, number>;
  /** Per-source-key cursor index (round-robin). */
  cursor: Record<string, number>;
}

export interface QuotaTracker {
  /** Current eligibility of a pool entry, given its caps and today's usage. */
  statusFor(entry: FreePoolEntry, now?: number): AvailabilityStatus;
  /** Record tokens consumed by a successful completion. */
  recordUsage(entryId: string, tokens: number, now?: number): void;
  /** D-131 — record tokens consumed by a successful embeddings call.
   *  Counts toward the same daily cap as `recordUsage` (per the
   *  share-quota decision) AND tracks an embeddings-only subset for
   *  visibility. Embeddings callers (`executeEmbedding`) use this
   *  instead of `recordUsage`; chat callers (`executeLLM`) continue
   *  using `recordUsage`. The split lets tooling answer "how much did
   *  embeddings consume today?" without re-parsing audit logs. */
  recordEmbeddingsUsage(entryId: string, tokens: number, now?: number): void;
  /** D-131 — embeddings-only tokens used today against an entry.
   *  Returns 0 when no embeddings call has fired against the entry
   *  today (or after a daily-reset has cleared the bucket). */
  embeddingsTokensToday(entryId: string): number;
  /** Total tokens used today against an id (pool entry OR slot key —
   *  the executor records slot completions under `slot_1`/`slot_2`).
   *  Returns 0 when nothing has fired today / after a daily reset.
   *  Used by `buildAvailability` to derive per-slot budget cutoffs
   *  (D-079/D-094 per-slot budgets). */
  tokensToday(entryId: string): number;
  /** Record a dispatch attempt for RPM tracking (called pre-request). */
  registerRequest(entryId: string, now?: number): void;
  /** Mark a source as rate-limited for `retryAfterMs` milliseconds.
   *  Subsequent `statusFor` calls return `quota_exhausted` until the
   *  cooldown expires. Default 60s when `retryAfterMs` is omitted —
   *  matches the RPM window granularity.
   *
   *  Applies to slots too (not just pool entries) — the executor
   *  passes the slot key (`slot_1` / `slot_2`) as the id. */
  markRateLimited(entryId: string, retryAfterMs?: number, now?: number): void;
  /** True if the source is currently in a post-429 cooldown. Exposed so
   *  the availability builder can surface slot cooldowns without
   *  needing a full `FreePoolEntry` for slots. */
  isInCooldown(entryId: string, now?: number): boolean;
  /** Advance the round-robin cursor for a source-key. Called after a successful match. */
  advanceCursor(sourceKey: string): void;
  /** Current round-robin cursor for a source-key. */
  currentCursor(sourceKey: string): number;
  /** Serializable snapshot for persistence. */
  snapshot(): QuotaSnapshot;
}

/** UTC YYYY-MM-DD from epoch millis. Kept UTC so daily resets don't slide with
 *  the user's timezone (more predictable for shared pool entries with caps). */
const dailyKey = (nowMs: number): string => new Date(nowMs).toISOString().slice(0, 10);

/** Drop RPM timestamps older than 60 seconds. */
const pruneRpm = (timestamps: number[], nowMs: number): number[] =>
  timestamps.filter((ts) => nowMs - ts < 60_000);

/** Build a QuotaTracker, optionally seeded from a persisted snapshot. RPM
 *  window starts empty regardless of snapshot (always in-memory). */
export const createQuotaTracker = (initial?: Partial<QuotaSnapshot>): QuotaTracker => {
  const daily_key = initial?.daily_reset_at ?? dailyKey(Date.now());
  const tokens_today = new Map<string, number>(
    Object.entries(initial?.tokens_today ?? {}),
  );
  // D-131 — embeddings-only subset of tokens_today, for cost-preview UI
  // and telemetry. Hydrated from snapshot when present.
  const embeddings_tokens_today = new Map<string, number>(
    Object.entries(initial?.embeddings_tokens_today ?? {}),
  );
  const rpm_window = new Map<string, number[]>();
  const cursor = new Map<string, number>(
    Object.entries(initial?.cursor ?? {}),
  );
  // Post-429 cooldown — epoch-millis timestamp after which the source is
  // usable again. In-memory only (documented limitation; a restart
  // resets cooldowns, which degrades gracefully — next call probes the
  // source afresh and re-marks it if still rate-limited).
  const cooldown_until = new Map<string, number>();

  let current_daily_key = daily_key;

  /** Default cooldown when provider doesn't send Retry-After. 60s
   *  matches the RPM window granularity — if we got 429 once, waiting
   *  a full RPM window before retrying is a safe default. */
  const DEFAULT_COOLDOWN_MS = 60_000;

  const maybeReset = (nowMs: number): void => {
    const key = dailyKey(nowMs);
    if (key !== current_daily_key) {
      current_daily_key = key;
      tokens_today.clear();
      // D-131 — embeddings counter shares the daily-reset cadence with
      // the chat counter. Both buckets clear at the same UTC midnight.
      embeddings_tokens_today.clear();
    }
  };

  return {
    statusFor(entry, nowArg) {
      const now = nowArg ?? Date.now();
      maybeReset(now);
      if (!entry.enabled) return { available: false, reason: 'disabled' };
      // Post-429 cooldown applies to every entry.
      const cooldownUntil = cooldown_until.get(entry.id);
      if (cooldownUntil != null && cooldownUntil > now) {
        return { available: false, reason: 'quota_exhausted' };
      } else if (cooldownUntil != null) {
        // Expired — drop so the map doesn't grow unbounded.
        cooldown_until.delete(entry.id);
      }
      if (!entry.api_key) return { available: false, reason: 'no_key' };
      if (!entry.model) return { available: false, reason: 'no_model' };
      if (entry.daily_cap_tokens != null) {
        const used = tokens_today.get(entry.id) ?? 0;
        if (used >= entry.daily_cap_tokens) return { available: false, reason: 'quota_exhausted' };
      }
      if (entry.rpm_cap != null) {
        const window = pruneRpm(rpm_window.get(entry.id) ?? [], now);
        rpm_window.set(entry.id, window);
        if (window.length >= entry.rpm_cap) return { available: false, reason: 'quota_exhausted' };
      }
      return { available: true };
    },

    recordUsage(entryId, tokens, nowArg) {
      const now = nowArg ?? Date.now();
      maybeReset(now);
      tokens_today.set(entryId, (tokens_today.get(entryId) ?? 0) + tokens);
    },

    recordEmbeddingsUsage(entryId, tokens, nowArg) {
      const now = nowArg ?? Date.now();
      maybeReset(now);
      // Both counters update — daily cap accounting stays unified
      // (same key, same budget) while the breakout records the
      // embeddings-only contribution.
      tokens_today.set(entryId, (tokens_today.get(entryId) ?? 0) + tokens);
      embeddings_tokens_today.set(
        entryId,
        (embeddings_tokens_today.get(entryId) ?? 0) + tokens,
      );
    },

    embeddingsTokensToday(entryId) {
      // No maybeReset — pure read; if the day rolled, the next write
      // call will clear and the read will see 0 then.
      return embeddings_tokens_today.get(entryId) ?? 0;
    },

    tokensToday(entryId) {
      // Pure read (mirrors embeddingsTokensToday) — no maybeReset, so it
      // stays deterministic under an injected clock. If the day rolled,
      // the next recordUsage clears the bucket and the read sees 0 then.
      return tokens_today.get(entryId) ?? 0;
    },

    registerRequest(entryId, nowArg) {
      const now = nowArg ?? Date.now();
      const window = pruneRpm(rpm_window.get(entryId) ?? [], now);
      window.push(now);
      rpm_window.set(entryId, window);
    },

    markRateLimited(entryId, retryAfterMs, nowArg) {
      const now = nowArg ?? Date.now();
      const ms = retryAfterMs != null && Number.isFinite(retryAfterMs) && retryAfterMs > 0
        ? retryAfterMs
        : DEFAULT_COOLDOWN_MS;
      cooldown_until.set(entryId, now + ms);
    },

    isInCooldown(entryId, nowArg) {
      const now = nowArg ?? Date.now();
      const until = cooldown_until.get(entryId);
      if (until == null) return false;
      if (until <= now) {
        cooldown_until.delete(entryId);
        return false;
      }
      return true;
    },

    advanceCursor(sourceKey) {
      cursor.set(sourceKey, (cursor.get(sourceKey) ?? 0) + 1);
    },

    currentCursor(sourceKey) {
      return cursor.get(sourceKey) ?? 0;
    },

    snapshot() {
      const embOut = Object.fromEntries(embeddings_tokens_today);
      return {
        daily_reset_at: current_daily_key,
        tokens_today: Object.fromEntries(tokens_today),
        // Omit the breakout entirely when no embeddings traffic has
        // fired today — keeps the stored snapshot small for the
        // common chat-only case, and round-trips cleanly when
        // re-hydrated (Object.entries({}) === []).
        ...(Object.keys(embOut).length > 0 ? { embeddings_tokens_today: embOut } : {}),
        cursor: Object.fromEntries(cursor),
      };
    },
  };
};
