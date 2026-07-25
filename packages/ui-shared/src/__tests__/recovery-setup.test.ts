/** Recovery-key setup state-machine tests.
 *
 *  The real crypto stack is the default; these tests inject a fake
 *  so we can exercise every transition deterministically (fixed
 *  generated key, synchronous derive/build/verify, controllable
 *  storage). Happy-path + every failure branch is covered.
 *
 *  Ported from `apps/extension/src/recovery/__tests__/setup.test.ts`
 *  at `c222acac^`. */

import { describe, it, expect, vi } from 'vitest';
import {
  initialRecoverySetupSlice,
  keyGenerated,
  ackWritten,
  challengeEntryChanged,
  challengeFailed,
  wrappingStarted,
  setupCompleted,
  setupReset,
  createRecoverySetupHandlers,
  type RecoverySetupSlice,
  type RecoveryCrypto,
} from '../account/recovery-setup.js';
import {
  readRecoveryCheck,
  RECOVERY_CHECK_KEY,
  type RecoveryCheckStorage,
} from '../account/recovery-check-store.js';

const KEY =
  'abandon ability able about above absent absorb abstract absurd abuse access accident ' +
  'account accuse achieve acid acoustic acquire across act action actor actress actual';
const WRONG_KEY =
  'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo ' +
  'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo';

// ────────────────────────────────────────────────────────────────
// Test rigs
// ────────────────────────────────────────────────────────────────

const mkStorage = (): RecoveryCheckStorage & { _backing: Map<string, unknown> } => {
  const backing = new Map<string, unknown>();
  return {
    _backing: backing,
    async get(keys) {
      const out: Record<string, unknown> = {};
      for (const k of keys) if (backing.has(k)) out[k] = backing.get(k);
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) backing.set(k, v);
    },
    async remove(keys) {
      for (const k of keys) backing.delete(k);
    },
  };
};

const mkStateStore = (initial: RecoverySetupSlice = initialRecoverySetupSlice()) => {
  let slice = { ...initial };
  return {
    getSlice: () => slice,
    setState: (patch: Partial<RecoverySetupSlice>) => { slice = { ...slice, ...patch }; },
  };
};

/** Fake crypto — deterministic, fast, captures call args. */
const mkFakeCrypto = (overrides: Partial<RecoveryCrypto> = {}): RecoveryCrypto => ({
  generate: () => KEY,
  isValid: (m) => m === KEY.toLowerCase() || m === WRONG_KEY.toLowerCase(),
  deriveKek: async () => ({} as CryptoKey),
  buildCheck: async () => 'check-blob',
  verifyCheck: async () => true,
  ...overrides,
});

// ────────────────────────────────────────────────────────────────
// Reducers
// ────────────────────────────────────────────────────────────────

describe('reducers', () => {
  it('initialRecoverySetupSlice is at idle with no state', () => {
    expect(initialRecoverySetupSlice()).toEqual({
      stage: 'idle',
      generatedKey: null,
      challengeEntry: '',
      pairServerUrl: '',
      pairServerCode: '',
      error: null,
    });
  });

  it('keyGenerated transitions to writing and stashes the mnemonic', () => {
    const patch = keyGenerated(KEY);
    expect(patch.stage).toBe('writing');
    expect(patch.generatedKey).toBe(KEY);
    expect(patch.challengeEntry).toBe('');
  });

  it('ackWritten moves to challenging with a cleared entry field', () => {
    const patch = ackWritten();
    expect(patch.stage).toBe('challenging');
    expect(patch.challengeEntry).toBe('');
  });

  it('challengeEntryChanged binds and clears error', () => {
    const patch = challengeEntryChanged('abandon');
    expect(patch.challengeEntry).toBe('abandon');
    expect(patch.error).toBeNull();
  });

  it('challengeFailed keeps user on challenging with the error', () => {
    const patch = challengeFailed('wrong');
    expect(patch.stage).toBe('challenging');
    expect(patch.error).toBe('wrong');
  });

  it('wrappingStarted moves to wrapping', () => {
    const patch = wrappingStarted();
    expect(patch.stage).toBe('wrapping');
  });

  it('setupCompleted moves to done and wipes generated key', () => {
    const patch = setupCompleted();
    expect(patch.stage).toBe('done');
    expect(patch.generatedKey).toBeNull();
    expect(patch.challengeEntry).toBe('');
  });

  it('setupReset returns to initial', () => {
    expect(setupReset()).toEqual(initialRecoverySetupSlice());
  });
});

