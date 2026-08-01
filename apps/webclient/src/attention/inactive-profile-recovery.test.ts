import { describe, expect, it, vi } from 'vitest';

import {
  INACTIVE_PROFILE_RECOVERY_HINT_KEY_PREFIX,
  INACTIVE_PROFILE_RECOVERY_REVIEW_SESSION_KEY,
  createBrowserInactiveProfileRecoveryDiscovery,
  createInactiveProfileRecoveryReviewContinuity,
  type InactiveProfileRecoveryStorage,
} from './inactive-profile-recovery.js';

class MemoryStorage implements InactiveProfileRecoveryStorage {
  readonly values = new Map<string, string>();
  denyReads = false;
  denyWrites = false;

  get length(): number {
    return this.values.size;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    if (this.denyReads) throw new Error('read denied');
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.denyWrites) throw new Error('write denied');
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    if (this.denyWrites) throw new Error('write denied');
    this.values.delete(key);
  }
}

const fakeDocument = () => {
  const windowListeners = new Map<string, Set<(event: unknown) => void>>();
  const documentListeners = new Map<string, Set<(event: unknown) => void>>();
  const add = (
    map: Map<string, Set<(event: unknown) => void>>,
    type: string,
    listener: (event: unknown) => void,
  ): void => {
    const listeners = map.get(type) ?? new Set();
    listeners.add(listener);
    map.set(type, listeners);
  };
  const remove = (
    map: Map<string, Set<(event: unknown) => void>>,
    type: string,
    listener: (event: unknown) => void,
  ): void => {
    map.get(type)?.delete(listener);
  };
  const view = {
    addEventListener: (type: string, listener: (event: unknown) => void) =>
      add(windowListeners, type, listener),
    removeEventListener: (type: string, listener: (event: unknown) => void) =>
      remove(windowListeners, type, listener),
  };
  const document = {
    defaultView: view,
    visibilityState: 'visible',
    addEventListener: (type: string, listener: (event: unknown) => void) =>
      add(documentListeners, type, listener),
    removeEventListener: (type: string, listener: (event: unknown) => void) =>
      remove(documentListeners, type, listener),
  } as unknown as Document;
  return {
    document,
    fireWindow(type: string, event: unknown = {}): void {
      for (const listener of [...(windowListeners.get(type) ?? [])]) {
        listener(event);
      }
    },
    fireDocument(type: string, event: unknown = {}): void {
      for (const listener of [...(documentListeners.get(type) ?? [])]) {
        listener(event);
      }
    },
  };
};

