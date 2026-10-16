/** Per-pair Google and Microsoft OAuth app profiles.
 * Legacy issuer keys remain the default profile. Named profiles have stable IDs
 * and separate credential keys in the same archived table. A secret is encrypted
 * under the live server-data key with its own row key as AES-GCM AAD.
 */

import type Database from 'better-sqlite3';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { OAUTH_APP_ID, OAUTH_APP_ISSUERS, isOAuthAppSecretExpiryDate, RpcError, type OAuthAppIssuer, type SavedOAuthApp } from '@recued/contracts';

const ENC_PREFIX = 'enc:v1:';

/** AES-256-GCM wrap. AAD is typed to each row (`oauth_app_config:<key>`) so
 *  moved ciphertext can't decrypt in the wrong place. (Mirrors llm-config.) */
const encryptSync = (plaintext: string, key: Uint8Array, aad: string): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key), iv);
  cipher.setAAD(Buffer.from(aad, 'utf-8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
};

const decryptSync = (payload: string, key: Uint8Array, aad: string): string => {
  const b = Buffer.from(payload.slice(ENC_PREFIX.length), 'base64');
  if (b.length < 28) throw new Error('oauth-app-config: encrypted payload too short');
  const iv = b.subarray(0, 12);
  const tag = b.subarray(12, 28);
  const ct = b.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key), iv);
  decipher.setAuthTag(tag);
  decipher.setAAD(Buffer.from(aad, 'utf-8'));
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf-8');
};

const isEncrypted = (v: string): boolean => v.startsWith(ENC_PREFIX);

export interface OAuthAppConfigStore {
  /** Stored `client_id` for the issuer, or `null` when none is stored here. */
  getClientId(issuer: OAuthAppIssuer, appId?: string): string | null;
  /** Stored `client_secret` (decrypted), or `null` when none is stored.
   *  Throws when the value is encrypted but the server is locked (no DEK). */
  getClientSecret(issuer: OAuthAppIssuer, appId?: string): string | null;
  /** True when a `client_secret` is stored (no decrypt — presence only). */
  hasSecret(issuer: OAuthAppIssuer, appId?: string): boolean;
  listApps(issuer?: OAuthAppIssuer): SavedOAuthApp[];
  getApp(issuer: OAuthAppIssuer, id: string): SavedOAuthApp | null;
  saveApp(input: { issuer: OAuthAppIssuer; id?: string; label: string; client_id: string;
    client_secret?: string; expected_revision?: number; secret_expires_on?: string | null }): SavedOAuthApp;
  deleteApp(issuer: OAuthAppIssuer, id: string, expectedRevision: number): void;
  /** Store (overwrite) the issuer's `client_id` + `client_secret` (secret
   *  encrypted). Throws when the server is locked (won't write a fresh secret
   *  as plaintext on a runtime that's supposed to encrypt — bait-and-switch). */
  setIssuer(issuer: OAuthAppIssuer, clientId: string, clientSecret: string): void;
  /** Remove the issuer's stored config. Nothing sits behind the store since
   *  the `RECUED_*` OAuth env vars were deleted, so the issuer is then simply
   *  unconfigured and enroll surfaces `not_configured`. */
  clearIssuer(issuer: OAuthAppIssuer): void;
}

export interface OAuthAppConfigStoreOptions {
  /** Returns the sub-DEK for encrypting the `client_secret`. `null` = locked
   *  or encryption disabled (see the three cases on `setIssuer`/`getClientSecret`,
   *  mirroring llm-config). Pass `keys.keyProvider('server-data')`. */
  getEncryptionKey?: () => Uint8Array | null;
}

