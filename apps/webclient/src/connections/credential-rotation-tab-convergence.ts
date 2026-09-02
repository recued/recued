/** Privacy-safe sibling-tab convergence for connection credential rotation and
 * server update/restart progress.
 *
 * BroadcastChannel carries the exact connection identity for low-latency
 * credential-rotation hints, while an origin-scoped Web Lock elects the one tab
 * allowed to send provider work. Rotation completion persists only an opaque
 * pulse. Server-update convergence separately persists the active profile
 * scope, operation, phase, start time, and (after acceptance) an opaque server
 * ledger receipt so a reload can verify the exact outcome. Neither record
 * contains a connection name, endpoint, credential, provider attempt id,
 * version, or raw error. Every hint is advisory; the paired server owns the
 * mutation and pending-attempt boundaries.
 */

import type { ConnectionKind } from '@recued/contracts';
import { CONNECTION_NAME_REGEX } from '@recued/ui-shared';

export const CREDENTIAL_ROTATION_TAB_CHANNEL_NAME =
  'recued.webclient.connection-credential-rotation.v1' as const;
export const CREDENTIAL_ROTATION_TAB_PULSE_KEY =
  'recued.connections.credential-rotation-changed.v1' as const;
const SERVER_UPDATE_PROGRESS_KEY_PREFIX =
  'recued.connections.server-update-progress.v1' as const;

const ROTATED_MESSAGE_TYPE =
  'recued.webclient.connection-credential-rotated' as const;
const STARTED_MESSAGE_TYPE =
  'recued.webclient.connection-credential-rotation-started' as const;
const RELEASED_MESSAGE_TYPE =
  'recued.webclient.connection-credential-rotation-released' as const;
const SAFE_STOPPED_MESSAGE_TYPE =
  'recued.webclient.connection-credential-rotation-safe-stopped' as const;
const SAFE_STOP_RESOLVED_MESSAGE_TYPE =
  'recued.webclient.connection-credential-safe-stop-resolved' as const;
const CAPABILITY_RESOLVED_MESSAGE_TYPE =
  'recued.webclient.connection-server-capability-resolved' as const;
const SERVER_UPDATE_PROGRESS_MESSAGE_TYPE =
  'recued.webclient.server-update-progress' as const;
const PULSE_TYPE = 'recued.webclient.connection-credential-rotation-pulse' as const;
const VERSION = 1 as const;
const MAX_SCOPE_ID = 256;
const MAX_EVENT_ID = 128;
const MAX_SERVER_UPDATE_OPERATION_ID = 128;
const DEFAULT_SERVER_UPDATE_PROGRESS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SERVER_UPDATE_APPLYING_MAX_AGE_MS = 15 * 60 * 1000;
const SERVER_UPDATE_PROGRESS_CLOCK_SKEW_MS = 1_000;
const VALID_KINDS: ReadonlySet<string> = new Set([
  'api',
  'mcp',
  'notification',
]);

export type CredentialRotationTabHint =
  | {
      readonly type: 'credential_rotation_started';
      readonly kind: ConnectionKind;
      readonly name: string;
    }
  | {
      readonly type: 'credential_rotation_released';
      readonly kind: ConnectionKind;
      readonly name: string;
    }
  | {
      readonly type: 'credential_rotated';
      readonly kind: ConnectionKind;
      readonly name: string;
    }
  | {
      readonly type: 'credential_rotation_safe_stopped';
      readonly kind: ConnectionKind;
      readonly name: string;
    }
  | {
      readonly type: 'credential_rotation_safe_stop_resolved';
      readonly kind: ConnectionKind;
      readonly name: string;
    }
  | {
      readonly type: 'server_capability_resolved';
      readonly kind: ConnectionKind;
      readonly name: string;
    }
  | {
      readonly type: 'server_update_progress';
      readonly progress: ServerUpdateTabProgress | null;
    }
  | { readonly type: 'reconcile' };

export type ServerUpdateOperation = 'update' | 'rollback';
export type ServerUpdateProgressPhase = 'applying' | 'awaiting_reconnect';

/** Privacy-safe, profile-scoped progress shared across same-origin tabs. */
export interface ServerUpdateTabProgress {
  readonly phase: ServerUpdateProgressPhase;
  readonly operation: ServerUpdateOperation;
  readonly startedAt: number;
  /** Opaque server-ledger receipt. Present only after the server accepted the
   * restart; contains no version, endpoint, credential, or raw error. */
  readonly operationId?: string;
}

export interface CredentialRotationOwnershipLease {
  /** Idempotently yield this tab's ownership. A closed browsing context also
   * releases the underlying Web Lock. */
  release(): void;
}

