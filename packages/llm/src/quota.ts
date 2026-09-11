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
 *  internal design notes open-question §3 — "share
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
  /** D-262 § B12.3 — per-entry transcription accounting for today.
   *
   *  ⛔ DELIBERATELY NOT FOLDED INTO `tokens_today`. Embeddings share that
   *  bucket because they genuinely return token counts; transcription does not
   *  — providers bill by AUDIO SECONDS. Converting one into the other would put
   *  a fabricated number into an accounting surface, and every reader of
   *  `tokens_today` would silently inherit it. Three separate quantities
   *  instead, each of which is exactly what its name says. */
  transcription_requests_today?: Record<string, number>;
  /** Bytes of audio sent. ALWAYS exact — we hold the buffer. */
  transcription_bytes_today?: Record<string, number>;
  /** Seconds of audio, and ⚠ ONLY when the provider reported a duration.
   *  Absent for providers that do not (Gemini's `generateContent` returns
   *  none), so this is a visibility figure and NEVER the cap's input — a
   *  budget that silently stopped counting for one provider would be worse
   *  than no budget. */
  transcription_seconds_today?: Record<string, number>;
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
  embeddingsTokensToday(entryId: string, now?: number): number;
  /** D-262 § B12.3 — record one transcription call.
   *
   *  ⚠ `seconds` is optional BECAUSE THE PROVIDERS DISAGREE: the multipart
   *  endpoints may report a duration, Gemini's `generateContent` never does.
   *  Recording it when present and omitting it when absent keeps the number
   *  honest; estimating it from bytes would make a made-up figure
   *  indistinguishable from a measured one in the same column. */
  recordTranscriptionUsage(
    entryId: string,
    usage: { bytes: number; seconds?: number },
    now?: number,
  ): void;
  /** Transcription calls made today against an id. The cap's input, because
   *  it is the only one of the three that is always exact. */
  transcriptionRequestsToday(entryId: string, now?: number): number;
  /** Audio bytes sent today. Exact, but a poor cost proxy on its own — the
   *  same speech is 20x larger at 320 kbps than at 16 kbps. */
  transcriptionBytesToday(entryId: string, now?: number): number;
  /** Audio seconds today, counting ONLY calls whose provider reported a
   *  duration. ⚠ An under-count by construction; never compare it to a cap. */
  transcriptionSecondsToday(entryId: string, now?: number): number;
  /** Total tokens used today against an id (pool entry OR slot key —
   *  the executor records slot completions under `slot_1`/`slot_2`).
   *  Returns 0 when nothing has fired today / after a daily reset.
   *  Used by `buildAvailability` to derive per-slot budget cutoffs
   *  (D-079/D-094 per-slot budgets). */
  tokensToday(entryId: string, now?: number): number;
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
  /** D-262 — the UTC day every `…Today` read is reporting for.
   *
   *  ⛔ NOT `snapshot().daily_reset_at`, WHICH IS A DIFFERENT QUESTION.
   *  `daily_reset_at` is the day the BUCKETS were last written on; it stays
   *  stale until the next write's `maybeReset`. The reads are day-aware and
   *  report 0 the moment the day rolls, so labelling them with the snapshot's
   *  key would date today's (correctly empty) counters as yesterday.
   *
   *  ⚠ Kept off `snapshot()` deliberately: that call serializes state for
   *  PERSISTENCE and carries the round-robin cursors, which are not daily.
   *  A day-aware `snapshot()` would have silently dropped them. */
  currentDay(now?: number): string;
  /** Serializable snapshot for persistence. Carries `daily_reset_at` — the
   *  day the buckets were last WRITTEN on, which is not necessarily today.
   *  For a display label use `currentDay()`. */
  snapshot(): QuotaSnapshot;
}

/** UTC YYYY-MM-DD from epoch millis. Kept UTC so daily resets don't slide with
 *  the user's timezone (more predictable for shared pool entries with caps). */
const dailyKey = (nowMs: number): string => new Date(nowMs).toISOString().slice(0, 10);

/** Drop RPM timestamps older than 60 seconds. */
const pruneRpm = (timestamps: number[], nowMs: number): number[] =>
  timestamps.filter((ts) => nowMs - ts < 60_000);

/** D-262 follow-on — how a persisted tracker tells its host to save.
 *
 *  ⛔ THE SEAM EXISTS BECAUSE `packages/` MAY NOT REACH `backend/`. The tracker
 *  cannot write to SQLite, so it announces a change and the host decides where
 *  and how often. That also leaves the cadence a host decision: today it writes
 *  through on every change, which is safe because LLM calls arrive seconds
 *  apart, and a debounce is a change in the persister rather than here.
 *
 *  ⚠ Fired only for state that is IN the snapshot — the daily counters and the
 *  cursor. NOT for `registerRequest` (the RPM window is deliberately in-memory
 *  and starts empty on every boot) and NOT for `markRateLimited` (a cooldown is
 *  a property of a live process; restoring one from disk would extend a
 *  provider's 60-second penalty across a restart it never asked for). */
export interface QuotaTrackerOptions {
  onChange?: (snapshot: QuotaSnapshot) => void;
}

/** Build a QuotaTracker, optionally seeded from a persisted snapshot. RPM
 *  window starts empty regardless of snapshot (always in-memory). */
