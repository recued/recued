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
export const RECOVERY_INTENT_CONTINUATION_MAX_AGE_MS = 30 * 60_000;

const VERSION = 1;
const REVIEW_VERIFICATION_VERSION = 2;
const LEGACY_RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY =
  'recued.webclient.recovery-intent-review-verification.v1';
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
