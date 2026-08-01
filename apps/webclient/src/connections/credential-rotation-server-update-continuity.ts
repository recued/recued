/** Secret-free continuity for an unsupported credential-rotation preflight.
 *
 * The replacement credential and every form value stay memory-only. This
 * marker carries only the active server-profile scope, existing connection
 * identity, recovery timestamp, and an allowlisted projection of server
 * version/update evidence so Settings -> Updates can survive a route change,
 * server restart, or same-tab reload, then return to the exact authoritative
 * preflight. An untouched clean-editor landing keeps a target-only continuation
 * until the first actual field change; interrupted checks remain durable.
 */

import type {
  ConnectionKind,
  ReleaseCheckResponse,
  ReleaseCheckStatus,
} from '@recued/contracts';
import {
  CONNECTION_NAME_REGEX,
  type ConnectionsServerUpdateTriage,
  type ConnectionsServerUpdateTriageReason,
  type ServerUpdateReceiptVerificationState,
} from '@recued/ui-shared';

import type { WebclientConnectionStatus } from '../realtime/connection-status.js';
import type { ServerUpdateTabProgress } from './credential-rotation-tab-convergence.js';

export type CredentialRotationServerUpdateContinuityStorage = Pick<
  Storage,
  'getItem' | 'setItem' | 'removeItem'
>;

export type CredentialRotationServerUpdatePhase =
  | 'guide'
  | 'awaiting_reconnect'
  | 'ready'
  /** The one-shot exact return address has been consumed, but its
   * authoritative activity + causally-later row reads have not reached a
   * stable landing yet. This safe phase survives reload; tab ownership does
   * not, so an interrupted boot can offer one explicit resume. */
  | 'checking_return'
  /** The fresh activity + saved-row reads opened the exact clean editor, and
   * no field has changed yet. Only target + phase survive interruption; resume
   * repeats those current reads and never restores a form or completion. */
  | 'editor_ready'
  | 'triage'
  /** One-shot, memory-only receipt after a fresh read in this tab proved the
   * previously missing activity capability against this selected server. */
  | 'resolved_elsewhere';

type CredentialRotationServerUpdateDurablePhase = Exclude<
  CredentialRotationServerUpdatePhase,
  'resolved_elsewhere'
>;

export interface CredentialRotationServerUpdateTarget {
  readonly kind: ConnectionKind;
  readonly name: string;
}

export interface CredentialRotationServerUpdateMarker
  extends CredentialRotationServerUpdateTarget {
  readonly phase: CredentialRotationServerUpdatePhase;
  readonly startedAt: number;
  /** Running server version observed before the update detour. */
  readonly baselineVersion?: string;
  /** Credential-free evidence when the returned server still lacks support. */
  readonly serverUpdateTriage?: ConnectionsServerUpdateTriage;
  /** Memory-only, profile-scoped progress from the tab coordinating the
   * server update or rollback. It is restored by the tab coordinator, never
   * serialized into this connection-specific session marker. */
  readonly serverUpdateProgress?: ServerUpdateTabProgress;
  /** Memory-only, allowlisted result of resolving the exact opaque receipt.
   * The receipt itself and raw failures remain in the boot verifier. */
  readonly serverUpdateVerification?: ServerUpdateReceiptVerificationState;
  /** Memory-only ownership of the consumed exact-return route. Reload and
   * sibling tabs restore `checking_return` without this bit, which turns the
   * in-flight status into an explicit Resume action instead of claiming that
   * another route is still checking. */
  readonly exactReturnActive?: true;
}

