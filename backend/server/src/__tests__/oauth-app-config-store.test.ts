/** BYO OAuth app credentials store — encryption, round-trip, lock behavior. */

import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { createOAuthAppConfigStore } from '../oauth-app-config-store.js';

const KEY = new Uint8Array(32).fill(7);
const make = (key: Uint8Array | null | 'none') => {
  const db = new Database(':memory:');
  const store =
    key === 'none'
      ? createOAuthAppConfigStore(db)
      : createOAuthAppConfigStore(db, { getEncryptionKey: () => key });
  return { db, store };
};
const rawValue = (db: Database.Database, key: string): string | undefined =>
  (db.prepare('SELECT value FROM oauth_app_config WHERE key = ?').get(key) as
    | { value: string }
    | undefined)?.value;

describe('OAuthAppConfigStore', () => {
  it('set/get round-trips client_id (plaintext) + client_secret (decrypted), per issuer', () => {
    const { store } = make(KEY);
    store.setIssuer('google', 'gid', 'gsecret');
    expect(store.getClientId('google')).toBe('gid');
    expect(store.getClientSecret('google')).toBe('gsecret');
    expect(store.hasSecret('google')).toBe(true);
    // The other issuer is untouched.
    expect(store.getClientId('microsoft')).toBeNull();
    expect(store.getClientSecret('microsoft')).toBeNull();
    expect(store.hasSecret('microsoft')).toBe(false);
  });

  it('encrypts the secret at rest; leaves client_id plaintext', () => {
    const { db, store } = make(KEY);
    store.setIssuer('google', 'gid', 'topsecret');
    const secret = rawValue(db, 'google.client_secret')!;
    expect(secret).toMatch(/^enc:v1:/);
    expect(secret).not.toContain('topsecret');
    expect(rawValue(db, 'google.client_id')).toBe('gid');
  });

  it('clear removes both id + secret', () => {
    const { store } = make(KEY);
    store.setIssuer('microsoft', 'mid', 'msecret');
    store.clearIssuer('microsoft');
    expect(store.getClientId('microsoft')).toBeNull();
    expect(store.getClientSecret('microsoft')).toBeNull();
    expect(store.hasSecret('microsoft')).toBe(false);
  });

  it('locked server (key null) refuses to write a fresh secret AND leaves no orphan client_id (atomic)', () => {
    const { db, store } = make(null);
    expect(() => store.setIssuer('google', 'gid', 'gsecret')).toThrow(/locked/i);
    // The id row must have rolled back with the failed secret write.
    expect(store.getClientId('google')).toBeNull();
    expect(rawValue(db, 'google.client_id')).toBeUndefined();
  });

  it('locked server can read the plaintext id + presence, but not decrypt the secret', () => {
    const { db } = make(KEY);
    createOAuthAppConfigStore(db, { getEncryptionKey: () => KEY }).setIssuer('google', 'gid', 'gsecret');
    const locked = createOAuthAppConfigStore(db, { getEncryptionKey: () => null });
    expect(locked.getClientId('google')).toBe('gid'); // plaintext id
    expect(locked.hasSecret('google')).toBe(true); // presence — no decrypt
    expect(() => locked.getClientSecret('google')).toThrow(/locked/i);
  });

  it('no encryption wired (dev) stores the secret as plaintext (legacy passthrough)', () => {
    const { db, store } = make('none');
    store.setIssuer('google', 'gid', 'plain');
    expect(store.getClientSecret('google')).toBe('plain');
    expect(rawValue(db, 'google.client_secret')).toBe('plain'); // no enc prefix
  });
});
