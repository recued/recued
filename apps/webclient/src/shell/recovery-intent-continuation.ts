/** Privacy-safe continuity after an automatic recovery-intent resume pauses.
 *
 * The route landing controller deliberately stops watching after a short,
 * focus-safe window. This store keeps only enough same-tab context to offer a
 * deliberate re-entry from Attention: the local profile, a canonical broad
 * route, and the closed-list action posture. It never stores a DOM target,
 * record, run, connection, draft, field value, or receipt copy.
 */

import type { RecoveryLandingIntent } from './recovery-intent-landing.js';
import { safeServerSwitchLandingHash } from './server-switch-continuity.js';

export const RECOVERY_INTENT_CONTINUATION_SESSION_KEY =
  'recued.webclient.recovery-intent-continuation.v1';
export const RECOVERY_INTENT_CONTINUATION_MAX_AGE_MS = 30 * 60_000;

const VERSION = 1;
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

interface StoredRecoveryIntentContinuationV1 {
  readonly v: 1;
  readonly profile_id: string;
  readonly landing_hash: string;
  readonly intent: RecoveryIntentContinuationIntent;
  readonly paused_at: number;
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
  /** Make the durable value inert before removal so denied deletion cannot
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

  const retireStorage = (): void => {
    if (storage === null) return;
    try {
      storage.setItem(RECOVERY_INTENT_CONTINUATION_SESSION_KEY, RETIRED_MARKER);
      try {
        storage.removeItem(RECOVERY_INTENT_CONTINUATION_SESSION_KEY);
      } catch {
        // The value is already inert if deletion is denied.
      }
    } catch {
      try {
        storage.removeItem(RECOVERY_INTENT_CONTINUATION_SESSION_KEY);
      } catch {
        // Best-effort cleanup in denied storage.
      }
    }
  };

  const retire = (): void => {
    volatile = null;
    retireStorage();
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
    if (storage === null) return currentVolatile(readAt);
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
      const marker: RecoveryIntentContinuation = {
        profileId: input.profileId,
        landingHash: input.landingHash,
        intent: input.intent,
        pausedAt: armedAt,
        expiresAt: armedAt + maxAgeMs,
      };
      volatile = marker;
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
    retire,
  };
};
