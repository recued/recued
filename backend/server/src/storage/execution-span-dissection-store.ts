/** First model-supplied request dissection per D-214 span root.
 *
 * The payload contains values only. Hashes and scope are absent and are always
 * derived server-side by the compiler.
 */

import type Database from 'better-sqlite3';
import type { RequestDissection } from '@recued/contracts';

import {
  openD214Json,
  sealD214Json,
  type D214KeyProvider,
} from './d214-sealed-json.js';

export const ensureExecutionSpanDissectionSchema = (
  db: Database.Database,
): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS execution_span_dissections (
      root_request_id    TEXT PRIMARY KEY,
      payload_encrypted  TEXT NOT NULL,
      recorded_at        INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS execution_turn_dissections (
      root_request_id    TEXT NOT NULL,
      session_id         TEXT NOT NULL,
      turn_id            TEXT NOT NULL,
      payload_encrypted  TEXT NOT NULL,
      recorded_at        INTEGER NOT NULL,
      PRIMARY KEY (root_request_id, session_id, turn_id)
    );
    CREATE INDEX IF NOT EXISTS idx_execution_turn_dissections_root
      ON execution_turn_dissections (root_request_id, recorded_at);
  `);
};

const boundedStrings = (
  value: unknown,
  maximum: number,
): string[] | null => {
  if (!Array.isArray(value) || value.length > maximum) return null;
  const out: string[] = [];
  for (const item of value) {
    if (
      typeof item !== 'string'
      || item.length === 0
      || Buffer.byteLength(item, 'utf8') > 512
    ) return null;
    out.push(item);
  }
  return out;
};

export const parseRequestDissection = (
  raw: unknown,
): RequestDissection | null => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const allowed = new Set([
    'schema_version',
    'intent',
    'objects',
    'entities',
    'constraints',
    'outcome_sought',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;
  if (
    value.schema_version !== 1
    || typeof value.intent !== 'string'
    || value.intent.length === 0
    || Buffer.byteLength(value.intent, 'utf8') > 512
    || typeof value.outcome_sought !== 'string'
    || Buffer.byteLength(value.outcome_sought, 'utf8') > 512
  ) return null;
  const objects = boundedStrings(value.objects, 16);
  const constraints = boundedStrings(value.constraints, 16);
  if (!objects || !constraints || !Array.isArray(value.entities)
    || value.entities.length > 16) return null;
  const entities: RequestDissection['entities'] = [];
  for (const rawEntity of value.entities) {
    if (
      rawEntity === null
      || typeof rawEntity !== 'object'
      || Array.isArray(rawEntity)
    ) return null;
    const entity = rawEntity as Record<string, unknown>;
    if (
      Object.keys(entity).some((key) => key !== 'role' && key !== 'kind')
      || typeof entity.role !== 'string'
      || typeof entity.kind !== 'string'
      || !entity.role
      || !entity.kind
      || Buffer.byteLength(entity.role, 'utf8') > 128
      || Buffer.byteLength(entity.kind, 'utf8') > 128
    ) return null;
    entities.push({ role: entity.role, kind: entity.kind });
  }
  return {
    schema_version: 1,
    intent: value.intent,
    objects,
    entities,
    constraints,
    outcome_sought: value.outcome_sought,
  };
};

export interface ExecutionSpanDissectionStore {
  putFirst(
    root_request_id: string,
    dissection: RequestDissection,
    recorded_at: number,
  ): Promise<boolean>;
  get(root_request_id: string): Promise<RequestDissection | undefined>;
  /** First dissection for each durable turn in the span. This is what lets the
   * compiler compare later intent facets without permitting re-rooting. */
  putForTurn(
    root_request_id: string,
    session_id: string,
    turn_id: string,
    dissection: RequestDissection,
    recorded_at: number,
  ): Promise<boolean>;
  getForTurn(
    root_request_id: string,
    session_id: string,
    turn_id: string,
  ): Promise<RequestDissection | undefined>;
  delete(root_request_id: string): boolean;
}

export const createExecutionSpanDissectionStore = (
  db: Database.Database,
  keyProvider?: D214KeyProvider,
): ExecutionSpanDissectionStore => {
  ensureExecutionSpanDissectionSchema(db);
  const insert = db.prepare(`
    INSERT INTO execution_span_dissections (
      root_request_id, payload_encrypted, recorded_at
    ) VALUES (?, ?, ?)
    ON CONFLICT (root_request_id) DO NOTHING
  `);
  const select = db.prepare(`
    SELECT payload_encrypted FROM execution_span_dissections
     WHERE root_request_id = ?
  `);
  const remove = db.prepare(`
    DELETE FROM execution_span_dissections WHERE root_request_id = ?
  `);
  const insertTurn = db.prepare(`
    INSERT INTO execution_turn_dissections (
      root_request_id, session_id, turn_id, payload_encrypted, recorded_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (root_request_id, session_id, turn_id) DO NOTHING
  `);
  const selectTurn = db.prepare(`
    SELECT payload_encrypted FROM execution_turn_dissections
     WHERE root_request_id = ? AND session_id = ? AND turn_id = ?
  `);
  const removeTurns = db.prepare(`
    DELETE FROM execution_turn_dissections WHERE root_request_id = ?
  `);
  const turnIdentity = (
    root_request_id: string,
    session_id: string,
    turn_id: string,
  ): string => `${root_request_id}\0${session_id}\0${turn_id}`;
  return {
    async putFirst(root_request_id, dissection, recorded_at) {
      const payload = await sealD214Json(
        dissection,
        'span-dissection',
        root_request_id,
        keyProvider,
      );
      return insert.run(root_request_id, payload, recorded_at).changes === 1;
    },
    async get(root_request_id) {
      const row = select.get(root_request_id) as
        | { payload_encrypted: string }
        | undefined;
      return row
        ? openD214Json<RequestDissection>(
            row.payload_encrypted,
            'span-dissection',
            root_request_id,
            keyProvider,
          )
        : undefined;
    },
    async putForTurn(
      root_request_id,
      session_id,
      turn_id,
      dissection,
      recorded_at,
    ) {
      const identity = turnIdentity(root_request_id, session_id, turn_id);
      const payload = await sealD214Json(
        dissection,
        'turn-dissection',
        identity,
        keyProvider,
      );
      return insertTurn.run(
        root_request_id,
        session_id,
        turn_id,
        payload,
        recorded_at,
      ).changes === 1;
    },
    async getForTurn(root_request_id, session_id, turn_id) {
      const row = selectTurn.get(
        root_request_id,
        session_id,
        turn_id,
      ) as { payload_encrypted: string } | undefined;
      return row
        ? openD214Json<RequestDissection>(
            row.payload_encrypted,
            'turn-dissection',
            turnIdentity(root_request_id, session_id, turn_id),
            keyProvider,
          )
        : undefined;
    },
    delete(root_request_id) {
      const removeAll = db.transaction(() => {
        const root = remove.run(root_request_id).changes;
        const turns = removeTurns.run(root_request_id).changes;
        return root + turns;
      });
      return removeAll() > 0;
    },
  };
};
