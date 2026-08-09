/** Cancelling a consumer's dispatches seeks by trigger instead of scanning.
 *
 *  ⛔ THE DEFECT. Six statements read `webhook_recipe_dispatches` by
 *  `trigger_id` — the consumer-uninstall cancel (three JOINs down from
 *  `webhook_consumer_bindings`) and the trigger-level cancel, whose three
 *  statements run INSIDE A LOOP over the consumer's triggers. The only index on
 *  the table led with `event_id`, so each of them scanned the whole dispatch
 *  table, once per trigger.
 *
 *  This table grows with EVERY inbound webhook event (D-148 P9 posts straight to
 *  the server), so it has no natural ceiling. Measured at 200k dispatches across
 *  2,000 triggers, uninstalling one consumer owning 5 of them:
 *  **33.6ms -> 0.26ms (130x)**.
 *
 *  ⚠ MY FIRST BENCHMARK SAID 2x, AND THE BENCHMARK WAS WRONG. It seeded 40
 *  triggers over 200k rows, giving each trigger 2.5% of the table — so the seek
 *  still returned 5,000 rows and the work was dominated by returning them. The
 *  real shape is MANY triggers across the whole install base with a consumer
 *  owning a few. Same lesson as EXPLAINing the statement the product issues:
 *  benchmark the distribution the product has, not the one that is easy to
 *  seed. */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { createWebhookConsumerStore } from '../storage/webhook-consumer-store.js';

/** The schema, built the way the server builds it. `createSchema` is private,
 *  so the factory IS the entry point — which also means these assertions run
 *  against the composition rather than a schema this file invented. */
const ensureSchema = (db: Database.Database): void => {
  createWebhookConsumerStore(db, {} as never);
};

const BY_TRIGGER = `SELECT dispatch_id FROM webhook_recipe_dispatches WHERE trigger_id = ?`;
const CANCEL = `UPDATE webhook_recipe_dispatches SET state = 'cancelled', claim_token = NULL,
                  updated_at = ? WHERE trigger_id = ? AND state IN ('pending', 'running')`;
const IDX = 'idx_webhook_recipe_dispatches_trigger';

const planFor = (sql: string, args: unknown[], drop?: string): string => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  ensureSchema(db);
  if (drop !== undefined) db.exec(`DROP INDEX ${drop}`);
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args as never[]) as Array<{
    detail: string;
  }>;
  db.close();
  return rows.map((r) => r.detail).join(' ; ');
};

describe('webhook dispatch trigger index', () => {
  it('⛔ a by-trigger read SEEKS', () => {
    const plan = planFor(BY_TRIGGER, ['t-1']);
    expect(plan, plan).toMatch(/SEARCH .*USING (COVERING )?INDEX idx_webhook_recipe_dispatches_trigger/);
  });

  it('⛔ KNOWN NEGATIVE: without it, every by-trigger read scans the table', () => {
    const plan = planFor(BY_TRIGGER, ['t-1'], IDX);
    expect(plan, plan).toMatch(/SCAN webhook_recipe_dispatches/);
    expect(plan, plan).not.toMatch(/USING INDEX/);
  });

  it('⛔ the CANCEL uses both columns, not just the seek', () => {
    // `state` is second on purpose: the cancel statements pair
    // `trigger_id = ?` with `state IN ('pending','running')`, so the plan should
    // narrow on both rather than seeking and then filtering.
    const plan = planFor(CANCEL, [1, 't-1']);
    expect(plan, plan).toMatch(/SEARCH .*INDEX idx_webhook_recipe_dispatches_trigger \(trigger_id=\? AND state=/);
  });

  it('⛔ the uninstall JOIN stops scanning dispatches too', () => {
    // The three-table shape the consumer-uninstall path uses. It reached
    // dispatches with no usable index and scanned it while the bindings and
    // triggers halves seeked.
    const sql = `DELETE FROM webhook_payload_pins WHERE pin_id IN (
      SELECT dispatch.dispatch_id FROM webhook_recipe_dispatches dispatch
      JOIN webhook_recipe_triggers trigger ON trigger.trigger_id = dispatch.trigger_id
      JOIN webhook_consumer_bindings binding ON binding.binding_id = trigger.binding_id
      WHERE binding.consumer_kind = ? AND binding.consumer_id = ?)`;
    const plan = planFor(sql, ['recipe', 'c-1']);
    expect(plan, plan).not.toMatch(/SCAN (webhook_recipe_dispatches|dispatch)\b/);
  });

  it('returns the same dispatches with and without the index', () => {
    const build = (withIndex: boolean): string[] => {
      const db = new Database(':memory:');
      db.pragma('foreign_keys = OFF');
      ensureSchema(db);
      if (!withIndex) db.exec(`DROP INDEX ${IDX}`);
      const cols = db.prepare(`PRAGMA table_info(webhook_recipe_dispatches)`).all() as Array<{
        name: string; notnull: number; type: string;
      }>;
      // ⚠ Every UNIQUE-indexed column needs a DISTINCT value per row — the
      // generic NOT NULL fallback hands them all the same one and the insert
      // fails on a constraint that has nothing to do with this test.
      const unique = new Set<string>();
      for (const idx of db.prepare(`PRAGMA index_list(webhook_recipe_dispatches)`).all() as Array<{
        name: string; unique: number;
      }>) {
        if (idx.unique !== 1) continue;
        for (const c of db.prepare(`PRAGMA index_info(${idx.name})`).all() as Array<{
          name: string | null;
        }>) if (c.name) unique.add(c.name);
      }
      const ins = db.prepare(
        `INSERT INTO webhook_recipe_dispatches (${cols.map((c) => c.name).join(',')})
         VALUES (${cols.map(() => '?').join(',')})`,
      );
      for (let i = 0; i < 300; i++) {
        ins.run(...cols.map((c) => {
          if (c.name === 'trigger_id') return `t-${i % 10}`;
          // The column CHECKs its vocabulary; 'done' is not in it.
          if (c.name === 'state') return i % 4 === 0 ? 'pending' : 'dispatched';
          if (unique.has(c.name)) return `${c.name}-${i}`;
          if (/_at$/.test(c.name)) return 1_700_000_000 + i;
          if (c.notnull === 1) return /INT|REAL|NUM/i.test(c.type) ? 0 : 'x';
          return null;
        }));
      }
      const out = (db.prepare(BY_TRIGGER).all('t-3') as Array<{ dispatch_id: string }>)
        .map((r) => r.dispatch_id).sort();
      db.close();
      return out;
    };
    const withIdx = build(true);
    expect(withIdx).toEqual(build(false));
    expect(withIdx).toHaveLength(30);
  });
});
