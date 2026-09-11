/** Material identity and mutation coordination below the public automation
 * stores. No caller-provided revision, timestamp or reused name is an identity. */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { RpcError, type PreapprovalResourcePin } from '@recued/contracts';
import { preapprovalHash } from '../preapproval-invocations.js';

type Invalidate = (kind: string, key: string, incarnation?: string) => number;
const invalidators = new WeakMap<Database.Database, Invalidate>();
const projecting = new WeakSet<Database.Database>();
interface IdentityRow extends PreapprovalResourcePin { present: number; qualifying_sequence: number }

export const initializePreapprovalLifecycle = (db: Database.Database): void => {
  db.exec(`CREATE TABLE IF NOT EXISTS preapproval_resource_identity (
    kind TEXT NOT NULL, key TEXT NOT NULL, incarnation TEXT NOT NULL,
    revision INTEGER NOT NULL, content_hash TEXT NOT NULL, present INTEGER NOT NULL,
    qualifying_sequence INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(kind, key)
  );
  CREATE TABLE IF NOT EXISTS preapproval_activations (
    future_ref TEXT PRIMARY KEY, target_kind TEXT NOT NULL, target_key TEXT NOT NULL,
    target_incarnation TEXT NOT NULL, target_revision INTEGER NOT NULL,
    original_enabled INTEGER NOT NULL, owner_mode TEXT NOT NULL,
    owner_changed INTEGER NOT NULL DEFAULT 0, due_at INTEGER,
    selector_sequence INTEGER NOT NULL, retired_at INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS preapproval_one_activation_per_target
    ON preapproval_activations(target_kind, target_key) WHERE retired_at IS NULL;
  CREATE TABLE IF NOT EXISTS preapproval_occurrences (
    target_kind TEXT NOT NULL, target_key TEXT NOT NULL, incarnation TEXT NOT NULL,
    occurrence_key TEXT NOT NULL, sequence INTEGER NOT NULL, payload_hash TEXT NOT NULL,
    future_ref TEXT, consumed_at INTEGER NOT NULL,
    PRIMARY KEY(target_kind,target_key,incarnation,occurrence_key)
  );
  CREATE TABLE IF NOT EXISTS preapproval_trigger_ingress (
    ingress_sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT NOT NULL UNIQUE,
    payload_hash TEXT NOT NULL, received_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS preapproval_trigger_windows (
    future_ref TEXT PRIMARY KEY, after_ingress_sequence INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS preapproval_trigger_candidates (
    future_ref TEXT PRIMARY KEY, trigger_id TEXT NOT NULL, event_key TEXT NOT NULL,
    ingress_sequence INTEGER NOT NULL, payload_hash TEXT NOT NULL, event_ciphertext TEXT NOT NULL
  )`);
};

export const registerPreapprovalInvalidator = (db: Database.Database, invalidate: Invalidate): void => {
  initializePreapprovalLifecycle(db);
  invalidators.set(db, invalidate);
};

const readIdentity = (db: Database.Database, kind: string, key: string): IdentityRow | null =>
  db.prepare('SELECT * FROM preapproval_resource_identity WHERE kind = ? AND key = ?')
    .get(kind, key) as IdentityRow | undefined ?? null;

/** Accept a new execution-owned resource in the same transaction that creates
 * it. Pending reviews retain this private identity in their encrypted plan;
 * they create no independent resource row to orphan on retries or refusal. */
export const createPreapprovalOwnedIdentity = (
  db: Database.Database, kind: string, key: string, incarnation: string, material: unknown,
): void => {
  if (!db.inTransaction) throw new Error('Owned resources require an activation transaction.');
  if (readIdentity(db, kind, key)) throw new RpcError('preapproval_stale', 'The execution resource already exists.', 409);
  db.prepare(`INSERT INTO preapproval_resource_identity
    (kind,key,incarnation,revision,content_hash,present,qualifying_sequence) VALUES(?,?,?,1,?,1,0)`)
    .run(kind, key, incarnation, preapprovalHash(material));
};

/** Called with a fresh authoritative read, within the writer/claim transaction.
 * Boot may backfill identities for legacy rows, never for a missing resource. */