export interface CredentialRotationTabConvergence {
  /** True when an atomic, origin-scoped ownership lock is available. The
   * server's unique pending-attempt gate remains authoritative. */
  readonly supportsOwnershipLeases: boolean;
  /** Claim the exact connection without waiting. The live owner receives a
   * lease; siblings receive null and preserve their drafts without sending. */
  claimCredentialRotationOwnership(identity: {
    kind: ConnectionKind;
    name: string;
  }): Promise<CredentialRotationOwnershipLease | null>;
  /** Ephemeral exact hints. They never touch localStorage. */
  notifyCredentialRotationStarted(identity: {
    kind: ConnectionKind;
    name: string;
  }): void;
  notifyCredentialRotationReleased(identity: {
    kind: ConnectionKind;
    name: string;
  }): void;
  /** Advisory exact-identity hint sent after an authoritative rejection
   * reaches the bounded regeneration/admin safe stop. The receiving tab must
   * repeat the server activity read before presenting correction details. */
  notifyCredentialRotationSafeStopped(identity: {
    kind: ConnectionKind;
    name: string;
  }): void;
  /** Advisory exact-identity wake-up sent only after the paired server records
   * the safe-stop closure. Siblings re-read server authority before unlocking;
   * the persistent fallback remains an identity-free pulse. */
  notifyCredentialRotationSafeStopResolved(identity: {
    kind: ConnectionKind;
    name: string;
  }): void;
  /** Publish an identity-free live + durable pulse after the paired server
   * records a fresh post-ack check. Siblings re-list server authority; no
   * connection identity, result, endpoint, or credential leaves this tab. */
  notifyPostSafeStopVerificationChanged(): void;
  /** Best-effort hint sent only after the server confirms the mutation. */
  notifyCredentialRotated(identity: {
    kind: ConnectionKind;
    name: string;
  }): void;
  /** Best-effort hint sent only after this tab receives a successful response
   * from the server-authoritative credential-rotation activity read. Siblings
   * must repeat that read before retiring an unsupported-capability diagnosis. */
  notifyServerCapabilityResolved(identity: {
    kind: ConnectionKind;
    name: string;
  }): void;
  /** True when this browser can atomically elect one server-update owner. */
  readonly supportsServerUpdateOwnership: boolean;
  /** Claim the active profile's single update/rollback action without waiting. */
  claimServerUpdateOwnership(): Promise<CredentialRotationOwnershipLease | null>;
  /** Current non-secret cross-tab progress, restored across tab arrival/reload. */
  readServerUpdateProgress(): ServerUpdateTabProgress | null;
  /** Publish update/restart progress. No connection identity, version,
   * endpoint, credential, form value, or raw error crosses tabs; an accepted
   * APPLY or restart may add only its opaque server-ledger receipt — which is
   * what makes a latch answerable after the tab that started it has gone. */
  notifyServerUpdateProgress(progress: {
    phase: ServerUpdateProgressPhase;
    operation: ServerUpdateOperation;
    operationId?: string;
  }): void;
  /** Clear only the exact operation lineage this tab independently settled.
   * A newer action wins the shared Web Lock/storage recheck. */
  clearServerUpdateProgress(
    expected: ServerUpdateTabProgress,
  ): Promise<boolean>;
  /** Re-read durable progress and clear a stale applying owner when Web Locks
   * prove no tab still owns the action. */
  reconcileServerUpdateProgress(): Promise<ServerUpdateTabProgress | null>;
  subscribe(listener: (hint: CredentialRotationTabHint) => void): () => void;
  close(): void;
}

export type CredentialRotationTabStorage = Pick<
  Storage,
  'getItem' | 'setItem' | 'removeItem'
>;

interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  removeEventListener(
    type: 'message',
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  close(): void;
}

interface CredentialRotationTabWindowLike {
  readonly BroadcastChannel?: new (name: string) => BroadcastChannelLike;
  readonly localStorage?: CredentialRotationTabStorage;
  readonly navigator?: {
    readonly locks?: CredentialRotationOwnershipLockProvider;
  };
  addEventListener?(type: 'focus', listener: () => void): void;
  addEventListener?(
    type: 'storage',
    listener: (event: StorageEvent) => void,
  ): void;
  removeEventListener?(type: 'focus', listener: () => void): void;
  removeEventListener?(
    type: 'storage',
    listener: (event: StorageEvent) => void,
  ): void;
}

interface CredentialRotationTabDocumentLike {
  readonly defaultView: CredentialRotationTabWindowLike | null;
  readonly visibilityState?: DocumentVisibilityState;
  addEventListener?(type: 'visibilitychange', listener: () => void): void;
  removeEventListener?(type: 'visibilitychange', listener: () => void): void;
}

interface RotationMessageV1 {
  readonly type:
    | typeof ROTATED_MESSAGE_TYPE
    | typeof STARTED_MESSAGE_TYPE
    | typeof RELEASED_MESSAGE_TYPE
    | typeof SAFE_STOPPED_MESSAGE_TYPE
    | typeof SAFE_STOP_RESOLVED_MESSAGE_TYPE
    | typeof CAPABILITY_RESOLVED_MESSAGE_TYPE;
  readonly version: typeof VERSION;
  readonly scope_id: string;
  readonly event_id: string;
  readonly kind: ConnectionKind;
  readonly name: string;
}

interface ServerUpdateProgressMessageV1 {
  readonly type: typeof SERVER_UPDATE_PROGRESS_MESSAGE_TYPE;
  readonly version: typeof VERSION;
  readonly scope_id: string;
  readonly event_id: string;
  readonly phase: ServerUpdateProgressPhase | 'idle';
  readonly operation: ServerUpdateOperation;
  readonly started_at: number;
  readonly operation_id?: string;
}

export interface CredentialRotationOwnershipLockProvider {
  request(
    name: string,
    options: { mode: 'exclusive'; ifAvailable: true },
    callback: (lock: unknown | null) => Promise<void> | void,
  ): Promise<unknown>;
}

interface RotationPulseV1 {
  readonly type: typeof PULSE_TYPE;
  readonly version: typeof VERSION;
  readonly scope_id: string;
  readonly event_id: string;
}

