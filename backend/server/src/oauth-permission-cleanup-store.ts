/** D-322 §44 — durable cleanup authority; candidate tokens stay encrypted. */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { RpcError, isOAuthPermissionCleanupJob, type OAuthPermissionCleanupJob, type ConnectionRow, type DirectOAuthAuth } from '@recued/contracts';
import type { CollectionInstanceRecord } from './collections/instance-store.js';
import { collectionAuthenticationLocks } from './collection-authentication-locks.js';

export interface OAuthPermissionCleanupData {
  public: OAuthPermissionCleanupJob; rows: CollectionInstanceRecord[]; group_ids: string[]; reviewed_groups: string[];
  dependency: string; generations: Record<string, string | null>; original_scopes: Record<string, string>;
  source_tokens: Record<string, string>;
  credentials_signature: string;
  api_connections?: OAuthPermissionCleanupApiConnection[];
  authorization?: { id: string; expires_at: number; app_signature: string; grant_key: string };
  candidates?: Record<string, { values: Record<string, string | null>; expires_at: number; app_signature: string }>;
}
export interface OAuthPermissionCleanupApiConnection {
  row: ConnectionRow; auth: DirectOAuthAuth; grant_key: string; group_id: string; base_url: string;
  identity: { url: string; kind: 'gmail' | 'calendar' | 'drive' | 'openid' };
  verification_url: string; required_scopes: string[];
}
interface Stored { id: string; revision: number; status: string; targets_json: string; data_ciphertext: string }
export const permissionCleanupFinished = (status: OAuthPermissionCleanupJob['status']): boolean => ['applied', 'restored', 'cancelled'].includes(status);
export const createOAuthPermissionCleanupStore = (db: Database.Database, getKey: () => Uint8Array | null, now: () => number) => {
  db.exec(`CREATE TABLE IF NOT EXISTS oauth_permission_cleanups (
    id TEXT PRIMARY KEY, revision INTEGER NOT NULL, status TEXT NOT NULL, targets_json TEXT NOT NULL, data_ciphertext TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS oauth_permission_cleanup_targets (grant_key TEXT PRIMARY KEY, job_id TEXT NOT NULL);`);
  const active = collectionAuthenticationLocks(db);
  for (const row of db.prepare<[], Stored>("SELECT * FROM oauth_permission_cleanups WHERE status NOT IN ('prepared', 'applied', 'restored', 'cancelled')").all()) {
    for (const target of JSON.parse(row.targets_json) as { platform: string; slug: string }[]) if (target.platform !== 'api') active.add(target.platform + ':' + target.slug);
  }
  const key = () => { const value = getKey(); if (!value) throw new RpcError('not_configured', 'Unlock the server to resume permission cleanup.'); return value; };
  const aad = (row: Omit<Stored, 'data_ciphertext'>) => Buffer.from(JSON.stringify(['oauth-permission-cleanup-v1', row.id, row.revision, row.status, row.targets_json]));
  const decode = (row: Stored): OAuthPermissionCleanupData => {
    const bytes = Buffer.from(row.data_ciphertext, 'base64');
    const cipher = createDecipheriv('aes-256-gcm', key(), bytes.subarray(0, 12));
    cipher.setAAD(aad(row)); cipher.setAuthTag(bytes.subarray(12, 28));
    const value = JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8')) as OAuthPermissionCleanupData;
    if (!isOAuthPermissionCleanupJob(value.public) || value.public.id !== row.id || value.public.revision !== row.revision || value.public.status !== row.status) {
      throw new RpcError('internal', 'The saved cleanup record could not be verified.');
    }
    return value;
  };
  const write = (value: OAuthPermissionCleanupData, expected: number) => {
    if (permissionCleanupFinished(value.public.status)) {
      delete value.api_connections; delete value.candidates; delete value.authorization;
    }
    value.public.revision = expected + 1; value.public.updated_at = now();
    if (!isOAuthPermissionCleanupJob(value.public)) throw new RpcError('internal', 'The cleanup record could not be represented safely.');
    const row = { id: value.public.id, revision: value.public.revision, status: value.public.status,
      targets_json: JSON.stringify(value.public.targets.map(t => ({ platform: t.platform, slug: t.slug }))) };
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key(), iv); cipher.setAAD(aad(row));
    const ciphertext = cipher.update(JSON.stringify(value), 'utf8');
    const tail = cipher.final(); const sealed = Buffer.concat([iv, cipher.getAuthTag(), ciphertext, tail]).toString('base64');
    db.transaction(() => {
      if (expected === 0) db.prepare('INSERT INTO oauth_permission_cleanups VALUES (?, ?, ?, ?, ?)').run(row.id, row.revision, row.status, row.targets_json, sealed);
      else if (db.prepare('UPDATE oauth_permission_cleanups SET revision = ?, status = ?, targets_json = ?, data_ciphertext = ? WHERE id = ? AND revision = ?')
        .run(row.revision, row.status, row.targets_json, sealed, row.id, expected).changes !== 1) throw new RpcError('conflict', 'The cleanup changed. Refresh its status before continuing.');
      if (permissionCleanupFinished(value.public.status)) db.prepare('DELETE FROM oauth_permission_cleanup_targets WHERE job_id = ?').run(row.id);
    })();
  };
  const expire = (value: OAuthPermissionCleanupData) => {
    if (value.candidates && Object.values(value.candidates).some(c => c.expires_at <= now()) && !permissionCleanupFinished(value.public.status)) {
      delete value.candidates; delete value.authorization; delete value.public.granted_scopes; delete value.public.review_expires_at; delete value.public.verified_targets;
      value.public.status = 'awaiting_reconnect'; value.public.verification = 'not_checked';
      value.public.last_error = 'This sign-in review expired. Reconnect and verify again.'; write(value, value.public.revision);
    }
    return value;
  };
  return {
    get(id: string): OAuthPermissionCleanupData {
      const row = db.prepare<[string], Stored>('SELECT * FROM oauth_permission_cleanups WHERE id = ?').get(id);
      if (!row) throw new RpcError('not_found', 'This permission cleanup is no longer available.'); return expire(decode(row));
    },
    list: (): OAuthPermissionCleanupJob[] => {
      key(); // Capability is unavailable while locked, even before the first saved task.
      return db.prepare<[], Stored>(`SELECT * FROM oauth_permission_cleanups
        ORDER BY CASE WHEN status IN ('applied', 'restored', 'cancelled') THEN 1 ELSE 0 END, rowid DESC LIMIT 64`).all().map(row => expire(decode(row)).public);
    },
    create(value: OAuthPermissionCleanupData, prefixes: readonly string[]) {
      db.transaction(() => {
        if (db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM oauth_permission_cleanups WHERE status NOT IN ('applied', 'restored', 'cancelled')").get()!.count >= 32) {
          throw new RpcError('conflict', 'Finish or cancel a saved permission cleanup before starting another.');
        }
        for (const prefix of prefixes) {
          if (db.prepare('SELECT 1 FROM oauth_permission_cleanup_targets WHERE grant_key = ?').get(prefix)) throw new RpcError('conflict', 'This sign-in already has a saved cleanup. Resume it from the worklist.');
          db.prepare('INSERT INTO oauth_permission_cleanup_targets VALUES (?, ?)').run(prefix, value.public.id);
        }
        write(value, 0);
      })();
    }, write,
  };
};