// ────────────────────────────────────────────────────────────────
// Handlers — happy path
// ────────────────────────────────────────────────────────────────

describe('full happy path', () => {
  it('start → ackWritten → submitChallenge wraps and stores the check', async () => {
    const store = mkStateStore();
    const storage = mkStorage();
    const crypto = mkFakeCrypto();
    const h = createRecoverySetupHandlers({
      getSlice: store.getSlice,
      setState: store.setState,
      storage,
      crypto,
    });

    h.start();
    expect(store.getSlice().stage).toBe('writing');
    expect(store.getSlice().generatedKey).toBe(KEY);

    h.ackWritten();
    expect(store.getSlice().stage).toBe('challenging');

    h.setChallengeEntry(KEY);
    expect(store.getSlice().challengeEntry).toBe(KEY);

    await h.submitChallenge();

    // Final state is done, generated key wiped.
    expect(store.getSlice().stage).toBe('done');
    expect(store.getSlice().generatedKey).toBeNull();
    expect(store.getSlice().challengeEntry).toBe('');

    // Check blob persisted under the right key.
    expect(storage._backing.get(RECOVERY_CHECK_KEY)).toBe('check-blob');
    expect(await readRecoveryCheck(storage)).toBe('check-blob');
  });

  it('accepts case-insensitive re-entry with extra whitespace', async () => {
    const store = mkStateStore();
    const storage = mkStorage();
    const h = createRecoverySetupHandlers({
      getSlice: store.getSlice,
      setState: store.setState,
      storage,
      crypto: mkFakeCrypto({
        // Accept the mixed-case version as valid BIP39 for this test.
        isValid: () => true,
      }),
    });

    h.start();
    h.ackWritten();
    // User types with stray whitespace + uppercase — normalizer should
    // canonicalize both sides before comparing.
    h.setChallengeEntry(`  Abandon  Ability Able About ABOVE absent ABSORB abstract absurd abuse access accident account accuse achieve acid acoustic acquire across act action actor actress actual  `);

    await h.submitChallenge();
    expect(store.getSlice().stage).toBe('done');
  });
});

// ────────────────────────────────────────────────────────────────
// Handlers — failure paths
// ────────────────────────────────────────────────────────────────

