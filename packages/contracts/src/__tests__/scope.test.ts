import { describe, it, expect } from 'vitest';
import { scopedVaultKey, publisherForIngredient, isValidVaultScope } from '../scope.js';

describe('scopedVaultKey', () => {
  it('builds the canonical scoped path', () => {
    expect(scopedVaultKey('recued-core', 'hubspot.token')).toBe('vault.recued-core.hubspot.token');
  });

  it('handles empty key', () => {
    expect(scopedVaultKey('recued-core', '')).toBe('vault.recued-core.');
  });

  it('preserves nested key paths', () => {
    expect(scopedVaultKey('acme', 'oauth.refresh_token')).toBe('vault.acme.oauth.refresh_token');
  });
});

describe('publisherForIngredient', () => {
  it('uses author for marketplace ingredient', () => {
    expect(publisherForIngredient('deal-reader-hubspot', 'recued-core')).toBe('recued-core');
  });

  it('uses "local" for local ingredient regardless of author', () => {
    expect(publisherForIngredient('local/my-search', 'whoever')).toBe('local');
  });

  it('uses author for non-local even if author looks like a local prefix', () => {
    expect(publisherForIngredient('search-exa-mcp', 'local-team')).toBe('local-team');
  });

  it('defaults to verified when third arg omitted (back-compat identity)', () => {
    expect(publisherForIngredient('deal-reader-hubspot', 'recued-core')).toBe('recued-core');
    expect(publisherForIngredient('deal-reader-hubspot', 'recued-core', true)).toBe('recued-core');
  });

  it('downgrades to "local" when verified=false (unverified marketplace claim)', () => {
    expect(publisherForIngredient('deal-reader-hubspot', 'recued-core', false)).toBe('local');
  });

  it('downgrades unverified even when author looks legitimate', () => {
    // Attacker crafts a manifest with author=recued-core but marketplace
    // says no. Scope must be 'local', not 'recued-core'.
    expect(publisherForIngredient('fake-hubspot-reader', 'recued-core', false)).toBe('local');
  });

  it('local slug wins over verified flag (local/ is always local)', () => {
    expect(publisherForIngredient('local/my-search', 'whoever', true)).toBe('local');
    expect(publisherForIngredient('local/my-search', 'whoever', false)).toBe('local');
  });

  it('empty author → "local" (authorless local ingredients)', () => {
    expect(publisherForIngredient('some-slug', '')).toBe('local');
    expect(publisherForIngredient('some-slug', '  ')).toBe('local');
  });
});

describe('isValidVaultScope', () => {
  it('true for matching scope', () => {
    expect(isValidVaultScope('vault.recued-core.hubspot.token', 'recued-core')).toBe(true);
  });

  it('false for wrong publisher', () => {
    expect(isValidVaultScope('vault.acme.hubspot.token', 'recued-core')).toBe(false);
  });

  it('false for non-vault path', () => {
    expect(isValidVaultScope('config.lookback_days', 'recued-core')).toBe(false);
  });

  it('false for malformed path', () => {
    expect(isValidVaultScope('vault', 'recued-core')).toBe(false);
    expect(isValidVaultScope('', 'recued-core')).toBe(false);
  });

  it('cross-publisher access blocked (defense-in-depth)', () => {
    // Publisher A's vault key, accessed in Publisher B's context
    const publisherAKey = scopedVaultKey('publisher-a', 'secret');
    expect(isValidVaultScope(publisherAKey, 'publisher-b')).toBe(false);
    expect(isValidVaultScope(publisherAKey, 'publisher-a')).toBe(true);
  });
});
