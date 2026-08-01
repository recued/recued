/** Secret-free same-tab continuity for an interrupted credential replacement.
 *
 * The candidate credential stays memory-only in the form. This envelope keeps
 * only the opaque server attempt id and connection identity needed to ask the
 * paired server for its durable outcome after a reload or reconnect. One
 * unresolved attempt occupies the tab so a newer rotation cannot silently
 * overwrite the only recovery pointer.
 */

import {
  CONNECTION_CREDENTIAL_ROTATION_ATTEMPT_ID_REGEX,
  type ConnectionKind,
} from '@recued/contracts';
import { CONNECTION_NAME_REGEX } from '@recued/ui-shared';

export type CredentialRotationContinuityStorage = Pick<
  Storage,
  'getItem' | 'setItem' | 'removeItem'
>;

export interface CredentialRotationContinuityMarker {
  readonly attemptId: string;
  readonly kind: ConnectionKind;
  readonly name: string;
  readonly startedAt: number;
  /** Non-secret row revision the editor was based on. A returned former owner
   * can compare this with a causally-later list response and distinguish its
   * own failed attempt from a successor's newer committed connection. */
  readonly baselineUpdatedAt?: number;
  /** Secret-free proof that this tab already showed a successor handoff. It
   * lets a reload distinguish a cleared handoff from an ordinary failed
   * attempt without ever retaining the replacement draft. */
  readonly successorObservedAt?: number;
}

export type CredentialRotationContinuityWriteResult =
  | 'stored'
  | 'occupied'
  | 'unavailable';

export type CredentialRotationContinuityMarkResult =
  | 'stored'
  | 'missing'
  | 'unavailable';

export interface CredentialRotationContinuityStore {
  /** Persist a marker before any credential-bearing RPC is sent. */
  write(input: {
    attemptId: string;
    kind: ConnectionKind;
    name: string;
    baselineUpdatedAt?: number;
  }): CredentialRotationContinuityWriteResult;
  /** Remember only that this tab observed a successor for the matching
   * attempt. Credential material remains memory-only. */
  markSuccessorObserved(
    attemptId: string,
  ): CredentialRotationContinuityMarkResult;
  /** Peek without consuming; terminal reconciliation retires explicitly. */
  read(): CredentialRotationContinuityMarker | null;
  /** Retire only the matching attempt so a stale completion cannot erase a
   * newer marker. */
  retire(attemptId: string): void;
}

interface StoredCredentialRotationV1 {
  readonly version: 1;
  readonly scope_id: string;
  readonly attempt_id: string;
  readonly kind: ConnectionKind;
  readonly name: string;
  readonly started_at: number;
}

interface StoredCredentialRotationV2 {
  readonly version: 2;
  readonly scope_id: string;
  readonly attempt_id: string;
  readonly kind: ConnectionKind;
  readonly name: string;
  readonly started_at: number;
  readonly baseline_updated_at: number | null;
}

interface StoredCredentialRotationV3 {
  readonly version: 3;
  readonly scope_id: string;
  readonly attempt_id: string;
  readonly kind: ConnectionKind;
  readonly name: string;
  readonly started_at: number;
  readonly baseline_updated_at: number | null;
  readonly successor_observed_at: number | null;
}

type StoredCredentialRotation =
  | StoredCredentialRotationV1
  | StoredCredentialRotationV2
  | StoredCredentialRotationV3;

export const CREDENTIAL_ROTATION_CONTINUITY_SESSION_KEY =
  'recued.connections.credential-rotation.v1';

