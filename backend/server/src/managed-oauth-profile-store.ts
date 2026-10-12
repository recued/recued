/** D-322 — encrypted broker profiles. A locked server never writes a plaintext key. */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { managedOAuthScopeUnion, type ManagedOAuthProfileView } from '@recued/contracts';

export interface ManagedOAuthProfile extends ManagedOAuthProfileView { api_key: string }
export interface ManagedOAuthProfileStore {
  list(): ManagedOAuthProfileView[];
  get(id: string): ManagedOAuthProfile | undefined;
  save(profile: ManagedOAuthProfile): void;
  delete(id: string): void;
  /** D-322 — identity includes Nango's public row ID and creation timestamp. */
  accountScopes(baseUrl: string, integration: string, identity: string): readonly string[] | undefined;
  rememberAccountScopes(baseUrl: string, integration: string, identity: string, scopes: readonly string[]): void;
  scopeHistorySignature(): string;
}

const aad = (id: string, viewJson: string): Buffer => Buffer.from(JSON.stringify(['managed-oauth-profile-v1', id, viewJson]));
const seal = (value: string, key: Uint8Array, id: string, viewJson: string): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(id, viewJson));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
};
const open = (value: string, key: Uint8Array, id: string, viewJson: string): string => {
  const bytes = Buffer.from(value, 'base64');
  const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  cipher.setAAD(aad(id, viewJson));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
};

// D-322 §15 — retire the prototype setting without changing authenticated stored JSON.
const profileView = (json: string): ManagedOAuthProfileView => {
  const { scope_verification_action: retired, ...view } = JSON.parse(json) as ManagedOAuthProfileView & { scope_verification_action?: unknown };
  void retired; return view;
};

export const createManagedOAuthProfileStore = (
  db: Database.Database,
  getKey: () => Uint8Array | null,
): ManagedOAuthProfileStore => {
  db.exec(`CREATE TABLE IF NOT EXISTS managed_oauth_profiles (
    id TEXT PRIMARY KEY, view_json TEXT NOT NULL, key_ciphertext TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS managed_oauth_scope_history (
    account_key TEXT PRIMARY KEY, scopes_ciphertext TEXT NOT NULL
  )`);
  const key = (): Uint8Array => {
    const value = getKey();
    if (value === null) throw new Error('Unlock the server before using managed OAuth.');
    return value;
  };
  const accountKey = (baseUrl: string, integration: string, identity: string): string => JSON.stringify([baseUrl, integration, identity]);
  const accountScopes = (baseUrl: string, integration: string, identity: string): readonly string[] | undefined => {
    const id = accountKey(baseUrl, integration, identity);
    const row = db.prepare('SELECT scopes_ciphertext FROM managed_oauth_scope_history WHERE account_key = ?')
      .get(id) as { scopes_ciphertext: string } | undefined;
    return row === undefined ? undefined : JSON.parse(open(row.scopes_ciphertext, key(), 'account:' + id, id)) as string[];
  };
  return {
    list: () => (db.prepare('SELECT view_json FROM managed_oauth_profiles ORDER BY id').all() as { view_json: string }[])
      .map((row) => profileView(row.view_json)),
    get(id) {
      const row = db.prepare('SELECT view_json, key_ciphertext FROM managed_oauth_profiles WHERE id = ?')
        .get(id) as { view_json: string; key_ciphertext: string } | undefined;
      if (row === undefined) return undefined;
      return { ...profileView(row.view_json), api_key: open(row.key_ciphertext, key(), id, row.view_json) };
    },
    save(profile) {
      const { api_key, ...view } = profile;
      const viewJson = JSON.stringify(view);
      const ciphertext = seal(api_key, key(), profile.id, viewJson);
      db.prepare('INSERT OR REPLACE INTO managed_oauth_profiles (id, view_json, key_ciphertext) VALUES (?, ?, ?)')
        .run(profile.id, viewJson, ciphertext);
    },
    delete: (id) => { db.prepare('DELETE FROM managed_oauth_profiles WHERE id = ?').run(id); },
    accountScopes,
    rememberAccountScopes(baseUrl, integration, identity, scopes) {
      const previous = accountScopes(baseUrl, integration, identity);
      const updated = managedOAuthScopeUnion(previous ?? [], scopes);
      if (JSON.stringify(previous) === JSON.stringify(updated)) return;
      const id = accountKey(baseUrl, integration, identity);
      const ciphertext = seal(JSON.stringify(updated), key(), 'account:' + id, id);
      db.prepare('INSERT OR REPLACE INTO managed_oauth_scope_history (account_key, scopes_ciphertext) VALUES (?, ?)')
        .run(id, ciphertext);
    },
    scopeHistorySignature: () => JSON.stringify(db.prepare('SELECT account_key, scopes_ciphertext FROM managed_oauth_scope_history ORDER BY account_key').all()),
  };
};
