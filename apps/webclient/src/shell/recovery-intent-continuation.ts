/** Privacy-safe continuity after an automatic recovery-intent resume pauses.
 *
 * The route landing controller deliberately stops watching after a short,
 * focus-safe window. This store keeps only enough same-tab context to offer a
 * deliberate re-entry from Attention: the local profile, a canonical broad
 * route, and the closed-list action posture. An unfinished post-review check
 * may add only its area/server target, lifecycle posture, bounded interruption
 * count, and closed-list reason. It never stores a DOM target, record, run,
 * connection, draft, field value, action result, or receipt copy.
 */

import type { RecoveryLandingIntent } from './recovery-intent-landing.js';
import { safeServerSwitchLandingHash } from './server-switch-continuity.js';

export const RECOVERY_INTENT_CONTINUATION_SESSION_KEY =
  'recued.webclient.recovery-intent-continuation.v1';
export const RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY =
  'recued.webclient.recovery-intent-review-verification.v2';
export const RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY =
  'recued.webclient.recovery-intent-deferred-check.v4';
export const RECOVERY_INTENT_CONTINUATION_MAX_AGE_MS = 30 * 60_000;

const VERSION = 1;
const REVIEW_VERIFICATION_VERSION = 2;
const LEGACY_RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY =
  'recued.webclient.recovery-intent-review-verification.v1';
const LEGACY_V3_RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY =
  'recued.webclient.recovery-intent-deferred-check.v3';
const LEGACY_V2_RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY =
  'recued.webclient.recovery-intent-deferred-check.v2';
const LEGACY_RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY =
  'recued.webclient.recovery-intent-deferred-check.v1';
const DEFERRED_CHECK_LEGACY_VERSION = 1;
const DEFERRED_CHECK_V2_VERSION = 2;
const DEFERRED_CHECK_PREVIOUS_VERSION = 3;
const DEFERRED_CHECK_VERSION = 4;
const RETIRED_MARKER = '0';
const CLOCK_SKEW_MS = 5 * 60_000;
const MAX_PROFILE_ID_LENGTH = 256;
const MAX_SAFE_LANDING_HASH_LENGTH = 512;

export type RecoveryIntentContinuationIntent = Exclude<
  RecoveryLandingIntent,
  'review'
>;

export type RecoveryIntentContinuationStorage = Pick<
  Storage,
  'getItem' | 'setItem' | 'removeItem'
>;

export interface RecoveryIntentContinuation {
  readonly profileId: string;
  readonly landingHash: string;
  readonly intent: RecoveryIntentContinuationIntent;
  readonly pausedAt: number;
  readonly expiresAt: number;
}

export type RecoveryIntentReviewInterruption =
  | 'connection'
  | 'navigation'
  | 'ownership'
  | 'reload';

/** Privacy-safe state for the one exact-area check that follows a direct
 * review. `ready` records only that the check remains to be started;
 * `checking` and `interrupted` bound an attempt that did start. This is
 * meaningful only while its exact parent continuation is still current. */
export interface RecoveryIntentReviewVerification {
  readonly profileId: string;
  readonly landingHash: string;
  readonly intent: RecoveryIntentContinuationIntent;
  readonly pausedAt: number;
  readonly reviewTarget: 'area' | 'server';
  readonly state: 'ready' | 'checking' | 'interrupted';
  readonly interruptionCount: 0 | 1 | 2;
  readonly lastInterruption: RecoveryIntentReviewInterruption | null;
}

/** A deliberately quiet exact-area check. It binds only to the parent
 * continuation's profile, scrubbed broad route, and creation time. The exact
 * intent is omitted so an expired marker can offer broad review without
 * reconstructing what the person previously meant to do. Its two-attempt
 * bound and area/server diagnosis target are closed-list state only. */
export interface RecoveryIntentDeferredCheck {
  readonly profileId: string;
  readonly landingHash: string;
  readonly pausedAt: number;
  readonly deferredAt: number;
  readonly expiresAt: number;
  /** The broad-area expiry notice is itself bounded and then disappears. */
  readonly handoffExpiresAt: number;
  /** A non-null value records only that a broad route-owned review began. */
  readonly reviewStartedAt: number | null;
  /** Explicit attempts are capped at two across reloads. This count contains
   * no result or route detail and reconnect never increments it. */
  readonly attemptCount: 0 | 1 | 2;
  /** Set only after the second unsuccessful attempt. This closed-list target
   * chooses a broad route review or exact active-server diagnosis without
   * persisting an error, response, credential, record, or prior intent. */
  readonly diagnosisTarget: 'area' | 'server' | null;
  /** Server diagnosis can end in one privacy-safe choice: run one fresh
   * broad-area check, or close the reminder. A started check never becomes
   * retryable after reload or failure. */
  readonly diagnosisOutcome:
    | 'choose'
    | 'recheck_started'
    | 'area_unconfirmed'
    | 'server_unavailable'
    | null;
}

