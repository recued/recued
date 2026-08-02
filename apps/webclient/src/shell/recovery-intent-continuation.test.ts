import { describe, expect, it, vi } from 'vitest';

import {
  createRecoveryIntentContinuationStore,
  RECOVERY_INTENT_CONTINUATION_MAX_AGE_MS,
  RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
  RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
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
    const verification = store.armReviewVerification(marker!, 'server');
    expect(verification).toEqual({
      profileId: 'profile-home',
      landingHash: '#chat',
      intent: 'continue',
      pausedAt: 8_000,
      reviewTarget: 'server',
      state: 'checking',
      interruptionCount: 0,
      lastInterruption: null,
    });
    expect(store.readReviewVerification(marker!)).toEqual(verification);
    store.clearReviewVerification();
    expect(store.readReviewVerification(marker!)).toBeNull();
    store.retire();
    expect(store.readForProfile('profile-home')).toBeNull();
  });

  it('restores only a privacy-safe unfinished review verification for its exact continuation', () => {
    const storage = memoryStorage();
    const firstStore = createRecoveryIntentContinuationStore({
      storage,
      now: () => 4_000,
    });
    const marker = firstStore.arm({
      profileId: 'profile-home',
      landingHash: '#connections/mail',
      intent: 'choose_again',
    })!;

    expect(firstStore.armReviewVerification(marker, 'area')).toEqual({
      profileId: 'profile-home',
      landingHash: '#connections/mail',
      intent: 'choose_again',
      pausedAt: 4_000,
      reviewTarget: 'area',
      state: 'checking',
      interruptionCount: 0,
      lastInterruption: null,
    });
    const raw = storage.data.get(
      RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
    )!;
    expect(JSON.parse(raw)).toEqual({
      v: 2,
      profile_id: 'profile-home',
      landing_hash: '#connections/mail',
      intent: 'choose_again',
      paused_at: 4_000,
      review_target: 'area',
      state: 'checking',
      interruption_count: 0,
      last_interruption: null,
    });
    expect(raw).not.toMatch(
      /credential|error|receipt|record|provider|field|draft|label/i,
    );

    const reloadedStore = createRecoveryIntentContinuationStore({
      storage,
      now: () => 4_500,
    });
    const restoredMarker = reloadedStore.readForProfile('profile-home')!;
    expect(reloadedStore.readReviewVerification(restoredMarker)).toEqual({
      profileId: 'profile-home',
      landingHash: '#connections/mail',
      intent: 'choose_again',
      pausedAt: 4_000,
      reviewTarget: 'area',
      state: 'checking',
      interruptionCount: 0,
      lastInterruption: null,
    });
  });

  it('restores a prepared exact-area check without persisting the reconciled receipt or state', () => {
    const storage = memoryStorage();
    const firstStore = createRecoveryIntentContinuationStore({
      storage,
      now: () => 4_000,
    });
    const marker = firstStore.arm({
      profileId: 'profile-home',
      landingHash: '#contracts',
      intent: 'choose_again',
    })!;

    expect(firstStore.prepareReviewVerification(marker)).toEqual({
      profileId: 'profile-home',
      landingHash: '#contracts',
      intent: 'choose_again',
      pausedAt: 4_000,
      reviewTarget: 'server',
      state: 'ready',
      interruptionCount: 0,
      lastInterruption: null,
    });
    const raw = storage.data.get(
      RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
    )!;
    expect(JSON.parse(raw)).toEqual({
      v: 2,
      profile_id: 'profile-home',
      landing_hash: '#contracts',
      intent: 'choose_again',
      paused_at: 4_000,
      review_target: 'server',
      state: 'ready',
      interruption_count: 0,
      last_interruption: null,
    });
    expect(raw).not.toMatch(
      /credential|error|receipt|record|provider|field|draft|running/i,
    );

    const reloadedStore = createRecoveryIntentContinuationStore({
      storage,
      now: () => 4_500,
    });
    const restoredMarker = reloadedStore.readForProfile('profile-home')!;
    const restored = reloadedStore.readReviewVerification(restoredMarker);
    expect(restored).toMatchObject({
      state: 'ready',
      interruptionCount: 0,
      lastInterruption: null,
    });
    expect(reloadedStore.interruptReviewVerification(
      restoredMarker,
      'server',
      'reload',
    )).toBeNull();
    expect(reloadedStore.readReviewVerification(restoredMarker)).toEqual(
      restored,
    );
    expect(reloadedStore.armReviewVerification(
      restoredMarker,
      'server',
    )).toEqual({
      ...restored,
      state: 'checking',
    });
  });

  it('caps repeated interruption attempts and deduplicates duplicate signals', () => {
    const storage = memoryStorage();
    const store = createRecoveryIntentContinuationStore({
      storage,
      now: () => 5_000,
    });
    const marker = store.arm({
      profileId: 'profile-home',
      landingHash: '#contracts',
      intent: 'continue',
    })!;
    const firstAttempt = store.armReviewVerification(marker, 'area')!;

    const firstInterruption = store.interruptReviewVerification(
      marker,
      'area',
      'connection',
    );
    expect(firstInterruption).toEqual({
      ...firstAttempt,
      state: 'interrupted',
      interruptionCount: 1,
      lastInterruption: 'connection',
    });
    expect(store.interruptReviewVerification(
      marker,
      'area',
      'navigation',
    )).toEqual(firstInterruption);

    expect(store.armReviewVerification(marker, 'area')).toEqual({
      ...firstAttempt,
      state: 'checking',
      interruptionCount: 1,
      lastInterruption: null,
    });
    const bounded = store.interruptReviewVerification(
      marker,
      'area',
      'navigation',
    );
    expect(bounded).toEqual({
      ...firstAttempt,
      state: 'interrupted',
      interruptionCount: 2,
      lastInterruption: 'navigation',
    });

    store.armReviewVerification(marker, 'area');
    expect(store.interruptReviewVerification(
      marker,
      'area',
      'ownership',
    )).toEqual({
      ...firstAttempt,
      state: 'interrupted',
      interruptionCount: 2,
      lastInterruption: 'ownership',
    });
    expect(JSON.parse(storage.data.get(
      RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
    )!)).toMatchObject({
      v: 2,
      state: 'interrupted',
      interruption_count: 2,
      last_interruption: 'ownership',
    });
  });

  it('migrates an in-flight v1 verifier to one bounded reload interruption', () => {
    const storage = memoryStorage();
    storage.setItem(
      RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
      JSON.stringify({
        v: 1,
        profile_id: 'profile-home',
        landing_hash: '#contracts',
        intent: 'choose_again',
        paused_at: 6_000,
      }),
    );
    const legacyKey =
      'recued.webclient.recovery-intent-review-verification.v1';
    storage.setItem(legacyKey, JSON.stringify({
      v: 1,
      profile_id: 'profile-home',
      landing_hash: '#contracts',
      intent: 'choose_again',
      paused_at: 6_000,
      review_target: 'server',
    }));
    const store = createRecoveryIntentContinuationStore({
      storage,
      now: () => 6_500,
    });
    const marker = store.readForProfile('profile-home')!;

    expect(store.readReviewVerification(marker)).toEqual({
      profileId: 'profile-home',
      landingHash: '#contracts',
      intent: 'choose_again',
      pausedAt: 6_000,
      reviewTarget: 'server',
      state: 'interrupted',
      interruptionCount: 1,
      lastInterruption: 'reload',
    });
    expect(storage.data.has(legacyKey)).toBe(false);
    expect(JSON.parse(storage.data.get(
      RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
    )!)).toMatchObject({
      v: 2,
      state: 'interrupted',
      interruption_count: 1,
      last_interruption: 'reload',
    });
  });

  it('keeps the legacy verifier durable until its v2 replacement is written', () => {
    const backing = memoryStorage();
    backing.setItem(
      RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
      JSON.stringify({
        v: 1,
        profile_id: 'profile-home',
        landing_hash: '#contracts',
        intent: 'choose_again',
        paused_at: 7_000,
      }),
    );
    const legacyKey =
      'recued.webclient.recovery-intent-review-verification.v1';
    const legacyRaw = JSON.stringify({
      v: 1,
      profile_id: 'profile-home',
      landing_hash: '#contracts',
      intent: 'choose_again',
      paused_at: 7_000,
      review_target: 'area',
    });
    backing.setItem(legacyKey, legacyRaw);
    const writeDenied = createRecoveryIntentContinuationStore({
      storage: {
        getItem: backing.getItem,
        setItem: (key, value): void => {
          if (key === RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY) {
            throw new Error('quota denied');
          }
          backing.setItem(key, value);
        },
        removeItem: backing.removeItem,
      },
      now: () => 7_500,
    });
    const marker = writeDenied.readForProfile('profile-home')!;

    expect(writeDenied.readReviewVerification(marker)).toMatchObject({
      state: 'interrupted',
      interruptionCount: 1,
      lastInterruption: 'reload',
    });
    expect(backing.data.has(
      RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
    )).toBe(false);
    expect(backing.data.get(legacyKey)).toBe(legacyRaw);

    // Once storage is writable again, the next cold reader can migrate the
    // retained proof instead of losing the interrupted posture on reload.
    const recovered = createRecoveryIntentContinuationStore({
      storage: backing,
      now: () => 8_000,
    });
    const recoveredMarker = recovered.readForProfile('profile-home')!;
    expect(recovered.readReviewVerification(recoveredMarker)).toMatchObject({
      state: 'interrupted',
      interruptionCount: 1,
      lastInterruption: 'reload',
    });
    expect(backing.data.has(legacyKey)).toBe(false);
    expect(JSON.parse(backing.data.get(
      RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
    )!)).toMatchObject({
      v: 2,
      state: 'interrupted',
      interruption_count: 1,
      last_interruption: 'reload',
    });
  });

  it('clears malformed or mismatched verification without losing the valid return', () => {
    const invalidVerifications: unknown[] = [
      {
        v: 1,
        profile_id: 'profile-other',
        landing_hash: '#contracts',
        intent: 'continue',
        paused_at: 1_000,
        review_target: 'server',
      },
      {
        v: 1,
        profile_id: 'profile-home',
        landing_hash: '#contracts',
        intent: 'continue',
        paused_at: 1_000,
        review_target: 'other',
      },
      {
        v: 1,
        profile_id: 'profile-home',
        landing_hash: '#contracts',
        intent: 'continue',
        paused_at: 1_000,
        review_target: 'area',
        error: 'private failure detail',
      },
      {
        v: 2,
        profile_id: 'profile-home',
        landing_hash: '#contracts',
        intent: 'continue',
        paused_at: 1_000,
        review_target: 'area',
        state: 'checking',
        interruption_count: 0,
        last_interruption: 'connection',
      },
      {
        v: 2,
        profile_id: 'profile-home',
        landing_hash: '#contracts',
        intent: 'continue',
        paused_at: 1_000,
        review_target: 'area',
        state: 'ready',
        interruption_count: 0,
        last_interruption: null,
      },
      {
        v: 2,
        profile_id: 'profile-home',
        landing_hash: '#contracts',
        intent: 'continue',
        paused_at: 1_000,
        review_target: 'server',
        state: 'ready',
        interruption_count: 1,
        last_interruption: null,
      },
      {
        v: 2,
        profile_id: 'profile-home',
        landing_hash: '#contracts',
        intent: 'continue',
        paused_at: 1_000,
        review_target: 'server',
        state: 'ready',
        interruption_count: 0,
        last_interruption: null,
        receipt: 'private receipt',
      },
      {
        v: 2,
        profile_id: 'profile-home',
        landing_hash: '#contracts',
        intent: 'continue',
        paused_at: 1_000,
        review_target: 'server',
        state: 'interrupted',
        interruption_count: 0,
        last_interruption: 'reload',
      },
      {
        v: 2,
        profile_id: 'profile-home',
        landing_hash: '#contracts',
        intent: 'continue',
        paused_at: 1_000,
        review_target: 'server',
        state: 'interrupted',
        interruption_count: 2,
        last_interruption: 'timeout',
      },
      {
        v: 2,
        profile_id: 'profile-home',
        landing_hash: '#contracts',
        intent: 'continue',
        paused_at: 1_000,
        review_target: 'server',
        state: 'interrupted',
        interruption_count: 2,
        last_interruption: 'navigation',
        error: 'private failure detail',
      },
    ];

    for (const invalid of invalidVerifications) {
      const storage = memoryStorage();
      const writer = createRecoveryIntentContinuationStore({
        storage,
        now: () => 1_000,
      });
      writer.arm({
        profileId: 'profile-home',
        landingHash: '#contracts',
        intent: 'continue',
      });
      storage.setItem(
        RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
        JSON.stringify(invalid),
      );
      const reader = createRecoveryIntentContinuationStore({
        storage,
        now: () => 1_500,
      });
      const marker = reader.readForProfile('profile-home')!;

      expect(reader.readReviewVerification(marker)).toBeNull();
      expect(storage.data.has(
        RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
      )).toBe(false);
      expect(reader.readForProfile('profile-home')).toEqual(marker);
    }
  });

  it('keeps local retirement and volatile re-arming authoritative when writes become denied', () => {
    const backing = memoryStorage();
    let denyWrites = false;
    const storage = {
      getItem: backing.getItem,
      setItem: (key: string, value: string): void => {
        if (denyWrites) throw new Error('write denied');
        backing.setItem(key, value);
      },
      removeItem: (key: string): void => {
        if (denyWrites) throw new Error('remove denied');
        backing.removeItem(key);
      },
    };
    let now = 1_000;
    const store = createRecoveryIntentContinuationStore({
      storage,
      now: () => now,
    });
    const original = store.arm({
      profileId: 'profile-home',
      landingHash: '#contracts',
      intent: 'continue',
    })!;
    store.armReviewVerification(original, 'area');
    const staleContinuation = backing.data.get(
      RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
    );
    const staleVerification = backing.data.get(
      RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
    );
    expect(staleContinuation).toBeDefined();
    expect(staleVerification).toBeDefined();

    denyWrites = true;
    store.clearReviewVerification();
    expect(backing.data.get(
      RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
    )).toBe(staleVerification);
    expect(store.readReviewVerification(original)).toBeNull();

    const rearmedVerification = store.armReviewVerification(
      original,
      'server',
    );
    expect(rearmedVerification?.reviewTarget).toBe('server');
    expect(store.readReviewVerification(original)).toEqual(
      rearmedVerification,
    );
    expect(backing.data.get(
      RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
    )).toBe(staleVerification);

    store.retire();
    expect(backing.data.get(
      RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
    )).toBe(staleContinuation);
    expect(store.readForProfile('profile-home')).toBeNull();

    now = 2_000;
    const rearmed = store.arm({
      profileId: 'profile-home',
      landingHash: '#chat',
      intent: 'choose_again',
    })!;
    expect(store.readForProfile('profile-home')).toEqual(rearmed);
    expect(rearmed.landingHash).toBe('#chat');
    expect(backing.data.get(
      RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
    )).toBe(staleContinuation);
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
    expect(removeItem).toHaveBeenCalledWith(
      RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
    );
    expect(storage.data.get(RECOVERY_INTENT_CONTINUATION_SESSION_KEY)).toBe('0');
    expect(storage.data.get(
      RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
    )).toBe('0');
    expect(store.readForProfile('profile-home')).toBeNull();
  });
});
