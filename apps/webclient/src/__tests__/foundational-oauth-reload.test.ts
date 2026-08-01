import { describe, expect, it } from 'vitest';

import {
  createFoundationalOAuthReloadStore,
  type FoundationalOAuthContinuityStorage,
} from '../connections/foundational-oauth-reload.js';

const NOW = 1_800_000_000_000;

const memoryStorage = () => {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
    data,
  };
};

const writeGmail = (
  storage: FoundationalOAuthContinuityStorage,
  over: Partial<Parameters<ReturnType<typeof createFoundationalOAuthReloadStore>['write']>[0]> = {},
) => createFoundationalOAuthReloadStore({
  storage,
  scopeId: 'profile-office',
  now: () => NOW,
}).write({
  lane: 'mail',
  providerId: 'gmail',
  slug: 'work',
  accountValues: {
    name: 'work',
    send_enabled: 'false',
  },
  clientId: 'PUBLIC-CLIENT-ID',
  phase: 'before_exchange',
  phaseStartedAt: NOW,
  ...over,
});

describe('foundational OAuth reload marker', () => {
  it('round-trips only closed-list setup context and consumes it once', () => {
    const storage = memoryStorage();
    expect(writeGmail(storage)).toBe(true);

    const raw = [...storage.data.values()][0] ?? '';
    expect(raw).toContain('PUBLIC-CLIENT-ID');
    expect(raw).toContain('send_enabled');
    expect(raw).not.toContain('client_secret');
    expect(raw).not.toContain('authorization_code');
    expect(raw).not.toContain('oauth_state');
    expect(raw).not.toContain('https://');

    const reader = createFoundationalOAuthReloadStore({
      storage,
      scopeId: 'profile-office',
      now: () => NOW + 1,
    });
    expect(reader.consume()).toEqual({
      lane: 'mail',
      providerId: 'gmail',
      providerLabel: 'Gmail',
      issuer: 'google',
      slug: 'work',
      returnHref: '#connections/mail',
      accountValues: { name: 'work', send_enabled: 'false' },
      clientId: 'PUBLIC-CLIENT-ID',
      phase: 'before_exchange',
      phaseStartedAt: NOW,
    });
    expect(reader.consume()).toBeNull();
  });

  it('drops unknown fields and rejects stale entries or another server profile', () => {
    const unknown = memoryStorage();
    expect(writeGmail(unknown, {
      accountValues: { name: 'work', future_secret: 'must-not-persist' },
    })).toBe(true);
    expect([...unknown.data.values()][0]).not.toContain('future_secret');
    expect([...unknown.data.values()][0]).not.toContain('must-not-persist');

    const stale = memoryStorage();
    expect(writeGmail(stale, { phaseStartedAt: NOW - 31 * 60 * 1_000 })).toBe(true);
    expect(createFoundationalOAuthReloadStore({
      storage: stale,
      scopeId: 'profile-office',
      now: () => NOW,
    }).consume()).toBeNull();
    expect(stale.data.size).toBe(0);

    const otherProfile = memoryStorage();
    expect(writeGmail(otherProfile)).toBe(true);
    expect(createFoundationalOAuthReloadStore({
      storage: otherProfile,
      scopeId: 'profile-personal',
      now: () => NOW,
    }).consume()).toBeNull();
    expect(otherProfile.data.size).toBe(0);
  });

  it('makes a denied remove one-shot, and ignores a marker it cannot retire', () => {
    const backing = memoryStorage();
    expect(writeGmail(backing)).toBe(true);
    const deniedRemove: FoundationalOAuthContinuityStorage = {
      getItem: backing.getItem,
      setItem: backing.setItem,
      removeItem: () => { throw new Error('denied'); },
    };
    const reader = createFoundationalOAuthReloadStore({
      storage: deniedRemove,
      scopeId: 'profile-office',
      now: () => NOW,
    });
    expect(reader.consume()).toMatchObject({ slug: 'work' });
    expect(reader.consume()).toBeNull();

    const cannotRetire = memoryStorage();
    expect(writeGmail(cannotRetire)).toBe(true);
    const deniedWrite: FoundationalOAuthContinuityStorage = {
      getItem: cannotRetire.getItem,
      setItem: () => { throw new Error('denied'); },
      removeItem: cannotRetire.removeItem,
    };
    expect(createFoundationalOAuthReloadStore({
      storage: deniedWrite,
      scopeId: 'profile-office',
      now: () => NOW,
    }).consume()).toBeNull();
  });
});