export interface BrowserCredentialRotationTabConvergenceOptions {
  readonly document?: Document;
  readonly scopeId?: string | null;
  /** Test/locked-browser seam. undefined resolves window.localStorage; null
   * disables the persistent, identity-free pulse while BroadcastChannel and
   * focus reconciliation remain available. */
  readonly storage?: CredentialRotationTabStorage | null;
  /** Deterministic test seam. Production uses crypto.randomUUID when present. */
  readonly eventId?: () => string;
  /** Deterministic/locked-browser seam. undefined resolves navigator.locks;
   * null disables browser ownership while server authority still applies. */
  readonly ownershipLockProvider?: CredentialRotationOwnershipLockProvider | null;
  /** Clock/expiry seams for privacy-safe update progress restoration.
   * Accepted restarts use this age; an unsettled applying phase is capped at
   * 15 minutes so browsers without Web Locks do not strand controls all day. */
  readonly now?: () => number;
  readonly serverUpdateProgressMaxAgeMs?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const exactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean => {
  const keys = Object.keys(value);
  return keys.length === expected.length
    && expected.every((key) => Object.hasOwn(value, key));
};

const validScope = (value: unknown): value is string =>
  typeof value === 'string'
  && value.length > 0
  && value.length <= MAX_SCOPE_ID;

const validEventId = (value: unknown): value is string =>
  typeof value === 'string'
  && value.length > 0
  && value.length <= MAX_EVENT_ID;

const validServerUpdateOperationId = (value: unknown): value is string =>
  typeof value === 'string'
  && /^[A-Za-z0-9._:-]+$/.test(value)
  && value.length > 0
  && value.length <= MAX_SERVER_UPDATE_OPERATION_ID;

const isServerUpdateOperation = (
  value: unknown,
): value is ServerUpdateOperation => value === 'update' || value === 'rollback';

const isServerUpdateProgressPhase = (
  value: unknown,
): value is ServerUpdateProgressPhase => value === 'applying'
  || value === 'awaiting_reconnect';

const parseMessage = (value: unknown): RotationMessageV1 | null => {
  if (
    !isRecord(value)
    || !exactKeys(value, [
      'type',
      'version',
      'scope_id',
      'event_id',
      'kind',
      'name',
    ])
    || (
      value.type !== ROTATED_MESSAGE_TYPE
      && value.type !== STARTED_MESSAGE_TYPE
      && value.type !== RELEASED_MESSAGE_TYPE
      && value.type !== SAFE_STOPPED_MESSAGE_TYPE
      && value.type !== SAFE_STOP_RESOLVED_MESSAGE_TYPE
      && value.type !== CAPABILITY_RESOLVED_MESSAGE_TYPE
    )
    || value.version !== VERSION
    || !validScope(value.scope_id)
    || !validEventId(value.event_id)
    || typeof value.kind !== 'string'
    || !VALID_KINDS.has(value.kind)
    || typeof value.name !== 'string'
    || !CONNECTION_NAME_REGEX.test(value.name)
  ) return null;
  return value as unknown as RotationMessageV1;
};

const parseServerUpdateProgressMessage = (
  value: unknown,
): ServerUpdateProgressMessageV1 | null => {
  const baseKeys = [
    'type',
    'version',
    'scope_id',
    'event_id',
    'phase',
    'operation',
    'started_at',
  ] as const;
  if (
    !isRecord(value)
    || (
      !exactKeys(value, baseKeys)
      && !exactKeys(value, [...baseKeys, 'operation_id'])
    )
    || value.type !== SERVER_UPDATE_PROGRESS_MESSAGE_TYPE
    || value.version !== VERSION
    || !validScope(value.scope_id)
    || !validEventId(value.event_id)
  ) return null;
  const hasOperationId = Object.hasOwn(value, 'operation_id');
  if (
    hasOperationId
    && (
      // Both phases a run can carry a receipt in — see the note on
      // `notifyServerUpdateProgress`. The id's own shape is still validated.
      (value.phase !== 'awaiting_reconnect' && value.phase !== 'applying')
      || !validServerUpdateOperationId(value.operation_id)
    )
  ) return null;
  return (
    value.phase === 'idle'
      || isServerUpdateProgressPhase(value.phase)
  )
    && isServerUpdateOperation(value.operation)
    && Number.isSafeInteger(value.started_at)
    ? value as unknown as ServerUpdateProgressMessageV1
    : null;
};

const ownershipKey = (identity: {
  kind: ConnectionKind;
  name: string;
}): string => `${identity.kind}/${identity.name}`;

export const credentialRotationOwnershipLockName = (
  scopeId: string,
  identity: { kind: ConnectionKind; name: string },
): string => [
  'recued.webclient.connection-credential-rotation-owner.v1',
  encodeURIComponent(scopeId),
  encodeURIComponent(identity.kind),
  encodeURIComponent(identity.name),
].join(':');

export const serverUpdateOwnershipLockName = (scopeId: string): string => [
  'recued.webclient.server-update-owner.v1',
  encodeURIComponent(scopeId),
].join(':');

export const serverUpdateProgressStorageKey = (scopeId: string): string => [
  SERVER_UPDATE_PROGRESS_KEY_PREFIX,
  encodeURIComponent(scopeId),
].join(':');

const parsePulseValue = (value: unknown): RotationPulseV1 | null => {
  if (
    !isRecord(value)
    || !exactKeys(value, ['type', 'version', 'scope_id', 'event_id'])
    || value.type !== PULSE_TYPE
    || value.version !== VERSION
    || !validScope(value.scope_id)
    || !validEventId(value.event_id)
  ) return null;
  return value as unknown as RotationPulseV1;
};

const parsePulse = (raw: string | null): RotationPulseV1 | null => {
  if (raw === null) return null;
  try {
    return parsePulseValue(JSON.parse(raw));
  } catch {
    return null;
  }
};

const progressFromMessage = (
  message: ServerUpdateProgressMessageV1,
): ServerUpdateTabProgress | null => message.phase === 'idle'
  ? null
  : {
      phase: message.phase,
      operation: message.operation!,
      startedAt: message.started_at!,
      ...(message.operation_id !== undefined
        ? { operationId: message.operation_id }
        : {}),
    };

const sameProgress = (
  left: ServerUpdateTabProgress | null,
  right: ServerUpdateTabProgress | null,
): boolean => left === null
  ? right === null
  : right !== null
    && left.phase === right.phase
    && left.operation === right.operation
    && left.startedAt === right.startedAt
    && left.operationId === right.operationId;

const cloneProgress = (
  progress: ServerUpdateTabProgress | null,
): ServerUpdateTabProgress | null => progress === null ? null : { ...progress };

let fallbackEventSequence = 0;
const defaultEventId = (): string => {
  try {
    const id = (globalThis as { crypto?: { randomUUID?: () => string } })
      .crypto?.randomUUID?.();
    if (id !== undefined && validEventId(id)) return id;
  } catch {
    // A deterministic, non-secret pulse is sufficient for deduplication.
  }
  fallbackEventSequence += 1;
  // Non-security identifier: a per-context random component prevents two tabs
  // without Web Crypto from minting the same millisecond/sequence pair.
  const contextPart = Math.random().toString(36).slice(2, 12);
  return `rotation-${Date.now().toString(36)}-${contextPart}-${fallbackEventSequence.toString(36)}`;
};

/** Build one boot-scoped convergence channel. null means the browser/profile
 * boundary is unavailable; callers keep ordinary server refresh behavior. */
export const createBrowserCredentialRotationTabConvergence = (
  options: BrowserCredentialRotationTabConvergenceOptions = {},
): CredentialRotationTabConvergence | null => {
  const doc = (options.document
    ?? (globalThis as { document?: Document }).document) as
    | CredentialRotationTabDocumentLike
    | undefined;
  if (doc === undefined) return null;
  const view = doc?.defaultView;
  const scopeId = options.scopeId?.trim() ?? '';
  if (view === null || view === undefined || !validScope(scopeId)) return null;
  const now = options.now ?? Date.now;
  const progressMaxAgeMs = options.serverUpdateProgressMaxAgeMs !== undefined
    && Number.isFinite(options.serverUpdateProgressMaxAgeMs)
    && options.serverUpdateProgressMaxAgeMs > 0
    ? options.serverUpdateProgressMaxAgeMs
    : DEFAULT_SERVER_UPDATE_PROGRESS_MAX_AGE_MS;
  const progressStorageKey = serverUpdateProgressStorageKey(scopeId);
  const progressStartedAtIsFresh = (
    phase: ServerUpdateProgressMessageV1['phase'],
    startedAt: number,
    readAt: number,
  ): boolean => {
    if (
      !Number.isFinite(readAt)
      || startedAt > readAt + SERVER_UPDATE_PROGRESS_CLOCK_SKEW_MS
    ) return false;
    const maxAge = phase === 'applying'
      ? Math.min(
          progressMaxAgeMs,
          DEFAULT_SERVER_UPDATE_APPLYING_MAX_AGE_MS,
        )
      : progressMaxAgeMs;
    return Math.max(0, readAt - startedAt) <= maxAge;
  };
  const progressIsFresh = (
    message: ServerUpdateProgressMessageV1,
    readAt: number,
  ): boolean => progressStartedAtIsFresh(
    message.phase,
    message.started_at,
    readAt,
  );

  let channel: BroadcastChannelLike | null = null;
  if (typeof view.BroadcastChannel === 'function') {
    try {
      channel = new view.BroadcastChannel(CREDENTIAL_ROTATION_TAB_CHANNEL_NAME);
    } catch {
      // localStorage/focus reconciliation remains available.
    }
  }

  let storage: CredentialRotationTabStorage | null = null;
  if (options.storage !== undefined) {
    storage = options.storage;
  } else {
    try {
      storage = view.localStorage ?? null;
    } catch {
      storage = null;
    }
  }

  const lockCandidate = options.ownershipLockProvider !== undefined
    ? options.ownershipLockProvider
    : view.navigator?.locks ?? null;
  const ownershipLockProvider = lockCandidate !== null
    && typeof lockCandidate.request === 'function'
    ? lockCandidate
    : null;

  const listeners = new Set<(hint: CredentialRotationTabHint) => void>();
  const ownershipLeases = new Map<string, CredentialRotationOwnershipLease>();
  const ownershipClaims = new Map<
    string,
    Promise<CredentialRotationOwnershipLease | null>
  >();
  let closed = false;
  let lastSeenEventId: string | null = null;
  let lastSeenServerUpdateEventId: string | null = null;
  let lastServerUpdateStartedAt: number | null = null;
  let serverUpdateProgress: ServerUpdateTabProgress | null = null;
  try {
    const existing = parsePulse(
      storage?.getItem(CREDENTIAL_ROTATION_TAB_PULSE_KEY) ?? null,
    );
    if (existing?.scope_id === scopeId) lastSeenEventId = existing.event_id;
  } catch {
    // A locked storage read does not disable the ephemeral channel.
  }

  const readStoredServerUpdateProgress = (): ServerUpdateProgressMessageV1 | null => {
    let raw: string | null;
    try {
      raw = storage?.getItem(progressStorageKey) ?? null;
    } catch {
      return null;
    }
    if (raw === null) return null;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      value = null;
    }
    const message = parseServerUpdateProgressMessage(value);
    const readAt = now();
    if (
      message === null
      || message.scope_id !== scopeId
      || !progressIsFresh(message, readAt)
    ) {
      try {
        storage?.removeItem(progressStorageKey);
      } catch {
        // An invalid/stale envelope remains ignored even if removal is locked.
      }
      return null;
    }
    return message;
  };

