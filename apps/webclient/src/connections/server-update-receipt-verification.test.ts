import { describe, expect, it, vi } from 'vitest';

import type {
  UpdateOperationClosureResponse,
  UpdateOperationStatusResponse,
} from '@recued/contracts';

import type { ServerUpdateTabProgress } from './credential-rotation-tab-convergence.js';
import {
  buildServerUpdateReceiptDiagnostic,
  createServerUpdateReceiptVerification,
  type ServerUpdateCurrentStateRead,
  type ServerUpdateReceiptVerificationScheduler,
} from './server-update-receipt-verification.js';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

const schedulerHarness = () => {
  const pending: Array<() => void> = [];
  const schedule: ServerUpdateReceiptVerificationScheduler = (callback) => {
    let active = true;
    pending.push(() => {
      if (!active) return;
      active = false;
      callback();
    });
    return () => {
      active = false;
    };
  };
  return {
    schedule,
    runNext() {
      const callback = pending.shift();
      if (callback === undefined) throw new Error('no scheduled retry');
      callback();
    },
    get size() {
      return pending.length;
    },
  };
};

const receiptProgress = (
  overrides: Partial<ServerUpdateTabProgress> = {},
): ServerUpdateTabProgress => ({
  phase: 'awaiting_reconnect',
  operation: 'update',
  startedAt: 100,
  operationId: 'opaque-receipt-do-not-project',
  ...overrides,
});

const unsupportedClose = async (): Promise<UpdateOperationClosureResponse> => ({
  status: 'refused',
  reason: 'not_supported',
});

const currentState = async () => ({
  release: {
    status: 'up-to-date' as const,
    current_version: '26.8.1',
    channel: 'stable' as const,
  },
});

