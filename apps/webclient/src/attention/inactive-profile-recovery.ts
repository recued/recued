/** Privacy-safe discovery for connection recovery on inactive server profiles.
 *
 * Recued has one live server per tab, so it cannot truthfully query an inactive
 * profile. The active profile may instead leave a bounded, last-observed hint
 * containing only its opaque browser-local id, a boolean, and an observation
 * time. Labels, server URLs, connection identities/counts/statuses, endpoints,
 * credentials, and raw errors never enter this store.
 *
 * A separate session marker carries only opaque profile ids, a route that has
 * already passed the normal server-switch scrubber, and a closed-list posture
 * saying whether source-owned detail had to be withheld. It survives the
 * deliberate switch reload, keeps the recovery excursion open while work is
 * unresolved, and can offer a reviewed return to the source after a fresh
 * authoritative all-clear. Labels, URLs, record ids, drafts, and recovery
 * details never enter the marker.
 */

import {
  isRecoveryReturnContext,
  safeServerSwitchLandingHash,
  type RecoveryReturnContext,
} from '../shell/server-switch-continuity.js';

export const INACTIVE_PROFILE_RECOVERY_HINT_KEY_PREFIX =
  'recued.connections.inactive-profile-recovery.v1:' as const;
export const INACTIVE_PROFILE_RECOVERY_REVIEW_SESSION_KEY =
  'recued.connections.inactive-profile-recovery-review.v1' as const;

const VERSION = 1 as const;
const REVIEW_EXCURSION_VERSION = 2 as const;
const CONTEXT_AWARE_EXCURSION_VERSION = 3 as const;
const RETIRED_MARKER = '0';
const MAX_PROFILE_ID_LENGTH = 256;
const MAX_SAFE_RETURN_HASH_LENGTH = 512;
const CLOCK_SKEW_MS = 1_000;
const DEFAULT_HINT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_REVIEW_MAX_AGE_MS = 30 * 60 * 1_000;
const DEFAULT_EXCURSION_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export type InactiveProfileRecoveryStorage = Pick<
  Storage,
  'getItem' | 'setItem' | 'removeItem'
> & Partial<Pick<Storage, 'key' | 'length'>>;

export interface InactiveProfileRecoveryHint {
  readonly profileId: string;
  readonly observedAt: number;
}

interface StoredInactiveProfileRecoveryHintV1 {
  readonly version: typeof VERSION;
  readonly profile_id: string;
  readonly has_recoveries: boolean;
  readonly observed_at: number;
}

interface StoredInactiveProfileRecoveryReviewV1 {
  readonly version: typeof VERSION;
  readonly target_profile_id: string;
  readonly started_at: number;
}

export type InactiveProfileRecoveryExcursionPhase =
  | 'switching'
  | 'recovering'
  | 'return_ready';

interface StoredInactiveProfileRecoveryExcursionV2 {
  readonly version: typeof REVIEW_EXCURSION_VERSION;
  readonly source_profile_id: string;
  readonly target_profile_id: string;
  readonly return_hash: string;
  readonly phase: InactiveProfileRecoveryExcursionPhase;
  readonly started_at: number;
}

interface StoredInactiveProfileRecoveryExcursionV3 {
  readonly version: typeof CONTEXT_AWARE_EXCURSION_VERSION;
  readonly source_profile_id: string;
  readonly target_profile_id: string;
  readonly return_hash: string;
  readonly return_context: RecoveryReturnContext;
  readonly phase: InactiveProfileRecoveryExcursionPhase;
  readonly started_at: number;
}

export type InactiveProfileRecoveryReviewState =
  | {
      readonly targetProfileId: string;
      readonly startedAt: number;
    }
  | {
      readonly targetProfileId: string;
      readonly startedAt: number;
      readonly sourceProfileId: string;
      readonly returnHash: string;
      readonly phase: InactiveProfileRecoveryExcursionPhase;
      /** Absent only for a compatible v2 excursion armed before context
       * reconciliation shipped. */
      readonly returnContext?: RecoveryReturnContext;
    };

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