  const restoredProgressMessage = readStoredServerUpdateProgress();
  if (restoredProgressMessage !== null) {
    serverUpdateProgress = progressFromMessage(restoredProgressMessage);
    lastSeenServerUpdateEventId = restoredProgressMessage.event_id;
    lastServerUpdateStartedAt = restoredProgressMessage.started_at;
  }

  const emit = (hint: CredentialRotationTabHint): void => {
    if (closed) return;
    for (const listener of [...listeners]) {
      try {
        listener(hint);
      } catch {
        // One stale route must not block persistence, sibling convergence, or
        // release of the profile-wide action lock.
      }
    }
  };

  const acceptServerUpdateProgressMessage = (
    message: ServerUpdateProgressMessageV1,
  ): boolean => {
    if (
      message.scope_id !== scopeId
      || message.event_id === lastSeenServerUpdateEventId
      || !progressIsFresh(message, now())
    ) return false;

    if (message.phase === 'idle') {
      if (
        lastServerUpdateStartedAt !== null
        && message.started_at < lastServerUpdateStartedAt
      ) return false;
      if (
        serverUpdateProgress !== null
        && (
          message.started_at < serverUpdateProgress.startedAt
          || (
            message.started_at === serverUpdateProgress.startedAt
            && message.operation !== serverUpdateProgress.operation
          )
        )
      ) return false;
      lastSeenServerUpdateEventId = message.event_id;
      lastServerUpdateStartedAt = Math.max(
        lastServerUpdateStartedAt ?? message.started_at,
        message.started_at,
      );
      if (
        serverUpdateProgress === null
      ) return true;
      if (serverUpdateProgress.phase === 'awaiting_reconnect') {
        // A sibling's reconnect proves that tab recovered, not this one. Keep
        // the accepted restart latched locally until this tab observes its own
        // disconnect/reconnect or independently confirms the target capability.
        return true;
      }
    } else {
      if (serverUpdateProgress === null) {
        // An idle tombstone proves this lineage already settled. A delayed
        // applying/awaiting event must not resurrect it after this tab's proof.
        if (
          lastServerUpdateStartedAt !== null
          && message.started_at <= lastServerUpdateStartedAt
        ) return false;
      } else {
        if (message.started_at < serverUpdateProgress.startedAt) return false;
        if (message.started_at === serverUpdateProgress.startedAt) {
          // Without Web Locks, two tabs can mint different operations in the
          // same millisecond before the server refuses one. The operation that
          // reached "restart accepted" outranks a merely applying peer.
          if (
            message.operation !== serverUpdateProgress.operation
            && !(
              serverUpdateProgress.phase === 'applying'
              && message.phase === 'awaiting_reconnect'
            )
          ) return false;
          if (
            serverUpdateProgress.phase === 'awaiting_reconnect'
            && message.phase === 'applying'
          ) return false;
          if (
            message.operation === serverUpdateProgress.operation
            && serverUpdateProgress.operationId !== undefined
            && message.phase === 'awaiting_reconnect'
            && message.operation_id !== serverUpdateProgress.operationId
          ) {
            // A delayed legacy envelope must not erase an exact receipt, and
            // two different receipts can never describe one action lineage.
            return false;
          }
        }
      }
      lastSeenServerUpdateEventId = message.event_id;
      lastServerUpdateStartedAt = Math.max(
        lastServerUpdateStartedAt ?? message.started_at,
        message.started_at,
      );
    }
    const next = progressFromMessage(message);
    const changed = !sameProgress(serverUpdateProgress, next);
    serverUpdateProgress = next;
    if (changed) {
      emit({
        type: 'server_update_progress',
        progress: cloneProgress(serverUpdateProgress),
      });
    }
    return true;
  };