describe('server update receipt verification recovery', () => {
  it('builds an honest bounded-failure diagnostic without receipt or URL detail', () => {
    const diagnostic = buildServerUpdateReceiptDiagnostic({
      serverUrl: 'https://owner:secret@home.example:8443/private?token=secret',
      profileLabel: 'Home\nserver',
      connectionIdentity: 'api/github-main',
      verification: {
        phase: 'retryable',
        operation: 'rollback',
        startedAt: 100,
        reason: 'temporary_failure',
      },
    });

    expect(diagnostic).toContain('Selected profile: Home server');
    expect(diagnostic).toContain('Server host: home.example:8443');
    expect(diagnostic).toContain('Expected operation: rollback');
    expect(diagnostic).toContain(
      'receipt status could not be read after bounded checks',
    );
    expect(diagnostic).not.toMatch(
      /owner|secret|\/private|token=|opaque-receipt/i,
    );
  });

  it('retries a still-restarting receipt and clears only its exact terminal lineage', async () => {
    let progress: ServerUpdateTabProgress | null = receiptProgress();
    const timers = schedulerHarness();
    const verify = vi.fn<(
      operationId: string,
    ) => Promise<UpdateOperationStatusResponse>>()
      .mockResolvedValueOnce({
        status: 'waiting_for_restart',
        operation: 'update',
      })
      .mockResolvedValueOnce({
        status: 'completed',
        operation: 'update',
      });
    const clearProgress = vi.fn(async (expected: ServerUpdateTabProgress) => {
      if (
        progress?.startedAt === expected.startedAt
        && progress.operationId === expected.operationId
      ) {
        progress = null;
        return true;
      }
      return false;
    });
    const controller = createServerUpdateReceiptVerification({
      readProgress: () => progress,
      isConnected: () => true,
      verify,
      close: unsupportedClose,
      clearProgress,
      scheduleRetry: timers.schedule,
    });

    controller.reconcile();
    await flush();
    expect(controller.read()).toEqual({
      phase: 'waiting',
      operation: 'update',
      startedAt: 100,
      reason: 'restart_pending',
    });
    expect(timers.size).toBe(1);

    timers.runNext();
    await flush();
    expect(verify).toHaveBeenNthCalledWith(
      1,
      'opaque-receipt-do-not-project',
    );
    expect(verify).toHaveBeenNthCalledWith(
      2,
      'opaque-receipt-do-not-project',
    );
    expect(clearProgress).toHaveBeenCalledOnce();
    expect(progress).toBeNull();
    expect(controller.read()).toBeNull();
    controller.dispose();
  });

  it('bounds temporary retries, exposes no receipt/error, and lets an owner start a fresh retry sequence', async () => {
    let progress: ServerUpdateTabProgress | null = receiptProgress();
    const timers = schedulerHarness();
    const verify = vi.fn<(
      operationId: string,
    ) => Promise<UpdateOperationStatusResponse>>()
      .mockRejectedValue(new Error('raw transport secret'));
    const controller = createServerUpdateReceiptVerification({
      readProgress: () => progress,
      isConnected: () => true,
      verify,
      close: unsupportedClose,
      clearProgress: async () => false,
      scheduleRetry: timers.schedule,
      maxAutomaticAttempts: 3,
    });

    controller.reconcile();
    await flush();
    timers.runNext();
    await flush();
    timers.runNext();
    await flush();

    expect(verify).toHaveBeenCalledTimes(3);
    expect(controller.read()).toEqual({
      phase: 'retryable',
      operation: 'update',
      startedAt: 100,
      reason: 'temporary_failure',
    });
    expect(JSON.stringify(controller.read())).not.toMatch(
      /opaque-receipt|raw transport secret/i,
    );

    verify.mockReset();
    verify.mockResolvedValue({
      status: 'completed',
      operation: 'update',
    });
    controller.retry();
    await flush();
    expect(verify).toHaveBeenCalledOnce();
    // The stub deliberately refuses to clear: uncertainty remains paused and
    // enters a new bounded sequence instead of unlocking controls.
    expect(controller.read()?.phase).toBe('waiting');
    expect(progress).not.toBeNull();
    controller.dispose();
  });

  it('safe-stops unknown and mismatched receipts until an explicit retry', async () => {
    let progress: ServerUpdateTabProgress | null = receiptProgress();
    const timers = schedulerHarness();
    const verify = vi.fn<(
      operationId: string,
    ) => Promise<UpdateOperationStatusResponse>>()
      .mockResolvedValueOnce({ status: 'unknown' })
      .mockResolvedValueOnce({
        status: 'reverted',
        operation: 'rollback',
      })
      .mockResolvedValueOnce({
        status: 'completed',
        operation: 'update',
      });
    const controller = createServerUpdateReceiptVerification({
      readProgress: () => progress,
      isConnected: () => true,
      verify,
      close: unsupportedClose,
      clearProgress: async () => {
        progress = null;
        return true;
      },
      scheduleRetry: timers.schedule,
    });

    controller.reconcile();
    await flush();
    expect(controller.read()?.reason).toBe('unknown_receipt');
    expect(timers.size).toBe(0);

    controller.retry();
    await flush();
    expect(controller.read()?.reason).toBe('operation_mismatch');
    expect(timers.size).toBe(0);

    controller.retry();
    await flush();
    expect(progress).toBeNull();
    expect(controller.read()).toBeNull();
    controller.dispose();
  });

  it('does not send a scheduled retry offline and resumes on reconnect', async () => {
    let connected = true;
    const progress = receiptProgress();
    const timers = schedulerHarness();
    const verify = vi.fn(async (): Promise<UpdateOperationStatusResponse> => ({
      status: 'waiting_for_restart',
      operation: 'update',
    }));
    const controller = createServerUpdateReceiptVerification({
      readProgress: () => progress,
      isConnected: () => connected,
      verify,
      close: unsupportedClose,
      clearProgress: async () => false,
      scheduleRetry: timers.schedule,
    });

    controller.reconcile();
    await flush();
    connected = false;
    timers.runNext();
    await flush();
    expect(verify).toHaveBeenCalledOnce();
    expect(controller.read()?.phase).toBe('waiting');

    connected = true;
    controller.reconcile();
    await flush();
    expect(verify).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it('falls back to explicit retry when the host cannot schedule safely', async () => {
    const progress = receiptProgress();
    const controller = createServerUpdateReceiptVerification({
      readProgress: () => progress,
      isConnected: () => true,
      verify: async () => ({
        status: 'waiting_for_restart',
        operation: 'update',
      }),
      close: unsupportedClose,
      clearProgress: async () => false,
      scheduleRetry: () => {
        throw new Error('timer unavailable');
      },
    });

    controller.reconcile();
    await flush();
    expect(controller.read()).toEqual({
      phase: 'retryable',
      operation: 'update',
      startedAt: 100,
      reason: 'temporary_failure',
    });
    controller.dispose();
  });

  it('requires review, confirms current state, then retires only the exact latch', async () => {
    let progress: ServerUpdateTabProgress | null = receiptProgress();
    const close = vi.fn(async (): Promise<UpdateOperationClosureResponse> => ({
      status: 'closed_unresolved',
      operation: 'update',
    }));
    const clearProgress = vi.fn(async (expected: ServerUpdateTabProgress) => {
      if (progress?.operationId !== expected.operationId) return false;
      progress = null;
      return true;
    });
    const controller = createServerUpdateReceiptVerification({
      readProgress: () => progress,
      isConnected: () => true,
      verify: async () => ({ status: 'unknown' }),
      close,
      readCurrentState: async () => ({
        release: {
          status: 'fetch-failed',
          current_version: '26.8.1',
          channel: 'stable',
        },
        affectedConnection: {
          kind: 'api',
          name: 'github-main',
          activity: 'idle',
        },
      }),
      clearProgress,
    });

    controller.reconcile();
    await flush();
    controller.closeUnresolved();
    await flush();
    expect(close).not.toHaveBeenCalled();
    expect(controller.read()?.phase).toBe('unknown');

    progress = receiptProgress({ operationId: 'newer-same-metadata-receipt' });
    controller.reviewClosure();
    expect(controller.read()?.phase).toBe('unknown');
    expect(close).not.toHaveBeenCalled();

    progress = receiptProgress();
    controller.reviewClosure();
    expect(controller.read()).toEqual({
      phase: 'reviewing_closure',
      operation: 'update',
      startedAt: 100,
      reason: 'unknown_receipt',
    });
    controller.closeUnresolved();
    await flush();
    expect(close).toHaveBeenCalledWith(
      'opaque-receipt-do-not-project',
      'update',
    );
    expect(controller.read()).toEqual({
      phase: 'closed',
      operation: 'update',
      startedAt: 100,
      reason: 'server_closed_unresolved',
    });
    expect(progress).not.toBeNull();
    expect(clearProgress).not.toHaveBeenCalled();

    progress = receiptProgress({ operationId: 'newer-same-metadata-receipt' });
    controller.finishClosure();
    await flush();
    expect(clearProgress).not.toHaveBeenCalled();
    expect(controller.read()?.phase).toBe('closed');

    progress = receiptProgress();
    controller.reconcile();
    await flush();
    expect(controller.read()?.phase).toBe('closed');
    controller.finishClosure();
    await flush();
    expect(clearProgress).not.toHaveBeenCalled();
    expect(controller.read()).toEqual({
      phase: 'baseline_confirmed',
      operation: 'update',
      startedAt: 100,
      reason: 'server_closed_unresolved',
      baseline: {
        currentVersion: '26.8.1',
        channel: 'stable',
        updateStatus: 'fetch-failed',
        affectedConnection: {
          kind: 'api',
          name: 'github-main',
          activity: 'idle',
        },
      },
    });
    expect(progress).not.toBeNull();

    controller.finishClosure();
    await flush();
    expect(clearProgress).toHaveBeenCalledOnce();
    expect(progress).toBeNull();
    expect(controller.read()).toEqual({
      phase: 'completed',
      operation: 'update',
      startedAt: 100,
      reason: 'server_closed_unresolved',
      baseline: {
        currentVersion: '26.8.1',
        channel: 'stable',
        updateStatus: 'fetch-failed',
        affectedConnection: {
          kind: 'api',
          name: 'github-main',
          activity: 'idle',
        },
      },
    });
    controller.reconcile();
    expect(controller.read()?.phase).toBe('completed');
    controller.dismissCompletion();
    expect(controller.read()).toBeNull();
    controller.dispose();
  });

  it('confirms a finish whose storage host clears the lineage before rejecting', async () => {
    let progress: ServerUpdateTabProgress | null = receiptProgress();
    const controller = createServerUpdateReceiptVerification({
      readProgress: () => progress,
      isConnected: () => true,
      verify: async () => ({
        status: 'closed_unresolved',
        operation: 'update',
      }),
      close: unsupportedClose,
      readCurrentState: currentState,
      clearProgress: async () => {
        progress = null;
        throw new Error('post-write storage failure');
      },
    });

    controller.reconcile();
    await flush();
    expect(controller.read()?.phase).toBe('closed');
    controller.finishClosure();
    await flush();
    expect(controller.read()?.phase).toBe('baseline_confirmed');
    controller.finishClosure();
    await flush();
    expect(progress).toBeNull();
    expect(controller.read()).toMatchObject({
      phase: 'completed',
      baseline: {
        currentVersion: '26.8.1',
        channel: 'stable',
        updateStatus: 'up-to-date',
      },
    });
    controller.dispose();
  });

  it('keeps finish recovery actionable when the storage host throws synchronously', async () => {
    const progress = receiptProgress();
    const controller = createServerUpdateReceiptVerification({
      readProgress: () => progress,
      isConnected: () => true,
      verify: async () => ({
        status: 'closed_unresolved',
        operation: 'update',
      }),
      close: unsupportedClose,
      readCurrentState: currentState,
      clearProgress: () => {
        throw new Error('synchronous storage denial');
      },
    });

    controller.reconcile();
    await flush();
    controller.finishClosure();
    await flush();
    controller.finishClosure();

    expect(controller.read()).toMatchObject({
      phase: 'baseline_confirmed',
      reason: 'finish_unavailable',
      baseline: {
        currentVersion: '26.8.1',
      },
    });
    controller.dispose();
  });

  it('does not replay completion in a passive tab whose latch disappears', async () => {
    let progress: ServerUpdateTabProgress | null = receiptProgress();
    const controller = createServerUpdateReceiptVerification({
      readProgress: () => progress,
      isConnected: () => true,
      verify: async () => ({
        status: 'closed_unresolved',
        operation: 'update',
      }),
      close: unsupportedClose,
      readCurrentState: currentState,
      clearProgress: async () => false,
    });

    controller.reconcile();
    await flush();
    controller.finishClosure();
    await flush();
    expect(controller.read()?.phase).toBe('baseline_confirmed');

    // A sibling clears the shared latch. This tab did not perform the final
    // retirement gesture, so it unlocks silently instead of replaying a
    // completion receipt.
    progress = null;
    controller.reconcile();
    expect(controller.read()).toBeNull();
    controller.dispose();
  });

  it('does not attach an older completion to a newer server action', async () => {
    let progress: ServerUpdateTabProgress | null = receiptProgress();
    let settleClear!: () => void;
    const clearPending = new Promise<boolean>((resolve) => {
      settleClear = () => resolve(true);
    });
    const controller = createServerUpdateReceiptVerification({
      readProgress: () => progress,
      isConnected: () => true,
      verify: async () => ({
        status: 'closed_unresolved',
        operation: progress?.operation ?? 'update',
      }),
      close: unsupportedClose,
      readCurrentState: currentState,
      clearProgress: async () => clearPending,
    });

    controller.reconcile();
    await flush();
    controller.finishClosure();
    await flush();
    controller.finishClosure();
    expect(controller.read()?.phase).toBe('finishing');

    progress = receiptProgress({
      operation: 'rollback',
      startedAt: 200,
      operationId: 'newer-server-action',
    });
    settleClear();
    await flush();

    expect(controller.read()?.phase).toBe('closed');
    expect(controller.read()).toMatchObject({
      operation: 'rollback',
      startedAt: 200,
    });
    expect(controller.read()?.phase).not.toBe('completed');
    controller.dispose();
  });

  it('restores a durable server closure without auto-clearing the browser latch', async () => {
    const progress = receiptProgress({ operation: 'rollback' });
    const clearProgress = vi.fn(async () => true);
    const controller = createServerUpdateReceiptVerification({
      readProgress: () => progress,
      isConnected: () => true,
      verify: async () => ({
        status: 'closed_unresolved',
        operation: 'rollback',
      }),
      close: unsupportedClose,
      readCurrentState: currentState,
      clearProgress,
    });

    controller.reconcile();
    await flush();
    expect(controller.read()).toEqual({
      phase: 'closed',
      operation: 'rollback',
      startedAt: 100,
      reason: 'server_closed_unresolved',
    });
    expect(clearProgress).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('ignores a stale current-state reply from an older exact lineage', async () => {
    let progress: ServerUpdateTabProgress | null = receiptProgress();
    let rejectFirst!: (reason?: unknown) => void;
    const first = new Promise<never>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const readCurrentState = vi.fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(await currentState());
    const clearProgress = vi.fn(async () => false);
    const controller = createServerUpdateReceiptVerification({
      readProgress: () => progress,
      isConnected: () => true,
      verify: async () => ({
        status: 'closed_unresolved',
        operation: 'update',
      }),
      close: unsupportedClose,
      readCurrentState,
      clearProgress,
    });

    controller.reconcile();
    await flush();
    controller.finishClosure();
    expect(controller.read()?.phase).toBe('checking_baseline');
    progress = receiptProgress({ operationId: 'newer-receipt' });
    controller.reconcile();
    rejectFirst(new Error('raw baseline transport detail'));
    await flush();
    expect(controller.read()?.phase).toBe('closed');
    expect(clearProgress).not.toHaveBeenCalled();

    controller.finishClosure();
    await flush();
    expect(controller.read()?.phase).toBe('baseline_confirmed');
    expect(JSON.stringify(controller.read())).not.toMatch(
      /raw baseline transport detail|opaque-receipt/i,
    );
    controller.dispose();
  });

  it('keeps a failed current-state read paused until an explicit successful retry', async () => {
    let progress: ServerUpdateTabProgress | null = receiptProgress();
    const readCurrentState = vi.fn()
      .mockRejectedValueOnce(new Error('raw baseline transport detail'))
      .mockResolvedValueOnce(await currentState());
    const clearProgress = vi.fn(async () => {
      progress = null;
      return true;
    });
    const controller = createServerUpdateReceiptVerification({
      readProgress: () => progress,
      isConnected: () => true,
      verify: async () => ({
        status: 'closed_unresolved',
        operation: 'update',
      }),
      close: unsupportedClose,
      readCurrentState,
      clearProgress,
    });

    controller.reconcile();
    await flush();
    controller.finishClosure();
    await flush();
    expect(controller.read()).toEqual({
      phase: 'baseline_retryable',
      operation: 'update',
      startedAt: 100,
      reason: 'baseline_unavailable',
    });
    expect(progress).not.toBeNull();
    expect(clearProgress).not.toHaveBeenCalled();
    expect(JSON.stringify(controller.read())).not.toMatch(
      /raw baseline transport detail|opaque-receipt/i,
    );

    controller.finishClosure();
    await flush();
    expect(controller.read()?.phase).toBe('baseline_confirmed');
    expect(progress).not.toBeNull();
    controller.dispose();
  });

  it('keeps the confirmed baseline visible when exact latch retirement needs a retry', async () => {
    let progress: ServerUpdateTabProgress | null = receiptProgress();
    let allowClear = false;
    const readCurrentState = vi.fn(currentState);
    const clearProgress = vi.fn(async () => {
      if (!allowClear) return false;
      progress = null;
      return true;
    });
    const controller = createServerUpdateReceiptVerification({
      readProgress: () => progress,
      isConnected: () => true,
      verify: async () => ({
        status: 'closed_unresolved',
        operation: 'update',
      }),
      close: unsupportedClose,
      readCurrentState,
      clearProgress,
    });

    controller.reconcile();
    await flush();
    controller.finishClosure();
    await flush();
    expect(controller.read()?.phase).toBe('baseline_confirmed');

    controller.finishClosure();
    await flush();
    expect(controller.read()).toMatchObject({
      phase: 'baseline_confirmed',
      reason: 'finish_unavailable',
      baseline: {
        currentVersion: '26.8.1',
        channel: 'stable',
        updateStatus: 'up-to-date',
      },
    });
    expect(progress).not.toBeNull();
    expect(readCurrentState).toHaveBeenCalledOnce();

    allowClear = true;
    controller.finishClosure();
    await flush();
    expect(clearProgress).toHaveBeenCalledTimes(2);
    expect(readCurrentState).toHaveBeenCalledOnce();
    expect(progress).toBeNull();
    expect(controller.read()?.phase).toBe('completed');
    controller.dispose();
  });

  it('projects only allowlisted current-state fields into presentation snapshots', async () => {
    const progress = receiptProgress();
    const readCurrentState = async (): Promise<ServerUpdateCurrentStateRead> =>
      ({
        release: {
          status: 'up-to-date',
          current_version: '26.8.1',
          channel: 'stable',
          release_secret: 'do-not-project-release-secret',
        },
        affectedConnection: {
          kind: 'api',
          name: 'github-main',
          activity: 'idle',
          credential: 'do-not-project-credential',
          endpoint: 'https://private.example/path',
        },
      } as unknown as ServerUpdateCurrentStateRead);
    const controller = createServerUpdateReceiptVerification({
      readProgress: () => progress,
      isConnected: () => true,
      verify: async () => ({
        status: 'closed_unresolved',
        operation: 'update',
      }),
      close: unsupportedClose,
      readCurrentState,
      clearProgress: async () => false,
    });

    controller.reconcile();
    await flush();
    controller.finishClosure();
    await flush();
    const snapshot = controller.read();
    expect(snapshot).toMatchObject({
      phase: 'baseline_confirmed',
      baseline: {
        currentVersion: '26.8.1',
        channel: 'stable',
        updateStatus: 'up-to-date',
        affectedConnection: {
          kind: 'api',
          name: 'github-main',
          activity: 'idle',
        },
      },
    });
    expect(JSON.stringify(snapshot)).not.toMatch(
      /do-not-project|private\.example|credential|endpoint|release_secret/i,
    );
    controller.dispose();
  });

  it('surfaces a server refusal and re-resolves a receipt that raced known', async () => {
    let progress: ServerUpdateTabProgress | null = receiptProgress();
    const close = vi.fn<(
      operationId: string,
      operation: 'update' | 'rollback',
    ) => Promise<UpdateOperationClosureResponse>>()
      .mockResolvedValueOnce({
        status: 'refused',
        reason: 'operation_in_flight',
      })
      .mockResolvedValueOnce({
        status: 'completed',
        operation: 'update',
      });
    const verify = vi.fn(async (): Promise<UpdateOperationStatusResponse> => ({
      status: 'unknown',
    }));
    const controller = createServerUpdateReceiptVerification({
      readProgress: () => progress,
      isConnected: () => true,
      verify,
      close,
      clearProgress: async () => {
        progress = null;
        return true;
      },
    });

    controller.reconcile();
    await flush();
    controller.reviewClosure();
    controller.closeUnresolved();
    await flush();
    expect(controller.read()?.reason).toBe('closure_in_flight');
    expect(progress).not.toBeNull();

    controller.retry();
    await flush();
    controller.reviewClosure();
    controller.closeUnresolved();
    await flush();
    expect(progress).toBeNull();
    expect(controller.read()).toBeNull();
    controller.dispose();
  });
});
