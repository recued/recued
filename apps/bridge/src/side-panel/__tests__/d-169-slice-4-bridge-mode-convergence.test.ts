/** D-169 P2 Slice 4 — `runBridgeModeConvergence` unit tests.
 *
 *  The convergence loop is the security-relevant half of the live-mode
 *  push: on a `bridge-mode-invalidated` signal it must re-read the mode
 *  and, if it can't immediately confirm the new value, FAIL CLOSED at once
 *  (before any retry backoff) so a stale approval-ON gate can never survive
 *  a change — then keep retrying to recover the true mode. These tests pin
 *  the exact attempt / delay / fail-closed behaviour AND the ordering (fail
 *  closed strictly before the first backoff) so a mutated loop — delayed
 *  fail-closed (the original fail-open), missing fail-closed, fail-closed on
 *  a success path, off-by-one — is caught. */

import { describe, expect, it, vi } from 'vitest';

import { runBridgeModeConvergence } from '../bridge-mode-convergence.js';

/** A `refresh` that returns the queued booleans in order, then repeats the
 *  last value once the queue is exhausted (so an over-running loop keeps
 *  getting the final verdict rather than throwing). */
const refreshReturning = (results: boolean[]): (() => Promise<boolean>) => {
  let i = 0;
  return () => {
    const value = results[Math.min(i, results.length - 1)] ?? false;
    i += 1;
    return Promise.resolve(value);
  };
};

describe('D-169 P2 Slice 4 — runBridgeModeConvergence', () => {
  it('stops after the first successful refresh: no delay, no fail-closed', async () => {
    const refresh = vi.fn(refreshReturning([true]));
    const failClosed = vi.fn();
    const delay = vi.fn(async () => {});

    await runBridgeModeConvergence({
      refresh,
      failClosed,
      delay,
      attempts: 3,
      retryMs: 2_000,
    });

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
    expect(failClosed).not.toHaveBeenCalled();
  });

  it('fails closed immediately on the first failure, then recovers when a retry succeeds', async () => {
    const refresh = vi.fn(refreshReturning([false, true]));
    const failClosed = vi.fn();
    const delay = vi.fn(async () => {});

    await runBridgeModeConvergence({
      refresh,
      failClosed,
      delay,
      attempts: 5,
      retryMs: 2_000,
    });

    // First refresh failed → fail closed at once → one backoff → second
    // refresh succeeds and recovers the true mode (loop returns).
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(failClosed).toHaveBeenCalledTimes(1);
    expect(delay).toHaveBeenCalledTimes(1);
    expect(delay).toHaveBeenCalledWith(2_000);
  });

  it('fails closed exactly once (not per attempt) when every refresh fails', async () => {
    const refresh = vi.fn(refreshReturning([false]));
    const failClosed = vi.fn();
    const delay = vi.fn(async () => {});

    await runBridgeModeConvergence({
      refresh,
      failClosed,
      delay,
      attempts: 3,
      retryMs: 2_000,
    });

    // 3 attempts total, a backoff between each retry (2), and a SINGLE
    // fail-closed (fired after the first failure, not re-fired per attempt).
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(delay).toHaveBeenCalledTimes(2);
    expect(failClosed).toHaveBeenCalledTimes(1);
  });

  it('with attempts=1 and a failure: one refresh, no delay, fail closed once', async () => {
    const refresh = vi.fn(refreshReturning([false]));
    const failClosed = vi.fn();
    const delay = vi.fn(async () => {});

    await runBridgeModeConvergence({
      refresh,
      failClosed,
      delay,
      attempts: 1,
      retryMs: 2_000,
    });

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
    expect(failClosed).toHaveBeenCalledTimes(1);
  });

  it('fails closed BEFORE the first backoff — no stale-permissive window (security ordering)', async () => {
    const order: string[] = [];
    const refresh = vi.fn(async () => {
      order.push('refresh');
      return false;
    });
    const failClosed = vi.fn(() => {
      order.push('failClosed');
    });
    const delay = vi.fn(async () => {
      order.push('delay');
    });

    await runBridgeModeConvergence({
      refresh,
      failClosed,
      delay,
      attempts: 2,
      retryMs: 10,
    });

    // The critical invariant: fail-closed lands immediately after the first
    // failed refresh and strictly BEFORE any backoff delay, so the gate is
    // never left stale-permissive while we wait to retry.
    expect(order).toEqual(['refresh', 'failClosed', 'delay', 'refresh']);
    expect(order.indexOf('failClosed')).toBeLessThan(order.indexOf('delay'));
  });
});
