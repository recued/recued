/** D-188 — the services that send on their own hold while the owner's pause does (the emergency
 *  stop, the owner's ruling of 2026-11-08: nothing leaves the server until Resume), and go on
 *  after it. Each reads the pause on every tick, so a held one needs no restart. */
import { describe, expect, it, vi } from 'vitest';

import { composeExchangeRetry } from '../composition/bin/wire-exchange-retry.js';
import { composePeerAskTimeoutSweep } from '../composition/bin/wire-peer-ask-timeout.js';
import { createSavedDataViewAlertRuntime } from '../saved-data-view-alert-runtime.js';

/** A registry that keeps the tick, so the test runs it. */
const capture = () => {
  let tick: (() => Promise<void> | void) | undefined;
  return {
    registry: { registerInterval: (spec: { tick: () => Promise<void> | void }) => { tick = spec.tick; return () => {}; } },
    tick: async () => { await tick!(); },
  };
};

describe('retries to a peer server', () => {
  it('re-sends nothing while paused, and looks again once resumed', async () => {
    let paused = true;
    const pendingRefs = vi.fn(async () => [] as string[]);
    const { registry, tick } = capture();
    composeExchangeRetry({
      registry: registry as never,
      pendingRefs,
      rowsForRef: async () => [],
      callbackForRef: () => undefined,
      healthForRef: () => undefined as never,
      classify: () => ({ kind: undefined as never, reason: '' }),
      resend: vi.fn(async () => {}),
      isPaused: () => paused,
      log: () => {},
    });
    await tick();
    expect(pendingRefs).not.toHaveBeenCalled();
    paused = false;
    await tick();
    expect(pendingRefs).toHaveBeenCalledTimes(1);
  });
});

describe('the peer-ask timeout sweep', () => {
  it('times out, resumes and withdraws nothing while paused', async () => {
    let paused = true;
    const list = vi.fn(() => []);
    const { registry, tick } = capture();
    composePeerAskTimeoutSweep({
      registry: registry as never,
      sweep: {
        outbox: { list, get: vi.fn(), close: vi.fn() },
        answers: { record: vi.fn(), get: vi.fn() },
        resume: vi.fn(async () => {}),
      } as never,
      isPaused: () => paused,
      log: () => {},
    });
    await tick();
    expect(list).not.toHaveBeenCalled();
    paused = false;
    await tick();
    expect(list).toHaveBeenCalled();
  });
});

describe('saved-view alerts', () => {
  it('push nothing while paused; the notices wait and go out once resumed', async () => {
    let paused = true;
    const evaluate = vi.fn();
    const runtime = createSavedDataViewAlertRuntime({
      store: { evaluate, pending: () => [], claim: () => false } as never,
      auditLog: { logActivity: vi.fn(async () => {}) } as never,
      notifier: { notify: vi.fn(async () => {}) } as never,
      isPaused: () => paused,
    });
    await runtime.tick();
    expect(evaluate).not.toHaveBeenCalled();
    paused = false;
    await runtime.tick();
    expect(evaluate).toHaveBeenCalledTimes(1);
  });
});