describe('submitChallenge failure paths', () => {
  it('invalid BIP39 checksum surfaces a typo-focused error, no wrap', async () => {
    const store = mkStateStore();
    const storage = mkStorage();
    const crypto = mkFakeCrypto({ isValid: () => false });
    const kekSpy = vi.spyOn(crypto, 'deriveKek');
    const h = createRecoverySetupHandlers({
      getSlice: store.getSlice,
      setState: store.setState,
      storage,
      crypto,
    });

    h.start();
    h.ackWritten();
    h.setChallengeEntry('not even a mnemonic');
    await h.submitChallenge();

    expect(store.getSlice().stage).toBe('challenging');
    expect(store.getSlice().error).toMatch(/typos|valid 24-word/);
    expect(kekSpy).not.toHaveBeenCalled();
    expect(storage._backing.has(RECOVERY_CHECK_KEY)).toBe(false);
  });

  it('valid BIP39 but mismatches generated — surfaces "doesn\'t match"', async () => {
    const store = mkStateStore();
    const storage = mkStorage();
    const h = createRecoverySetupHandlers({
      getSlice: store.getSlice,
      setState: store.setState,
      storage,
      crypto: mkFakeCrypto(),
    });

    h.start();
    h.ackWritten();
    h.setChallengeEntry(WRONG_KEY);
    await h.submitChallenge();

    expect(store.getSlice().stage).toBe('challenging');
    expect(store.getSlice().error).toMatch(/doesn'?t match/);
    expect(storage._backing.has(RECOVERY_CHECK_KEY)).toBe(false);
  });

  it('post-wrap self-verify failure rolls back to challenging with an error', async () => {
    const store = mkStateStore();
    const storage = mkStorage();
    const h = createRecoverySetupHandlers({
      getSlice: store.getSlice,
      setState: store.setState,
      storage,
      crypto: mkFakeCrypto({ verifyCheck: async () => false }),
    });

    h.start();
    h.ackWritten();
    h.setChallengeEntry(KEY);
    await h.submitChallenge();

    expect(store.getSlice().stage).toBe('challenging');
    expect(store.getSlice().error).toMatch(/round-trip/);
    expect(storage._backing.has(RECOVERY_CHECK_KEY)).toBe(false);
  });

  it('storage write failure surfaces as challenge error, does not leave half-state', async () => {
    const store = mkStateStore();
    const broken: RecoveryCheckStorage = {
      async get() { return {}; },
      async set() { throw new Error('disk full'); },
      async remove() {},
    };
    const h = createRecoverySetupHandlers({
      getSlice: store.getSlice,
      setState: store.setState,
      storage: broken,
      crypto: mkFakeCrypto(),
    });

    h.start();
    h.ackWritten();
    h.setChallengeEntry(KEY);
    await h.submitChallenge();

    expect(store.getSlice().stage).toBe('challenging');
    expect(store.getSlice().error).toMatch(/disk full/);
  });
});

// ────────────────────────────────────────────────────────────────
// Handlers — guards + reset
// ────────────────────────────────────────────────────────────────

describe('guards', () => {
  it('ackWritten before start is a no-op (double-click safety)', () => {
    const store = mkStateStore();
    const storage = mkStorage();
    const h = createRecoverySetupHandlers({
      getSlice: store.getSlice,
      setState: store.setState,
      storage,
      crypto: mkFakeCrypto(),
    });

    h.ackWritten();
    expect(store.getSlice().stage).toBe('idle');
  });

  it('submitChallenge in the wrong stage is a no-op', async () => {
    const store = mkStateStore(); // starts idle
    const storage = mkStorage();
    const h = createRecoverySetupHandlers({
      getSlice: store.getSlice,
      setState: store.setState,
      storage,
      crypto: mkFakeCrypto(),
    });

    h.setChallengeEntry(KEY);
    await h.submitChallenge();

    // No transition, no storage write.
    expect(store.getSlice().stage).toBe('idle');
    expect(storage._backing.has(RECOVERY_CHECK_KEY)).toBe(false);
  });

  it('submitChallenge without a generated key is a no-op', async () => {
    // Force an inconsistent state: challenging stage but no key.
    const store = mkStateStore({
      stage: 'challenging',
      generatedKey: null,
      challengeEntry: KEY,
      pairServerUrl: '',
      pairServerCode: '',
      error: null,
    });
    const storage = mkStorage();
    const h = createRecoverySetupHandlers({
      getSlice: store.getSlice,
      setState: store.setState,
      storage,
      crypto: mkFakeCrypto(),
    });

    await h.submitChallenge();
    expect(storage._backing.has(RECOVERY_CHECK_KEY)).toBe(false);
  });
});

describe('onCompleted hook (composed flows like setup-then-pair)', () => {
  it('invokes onCompleted with the verified key, then transitions to done', async () => {
    const store = mkStateStore();
    const storage = mkStorage();
    const seen: string[] = [];
    const stages: string[] = [];
    const h = createRecoverySetupHandlers({
      getSlice: store.getSlice,
      setState: (patch) => {
        if (patch.stage) stages.push(patch.stage);
        store.setState(patch);
      },
      storage,
      crypto: mkFakeCrypto(),
      onCompleted: async (key) => { seen.push(key); },
    });

    h.start();
    h.ackWritten();
    h.setChallengeEntry(KEY);
    await h.submitChallenge();

    // Key was passed to the hook.
    expect(seen).toEqual([KEY]);
    // Stage walked through finalizing on the way to done.
    expect(stages).toContain('finalizing');
    expect(store.getSlice().stage).toBe('done');
    // Generated key wiped post-completion.
    expect(store.getSlice().generatedKey).toBeNull();
    // Check is still persisted (the follow-up succeeded).
    expect(await readRecoveryCheck(storage)).toBe('check-blob');
  });

  it('onCompleted rejection surfaces as challenge error, but the check stays saved', async () => {
    const store = mkStateStore();
    const storage = mkStorage();
    const h = createRecoverySetupHandlers({
      getSlice: store.getSlice,
      setState: store.setState,
      storage,
      crypto: mkFakeCrypto(),
      onCompleted: async () => { throw new Error('pair failed'); },
    });

    h.start();
    h.ackWritten();
    h.setChallengeEntry(KEY);
    await h.submitChallenge();

    // Lands in `done` with error preserved — NOT back on `challenging`,
    // because the challenge form without a generatedKey would
    // re-render but every submit would silently no-op. The host
    // renders the warning variant when slice.error is set.
    expect(store.getSlice().stage).toBe('done');
    expect(store.getSlice().error).toMatch(/Setup saved.*follow-up step failed.*pair failed/);
    // Crucially: the check IS persisted — setup succeeded, only the
    // follow-on op failed. User can retry the pair from the surface
    // that triggered it.
    expect(await readRecoveryCheck(storage)).toBe('check-blob');
    // Key material must be wiped even on follow-up failure — the
    // docstring promises "On reject, the key is wiped anyway" and a
    // stale generatedKey would re-render the 24 words into the
    // challenge grid on the next paint.
    expect(store.getSlice().generatedKey).toBeNull();
    expect(store.getSlice().challengeEntry).toBe('');
  });

  it('without onCompleted, behaves identically to the original flow (no finalizing stage)', async () => {
    const store = mkStateStore();
    const storage = mkStorage();
    const stages: string[] = [];
    const h = createRecoverySetupHandlers({
      getSlice: store.getSlice,
      setState: (patch) => {
        if (patch.stage) stages.push(patch.stage);
        store.setState(patch);
      },
      storage,
      crypto: mkFakeCrypto(),
      // no onCompleted
    });

    h.start();
    h.ackWritten();
    h.setChallengeEntry(KEY);
    await h.submitChallenge();

    expect(store.getSlice().stage).toBe('done');
    expect(stages).not.toContain('finalizing');
  });
});

describe('reset', () => {
  it('reset from writing wipes the generated key', () => {
    const store = mkStateStore();
    const storage = mkStorage();
    const h = createRecoverySetupHandlers({
      getSlice: store.getSlice,
      setState: store.setState,
      storage,
      crypto: mkFakeCrypto(),
    });

    h.start();
    expect(store.getSlice().generatedKey).toBe(KEY);

    h.reset();
    expect(store.getSlice()).toEqual(initialRecoverySetupSlice());
  });

  it('reset from challenging wipes both generated and entered', () => {
    const store = mkStateStore();
    const storage = mkStorage();
    const h = createRecoverySetupHandlers({
      getSlice: store.getSlice,
      setState: store.setState,
      storage,
      crypto: mkFakeCrypto(),
    });

    h.start();
    h.ackWritten();
    h.setChallengeEntry(KEY);

    h.reset();
    expect(store.getSlice()).toEqual(initialRecoverySetupSlice());
  });
});
