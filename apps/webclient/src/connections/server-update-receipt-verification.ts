/** Authoritative, privacy-safe recovery for a restored server-update receipt.
 *
 * A cold/reloaded tab cannot prove an update or rollback merely because its
 * socket connected. It asks the selected server to resolve the exact opaque
 * ledger receipt, retries temporary uncertainty a bounded number of times, and
 * keeps controls paused unless that exact operation reaches a terminal state.
 * Presentation subscribers receive only an allowlisted state: the receipt and
 * raw transport/server errors never leave this controller.
 */

import type {
  ConnectionCredentialRotationActivity,
  ConnectionKind,
  ReleaseCheckResponse,
  ReleaseCheckStatus,
  UpdateOperationClosureResponse,
  UpdateOperationStatusResponse,
} from '@recued/contracts';
import type { ServerUpdateReceiptVerificationState } from '@recued/ui-shared';

import type {
  ServerUpdateTabProgress,
} from './credential-rotation-tab-convergence.js';

export type ServerUpdateReceiptVerificationScheduler = (
  callback: () => void,
  delayMs: number,
) => () => void;

export interface ServerUpdateCurrentStateRead {
  release: ReleaseCheckResponse;
  affectedConnection?: {
    kind: ConnectionKind;
    name: string;
    activity: ConnectionCredentialRotationActivity['status'] | 'unavailable';
  };
}

export interface ServerUpdateReceiptVerificationController {
  read(): ServerUpdateReceiptVerificationState | null;
  /** Re-read current connectivity/progress and start or resume verification. */
  reconcile(): void;
  /** Explicit owner retry. Starts a fresh bounded retry sequence. */
  retry(): void;
  /** Open/cancel the explicit review gate for a server-authored closure. */
  reviewClosure(): void;
  cancelClosureReview(): void;
  /** Ask the selected server to durably close an unresolved receipt. */
  closeUnresolved(): void;
  /** Advance a durable closure through a fresh current-state read, explicit
   * review, and finally retirement of the exact browser latch. */
  finishClosure(): void;
  /** Consume the one-shot, memory-only completion confirmation. */
  dismissCompletion(): void;
  subscribe(
    listener: (
      state: ServerUpdateReceiptVerificationState | null,
    ) => void,
  ): () => void;
  dispose(): void;
}

export interface ServerUpdateReceiptVerificationOptions {
  readProgress(): ServerUpdateTabProgress | null;
  isConnected(): boolean;
  verify(operationId: string): Promise<UpdateOperationStatusResponse>;
  close(
    operationId: string,
    expectedOperation: 'update' | 'rollback',
  ): Promise<UpdateOperationClosureResponse>;
  readCurrentState?(
    progress: ServerUpdateTabProgress,
  ): Promise<ServerUpdateCurrentStateRead>;
  clearProgress(progress: ServerUpdateTabProgress): Promise<boolean>;
  scheduleRetry?: ServerUpdateReceiptVerificationScheduler;
  retryDelayMs?: number;
  maxAutomaticAttempts?: number;
}

const diagnosticLine = (value: string): string => value
  .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
  .replace(/\s+/gu, ' ')
  .trim()
  .slice(0, 240);

const diagnosticServerHost = (serverUrl: string | null | undefined): string => {
  if (serverUrl === null || serverUrl === undefined) return 'unavailable';
  try {
    return diagnosticLine(new URL(serverUrl).host) || 'unavailable';
  } catch {
    return 'unavailable';
  }
};

/** Copyable administrator handoff for an unresolved receipt. It includes
 * only owner-visible identity and the allowlisted verifier result. */
