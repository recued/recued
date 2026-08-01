/** Per-pair store for BYO OAuth app credentials (Google / Microsoft).
 *
 *  The foundational mail/calendar OAuth flow needs the owner's own OAuth app
 *  `client_id` + `client_secret` (no Recued-operated broker — D-062). These
 *  were ENV-only (`RECUED_{GMAIL,GCAL,GRAPH}_CLIENT_ID/SECRET`); this store
 *  lets the owner enter them in the UI instead, persisted in SQLite with the
 *  secret encrypted at rest. The env vars stay a fallback — the resolver in
 *  `compose-collection-context.ts` reads stored-then-env.
 *
 *  Keyed per ISSUER (`google` / `microsoft`): one Google app covers Gmail +
 *  Google Calendar; one Microsoft app covers Graph mail + calendar. Storage +
 *  encryption modeled exactly on `llm-config.ts` (the `key TEXT, value TEXT`
 *  table + AES-256-GCM under `keys.keyProvider('server-data')` with a versioned
 *  `enc:v1:` prefix + per-row AAD; legacy plaintext rows pass through). */

import type Database from 'better-sqlite3';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { OAuthAppIssuer } from '@recued/contracts';

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
  getClientId(issuer: OAuthAppIssuer): string | null;
  /** Stored `client_secret` (decrypted), or `null` when none is stored.
   *  Throws when the value is encrypted but the server is locked (no DEK). */
  getClientSecret(issuer: OAuthAppIssuer): string | null;
  /** True when a `client_secret` is stored (no decrypt — presence only). */
  hasSecret(issuer: OAuthAppIssuer): boolean;
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

  const idKey = (issuer: OAuthAppIssuer): string => `${issuer}.client_id`;
  const secretKey = (issuer: OAuthAppIssuer): string => `${issuer}.client_secret`;

  return {
    getClientId(issuer) {
      return get(idKey(issuer)) ?? null;
    },
    getClientSecret(issuer) {
      return getSensitive(secretKey(issuer)) ?? null;
    },
    hasSecret(issuer) {
      return get(secretKey(issuer)) !== undefined;
    },
    setIssuer(issuer, clientId, clientSecret) {
      // Atomic: a failed secret write (e.g. locked vault → setSensitive throws)
      // must not leave an orphan client_id row without its secret (Codex F2).
      // better-sqlite3 rolls the transaction back when the function throws.
      db.transaction(() => {
        set(idKey(issuer), clientId);
        setSensitive(secretKey(issuer), clientSecret);
      })();
    },
    clearIssuer(issuer) {
      del(idKey(issuer));
      del(secretKey(issuer));
    },
  };
};
