/** D-132 — Per-topic trust state + pool policy contracts.
 *
 *  The promotion path D-123 left implicit. Each enrichment topic
 *  carries:
 *    - `trust_state` — `'off' | 'manual' | 'auto'`. Replaces the
 *      static `idle_eligible` derivation at the scheduler. AI-surface
 *      producers default to `'manual'`; deterministic producers
 *      default to `'auto'`.
 *    - `pool_policy` — `'free_only' | 'free_then_byok' | 'byok_only'`.
 *      Translates 1:1 to the existing `ForceLayer` at producer call
 *      time. Author declares the per-topic default in the registry;
 *      user overrides per-topic.
 *
 *  Substrate-only types here — the runtime + persistence + UI live in
 *  `backend/server/src/housekeeping/trust-store.ts` and the
 *  `packages/ui-shared/` settings panel. Spec: `docs/d-132-spec.md`. */

// ────────────────────────────────────────────────────────────────
// Trust state
// ────────────────────────────────────────────────────────────────

/** Three-state trust gate. `'off'` — never run, even via Run Now;
 *  `'manual'` — Run Now only, idle/reactive cycles skip;
 *  `'auto'` — idle cycles + reactive dispatch fire freely. The
 *  fourth "ask before each scheduled run" state was deliberately cut
 *  (incompatible with idle-driven housekeeping per `docs/d-132-spec.md`
 *  load-bearing decision §1). */
export type EnrichmentTrustState = 'off' | 'manual' | 'auto';

/** Default trust state for AI-surface producers absent registry
 *  override. The conservative default — user explicitly promotes via
 *  the trust radios after observing a few manual runs. */
export const TRUST_DEFAULT_AI: EnrichmentTrustState = 'manual';

/** Default trust state for deterministic (zero-token) producers
 *  absent registry override. They run on every idle cycle by default;
 *  the user can disable per-topic if undesired. */
export const TRUST_DEFAULT_DETERMINISTIC: EnrichmentTrustState = 'auto';

/** Closed enumeration. Used by the rpc validator (`housekeeping.trust.write`)
 *  + UI radios. */
export const ALL_ENRICHMENT_TRUST_STATES: ReadonlyArray<EnrichmentTrustState> = [
  'off',
  'manual',
  'auto',
] as const;

// ────────────────────────────────────────────────────────────────
// Pool policy
// ────────────────────────────────────────────────────────────────

/** Where AI inference cost lands for a given producer's runs.
 *    - `'free_only'` — never use BYOK; skip-and-log when the free
 *      pool is exhausted.
 *    - `'free_then_byok'` — try free first, fall back to BYOK
 *      (default behaviour today).
 *    - `'byok_only'` — bypass free pool, use BYOK directly; skip
 *      when no BYOK is configured. */
export type EnrichmentPoolPolicy = 'free_only' | 'free_then_byok' | 'byok_only';

/** Default pool routing absent registry override. Conservative —
 *  authors should declare per-producer for sensible defaults. */
export const POOL_POLICY_DEFAULT: EnrichmentPoolPolicy = 'free_then_byok';

/** Closed enumeration. Used by the rpc validator
 *  (`housekeeping.trust.write`) + UI radios. */
export const ALL_ENRICHMENT_POOL_POLICIES: ReadonlyArray<EnrichmentPoolPolicy> = [
  'free_only',
  'free_then_byok',
  'byok_only',
] as const;

// ────────────────────────────────────────────────────────────────
// Promotion suggestion
// ────────────────────────────────────────────────────────────────

/** Successful manual runs before the promotion-suggestion banner
 *  fires. Tunable via telemetry post-launch — pre-launch the gut-feel
 *  threshold from the design discussion is what ships. */
export const MANUAL_RUN_THRESHOLD = 3;

// ────────────────────────────────────────────────────────────────
// Pause-AI control
// ────────────────────────────────────────────────────────────────

/** Pause durations surfaced in the top-bar Pause-AI control. The
 *  fixed presets avoid free-form duration fields that invite typo-
 *  driven 9999-hour pauses. */
export const PAUSE_DURATIONS_MS = {
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '24h': 24 * 60 * 60_000,
} as const;

/** Sentinel for the "until I resume" duration option — the UI sets
 *  `pause_background_ai_until` to this value and treats it as a
 *  user-managed indefinite pause. The far-future timestamp avoids a
 *  separate column / discriminator while staying readable in the DB. */
export const PAUSE_UNTIL_RESUME_TIMESTAMP = 8_640_000_000_000_000; // ECMA max safe Date

// ────────────────────────────────────────────────────────────────
// Error history
// ────────────────────────────────────────────────────────────────

/** Last-N error ring buffer size on the per-topic detail drawer.
 *  3 is enough to spot intermittent vs sticky failures without
 *  bloating the `housekeeping_state.last_errors_json` column. */
export const TRUST_ERROR_HISTORY_SIZE = 3;

// ────────────────────────────────────────────────────────────────
// Persistence row shape
// ────────────────────────────────────────────────────────────────

/** Row shape for `enrichment_trust`. Single-row upsert keyed on
 *  topic — absent row means "registry default." Returned from
 *  `housekeeping.trust.read` rpc. */
export interface EnrichmentTrustRow {
  topic: string;
  trust_state: EnrichmentTrustState;
  pool_policy: EnrichmentPoolPolicy;
  /** Increments on each successful manual fire of an AI-surface
   *  producer with `trust_state === 'manual'`. Crosses
   *  `MANUAL_RUN_THRESHOLD` → triggers the promotion-suggestion
   *  banner. */
  manual_run_count: number;
  /** Timestamp when the promotion banner first fired for this
   *  topic. Null when the threshold hasn't been crossed yet. */
  promotion_suggested_at: number | null;
  /** Timestamp when the user dismissed the banner via "Don't ask
   *  again." Null when the user has either never been shown the
   *  banner or has been shown but neither dismissed nor promoted. */
  promotion_dismissed_at: number | null;
  updated_at: number;
}

/** Last-N errors stored on `housekeeping_state.last_errors_json` for
 *  the detail drawer. Newest-first; `last_error` (existing column)
 *  remains the most-recent entry for back-compat with existing
 *  status reads. */
export interface HousekeepingErrorEntry {
  ts: number;
  message: string;
}