const validTime = (value: unknown): value is number =>
  typeof value === 'number'
  && Number.isSafeInteger(value)
  && value >= 0;

const validExcursionPhase = (
  value: unknown,
): value is InactiveProfileRecoveryExcursionPhase =>
  value === 'switching'
  || value === 'recovering'
  || value === 'return_ready';

const validSafeReturnHash = (value: unknown): value is string => {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_SAFE_RETURN_HASH_LENGTH
  ) return false;
  try {
    return safeServerSwitchLandingHash(value) === value;
  } catch {
    return false;
  }
};

const validMaxAge = (value: number | undefined, fallback: number): number =>
  value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : fallback;

const currentTime = (now: (() => number) | undefined): number => {
  const value = (now ?? Date.now)();
  return validTime(value) ? value : Date.now();
};

const hintStorageKey = (profileId: string): string =>
  `${INACTIVE_PROFILE_RECOVERY_HINT_KEY_PREFIX}${encodeURIComponent(profileId)}`;

const hintObservationStorageKey = (
  profileId: string,
  observedAt: number,
  hasRecoveries: boolean,
): string =>
  `${hintStorageKey(profileId)}:${observedAt}:${hasRecoveries ? '1' : '0'}`;

const parseJson = (raw: string | null): unknown => {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
};

const parseStoredHint = (
  raw: string | null,
  expectedProfileId: string,
  readAt: number,
  maxAgeMs: number,
): StoredInactiveProfileRecoveryHintV1 | null => {
  const value = parseJson(raw);
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      'version',
      'profile_id',
      'has_recoveries',
      'observed_at',
    ])
    || value.version !== VERSION
    || !validProfileId(value.profile_id)
    || value.profile_id !== expectedProfileId
    || typeof value.has_recoveries !== 'boolean'
    || !validTime(value.observed_at)
    || value.observed_at > readAt + CLOCK_SKEW_MS
    || Math.max(0, readAt - value.observed_at) > maxAgeMs
  ) return null;
  return value as unknown as StoredInactiveProfileRecoveryHintV1;
};

const parseStoredReview = (
  raw: string | null,
): StoredInactiveProfileRecoveryReviewV1
  | StoredInactiveProfileRecoveryExcursionV2
  | StoredInactiveProfileRecoveryExcursionV3
  | null => {
  const value = parseJson(raw);
  if (!isRecord(value)) return null;
  if (
    hasExactKeys(value, [
      'version',
      'target_profile_id',
      'started_at',
    ])
    && value.version === VERSION
    && validProfileId(value.target_profile_id)
    && validTime(value.started_at)
  ) return value as unknown as StoredInactiveProfileRecoveryReviewV1;
  if (
    hasExactKeys(value, [
      'version',
      'source_profile_id',
      'target_profile_id',
      'return_hash',
      'phase',
      'started_at',
    ])
    && value.version === REVIEW_EXCURSION_VERSION
    && validProfileId(value.source_profile_id)
    && validProfileId(value.target_profile_id)
    && value.source_profile_id !== value.target_profile_id
    && validSafeReturnHash(value.return_hash)
    && validExcursionPhase(value.phase)
    && validTime(value.started_at)
  ) return value as unknown as StoredInactiveProfileRecoveryExcursionV2;
  if (
    hasExactKeys(value, [
      'version',
      'source_profile_id',
      'target_profile_id',
      'return_hash',
      'return_context',
      'phase',
      'started_at',
    ])
    && value.version === CONTEXT_AWARE_EXCURSION_VERSION
    && validProfileId(value.source_profile_id)
    && validProfileId(value.target_profile_id)
    && value.source_profile_id !== value.target_profile_id
    && validSafeReturnHash(value.return_hash)
    && isRecoveryReturnContext(value.return_context)
    && validExcursionPhase(value.phase)
    && validTime(value.started_at)
  ) return value as unknown as StoredInactiveProfileRecoveryExcursionV3;
  return null;
};

