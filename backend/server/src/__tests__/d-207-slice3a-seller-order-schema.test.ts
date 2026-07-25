/** D-207 slice 3a — the seller schema, tested through the REAL store.
 *
 *  ⛔ Slice 1c shipped INERT to production because every door test faked the
 *  contract store with an in-memory Map, while the one store that actually
 *  validates rejected every write. The schema IS the gate — so test it through
 *  the real gate. These tests open a real SQLite database and run the real
 *  `ensureSellerSchema`.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  SELLER_OFFER_KINDS,
  SELLER_OFFER_PRICING_KINDS,
  SELLER_ORDER_PHASES,
} from '@recued/contracts';
import {
  ensureSellerSchema,
  SELLER_OFFERS_TABLE,
  SELLER_ORDERS_TABLE,
} from '../storage/seller-store.js';

const openDb = (): Database.Database => new Database(':memory:');

const columnsOf = (db: Database.Database, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (c) => c.name,
  );

const storedDdl = (db: Database.Database, table: string): string =>
  (
    db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`)
      .get(table) as { sql: string }
  ).sql;

describe('D-207 slice 3a — the `seller_orders` table', () => {
  it('is created with the order columns the row shape declares', () => {
    const db = openDb();
    ensureSellerSchema(db);
    const columns = columnsOf(db, SELLER_ORDERS_TABLE);
    for (const expected of [
      'order_key',
      'order_handle',
      'offer_id',
      'origin_kind',
      'origin_ref',
      'phase',
      'pricing_kind',
      'amount_minor',
      'currency',
      'checkout_url',
      'linked_work_entity_kind',
      'linked_work_entity_id',
      'revision',
      'paid_at',
      'expires_at',
    ]) {
      expect(columns, `seller_orders is missing '${expected}'`).toContain(expected);
    }
    db.close();
  });

  /** The generated CHECK must admit the whole phase vocabulary — this is the
   *  invariant, not the literal list. */
  it('admits every declared order phase', () => {
    const db = openDb();
    ensureSellerSchema(db);
    const ddl = storedDdl(db, SELLER_ORDERS_TABLE);
    for (const phase of SELLER_ORDER_PHASES) {
      expect(ddl, `the phase CHECK omits '${phase}'`).toContain(`'${phase}'`);
    }
    db.close();
  });

  it('refuses a half-populated work-entity link (a provenance field that lies)', () => {
    const db = openDb();
    ensureSellerSchema(db);
    const insert = (kind: string | null, id: string | null): void => {
      db.prepare(
        `INSERT INTO ${SELLER_ORDERS_TABLE}
           (order_key, order_handle, offer_id, origin_kind, origin_ref, phase,
            pricing_kind, revision, created_at, updated_at,
            linked_work_entity_kind, linked_work_entity_id)
         VALUES (?, ?, 'o1', 'reception_submission', 'sub_1', 'draft',
                 'fixed', 0, 1, 1, ?, ?)`,
      ).run(`ord:o1:sub_${String(Math.abs(kind === null ? 1 : 2))}`, `oh_${'a'.repeat(64)}`, kind, id);
    };
    expect(() => insert('task', null)).toThrow();
    expect(() => insert(null, 'wt_1')).toThrow();
    db.close();
  });

  it('refuses a duplicate order_handle', () => {
    const db = openDb();
    ensureSellerSchema(db);
    const handle = `oh_${'b'.repeat(64)}`;
    const insert = (key: string): void => {
      db.prepare(
        `INSERT INTO ${SELLER_ORDERS_TABLE}
           (order_key, order_handle, offer_id, origin_kind, origin_ref, phase,
            pricing_kind, revision, created_at, updated_at)
         VALUES (?, ?, 'o1', 'reception_submission', 'sub_1', 'draft', 'fixed', 0, 1, 1)`,
      ).run(key, handle);
    };
    insert('ord:o1:sub_1');
    expect(() => insert('ord:o1:sub_2')).toThrow();
    db.close();
  });
});