export const createOAuthAppConfigStore = (
  db: Database.Database,
  opts: OAuthAppConfigStoreOptions = {},
): OAuthAppConfigStore => {
  const getKey = opts.getEncryptionKey;
  db.exec(`
    CREATE TABLE IF NOT EXISTS oauth_app_config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const get = (key: string): string | undefined => {
    const row = db.prepare('SELECT value FROM oauth_app_config WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  };

  const getSensitive = (key: string): string | undefined => {
    const raw = get(key);
    if (raw === undefined) return undefined;
    if (!isEncrypted(raw)) return raw; // legacy plaintext passes through
    const dek = getKey?.();
    if (!dek) {
      throw new Error(
        `oauth-app-config: cannot decrypt '${key}' — server is locked (no DEK available).`,
      );
    }
    return decryptSync(raw, dek, `oauth_app_config:${key}`);
  };

  const set = (key: string, value: string): void => {
    db.prepare('INSERT OR REPLACE INTO oauth_app_config (key, value) VALUES (?, ?)').run(key, value);
  };

  const setSensitive = (key: string, value: string): void => {
    if (!getKey) {
      set(key, value); // encryption not wired (dev / legacy)
      return;
    }
    const dek = getKey();
    if (!dek) {
      throw new Error(
        `oauth-app-config: cannot write '${key}' — server is locked (no DEK available). `
        + 'Unlock the server before saving OAuth app credentials.',
      );
    }
    set(key, encryptSync(value, dek, `oauth_app_config:${key}`));
  };

  const del = (key: string): void => {
    db.prepare('DELETE FROM oauth_app_config WHERE key = ?').run(key);
  };

  // Keep the original keys and AAD for the default profile. No legacy secret
  // needs decrypting or rewriting merely to list or add another app.
  const prefix = (issuer: OAuthAppIssuer, id = 'default'): string => id === 'default' ? issuer : `${issuer}.app.${id}`;
  const idKey = (issuer: OAuthAppIssuer, id = 'default'): string => `${prefix(issuer, id)}.client_id`;
  const secretKey = (issuer: OAuthAppIssuer, id = 'default'): string => `${prefix(issuer, id)}.client_secret`;
  const defaultRevision = (issuer: OAuthAppIssuer): number => {
    try {
      const value: unknown = JSON.parse(get(`${issuer}.profile`) ?? 'null');
      return value && typeof value === 'object' && 'revision' in value && Number.isSafeInteger(value.revision)
        && Number(value.revision) >= 1 ? Number(value.revision) : 0;
    } catch { return 0; }
  };
  const removeCredentials = (issuer: OAuthAppIssuer, id: string, revision: number): void => {
    del(idKey(issuer, id)); del(secretKey(issuer, id));
    // The default ID is reused by legacy setup. Keep only its revision after
    // removal so an old editor cannot overwrite or delete a recreated app.
    if (id === 'default' && revision > 0) set(`${issuer}.profile`, JSON.stringify({ revision }));
    else del(`${prefix(issuer, id)}.profile`);
  };
  const getApp = (issuer: OAuthAppIssuer, id: string): SavedOAuthApp | null => {
    if (!OAUTH_APP_ID.test(id)) return null;
    const clientId = get(idKey(issuer, id)); if (!clientId) return null;
    const metadata = get(`${prefix(issuer, id)}.profile`);
    let label = `Default ${issuer === 'google' ? 'Google' : 'Microsoft'} app`; let revision = 1; let expiry: string | undefined;
    if (metadata) {
      try {
        const value: unknown = JSON.parse(metadata);
        if (!value || typeof value !== 'object' || !('label' in value) || typeof value.label !== 'string'
          || !('revision' in value) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1) return null;
        label = value.label; revision = Number(value.revision);
        if ('secret_expires_on' in value && isOAuthAppSecretExpiryDate(value.secret_expires_on)) expiry = value.secret_expires_on;
      } catch { return null; }
    } else if (id !== 'default') return null;
    return { id, issuer, label, revision, client_id: clientId, has_secret: get(secretKey(issuer, id)) !== undefined,
      ...(expiry ? { secret_expires_on: expiry } : {}) };
  };
  const listApps = (issuer?: OAuthAppIssuer): SavedOAuthApp[] => {
    const keys = db.prepare<[], { key: string }>('SELECT key FROM oauth_app_config ORDER BY key').all();
    return (issuer ? [issuer] : [...OAUTH_APP_ISSUERS]).flatMap(owner => {
      const ids = ['default', ...keys.flatMap(row => {
        const start = `${owner}.app.`; const end = '.client_id';
        return row.key.startsWith(start) && row.key.endsWith(end) ? [row.key.slice(start.length, -end.length)] : [];
      })];
      return ids.flatMap(id => { const app = getApp(owner, id); return app ? [app] : []; });
    });
  };
  const saveApp: OAuthAppConfigStore['saveApp'] = input => db.transaction(() => {
    if (input.secret_expires_on !== undefined && input.secret_expires_on !== null && !isOAuthAppSecretExpiryDate(input.secret_expires_on)) {
      throw new RpcError('bad_request', 'Enter a real expiry date as YYYY-MM-DD, or clear the date.');
    }
    const id = input.id ?? 'app-' + randomUUID().replaceAll('-', '');
    if (!OAUTH_APP_ID.test(id)) throw new RpcError('bad_request', 'Choose a valid saved OAuth app.');
    const current = getApp(input.issuer, id);
    if (current && current.revision !== input.expected_revision) throw new RpcError('conflict', 'The saved app changed. Refresh before saving.');
    if (!current && input.id && (id !== 'default' || input.expected_revision !== undefined)) throw new RpcError('not_found', 'This saved app was removed. Add a new app.');
    if (!current && listApps(input.issuer).length >= 50) throw new RpcError('bad_request', 'Remove an unused app before adding more.');
    if (listApps(input.issuer).some(app => app.id !== id && app.label.toLowerCase() === input.label.toLowerCase())) {
      throw new RpcError('bad_request', 'An app with this name already exists for this vendor. Choose another name.');
    }
    if (!input.client_secret && (!current || current.client_id !== input.client_id)) {
      throw new RpcError('bad_request', 'Enter the matching client secret for a new Client ID.');
    }
    const revision = (current?.revision ?? (id === 'default' ? defaultRevision(input.issuer) : 0)) + 1;
    if (!Number.isSafeInteger(revision)) throw new RpcError('conflict', 'This saved app cannot be edited. Add a new app.');
    if (input.client_secret) setSensitive(secretKey(input.issuer, id), input.client_secret);
    set(idKey(input.issuer, id), input.client_id);
    const expiry = input.secret_expires_on !== undefined ? input.secret_expires_on
      : !input.client_secret && current?.client_id === input.client_id ? current.secret_expires_on : undefined;
    set(`${prefix(input.issuer, id)}.profile`, JSON.stringify({ label: input.label, revision,
      ...(expiry ? { secret_expires_on: expiry } : {}) }));
    return getApp(input.issuer, id)!;
  })();
  const deleteApp: OAuthAppConfigStore['deleteApp'] = (issuer, id, revision) => db.transaction(() => {
    const current = getApp(issuer, id);
    if (!current || current.revision !== revision) throw new RpcError('conflict', 'The saved app changed or was removed. Refresh before removing it.');
    removeCredentials(issuer, id, current.revision);
  })();

  return {
    getClientId(issuer, id = 'default') {
      return OAUTH_APP_ID.test(id) ? get(idKey(issuer, id)) ?? null : null;
    },
    getClientSecret(issuer, id = 'default') {
      return OAUTH_APP_ID.test(id) ? getSensitive(secretKey(issuer, id)) ?? null : null;
    },
    hasSecret(issuer, id = 'default') {
      return OAUTH_APP_ID.test(id) && get(secretKey(issuer, id)) !== undefined;
    },
    listApps, getApp, saveApp, deleteApp,
    setIssuer(issuer, clientId, clientSecret) {
      // Atomic: a failed secret write (e.g. locked vault → setSensitive throws)
      // must not leave an orphan client_id row without its secret (Codex F2).
      // better-sqlite3 rolls the transaction back when the function throws.
      const current = getApp(issuer, 'default');
      const baseLabel = `Default ${issuer === 'google' ? 'Google' : 'Microsoft'} app`;
      const labels = new Set(listApps(issuer).map(app => app.label.toLowerCase()));
      let label = current?.label ?? baseLabel;
      for (let suffix = 2; !current && labels.has(label.toLowerCase()); suffix += 1) label = `${baseLabel} (${suffix})`;
      saveApp({ issuer, id: 'default', label,
        client_id: clientId, client_secret: clientSecret, ...(current ? { expected_revision: current.revision } : {}) });
    },
    clearIssuer(issuer) {
      db.transaction(() => removeCredentials(issuer, 'default', getApp(issuer, 'default')?.revision ?? defaultRevision(issuer)))();
    },
  };
};
