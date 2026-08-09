/** The owner's pending-approvals view seeks instead of scanning every plan.
 *
 *  ⛔ THE DEFECT. `handlePlansPendingList` — the cross-session approval-inbox
 *  rpc the webclient reads — asks
 *  `WHERE status = 'proposed' ORDER BY created_at ASC, plan_id ASC`. Every
 *  index on `chat_plans` leads with `session_id`, which cannot serve a query
 *  that names no session, so the view SCANNED the table and sorted it.
 *  Measured at 200k plans with 100 proposed: **4.62ms -> 0.06ms**.
 *
 *  🔑 PARTIAL, because `proposed` is TRANSIENT — a plan is proposed only until
 *  the owner approves or rejects it. The index holds the pending approvals and
 *  nothing else (100 entries, not 200,000) and a row LEAVES it when the owner
 *  acts. Its columns are the query's own ORDER BY, so the sort goes too.
 *
 *  ⚠ NOT added for the sibling boot statement (`UPDATE … WHERE
 *  execution_status = 'running'`, the crash-recovery reconcile). That runs ONCE
 *  per store construction, and an index maintained on every execution
 *  transition to save one scan at boot is the wrong trade — the same call made
 *  for `form_response`'s boot backfills. */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { ensureChatSchema } from '../storage/chat-store.js';

const PENDING = `SELECT * FROM chat_plans WHERE status = 'proposed'
                 ORDER BY created_at ASC, plan_id ASC`;

const planFor = (drop?: string): string => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  ensureChatSchema(db);
  if (drop !== undefined) db.exec(`DROP INDEX ${drop}`);
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${PENDING}`).all() as Array<{ detail: string }>;
  db.close();
  return rows.map((r) => r.detail).join(' ; ');
};

describe('chat_plans pending-approvals index', () => {
  it('⛔ the approvals view walks the partial index and does not sort', () => {
    const plan = planFor();
    expect(plan, plan).toMatch(/idx_chat_plans_proposed/);
    expect(plan, plan).not.toMatch(/TEMP B-TREE/);
  });

  it('⛔ KNOWN NEGATIVE: without it, the view scans every plan and sorts', () => {
    const plan = planFor('idx_chat_plans_proposed');
    expect(plan, plan).toMatch(/SCAN chat_plans/);
    expect(plan, plan).toMatch(/TEMP B-TREE/);
  });

  it('⛔ it is PARTIAL — otherwise it holds every plan ever proposed', () => {
    // The economics are the shape. A plain (status, created_at, plan_id) index
    // carries an entry per plan forever to answer a question about the handful
    // still awaiting the owner. Pinned so nobody drops the WHERE — which would
    // still satisfy the plan assertions above.
    const db = new Database(':memory:');
    ensureChatSchema(db);
    const sql = (db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='index' AND name = ?`,
    ).get('idx_chat_plans_proposed') as { sql: string }).sql;
    expect(sql).toMatch(/WHERE\s+status\s*=\s*'proposed'/);
    db.close();
  });

  it('returns the same plans, in the same order, with and without it', () => {
    // An index moves the plan, never the answer — and this list is what the
    // owner acts on, so a dropped row is an approval that silently disappears.
    const build = (withIndex: boolean): string[] => {
      const db = new Database(':memory:');
      ensureChatSchema(db);
      if (!withIndex) db.exec('DROP INDEX idx_chat_plans_proposed');
      // ⚠ SEED THE PARENT ROWS rather than switching foreign keys off.
      // `chat_plans.session_id` references `chat_sessions`, and a fixture that
      // disables the constraint is testing a database shape the server never
      // has. Columns are read from the schema, not written from memory.
      const seedCols = db.prepare(`PRAGMA table_info(chat_sessions)`).all() as Array<{
        name: string; notnull: number; type: string; pk: number;
      }>;
      const seedIns = db.prepare(
        `INSERT INTO chat_sessions (${seedCols.map((c) => c.name).join(',')})
         VALUES (${seedCols.map(() => '?').join(',')})`,
      );
      for (let sIdx = 0; sIdx < 5; sIdx++) {
        seedIns.run(...seedCols.map((c) => {
          if (c.name === 'session_id') return `s-${sIdx}`;
          if (/_at$/.test(c.name)) return 1_700_000_000;
          if (c.notnull === 1) return /INT|REAL|NUM/i.test(c.type) ? 0 : 'x';
          return null;
        }));
      }
      const cols = db.prepare(`PRAGMA table_info(chat_plans)`).all() as Array<{
        name: string; notnull: number; type: string; pk: number;
      }>;
      const ins = db.prepare(
        `INSERT INTO chat_plans (${cols.map((c) => c.name).join(',')})
         VALUES (${cols.map(() => '?').join(',')})`,
      );
      for (let i = 0; i < 200; i++) {
        ins.run(...cols.map((c) => {
          if (c.name === 'plan_id') return `p-${1000 + i}`;
          if (c.name === 'session_id') return `s-${i % 5}`;
          if (c.name === 'status') return i % 3 === 0 ? 'proposed' : 'approved';
          if (/_at$/.test(c.name)) return 1_700_000_000 + (i % 7);   // ties, on purpose
          if (c.pk === 1) return `pk-${i}`;
          if (c.notnull === 1) return /INT|REAL|NUM/i.test(c.type) ? 0 : 'x';
          return null;
        }));
      }
      const out = (db.prepare(PENDING).all() as Array<{ plan_id: string }>).map((r) => r.plan_id);
      db.close();
      return out;
    };
    const withIdx = build(true);
    expect(withIdx).toEqual(build(false));
    expect(withIdx.length).toBeGreaterThan(0);
  });
});
