/** D-169 P2 Slice 4 — regression coverage for the fail-closed mode-convergence
 *  loop (`side-panel/bridge-mode-convergence.ts`).
 *
 *  Locks in the Codex adversarial-review HIGH fold: a `bridge-mode-invalidated`
 *  push means the mode CHANGED, so if the very first re-fetch fails we must
 *  `failClosed()` IMMEDIATELY — before any backoff delay — rather than leave a
 *  possibly-approval-ON gate up while we retry. Recovery happens the instant a
 *  later attempt succeeds. */

import { describe, it, expect } from 'vitest';
import {
  runBridgeModeConvergence,
  type BridgeModeConvergenceOptions,
} from '../side-panel/bridge-mode-convergence.js';

/** A harness that records the exact call ORDER across refresh/failClosed/delay
 *  into one log, so ordering invariants are assertable. `refreshResults` is
 *  consumed one per `refresh()`; once exhausted the last value repeats. */
const harness = (
  refreshResults: boolean[],
  attempts: number,
  retryMs = 10,
): { opts: BridgeModeConvergenceOptions; log: string[] } => {
  const log: string[] = [];
  let i = 0;
  const opts: BridgeModeConvergenceOptions = {
    refresh: async () => {
      const r =
        i < refreshResults.length
          ? refreshResults[i]
          : refreshResults[refreshResults.length - 1];
      i += 1;
      log.push(`refresh:${r}`);
      return r;
    },
    failClosed: () => {
      log.push('failClosed');
    },
    delay: async (ms: number) => {
      log.push(`delay:${ms}`);
    },
    attempts,
    retryMs,
  };
  return { opts, log };
};

describe('runBridgeModeConvergence', () => {
  it('applies the mode on the eager first refresh — no failClosed, no delay', async () => {
    const { opts, log } = harness([true], 3);
    await runBridgeModeConvergence(opts);
    expect(log).toEqual(['refresh:true']);
  });

  it('INVARIANT: fails closed immediately on the first failure, BEFORE any backoff', async () => {
    const { opts, log } = harness([false, true], 3);
    await runBridgeModeConvergence(opts);
    // failClosed lands before the first delay, then a retry recovers.
    expect(log).toEqual(['refresh:false', 'failClosed', 'delay:10', 'refresh:true']);
    expect(log.indexOf('failClosed')).toBeLessThan(log.indexOf('delay:10'));
  });

  it('fails closed exactly once even when every attempt fails', async () => {
    const { opts, log } = harness([false], 3);
    await runBridgeModeConvergence(opts);
    // eager + 2 retries = 3 total refreshes; 2 backoffs; ONE failClosed.
    expect(log.filter((e) => e === 'refresh:false')).toHaveLength(3);
    expect(log.filter((e) => e === 'delay:10')).toHaveLength(2);
    expect(log.filter((e) => e === 'failClosed')).toHaveLength(1);
  });

  it('honours attempts=1 — one refresh, fail closed, no retry/delay', async () => {
    const { opts, log } = harness([false], 1);
    await runBridgeModeConvergence(opts);
    expect(log).toEqual(['refresh:false', 'failClosed']);
  });

  it('does not fail closed when a later retry recovers within budget', async () => {
    const { opts, log } = harness([false, false, true], 3);
    await runBridgeModeConvergence(opts);
    expect(log).toEqual([
      'refresh:false',
      'failClosed',
      'delay:10',
      'refresh:false',
      'delay:10',
      'refresh:true',
    ]);
  });
});
