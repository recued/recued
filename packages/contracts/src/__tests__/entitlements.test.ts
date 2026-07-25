import { describe, it, expect } from 'vitest';
import {
  isPro, isAnonymous, isExpired,
} from '../entitlements.js';
import type { Entitlement, EntitlementProvider } from '../entitlements.js';

const make = (overrides: Partial<Entitlement> = {}): Entitlement => ({
  user_id: 'u1',
  tier: 'free',
  ...overrides,
});

describe('isPro', () => {
  it('false for free', () => expect(isPro(make({ tier: 'free' }))).toBe(false));
  it('true for pro', () => expect(isPro(make({ tier: 'pro' }))).toBe(true));
  it('true for enterprise', () => expect(isPro(make({ tier: 'enterprise' }))).toBe(true));
});

describe('isAnonymous', () => {
  it('true when user_id is null', () => expect(isAnonymous(make({ user_id: null }))).toBe(true));
  it('false when user_id is set', () => expect(isAnonymous(make({ user_id: 'u1' }))).toBe(false));
});

describe('isExpired', () => {
  it('false when no expires_at', () => expect(isExpired(make())).toBe(false));
  it('false when expires in the future', () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    expect(isExpired(make({ expires_at: future }))).toBe(false);
  });
  it('true when expires in the past', () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    expect(isExpired(make({ expires_at: past }))).toBe(true);
  });
});

describe('EntitlementProvider mock (D-168: binary tier; no per-feature flags)', () => {
  const createMockProvider = (entitlement: Entitlement): EntitlementProvider => ({
    current: async () => entitlement,
    refresh: async () => {},
  });

  it('returns current entitlement', async () => {
    const e = make({ tier: 'pro' });
    const provider = createMockProvider(e);
    const current = await provider.current();
    expect(current.tier).toBe('pro');
  });

  it('refresh resolves without error', async () => {
    const provider = createMockProvider(make());
    await expect(provider.refresh()).resolves.toBeUndefined();
  });
});