interface StoredRecoveryIntentContinuationV1 {
  readonly v: 1;
  readonly profile_id: string;
  readonly landing_hash: string;
  readonly intent: RecoveryIntentContinuationIntent;
  readonly paused_at: number;
}

interface StoredRecoveryIntentReviewVerificationV2 {
  readonly v: 2;
  readonly profile_id: string;
  readonly landing_hash: string;
  readonly intent: RecoveryIntentContinuationIntent;
  readonly paused_at: number;
  readonly review_target: 'area' | 'server';
  readonly state: 'ready' | 'checking' | 'interrupted';
  readonly interruption_count: 0 | 1 | 2;
  readonly last_interruption: RecoveryIntentReviewInterruption | null;
}

interface StoredRecoveryIntentDeferredCheckV4 {
  readonly v: 4;
  readonly profile_id: string;
  readonly landing_hash: string;
  readonly paused_at: number;
  readonly deferred_at: number;
  readonly review_started_at: number | null;
  readonly attempt_count: 0 | 1 | 2;
  readonly diagnosis_target: 'area' | 'server' | null;
  readonly diagnosis_outcome:
    | 'choose'
    | 'recheck_started'
    | 'area_unconfirmed'
    | 'server_unavailable'
    | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean => {
  const keys = Object.keys(value);
  return keys.length === expected.length
    && expected.every((key) => Object.hasOwn(value, key));
};

const validProfileId = (value: unknown): value is string =>
  typeof value === 'string'
  && value.trim().length > 0
  && value.length <= MAX_PROFILE_ID_LENGTH;

const validSafeLandingHash = (value: unknown): value is string =>
  typeof value === 'string'
  && value.length > 0
  && value.length <= MAX_SAFE_LANDING_HASH_LENGTH
  && safeServerSwitchLandingHash(value) === value;

const validIntent = (
  value: unknown,
): value is RecoveryIntentContinuationIntent =>
  value === 'continue' || value === 'choose_again';

const validTime = (value: unknown): value is number =>
  typeof value === 'number'
  && Number.isSafeInteger(value)
  && value >= 0;

const validReviewInterruption = (
  value: unknown,
): value is RecoveryIntentReviewInterruption =>
  value === 'connection'
  || value === 'navigation'
  || value === 'ownership'
  || value === 'reload';

const resolveSessionStorage = (
  document: Document | undefined,
  storage: RecoveryIntentContinuationStorage | null | undefined,
): RecoveryIntentContinuationStorage | null => {
  if (storage !== undefined) return storage;
  try {
    return document?.defaultView?.sessionStorage
      ?? (globalThis as { sessionStorage?: Storage }).sessionStorage
      ?? null;
  } catch {
    return null;
  }
};

const resolveNow = (now: (() => number) | undefined): number => {
  try {
    const value = (now ?? Date.now)();
    return validTime(value) ? value : Date.now();
  } catch {
    return Date.now();
  }
};

const resolveMaxAge = (value: number | undefined): number =>
  value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : RECOVERY_INTENT_CONTINUATION_MAX_AGE_MS;

const parseStored = (
  raw: string | null,
  readAt: number,
  maxAgeMs: number,
): RecoveryIntentContinuation | null => {
  if (raw === null || raw === RETIRED_MARKER) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      'v',
      'profile_id',
      'landing_hash',
      'intent',
      'paused_at',
    ])
    || value.v !== VERSION
    || !validProfileId(value.profile_id)
    || !validSafeLandingHash(value.landing_hash)
    || !validIntent(value.intent)
    || !validTime(value.paused_at)
    || value.paused_at > readAt + CLOCK_SKEW_MS
    || Math.max(0, readAt - value.paused_at) > maxAgeMs
    || value.paused_at > Number.MAX_SAFE_INTEGER - maxAgeMs
  ) return null;
  return {
    profileId: value.profile_id,
    landingHash: value.landing_hash,
    intent: value.intent,
    pausedAt: value.paused_at,
    expiresAt: value.paused_at + maxAgeMs,
  };
};

const sameContinuation = (
  left: RecoveryIntentContinuation,
  right: Pick<
    RecoveryIntentContinuation,
    'profileId' | 'landingHash' | 'intent' | 'pausedAt'
  >,
): boolean =>
  left.profileId === right.profileId
  && left.landingHash === right.landingHash
  && left.intent === right.intent
  && left.pausedAt === right.pausedAt;