export interface CredentialRotationServerUpdateContinuity {
  /** Current profile-scoped marker, if one was restored or begun this boot. */
  read(): CredentialRotationServerUpdateMarker | null;
  /** True when the current marker is recoverable after a same-tab reload. */
  isDurable(): boolean;
  /** Start (or replace) the guide for an explicit unsupported preflight. */
  begin(target: CredentialRotationServerUpdateTarget): void;
  /** Remember the running version before update/restart. Invalid wire values
   * are ignored rather than widened into durable browser state. */
  recordServerCheck(
    target: CredentialRotationServerUpdateTarget,
    check: ReleaseCheckResponse,
  ): void;
  /** Record the authoritative update evidence after support is still absent. */
  markStillUnsupported(
    target: CredentialRotationServerUpdateTarget,
    check: ReleaseCheckResponse | null,
  ): ConnectionsServerUpdateTriage | null;
  /** An accepted in-place update now owns the next disconnect/reconnect. */
  markAwaitingReconnect(
    target: CredentialRotationServerUpdateTarget,
    runningVersion?: string,
  ): void;
  /** Replace only the matching stale triage with a one-shot result. The
   * result is deliberately not persisted, so reload cannot replay an old
   * confirmation as current server evidence. */
  markCapabilityResolvedElsewhere(
    target: CredentialRotationServerUpdateTarget,
  ): boolean;
  /** Turn the matching one-shot result back into a durable exact retry only
   * after the owner explicitly chooses to continue in this tab. */
  resumeResolvedRetry(
    target: CredentialRotationServerUpdateTarget,
  ): boolean;
  /** Consume the exact-return handoff before its temporary route is scrubbed.
   * The durable phase retains only the existing secret-free envelope; any
   * one-shot completion is removed from this owner and must be passed directly
   * to the first mounted panel if it still needs orientation copy. */
  beginExactReturn(
    target: CredentialRotationServerUpdateTarget,
  ): boolean;
  /** Release only this tab's route ownership. The durable target remains so a
   * reload or route change can offer one safe, explicit resume. */
  interruptExactReturn(
    target: CredentialRotationServerUpdateTarget,
  ): void;
  /** Replace active exact-return ownership with a target-only clean-editor
   * continuation. This strips all update evidence and completion state before
   * persistence; the first actual editor change retires it. */
  markExactEditorReady(
    target: CredentialRotationServerUpdateTarget,
  ): boolean;
  /** Overlay privacy-safe, server-global tab progress without changing or
   * persisting the underlying exact retry/triage phase. */
  observeServerUpdateProgress(progress: ServerUpdateTabProgress | null): void;
  /** Overlay route-independent receipt recovery without persisting it. */
  observeServerUpdateVerification(
    state: ServerUpdateReceiptVerificationState | null,
  ): void;
  /** Retire only the matching target so stale UI cannot clear a newer guide. */
  retire(target?: CredentialRotationServerUpdateTarget): void;
  /** Route-independent updates for Account and Settings. Not immediate. */
  subscribe(
    listener: (marker: CredentialRotationServerUpdateMarker | null) => void,
  ): () => void;
  dispose(): void;
}

interface StoredCredentialRotationServerUpdateV1 {
  readonly version: 1;
  readonly scope_id: string;
  readonly kind: ConnectionKind;
  readonly name: string;
  readonly phase: Exclude<
    CredentialRotationServerUpdateDurablePhase,
    'triage'
  >;
  readonly started_at: number;
}

interface StoredCredentialRotationServerUpdateV2 {
  readonly version: 2;
  readonly scope_id: string;
  readonly kind: ConnectionKind;
  readonly name: string;
  readonly phase: CredentialRotationServerUpdateDurablePhase;
  readonly started_at: number;
  readonly baseline_version: string | null;
  readonly triage_reason: ConnectionsServerUpdateTriageReason | null;
  readonly triage_check_status: ReleaseCheckStatus | 'unavailable' | null;
  readonly triage_current_version: string | null;
  readonly triage_channel: 'stable' | 'edge' | null;
  readonly triage_available_version: string | null;
}

type StoredCredentialRotationServerUpdate =
  | StoredCredentialRotationServerUpdateV1
  | StoredCredentialRotationServerUpdateV2;

export const CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY =
  'recued.connections.credential-rotation-server-update.v1';
// Keep the established key so existing v1 envelopes remain discoverable. The
// validated `version` field above owns the in-place envelope migration.

const DEFAULT_MAX_AGE_MS = Number.POSITIVE_INFINITY;
const MAX_SCOPE_ID = 256;
const VALID_KINDS: ReadonlySet<string> = new Set([
  'api',
  'mcp',
  'notification',
]);
const VALID_V1_PHASES: ReadonlySet<string> = new Set([
  'guide',
  'awaiting_reconnect',
  'ready',
]);
const VALID_PHASES: ReadonlySet<string> = new Set([
  ...VALID_V1_PHASES,
  'checking_return',
  'editor_ready',
  'triage',
]);
const VALID_RELEASE_CHECK_STATUSES: ReadonlySet<string> = new Set([
  'update-available',
  'up-to-date',
  'stale-feed',
  'launcher-outdated',
  'replay',
  'fetch-failed',
  'bad-signature',
  'not-configured',
]);
const VALID_TRIAGE_REASONS: ReadonlySet<string> = new Set([
  'update_still_available',
  'running_version_unchanged',
  'running_version_changed',
  'launcher_update_required',
  'self_update_unavailable',
  'current_build_missing_capability',
  'release_check_inconclusive',
]);
const MAX_VERSION_LENGTH = 128;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isValidTarget = (
  target: CredentialRotationServerUpdateTarget,
): boolean => VALID_KINDS.has(target.kind)
  && CONNECTION_NAME_REGEX.test(target.name);

