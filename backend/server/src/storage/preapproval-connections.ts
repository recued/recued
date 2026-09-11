/** Durable, secret-free identity for the actual enrolled route and credential
 * lineage. Only a refresh derived from the current credential preserves that
 * lineage. Re-enrollment, replacement and deletion cannot inherit it. */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { connectionRowKey, type ConnectionKind, type ConnectionRow } from '@recued/contracts';
import { preapprovalHash } from '../preapproval-invocations.js';
import type { PreapprovalDependency } from '../preapproval-model.js';
import { initializePreapprovalLifecycle, synchronizePreapprovalIdentity } from './preapproval-lifecycle.js';

export const initializePreapprovalConnections = (db: Database.Database): void => {
  initializePreapprovalLifecycle(db);
  db.exec(`CREATE TABLE IF NOT EXISTS preapproval_connection_credentials (
    connection_key TEXT PRIMARY KEY, ciphertext_hash TEXT NOT NULL, credential_lineage TEXT NOT NULL
  )`);
};

const jsonMaterial = (text: string): unknown => {
  try { return JSON.parse(text); } catch { return { invalid_json: text }; }
};
const mcpDefinitionMaterial = (row: ConnectionRow): unknown => {
  const health = row.health_json ? jsonMaterial(row.health_json) : null;
  if (!health || typeof health !== 'object' || Array.isArray(health)) return null;
  const data = health as Record<string, unknown>;
  return { tools: Array.isArray(data.tools) ? [...data.tools].sort() : null,
    tool_hashes: Array.isArray(data.tool_hashes) ? [...data.tool_hashes].sort() : null,
    schemas: data.mcp_tool_schemas ?? null };
};
export const connectionPreapprovalMaterial = (row: ConnectionRow | null): unknown | null => row ? {
  kind: row.kind, name: row.name, subtype: row.subtype ?? null,
  publisher_id: row.publisher_id ?? null, config: jsonMaterial(row.config_json),
  subresource_path: row.subresource_path ?? null,
  granted_scopes: row.granted_scopes_json ? jsonMaterial(row.granted_scopes_json) : null,
  ...(row.kind === 'mcp' ? { tool_definitions: mcpDefinitionMaterial(row) } : {}),
} : null;

/** Caller holds the realm write transaction. No secret enters a plan or review. */
export const synchronizePreapprovalConnection = (
  db: Database.Database, kind: ConnectionKind, name: string, row: ConnectionRow | null,
  refreshedFrom?: string,
): PreapprovalDependency[] => {
  if (!db.inTransaction) throw new Error('Connection identity requires a transaction.');
  const key = connectionRowKey(kind, name);
  const route = synchronizePreapprovalIdentity(db, 'connection', key, connectionPreapprovalMaterial(row));
  const prior = db.prepare('SELECT * FROM preapproval_connection_credentials WHERE connection_key = ?')
    .get(key) as { ciphertext_hash: string; credential_lineage: string } | undefined;
  if (!row) {
    synchronizePreapprovalIdentity(db, 'connection_credential', key, null);
    db.prepare('DELETE FROM preapproval_connection_credentials WHERE connection_key = ?').run(key);
    return [];
  }
  const ciphertextHash = preapprovalHash(row.auth_ciphertext);
  const lineage = prior && (prior.ciphertext_hash === ciphertextHash
    || (refreshedFrom !== undefined && prior.ciphertext_hash === preapprovalHash(refreshedFrom)))
    ? prior.credential_lineage : randomUUID();
  db.prepare(`INSERT INTO preapproval_connection_credentials VALUES(?,?,?)
    ON CONFLICT(connection_key) DO UPDATE SET ciphertext_hash=excluded.ciphertext_hash,
      credential_lineage=excluded.credential_lineage`).run(key, ciphertextHash, lineage);
  const credential = synchronizePreapprovalIdentity(db, 'connection_credential', key, { lineage });
  return [route!, credential!].map(({ kind: pinKind, key: pinKey, incarnation, revision, content_hash }) =>
    ({ kind: pinKind, key: pinKey, incarnation, revision, content_hash, until_phase: 'terminal' }));
};

export const mutatePreapprovalConnection = <T>(
  db: Database.Database, kind: ConnectionKind, name: string, read: () => ConnectionRow | null,
  write: () => T, refreshedFrom?: string,
): T => db.transaction(() => {
  synchronizePreapprovalConnection(db, kind, name, read());
  const result = write();
  synchronizePreapprovalConnection(db, kind, name, read(), refreshedFrom);
  return result;
}).immediate();
