/** Durable versions of the actual contract queries used during preparation.
 * Tracking reads avoids a parallel handwritten list of authorization tables.
 * Writers refresh affected queries in their own transaction: revoke/regrant,
 * uninstall/reinstall and temporary policy tightening cannot revive a review. */
import type Database from 'better-sqlite3';
import { preapprovalHash } from '../preapproval-invocations.js';
import type { PreapprovalDependency } from '../preapproval-model.js';
import { initializePreapprovalLifecycle, synchronizePreapprovalIdentity } from './preapproval-lifecycle.js';
import { encodeContractSegmentKey, decodeContractSegmentKey } from './contract-key.js';

interface Query { scope: string; segments: readonly string[]; exact: boolean }
interface QueryRow { query_key: string; scope: string; segments_json: string; exact: number }
interface Collector { db: Database.Database; phase: 'decision' | 'terminal'; reads: Map<string, Query & { phase: 'decision' | 'terminal' }>;
  projection?: { source: string; query: Query | null } }
let active: Collector | undefined;
// Reserved query sources are not contract schema scopes. They share the same
// durable read-set protocol for bearer/paired-client lifecycle writers.
export const PREAPPROVAL_MCP_TOKEN_QUERY = '@mcp_token';
export const PREAPPROVAL_CLIENT_TOKEN_QUERY = '@client_token';
export const PREAPPROVAL_CONNECTION_GRANTS_QUERY = '@connection_grants';
export const PREAPPROVAL_PACK_RESOLUTION_QUERY = '@pack_resolution';

export const initializePreapprovalContractReads = (db: Database.Database): void => {
  initializePreapprovalLifecycle(db);
  db.exec(`CREATE TABLE IF NOT EXISTS preapproval_contract_queries (
    query_key TEXT PRIMARY KEY, scope TEXT NOT NULL, segments_json TEXT NOT NULL, exact INTEGER NOT NULL
  ); CREATE INDEX IF NOT EXISTS preapproval_contract_queries_scope ON preapproval_contract_queries(scope)`);
};

export const recordPreapprovalContractRead = (db: Database.Database, scope: string, segments: readonly string[], exact: boolean): void => {
  if (active?.db !== db || scope === 'schema') return;
  const projected = active.projection?.source === scope ? active.projection : undefined;
  if (projected?.query === null) return;
  const query = projected?.query ?? { scope, segments: [...segments], exact }; const key = preapprovalHash(query);
  const prior = active.reads.get(key);
  if (prior?.phase === 'terminal') return;
  active.reads.set(key, { ...query, phase: active.phase });
};

/** Host reducers can pin the exact non-leading-segment query they actually
 * consume. The original store must still perform the read on the collector's
 * database. This never changes what the reducer reads or authorizes. */
export const withPreapprovalContractProjection = <T>(source: string, query: Query | null, read: () => T): T => {
  if (!active) return read();
  const collector = active; const previous = collector.projection;
  collector.projection = { source, query };
  try { return read(); } finally { collector.projection = previous; }
};

