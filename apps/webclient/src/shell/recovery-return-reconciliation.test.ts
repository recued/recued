import { describe, expect, it } from 'vitest';

import {
  reconcileRecoveryContext,
  recoveryReturnAfterReconnectReceipt,
  recoveryReturnReceipt,
} from './recovery-return-reconciliation.js';

describe('recovery-return context freshness reconciliation', () => {
  it('calls context current only after an authoritative read with no errors', async () => {
    let loaded = false;
    expect(await reconcileRecoveryContext({
      whenLoaded: async () => { loaded = true; },
      getLoadErrors: () => ({ list: null, detail: null }),
    })).toBe('current');
    expect(loaded).toBe(true);

    expect(await reconcileRecoveryContext({
      whenLoaded: async () => undefined,
      getLoadErrors: () => ({ list: null, detail: 'not available' }),
    })).toBe('unavailable');
    expect(await reconcileRecoveryContext({
      whenLoaded: async () => { throw new Error('read failed'); },
    })).toBe('unavailable');
  });

  it('treats a mounted route without a freshness seam conservatively', async () => {
    expect(await reconcileRecoveryContext({})).toBe('mounted_only');
    expect(await reconcileRecoveryContext({
      getRecoveryContextFreshness: () => 'current',
    })).toBe('mounted_only');
    expect(await reconcileRecoveryContext({
      whenLoaded: async () => undefined,
    })).toBe('mounted_only');
  });

  it('distinguishes ready, withheld-detail, unavailable, legacy, and moved returns', () => {
    const common = {
      profileLabel: 'home',
      areaLabel: 'Data · Files',
      routeStillActive: true,
    } as const;
    const ready = recoveryReturnReceipt({
      ...common,
      returnContext: 'area',
      freshness: 'current',
    });
    expect(ready).toMatchObject({
      tone: 'success',
      intent: 'continue',
      actionLabel: 'Continue in Data · Files',
    });
    expect(ready.copy).toContain('up to date and ready');

    const withheld = recoveryReturnReceipt({
      ...common,
      returnContext: 'detail_withheld',
      freshness: 'current',
    });
    expect(withheld).toMatchObject({
      tone: 'attention',
      intent: 'choose_again',
      actionLabel: 'Choose again in Data · Files',
    });
    expect(withheld.copy).toContain('did not carry what you had open');

    const unavailable = recoveryReturnReceipt({
      ...common,
      returnContext: 'area',
      freshness: 'unavailable',
    });
    expect(unavailable.copy).toContain('could not check that');
    expect(unavailable.copy).not.toContain('ready');
    expect(unavailable).toMatchObject({
      intent: 'review',
      actionLabel: 'Review Data · Files',
    });

    const retryable = recoveryReturnReceipt({
      ...common,
      returnContext: 'area',
      freshness: 'unavailable',
      canRetry: true,
    });
    expect(retryable).toMatchObject({
      tone: 'attention',
      intent: 'retry',
      actionLabel: 'Retry Data · Files',
    });
    expect(retryable.copy).toContain('Check again before you carry on');

    const legacy = recoveryReturnReceipt({
      ...common,
      freshness: 'current',
    });
    expect(legacy.copy).toContain('Have a look before you carry on');

    const moved = recoveryReturnReceipt({
      ...common,
      returnContext: 'area',
      freshness: 'current',
      routeStillActive: false,
    });
    expect(moved.copy).toContain('tab has moved');
    expect(moved).toMatchObject({
      intent: 'return',
      actionLabel: 'Return to Data · Files',
    });

    const reconnected = recoveryReturnAfterReconnectReceipt(common);
    expect(reconnected).toMatchObject({
      tone: 'attention',
      intent: 'review',
      actionLabel: 'Review Data · Files',
    });
    expect(reconnected.copy).toContain('server is connected');
    expect(reconnected.copy).toContain('could not check that');
    expect(reconnected.copy).not.toContain('refreshed');
    expect(reconnected.copy).not.toContain('ready');
  });
});