const parseStoredReviewVerification = (
  raw: string | null,
  marker: RecoveryIntentContinuation,
): RecoveryIntentReviewVerification | null => {
  if (raw === null || raw === RETIRED_MARKER) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const commonValid =
    validProfileId(value.profile_id)
    && validSafeLandingHash(value.landing_hash)
    && validIntent(value.intent)
    && validTime(value.paused_at)
    && (value.review_target === 'area' || value.review_target === 'server');
  if (!commonValid) return null;
  let verification: RecoveryIntentReviewVerification;
  if (
    value.v === VERSION
    && hasExactKeys(value, [
      'v',
      'profile_id',
      'landing_hash',
      'intent',
      'paused_at',
      'review_target',
    ])
  ) {
    // v1 only proved that a check had started. Seeing it after this version
    // boots is therefore one reload interruption, never a completed result.
    verification = {
      profileId: value.profile_id as string,
      landingHash: value.landing_hash as string,
      intent: value.intent as RecoveryIntentContinuationIntent,
      pausedAt: value.paused_at as number,
      reviewTarget: value.review_target as 'area' | 'server',
      state: 'interrupted',
      interruptionCount: 1,
      lastInterruption: 'reload',
    };
  } else if (
    value.v === REVIEW_VERIFICATION_VERSION
    && hasExactKeys(value, [
      'v',
      'profile_id',
      'landing_hash',
      'intent',
      'paused_at',
      'review_target',
      'state',
      'interruption_count',
      'last_interruption',
    ])
    && (
      value.state === 'ready'
      || value.state === 'checking'
      || value.state === 'interrupted'
    )
    && (value.state !== 'ready' || value.review_target === 'server')
    && (
      value.interruption_count === 0
      || value.interruption_count === 1
      || value.interruption_count === 2
    )
    && (
      (
        value.state === 'ready'
        && value.interruption_count === 0
        && value.last_interruption === null
      )
      || (
        value.state === 'checking'
        && value.last_interruption === null
      )
      || (
        value.state === 'interrupted'
        && value.interruption_count > 0
        && validReviewInterruption(value.last_interruption)
      )
    )
  ) {
    verification = {
      profileId: value.profile_id as string,
      landingHash: value.landing_hash as string,
      intent: value.intent as RecoveryIntentContinuationIntent,
      pausedAt: value.paused_at as number,
      reviewTarget: value.review_target as 'area' | 'server',
      state: value.state,
      interruptionCount: value.interruption_count,
      lastInterruption: value.last_interruption,
    };
  } else {
    return null;
  }
  return sameContinuation(marker, verification) ? verification : null;
};

const parseStoredDeferredCheck = (
  raw: string | null,
  readAt: number,
  maxAgeMs: number,
  handoffMaxAgeMs: number,
): RecoveryIntentDeferredCheck | null => {
  if (raw === null || raw === RETIRED_MARKER) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const legacy = value.v === DEFERRED_CHECK_LEGACY_VERSION
    && hasExactKeys(value, [
      'v', 'profile_id', 'landing_hash', 'paused_at', 'deferred_at',
    ]);
  const legacyV2 = value.v === DEFERRED_CHECK_V2_VERSION
    && hasExactKeys(value, [
      'v',
      'profile_id',
      'landing_hash',
      'paused_at',
      'deferred_at',
      'review_started_at',
    ]);
  const previous = value.v === DEFERRED_CHECK_PREVIOUS_VERSION
    && hasExactKeys(value, [
      'v',
      'profile_id',
      'landing_hash',
      'paused_at',
      'deferred_at',
      'review_started_at',
      'attempt_count',
      'diagnosis_target',
    ]);
  const current = value.v === DEFERRED_CHECK_VERSION
    && hasExactKeys(value, [
      'v',
      'profile_id',
      'landing_hash',
      'paused_at',
      'deferred_at',
      'review_started_at',
      'attempt_count',
      'diagnosis_target',
      'diagnosis_outcome',
    ]);
  if (
    (!legacy && !legacyV2 && !previous && !current)
    || !validProfileId(value.profile_id)
    || !validSafeLandingHash(value.landing_hash)
    || !validTime(value.paused_at)
    || !validTime(value.deferred_at)
    || value.paused_at > Number.MAX_SAFE_INTEGER - maxAgeMs
    || value.paused_at + maxAgeMs
      > Number.MAX_SAFE_INTEGER - handoffMaxAgeMs
    || value.deferred_at < value.paused_at
    || value.deferred_at > value.paused_at + maxAgeMs
    || value.deferred_at > readAt + CLOCK_SKEW_MS
    || readAt >= value.paused_at + maxAgeMs + handoffMaxAgeMs
  ) return null;
  const expiresAt = value.paused_at + maxAgeMs;
  const handoffExpiresAt = expiresAt + handoffMaxAgeMs;
  const reviewStartedAt = legacy || value.review_started_at === null
    ? null
    : value.review_started_at;
  if (
    reviewStartedAt !== null
    && (
      !validTime(reviewStartedAt)
      || reviewStartedAt < expiresAt
      || reviewStartedAt >= handoffExpiresAt
      || readAt < expiresAt
      || reviewStartedAt > readAt + CLOCK_SKEW_MS
    )
  ) return null;
  const attemptCount = legacy
    ? 0
    : legacyV2
      ? (reviewStartedAt === null ? 0 : 1)
      : value.attempt_count;
  const diagnosisTarget = previous || current
    ? value.diagnosis_target
    : null;
  const diagnosisOutcome = current ? value.diagnosis_outcome : null;
  if (
    (attemptCount !== 0 && attemptCount !== 1 && attemptCount !== 2)
    || (
      diagnosisTarget !== null
      && diagnosisTarget !== 'area'
      && diagnosisTarget !== 'server'
    )
    || (reviewStartedAt === null) !== (attemptCount === 0)
    || (diagnosisTarget !== null && attemptCount !== 2)
    || (
      diagnosisOutcome !== null
      && diagnosisOutcome !== 'choose'
      && diagnosisOutcome !== 'recheck_started'
      && diagnosisOutcome !== 'area_unconfirmed'
      && diagnosisOutcome !== 'server_unavailable'
    )
    || (diagnosisOutcome !== null && diagnosisTarget !== 'server')
  ) return null;
  return {
    profileId: value.profile_id,
    landingHash: value.landing_hash,
    pausedAt: value.paused_at,
    deferredAt: value.deferred_at,
    expiresAt,
    handoffExpiresAt,
    reviewStartedAt,
    attemptCount,
    diagnosisTarget,
    diagnosisOutcome,
  };
};

