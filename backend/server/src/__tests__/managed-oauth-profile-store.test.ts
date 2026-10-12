/** D-322 — ciphertext, lock and AAD boundaries for broker environment keys. */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createManagedOAuthProfileStore } from '../managed-oauth-profile-store.js';

describe('managed OAuth profiles', () => {
  it('reads legacy encrypted profiles while hiding the retired function setting', () => {
    const db = new Database(':memory:');
    try {
      const key = () => new Uint8Array(32).fill(7); const store = createManagedOAuthProfileStore(db, key);
      const legacy = { id: 'cloud', label: 'Cloud', broker: 'nango' as const, base_url: 'https://api.nango.dev',
        revision: 1, api_key: 'environment-secret', scope_verification_action: 'retired-function' };
      store.save(legacy);
      const reopened = createManagedOAuthProfileStore(db, key);
      expect(reopened.get('cloud')?.api_key).toBe('environment-secret');
      expect(reopened.get('cloud')).not.toHaveProperty('scope_verification_action');
      expect(reopened.list()[0]).not.toHaveProperty('scope_verification_action');
      const raw = db.prepare('SELECT view_json FROM managed_oauth_profiles').get() as { view_json: string };
      expect(raw.view_json).toContain('retired-function');
    } finally { db.close(); }
  });
  it('retains encrypted scope history across reopen and separates remote identities', () => {
    const db = new Database(':memory:');
    try {
      const key = () => new Uint8Array(32).fill(7);
      const store = createManagedOAuthProfileStore(db, key);
      store.rememberAccountScopes('https://api.nango.dev', 'graph', '101:created', ['private-scope', 'read']);
      store.rememberAccountScopes('https://api.nango.dev', 'graph', '101:created', ['write', 'read']);
      const before = store.scopeHistorySignature();
      store.rememberAccountScopes('https://api.nango.dev', 'graph', '101:created', ['read']);
      expect(store.scopeHistorySignature()).toBe(before);
      const reopened = createManagedOAuthProfileStore(db, key);
      expect(reopened.accountScopes('https://api.nango.dev', 'graph', '101:created')).toEqual(['private-scope', 'read', 'write']);
      expect(reopened.accountScopes('https://api.nango.dev', 'graph', '202:created')).toBeUndefined();
      expect(reopened.accountScopes('https://api.nango.dev', 'other', '101:created')).toBeUndefined();
      expect(store.scopeHistorySignature()).not.toContain('private-scope');
      db.prepare('UPDATE managed_oauth_scope_history SET account_key = ?').run(JSON.stringify(['https://api.nango.dev', 'graph', 'moved']));
      expect(() => reopened.accountScopes('https://api.nango.dev', 'graph', 'moved')).toThrow();
    } finally { db.close(); }
  });
  it('authenticates routing metadata so a database edit cannot send a key to another broker', () => {
    const db = new Database(':memory:');
    try {
      const store = createManagedOAuthProfileStore(db, () => new Uint8Array(32).fill(7));
      store.save({ id: 'cloud', label: 'Cloud', broker: 'nango', base_url: 'https://api.nango.dev', revision: 1, api_key: 'environment-secret' });
      const view = { ...store.list()[0]!, base_url: 'https://another-broker.example' };
      db.prepare('UPDATE managed_oauth_profiles SET view_json = ? WHERE id = ?').run(JSON.stringify(view), 'cloud');
      expect(() => store.get('cloud')).toThrow();
    } finally { db.close(); }
  });
  it('round trips only encrypted keys and lists secret-free metadata', () => {
    const db = new Database(':memory:');
    try {
      const store = createManagedOAuthProfileStore(db, () => new Uint8Array(32).fill(7));
      store.save({ id: 'cloud', label: 'Nango Cloud', broker: 'nango', base_url: 'https://api.nango.dev', revision: 1, api_key: 'environment-secret' });
      expect(store.get('cloud')?.api_key).toBe('environment-secret');
      expect(JSON.stringify(store.list())).not.toContain('secret');
      const row = db.prepare('SELECT * FROM managed_oauth_profiles').get() as Record<string, unknown>;
      expect(JSON.stringify(row)).not.toContain('environment-secret');
      db.prepare('UPDATE managed_oauth_profiles SET id = ?').run('moved');
      expect(() => store.get('moved')).toThrow();
    } finally { db.close(); }
  });
  it('fails while locked without damaging a saved profile', () => {
    const db = new Database(':memory:'); let locked = false;
    try {
      const store = createManagedOAuthProfileStore(db, () => locked ? null : new Uint8Array(32).fill(8));
      const original = { id: 'cloud', label: 'Cloud', broker: 'nango' as const, base_url: 'https://api.nango.dev', revision: 1, api_key: 'original-key' };
      store.save(original); store.rememberAccountScopes(original.base_url, 'graph', 'account', ['read']); locked = true;
      expect(() => store.get('cloud')).toThrow('Unlock');
      expect(() => store.save({ ...original, revision: 2, api_key: 'replacement' })).toThrow('Unlock');
      expect(() => store.accountScopes(original.base_url, 'graph', 'account')).toThrow('Unlock');
      expect(() => store.rememberAccountScopes(original.base_url, 'graph', 'account', ['write'])).toThrow('Unlock');
      expect(store.list()[0]?.revision).toBe(1);
      locked = false; expect(store.get('cloud')?.api_key).toBe('original-key');
      store.delete('cloud'); expect(store.list()).toEqual([]);
    } finally { db.close(); }
  });
});