export const createQuotaTracker = (
  initial?: Partial<QuotaSnapshot>,
  options?: QuotaTrackerOptions,
): QuotaTracker => {
  const daily_key = initial?.daily_reset_at ?? dailyKey(Date.now());
  const tokens_today = new Map<string, number>(
    Object.entries(initial?.tokens_today ?? {}),
  );
  // D-131 — embeddings-only subset of tokens_today, for cost-preview UI
  // and telemetry. Hydrated from snapshot when present.
  const embeddings_tokens_today = new Map<string, number>(
    Object.entries(initial?.embeddings_tokens_today ?? {}),
  );
  // D-262 § B12.3 — transcription accounting, kept OUT of `tokens_today`
  // because audio seconds are not tokens and pretending otherwise would put a
  // fabricated number where every reader assumes a measured one.
  const transcription_requests_today = new Map<string, number>(
    Object.entries(initial?.transcription_requests_today ?? {}),
  );
  const transcription_bytes_today = new Map<string, number>(
    Object.entries(initial?.transcription_bytes_today ?? {}),
  );
  const transcription_seconds_today = new Map<string, number>(
    Object.entries(initial?.transcription_seconds_today ?? {}),
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
      transcription_requests_today.clear();
      transcription_bytes_today.clear();
      transcription_seconds_today.clear();
    }
  };

  /** D-262 — read a "today" bucket. ⛔⛔ REPORTS 0 ONCE THE DAY HAS ROLLED,
   *  because a counter named `…Today` returning YESTERDAY'S number is simply
   *  wrong, and three of these reads are BUDGET GATES.
   *
   *  ⛔ The bug this closes: `maybeReset` only runs on WRITES, and a gate reads
   *  BEFORE its write. A cap reached on day 1 therefore stayed reached on day 2
   *  — and the only thing that could have cleared it was the call the cap was
   *  refusing. Transcription was fully exposed (slice 3 removed `matchLLM`, so
   *  nothing on that path calls `statusFor` either); the chat and embeddings
   *  slot budgets were exposed too, MASKED only on servers whose free pool made
   *  `statusFor` roll the day first. The refusal text even promised "It resets
   *  at 00:00 UTC".
   *
   *  🔑 PURE ON PURPOSE — it reports rather than clears. A read that mutated
   *  would drop the buckets without `notify()`, leaving the persisted snapshot
   *  disagreeing with memory. The next write's `maybeReset` still does the
   *  actual clearing. */
  const readToday = (
    bucket: Map<string, number>,
    entryId: string,
    nowArg?: number,
  ): number => {
    const now = nowArg ?? Date.now();
    if (dailyKey(now) !== current_daily_key) return 0;
    return bucket.get(entryId) ?? 0;
  };

  /** The persisted shape. Extracted so `notify` and `snapshot()` can never
   *  disagree about what gets saved versus what gets reported. */
  const buildSnapshot = (): QuotaSnapshot => {
    const embOut = Object.fromEntries(embeddings_tokens_today);
    return {
      daily_reset_at: current_daily_key,
      tokens_today: Object.fromEntries(tokens_today),
      // Omit the breakout entirely when no embeddings traffic has fired today
      // — keeps the stored snapshot small for the common chat-only case, and
      // round-trips cleanly when re-hydrated (Object.entries({}) === []).
      ...(Object.keys(embOut).length > 0 ? { embeddings_tokens_today: embOut } : {}),
      // D-262 § B12.3 — same omit-when-empty rule, for the same reason: a
      // server that has never transcribed carries no transcription keys.
      ...(transcription_requests_today.size > 0
        ? { transcription_requests_today: Object.fromEntries(transcription_requests_today) }
        : {}),
      ...(transcription_bytes_today.size > 0
        ? { transcription_bytes_today: Object.fromEntries(transcription_bytes_today) }
        : {}),
      ...(transcription_seconds_today.size > 0
        ? { transcription_seconds_today: Object.fromEntries(transcription_seconds_today) }
        : {}),
      cursor: Object.fromEntries(cursor),
    };
  };

  /** Announce a change to the persisted state.
   *
   *  ⛔ NEVER LET A PERSISTENCE FAILURE REACH THE LLM PATH. A locked or
   *  read-only store must degrade to "budgets reset on restart", which is
   *  exactly the behaviour that existed before persistence — not a thrown
   *  error in the middle of someone's chat turn. */
  const notify = (): void => {
    if (!options?.onChange) return;
    try {
      options.onChange(buildSnapshot());
    } catch {
      /* the host's problem, and never the caller's */
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
      notify();
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
      notify();
    },

    recordTranscriptionUsage(entryId, usage, nowArg) {
      const now = nowArg ?? Date.now();
      maybeReset(now);
      transcription_requests_today.set(
        entryId,
        (transcription_requests_today.get(entryId) ?? 0) + 1,
      );
      transcription_bytes_today.set(
        entryId,
        (transcription_bytes_today.get(entryId) ?? 0) + usage.bytes,
      );
      // ⚠ Only when the provider actually said so. A missing duration leaves
      // the counter untouched rather than adding a guess, which is why the cap
      // reads requests instead.
      if (usage.seconds !== undefined && usage.seconds > 0) {
        transcription_seconds_today.set(
          entryId,
          (transcription_seconds_today.get(entryId) ?? 0) + usage.seconds,
        );
      }
      notify();
    },

    transcriptionRequestsToday(entryId, now) {
      return readToday(transcription_requests_today, entryId, now);
    },
    transcriptionBytesToday(entryId, now) {
      return readToday(transcription_bytes_today, entryId, now);
    },
    transcriptionSecondsToday(entryId, now) {
      return readToday(transcription_seconds_today, entryId, now);
    },

    embeddingsTokensToday(entryId, now) {
      return readToday(embeddings_tokens_today, entryId, now);
    },

    tokensToday(entryId, now) {
      return readToday(tokens_today, entryId, now);
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
      notify();
    },

    currentCursor(sourceKey) {
      return cursor.get(sourceKey) ?? 0;
    },

    currentDay(now) {
      return dailyKey(now ?? Date.now());
    },

    snapshot() {
      return buildSnapshot();
    },
  };
};
