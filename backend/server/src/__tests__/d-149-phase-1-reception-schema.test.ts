/** D-149 P1 — Reception substrate placeholder schema.
 *
 *  Acceptance per spec § A.3 + § A.5.* + Must Hold I-15:
 *    - `ensureReceptionSchema(db)` lands all Reception tables (eight at
 *      P1; the ninth `reception_rate_limiter` joins at P3 per spec
 *      § Contract Tightening § Rate-limit substrate).
 *    - The tables match the contract `RECEPTION_TABLES` list verbatim;
 *      reception tables are per-pair-only (D-097 / D-168).
 *    - The schema is idempotent — calling twice does not error.
 *    - `enabled DEFAULT 0` is enforced at the SQL layer per Must Hold
 *      I-1 default-off baseline (insert without explicit `enabled`
 *      lands `0`).
 *    - The required indexes from the spec land alongside the tables.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  RECEPTION_TABLES,
  type ReceptionTableName,
} from '@recued/contracts';
import { ensureReceptionSchema } from '../storage/reception-store.js';

const listTables = (db: Database.Database): Set<string> => {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
    .all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
};

const listIndexes = (db: Database.Database): Set<string> => {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_autoindex%'`)
    .all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
};

describe('D-149 P1 + P3 — ensureReceptionSchema lands the substrate tables', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
  });

  it('lands every table named in RECEPTION_TABLES', () => {
    ensureReceptionSchema(db);
    const tables = listTables(db);
    for (const name of RECEPTION_TABLES) {
      expect(tables.has(name)).toBe(true);
    }
  });

  it('lands the canonical indexes per spec § A.3 + § A.5.* + P3 rate-limiter', () => {
    ensureReceptionSchema(db);
    const indexes = listIndexes(db);
    const required = [
      'idx_endpoint_kind_enabled',
      'idx_endpoint_active',
      'idx_access_endpoint',
      'idx_access_outcome',
      // D-210 A.8 slice 4c — `idx_booking_endpoint` / `idx_booking_pending` are
      // gone with the `reception_booking_request` table they indexed. The
      // booking flow's equivalents are the form-submission indexes below, which
      // now serve both flows.
      'idx_form_submission_endpoint',
      'idx_form_submission_processing',
      'idx_intake_recipe_pair_form',
      'idx_drop_blob_endpoint',
      'idx_drop_blob_pending',
      'idx_approval_intent_endpoint',
      'idx_approval_intent_consumed',
      'idx_approval_intent_pending',
      'idx_status_projection_endpoint',
      'idx_status_projection_source',
      // D-149 P3 — rate-limit substrate index per § Contract Tightening.
      'idx_rate_limiter_window',
    ];
    for (const name of required) {
      expect(indexes.has(name)).toBe(true);
    }
  });

  it('is idempotent — second call is a no-op', () => {
    ensureReceptionSchema(db);
    const before = listTables(db).size;
    expect(() => ensureReceptionSchema(db)).not.toThrow();
    const after = listTables(db).size;
    expect(after).toBe(before);
  });
});

describe('D-149 P1 — public_endpoint_registry default-off enforcement (Must Hold I-1)', () => {
  it('enabled defaults to 0 when caller omits the column', () => {
    const db = new Database(':memory:');
    ensureReceptionSchema(db);
    db.prepare(
      `INSERT INTO public_endpoint_registry
        (endpoint_id, kind, packet_declaration, bearer_secret_hmac,
         created_at, created_by_client_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      'endpoint-1',
      'scheduling_link',
      '{}',
      Buffer.alloc(32),
      1_700_000_000_000,
      'client-1',
    );
    const row = db.prepare(`SELECT enabled FROM public_endpoint_registry WHERE endpoint_id = ?`).get('endpoint-1') as
      | { enabled: number }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.enabled).toBe(0);
  });

  it('caller can explicitly set enabled = 1 (P3 endpoint.enable rpc path)', () => {
    const db = new Database(':memory:');
    ensureReceptionSchema(db);
    db.prepare(
      `INSERT INTO public_endpoint_registry
        (endpoint_id, kind, enabled, packet_declaration, bearer_secret_hmac,
         created_at, created_by_client_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'endpoint-2',
      'reception_page',
      1,
      '{}',
      Buffer.alloc(32),
      1_700_000_000_000,
      'client-1',
    );
    const row = db.prepare(`SELECT enabled FROM public_endpoint_registry WHERE endpoint_id = ?`).get('endpoint-2') as
      | { enabled: number }
      | undefined;
    expect(row?.enabled).toBe(1);
  });
});

describe('D-149 P1 — RECEPTION_TABLES contract matches the schema landing', () => {
  it('every table the schema creates is in RECEPTION_TABLES', () => {
    const db = new Database(':memory:');
    ensureReceptionSchema(db);
    const tables = listTables(db);
    const expected: ReadonlySet<ReceptionTableName> = new Set(RECEPTION_TABLES);
    for (const name of tables) {
      expect(expected.has(name as ReceptionTableName)).toBe(true);
    }
    expect(tables.size).toBe(RECEPTION_TABLES.length);
  });
});