export interface RecoveryIntentDeferredCheckStore {
  /** Read a current or recently expired quiet marker for this exact profile.
   * Invalid, cross-profile, and over-age values are retired. */
  readForProfile(profileId: string): RecoveryIntentDeferredCheck | null;
  /** Quiet one prepared server-review check without extending its parent TTL.
   * Repeated deferral is idempotent for the same parent marker. */
  defer(
    marker: RecoveryIntentContinuation,
  ): RecoveryIntentDeferredCheck | null;
  /** Start one explicit broad-area attempt. The stored timestamp and bounded
   * attempt count survive reload; a diagnosis-bound marker cannot restart. */
  markReviewStarted(
    marker: RecoveryIntentDeferredCheck,
  ): RecoveryIntentDeferredCheck | null;
  /** Complete an unsuccessful attempt. Only the second failure persists the
   * closed-list diagnosis target; duplicate completion is idempotent. */
  recordReviewFailure(
    marker: RecoveryIntentDeferredCheck,
    diagnosisTarget: 'area' | 'server',
  ): RecoveryIntentDeferredCheck | null;
  /** Record that the exact server diagnosis finished and expose one explicit
   * broad-area recheck-or-close choice. */
  recordDiagnosisOutcome(
    marker: RecoveryIntentDeferredCheck,
  ): RecoveryIntentDeferredCheck | null;
  /** Consume the one post-diagnosis recheck choice before route work begins. */
  markDiagnosisRecheckStarted(
    marker: RecoveryIntentDeferredCheck,
  ): RecoveryIntentDeferredCheck | null;
  /** End the consumed recheck without creating another retry. */
  recordDiagnosisRecheckFailure(
    marker: RecoveryIntentDeferredCheck,
    target: 'area' | 'server',
  ): RecoveryIntentDeferredCheck | null;
  /** Retire the quiet/expired handoff without touching unrelated storage. */
  clear(): void;
}

