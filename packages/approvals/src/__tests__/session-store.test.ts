import { describe, it, expect } from 'vitest';
import { createSessionStore } from '../session-store.js';
import { SESSION_LIMITS } from '@recued/contracts';

const session = (overrides: Partial<{ recipe_id: string; granted_at: number }> = {}) => {
  const granted = overrides.granted_at ?? Date.now();
  return {
    recipe_id: overrides.recipe_id ?? 'r1',
    risk_tier: 'write' as const,
    granted_at: new Date(granted).toISOString(),
    last_used_at: new Date(granted).toISOString(),
    expires_at: new Date(granted + SESSION_LIMITS.max_duration_ms).toISOString(),
  };
};

describe('createSessionStore', () => {
  it('returns false for unknown', () => {
    const store = createSessionStore();
    expect(store.isValid('r1', 'write')).toBe(false);
  });

  it('add + isValid', () => {
    const store = createSessionStore();
    store.add(session());
    expect(store.isValid('r1', 'write')).toBe(true);
  });

  it('different tier is independent', () => {
    const store = createSessionStore();
    store.add(session());
    expect(store.isValid('r1', 'admin')).toBe(false);
  });

  it('different recipe is independent', () => {
    const store = createSessionStore();
    store.add(session({ recipe_id: 'r1' }));
    expect(store.isValid('r2', 'write')).toBe(false);
  });

  it('expires after max_duration', () => {
    let now = 1_000_000;
    const store = createSessionStore(() => now);
    store.add(session({ granted_at: now }));
    now += SESSION_LIMITS.max_duration_ms + 1;
    expect(store.isValid('r1', 'write')).toBe(false);
  });

  it('expires after idle timeout', () => {
    let now = 1_000_000;
    const store = createSessionStore(() => now);
    store.add(session({ granted_at: now }));
    now += SESSION_LIMITS.idle_timeout_ms + 1;
    expect(store.isValid('r1', 'write')).toBe(false);
  });

  it('idle timer resets on validation', () => {
    let now = 1_000_000;
    const store = createSessionStore(() => now);
    store.add(session({ granted_at: now }));

    // Halfway through idle window — still valid, refreshes timer
    now += SESSION_LIMITS.idle_timeout_ms - 1;
    expect(store.isValid('r1', 'write')).toBe(true);

    // Another almost-full idle window — still valid because last validation refreshed
    now += SESSION_LIMITS.idle_timeout_ms - 1;
    expect(store.isValid('r1', 'write')).toBe(true);
  });

  it('hard cap still expires even if idle keeps refreshing', () => {
    let now = 1_000_000;
    const store = createSessionStore(() => now);
    store.add(session({ granted_at: now }));

    // Walk through the session, validating periodically (refreshes idle timer)
    for (let i = 0; i < 10; i++) {
      now += SESSION_LIMITS.idle_timeout_ms / 2;
    }
    // We're way past the 8h hard cap now
    now = 1_000_000 + SESSION_LIMITS.max_duration_ms + 1;
    expect(store.isValid('r1', 'write')).toBe(false);
  });

  it('remove drops session', () => {
    const store = createSessionStore();
    store.add(session());
    store.remove('r1', 'write');
    expect(store.isValid('r1', 'write')).toBe(false);
  });

  it('clear drops all sessions', () => {
    const store = createSessionStore();
    store.add(session({ recipe_id: 'r1' }));
    store.add(session({ recipe_id: 'r2' }));
    store.clear();
    expect(store.isValid('r1', 'write')).toBe(false);
    expect(store.isValid('r2', 'write')).toBe(false);
  });

  it('expired sessions are cleaned on isValid check (lazy sweep)', () => {
    let clock = 1_000_000;
    const store = createSessionStore(() => clock);

    // Use the helper with granted_at as a number — session() builds expires_at from it
    store.add(session({ recipe_id: 'r1', granted_at: clock }));

    expect(store.isValid('r1', 'write')).toBe(true);
    // Jump past max_duration (8 hours)
    clock += SESSION_LIMITS.max_duration_ms + 1;
    expect(store.isValid('r1', 'write')).toBe(false);
    // Session was deleted on that check
    expect(store.isValid('r1', 'write')).toBe(false);
  });
});
