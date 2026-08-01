import { describe, expect, it, vi } from 'vitest';

import {
  createRecoveryIntentContinuationStore,
  RECOVERY_INTENT_CONTINUATION_MAX_AGE_MS,
  RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
} from './recovery-intent-continuation.js';

const memoryStorage = () => {
  const data = new Map<string, string>();
  return {
    getItem: (key: string): string | null => data.get(key) ?? null,
    setItem: (key: string, value: string): void => { data.set(key, value); },
    removeItem: (key: string): void => { data.delete(key); },
    data,
  };
};

describe('paused recovery-intent continuation', () => {
  it('stores only one profile, scrubbed route, closed intent, and timestamp', () => {
    const storage = memoryStorage();
    let now = 1_000;
    const store = createRecoveryIntentContinuationStore({
      storage,
      now: () => now,
    });

    const first = store.arm({
      profileId: 'profile-home',
      landingHash: '#connections/mail',
      intent: 'choose_again',
    });
    expect(first).toEqual({
      profileId: 'profile-home',
      landingHash: '#connections/mail',
      intent: 'choose_again',
      pausedAt: 1_000,
      expiresAt: 1_000 + RECOVERY_INTENT_CONTINUATION_MAX_AGE_MS,
    });
    expect(JSON.parse(storage.data.get(
      RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
    )!)).toEqual({
      v: 1,
      profile_id: 'profile-home',
      landing_hash: '#connections/mail',
      intent: 'choose_again',
      paused_at: 1_000,
    });
    expect(storage.data.get(RECOVERY_INTENT_CONTINUATION_SESSION_KEY))
      .not.toContain('record');
    expect(storage.data.get(RECOVERY_INTENT_CONTINUATION_SESSION_KEY))
      .not.toContain('credential');

    now = 2_000;
    expect(store.arm({
      profileId: 'profile-home',
      landingHash: '#connections/mail',
      intent: 'choose_again',
    })).toEqual(first);
    expect(store.readForProfile('profile-home')).toEqual(first);
  });

  it('rejects detail routes, malformed shapes, stale markers, and profile drift', () => {
    const readAt = 2_000_000;
    const cases: unknown[] = [
      {
        v: 1,
        profile_id: 'profile-home',
        landing_hash: '#contracts/private-contract',
        intent: 'continue',
        paused_at: 1_000,
      },
      {
        v: 1,
        profile_id: 'profile-home',
        landing_hash: '#contracts',
        intent: 'review',
        paused_at: 1_000,
      },
      {
        v: 1,
        profile_id: 'profile-home',
        landing_hash: '#contracts',
        intent: 'continue',
        paused_at: 1_000,
        record_id: 'private-contract',
      },
      {
        v: 1,
        profile_id: 'profile-home',
        landing_hash: '#contracts',
        intent: 'continue',
        paused_at: readAt - RECOVERY_INTENT_CONTINUATION_MAX_AGE_MS - 1,
      },
      {
        v: 1,
        profile_id: 'profile-home',
        landing_hash: '#contracts',
        intent: 'continue',
        paused_at: readAt + 5 * 60_000 + 1,
      },
    ];

    for (const value of cases) {
      const storage = memoryStorage();
      storage.setItem(
        RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
        JSON.stringify(value),
      );
      const store = createRecoveryIntentContinuationStore({
        storage,
        now: () => readAt,
      });
      expect(store.readForProfile('profile-home')).toBeNull();
      expect(storage.data.has(RECOVERY_INTENT_CONTINUATION_SESSION_KEY))
        .toBe(false);
    }

    const storage = memoryStorage();
    const store = createRecoveryIntentContinuationStore({
      storage,
      now: () => 1_000,
    });
    expect(store.arm({
      profileId: 'profile-home',
      landingHash: '#contracts/private-contract',
      intent: 'continue',
    })).toBeNull();
    expect(storage.data.size).toBe(0);

    expect(store.arm({
      profileId: 'profile-home',
      landingHash: '#contracts',
      intent: 'continue',
    })).not.toBeNull();
    expect(store.readForProfile('profile-office')).toBeNull();
    expect(storage.data.has(RECOVERY_INTENT_CONTINUATION_SESSION_KEY))
      .toBe(false);
  });

  it('keeps a volatile same-tab affordance when session storage is denied', () => {
    const storage = {
      getItem: vi.fn(() => { throw new Error('denied'); }),
      setItem: vi.fn(() => { throw new Error('denied'); }),
      removeItem: vi.fn(() => { throw new Error('denied'); }),
    };
    const store = createRecoveryIntentContinuationStore({
      storage,
      now: () => 8_000,
    });
    const marker = store.arm({
      profileId: 'profile-home',
      landingHash: '#chat',
      intent: 'continue',
    });

    expect(marker).not.toBeNull();
    expect(store.readForProfile('profile-home')).toEqual(marker);
    store.retire();
    expect(store.readForProfile('profile-home')).toBeNull();
  });

  it('makes a completed marker inert even when deletion is denied', () => {
    const storage = memoryStorage();
    const removeItem = vi.fn(() => { throw new Error('denied'); });
    const store = createRecoveryIntentContinuationStore({
      storage: { ...storage, removeItem },
      now: () => 1_000,
    });
    store.arm({
      profileId: 'profile-home',
      landingHash: '#contracts',
      intent: 'continue',
    });

    store.retire();
    expect(removeItem).toHaveBeenCalledWith(
      RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
    );
    expect(storage.data.get(RECOVERY_INTENT_CONTINUATION_SESSION_KEY)).toBe('0');
    expect(store.readForProfile('profile-home')).toBeNull();
  });
});