const resolveLocalStorage = (
  document: Document | undefined,
  storage: InactiveProfileRecoveryStorage | null | undefined,
): InactiveProfileRecoveryStorage | null => {
  if (storage !== undefined) return storage;
  try {
    return document?.defaultView?.localStorage
      ?? (globalThis as { localStorage?: Storage }).localStorage
      ?? null;
  } catch {
    return null;
  }
};

const resolveSessionStorage = (
  document: Document | undefined,
  storage: InactiveProfileRecoveryStorage | null | undefined,
): InactiveProfileRecoveryStorage | null => {
  if (storage !== undefined) return storage;
  try {
    return document?.defaultView?.sessionStorage
      ?? (globalThis as { sessionStorage?: Storage }).sessionStorage
      ?? null;
  } catch {
    return null;
  }
};

export interface InactiveProfileRecoveryDiscovery {
  /** Read last-observed positive hints only for the caller's current roster. */
  read(profileIds: readonly string[]): ReadonlyArray<InactiveProfileRecoveryHint>;
  /** Record one valid authoritative snapshot. Older in-flight reads cannot
   * overwrite a newer observation; an all-clear wins an exact-time tie. */
  record(input: {
    profileId: string;
    hasRecoveries: boolean;
    observedAt: number;
  }): boolean;
  /** Tombstone a stale positive observation without allowing an older read to
   * resurrect its reminder. */
  retire(profileId: string, observedAt?: number): boolean;
  /** Remove every durable observation for a profile that is no longer in the
   * local roster. Roster binding prevents any late in-flight write from being
   * rendered, and a later storage/focus reconciliation can purge it again. */
  purge(profileId: string): boolean;
  /** Same-tab writes emit directly; sibling writes arrive through the storage
   * event. Focus/visibility also emit so missed browser events are harmless. */
  subscribe(listener: () => void): () => void;
  close(): void;
}

export interface BrowserInactiveProfileRecoveryDiscoveryOptions {
  readonly document?: Document;
  /** Defaults to origin localStorage. null disables durable discovery. */
  readonly storage?: InactiveProfileRecoveryStorage | null;
  readonly now?: () => number;
  readonly maxAgeMs?: number;
}