// sessionStorage already scopes this pointer to the tab lifecycle. Do not age
// out an unresolved server claim: an arbitrary client deadline could permit a
// second rotation while the first is still pending. Callers may inject a
// finite bound for constrained hosts/tests; production reconciles until the
// server returns a terminal receipt (including not_found after a reset).
const DEFAULT_MAX_AGE_MS = Number.POSITIVE_INFINITY;
const MAX_SCOPE_ID = 256;
const VALID_KINDS: ReadonlySet<string> = new Set([
  'api',
  'mcp',
  'notification',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasValidStoredIdentity = (value: Record<string, unknown>): boolean =>
  typeof value.scope_id === 'string'
    && value.scope_id.length > 0
    && value.scope_id.length <= MAX_SCOPE_ID
    && typeof value.attempt_id === 'string'
    && CONNECTION_CREDENTIAL_ROTATION_ATTEMPT_ID_REGEX.test(value.attempt_id)
    && typeof value.kind === 'string'
    && VALID_KINDS.has(value.kind)
    && typeof value.name === 'string'
    && CONNECTION_NAME_REGEX.test(value.name)
    && typeof value.started_at === 'number'
    && Number.isFinite(value.started_at);

const isStored = (value: unknown): value is StoredCredentialRotation => {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  const common = [
    'version',
    'scope_id',
    'attempt_id',
    'kind',
    'name',
    'started_at',
  ];
  if (!common.every((key) => Object.hasOwn(value, key))) return false;
  if (value.version === 1) {
    return keys.length === common.length && hasValidStoredIdentity(value);
  }
  if (value.version === 2) {
    return keys.length === common.length + 1
      && Object.hasOwn(value, 'baseline_updated_at')
      && (
        value.baseline_updated_at === null
        || (
          typeof value.baseline_updated_at === 'number'
          && Number.isFinite(value.baseline_updated_at)
        )
      )
      && hasValidStoredIdentity(value);
  }
  return value.version === 3
    && keys.length === common.length + 2
    && Object.hasOwn(value, 'baseline_updated_at')
    && Object.hasOwn(value, 'successor_observed_at')
    && typeof value.started_at === 'number'
    && (
      value.baseline_updated_at === null
      || (
        typeof value.baseline_updated_at === 'number'
        && Number.isFinite(value.baseline_updated_at)
      )
    )
    && (
      value.successor_observed_at === null
      || (
        typeof value.successor_observed_at === 'number'
        && Number.isFinite(value.successor_observed_at)
        && value.successor_observed_at >= value.started_at
      )
    )
    && hasValidStoredIdentity(value);
};

const parseStored = (raw: string): StoredCredentialRotation | null => {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isStored(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const isCurrent = (
  stored: StoredCredentialRotation,
  readAt: number,
  maxAgeMs: number,
): boolean => Number.isFinite(readAt)
  && stored.started_at <= readAt
  && readAt - stored.started_at <= maxAgeMs;

const inertThenRemove = (
  storage: CredentialRotationContinuityStorage,
): void => {
  try {
    storage.setItem(
      CREDENTIAL_ROTATION_CONTINUITY_SESSION_KEY,
      '{"version":1,"retired":true}',
    );
  } catch {
    // Removal may still be allowed when a policy/quota blocks writes.
  }
  try {
    storage.removeItem(CREDENTIAL_ROTATION_CONTINUITY_SESSION_KEY);
  } catch {
    // The inert replacement, when written, is already non-replayable.
  }
};

export const createCredentialRotationContinuityStore = (options: {
  storage?: CredentialRotationContinuityStorage | null;
  scopeId?: string | null;
  now?: () => number;
  maxAgeMs?: number;
}): CredentialRotationContinuityStore => {
  const storage = options.storage === undefined
    ? (() => {
        try {
          return globalThis.sessionStorage;
        } catch {
          return null;
        }
      })()
    : options.storage;
  const scopeId = options.scopeId?.trim() ?? '';
  const enabled = storage !== null
    && storage !== undefined
    && scopeId.length > 0
    && scopeId.length <= MAX_SCOPE_ID;
  const now = options.now ?? Date.now;
  const maxAgeMs = options.maxAgeMs !== undefined
    && Number.isFinite(options.maxAgeMs)
    && options.maxAgeMs > 0
    ? options.maxAgeMs
    : DEFAULT_MAX_AGE_MS;
  const locallyRetired = new Set<string>();
  let lastReadUnavailable = false;

  const readStored = (): StoredCredentialRotation | null => {
    lastReadUnavailable = false;
    if (!enabled) return null;
    let raw: string | null;
    try {
      raw = storage!.getItem(CREDENTIAL_ROTATION_CONTINUITY_SESSION_KEY);
    } catch {
      lastReadUnavailable = true;
      return null;
    }
    if (raw === null) return null;
    const stored = parseStored(raw);
    if (stored === null || !isCurrent(stored, now(), maxAgeMs)) {
      inertThenRemove(storage!);
      return null;
    }
    return stored;
  };

  return {
    write(input) {
      if (
        !enabled
        || !CONNECTION_CREDENTIAL_ROTATION_ATTEMPT_ID_REGEX.test(input.attemptId)
        || !VALID_KINDS.has(input.kind)
        || !CONNECTION_NAME_REGEX.test(input.name)
        || (
          input.baselineUpdatedAt !== undefined
          && !Number.isFinite(input.baselineUpdatedAt)
        )
      ) return 'unavailable';

      const startedAt = now();
      if (!Number.isFinite(startedAt)) return 'unavailable';
      const occupied = readStored();
      if (lastReadUnavailable) return 'unavailable';
      if (occupied !== null) {
        if (
          occupied.scope_id === scopeId
          && occupied.attempt_id === input.attemptId
          && occupied.kind === input.kind
          && occupied.name === input.name
        ) return 'stored';
        return 'occupied';
      }

      const stored: StoredCredentialRotationV3 = {
        version: 3,
        scope_id: scopeId,
        attempt_id: input.attemptId,
        kind: input.kind,
        name: input.name,
        started_at: startedAt,
        baseline_updated_at: input.baselineUpdatedAt ?? null,
        successor_observed_at: null,
      };
      try {
        storage!.setItem(
          CREDENTIAL_ROTATION_CONTINUITY_SESSION_KEY,
          JSON.stringify(stored),
        );
        locallyRetired.delete(input.attemptId);
        return 'stored';
      } catch {
        return 'unavailable';
      }
    },

    markSuccessorObserved(attemptId) {
      if (
        !enabled
        || !CONNECTION_CREDENTIAL_ROTATION_ATTEMPT_ID_REGEX.test(attemptId)
      ) return 'unavailable';
      const stored = readStored();
      if (lastReadUnavailable) return 'unavailable';
      if (
        stored === null
        || stored.scope_id !== scopeId
        || stored.attempt_id !== attemptId
        || locallyRetired.has(attemptId)
      ) return 'missing';
      if (
        stored.version === 3
        && stored.successor_observed_at !== null
      ) return 'stored';
      const observedAt = now();
      if (!Number.isFinite(observedAt) || observedAt < stored.started_at) {
        return 'unavailable';
      }
      const next: StoredCredentialRotationV3 = {
        version: 3,
        scope_id: stored.scope_id,
        attempt_id: stored.attempt_id,
        kind: stored.kind,
        name: stored.name,
        started_at: stored.started_at,
        baseline_updated_at: stored.version === 1
          ? null
          : stored.baseline_updated_at,
        successor_observed_at: observedAt,
      };
      try {
        storage!.setItem(
          CREDENTIAL_ROTATION_CONTINUITY_SESSION_KEY,
          JSON.stringify(next),
        );
        return 'stored';
      } catch {
        return 'unavailable';
      }
    },

    read() {
      const stored = readStored();
      if (
        stored === null
        || stored.scope_id !== scopeId
        || locallyRetired.has(stored.attempt_id)
      ) return null;
      return {
        attemptId: stored.attempt_id,
        kind: stored.kind,
        name: stored.name,
        startedAt: stored.started_at,
        ...(stored.version !== 1 && stored.baseline_updated_at !== null
          ? { baselineUpdatedAt: stored.baseline_updated_at }
          : {}),
        ...(stored.version === 3 && stored.successor_observed_at !== null
          ? { successorObservedAt: stored.successor_observed_at }
          : {}),
      };
    },

    retire(attemptId) {
      locallyRetired.add(attemptId);
      const stored = readStored();
      if (
        stored === null
        || stored.scope_id !== scopeId
        || stored.attempt_id !== attemptId
      ) return;
      inertThenRemove(storage!);
    },
  };
};
