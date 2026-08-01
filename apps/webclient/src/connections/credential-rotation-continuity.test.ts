import { describe, expect, it } from 'vitest';

import {
  CREDENTIAL_ROTATION_CONTINUITY_SESSION_KEY,
  createCredentialRotationContinuityStore,
  type CredentialRotationContinuityStorage,
} from './credential-rotation-continuity.js';

const ATTEMPT_A = 'rotation-continuity-test-0001';
const ATTEMPT_B = 'rotation-continuity-test-0002';

const memoryStorage = () => {
  const values = new Map<string, string>();
  const storage: CredentialRotationContinuityStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
  return { storage, values };
};

describe('credential rotation continuity', () => {
  it('persists only the opaque attempt, identity, and non-secret baseline revision', () => {
    const { storage, values } = memoryStorage();
    const store = createCredentialRotationContinuityStore({
      storage,
      scopeId: 'profile-a',
      now: () => 1_000,
    });

    expect(store.write({
      attemptId: ATTEMPT_A,
      kind: 'api',
      name: 'hubspot',
      baselineUpdatedAt: 900,
    })).toBe('stored');
    expect(store.read()).toEqual({
      attemptId: ATTEMPT_A,
      kind: 'api',
      name: 'hubspot',
      startedAt: 1_000,
      baselineUpdatedAt: 900,
    });

    const raw = values.get(CREDENTIAL_ROTATION_CONTINUITY_SESSION_KEY)!;
    expect(JSON.parse(raw)).toEqual({
      version: 3,
      scope_id: 'profile-a',
      attempt_id: ATTEMPT_A,
      kind: 'api',
      name: 'hubspot',
      started_at: 1_000,
      baseline_updated_at: 900,
      successor_observed_at: null,
    });
    expect(raw).not.toMatch(/token|secret|password|auth|config|value/i);
  });

  it('persists a secret-free successor observation and restores it after reload', () => {
    const { storage, values } = memoryStorage();
    let now = 1_000;
    const firstMount = createCredentialRotationContinuityStore({
      storage,
      scopeId: 'profile-a',
      now: () => now,
    });
    expect(firstMount.write({
      attemptId: ATTEMPT_A,
      kind: 'api',
      name: 'hubspot',
      baselineUpdatedAt: 900,
    })).toBe('stored');

    now = 1_200;
    expect(firstMount.markSuccessorObserved(ATTEMPT_B)).toBe('missing');
    expect(firstMount.markSuccessorObserved(ATTEMPT_A)).toBe('stored');

    const secondMount = createCredentialRotationContinuityStore({
      storage,
      scopeId: 'profile-a',
      now: () => 1_300,
    });
    expect(secondMount.read()).toEqual({
      attemptId: ATTEMPT_A,
      kind: 'api',
      name: 'hubspot',
      startedAt: 1_000,
      baselineUpdatedAt: 900,
      successorObservedAt: 1_200,
    });
    const raw = values.get(CREDENTIAL_ROTATION_CONTINUITY_SESSION_KEY)!;
    expect(JSON.parse(raw)).toMatchObject({
      version: 3,
      successor_observed_at: 1_200,
    });
    expect(raw).not.toMatch(/token|secret|password|auth|config|value/i);
  });

  it('reads V2 markers and upgrades them when a successor is observed', () => {
    const { storage, values } = memoryStorage();
    values.set(CREDENTIAL_ROTATION_CONTINUITY_SESSION_KEY, JSON.stringify({
      version: 2,
      scope_id: 'profile-a',
      attempt_id: ATTEMPT_A,
      kind: 'api',
      name: 'hubspot',
      started_at: 1_000,
      baseline_updated_at: 900,
    }));
    const store = createCredentialRotationContinuityStore({
      storage,
      scopeId: 'profile-a',
      now: () => 1_500,
    });

    expect(store.read()).toEqual({
      attemptId: ATTEMPT_A,
      kind: 'api',
      name: 'hubspot',
      startedAt: 1_000,
      baselineUpdatedAt: 900,
    });
    expect(store.markSuccessorObserved(ATTEMPT_A)).toBe('stored');
    expect(store.read()?.successorObservedAt).toBe(1_500);
    expect(JSON.parse(values.get(
      CREDENTIAL_ROTATION_CONTINUITY_SESSION_KEY,
    )!)).toMatchObject({
      version: 3,
      baseline_updated_at: 900,
      successor_observed_at: 1_500,
    });
  });

  it('does not overwrite an unresolved attempt, including another profile', () => {
    const { storage } = memoryStorage();
    const profileA = createCredentialRotationContinuityStore({
      storage,
      scopeId: 'profile-a',
      now: () => 1_000,
    });
    const profileB = createCredentialRotationContinuityStore({
      storage,
      scopeId: 'profile-b',
      now: () => 1_100,
    });

    expect(profileA.write({
      attemptId: ATTEMPT_A,
      kind: 'api',
      name: 'hubspot',
    })).toBe('stored');
    expect(profileB.read()).toBeNull();
    expect(profileB.write({
      attemptId: ATTEMPT_B,
      kind: 'mcp',
      name: 'github',
    })).toBe('occupied');
    expect(profileA.read()?.attemptId).toBe(ATTEMPT_A);
  });

  it('retires only the matching attempt and makes it inert before removal', () => {
    const { storage, values } = memoryStorage();
    const store = createCredentialRotationContinuityStore({
      storage,
      scopeId: 'profile-a',
      now: () => 1_000,
    });
    expect(store.write({
      attemptId: ATTEMPT_A,
      kind: 'api',
      name: 'hubspot',
    })).toBe('stored');

    store.retire(ATTEMPT_B);
    expect(store.read()?.attemptId).toBe(ATTEMPT_A);
    store.retire(ATTEMPT_A);
    expect(store.read()).toBeNull();
    expect(values.has(CREDENTIAL_ROTATION_CONTINUITY_SESSION_KEY)).toBe(false);
  });

  it('drops malformed and expired markers instead of replaying them', () => {
    const { storage, values } = memoryStorage();
    values.set(CREDENTIAL_ROTATION_CONTINUITY_SESSION_KEY, '{"token":"leak"}');
    const store = createCredentialRotationContinuityStore({
      storage,
      scopeId: 'profile-a',
      now: () => 10_000,
      maxAgeMs: 500,
    });
    expect(store.read()).toBeNull();
    expect(values.has(CREDENTIAL_ROTATION_CONTINUITY_SESSION_KEY)).toBe(false);

    values.set(CREDENTIAL_ROTATION_CONTINUITY_SESSION_KEY, JSON.stringify({
      version: 1,
      scope_id: 'profile-a',
      attempt_id: ATTEMPT_A,
      kind: 'api',
      name: 'hubspot',
      started_at: 1_000,
    }));
    expect(store.read()).toBeNull();
    expect(values.has(CREDENTIAL_ROTATION_CONTINUITY_SESSION_KEY)).toBe(false);
  });

  it('does not age out an unresolved production marker on an arbitrary deadline', () => {
    const { storage, values } = memoryStorage();
    values.set(CREDENTIAL_ROTATION_CONTINUITY_SESSION_KEY, JSON.stringify({
      version: 1,
      scope_id: 'profile-a',
      attempt_id: ATTEMPT_A,
      kind: 'api',
      name: 'hubspot',
      started_at: 1_000,
    }));
    const store = createCredentialRotationContinuityStore({
      storage,
      scopeId: 'profile-a',
      now: () => 365 * 24 * 60 * 60 * 1_000,
    });

    expect(store.read()?.attemptId).toBe(ATTEMPT_A);
    expect(values.has(CREDENTIAL_ROTATION_CONTINUITY_SESSION_KEY)).toBe(true);
  });

  it('fails closed when storage is unavailable', () => {
    const store = createCredentialRotationContinuityStore({
      storage: null,
      scopeId: 'profile-a',
    });
    expect(store.write({
      attemptId: ATTEMPT_A,
      kind: 'api',
      name: 'hubspot',
    })).toBe('unavailable');
    expect(store.markSuccessorObserved(ATTEMPT_A)).toBe('unavailable');
    expect(store.read()).toBeNull();
  });

  it('does not overwrite a marker when storage cannot be read', () => {
    let writes = 0;
    const store = createCredentialRotationContinuityStore({
      storage: {
        getItem: () => { throw new Error('read denied'); },
        setItem: () => { writes += 1; },
        removeItem: () => undefined,
      },
      scopeId: 'profile-a',
    });
    expect(store.write({
      attemptId: ATTEMPT_A,
      kind: 'api',
      name: 'hubspot',
    })).toBe('unavailable');
    expect(writes).toBe(0);
  });
});