export const createBrowserInactiveProfileRecoveryDiscovery = (
  options: BrowserInactiveProfileRecoveryDiscoveryOptions = {},
): InactiveProfileRecoveryDiscovery => {
  const doc = options.document
    ?? (globalThis as { document?: Document }).document;
  const view = doc?.defaultView;
  const storage = resolveLocalStorage(doc, options.storage);
  const maxAgeMs = validMaxAge(
    options.maxAgeMs,
    DEFAULT_HINT_MAX_AGE_MS,
  );
  const listeners = new Set<() => void>();
  const purgedProfileIds = new Set<string>();
  let closed = false;

  const emit = (): void => {
    if (closed) return;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // One stale shell cannot block sibling discovery or durable writes.
      }
    }
  };

  const removeKey = (key: string): void => {
    try {
      storage?.removeItem(key);
    } catch {
      // Invalid/stale state stays ignored when storage cleanup is denied.
    }
  };

  const supportsKeyEnumeration = (): boolean => {
    if (storage === null || typeof storage.key !== 'function') return false;
    try {
      const length = storage.length;
      if (
        typeof length !== 'number'
        || !Number.isSafeInteger(length)
        || length < 0
      ) return false;
      // Probe the same method the journal scan needs. A partial test/storage
      // shim should use the safe legacy key instead of accepting journal
      // writes it can never enumerate again.
      storage.key(0);
      return true;
    } catch {
      return false;
    }
  };
  const keyEnumerationAvailable = supportsKeyEnumeration();

  const keysForProfile = (profileId: string): readonly string[] => {
    const baseKey = hintStorageKey(profileId);
    if (!keyEnumerationAvailable || storage === null) return [baseKey];
    const keys: string[] = [];
    try {
      const length = storage.length ?? 0;
      for (let index = 0; index < length; index += 1) {
        const key = storage.key?.(index) ?? null;
        if (key === baseKey || key?.startsWith(`${baseKey}:`) === true) {
          keys.push(key);
        }
      }
    } catch {
      // If enumeration becomes unavailable, the legacy single-key record is
      // still safe to parse. Discovery degrades rather than trusting a partial
      // journal scan.
      return [baseKey];
    }
    return [...new Set(keys)];
  };

  const readLatest = (
    profileId: string,
    readAt: number,
    prune: boolean,
  ): StoredInactiveProfileRecoveryHintV1 | null => {
    const baseKey = hintStorageKey(profileId);
    const valid: Array<{
      key: string;
      value: StoredInactiveProfileRecoveryHintV1;
    }> = [];
    for (const key of keysForProfile(profileId)) {
      let raw: string | null;
      try {
        raw = storage?.getItem(key) ?? null;
      } catch {
        continue;
      }
      if (raw === null) continue;
      const parsed = parseStoredHint(raw, profileId, readAt, maxAgeMs);
      const expectedJournalKey = parsed === null
        ? null
        : hintObservationStorageKey(
            profileId,
            parsed.observed_at,
            parsed.has_recoveries,
          );
      if (
        parsed === null
        || (key !== baseKey && key !== expectedJournalKey)
      ) {
        removeKey(key);
        continue;
      }
      valid.push({ key, value: parsed });
    }
    valid.sort((a, b) =>
      b.value.observed_at - a.value.observed_at
      // An all-clear wins an exact request-time tie.
      || Number(a.value.has_recoveries) - Number(b.value.has_recoveries)
      || a.key.localeCompare(b.key));
    const winner = valid[0] ?? null;
    if (prune && winner !== null) {
      for (const candidate of valid.slice(1)) removeKey(candidate.key);
    }
    return winner?.value ?? null;
  };

  const sweepStoredHints = (): void => {
    if (!keyEnumerationAvailable || storage === null) return;
    const readAt = currentTime(options.now);
    const keys: string[] = [];
    try {
      const length = storage.length ?? 0;
      for (let index = 0; index < length; index += 1) {
        const key = storage.key?.(index) ?? null;
        if (key?.startsWith(INACTIVE_PROFILE_RECOVERY_HINT_KEY_PREFIX)) {
          keys.push(key);
        }
      }
    } catch {
      return;
    }
    for (const key of [...new Set(keys)]) {
      let raw: string | null;
      try {
        raw = storage.getItem(key);
      } catch {
        continue;
      }
      const candidate = parseJson(raw);
      const profileId = isRecord(candidate) && validProfileId(candidate.profile_id)
        ? candidate.profile_id
        : null;
      const parsed = profileId === null
        ? null
        : parseStoredHint(raw, profileId, readAt, maxAgeMs);
      const baseKey = profileId === null ? null : hintStorageKey(profileId);
      const expectedJournalKey = parsed === null || profileId === null
        ? null
        : hintObservationStorageKey(
            profileId,
            parsed.observed_at,
            parsed.has_recoveries,
          );
      if (
        parsed === null
        || (key !== baseKey && key !== expectedJournalKey)
      ) removeKey(key);
    }
    // Focus/visibility are the fallback when a browser drops or coalesces a
    // sibling storage event. Re-apply every roster-forget fence after the
    // general expiry sweep so a valid-but-orphaned late response is removed.
    for (const profileId of purgedProfileIds) {
      for (const key of keysForProfile(profileId)) removeKey(key);
    }
  };

  sweepStoredHints();

  const read = (
    profileIds: readonly string[],
  ): ReadonlyArray<InactiveProfileRecoveryHint> => {
    if (closed || storage === null) return [];
    const readAt = currentTime(options.now);
    const unique = [...new Set(profileIds.filter(validProfileId))]
      .filter((profileId) => !purgedProfileIds.has(profileId));
    const hints: InactiveProfileRecoveryHint[] = [];
    for (const profileId of unique) {
      const parsed = readLatest(profileId, readAt, true);
      if (parsed === null) continue;
      if (parsed.has_recoveries) {
        hints.push({
          profileId,
          observedAt: parsed.observed_at,
        });
      }
    }
    return hints.sort((a, b) =>
      b.observedAt - a.observedAt || a.profileId.localeCompare(b.profileId));
  };

  const record: InactiveProfileRecoveryDiscovery['record'] = (input) => {
    if (
      closed
      || storage === null
      || !validProfileId(input.profileId)
      || purgedProfileIds.has(input.profileId)
      || !validTime(input.observedAt)
    ) return false;
    const readAt = currentTime(options.now);
    if (input.observedAt > readAt + CLOCK_SKEW_MS) return false;
    const existing = readLatest(input.profileId, readAt, true);
    if (
      existing !== null
      && (
        existing.observed_at > input.observedAt
        || (
          existing.observed_at === input.observedAt
          && (
            existing.has_recoveries === input.hasRecoveries
            || existing.has_recoveries === false
          )
        )
      )
    ) return false;
    const next: StoredInactiveProfileRecoveryHintV1 = {
      version: VERSION,
      profile_id: input.profileId,
      has_recoveries: input.hasRecoveries,
      observed_at: input.observedAt,
    };
    const key = keyEnumerationAvailable
      ? hintObservationStorageKey(
          input.profileId,
          input.observedAt,
          input.hasRecoveries,
        )
      : hintStorageKey(input.profileId);
    try {
      storage.setItem(key, JSON.stringify(next));
    } catch {
      return false;
    }
    // A key-per-observation journal closes the localStorage read/write race:
    // two tabs cannot overwrite one another before their timestamps are
    // compared. Prune after the write so even a late older writer observes and
    // removes itself, leaving the journal bounded to the winning snapshot.
    const winner = readLatest(input.profileId, readAt, true);
    if (
      winner === null
      || winner.observed_at !== input.observedAt
      || winner.has_recoveries !== input.hasRecoveries
    ) return false;
    emit();
    return true;
  };

  const purge = (profileId: string): boolean => {
    if (closed || storage === null || !validProfileId(profileId)) {
      return false;
    }
    purgedProfileIds.add(profileId);
    let succeeded = true;
    for (const key of keysForProfile(profileId)) {
      try {
        storage.removeItem(key);
      } catch {
        succeeded = false;
      }
    }
    if (succeeded) emit();
    return succeeded;
  };

  const onStorage = (event: StorageEvent): void => {
    const eventKey = event.key;
    if (eventKey === null) {
      emit();
      return;
    }
    if (
      eventKey.startsWith(INACTIVE_PROFILE_RECOVERY_HINT_KEY_PREFIX)
    ) {
      const purgedProfileId = [...purgedProfileIds].find((profileId) => {
        const baseKey = hintStorageKey(profileId);
        return eventKey === baseKey || eventKey.startsWith(`${baseKey}:`);
      });
      if (purgedProfileId !== undefined) {
        // A sibling may finish an older request after this profile left the
        // roster. Re-apply the local forget boundary instead of allowing that
        // late response to recreate an orphaned reminder.
        void purge(purgedProfileId);
        return;
      }
      emit();
    }
  };
  const onFocus = (): void => {
    sweepStoredHints();
    emit();
  };
  const onVisibilityChange = (): void => {
    if (doc?.visibilityState === 'visible') {
      sweepStoredHints();
      emit();
    }
  };
  view?.addEventListener?.('storage', onStorage);
  view?.addEventListener?.('focus', onFocus);
  doc?.addEventListener?.('visibilitychange', onVisibilityChange);

  return {
    read,
    record,
    retire: (profileId, observedAt) => record({
      profileId,
      hasRecoveries: false,
      observedAt: observedAt ?? currentTime(options.now),
    }),
    purge,
    subscribe(listener) {
      if (closed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      if (closed) return;
      closed = true;
      listeners.clear();
      view?.removeEventListener?.('storage', onStorage);
      view?.removeEventListener?.('focus', onFocus);
      doc?.removeEventListener?.('visibilitychange', onVisibilityChange);
    },
  };
};