describe('inactive profile recovery discovery', () => {
  it('persists only profile-level availability and reads roster-bound positive hints', () => {
    const storage = new MemoryStorage();
    const discovery = createBrowserInactiveProfileRecoveryDiscovery({
      storage,
      now: () => 10_000,
    });

    expect(discovery.record({
      profileId: 'profile-home',
      hasRecoveries: true,
      observedAt: 9_000,
    })).toBe(true);
    expect(discovery.read(['profile-home', 'profile-office'])).toEqual([{
      profileId: 'profile-home',
      observedAt: 9_000,
    }]);

    const storedKey = [...storage.values.keys()].find((key) =>
      key.startsWith(
        `${INACTIVE_PROFILE_RECOVERY_HINT_KEY_PREFIX}profile-home:`,
      ));
    const raw = storedKey === undefined
      ? undefined
      : storage.values.get(storedKey);
    expect(JSON.parse(raw ?? '')).toEqual({
      version: 1,
      profile_id: 'profile-home',
      has_recoveries: true,
      observed_at: 9_000,
    });
    expect(raw).not.toContain('gmail');
    expect(raw).not.toContain('connection');
    expect(raw).not.toContain('server_url');
    discovery.close();
  });

  it('lets a newer all-clear tombstone win and rejects an older late response', () => {
    const storage = new MemoryStorage();
    const discovery = createBrowserInactiveProfileRecoveryDiscovery({
      storage,
      now: () => 1_000,
    });

    expect(discovery.record({
      profileId: 'profile-home',
      hasRecoveries: true,
      observedAt: 100,
    })).toBe(true);
    expect(discovery.record({
      profileId: 'profile-home',
      hasRecoveries: false,
      observedAt: 200,
    })).toBe(true);
    expect(discovery.record({
      profileId: 'profile-home',
      hasRecoveries: true,
      observedAt: 150,
    })).toBe(false);
    expect(discovery.record({
      profileId: 'profile-home',
      hasRecoveries: true,
      observedAt: 200,
    })).toBe(false);
    expect(discovery.read(['profile-home'])).toEqual([]);
    discovery.close();
  });

  it('purges every observation when a profile leaves the local roster', () => {
    const storage = new MemoryStorage();
    const discovery = createBrowserInactiveProfileRecoveryDiscovery({
      storage,
      now: () => 1_000,
    });
    expect(discovery.record({
      profileId: 'profile-home',
      hasRecoveries: true,
      observedAt: 100,
    })).toBe(true);
    storage.values.set(
      `${INACTIVE_PROFILE_RECOVERY_HINT_KEY_PREFIX}profile-home`,
      JSON.stringify({
        version: 1,
        profile_id: 'profile-home',
        has_recoveries: false,
        observed_at: 90,
      }),
    );
    const changed = vi.fn();
    discovery.subscribe(changed);

    expect(discovery.purge('profile-home')).toBe(true);
    expect([...storage.values.keys()].filter((key) =>
      key.startsWith(
        `${INACTIVE_PROFILE_RECOVERY_HINT_KEY_PREFIX}profile-home`,
      ))).toEqual([]);
    expect(discovery.read(['profile-home'])).toEqual([]);
    expect(changed).toHaveBeenCalledOnce();
    expect(discovery.record({
      profileId: 'profile-home',
      hasRecoveries: true,
      observedAt: 200,
    })).toBe(false);
    expect(storage.values.size).toBe(0);
    discovery.close();
  });

  it('re-purges a sibling late response after the local roster forget boundary', () => {
    const storage = new MemoryStorage();
    const browser = fakeDocument();
    const discovery = createBrowserInactiveProfileRecoveryDiscovery({
      document: browser.document,
      storage,
      now: () => 1_000,
    });
    expect(discovery.purge('profile-home')).toBe(true);
    const lateKey =
      `${INACTIVE_PROFILE_RECOVERY_HINT_KEY_PREFIX}profile-home:200:1`;
    storage.values.set(lateKey, JSON.stringify({
      version: 1,
      profile_id: 'profile-home',
      has_recoveries: true,
      observed_at: 200,
    }));

    browser.fireWindow('storage', { key: lateKey });
    expect(storage.values.has(lateKey)).toBe(false);
    storage.values.set(lateKey, JSON.stringify({
      version: 1,
      profile_id: 'profile-home',
      has_recoveries: true,
      observed_at: 200,
    }));
    browser.fireWindow('focus');
    expect(storage.values.has(lateKey)).toBe(false);
    expect(discovery.read(['profile-home'])).toEqual([]);
    discovery.close();
  });

  it('keeps the newer cross-tab observation when both writers read before either write', () => {
    const storage = new MemoryStorage();
    const older = createBrowserInactiveProfileRecoveryDiscovery({
      storage,
      now: () => 1_000,
    });
    const newer = createBrowserInactiveProfileRecoveryDiscovery({
      storage,
      now: () => 1_000,
    });
    const originalSet = storage.setItem.bind(storage);
    let interleaved = false;
    storage.setItem = (key: string, value: string): void => {
      if (!interleaved) {
        interleaved = true;
        expect(newer.record({
          profileId: 'profile-home',
          hasRecoveries: false,
          observedAt: 200,
        })).toBe(true);
      }
      originalSet(key, value);
    };

    expect(older.record({
      profileId: 'profile-home',
      hasRecoveries: true,
      observedAt: 100,
    })).toBe(false);
    expect(older.read(['profile-home'])).toEqual([]);
    expect([...storage.values.values()]).toEqual([
      JSON.stringify({
        version: 1,
        profile_id: 'profile-home',
        has_recoveries: false,
        observed_at: 200,
      }),
    ]);
    older.close();
    newer.close();
  });

  it('drops malformed, future, expired, and off-roster hints', () => {
    const storage = new MemoryStorage();
    storage.values.set(
      `${INACTIVE_PROFILE_RECOVERY_HINT_KEY_PREFIX}profile-malformed`,
      JSON.stringify({
        version: 1,
        profile_id: 'profile-malformed',
        has_recoveries: true,
        observed_at: 9_500,
        connection_name: 'must-not-survive',
      }),
    );
    storage.values.set(
      `${INACTIVE_PROFILE_RECOVERY_HINT_KEY_PREFIX}profile-future`,
      JSON.stringify({
        version: 1,
        profile_id: 'profile-future',
        has_recoveries: true,
        observed_at: 12_000,
      }),
    );
    storage.values.set(
      `${INACTIVE_PROFILE_RECOVERY_HINT_KEY_PREFIX}profile-expired`,
      JSON.stringify({
        version: 1,
        profile_id: 'profile-expired',
        has_recoveries: true,
        observed_at: 1_000,
      }),
    );
    storage.values.set(
      `${INACTIVE_PROFILE_RECOVERY_HINT_KEY_PREFIX}profile-unlisted`,
      JSON.stringify({
        version: 1,
        profile_id: 'profile-unlisted',
        has_recoveries: true,
        observed_at: 9_500,
      }),
    );
    storage.values.set(
      `${INACTIVE_PROFILE_RECOVERY_HINT_KEY_PREFIX}profile-orphan:1000:1`,
      JSON.stringify({
        version: 1,
        profile_id: 'profile-orphan',
        has_recoveries: true,
        observed_at: 1_000,
      }),
    );
    const discovery = createBrowserInactiveProfileRecoveryDiscovery({
      storage,
      now: () => 10_000,
      maxAgeMs: 2_000,
    });

    expect(discovery.read([
      'profile-malformed',
      'profile-future',
      'profile-expired',
    ])).toEqual([]);
    expect(storage.values.has(
      `${INACTIVE_PROFILE_RECOVERY_HINT_KEY_PREFIX}profile-malformed`,
    )).toBe(false);
    expect(storage.values.has(
      `${INACTIVE_PROFILE_RECOVERY_HINT_KEY_PREFIX}profile-future`,
    )).toBe(false);
    expect(storage.values.has(
      `${INACTIVE_PROFILE_RECOVERY_HINT_KEY_PREFIX}profile-expired`,
    )).toBe(false);
    expect(storage.values.has(
      `${INACTIVE_PROFILE_RECOVERY_HINT_KEY_PREFIX}profile-unlisted`,
    )).toBe(true);
    expect(storage.values.has(
      `${INACTIVE_PROFILE_RECOVERY_HINT_KEY_PREFIX}profile-orphan:1000:1`,
    )).toBe(false);
    discovery.close();
  });

  it('reconciles sibling storage, focus, and visibility hints without payload authority', () => {
    const storage = new MemoryStorage();
    const browser = fakeDocument();
    const discovery = createBrowserInactiveProfileRecoveryDiscovery({
      document: browser.document,
      storage,
      now: () => 10_000,
    });
    const changed = vi.fn();
    discovery.subscribe(changed);

    discovery.record({
      profileId: 'profile-home',
      hasRecoveries: true,
      observedAt: 9_000,
    });
    browser.fireWindow('storage', {
      key: `${INACTIVE_PROFILE_RECOVERY_HINT_KEY_PREFIX}profile-home`,
      newValue: '{not trusted directly}',
    });
    browser.fireWindow('storage', { key: null });
    browser.fireWindow('focus');
    browser.fireDocument('visibilitychange');
    expect(changed).toHaveBeenCalledTimes(5);

    discovery.close();
    browser.fireWindow('focus');
    expect(changed).toHaveBeenCalledTimes(5);
  });

  it('degrades to no discovery when persistent storage is denied', () => {
    const storage = new MemoryStorage();
    storage.denyWrites = true;
    const discovery = createBrowserInactiveProfileRecoveryDiscovery({
      storage,
      now: () => 10_000,
    });
    expect(discovery.record({
      profileId: 'profile-home',
      hasRecoveries: true,
      observedAt: 9_000,
    })).toBe(false);
    storage.denyReads = true;
    expect(discovery.read(['profile-home'])).toEqual([]);
    discovery.close();
  });

  it('uses the safe single-key fallback when a storage shim cannot enumerate', () => {
    const storage = new MemoryStorage();
    storage.key = () => { throw new Error('enumeration denied'); };
    const discovery = createBrowserInactiveProfileRecoveryDiscovery({
      storage,
      now: () => 10_000,
    });

    expect(discovery.record({
      profileId: 'profile-home',
      hasRecoveries: true,
      observedAt: 9_000,
    })).toBe(true);
    expect(storage.values.has(
      `${INACTIVE_PROFILE_RECOVERY_HINT_KEY_PREFIX}profile-home`,
    )).toBe(true);
    expect(discovery.read(['profile-home'])).toEqual([{
      profileId: 'profile-home',
      observedAt: 9_000,
    }]);
    discovery.close();
  });
});