const sameTarget = (
  left: CredentialRotationServerUpdateTarget,
  right: CredentialRotationServerUpdateTarget,
): boolean => left.kind === right.kind && left.name === right.name;

const hasExactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean => Object.keys(value).length === expected.length
  && expected.every((key) => Object.hasOwn(value, key));

const isValidVersion = (value: unknown): value is string =>
  typeof value === 'string'
  && value.length > 0
  && value.length <= MAX_VERSION_LENGTH
  && !/[\u0000-\u001f\u007f]/u.test(value);

interface SafeReleaseCheckProjection {
  readonly status: ReleaseCheckStatus;
  readonly currentVersion: string;
  readonly channel: 'stable' | 'edge';
  readonly availableVersion?: string;
}

const projectReleaseCheck = (
  value: unknown,
): SafeReleaseCheckProjection | null => {
  if (
    !isRecord(value)
    || typeof value.status !== 'string'
    || !VALID_RELEASE_CHECK_STATUSES.has(value.status)
    || !isValidVersion(value.current_version)
    || (value.channel !== 'stable' && value.channel !== 'edge')
  ) return null;
  if (value.status === 'update-available') {
    if (!isRecord(value.available) || !isValidVersion(value.available.version)) {
      return null;
    }
    return {
      status: value.status,
      currentVersion: value.current_version,
      channel: value.channel,
      availableVersion: value.available.version,
    };
  }
  return {
    status: value.status as ReleaseCheckStatus,
    currentVersion: value.current_version,
    channel: value.channel,
  };
};

const triageFromProjection = (
  baselineVersion: string | undefined,
  check: SafeReleaseCheckProjection | null,
): ConnectionsServerUpdateTriage => {
  if (check === null) {
    return {
      reason: 'release_check_inconclusive',
      checkStatus: 'unavailable',
      ...(baselineVersion !== undefined ? { baselineVersion } : {}),
    };
  }
  let reason: ConnectionsServerUpdateTriageReason;
  if (check.status === 'update-available') {
    reason = 'update_still_available';
  } else if (check.status === 'launcher-outdated') {
    reason = 'launcher_update_required';
  } else if (check.status === 'not-configured') {
    reason = 'self_update_unavailable';
  } else if (check.status !== 'up-to-date') {
    // A version echo is useful evidence, but it cannot turn a failed, stale,
    // replayed, or bad-signature release check into a successful diagnosis.
    reason = 'release_check_inconclusive';
  } else if (baselineVersion === undefined) {
    reason = 'current_build_missing_capability';
  } else {
    reason = check.currentVersion === baselineVersion
      ? 'running_version_unchanged'
      : 'running_version_changed';
  }
  return {
    reason,
    checkStatus: check.status,
    ...(baselineVersion !== undefined ? { baselineVersion } : {}),
    currentVersion: check.currentVersion,
    channel: check.channel,
    ...(check.availableVersion !== undefined
      ? { availableVersion: check.availableVersion }
      : {}),
  };
};

export const classifyCredentialRotationServerUpdateTriage = (
  baselineVersion: string | undefined,
  check: ReleaseCheckResponse | null,
): ConnectionsServerUpdateTriage => triageFromProjection(
  isValidVersion(baselineVersion) ? baselineVersion : undefined,
  projectReleaseCheck(check),
);

const hasValidStoredBase = (
  value: Record<string, unknown>,
  phases: ReadonlySet<string>,
): boolean => typeof value.scope_id === 'string'
  && value.scope_id.length > 0
  && value.scope_id.length <= MAX_SCOPE_ID
  && typeof value.kind === 'string'
  && VALID_KINDS.has(value.kind)
  && typeof value.name === 'string'
  && CONNECTION_NAME_REGEX.test(value.name)
  && typeof value.phase === 'string'
  && phases.has(value.phase)
  && typeof value.started_at === 'number'
  && Number.isFinite(value.started_at);