export const createRecoveryIntentDeferredCheckStore = (options: {
  readonly document?: Document;
  readonly storage?: RecoveryIntentContinuationStorage | null;
  readonly now?: () => number;
  readonly maxAgeMs?: number;
  readonly handoffMaxAgeMs?: number;
} = {}): RecoveryIntentDeferredCheckStore => {
  const storage = resolveSessionStorage(options.document, options.storage);
  const maxAgeMs = resolveMaxAge(options.maxAgeMs);
  const handoffMaxAgeMs = resolveMaxAge(options.handoffMaxAgeMs);
  let volatile: RecoveryIntentDeferredCheck | null = null;
  let retiredLocally = false;

  const retireStorageKey = (key: string): void => {
    if (storage === null) return;
    try {
      storage.setItem(key, RETIRED_MARKER);
      try {
        storage.removeItem(key);
      } catch {
        // The tombstone already makes a denied deletion inert.
      }
    } catch {
      try {
        storage.removeItem(key);
      } catch {
        // Best-effort cleanup when storage is unavailable.
      }
    }
  };

  const clear = (): void => {
    volatile = null;
    retiredLocally = true;
    retireStorageKey(RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY);
    retireStorageKey(
      LEGACY_V3_RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
    );
    retireStorageKey(
      LEGACY_V2_RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
    );
    retireStorageKey(LEGACY_RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY);
  };

  const persist = (value: RecoveryIntentDeferredCheck): void => {
    const stored: StoredRecoveryIntentDeferredCheckV4 = {
      v: DEFERRED_CHECK_VERSION,
      profile_id: value.profileId,
      landing_hash: value.landingHash,
      paused_at: value.pausedAt,
      deferred_at: value.deferredAt,
      review_started_at: value.reviewStartedAt,
      attempt_count: value.attemptCount,
      diagnosis_target: value.diagnosisTarget,
      diagnosis_outcome: value.diagnosisOutcome,
    };
    try {
      storage?.setItem(
        RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
        JSON.stringify(stored),
      );
      try {
        storage?.removeItem(
          LEGACY_V3_RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
        );
        storage?.removeItem(
          LEGACY_V2_RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
        );
        storage?.removeItem(
          LEGACY_RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
        );
      } catch {
        // The current value is authoritative even if legacy cleanup is denied.
      }
    } catch {
      // The same-tab posture remains authoritative in memory.
    }
  };

  const read = (readAt: number): RecoveryIntentDeferredCheck | null => {
    if (retiredLocally) return null;
    if (volatile !== null) {
      if (readAt < volatile.handoffExpiresAt) return volatile;
      clear();
      return null;
    }
    if (storage === null) return null;
    let raw: string | null;
    try {
      raw = storage.getItem(RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY);
      if (raw === null) {
        raw = storage.getItem(
          LEGACY_V3_RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
        );
      }
      if (raw === null) {
        raw = storage.getItem(
          LEGACY_V2_RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
        );
      }
      if (raw === null) {
        raw = storage.getItem(
          LEGACY_RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
        );
      }
    } catch {
      return null;
    }
    const parsed = parseStoredDeferredCheck(
      raw,
      readAt,
      maxAgeMs,
      handoffMaxAgeMs,
    );
    if (parsed === null) {
      if (raw !== null) clear();
      return null;
    }
    volatile = parsed;
    return parsed;
  };

  return {
    readForProfile: (profileId) => {
      if (!validProfileId(profileId)) {
        clear();
        return null;
      }
      const marker = read(resolveNow(options.now));
      if (marker === null) return null;
      if (marker.profileId !== profileId) {
        clear();
        return null;
      }
      return marker;
    },
    defer: (marker) => {
      const deferredAt = resolveNow(options.now);
      if (
        !validProfileId(marker.profileId)
        || !validSafeLandingHash(marker.landingHash)
        || !validTime(marker.pausedAt)
        || !validTime(marker.expiresAt)
        || marker.pausedAt > Number.MAX_SAFE_INTEGER - maxAgeMs
        || marker.expiresAt !== marker.pausedAt + maxAgeMs
        || deferredAt < marker.pausedAt
        || deferredAt >= marker.expiresAt
        || marker.expiresAt
          > Number.MAX_SAFE_INTEGER - handoffMaxAgeMs
      ) return null;
      const current = read(deferredAt);
      if (
        current !== null
        && current.profileId === marker.profileId
        && current.landingHash === marker.landingHash
        && current.pausedAt === marker.pausedAt
      ) return current;
      const deferred: RecoveryIntentDeferredCheck = {
        profileId: marker.profileId,
        landingHash: marker.landingHash,
        pausedAt: marker.pausedAt,
        deferredAt,
        expiresAt: marker.expiresAt,
        handoffExpiresAt: marker.expiresAt + handoffMaxAgeMs,
        reviewStartedAt: null,
        attemptCount: 0,
        diagnosisTarget: null,
        diagnosisOutcome: null,
      };
      volatile = deferred;
      retiredLocally = false;
      persist(deferred);
      return deferred;
    },
    markReviewStarted: (marker) => {
      const reviewStartedAt = resolveNow(options.now);
      if (
        reviewStartedAt < marker.expiresAt
        || reviewStartedAt >= marker.handoffExpiresAt
      ) return null;
      const current = read(reviewStartedAt);
      if (
        current === null
        || current.profileId !== marker.profileId
        || current.landingHash !== marker.landingHash
        || current.pausedAt !== marker.pausedAt
        || current.deferredAt !== marker.deferredAt
        || current.expiresAt !== marker.expiresAt
        || current.handoffExpiresAt !== marker.handoffExpiresAt
      ) return null;
      if (
        current.diagnosisTarget !== null
        || current.diagnosisOutcome !== null
      ) return current;
      const started: RecoveryIntentDeferredCheck = {
        ...current,
        reviewStartedAt,
        attemptCount: current.attemptCount === 0 ? 1 : 2,
      };
      volatile = started;
      retiredLocally = false;
      persist(started);
      return started;
    },
    recordReviewFailure: (marker, diagnosisTarget) => {
      const failedAt = resolveNow(options.now);
      const current = read(failedAt);
      if (
        current === null
        || current.profileId !== marker.profileId
        || current.landingHash !== marker.landingHash
        || current.pausedAt !== marker.pausedAt
        || current.deferredAt !== marker.deferredAt
        || current.expiresAt !== marker.expiresAt
        || current.handoffExpiresAt !== marker.handoffExpiresAt
        || current.reviewStartedAt !== marker.reviewStartedAt
        || current.attemptCount !== marker.attemptCount
        || current.attemptCount === 0
      ) return null;
      if (
        current.diagnosisTarget !== null
        || current.diagnosisOutcome !== null
        || current.attemptCount < 2
      ) {
        return current;
      }
      const failed: RecoveryIntentDeferredCheck = {
        ...current,
        diagnosisTarget,
      };
      volatile = failed;
      retiredLocally = false;
      persist(failed);
      return failed;
    },
    recordDiagnosisOutcome: (marker) => {
      const recordedAt = resolveNow(options.now);
      const current = read(recordedAt);
      if (
        current === null
        || current.profileId !== marker.profileId
        || current.landingHash !== marker.landingHash
        || current.pausedAt !== marker.pausedAt
        || current.deferredAt !== marker.deferredAt
        || current.expiresAt !== marker.expiresAt
        || current.handoffExpiresAt !== marker.handoffExpiresAt
        || current.reviewStartedAt !== marker.reviewStartedAt
        || current.attemptCount !== 2
        || current.diagnosisTarget !== 'server'
      ) return null;
      if (current.diagnosisOutcome !== null) return current;
      const outcome: RecoveryIntentDeferredCheck = {
        ...current,
        diagnosisOutcome: 'choose',
      };
      volatile = outcome;
      retiredLocally = false;
      persist(outcome);
      return outcome;
    },
    markDiagnosisRecheckStarted: (marker) => {
      const startedAt = resolveNow(options.now);
      const current = read(startedAt);
      if (
        current === null
        || current.profileId !== marker.profileId
        || current.landingHash !== marker.landingHash
        || current.pausedAt !== marker.pausedAt
        || current.deferredAt !== marker.deferredAt
        || current.expiresAt !== marker.expiresAt
        || current.handoffExpiresAt !== marker.handoffExpiresAt
        || current.reviewStartedAt !== marker.reviewStartedAt
        || current.attemptCount !== 2
        || current.diagnosisTarget !== 'server'
      ) return null;
      if (current.diagnosisOutcome === 'recheck_started') return current;
      if (current.diagnosisOutcome !== 'choose') return null;
      const started: RecoveryIntentDeferredCheck = {
        ...current,
        diagnosisOutcome: 'recheck_started',
      };
      volatile = started;
      retiredLocally = false;
      persist(started);
      return started;
    },
    recordDiagnosisRecheckFailure: (marker, target) => {
      const failedAt = resolveNow(options.now);
      const current = read(failedAt);
      if (
        current === null
        || current.profileId !== marker.profileId
        || current.landingHash !== marker.landingHash
        || current.pausedAt !== marker.pausedAt
        || current.deferredAt !== marker.deferredAt
        || current.expiresAt !== marker.expiresAt
        || current.handoffExpiresAt !== marker.handoffExpiresAt
        || current.reviewStartedAt !== marker.reviewStartedAt
        || current.attemptCount !== 2
        || current.diagnosisTarget !== 'server'
        || current.diagnosisOutcome !== 'recheck_started'
      ) return null;
      const failed: RecoveryIntentDeferredCheck = {
        ...current,
        diagnosisOutcome: target === 'server'
          ? 'server_unavailable'
          : 'area_unconfirmed',
      };
      volatile = failed;
      retiredLocally = false;
      persist(failed);
      return failed;
    },
    clear,
  };
};

