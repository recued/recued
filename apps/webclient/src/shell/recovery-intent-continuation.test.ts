import { describe, expect, it, vi } from 'vitest';

import {
  createRecoveryIntentContinuationStore,
  createRecoveryIntentDeferredCheckStore,
  RECOVERY_INTENT_CONTINUATION_MAX_AGE_MS,
  RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
  RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
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

  it('persists a bounded quiet deferral without the prior intent or review material', () => {
    const storage = memoryStorage();
    let now = 1_000;
    const continuationStore = createRecoveryIntentContinuationStore({
      storage,
      now: () => now,
      maxAgeMs: 1_000,
    });
    const deferredStore = createRecoveryIntentDeferredCheckStore({
      storage,
      now: () => now,
      maxAgeMs: 1_000,
      handoffMaxAgeMs: 500,
    });
    const marker = continuationStore.arm({
      profileId: 'profile-home',
      landingHash: '#contracts',
      intent: 'choose_again',
    })!;
    continuationStore.prepareReviewVerification(marker);

    now = 1_200;
    const deferred = deferredStore.defer(marker);
    expect(deferred).toEqual({
      profileId: 'profile-home',
      landingHash: '#contracts',
      pausedAt: 1_000,
      deferredAt: 1_200,
      expiresAt: 2_000,
      handoffExpiresAt: 2_500,
      reviewStartedAt: null,
      attemptCount: 0,
      diagnosisTarget: null,
      diagnosisOutcome: null,
    });
    const raw = storage.data.get(
      RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
    )!;
    expect(JSON.parse(raw)).toEqual({
      v: 4,
      profile_id: 'profile-home',
      landing_hash: '#contracts',
      paused_at: 1_000,
      deferred_at: 1_200,
      review_started_at: null,
      attempt_count: 0,
      diagnosis_target: null,
      diagnosis_outcome: null,
    });
    expect(raw).not.toMatch(
      /intent|choose|receipt|credential|error|record|provider|review_target/i,
    );

    now = 1_500;
    expect(deferredStore.defer(marker)).toEqual(deferred);
    const reloaded = createRecoveryIntentDeferredCheckStore({
      storage,
      now: () => now,
      maxAgeMs: 1_000,
      handoffMaxAgeMs: 500,
    });
    expect(reloaded.readForProfile('profile-home')).toEqual(deferred);

    // The exact return is now stale, but its intent-free broad-area handoff
    // remains briefly available and then retires itself.
    now = 2_001;
    const started = reloaded.markReviewStarted(deferred!);
    expect(started).toEqual({
      ...deferred!,
      reviewStartedAt: 2_001,
      attemptCount: 1,
    });
    expect(JSON.parse(storage.data.get(
      RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
    )!)).toEqual({
      v: 4,
      profile_id: 'profile-home',
      landing_hash: '#contracts',
      paused_at: 1_000,
      deferred_at: 1_200,
      review_started_at: 2_001,
      attempt_count: 1,
      diagnosis_target: null,
      diagnosis_outcome: null,
    });
    const retryReloaded = createRecoveryIntentDeferredCheckStore({
      storage,
      now: () => now,
      maxAgeMs: 1_000,
      handoffMaxAgeMs: 500,
    });
    expect(retryReloaded.readForProfile('profile-home')).toEqual(started);
    const secondAttempt = retryReloaded.markReviewStarted(started!);
    expect(secondAttempt).toEqual({
      ...started!,
      attemptCount: 2,
    });
    const bounded = retryReloaded.recordReviewFailure(
      secondAttempt!,
      'area',
    );
    expect(bounded).toEqual({
      ...secondAttempt!,
      diagnosisTarget: 'area',
    });
    expect(retryReloaded.recordReviewFailure(
      secondAttempt!,
      'server',
    )).toEqual(bounded);
    expect(retryReloaded.recordDiagnosisOutcome(bounded!)).toBeNull();
    expect(storage.data.get(
      RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
    )).not.toMatch(/credential|receipt|record|provider|error/i);
    now = 2_500;
    expect(retryReloaded.readForProfile('profile-home')).toBeNull();
    expect(storage.data.has(
      RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
    )).toBe(false);

    now = 2_000;
    expect(deferredStore.defer(marker)).toBeNull();
  });

  it('restores a legacy deferred marker without inventing a retry', () => {
    const storage = memoryStorage();
    storage.setItem(
      'recued.webclient.recovery-intent-deferred-check.v1',
      JSON.stringify({
        v: 1,
        profile_id: 'profile-home',
        landing_hash: '#contracts',
        paused_at: 1_000,
        deferred_at: 1_200,
      }),
    );
    const store = createRecoveryIntentDeferredCheckStore({
      storage,
      now: () => 2_001,
      maxAgeMs: 1_000,
      handoffMaxAgeMs: 500,
    });

    expect(store.readForProfile('profile-home')).toEqual({
      profileId: 'profile-home',
      landingHash: '#contracts',
      pausedAt: 1_000,
      deferredAt: 1_200,
      expiresAt: 2_000,
      handoffExpiresAt: 2_500,
      reviewStartedAt: null,
      attemptCount: 0,
      diagnosisTarget: null,
      diagnosisOutcome: null,
    });
  });

  it('migrates a v2 started review into the first bounded attempt', () => {
    const storage = memoryStorage();
    storage.setItem(
      'recued.webclient.recovery-intent-deferred-check.v2',
      JSON.stringify({
        v: 2,
        profile_id: 'profile-home',
        landing_hash: '#contracts',
        paused_at: 1_000,
        deferred_at: 1_200,
        review_started_at: 2_001,
      }),
    );
    const store = createRecoveryIntentDeferredCheckStore({
      storage,
      now: () => 2_002,
      maxAgeMs: 1_000,
      handoffMaxAgeMs: 500,
    });

    const migrated = store.readForProfile('profile-home');
    expect(migrated).toMatchObject({
      reviewStartedAt: 2_001,
      attemptCount: 1,
      diagnosisTarget: null,
    });
    const secondAttempt = store.markReviewStarted(migrated!);
    expect(secondAttempt?.attemptCount).toBe(2);
    expect(store.recordReviewFailure(
      secondAttempt!,
      'server',
    )?.diagnosisTarget).toBe('server');
    expect(JSON.parse(storage.getItem(
      RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
    )!)).toMatchObject({
      v: 4,
      attempt_count: 2,
      diagnosis_target: 'server',
      diagnosis_outcome: null,
    });
    expect(storage.getItem(
      'recued.webclient.recovery-intent-deferred-check.v2',
    )).toBeNull();
  });

  it('offers and consumes one privacy-safe recheck after server diagnosis', () => {
    const storage = memoryStorage();
    storage.setItem(
      'recued.webclient.recovery-intent-deferred-check.v3',
      JSON.stringify({
        v: 3,
        profile_id: 'profile-home',
        landing_hash: '#contracts',
        paused_at: 1_000,
        deferred_at: 1_200,
        review_started_at: 2_001,
        attempt_count: 2,
        diagnosis_target: 'server',
      }),
    );
    const store = createRecoveryIntentDeferredCheckStore({
      storage,
      now: () => 2_002,
      maxAgeMs: 1_000,
      handoffMaxAgeMs: 500,
    });

    const diagnosed = store.readForProfile('profile-home');
    expect(diagnosed).toMatchObject({
      attemptCount: 2,
      diagnosisTarget: 'server',
      diagnosisOutcome: null,
    });
    const choice = store.recordDiagnosisOutcome(diagnosed!);
    expect(choice?.diagnosisOutcome).toBe('choose');
    const started = store.markDiagnosisRecheckStarted(choice!);
    expect(started?.diagnosisOutcome).toBe('recheck_started');
    expect(store.markDiagnosisRecheckStarted(choice!)).toEqual(started);
    const failed = store.recordDiagnosisRecheckFailure(started!, 'area');
    expect(failed?.diagnosisOutcome).toBe('area_unconfirmed');
    expect(store.markDiagnosisRecheckStarted(failed!)).toBeNull();
    expect(JSON.parse(storage.getItem(
      RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
    )!)).toEqual({
      v: 4,
      profile_id: 'profile-home',
      landing_hash: '#contracts',
      paused_at: 1_000,
      deferred_at: 1_200,
      review_started_at: 2_001,
      attempt_count: 2,
      diagnosis_target: 'server',
      diagnosis_outcome: 'area_unconfirmed',
    });
    expect(storage.getItem(
      RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
    )).not.toMatch(/intent|credential|receipt|record|provider|error/i);
    expect(storage.getItem(
      'recued.webclient.recovery-intent-deferred-check.v3',
    )).toBeNull();
  });

  it('rejects malformed, detailed, and cross-profile deferred checks', () => {
    const invalid: unknown[] = [
      {
        v: 1,
        profile_id: 'profile-home',
        landing_hash: '#contracts/private-contract',
        paused_at: 1_000,
        deferred_at: 1_100,
      },
      {
        v: 1,
        profile_id: 'profile-home',
        landing_hash: '#contracts',
        paused_at: 1_000,
        deferred_at: 1_100,
        intent: 'choose_again',
      },
      {
        v: 1,
        profile_id: 'profile-home',
        landing_hash: '#contracts',
        paused_at: 1_000,
        deferred_at: 2_001,
      },
      {
        v: 2,
        profile_id: 'profile-home',
        landing_hash: '#contracts',
        paused_at: 1_000,
        deferred_at: 1_100,
        review_started_at: 2_001,
      },
      {
        v: 2,
        profile_id: 'profile-home',
        landing_hash: '#contracts',
        paused_at: 1_000,
        deferred_at: 1_100,
        review_started_at: null,
        error: 'private transport detail',
      },
      {
        v: 3,
        profile_id: 'profile-home',
        landing_hash: '#contracts',
        paused_at: 1_000,
        deferred_at: 1_100,
        review_started_at: 2_001,
        attempt_count: 1,
        diagnosis_target: 'server',
      },
      {
        v: 4,
        profile_id: 'profile-home',
        landing_hash: '#contracts',
        paused_at: 1_000,
        deferred_at: 1_100,
        review_started_at: 2_001,
        attempt_count: 2,
        diagnosis_target: 'area',
        diagnosis_outcome: 'choose',
      },
      {
        v: 4,
        profile_id: 'profile-home',
        landing_hash: '#contracts',
        paused_at: 1_000,
        deferred_at: 1_100,
        review_started_at: 2_001,
        attempt_count: 2,
        diagnosis_target: 'server',
        diagnosis_outcome: 'choose',
        error: 'private transport detail',
      },
    ];
    for (const value of invalid) {
      const storage = memoryStorage();
      storage.setItem(
        RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
        JSON.stringify(value),
      );
      const store = createRecoveryIntentDeferredCheckStore({
        storage,
        now: () => 1_500,
        maxAgeMs: 1_000,
      });
      expect(store.readForProfile('profile-home')).toBeNull();
      expect(storage.data.has(
        RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
      )).toBe(false);
    }

    const storage = memoryStorage();
    const store = createRecoveryIntentDeferredCheckStore({
      storage,
      now: () => 1_000,
      maxAgeMs: 1_000,
    });
    expect(store.defer({
      profileId: 'profile-home',
      landingHash: '#contracts',
      intent: 'continue',
      pausedAt: 1_000,
      expiresAt: 2_000,
    })).not.toBeNull();
    expect(store.readForProfile('profile-office')).toBeNull();
    expect(storage.data.has(
      RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
    )).toBe(false);
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