const isStoredV1 = (
  value: unknown,
): value is StoredCredentialRotationServerUpdateV1 => {
  if (!isRecord(value)) return false;
  const expected = [
    'version',
    'scope_id',
    'kind',
    'name',
    'phase',
    'started_at',
  ];
  return value.version === 1
    && hasExactKeys(value, expected)
    && hasValidStoredBase(value, VALID_V1_PHASES);
};

const isStoredV2 = (
  value: unknown,
): value is StoredCredentialRotationServerUpdateV2 => {
  if (!isRecord(value)) return false;
  const expected = [
    'version',
    'scope_id',
    'kind',
    'name',
    'phase',
    'started_at',
    'baseline_version',
    'triage_reason',
    'triage_check_status',
    'triage_current_version',
    'triage_channel',
    'triage_available_version',
  ];
  if (
    value.version !== 2
    || !hasExactKeys(value, expected)
    || !hasValidStoredBase(value, VALID_PHASES)
    || (value.baseline_version !== null
      && !isValidVersion(value.baseline_version))
  ) return false;
  if (value.phase !== 'triage') {
    return value.triage_reason === null
      && value.triage_check_status === null
      && value.triage_current_version === null
      && value.triage_channel === null
      && value.triage_available_version === null;
  }
  if (
    typeof value.triage_reason !== 'string'
    || !VALID_TRIAGE_REASONS.has(value.triage_reason)
    || typeof value.triage_check_status !== 'string'
    || (
      value.triage_check_status !== 'unavailable'
      && !VALID_RELEASE_CHECK_STATUSES.has(value.triage_check_status)
    )
  ) return false;
  const baseline = value.baseline_version ?? undefined;
  let projected: SafeReleaseCheckProjection | null = null;
  if (value.triage_check_status === 'unavailable') {
    if (
      value.triage_current_version !== null
      || value.triage_channel !== null
      || value.triage_available_version !== null
    ) return false;
  } else {
    if (
      !isValidVersion(value.triage_current_version)
      || (value.triage_channel !== 'stable' && value.triage_channel !== 'edge')
    ) return false;
    if (value.triage_check_status === 'update-available') {
      if (!isValidVersion(value.triage_available_version)) return false;
      projected = {
        status: value.triage_check_status,
        currentVersion: value.triage_current_version,
        channel: value.triage_channel,
        availableVersion: value.triage_available_version,
      };
    } else {
      if (value.triage_available_version !== null) return false;
      projected = {
        status: value.triage_check_status as ReleaseCheckStatus,
        currentVersion: value.triage_current_version,
        channel: value.triage_channel,
      };
    }
  }
  return triageFromProjection(baseline, projected).reason
    === value.triage_reason;
};