export interface RecoveryIntentContinuationStore {
  /** Return only a current marker for this exact active profile. Invalid,
   * expired, and mismatched state is retired instead of crossing profiles. */
  readForProfile(profileId: string): RecoveryIntentContinuation | null;
  /** Arm or deduplicate one paused return. Storage denial still preserves the
   * current-tab in-memory affordance. Invalid inputs never replace a valid one. */
  arm(input: {
    readonly profileId: string;
    readonly landingHash: string;
    readonly intent: RecoveryIntentContinuationIntent;
  }): RecoveryIntentContinuation | null;
  /** Restore only an unfinished direct-review verification bound to this exact
   * continuation. Invalid or mismatched verifier state is cleared without
   * discarding the still-valid parent continuation. */
  readReviewVerification(
    marker: RecoveryIntentContinuation,
  ): RecoveryIntentReviewVerification | null;
  /** Persist only that one explicit route-owned check remains after a server
   * review. The server action, receipt, observed state, and provider detail
   * stay memory-only and are never accepted by this API. */
  prepareReviewVerification(
    marker: RecoveryIntentContinuation,
  ): RecoveryIntentReviewVerification | null;
  /** Mark an authoritative outcome check in flight while preserving its capped
   * prior interruption count. No provider detail, error, credential, or
   * receipt is stored. */
  armReviewVerification(
    marker: RecoveryIntentContinuation,
    reviewTarget: RecoveryIntentReviewVerification['reviewTarget'],
  ): RecoveryIntentReviewVerification | null;
  /** Record one closed-list interruption. Repeated signals for an already
   * interrupted attempt deduplicate, and the count caps at two. */
  interruptReviewVerification(
    marker: RecoveryIntentContinuation,
    reviewTarget: RecoveryIntentReviewVerification['reviewTarget'],
    reason: RecoveryIntentReviewInterruption,
  ): RecoveryIntentReviewVerification | null;
  /** Clear only the unfinished-verification marker after a determinate result
   * or a fresh direct review. */
  clearReviewVerification(): void;
  /** Make both durable values inert before removal so denied deletion cannot
   * replay an already completed or dismissed continuation. */
  retire(): void;
}