  const acceptStoredServerUpdateProgress = (raw: string | null): boolean => {
    if (raw === null) {
      // Clears use a lineage-bearing idle tombstone. A bare remove event can
      // be delayed until after a newer apply, so it is never enough evidence
      // to change live progress.
      return false;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return false;
    }
    const message = parseServerUpdateProgressMessage(value);
    return message !== null
      ? acceptServerUpdateProgressMessage(message)
      : false;
  };

  const acceptPulseMessage = (pulse: RotationPulseV1 | null): boolean => {
    if (
      pulse === null
      || pulse.scope_id !== scopeId
      || pulse.event_id === lastSeenEventId
    ) return false;
    lastSeenEventId = pulse.event_id;
    emit({ type: 'reconcile' });
    return true;
  };

  const acceptPulse = (raw: string | null): boolean =>
    acceptPulseMessage(parsePulse(raw));

  const rereadPulseOrReconcile = (): void => {
    try {
      if (acceptPulse(
        storage?.getItem(CREDENTIAL_ROTATION_TAB_PULSE_KEY) ?? null,
      )) return;
    } catch {
      // The authoritative list read below is still useful after focus.
    }
    emit({ type: 'reconcile' });
  };

  const onMessage = (event: MessageEvent<unknown>): void => {
    const progressMessage = parseServerUpdateProgressMessage(event.data);
    if (progressMessage !== null) {
      acceptServerUpdateProgressMessage(progressMessage);
      return;
    }
    const pulse = parsePulseValue(event.data);
    if (pulse !== null) {
      acceptPulseMessage(pulse);
      return;
    }
    const message = parseMessage(event.data);
    if (
      message === null
      || message.scope_id !== scopeId
      || message.event_id === lastSeenEventId
    ) return;
    lastSeenEventId = message.event_id;
    const type = message.type === STARTED_MESSAGE_TYPE
      ? 'credential_rotation_started'
      : message.type === RELEASED_MESSAGE_TYPE
        ? 'credential_rotation_released'
        : message.type === SAFE_STOPPED_MESSAGE_TYPE
          ? 'credential_rotation_safe_stopped'
          : message.type === SAFE_STOP_RESOLVED_MESSAGE_TYPE
            ? 'credential_rotation_safe_stop_resolved'
            : message.type === CAPABILITY_RESOLVED_MESSAGE_TYPE
              ? 'server_capability_resolved'
              : 'credential_rotated';
    emit({ type, kind: message.kind, name: message.name });
  };
  const onStorage = (event: StorageEvent): void => {
    if (event.key === progressStorageKey) {
      acceptStoredServerUpdateProgress(event.newValue);
      return;
    }
    if (event.key !== CREDENTIAL_ROTATION_TAB_PULSE_KEY) return;
    acceptPulse(event.newValue);
  };
  const onFocus = (): void => {
    rereadPulseOrReconcile();
    void reconcileServerUpdateProgress();
  };
  const onVisibilityChange = (): void => {
    if (doc?.visibilityState === 'visible') {
      rereadPulseOrReconcile();
      void reconcileServerUpdateProgress();
    }
  };