const material = (scope: string, raw: string): unknown => {
  const value: unknown = JSON.parse(raw);
  // Reservation changes only an attempt's remaining budget. All identity,
  // expiry, revocation, scope and grant fields remain material. Live admission
  // still enforces exhaustion and only its private reserved attempt gets credit.
  if (scope === 'contract_definition' && value && typeof value === 'object' && !Array.isArray(value)) {
    const { uses_remaining: _remaining, ...identity } = value as Record<string, unknown>;
    return identity;
  }
  return value;
};
const refresh = (db: Database.Database, row: QueryRow): PreapprovalDependency => {
  const segments = JSON.parse(row.segments_json) as string[];
  let values: unknown;
  if (row.scope === PREAPPROVAL_MCP_TOKEN_QUERY || row.scope === PREAPPROVAL_CLIENT_TOKEN_QUERY) {
    if (!row.exact || !segments[0] || (row.scope === PREAPPROVAL_CLIENT_TOKEN_QUERY && segments.length !== 1)) {
      throw new Error('Credential identity requires an exact host-issued token id.');
    }
    const token = row.scope === PREAPPROVAL_MCP_TOKEN_QUERY
      ? db.prepare(`SELECT token_id,bearer_hash,peer_handle,created_at,revoked_at,grants_json,chat_mode_json,contract_id
          FROM chat_inbound_tokens WHERE token_id=?`).get(segments[0])
      : db.prepare(`SELECT token_id,token_hash_json,client_kind,issued_at,revoked_at,metadata_blob
          FROM client_tokens WHERE token_id=?`).get(segments[0]);
    values = token ? Object.fromEntries(Object.entries(token).map(([key, value]) => {
      if (typeof value === 'string' && (key.endsWith('_json') || key === 'metadata_blob')) {
        try {
          const parsed: unknown = JSON.parse(value);
          if (key === 'grants_json' && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            // Added unrelated grants cannot enlarge the frozen invocation set.
            // Existing grants remain pinned, including removal then restoration.
            return [key, Object.fromEntries(segments.slice(1).map(name => [name,
              Object.hasOwn(parsed, name) ? (parsed as Record<string, unknown>)[name] : null]))];
          }
          return [key, parsed];
        } catch { /* Corrupt values remain material and fail normal admission. */ }
      }
      return [key, value];
    })) : [];
  } else {
    const prefix = encodeContractSegmentKey(segments);
    const source = row.scope === PREAPPROVAL_CONNECTION_GRANTS_QUERY ? 'grant'
      : row.scope === PREAPPROVAL_PACK_RESOLUTION_QUERY ? 'installed_pack' : row.scope;
    const rows = db.prepare('SELECT seg_key,value_inline FROM contract_store WHERE scope=? ORDER BY seg_key')
      .all(source) as Array<{ seg_key: string; value_inline: string }>;
    const selected = rows.filter(item => {
      if (row.scope === PREAPPROVAL_CONNECTION_GRANTS_QUERY) {
        const keys = decodeContractSegmentKey(item.seg_key);
        return keys.length === 4 && keys[0] !== '__user__' && keys[0] !== segments[2]
          && keys[1] === segments[0] && keys[2] === segments[1];
      }
      if (row.scope === PREAPPROVAL_PACK_RESOLUTION_QUERY) {
        const value = JSON.parse(item.value_inline) as Record<string, unknown>;
        const slug = decodeContractSegmentKey(item.seg_key)[0];
        return typeof value.publisher === 'string' && (segments[0] === `${value.publisher}.${slug}`
          || (typeof value.authored_pack_slug === 'string' && segments[0] === `${value.publisher}.${value.authored_pack_slug.trim()}`));
      }
      return row.exact ? item.seg_key === prefix : !prefix || item.seg_key === prefix || item.seg_key.startsWith(prefix + '.');
    });
    values = selected.map(item => ({ key: item.seg_key, value: material(source, item.value_inline) }));
  }
  const pin = synchronizePreapprovalIdentity(db, 'contract_query', row.query_key,
    values)!;
  return { kind: pin.kind, key: pin.key, incarnation: pin.incarnation, revision: pin.revision,
    content_hash: pin.content_hash, until_phase: 'terminal' };
};

export const readPreapprovalContractQuery = (db: Database.Database, key: string): PreapprovalDependency | null => {
  if (!db.inTransaction) throw new Error('Authority query identity requires a transaction.');
  const row = db.prepare('SELECT * FROM preapproval_contract_queries WHERE query_key=?').get(key) as QueryRow | undefined;
  return row ? refresh(db, row) : null;
};

export const withPreapprovalContractReadPhase = <T>(phase: Collector['phase'], run: () => T): T => {
  if (!active) return run();
  const prior = active.phase; active.phase = phase;
  try { return run(); } finally { active.phase = prior; }
};

export const collectPreapprovalContractReads = <T>(db: Database.Database, run: () => T): { result: T; dependencies: PreapprovalDependency[] } => {
  if (!db.inTransaction) throw new Error('Authority preparation requires a transaction.');
  const prior = active; const collector: Collector = { db, reads: new Map(), phase: 'terminal' }; active = collector;
  let result: T;
  try {
    result = run();
    if (result && typeof result === 'object' && 'then' in result) throw new Error('Authority preparation cannot await.');
  }
  finally { active = prior; }
  const dependencies: PreapprovalDependency[] = [];
  for (const [key, query] of collector.reads) {
    const row: QueryRow = { query_key: key, scope: query.scope, segments_json: JSON.stringify(query.segments), exact: query.exact ? 1 : 0 };
    db.prepare('INSERT INTO preapproval_contract_queries VALUES(?,?,?,?) ON CONFLICT(query_key) DO NOTHING')
      .run(row.query_key, row.scope, row.segments_json, row.exact);
    dependencies.push({ ...refresh(db, row), until_phase: query.phase });
  }
  return { result, dependencies };
};

export const refreshPreapprovalContractQueries = (db: Database.Database, scope: string): void => {
  if (!db.inTransaction) throw new Error('Authority changes require a transaction.');
  const projected = scope === 'grant' ? PREAPPROVAL_CONNECTION_GRANTS_QUERY
    : scope === 'installed_pack' ? PREAPPROVAL_PACK_RESOLUTION_QUERY : scope;
  const rows = db.prepare('SELECT * FROM preapproval_contract_queries WHERE scope=? OR scope=?').all(scope, projected) as QueryRow[];
  for (const row of rows) refresh(db, row);
};
export const mutatePreapprovalContractQueries = <T>(db: Database.Database, scope: string, write: () => T): T =>
  db.transaction(() => { const result = write(); refreshPreapprovalContractQueries(db, scope); return result; }).immediate();