const parseStored = (
  raw: string,
): StoredCredentialRotationServerUpdate | null => {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isStoredV1(parsed) || isStoredV2(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const inertThenRemove = (
  storage: CredentialRotationServerUpdateContinuityStorage,
): void => {
  try {
    storage.setItem(
      CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
      '{"version":1,"retired":true}',
    );
  } catch {
    // Removal may still be available when a quota/policy blocks writes.
  }
  try {
    storage.removeItem(CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY);
  } catch {
    // The inert replacement, when written, is already non-replayable.
  }
};

const markerFromStored = (
  stored: StoredCredentialRotationServerUpdate,
): CredentialRotationServerUpdateMarker => {
  const base: CredentialRotationServerUpdateMarker = {
    kind: stored.kind,
    name: stored.name,
    phase: stored.phase,
    startedAt: stored.started_at,
    ...(stored.version === 2 && stored.baseline_version !== null
      ? { baselineVersion: stored.baseline_version }
      : {}),
  };
  if (
    stored.version !== 2
    || stored.phase !== 'triage'
    || stored.triage_reason === null
    || stored.triage_check_status === null
  ) return base;
  return {
    ...base,
    serverUpdateTriage: {
      reason: stored.triage_reason,
      checkStatus: stored.triage_check_status,
      ...(stored.baseline_version !== null
        ? { baselineVersion: stored.baseline_version }
        : {}),
      ...(stored.triage_current_version !== null
        ? { currentVersion: stored.triage_current_version }
        : {}),
      ...(stored.triage_channel !== null
        ? { channel: stored.triage_channel }
        : {}),
      ...(stored.triage_available_version !== null
        ? { availableVersion: stored.triage_available_version }
        : {}),
    },
  };
};

export const createCredentialRotationServerUpdateContinuity = (options: {
  storage?: CredentialRotationServerUpdateContinuityStorage | null;
  scopeId?: string | null;
  status: () => WebclientConnectionStatus;
  onStatus: (
    listener: (status: WebclientConnectionStatus) => void,
  ) => () => void;
  now?: () => number;
  maxAgeMs?: number;
}): CredentialRotationServerUpdateContinuity => {
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
  const persistenceEnabled = storage !== null
    && storage !== undefined
    && scopeId.length > 0
    && scopeId.length <= MAX_SCOPE_ID;
  const now = options.now ?? Date.now;
  const maxAgeMs = options.maxAgeMs !== undefined
    && Number.isFinite(options.maxAgeMs)
    && options.maxAgeMs > 0
    ? options.maxAgeMs
    : DEFAULT_MAX_AGE_MS;

  const readStored = (): CredentialRotationServerUpdateMarker | null => {
    if (!persistenceEnabled) return null;
    let raw: string | null;
    try {
      raw = storage!.getItem(
        CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
      );
    } catch {
      return null;
    }
    if (raw === null) return null;
    const stored = parseStored(raw);
    const readAt = now();
    if (
      stored === null
      || !Number.isFinite(readAt)
      || stored.started_at > readAt
      || readAt - stored.started_at > maxAgeMs
    ) {
      inertThenRemove(storage!);
      return null;
    }
    // A marker for another saved server remains available if this tab later
    // switches back. It must never appear against the current profile.
    if (stored.scope_id !== scopeId) return null;
    return markerFromStored(stored);
  };

  let disposed = false;
  let current = readStored();
  let sawDisconnect = current !== null
    && current.phase !== 'ready'
    && current.phase !== 'checking_return'
    && current.phase !== 'editor_ready'
    && current.phase !== 'triage'
    && options.status() !== 'connected';
  const listeners = new Set<(
    marker: CredentialRotationServerUpdateMarker | null,
  ) => void>();

  let durable = current !== null;

  const snapshotVerification = (
    verification: ServerUpdateReceiptVerificationState,
  ): ServerUpdateReceiptVerificationState => ({
    ...verification,
    ...(verification.baseline === undefined
      ? {}
      : {
          baseline: {
            currentVersion: verification.baseline.currentVersion,
            channel: verification.baseline.channel,
            updateStatus: verification.baseline.updateStatus,
            ...(verification.baseline.affectedConnection === undefined
              ? {}
              : {
                  affectedConnection: {
                    kind: verification.baseline.affectedConnection.kind,
                    name: verification.baseline.affectedConnection.name,
                    activity:
                      verification.baseline.affectedConnection.activity,
                  },
                }),
          },
        }),
  });

  const snapshotOf = (
    marker: CredentialRotationServerUpdateMarker,
  ): CredentialRotationServerUpdateMarker => ({
    ...marker,
    ...(marker.serverUpdateTriage !== undefined
      ? { serverUpdateTriage: { ...marker.serverUpdateTriage } }
      : {}),
    ...(marker.serverUpdateProgress !== undefined
      ? { serverUpdateProgress: { ...marker.serverUpdateProgress } }
      : {}),
    ...(marker.serverUpdateVerification !== undefined
      ? {
          serverUpdateVerification: snapshotVerification(
            marker.serverUpdateVerification,
          ),
        }
      : {}),
  });

  const persist = (): boolean => {
    if (!persistenceEnabled || current === null) return false;
    if (current.phase === 'resolved_elsewhere') {
      inertThenRemove(storage!);
      return false;
    }
    const triage = current.phase === 'triage'
      ? current.serverUpdateTriage ?? null
      : null;
    try {
      storage!.setItem(
        CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
        JSON.stringify({
          version: 2,
          scope_id: scopeId,
          kind: current.kind,
          name: current.name,
          phase: current.phase,
          started_at: current.startedAt,
          baseline_version: current.baselineVersion ?? null,
          triage_reason: triage?.reason ?? null,
          triage_check_status: triage?.checkStatus ?? null,
          triage_current_version: triage?.currentVersion ?? null,
          triage_channel: triage?.channel ?? null,
          triage_available_version: triage?.availableVersion ?? null,
        } satisfies StoredCredentialRotationServerUpdateV2),
      );
      return true;
    } catch {
      // The in-memory continuation remains useful for route changes, but the
      // previously saved phase is now stale. Retire it best-effort so reload
      // cannot replay an older guide while this tab correctly reports that
      // its newest diagnosis is not durable.
      inertThenRemove(storage!);
      return false;
    }
  };

  const emit = (): void => {
    const snapshot = current === null ? null : snapshotOf(current);
    for (const listener of [...listeners]) {
      try {
        listener(snapshot);
      } catch {
        // One presentation listener cannot break the continuity owner.
      }
    }
  };

  const setPhase = (
    phase: Exclude<
      CredentialRotationServerUpdatePhase,
      'triage' | 'resolved_elsewhere'
    >,
  ): void => {
    if (current === null || current.phase === phase) return;
    const { serverUpdateTriage: _triage, ...rest } = current;
    current = { ...rest, phase };
    durable = persist();
    emit();
  };

  const detachStatus = options.onStatus((status) => {
    if (
      disposed
      || current === null
      || current.phase === 'ready'
      || current.phase === 'checking_return'
      || current.phase === 'editor_ready'
      || current.phase === 'triage'
      || current.phase === 'resolved_elsewhere'
    ) return;
    if (status !== 'connected') {
      sawDisconnect = true;
      return;
    }
    if (sawDisconnect) setPhase('ready');
  });

  return {
    read() {
      return current === null ? null : snapshotOf(current);
    },
    isDurable() {
      return current !== null && durable;
    },
    begin(target) {
      if (disposed || !isValidTarget(target)) return;
      const startedAt = now();
      if (!Number.isFinite(startedAt)) return;
      current = {
        kind: target.kind,
        name: target.name,
        phase: 'guide',
        startedAt,
      };
      sawDisconnect = options.status() !== 'connected';
      durable = persist();
      emit();
    },
    recordServerCheck(target, check) {
      if (
        disposed
        || current === null
        || current.phase !== 'guide'
        || current.baselineVersion !== undefined
        || !sameTarget(current, target)
      ) return;
      const projected = projectReleaseCheck(check);
      if (projected === null) return;
      current = {
        ...current,
        baselineVersion: projected.currentVersion,
      };
      durable = persist();
      emit();
    },
    markStillUnsupported(target, check) {
      if (
        disposed
        || current === null
        || current.phase === 'resolved_elsewhere'
        || !sameTarget(current, target)
      ) return null;
      const triage = triageFromProjection(
        current.baselineVersion,
        projectReleaseCheck(check),
      );
      const {
        serverUpdateVerification: _verification,
        ...rest
      } = current;
      current = {
        ...rest,
        phase: 'triage',
        serverUpdateTriage: triage,
      };
      sawDisconnect = false;
      durable = persist();
      emit();
      return { ...triage };
    },
    markAwaitingReconnect(target, runningVersion) {
      if (
        disposed
        || current === null
        || current.phase === 'ready'
        || current.phase === 'resolved_elsewhere'
        || !sameTarget(current, target)
      ) return;
      sawDisconnect = options.status() !== 'connected';
      const { serverUpdateTriage: _triage, ...rest } = current;
      current = {
        ...rest,
        phase: 'awaiting_reconnect',
        ...(isValidVersion(runningVersion)
          ? { baselineVersion: runningVersion }
          : {}),
      };
      durable = persist();
      emit();
    },
    markCapabilityResolvedElsewhere(target) {
      if (
        disposed
        || current === null
        || current.phase !== 'triage'
        || !sameTarget(current, target)
      ) return false;
      current = {
        kind: current.kind,
        name: current.name,
        phase: 'resolved_elsewhere',
        startedAt: current.startedAt,
      };
      sawDisconnect = false;
      durable = false;
      if (persistenceEnabled) inertThenRemove(storage!);
      emit();
      return true;
    },
    resumeResolvedRetry(target) {
      if (
        disposed
        || current === null
        || current.phase !== 'resolved_elsewhere'
        || !sameTarget(current, target)
      ) return false;
      current = {
        ...current,
        phase: 'ready',
      };
      sawDisconnect = false;
      durable = persist();
      emit();
      return true;
    },
    beginExactReturn(target) {
      if (
        disposed
        || current === null
        || !sameTarget(current, target)
        || current.serverUpdateProgress !== undefined
      ) return false;
      const {
        serverUpdateTriage: _triage,
        serverUpdateVerification: _verification,
        exactReturnActive: _active,
        ...rest
      } = current;
      current = {
        ...rest,
        phase: 'checking_return',
        exactReturnActive: true,
      };
      sawDisconnect = false;
      durable = persist();
      emit();
      return true;
    },
    interruptExactReturn(target) {
      if (
        disposed
        || current === null
        || current.exactReturnActive !== true
        || !sameTarget(current, target)
      ) return;
      const { exactReturnActive: _active, ...rest } = current;
      current = rest;
      durable = persist();
      emit();
    },
    markExactEditorReady(target) {
      if (
        disposed
        || current === null
        || current.phase !== 'checking_return'
        || current.exactReturnActive !== true
        || current.serverUpdateProgress !== undefined
        || !sameTarget(current, target)
      ) return false;
      current = {
        kind: current.kind,
        name: current.name,
        phase: 'editor_ready',
        startedAt: current.startedAt,
      };
      sawDisconnect = false;
      durable = persist();
      emit();
      return true;
    },
    observeServerUpdateProgress(progress) {
      if (disposed || current === null) return;
      const prior = current.serverUpdateProgress ?? null;
      if (
        prior === null
          ? progress === null
          : progress !== null
            && prior.phase === progress.phase
            && prior.operation === progress.operation
            && prior.startedAt === progress.startedAt
            && prior.operationId === progress.operationId
      ) return;
      if (progress === null) {
        const {
          serverUpdateProgress: _progress,
          serverUpdateVerification: _verification,
          ...rest
        } = current;
        current = current.serverUpdateVerification?.phase === 'completed'
          ? {
              ...rest,
              serverUpdateVerification: snapshotVerification(
                current.serverUpdateVerification,
              ),
            }
          : rest;
      } else {
        const { serverUpdateVerification: _verification, ...rest } = current;
        current = {
          ...rest,
          serverUpdateProgress: { ...progress },
        };
      }
      emit();
    },
    observeServerUpdateVerification(next) {
      if (disposed || current === null) return;
      const prior = current.serverUpdateVerification ?? null;
      if (next === null) {
        if (prior === null) return;
        const { serverUpdateVerification: _verification, ...rest } = current;
        current = rest;
        emit();
        return;
      }
      if (next.phase === 'completed') {
        // Completion is a one-shot orientation receipt for entering the exact
        // return. Once that route owns the handoff, a late controller emission
        // cannot turn the interrupted/resumable phase back into a replayable
        // success receipt.
        if (
          current.exactReturnActive === true
          || current.phase === 'editor_ready'
        ) return;
        const affected = next.baseline?.affectedConnection;
        const progress = current.serverUpdateProgress;
        if (
          affected === undefined
          || affected.kind !== current.kind
          || affected.name !== current.name
          || (
            progress !== undefined
            && (
              prior?.phase !== 'finishing'
              || prior.operation !== next.operation
              || prior.startedAt !== next.startedAt
              || progress.operation !== next.operation
              || progress.startedAt !== next.startedAt
            )
          )
        ) return;
        if (
          prior !== null
          && prior.phase === next.phase
          && prior.operation === next.operation
          && prior.startedAt === next.startedAt
          && prior.reason === next.reason
          && JSON.stringify(prior.baseline) === JSON.stringify(next.baseline)
        ) return;
        const {
          serverUpdateProgress: _progress,
          serverUpdateTriage: _triage,
          ...rest
        } = current;
        current = {
          ...rest,
          phase: 'ready',
          serverUpdateVerification: snapshotVerification(next),
        };
        sawDisconnect = false;
        durable = persist();
        emit();
        return;
      }
      const progress = current.serverUpdateProgress;
      if (
        progress?.phase !== 'awaiting_reconnect'
        || progress.operation !== next.operation
        || progress.startedAt !== next.startedAt
      ) return;
      if (
        prior !== null
        && prior.phase === next.phase
        && prior.operation === next.operation
        && prior.startedAt === next.startedAt
        && prior.reason === next.reason
        && JSON.stringify(prior.baseline) === JSON.stringify(next.baseline)
      ) return;
      current = {
        ...current,
        serverUpdateVerification: snapshotVerification(next),
      };
      emit();
    },
    retire(target) {
      if (
        disposed
        || current === null
        || (target !== undefined && !sameTarget(current, target))
      ) return;
      current = null;
      sawDisconnect = false;
      durable = false;
      if (persistenceEnabled) inertThenRemove(storage!);
      emit();
    },
    subscribe(listener) {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      detachStatus();
      listeners.clear();
    },
  };
};