  channel?.addEventListener('message', onMessage);
  view.addEventListener?.('storage', onStorage);
  view.addEventListener?.('focus', onFocus);
  doc.addEventListener?.('visibilitychange', onVisibilityChange);

  const validIdentity = (identity: {
    kind: ConnectionKind;
    name: string;
  }): boolean => VALID_KINDS.has(identity.kind)
    && CONNECTION_NAME_REGEX.test(identity.name);

  const postIdentity = (
    type: RotationMessageV1['type'],
    identity: { kind: ConnectionKind; name: string },
  ): string | null => {
    if (closed || !validIdentity(identity)) return null;
    const eventId = (options.eventId ?? defaultEventId)();
    if (!validEventId(eventId)) return null;
    lastSeenEventId = eventId;
    const message: RotationMessageV1 = {
      type,
      version: VERSION,
      scope_id: scopeId,
      event_id: eventId,
      kind: identity.kind,
      name: identity.name,
    };
    try {
      channel?.postMessage(message);
    } catch {
      // Focus/list reconciliation and the server ownership gate remain.
    }
    return eventId;
  };

  const persistOpaquePulse = (eventId: string): void => {
    const pulse: RotationPulseV1 = {
      type: PULSE_TYPE,
      version: VERSION,
      scope_id: scopeId,
      event_id: eventId,
    };
    try {
      storage?.setItem(
        CREDENTIAL_ROTATION_TAB_PULSE_KEY,
        JSON.stringify(pulse),
      );
    } catch {
      // A later focus still performs an authoritative generic reconcile.
    }
  };

  const broadcastOpaquePulse = (eventId: string): void => {
    const pulse: RotationPulseV1 = {
      type: PULSE_TYPE,
      version: VERSION,
      scope_id: scopeId,
      event_id: eventId,
    };
    try {
      channel?.postMessage(pulse);
    } catch {
      // Storage/focus reconciliation remains available.
    }
  };

  const claimOwnership = async (
    key: string,
    lockName: string,
  ): Promise<CredentialRotationOwnershipLease | null> => {
    if (closed || ownershipLockProvider === null) return null;
    const held = ownershipLeases.get(key);
    if (held !== undefined) return held;
    const pending = ownershipClaims.get(key);
    if (pending !== undefined) return pending;

    const claim = new Promise<CredentialRotationOwnershipLease | null>((resolve) => {
      let settled = false;
      const settle = (lease: CredentialRotationOwnershipLease | null): void => {
        if (settled) return;
        settled = true;
        resolve(lease);
      };
      try {
        void ownershipLockProvider.request(
          lockName,
          { mode: 'exclusive', ifAvailable: true },
          async (lock) => {
            if (lock === null || closed) {
              settle(null);
              return;
            }
            let releaseHeldLock = (): void => undefined;
            const heldLock = new Promise<void>((release) => {
              releaseHeldLock = release;
            });
            let released = false;
            const lease: CredentialRotationOwnershipLease = {
              release() {
                if (released) return;
                released = true;
                if (ownershipLeases.get(key) === lease) {
                  ownershipLeases.delete(key);
                }
                releaseHeldLock();
              },
            };
            ownershipLeases.set(key, lease);
            settle(lease);
            await heldLock;
          },
        ).catch(() => settle(null));
      } catch {
        settle(null);
      }
    });
    ownershipClaims.set(key, claim);
    void claim.finally(() => {
      if (ownershipClaims.get(key) === claim) ownershipClaims.delete(key);
    });
    return claim;
  };

  const claimCredentialRotationOwnership = async (identity: {
    kind: ConnectionKind;
    name: string;
  }): Promise<CredentialRotationOwnershipLease | null> => {
    if (!validIdentity(identity)) return null;
    return claimOwnership(
      ownershipKey(identity),
      credentialRotationOwnershipLockName(scopeId, identity),
    );
  };

  const serverUpdateOwnershipKey = 'server-update';
  const claimServerUpdateOwnership = () => claimOwnership(
    serverUpdateOwnershipKey,
    serverUpdateOwnershipLockName(scopeId),
  );