export const synchronizePreapprovalIdentity = (
  db: Database.Database, kind: string, key: string, material: unknown | null,
): IdentityRow | null => {
  const prior = readIdentity(db, kind, key);
  if (!prior && material === null) return null;
  const hash = material === null ? '' : preapprovalHash(material);
  if (prior && prior.present === (material === null ? 0 : 1) && prior.content_hash === hash) {
    return prior.present ? prior : null;
  }
  if (prior?.present) {
    const invalidate = invalidators.get(db);
    if (invalidate) invalidate(kind, key, prior.incarnation);
    else if (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'preapproval_executions'").get()) {
      const pending = db.prepare(`SELECT e.future_ref FROM preapproval_executions e
        LEFT JOIN preapproval_dependencies d ON d.future_ref = e.future_ref
        WHERE e.state IN ('prepared','active','running','held','in_doubt')
        AND ((e.target_kind = ? AND e.target_key = ?) OR (d.kind = ? AND d.key = ?)) LIMIT 1`)
        .get(kind, key, kind, key);
      if (pending) throw new RpcError('preapproval_unsupported', 'Pre-approval lifecycle is unavailable.', 503);
    }
  }
  const row: IdentityRow = {
    kind, key, incarnation: prior?.present ? prior.incarnation : randomUUID(),
    revision: prior?.present ? prior.revision + 1 : 1, content_hash: hash,
    present: material === null ? 0 : 1, qualifying_sequence: prior?.qualifying_sequence ?? 0,
  };
  db.prepare(`INSERT INTO preapproval_resource_identity
    (kind,key,incarnation,revision,content_hash,present,qualifying_sequence) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(kind,key) DO UPDATE SET incarnation=excluded.incarnation, revision=excluded.revision,
      content_hash=excluded.content_hash, present=excluded.present`)
    .run(kind, key, row.incarnation, row.revision, hash, row.present, row.qualifying_sequence);
  return row.present ? row : null;
};

/** Host-only synchronous projection. Its only use is parking/restoring the
 * existing row inside the decision/retirement transaction. */
export const projectPreapprovalAutomation = <T>(db: Database.Database, project: () => T): T => {
  if (!db.inTransaction) throw new Error('Automation projection requires a transaction.');
  if (projecting.has(db)) return project();
  projecting.add(db);
  try {
    const result = project();
    if (result && typeof result === 'object' && 'then' in result) throw new Error('Automation projection cannot await.');
    return result;
  } finally { projecting.delete(db); }
};

export const assertPreapprovalLegacyEnable = (db: Database.Database, kind: string, key: string, enabled: boolean): void => {
  if (!enabled || projecting.has(db)) return;
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'preapproval_activations'").get()) return;
  const managed = db.prepare(`SELECT future_ref FROM preapproval_activations
    WHERE target_kind = ? AND target_key = ? AND retired_at IS NULL`).get(kind, key);
  if (managed) throw new RpcError('preapproval_target_mismatch', 'This automation has a reviewed execution. Cancel it before enabling the ordinary rule.', 409);
};

/** Read the owner's intent behind a parked row. A later explicit pause/edit
 * marks owner_changed even if `enabled:false` equals the parking projection. */
export const preapprovalLogicalEnabled = (db: Database.Database, kind: string, key: string, stored: boolean): boolean => {
  const row = db.prepare(`SELECT original_enabled, owner_changed FROM preapproval_activations
    WHERE target_kind = ? AND target_key = ? AND retired_at IS NULL`).get(kind, key) as {
      original_enabled: number; owner_changed: number;
    } | undefined;
  return row && !row.owner_changed ? row.original_enabled === 1 : stored;
};

export const notePreapprovalOwnerMutation = (db: Database.Database, kind: string, key: string): void => {
  if (projecting.has(db)) return;
  const managed = db.prepare(`SELECT future_ref FROM preapproval_activations
    WHERE target_kind = ? AND target_key = ? AND retired_at IS NULL`).get(kind, key);
  if (!managed) return;
  const invalidate = invalidators.get(db);
  if (!invalidate) throw new RpcError('preapproval_unsupported', 'Pre-approval lifecycle is unavailable.', 503);
  invalidate(kind, key);
  db.prepare(`UPDATE preapproval_activations SET owner_changed = 1
    WHERE target_kind = ? AND target_key = ? AND retired_at IS NULL`).run(kind, key);
};

/** Every store write uses one transaction for the row and its identity. Stats
 * updates supply the same material and cannot invalidate a pending decision. */
export const mutatePreapprovalResource = <T>(
  db: Database.Database, kind: string, key: string, material: () => unknown | null, mutate: () => T,
): T => db.transaction(() => {
  if (projecting.has(db)) return mutate();
  synchronizePreapprovalIdentity(db, kind, key, material());
  const result = mutate();
  synchronizePreapprovalIdentity(db, kind, key, material());
  return result;
}).immediate();

/** A qualifying ordinary fire also moves this sequence. Preparation/decision
 * can consequently detect intervening execution even without a config edit. */
export const advancePreapprovalOccurrence = (db: Database.Database, kind: string, key: string): number => {
  if (!db.inTransaction) throw new Error('Occurrence selection requires a transaction.');
  const row = db.prepare(`UPDATE preapproval_resource_identity SET qualifying_sequence = qualifying_sequence + 1
    WHERE kind = ? AND key = ? AND present = 1 RETURNING qualifying_sequence`).get(kind, key) as { qualifying_sequence: number } | undefined;
  if (!row) throw new RpcError('preapproval_stale', 'The activation target no longer exists.', 409);
  return row.qualifying_sequence;
};