describe('inactive profile recovery review continuity', () => {
  it('preserves an exact target until that profile receives a valid recheck', () => {
    const storage = new MemoryStorage();
    const continuity = createInactiveProfileRecoveryReviewContinuity({
      storage,
      now: () => 10_000,
    });

    expect(continuity.arm('profile-home')).toBe(true);
    expect(continuity.readForProfile('profile-office')).toBeNull();
    expect(continuity.readForProfile('profile-home')).toEqual({
      targetProfileId: 'profile-home',
      startedAt: 10_000,
    });
    continuity.retire('profile-office');
    expect(continuity.readForProfile('profile-home')).not.toBeNull();
    continuity.retire('profile-home');
    expect(continuity.readForProfile('profile-home')).toBeNull();
  });

  it('retires malformed, future, and expired review markers without replay', () => {
    const storage = new MemoryStorage();
    const continuity = createInactiveProfileRecoveryReviewContinuity({
      storage,
      now: () => 10_000,
      maxAgeMs: 2_000,
    });
    const put = (value: unknown): void => {
      storage.values.set(
        INACTIVE_PROFILE_RECOVERY_REVIEW_SESSION_KEY,
        JSON.stringify(value),
      );
    };

    put({
      version: 1,
      target_profile_id: 'profile-home',
      started_at: 7_000,
    });
    expect(continuity.readForProfile('profile-home')).toBeNull();
    expect(storage.values.has(
      INACTIVE_PROFILE_RECOVERY_REVIEW_SESSION_KEY,
    )).toBe(false);

    put({
      version: 1,
      target_profile_id: 'profile-home',
      started_at: 12_000,
    });
    expect(continuity.readForProfile('profile-home')).toBeNull();

    put({
      version: 1,
      target_profile_id: 'profile-home',
      started_at: 9_000,
      connection_name: 'must-not-survive',
    });
    expect(continuity.readForProfile('profile-home')).toBeNull();
  });

  it('keeps a scrubbed recovery excursion through repair and unlocks return only after all-clear', () => {
    const storage = new MemoryStorage();
    let now = 10_000;
    const continuity = createInactiveProfileRecoveryReviewContinuity({
      storage,
      now: () => now,
    });

    expect(continuity.armExcursion({
      sourceProfileId: 'profile-home',
      targetProfileId: 'profile-office',
      returnHash: '#connections/mail',
    })).toBe(true);
    expect(continuity.readForProfile('profile-office')).toEqual({
      targetProfileId: 'profile-office',
      sourceProfileId: 'profile-home',
      returnHash: '#connections/mail',
      phase: 'switching',
      startedAt: 10_000,
    });

    now = 20_000;
    expect(continuity.recordSnapshot('profile-office', true)).toEqual({
      targetProfileId: 'profile-office',
      sourceProfileId: 'profile-home',
      returnHash: '#connections/mail',
      phase: 'recovering',
      startedAt: 10_000,
    });
    expect(continuity.readForProfile('profile-office')).toMatchObject({
      phase: 'recovering',
    });

    now = 30_000;
    expect(continuity.recordSnapshot('profile-office', false)).toMatchObject({
      phase: 'return_ready',
    });
    expect(JSON.parse(storage.values.get(
      INACTIVE_PROFILE_RECOVERY_REVIEW_SESSION_KEY,
    ) ?? '{}')).toEqual({
      version: 2,
      source_profile_id: 'profile-home',
      target_profile_id: 'profile-office',
      return_hash: '#connections/mail',
      phase: 'return_ready',
      started_at: 10_000,
    });
  });

  it('preserves only a privacy-safe context posture across a recovery excursion', () => {
    const storage = new MemoryStorage();
    const continuity = createInactiveProfileRecoveryReviewContinuity({
      storage,
      now: () => 10_000,
    });

    expect(continuity.armExcursion({
      sourceProfileId: 'profile-home',
      targetProfileId: 'profile-office',
      returnHash: '#chat',
      returnContext: 'detail_withheld',
    })).toBe(true);
    expect(continuity.readForProfile('profile-office')).toMatchObject({
      returnContext: 'detail_withheld',
      phase: 'switching',
    });
    expect(continuity.recordSnapshot('profile-office', false)).toMatchObject({
      returnContext: 'detail_withheld',
      phase: 'return_ready',
    });

    const raw = storage.values.get(
      INACTIVE_PROFILE_RECOVERY_REVIEW_SESSION_KEY,
    ) ?? '';
    expect(JSON.parse(raw)).toEqual({
      version: 3,
      source_profile_id: 'profile-home',
      target_profile_id: 'profile-office',
      return_hash: '#chat',
      return_context: 'detail_withheld',
      phase: 'return_ready',
      started_at: 10_000,
    });
    expect(raw).not.toContain('thread');
    expect(raw).not.toContain('draft');
  });

  it('rejects raw detail routes and retires malformed excursion payloads', () => {
    const storage = new MemoryStorage();
    const continuity = createInactiveProfileRecoveryReviewContinuity({
      storage,
      now: () => 10_000,
    });

    expect(continuity.armExcursion({
      sourceProfileId: 'profile-home',
      targetProfileId: 'profile-office',
      returnHash: '#connections/mail/account-secret',
    })).toBe(false);
    expect(storage.values.size).toBe(0);

    expect(continuity.armExcursion({
      sourceProfileId: 'profile-home',
      targetProfileId: 'profile-office',
      returnHash: '#connections/mail',
      returnContext: 'account-secret' as never,
    })).toBe(false);
    expect(storage.values.size).toBe(0);

    storage.values.set(
      INACTIVE_PROFILE_RECOVERY_REVIEW_SESSION_KEY,
      JSON.stringify({
        version: 2,
        source_profile_id: 'profile-home',
        target_profile_id: 'profile-office',
        return_hash: '#chat/thread-secret',
        phase: 'return_ready',
        started_at: 9_000,
      }),
    );
    expect(continuity.readForProfile('profile-office')).toBeNull();
    expect(storage.values.has(
      INACTIVE_PROFILE_RECOVERY_REVIEW_SESSION_KEY,
    )).toBe(false);
  });

  it('keeps an excursion across a longer repair window but expires it after one day', () => {
    const storage = new MemoryStorage();
    let now = 1_000;
    const continuity = createInactiveProfileRecoveryReviewContinuity({
      storage,
      now: () => now,
    });
    continuity.armExcursion({
      sourceProfileId: 'profile-home',
      targetProfileId: 'profile-office',
      returnHash: '#chat',
    });

    now += 31 * 60 * 1_000;
    expect(continuity.readForProfile('profile-office')).not.toBeNull();
    now = 1_000 + 24 * 60 * 60 * 1_000 + 1;
    expect(continuity.readForProfile('profile-office')).toBeNull();
  });
});