  const notifyServerUpdateProgress = (progress: {
    phase: ServerUpdateProgressPhase;
    operation: ServerUpdateOperation;
    operationId?: string;
  }): void => {
    if (closed) return;
  // ⛔⛔ A RECEIPT IS NOT ONLY A RESTART'S. It was accepted on `awaiting_reconnect`
  // ALONE, and a notify carrying one on any other phase was dropped in SILENCE —
  // which is where the receipt now arrives: `update.apply` answers `applying`
  // with the id reserved before the work starts, so the run is answerable from
  // the moment it is accepted rather than only once a restart was reached. A
  // latch that names its operation is the one thing that survives its owner
  // leaving the page, so dropping it here disarmed exactly the case it exists
  // for — and did so invisibly, because a dropped notify looks like a notify
  // nobody made.
  //
  // ⚠ Cross-version, same browser: a tab running an older build parses an
  // `applying` latch carrying a receipt as malformed and removes it. That is the
  // pre-existing behaviour for anything it cannot name, and the cost is a latch
  // retired early — never a wrong one accepted.
    if (
      progress.operationId !== undefined
      && (
        (progress.phase !== 'awaiting_reconnect' && progress.phase !== 'applying')
        || !validServerUpdateOperationId(progress.operationId)
      )
    ) return;
    // A terminal restart advances one lineage from applying to
    // awaiting_reconnect. An rpc acceptance can resolve after that terminal (the
    // two travel on different channels), but it is older evidence and must not
    // mint a fresh applying lineage over the receipt verifier's state.
    if (
      serverUpdateProgress !== null
      && serverUpdateProgress.operation === progress.operation
      && serverUpdateProgress.phase === 'awaiting_reconnect'
      && progress.phase === 'applying'
    ) return;
    const eventId = (options.eventId ?? defaultEventId)();
    if (!validEventId(eventId)) return;
    const observedAt = now();
    if (!Number.isSafeInteger(observedAt)) return;
    const continuesCurrentLineage = serverUpdateProgress !== null
      && serverUpdateProgress.operation === progress.operation
      && (
        serverUpdateProgress.phase === progress.phase
        || (
          serverUpdateProgress.phase === 'applying'
          && progress.phase === 'awaiting_reconnect'
        )
      );
    const startedAt = continuesCurrentLineage
      ? serverUpdateProgress!.startedAt
      : Math.max(
          observedAt,
          lastServerUpdateStartedAt === null
            ? observedAt
            : lastServerUpdateStartedAt + 1,
        );
    if (!Number.isSafeInteger(startedAt)) return;
    const operationId = progress.operationId
      ?? (continuesCurrentLineage
        ? serverUpdateProgress?.operationId
        : undefined);
    const message: ServerUpdateProgressMessageV1 = {
      type: SERVER_UPDATE_PROGRESS_MESSAGE_TYPE,
      version: VERSION,
      scope_id: scopeId,
      event_id: eventId,
      phase: progress.phase,
      operation: progress.operation,
      started_at: startedAt,
      ...(operationId !== undefined ? { operation_id: operationId } : {}),
    };
    const next = progressFromMessage(message);
    const changed = !sameProgress(serverUpdateProgress, next);
    serverUpdateProgress = next;
    lastSeenServerUpdateEventId = eventId;
    lastServerUpdateStartedAt = startedAt;
    try {
      storage?.setItem(progressStorageKey, JSON.stringify(message));
    } catch {
      // The ephemeral channel + server ownership lock still converge live tabs.
    }
    try {
      channel?.postMessage(message);
    } catch {
      // Storage/focus reconciliation remains available.
    }
    if (changed) {
      emit({
        type: 'server_update_progress',
        progress: cloneProgress(serverUpdateProgress),
      });
    }
  };

  const clearServerUpdateProgress = async (
    expected: ServerUpdateTabProgress,
  ): Promise<boolean> => {
    if (
      closed
      || !sameProgress(serverUpdateProgress, expected)
    ) return false;
    const alreadyHeld =
      ownershipLeases.get(serverUpdateOwnershipKey) ?? null;
    const lease = ownershipLockProvider === null
      ? null
      : alreadyHeld ?? await claimServerUpdateOwnership();
    if (ownershipLockProvider !== null && lease === null) return false;
    try {
      if (
        closed
        || !sameProgress(serverUpdateProgress, expected)
      ) return false;
      try {
        const raw = storage?.getItem(progressStorageKey) ?? null;
        if (raw !== null) {
          const parsed = parseServerUpdateProgressMessage(JSON.parse(raw));
          if (
            parsed !== null
            && parsed.scope_id === scopeId
            && progressIsFresh(parsed, now())
          ) {
            if (parsed.phase === 'idle') {
              const storedIsNewerOrAmbiguous =
                parsed.started_at > expected.startedAt
                || (
                  parsed.started_at === expected.startedAt
                  && parsed.operation !== expected.operation
                );
              if (storedIsNewerOrAmbiguous) {
                // This tab has independently settled `expected`, but must not
                // overwrite a later tombstone. Retire only its local latch.
                lastSeenServerUpdateEventId = parsed.event_id;
                lastServerUpdateStartedAt = Math.max(
                  lastServerUpdateStartedAt ?? parsed.started_at,
                  parsed.started_at,
                );
                serverUpdateProgress = null;
                emit({ type: 'server_update_progress', progress: null });
                return true;
              }
            } else {
              const stored = progressFromMessage(parsed);
              if (!sameProgress(stored, expected)) {
                const storedIsOlderOrRegressive =
                  parsed.started_at < expected.startedAt
                  || (
                    parsed.started_at === expected.startedAt
                    && parsed.operation === expected.operation
                    && expected.phase === 'awaiting_reconnect'
                    && parsed.phase === 'applying'
                  );
                if (!storedIsOlderOrRegressive) {
                  acceptServerUpdateProgressMessage(parsed);
                  return false;
                }
              }
            }
          }
        }
      } catch {
        // The channel message remains lineage-safe when storage is locked;
        // peers compare it with the operation they currently observe.
      }
      const eventId = (options.eventId ?? defaultEventId)();
      if (!validEventId(eventId)) return false;
      const message: ServerUpdateProgressMessageV1 = {
        type: SERVER_UPDATE_PROGRESS_MESSAGE_TYPE,
        version: VERSION,
        scope_id: scopeId,
        event_id: eventId,
        phase: 'idle',
        operation: expected.operation,
        started_at: expected.startedAt,
      };
      serverUpdateProgress = null;
      lastSeenServerUpdateEventId = eventId;
      lastServerUpdateStartedAt = Math.max(
        lastServerUpdateStartedAt ?? expected.startedAt,
        expected.startedAt,
      );
      try {
        // An idle tombstone is safer than a lineage-free removal event, which
        // could arrive after a newer update starts.
        storage?.setItem(progressStorageKey, JSON.stringify(message));
      } catch {
        // Broadcast still carries the exact operation lineage.
      }
      try {
        channel?.postMessage(message);
      } catch {
        // A later storage/focus reconciliation remains available.
      }
      emit({ type: 'server_update_progress', progress: null });
      return true;
    } finally {
      if (alreadyHeld === null) lease?.release();
    }
  };