export const buildServerUpdateReceiptDiagnostic = (options: {
  serverUrl?: string | null;
  profileLabel?: string | null;
  connectionIdentity?: string | null;
  verification: ServerUpdateReceiptVerificationState;
}): string => {
  const result = options.verification.phase === 'completed'
    ? 'current server state confirmed and browser recovery latch retired'
    : options.verification.reason === 'operation_mismatch'
    ? 'receipt resolved to a different operation'
    : options.verification.reason === 'unknown_receipt'
      ? 'selected server did not recognize receipt'
      : options.verification.reason === 'closure_in_flight'
        ? 'server refused closure while a release transition was active'
        : options.verification.reason === 'closure_unavailable'
          ? 'server-authoritative closure was unavailable'
          : options.verification.reason === 'baseline_unavailable'
            ? 'current server state could not be read after closure'
            : options.verification.reason === 'finish_unavailable'
              ? 'browser recovery latch could not be retired'
              : options.verification.reason === 'restart_pending'
                ? 'restart remained pending after bounded checks'
                : options.verification.reason === 'temporary_failure'
                  ? 'receipt status could not be read after bounded checks'
                  : 'receipt verification is incomplete';
  return [
    'Recued server update receipt diagnostic',
    ...(options.connectionIdentity === undefined
      || options.connectionIdentity === null
      ? []
      : [`Connection: ${diagnosticLine(options.connectionIdentity)}`]),
    `Selected profile: ${diagnosticLine(options.profileLabel ?? '') || 'unnamed'}`,
    `Server host: ${diagnosticServerHost(options.serverUrl)}`,
    `Expected operation: ${options.verification.operation}`,
    `Verification result: ${result}`,
    options.verification.phase === 'completed'
      ? 'Safety state: server controls are unlocked; original operation outcome remains unknown'
      : options.verification.phase === 'closed'
      || options.verification.phase === 'checking_baseline'
      || options.verification.phase === 'baseline_retryable'
      || options.verification.phase === 'baseline_confirmed'
      ? 'Safety state: server recorded unresolved closure; controls await a reviewed current-state baseline'
      : 'Safety state: server controls remain paused',
  ].join('\n');
};

const DEFAULT_RETRY_DELAY_MS = 2_500;
const DEFAULT_MAX_AUTOMATIC_ATTEMPTS = 3;
const MAX_BASELINE_VERSION_LENGTH = 128;
const MAX_BASELINE_CONNECTION_NAME_LENGTH = 128;
const RELEASE_CHECK_STATUSES: ReadonlySet<ReleaseCheckStatus> = new Set([
  'update-available',
  'up-to-date',
  'stale-feed',
  'launcher-outdated',
  'replay',
  'fetch-failed',
  'bad-signature',
  'not-configured',
]);
const CONNECTION_KINDS: ReadonlySet<ConnectionKind> = new Set([
  'api',
  'mcp',
  'notification',
]);

const defaultScheduleRetry: ServerUpdateReceiptVerificationScheduler = (
  callback,
  delayMs,
) => {
  const handle = globalThis.setTimeout(callback, delayMs);
  return () => globalThis.clearTimeout(handle);
};

const exactProgress = (
  left: ServerUpdateTabProgress | null,
  right: ServerUpdateTabProgress,
): boolean => left !== null
  && left.phase === right.phase
  && left.operation === right.operation
  && left.startedAt === right.startedAt
  && left.operationId === right.operationId;

const verificationKey = (
  progress: ServerUpdateTabProgress,
): string | null => progress.phase === 'awaiting_reconnect'
  && progress.operationId !== undefined
  ? JSON.stringify([
      progress.operation,
      progress.startedAt,
      progress.operationId,
    ])
  : null;

const sameState = (
  left: ServerUpdateReceiptVerificationState | null,
  right: ServerUpdateReceiptVerificationState | null,
): boolean => left === null
  ? right === null
  : right !== null
    && left.phase === right.phase
    && left.operation === right.operation
    && left.startedAt === right.startedAt
    && left.reason === right.reason
    && (
      left.baseline === undefined
        ? right.baseline === undefined
        : right.baseline !== undefined
          && left.baseline.currentVersion === right.baseline.currentVersion
          && left.baseline.channel === right.baseline.channel
          && left.baseline.updateStatus === right.baseline.updateStatus
          && (
            left.baseline.affectedConnection === undefined
              ? right.baseline.affectedConnection === undefined
              : right.baseline.affectedConnection !== undefined
                && left.baseline.affectedConnection.kind
                  === right.baseline.affectedConnection.kind
                && left.baseline.affectedConnection.name
                  === right.baseline.affectedConnection.name
                && left.baseline.affectedConnection.activity
                  === right.baseline.affectedConnection.activity
          )
    );