export interface InactiveProfileRecoveryReviewContinuity {
  /** Legacy review-only marker retained for safe migration and older callers. */
  arm(targetProfileId: string): boolean;
  /** Arm a privacy-safe recovery excursion before opening the switch review. */
  armExcursion(input: {
    readonly sourceProfileId: string;
    readonly targetProfileId: string;
    /** Must already be canonical output from safeServerSwitchLandingHash. */
    readonly returnHash: string;
    /** Omit only for compatible callers that predate context reconciliation. */
    readonly returnContext?: RecoveryReturnContext;
  }): boolean;
  /** Peek without consuming. A failed target boot must be able to retry. */
  readForProfile(
    targetProfileId: string,
  ): InactiveProfileRecoveryReviewState | null;
  /** Advance an exact-target excursion from a fresh authoritative list. A
   * legacy review is retired after that first valid list. */
  recordSnapshot(
    targetProfileId: string,
    hasRecoveries: boolean,
  ): InactiveProfileRecoveryReviewState | null;
  /** Retire only the expected target after an explicit abandon/completion. */
  retire(targetProfileId: string): void;
}

export interface InactiveProfileRecoveryReviewContinuityOptions {
  readonly document?: Document;
  /** Defaults to same-tab sessionStorage. null disables reload continuity. */
  readonly storage?: InactiveProfileRecoveryStorage | null;
  readonly now?: () => number;
  readonly maxAgeMs?: number;
}