  async function reconcileServerUpdateProgress(): Promise<ServerUpdateTabProgress | null> {
    if (closed) return null;
    const readAt = now();
    if (
      serverUpdateProgress !== null
      && !progressStartedAtIsFresh(
        serverUpdateProgress.phase,
        serverUpdateProgress.startedAt,
        readAt,
      )
    ) {
      serverUpdateProgress = null;
      emit({ type: 'server_update_progress', progress: null });
    }
    let raw: string | null;
    try {
      raw = storage?.getItem(progressStorageKey) ?? null;
    } catch {
      return cloneProgress(serverUpdateProgress);
    }
    let parsed: ServerUpdateProgressMessageV1 | null = null;
    if (raw !== null) {
      try {
        parsed = parseServerUpdateProgressMessage(JSON.parse(raw));
      } catch {
        // Invalid durable progress is removed below.
      }
      if (
        parsed === null
        || parsed.scope_id !== scopeId
        || !progressIsFresh(parsed, readAt)
      ) {
        try {
          storage?.removeItem(progressStorageKey);
        } catch {
          // The malformed envelope remains ignored in memory.
        }
      } else {
        acceptServerUpdateProgressMessage(parsed);
      }
    }

    if (
      serverUpdateProgress?.phase !== 'applying'
      || ownershipLockProvider === null
      || ownershipLeases.has(serverUpdateOwnershipKey)
      // ⛔⛔ A LATCH THAT NAMES ITS OPERATION IS NOT STRANDED. The retirement below
      // rests on one premise — nobody can advance an "applying" marker once its
      // owner is gone — and a receipt makes that premise false: any tab can ask
      // the server what became of that exact operation. Reaping it anyway throws
      // away the only pointer to a run that is still going, which is the whole
      // reason the id is on the latch. The receipt-free shape is unchanged and
      // still retired: nothing can answer for it.
      || serverUpdateProgress.operationId !== undefined
    ) return cloneProgress(serverUpdateProgress);

    const probeLease = await claimServerUpdateOwnership();
    if (probeLease === null) return cloneProgress(serverUpdateProgress);
    // No browser tab can advance this "applying" marker after its owner closed.
    // Retire the stale browser latch; if its RPC outlived the tab, the server's
    // authoritative in-flight gate still refuses any duplicate mutation.
    const expected = cloneProgress(serverUpdateProgress);
    if (expected !== null) await clearServerUpdateProgress(expected);
    probeLease.release();
    return cloneProgress(serverUpdateProgress);
  }

  return {
    supportsOwnershipLeases: ownershipLockProvider !== null,
    claimCredentialRotationOwnership,
    notifyCredentialRotationStarted(identity) {
      postIdentity(STARTED_MESSAGE_TYPE, identity);
    },
    notifyCredentialRotationReleased(identity) {
      postIdentity(RELEASED_MESSAGE_TYPE, identity);
    },
    notifyCredentialRotationSafeStopped(identity) {
      const eventId = postIdentity(SAFE_STOPPED_MESSAGE_TYPE, identity);
      if (eventId === null) return;
      // Persist no identity or recovery detail. A sibling without a live
      // channel rechecks only its already-open exact editor after this pulse.
      persistOpaquePulse(eventId);
    },
    notifyCredentialRotationSafeStopResolved(identity) {
      const eventId = postIdentity(
        SAFE_STOP_RESOLVED_MESSAGE_TYPE,
        identity,
      );
      if (eventId === null) return;
      persistOpaquePulse(eventId);
    },
    notifyPostSafeStopVerificationChanged() {
      if (closed) return;
      const eventId = (options.eventId ?? defaultEventId)();
      if (!validEventId(eventId)) return;
      lastSeenEventId = eventId;
      // BroadcastChannel does not echo to its sender. Wake shell-level
      // consumers in this tab too (notably Attention); every consumer still
      // re-lists server authority before changing visible recovery state.
      emit({ type: 'reconcile' });
      broadcastOpaquePulse(eventId);
      persistOpaquePulse(eventId);
    },
    notifyCredentialRotated(identity) {
      const eventId = postIdentity(ROTATED_MESSAGE_TYPE, identity);
      if (eventId === null) return;
      persistOpaquePulse(eventId);
    },
    supportsServerUpdateOwnership: ownershipLockProvider !== null,
    claimServerUpdateOwnership,
    readServerUpdateProgress() {
      return cloneProgress(serverUpdateProgress);
    },
    notifyServerUpdateProgress,
    clearServerUpdateProgress,
    reconcileServerUpdateProgress,
    notifyServerCapabilityResolved(identity) {
      const eventId = postIdentity(
        CAPABILITY_RESOLVED_MESSAGE_TYPE,
        identity,
      );
      if (eventId === null) return;
      persistOpaquePulse(eventId);
    },
    subscribe(listener) {
      if (closed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      if (closed) return;
      closed = true;
      listeners.clear();
      for (const lease of [...ownershipLeases.values()]) lease.release();
      channel?.removeEventListener('message', onMessage);
      try {
        channel?.close();
      } catch {
        /* best-effort browser teardown */
      }
      view.removeEventListener?.('storage', onStorage);
      view.removeEventListener?.('focus', onFocus);
      doc.removeEventListener?.('visibilitychange', onVisibilityChange);
    },
  };
};