const projectCurrentStateBaseline = (
  value: ServerUpdateCurrentStateRead,
): NonNullable<ServerUpdateReceiptVerificationState['baseline']> | null => {
  const version = value.release.current_version;
  if (
    typeof version !== 'string'
    || version.length === 0
    || version.length > MAX_BASELINE_VERSION_LENGTH
    || (
      value.release.channel !== 'stable'
      && value.release.channel !== 'edge'
    )
    || !RELEASE_CHECK_STATUSES.has(value.release.status)
  ) return null;
  const affected = value.affectedConnection;
  if (
    affected !== undefined
    && (
      !CONNECTION_KINDS.has(affected.kind)
      || typeof affected.name !== 'string'
      || affected.name.length === 0
      || affected.name.length > MAX_BASELINE_CONNECTION_NAME_LENGTH
      || (
        affected.activity !== 'idle'
        && affected.activity !== 'pending'
        && affected.activity !== 'unavailable'
      )
    )
  ) return null;
  return {
    currentVersion: version,
    channel: value.release.channel,
    updateStatus: value.release.status,
    ...(affected === undefined
      ? {}
      : {
          affectedConnection: {
            kind: affected.kind,
            name: affected.name,
            activity: affected.activity,
          },
        }),
  };
};

export const createServerUpdateReceiptVerification = (
  options: ServerUpdateReceiptVerificationOptions,
): ServerUpdateReceiptVerificationController => {
  const scheduleRetry = options.scheduleRetry ?? defaultScheduleRetry;
  const retryDelayMs =
    options.retryDelayMs !== undefined
    && Number.isFinite(options.retryDelayMs)
    && options.retryDelayMs >= 0
      ? options.retryDelayMs
      : DEFAULT_RETRY_DELAY_MS;
  const maxAutomaticAttempts =
    options.maxAutomaticAttempts !== undefined
    && Number.isSafeInteger(options.maxAutomaticAttempts)
    && options.maxAutomaticAttempts > 0
      ? options.maxAutomaticAttempts
      : DEFAULT_MAX_AUTOMATIC_ATTEMPTS;

  let disposed = false;
  let state: ServerUpdateReceiptVerificationState | null = null;
  let lineageKey: string | null = null;
  let attempts = 0;
  let generation = 0;
  let inFlightKey: string | null = null;
  let cancelRetry: (() => void) | null = null;
  let pendingFinish: {
    expected: ServerUpdateTabProgress;
    baseline: NonNullable<
      ServerUpdateReceiptVerificationState['baseline']
    >;
  } | null = null;
  const listeners = new Set<(
    next: ServerUpdateReceiptVerificationState | null,
  ) => void>();

  const snapshot = (): ServerUpdateReceiptVerificationState | null =>
    state === null
      ? null
      : {
          ...state,
          ...(state.baseline === undefined
            ? {}
            : {
                baseline: {
                  currentVersion: state.baseline.currentVersion,
                  channel: state.baseline.channel,
                  updateStatus: state.baseline.updateStatus,
                  ...(state.baseline.affectedConnection === undefined
                    ? {}
                    : {
                        affectedConnection: {
                          kind: state.baseline.affectedConnection.kind,
                          name: state.baseline.affectedConnection.name,
                          activity:
                            state.baseline.affectedConnection.activity,
                        },
                      }),
                },
              }),
        };

  const emit = (): void => {
    const next = snapshot();
    for (const listener of [...listeners]) {
      try {
        listener(next);
      } catch {
        // One presentation subscriber cannot break authoritative recovery.
      }
    }
  };

  const setState = (
    next: ServerUpdateReceiptVerificationState | null,
  ): void => {
    if (sameState(state, next)) return;
    state = next === null ? null : { ...next };
    emit();
  };

  const cancelScheduledRetry = (): void => {
    const cancel = cancelRetry;
    cancelRetry = null;
    if (cancel === null) return;
    try {
      cancel();
    } catch {
      // A hostile timer seam cannot make a stale callback authoritative.
    }
  };

  const resetLineage = (nextKey: string | null): void => {
    cancelScheduledRetry();
    generation += 1;
    inFlightKey = null;
    pendingFinish = null;
    lineageKey = nextKey;
    attempts = 0;
    setState(null);
  };

  const completePendingFinish = (): void => {
    const pending = pendingFinish;
    if (pending === null) return;
    cancelScheduledRetry();
    generation += 1;
    inFlightKey = null;
    pendingFinish = null;
    lineageKey = null;
    attempts = 0;
    setState({
      phase: 'completed',
      operation: pending.expected.operation,
      startedAt: pending.expected.startedAt,
      reason: 'server_closed_unresolved',
      baseline: pending.baseline,
    });
  };

  const currentEligibleProgress = (): ServerUpdateTabProgress | null => {
    const progress = options.readProgress();
    if (progress === null) return null;
    return verificationKey(progress) === null ? null : progress;
  };

  const matchesCurrentLineage = (
    progress: ServerUpdateTabProgress,
  ): boolean => lineageKey !== null
    && verificationKey(progress) === lineageKey;

  let startCheck: (progress: ServerUpdateTabProgress) => void;

  const setUnknown = (
    progress: ServerUpdateTabProgress,
    reason:
      | 'unknown_receipt'
      | 'operation_mismatch'
      | 'closure_in_flight'
      | 'closure_unavailable',
  ): void => {
    setState({
      phase: 'unknown',
      operation: progress.operation,
      startedAt: progress.startedAt,
      reason,
    });
  };

  const clearTerminalProgress = async (
    expected: ServerUpdateTabProgress,
    requestGeneration: number,
  ): Promise<void> => {
    const cleared = await options.clearProgress(expected);
    if (
      disposed
      || requestGeneration !== generation
    ) return;
    if (!exactProgress(options.readProgress(), expected)) {
      const latest = currentEligibleProgress();
      resetLineage(latest === null ? null : verificationKey(latest));
      if (latest !== null && options.isConnected()) startCheck(latest);
      return;
    }
    if (cleared === false) {
      waitOrRequireRetry(expected, 'temporary_failure');
    }
  };

  const waitOrRequireRetry = (
    progress: ServerUpdateTabProgress,
    reason: 'restart_pending' | 'temporary_failure',
  ): void => {
    if (
      disposed
      || !exactProgress(options.readProgress(), progress)
    ) {
      return;
    }
    if (attempts >= maxAutomaticAttempts) {
      cancelScheduledRetry();
      setState({
        phase: 'retryable',
        operation: progress.operation,
        startedAt: progress.startedAt,
        reason,
      });
      return;
    }
    setState({
      phase: 'waiting',
      operation: progress.operation,
      startedAt: progress.startedAt,
      reason,
    });
    cancelScheduledRetry();
    try {
      cancelRetry = scheduleRetry(() => {
        cancelRetry = null;
        if (
          disposed
          || !options.isConnected()
          || !exactProgress(options.readProgress(), progress)
        ) return;
        startCheck(progress);
      }, retryDelayMs);
    } catch {
      cancelRetry = null;
      setState({
        phase: 'retryable',
        operation: progress.operation,
        startedAt: progress.startedAt,
        reason: 'temporary_failure',
      });
    }
  };

  startCheck = (progress) => {
    const key = verificationKey(progress);
    if (
      disposed
      || key === null
      || !options.isConnected()
      || inFlightKey === key
      || !exactProgress(options.readProgress(), progress)
    ) return;
    if (lineageKey !== key) resetLineage(key);
    cancelScheduledRetry();
    attempts += 1;
    const checkGeneration = ++generation;
    inFlightKey = key;
    const expected = { ...progress };
    setState({
      phase: 'checking',
      operation: progress.operation,
      startedAt: progress.startedAt,
    });

    let request: Promise<UpdateOperationStatusResponse>;
    try {
      request = options.verify(progress.operationId!);
    } catch {
      inFlightKey = null;
      waitOrRequireRetry(expected, 'temporary_failure');
      return;
    }

    void request.then(async (outcome) => {
      if (
        disposed
        || checkGeneration !== generation
        || !exactProgress(options.readProgress(), expected)
      ) return;
      if (outcome.status === 'unknown') {
        setUnknown(expected, 'unknown_receipt');
        return;
      }
      if (outcome.operation !== expected.operation) {
        setUnknown(expected, 'operation_mismatch');
        return;
      }
      if (outcome.status === 'closed_unresolved') {
        setState({
          phase: 'closed',
          operation: expected.operation,
          startedAt: expected.startedAt,
          reason: 'server_closed_unresolved',
        });
        return;
      }
      if (outcome.status === 'waiting_for_restart') {
        waitOrRequireRetry(expected, 'restart_pending');
        return;
      }
      await clearTerminalProgress(expected, checkGeneration);
    }).catch(() => {
      if (
        disposed
        || checkGeneration !== generation
        || !exactProgress(options.readProgress(), expected)
      ) return;
      waitOrRequireRetry(expected, 'temporary_failure');
    }).finally(() => {
      if (inFlightKey === key && checkGeneration === generation) {
        inFlightKey = null;
      }
    });
  };

  const reconcile = (): void => {
    if (disposed) return;
    const progress = currentEligibleProgress();
    const key = progress === null ? null : verificationKey(progress);
    if (
      progress === null
      && state?.phase === 'finishing'
      && pendingFinish !== null
    ) {
      completePendingFinish();
      return;
    }
    if (progress === null && state?.phase === 'completed') return;
    if (key !== lineageKey) resetLineage(key);
    if (progress === null || !options.isConnected()) return;
    if (inFlightKey === key || cancelRetry !== null) return;
    if (
      state?.phase === 'retryable'
      || state?.phase === 'unknown'
      || state?.phase === 'reviewing_closure'
      || state?.phase === 'closing'
      || state?.phase === 'closed'
      || state?.phase === 'checking_baseline'
      || state?.phase === 'baseline_retryable'
      || state?.phase === 'baseline_confirmed'
      || state?.phase === 'finishing'
    ) return;
    startCheck(progress);
  };

  return {
    read: snapshot,
    reconcile,
    retry() {
      if (disposed) return;
      if (
        state?.phase === 'reviewing_closure'
        || state?.phase === 'closing'
        || state?.phase === 'closed'
        || state?.phase === 'checking_baseline'
        || state?.phase === 'baseline_retryable'
        || state?.phase === 'baseline_confirmed'
        || state?.phase === 'finishing'
      ) return;
      const progress = currentEligibleProgress();
      if (progress === null || !options.isConnected()) return;
      const key = verificationKey(progress);
      if (key === null) return;
      cancelScheduledRetry();
      generation += 1;
      inFlightKey = null;
      lineageKey = key;
      attempts = 0;
      startCheck(progress);
    },
    reviewClosure() {
      if (
        disposed
        || state?.phase !== 'unknown'
        || state.reason !== 'unknown_receipt'
      ) return;
      const progress = currentEligibleProgress();
      if (
        progress === null
        || !matchesCurrentLineage(progress)
        || progress.operation !== state.operation
        || progress.startedAt !== state.startedAt
      ) return;
      cancelScheduledRetry();
      setState({
        phase: 'reviewing_closure',
        operation: progress.operation,
        startedAt: progress.startedAt,
        reason: 'unknown_receipt',
      });
    },
    cancelClosureReview() {
      if (disposed || state?.phase !== 'reviewing_closure') return;
      const progress = currentEligibleProgress();
      if (
        progress === null
        || !matchesCurrentLineage(progress)
        || progress.operation !== state.operation
        || progress.startedAt !== state.startedAt
      ) return;
      setUnknown(progress, 'unknown_receipt');
    },
    closeUnresolved() {
      if (
        disposed
        || state?.phase !== 'reviewing_closure'
        || !options.isConnected()
      ) return;
      const progress = currentEligibleProgress();
      if (
        progress === null
        || !matchesCurrentLineage(progress)
        || progress.operation !== state.operation
        || progress.startedAt !== state.startedAt
      ) return;
      const key = verificationKey(progress);
      if (key === null || inFlightKey === key) return;
      cancelScheduledRetry();
      const closeGeneration = ++generation;
      inFlightKey = key;
      const expected = { ...progress };
      setState({
        phase: 'closing',
        operation: progress.operation,
        startedAt: progress.startedAt,
      });

      let request: Promise<UpdateOperationClosureResponse>;
      try {
        request = options.close(progress.operationId!, progress.operation);
      } catch {
        inFlightKey = null;
        setUnknown(expected, 'closure_unavailable');
        return;
      }
      void request.then(async (outcome) => {
        if (
          disposed
          || closeGeneration !== generation
          || !exactProgress(options.readProgress(), expected)
        ) return;
        if (outcome.status === 'refused') {
          setUnknown(
            expected,
            outcome.reason === 'operation_in_flight'
              ? 'closure_in_flight'
              : 'closure_unavailable',
          );
          return;
        }
        if (outcome.status === 'unknown') {
          setUnknown(expected, 'unknown_receipt');
          return;
        }
        if (outcome.operation !== expected.operation) {
          setUnknown(expected, 'operation_mismatch');
          return;
        }
        if (outcome.status === 'closed_unresolved') {
          setState({
            phase: 'closed',
            operation: expected.operation,
            startedAt: expected.startedAt,
            reason: 'server_closed_unresolved',
          });
          return;
        }
        if (outcome.status === 'waiting_for_restart') {
          waitOrRequireRetry(expected, 'restart_pending');
          return;
        }
        await clearTerminalProgress(expected, closeGeneration);
      }).catch(() => {
        if (
          disposed
          || closeGeneration !== generation
          || !exactProgress(options.readProgress(), expected)
        ) return;
        setUnknown(expected, 'closure_unavailable');
      }).finally(() => {
        if (inFlightKey === key && closeGeneration === generation) {
          inFlightKey = null;
        }
      });
    },
    finishClosure() {
      if (
        disposed
        || (
          state?.phase !== 'closed'
          && state?.phase !== 'baseline_retryable'
          && state?.phase !== 'baseline_confirmed'
        )
      ) return;
      const progress = currentEligibleProgress();
      if (
        progress === null
        || !matchesCurrentLineage(progress)
        || progress.operation !== state.operation
        || progress.startedAt !== state.startedAt
      ) return;
      cancelScheduledRetry();
      const expected = { ...progress };
      if (state.phase !== 'baseline_confirmed') {
        if (!options.isConnected()) return;
        const key = verificationKey(expected);
        if (key === null || inFlightKey === key) return;
        const readCurrentState = options.readCurrentState;
        if (readCurrentState === undefined) {
          setState({
            phase: 'baseline_retryable',
            operation: expected.operation,
            startedAt: expected.startedAt,
            reason: 'baseline_unavailable',
          });
          return;
        }
        const baselineGeneration = ++generation;
        inFlightKey = key;
        setState({
          phase: 'checking_baseline',
          operation: expected.operation,
          startedAt: expected.startedAt,
          reason: 'server_closed_unresolved',
        });
        let request: Promise<ServerUpdateCurrentStateRead>;
        try {
          request = readCurrentState(expected);
        } catch {
          inFlightKey = null;
          setState({
            phase: 'baseline_retryable',
            operation: expected.operation,
            startedAt: expected.startedAt,
            reason: 'baseline_unavailable',
          });
          return;
        }
        void request.then((result) => {
          if (
            disposed
            || baselineGeneration !== generation
            || !exactProgress(options.readProgress(), expected)
          ) return;
          const baseline = projectCurrentStateBaseline(result);
          if (baseline === null) {
            setState({
              phase: 'baseline_retryable',
              operation: expected.operation,
              startedAt: expected.startedAt,
              reason: 'baseline_unavailable',
            });
            return;
          }
          setState({
            phase: 'baseline_confirmed',
            operation: expected.operation,
            startedAt: expected.startedAt,
            reason: 'server_closed_unresolved',
            baseline,
          });
        }).catch(() => {
          if (
            disposed
            || baselineGeneration !== generation
            || !exactProgress(options.readProgress(), expected)
          ) return;
          setState({
            phase: 'baseline_retryable',
            operation: expected.operation,
            startedAt: expected.startedAt,
            reason: 'baseline_unavailable',
          });
        }).finally(() => {
          if (inFlightKey === key && baselineGeneration === generation) {
            inFlightKey = null;
          }
        });
        return;
      }
      const confirmedBaseline = state.baseline;
      if (confirmedBaseline === undefined) return;
      const finishGeneration = ++generation;
      pendingFinish = {
        expected,
        baseline: confirmedBaseline,
      };
      setState({
        phase: 'finishing',
        operation: expected.operation,
        startedAt: expected.startedAt,
        reason: 'server_closed_unresolved',
      });
      const settleFinish = (): void => {
        if (disposed || finishGeneration !== generation) return;
        if (!exactProgress(options.readProgress(), expected)) {
          const latest = currentEligibleProgress();
          if (latest === null) {
            completePendingFinish();
            return;
          }
          resetLineage(verificationKey(latest));
          if (options.isConnected()) startCheck(latest);
          return;
        }
        // A storage host that rejects, or reports success without retiring the
        // exact lineage, is not authoritative enough to hide the latch. Keep
        // the freshly read baseline visible so the owner can retry Finish
        // without turning a local failure into permission for a new mutation.
        setState({
          phase: 'baseline_confirmed',
          operation: expected.operation,
          startedAt: expected.startedAt,
          reason: 'finish_unavailable',
          baseline: confirmedBaseline,
        });
        pendingFinish = null;
      };
      let clearing: Promise<boolean>;
      try {
        clearing = options.clearProgress(expected);
      } catch {
        settleFinish();
        return;
      }
      void clearing.then(settleFinish, settleFinish);
    },
    dismissCompletion() {
      if (disposed || state?.phase !== 'completed') return;
      generation += 1;
      setState(null);
    },
    subscribe(listener) {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelScheduledRetry();
      generation += 1;
      inFlightKey = null;
      pendingFinish = null;
      lineageKey = null;
      state = null;
      listeners.clear();
    },
  };
};