describe('D-207 slice 3a — the CHECK-drift convergence', () => {
  it('adds `checkout_url` to an offers table that predates it', () => {
    const db = openDb();
    ensureSellerSchema(db);
    // Simulate the pre-D-207 shape by dropping the column back off.
    db.exec(`ALTER TABLE ${SELLER_OFFERS_TABLE} DROP COLUMN checkout_url`);
    expect(columnsOf(db, SELLER_OFFERS_TABLE)).not.toContain('checkout_url');

    ensureSellerSchema(db);
    expect(columnsOf(db, SELLER_OFFERS_TABLE)).toContain('checkout_url');
    db.close();
  });

  /** ⛔ THE ONE THAT HAS TO BITE.
   *
   *  `CREATE TABLE IF NOT EXISTS` skips an existing table, and SQLite cannot
   *  ALTER a CHECK. So a CHECK generated from a TypeScript const is real exactly
   *  once — at creation — and frozen forever after. Widen `SELLER_OFFER_KINDS` on
   *  a live server and every new kind is still rejected, by a CHECK compiled from
   *  the old const, while a fresh-DB suite stays green. That is the SQL twin of
   *  the `door_types` value_shape bug that made slice 1c inert in production.
   *
   *  Here the live table admits only `'fixed'` — omitting `'unspecified'`, which
   *  the const DOES declare. Convergence must rebuild it, WITHOUT losing the row
   *  that is already there. Delete `convergeSellerOffersSchema` and this fails. */
  it('rebuilds a live table whose CHECK does not admit a currently-declared member', () => {
    const db = openDb();
    db.exec(`
      CREATE TABLE ${SELLER_OFFERS_TABLE} (
        offer_id                 TEXT PRIMARY KEY,
        kind                     TEXT NOT NULL CHECK (kind IN ('one_time_outcome')),
        display_name             TEXT NOT NULL,
        description              TEXT NOT NULL,
        pricing_kind             TEXT NOT NULL CHECK (pricing_kind IN ('fixed')),
        amount_minor             INTEGER,
        currency                 TEXT,
        fulfillment_recipe_id    TEXT,
        state                    TEXT NOT NULL CHECK (state IN ('draft', 'active', 'paused', 'archived')),
        created_by_recipe_id     TEXT,
        created_at               INTEGER NOT NULL,
        updated_at               INTEGER NOT NULL
      );
    `);
    db.prepare(
      `INSERT INTO ${SELLER_OFFERS_TABLE}
         (offer_id, kind, display_name, description, pricing_kind, amount_minor,
          currency, fulfillment_recipe_id, state, created_by_recipe_id, created_at, updated_at)
       VALUES ('legacy', 'one_time_outcome', 'Legacy', 'desc', 'fixed', 500,
               'usd', NULL, 'active', NULL, 10, 20)`,
    ).run();

    // Before convergence the live table refuses a member the const declares.
    expect(SELLER_OFFER_PRICING_KINDS).toContain('unspecified');
    expect(() =>
      db
        .prepare(
          `INSERT INTO ${SELLER_OFFERS_TABLE}
             (offer_id, kind, display_name, description, pricing_kind, amount_minor,
              currency, fulfillment_recipe_id, state, created_by_recipe_id, created_at, updated_at)
           VALUES ('quote', 'one_time_outcome', 'Quote', 'desc', 'unspecified', NULL,
                   NULL, NULL, 'draft', NULL, 10, 20)`,
        )
        .run(),
    ).toThrow();

    ensureSellerSchema(db);

    // The live table now admits every declared member ...
    const ddl = storedDdl(db, SELLER_OFFERS_TABLE);
    for (const member of [...SELLER_OFFER_KINDS, ...SELLER_OFFER_PRICING_KINDS]) {
      expect(ddl, `the converged CHECK omits '${member}'`).toContain(`'${member}'`);
    }
    expect(() =>
      db
        .prepare(
          `INSERT INTO ${SELLER_OFFERS_TABLE}
             (offer_id, kind, display_name, description, pricing_kind, amount_minor,
              currency, fulfillment_recipe_id, checkout_url, state, created_by_recipe_id, created_at, updated_at)
           VALUES ('quote', 'document', 'Quote', 'desc', 'unspecified', NULL,
                   NULL, NULL, NULL, 'draft', NULL, 10, 20)`,
        )
        .run(),
    ).not.toThrow();

    // ... and the pre-existing row survived the rebuild AND was remapped: D-207
    // §4.1 retired `one_time_outcome`, so the converge copy rewrote it to the
    // declared successor `document` rather than letting the new CHECK refuse it.
    const legacy = db
      .prepare(`SELECT offer_id, kind, amount_minor, state FROM ${SELLER_OFFERS_TABLE} WHERE offer_id = 'legacy'`)
      .get() as
      | { offer_id: string; kind: string; amount_minor: number; state: string }
      | undefined;
    expect(legacy).toEqual({ offer_id: 'legacy', kind: 'document', amount_minor: 500, state: 'active' });

    // The new column arrived with the rebuild.
    expect(columnsOf(db, SELLER_OFFERS_TABLE)).toContain('checkout_url');
    db.close();
  });

  /** ⛔ THE OWNER-RULED VALUE MIGRATION (D-207 §4.1 / 3d·3).
   *
   *  Widening keeps every stored row valid, so a verbatim copy suffices. RETIRING
   *  a member does not: a row holding the retired value would be REFUSED by the
   *  new CHECK. `one_time_outcome` was the single pre-D-207 kind and is superseded
   *  by `document`, so the converge copy must rewrite it in flight. Drop the
   *  remap and `ensureSellerSchema` throws on the copy (the new CHECK rejects the
   *  legacy value) — this test fails loudly rather than silently mangling data. */
  it('remaps a retired `one_time_outcome` offer row to `document` on convergence', () => {
    const db = openDb();
    db.exec(`
      CREATE TABLE ${SELLER_OFFERS_TABLE} (
        offer_id                 TEXT PRIMARY KEY,
        kind                     TEXT NOT NULL CHECK (kind IN ('one_time_outcome')),
        display_name             TEXT NOT NULL,
        description              TEXT NOT NULL,
        pricing_kind             TEXT NOT NULL CHECK (pricing_kind IN ('fixed', 'unspecified')),
        amount_minor             INTEGER,
        currency                 TEXT,
        fulfillment_recipe_id    TEXT,
        checkout_url             TEXT,
        state                    TEXT NOT NULL CHECK (state IN ('draft', 'active', 'paused', 'archived')),
        created_by_recipe_id     TEXT,
        created_at               INTEGER NOT NULL,
        updated_at               INTEGER NOT NULL
      );
    `);
    db.prepare(
      `INSERT INTO ${SELLER_OFFERS_TABLE}
         (offer_id, kind, display_name, description, pricing_kind, amount_minor,
          currency, fulfillment_recipe_id, checkout_url, state, created_by_recipe_id, created_at, updated_at)
       VALUES ('doc', 'one_time_outcome', 'Doc', 'desc', 'fixed', 900,
               'USD', NULL, NULL, 'active', NULL, 30, 40)`,
    ).run();

    // The retired value is gone from the current vocabulary, so a verbatim copy
    // into the rebuilt table would violate its CHECK.
    expect(SELLER_OFFER_KINDS as readonly string[]).not.toContain('one_time_outcome');

    ensureSellerSchema(db);

    const remapped = db
      .prepare(`SELECT kind, amount_minor FROM ${SELLER_OFFERS_TABLE} WHERE offer_id = 'doc'`)
      .get() as { kind: string; amount_minor: number };
    expect(remapped.kind).toBe('document');
    // Non-kind columns copy verbatim alongside the rewrite.
    expect(remapped.amount_minor).toBe(900);
    // No legacy value escaped the rewrite.
    const stragglers = db
      .prepare(
        `SELECT COUNT(*) AS n FROM ${SELLER_OFFERS_TABLE} WHERE kind = 'one_time_outcome'`,
      )
      .get() as { n: number };
    expect(stragglers.n).toBe(0);
    db.close();
  });

  /** D-196 renewal — the ORDERS twin of the offers converge test. A live table
   *  created before `SELLER_ORDER_ORIGIN_KINDS` gained `provider_invoice` still
   *  rejects every renewal order through a CHECK compiled from the old const,
   *  while a fresh-DB suite stays green. The converger must rebuild it — with
   *  the existing rows carried verbatim (the order vocabularies only ever
   *  widened, so no remap). */
  it('rebuilds a live orders table whose origin CHECK predates provider_invoice', () => {
    const db = openDb();
    // The full current column set, but the CHECKs as a pre-renewal server
    // compiled them: three origin kinds, no `provider_invoice`.
    db.exec(`
      CREATE TABLE ${SELLER_ORDERS_TABLE} (
        order_key                TEXT PRIMARY KEY,
        order_handle             TEXT NOT NULL UNIQUE,
        offer_id                 TEXT NOT NULL,
        origin_kind              TEXT NOT NULL CHECK (origin_kind IN ('reception_submission', 'seller_customer', 'manual')),
        origin_ref               TEXT NOT NULL,
        phase                    TEXT NOT NULL CHECK (phase IN ('draft', 'pricing', 'awaiting_payment', 'paid', 'fulfilling', 'approved', 'delivering', 'complete', 'needs_owner', 'ambiguous', 'failed', 'expired', 'cancelled', 'refunded')),
        pricing_kind             TEXT NOT NULL CHECK (pricing_kind IN ('fixed', 'unspecified', 'free', 'recurring')),
        amount_minor             INTEGER,
        currency                 TEXT,
        fulfillment_recipe_id    TEXT,
        customer_id              TEXT,
        entitlement_key          TEXT,
        provider                 TEXT,
        provider_session_id      TEXT,
        provider_payment_id      TEXT,
        checkout_url             TEXT,
        artifact_ref             TEXT,
        artifact_hash            TEXT,
        linked_work_entity_kind  TEXT,
        linked_work_entity_id    TEXT,
        error_code               TEXT,
        revision                 INTEGER NOT NULL,
        created_at               INTEGER NOT NULL,
        updated_at               INTEGER NOT NULL,
        paid_at                  INTEGER,
        expires_at               INTEGER
      );
    `);
    const insertRenewal = (): void => {
      db.prepare(
        `INSERT INTO ${SELLER_ORDERS_TABLE}
           (order_key, order_handle, offer_id, origin_kind, origin_ref, phase,
            pricing_kind, entitlement_key, revision, created_at, updated_at)
         VALUES ('ord:o1:in_cycle_2', 'oh_${'c'.repeat(64)}', 'o1', 'provider_invoice',
                 'in_cycle_2', 'draft', 'recurring', 'pro', 0, 1, 1)`,
      ).run();
    };
    db.prepare(
      `INSERT INTO ${SELLER_ORDERS_TABLE}
         (order_key, order_handle, offer_id, origin_kind, origin_ref, phase,
          pricing_kind, entitlement_key, revision, created_at, updated_at)
       VALUES ('ord:o1:sub_1', 'oh_${'d'.repeat(64)}', 'o1', 'reception_submission',
               'sub_1', 'complete', 'recurring', 'pro', 4, 1, 1)`,
    ).run();

    // Before convergence the live table refuses the origin the const declares.
    expect(() => insertRenewal()).toThrow();

    ensureSellerSchema(db);

    // The rebuilt CHECK admits it, and the acquisition row survived verbatim.
    expect(() => insertRenewal()).not.toThrow();
    const acquisition = db
      .prepare(`SELECT origin_kind, phase, revision FROM ${SELLER_ORDERS_TABLE} WHERE order_key = 'ord:o1:sub_1'`)
      .get() as { origin_kind: string; phase: string; revision: number };
    expect(acquisition).toEqual({
      origin_kind: 'reception_submission',
      phase: 'complete',
      revision: 4,
    });
    db.close();
  });

  it('is idempotent — a converged schema is left alone on the next boot', () => {
    const db = openDb();
    ensureSellerSchema(db);
    const before = storedDdl(db, SELLER_OFFERS_TABLE);
    ensureSellerSchema(db);
    ensureSellerSchema(db);
    expect(storedDdl(db, SELLER_OFFERS_TABLE)).toBe(before);
    db.close();
  });
});