export const createRecoveryIntentContinuationStore = (options: {
  readonly document?: Document;
  readonly storage?: RecoveryIntentContinuationStorage | null;
  readonly now?: () => number;
  readonly maxAgeMs?: number;
} = {}): RecoveryIntentContinuationStore => {
  const storage = resolveSessionStorage(options.document, options.storage);
  const maxAgeMs = resolveMaxAge(options.maxAgeMs);
  let volatile: RecoveryIntentContinuation | null = null;
  let volatileReviewVerification: RecoveryIntentReviewVerification | null =
    null;
  // A tab-local decision must outrank an older readable value when storage
  // changes from writable to read-only. Re-arming deliberately clears the
  // corresponding tombstone and makes the new volatile value authoritative.
  let continuationRetiredLocally = false;
  let reviewVerificationRetiredLocally = false;

  const retireStorageKey = (key: string): void => {
    if (storage === null) return;
    try {
      storage.setItem(key, RETIRED_MARKER);
      try {
        storage.removeItem(key);
      } catch {
        // The value is already inert if deletion is denied.
      }
    } catch {
      try {
        storage.removeItem(key);
      } catch {
        // Best-effort cleanup in denied storage.
      }
    }
  };

  const clearReviewVerification = (): void => {
    volatileReviewVerification = null;
    reviewVerificationRetiredLocally = true;
    retireStorageKey(RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY);
    retireStorageKey(
      LEGACY_RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
    );
  };

  const retire = (): void => {
    volatile = null;
    volatileReviewVerification = null;
    continuationRetiredLocally = true;
    reviewVerificationRetiredLocally = true;
    retireStorageKey(RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY);
    retireStorageKey(
      LEGACY_RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
    );
    retireStorageKey(RECOVERY_INTENT_CONTINUATION_SESSION_KEY);
  };

  const currentVolatile = (readAt: number): RecoveryIntentContinuation | null => {
    if (volatile === null) return null;
    if (readAt > volatile.expiresAt) {
      retire();
      return null;
    }
    return volatile;
  };

  const readStored = (readAt: number): RecoveryIntentContinuation | null => {
    if (continuationRetiredLocally) return currentVolatile(readAt);
    const inMemory = currentVolatile(readAt);
    if (inMemory !== null || storage === null) return inMemory;
    let raw: string | null;
    try {
      raw = storage.getItem(RECOVERY_INTENT_CONTINUATION_SESSION_KEY);
    } catch {
      return currentVolatile(readAt);
    }
    if (raw === null) return currentVolatile(readAt);
    const parsed = parseStored(raw, readAt, maxAgeMs);
    if (parsed === null) {
      retire();
      return null;
    }
    volatile = parsed;
    continuationRetiredLocally = false;
    return parsed;
  };

  const persistReviewVerification = (
    verification: RecoveryIntentReviewVerification,
  ): RecoveryIntentReviewVerification => {
    volatileReviewVerification = verification;
    reviewVerificationRetiredLocally = false;
    const stored: StoredRecoveryIntentReviewVerificationV2 = {
      v: REVIEW_VERIFICATION_VERSION,
      profile_id: verification.profileId,
      landing_hash: verification.landingHash,
      intent: verification.intent,
      paused_at: verification.pausedAt,
      review_target: verification.reviewTarget,
      state: verification.state,
      interruption_count: verification.interruptionCount,
      last_interruption: verification.lastInterruption,
    };
    let persisted = false;
    try {
      if (storage !== null) {
        storage.setItem(
          RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
          JSON.stringify(stored),
        );
        persisted = true;
      }
    } catch {
      // The current tab still owns the closed-list verification lifecycle.
    }
    if (persisted) {
      // Keep a readable legacy proof until the replacement is durable. A
      // quota failure must not turn the next reload back into an unbounded
      // neutral continuation.
      retireStorageKey(
        LEGACY_RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
      );
    }
    return verification;
  };

  const readReviewVerification = (
    marker: RecoveryIntentContinuation,
  ): RecoveryIntentReviewVerification | null => {
    const current = readStored(resolveNow(options.now));
    if (current === null || !sameContinuation(current, marker)) {
      clearReviewVerification();
      return null;
    }
    if (reviewVerificationRetiredLocally) return null;
    if (
      volatileReviewVerification !== null
      && sameContinuation(current, volatileReviewVerification)
    ) return volatileReviewVerification;
    if (storage === null) return null;
    let raw: string | null;
    let legacy = false;
    try {
      raw = storage.getItem(
        RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
      );
      if (raw === null) {
        raw = storage.getItem(
          LEGACY_RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
        );
        legacy = raw !== null;
      }
    } catch {
      return null;
    }
    if (raw === null) return null;
    const parsed = parseStoredReviewVerification(raw, current);
    if (parsed === null) {
      clearReviewVerification();
      return null;
    }
    if (legacy) return persistReviewVerification(parsed);
    volatileReviewVerification = parsed;
    reviewVerificationRetiredLocally = false;
    return parsed;
  };

  return {
    readForProfile: (profileId): RecoveryIntentContinuation | null => {
      if (!validProfileId(profileId)) {
        retire();
        return null;
      }
      const marker = readStored(resolveNow(options.now));
      if (marker === null) return null;
      if (marker.profileId !== profileId) {
        retire();
        return null;
      }
      return marker;
    },
    arm: (input): RecoveryIntentContinuation | null => {
      if (
        !validProfileId(input.profileId)
        || !validSafeLandingHash(input.landingHash)
        || !validIntent(input.intent)
      ) return null;
      const armedAt = resolveNow(options.now);
      const current = readStored(armedAt);
      if (
        current !== null
        && current.profileId === input.profileId
        && current.landingHash === input.landingHash
        && current.intent === input.intent
      ) return current;
      if (armedAt > Number.MAX_SAFE_INTEGER - maxAgeMs) return null;
      // A genuinely new paused return cannot inherit an unfinished verifier
      // from the prior route/profile, even if storage removal is denied.
      clearReviewVerification();
      const marker: RecoveryIntentContinuation = {
        profileId: input.profileId,
        landingHash: input.landingHash,
        intent: input.intent,
        pausedAt: armedAt,
        expiresAt: armedAt + maxAgeMs,
      };
      volatile = marker;
      continuationRetiredLocally = false;
      const stored: StoredRecoveryIntentContinuationV1 = {
        v: VERSION,
        profile_id: marker.profileId,
        landing_hash: marker.landingHash,
        intent: marker.intent,
        paused_at: marker.pausedAt,
      };
      try {
        storage?.setItem(
          RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
          JSON.stringify(stored),
        );
      } catch {
        // The same-tab in-memory continuation remains available.
      }
      return marker;
    },
    readReviewVerification,
    prepareReviewVerification: (marker) => {
      const current = readStored(resolveNow(options.now));
      if (current === null || !sameContinuation(current, marker)) return null;
      return persistReviewVerification({
        profileId: current.profileId,
        landingHash: current.landingHash,
        intent: current.intent,
        pausedAt: current.pausedAt,
        reviewTarget: 'server',
        state: 'ready',
        interruptionCount: 0,
        lastInterruption: null,
      });
    },
    armReviewVerification: (marker, reviewTarget) => {
      if (reviewTarget !== 'area' && reviewTarget !== 'server') return null;
      const current = readStored(resolveNow(options.now));
      if (current === null || !sameContinuation(current, marker)) return null;
      const previous = readReviewVerification(marker);
      const verification: RecoveryIntentReviewVerification = {
        profileId: current.profileId,
        landingHash: current.landingHash,
        intent: current.intent,
        pausedAt: current.pausedAt,
        reviewTarget,
        state: 'checking',
        interruptionCount:
          previous?.reviewTarget === reviewTarget
            ? previous.interruptionCount
            : 0,
        lastInterruption: null,
      };
      return persistReviewVerification(verification);
    },
    interruptReviewVerification: (marker, reviewTarget, reason) => {
      if (
        (reviewTarget !== 'area' && reviewTarget !== 'server')
        || !validReviewInterruption(reason)
      ) return null;
      const verification = readReviewVerification(marker);
      if (
        verification === null
        || verification.reviewTarget !== reviewTarget
      ) return null;
      if (verification.state === 'interrupted') return verification;
      if (verification.state !== 'checking') return null;
      return persistReviewVerification({
        ...verification,
        state: 'interrupted',
        interruptionCount: Math.min(
          2,
          verification.interruptionCount + 1,
        ) as 1 | 2,
        lastInterruption: reason,
      });
    },
    clearReviewVerification,
    retire,
  };
};