export const createInactiveProfileRecoveryReviewContinuity = (
  options: InactiveProfileRecoveryReviewContinuityOptions = {},
): InactiveProfileRecoveryReviewContinuity => {
  const doc = options.document
    ?? (globalThis as { document?: Document }).document;
  const storage = resolveSessionStorage(doc, options.storage);
  const maxAgeMs = validMaxAge(
    options.maxAgeMs,
    DEFAULT_REVIEW_MAX_AGE_MS,
  );
  const excursionMaxAgeMs = validMaxAge(
    options.maxAgeMs,
    DEFAULT_EXCURSION_MAX_AGE_MS,
  );

  const retireRaw = (): void => {
    if (storage === null) return;
    try {
      storage.setItem(
        INACTIVE_PROFILE_RECOVERY_REVIEW_SESSION_KEY,
        RETIRED_MARKER,
      );
      try {
        storage.removeItem(INACTIVE_PROFILE_RECOVERY_REVIEW_SESSION_KEY);
      } catch {
        // The marker is already inert if deletion is blocked.
      }
    } catch {
      try {
        storage.removeItem(INACTIVE_PROFILE_RECOVERY_REVIEW_SESSION_KEY);
      } catch {
        // Best-effort retirement in a fully locked storage context.
      }
    }
  };

  const readMarker = (
    targetProfileId: string,
  ): StoredInactiveProfileRecoveryReviewV1
    | StoredInactiveProfileRecoveryExcursionV2
    | StoredInactiveProfileRecoveryExcursionV3
    | null => {
    if (storage === null || !validProfileId(targetProfileId)) return null;
    let raw: string | null;
    try {
      raw = storage.getItem(INACTIVE_PROFILE_RECOVERY_REVIEW_SESSION_KEY);
    } catch {
      return null;
    }
    if (raw === null || raw === RETIRED_MARKER) return null;
    const marker = parseStoredReview(raw);
    const readAt = currentTime(options.now);
    const markerMaxAge = marker?.version === REVIEW_EXCURSION_VERSION
      || marker?.version === CONTEXT_AWARE_EXCURSION_VERSION
      ? excursionMaxAgeMs
      : maxAgeMs;
    if (
      marker === null
      || marker.started_at > readAt + CLOCK_SKEW_MS
      || Math.max(0, readAt - marker.started_at) > markerMaxAge
    ) {
      retireRaw();
      return null;
    }
    return marker.target_profile_id === targetProfileId ? marker : null;
  };

  const projectMarker = (
    marker: StoredInactiveProfileRecoveryReviewV1
      | StoredInactiveProfileRecoveryExcursionV2
      | StoredInactiveProfileRecoveryExcursionV3,
  ): InactiveProfileRecoveryReviewState => marker.version === VERSION
    ? {
        targetProfileId: marker.target_profile_id,
        startedAt: marker.started_at,
      }
    : {
        targetProfileId: marker.target_profile_id,
        startedAt: marker.started_at,
        sourceProfileId: marker.source_profile_id,
        returnHash: marker.return_hash,
        phase: marker.phase,
        ...(marker.version === CONTEXT_AWARE_EXCURSION_VERSION
          ? { returnContext: marker.return_context }
          : {}),
      };

  return {
    arm(targetProfileId) {
      if (storage === null || !validProfileId(targetProfileId)) return false;
      const startedAt = currentTime(options.now);
      const marker: StoredInactiveProfileRecoveryReviewV1 = {
        version: VERSION,
        target_profile_id: targetProfileId,
        started_at: startedAt,
      };
      try {
        storage.setItem(
          INACTIVE_PROFILE_RECOVERY_REVIEW_SESSION_KEY,
          JSON.stringify(marker),
        );
        return true;
      } catch {
        return false;
      }
    },
    armExcursion(input) {
      if (
        storage === null
        || !validProfileId(input.sourceProfileId)
        || !validProfileId(input.targetProfileId)
        || input.sourceProfileId === input.targetProfileId
        || !validSafeReturnHash(input.returnHash)
        || (
          input.returnContext !== undefined
          && !isRecoveryReturnContext(input.returnContext)
        )
      ) return false;
      const marker: StoredInactiveProfileRecoveryExcursionV2
        | StoredInactiveProfileRecoveryExcursionV3 =
        input.returnContext === undefined
          ? {
              version: REVIEW_EXCURSION_VERSION,
              source_profile_id: input.sourceProfileId,
              target_profile_id: input.targetProfileId,
              return_hash: input.returnHash,
              phase: 'switching',
              started_at: currentTime(options.now),
            }
          : {
              version: CONTEXT_AWARE_EXCURSION_VERSION,
              source_profile_id: input.sourceProfileId,
              target_profile_id: input.targetProfileId,
              return_hash: input.returnHash,
              return_context: input.returnContext,
              phase: 'switching',
              started_at: currentTime(options.now),
            };
      try {
        storage.setItem(
          INACTIVE_PROFILE_RECOVERY_REVIEW_SESSION_KEY,
          JSON.stringify(marker),
        );
        return true;
      } catch {
        return false;
      }
    },
    readForProfile(targetProfileId) {
      const marker = readMarker(targetProfileId);
      return marker === null ? null : projectMarker(marker);
    },
    recordSnapshot(targetProfileId, hasRecoveries) {
      const marker = readMarker(targetProfileId);
      if (marker === null) return null;
      if (marker.version === VERSION) {
        retireRaw();
        return null;
      }
      const updated: StoredInactiveProfileRecoveryExcursionV2
        | StoredInactiveProfileRecoveryExcursionV3 = {
        ...marker,
        phase: hasRecoveries ? 'recovering' : 'return_ready',
      };
      try {
        storage?.setItem(
          INACTIVE_PROFILE_RECOVERY_REVIEW_SESSION_KEY,
          JSON.stringify(updated),
        );
      } catch {
        // The live authoritative result can still drive this mount. A future
        // reload safely falls back to rechecking the last durable phase.
      }
      return projectMarker(updated);
    },
    retire(targetProfileId) {
      if (storage === null || !validProfileId(targetProfileId)) return;
      let raw: string | null;
      try {
        raw = storage.getItem(INACTIVE_PROFILE_RECOVERY_REVIEW_SESSION_KEY);
      } catch {
        return;
      }
      if (raw === null || raw === RETIRED_MARKER) return;
      const marker = parseStoredReview(raw);
      if (marker !== null && marker.target_profile_id !== targetProfileId) {
        return;
      }
      retireRaw();
    },
  };
};
