/** D-207 slice 3d·4 — the `free` / `recurring` pricing backing, tested through the
 *  REAL store and a REAL SQLite database.
 *
 *  3d·3 widened `SELLER_OFFER_PRICING_KINDS` to VOCABULARY only: `free` and
 *  `recurring` type-checked but were unreachable — an offer with either failed
 *  closed at the offer table's amount/currency CHECK, `ensureOffer` special-cased
 *  only `fixed`, and the orders `pricing_kind` CHECK had no converger. This slice
 *  wires the three seams together (§4.4a):
 *    - PRICED (`fixed`/`recurring`) → positive `amount_minor` + `currency`;
 *    - UNPRICED (`unspecified`/`free`) → neither.
 *
 *  ⛔ Both the SQL CHECK and `ensureOffer` DERIVE from one const
 *  (`SELLER_OFFER_PRICING_REQUIRES_AMOUNT`), so the fence and the runtime check can
 *  never disagree. And because the amount/currency CHECK is a hand-shaped rule (not
 *  an enum), a live table that predates the rule change slips past the membership
 *  converger — so `convergeSellerOffersSchema` was taught to detect it, and the
 *  orders table got its own converger.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  SELLER_OFFER_PRICING_KINDS,
  sellerOfferPricingRequiresAmount,
} from '@recued/contracts';
import {
  createSellerStore,
  ensureSellerSchema,
  SELLER_OFFERS_TABLE,
  SELLER_ORDERS_TABLE,
} from '../storage/seller-store.js';

const NOW = 1_720_000_000_000;

const openDb = (): Database.Database => new Database(':memory:');

const storedDdl = (db: Database.Database, table: string): string =>
  (
    db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`)
      .get(table) as { sql: string }
  ).sql;

/** A fully-populated order row for the given pricing_kind, so a raw insert
 *  exercises ONLY the `pricing_kind` CHECK and not a NOT-NULL omission. */
const insertOrder = (
  db: Database.Database,
  order_key: string,
  order_handle: string,
  pricing_kind: string,
): void => {
  db.prepare(
    `INSERT INTO ${SELLER_ORDERS_TABLE}
       (order_key, order_handle, offer_id, origin_kind, origin_ref, phase,
        pricing_kind, revision, created_at, updated_at)
     VALUES (?, ?, 'offer-1', 'manual', 'ref-1', 'draft', ?, 0, ?, ?)`,
  ).run(order_key, order_handle, pricing_kind, NOW, NOW);
};

describe('D-207 slice 3d·4 — free/recurring offers (fresh DB)', () => {
  it('creates a `free` offer with no amount and no currency', () => {
    const db = openDb();
    ensureSellerSchema(db);
    const store = createSellerStore(db);
    const created = store.ensureOffer({
      offer_id: 'welcome-guide',
      kind: 'document',
      display_name: 'Welcome guide',
      description: 'A free download.',
      pricing_kind: 'free',
      now: NOW,
    });
    expect(created.result).toBe('created');
    expect(created.offer.pricing_kind).toBe('free');
    expect(created.offer.amount_minor).toBeNull();
    expect(created.offer.currency).toBeNull();
  });

  it('creates a `recurring` offer shaped like a fixed price', () => {
    const db = openDb();
    ensureSellerSchema(db);
    const store = createSellerStore(db);
    const created = store.ensureOffer({
      offer_id: 'pro-plan',
      kind: 'access',
      display_name: 'Pro plan',
      description: 'Monthly subscription.',
      pricing_kind: 'recurring',
      amount_minor: 1_200,
      currency: 'usd',
      now: NOW,
    });
    expect(created.result).toBe('created');
    expect(created.offer.pricing_kind).toBe('recurring');
    expect(created.offer.amount_minor).toBe(1_200);
    // `cleanOfferCurrency` normalizes to uppercase, so `usd` and `USD` can never
    // read as two currencies.
    expect(created.offer.currency).toBe('USD');
  });

  it('refuses a `free` offer that carries an amount (unpriced must be empty)', () => {
    const db = openDb();
    ensureSellerSchema(db);
    const store = createSellerStore(db);
    expect(() =>
      store.ensureOffer({
        offer_id: 'not-free',
        kind: 'document',
        display_name: 'Not free',
        description: 'Contradiction.',
        pricing_kind: 'free',
        amount_minor: 500,
        now: NOW,
      }),
    ).toThrow(/amount_minor must be absent for free pricing/);
  });

  it('refuses a `recurring` offer with no amount (priced must have one)', () => {
    const db = openDb();
    ensureSellerSchema(db);
    const store = createSellerStore(db);
    expect(() =>
      store.ensureOffer({
        offer_id: 'no-price',
        kind: 'access',
        display_name: 'No price',
        description: 'Missing amount.',
        pricing_kind: 'recurring',
        currency: 'usd',
        now: NOW,
      }),
    ).toThrow(/amount_minor must be a positive safe integer for recurring pricing/);
  });

  it('refuses a `recurring` offer with an amount but no currency', () => {
    const db = openDb();
    ensureSellerSchema(db);
    const store = createSellerStore(db);
    expect(() =>
      store.ensureOffer({
        offer_id: 'no-currency',
        kind: 'access',
        display_name: 'No currency',
        description: 'Missing currency.',
        pricing_kind: 'recurring',
        amount_minor: 1_200,
        now: NOW,
      }),
    ).toThrow(/currency is required for recurring pricing/);
  });

  /** The runtime check is not the only fence — the storage CHECK refuses the same
   *  shape independently, so a caller reaching the row past `ensureOffer` (a future
   *  op, a migration) still cannot land a half-defined free offer. */
  it('the storage CHECK independently refuses a free offer carrying an amount', () => {
    const db = openDb();
    ensureSellerSchema(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO ${SELLER_OFFERS_TABLE}
             (offer_id, kind, display_name, description, pricing_kind, amount_minor,
              currency, state, created_at, updated_at)
           VALUES ('x', 'document', 'X', 'd', 'free', 500, 'usd', 'draft', ?, ?)`,
        )
        .run(NOW, NOW),
    ).toThrow();
  });
});

describe('D-207 slice 3d·4 — free/recurring orders (fresh DB)', () => {
  it('admits a `free` and a `recurring` order', () => {
    const db = openDb();
    ensureSellerSchema(db);
    expect(() => insertOrder(db, 'ord-free', 'oh_free', 'free')).not.toThrow();
    expect(() => insertOrder(db, 'ord-recur', 'oh_recur', 'recurring')).not.toThrow();
  });
});

/** ── Existing-DB convergence ──────────────────────────────────────────────────
 *
 *  A generated CHECK is real exactly once, at creation; `CREATE TABLE IF NOT EXISTS`
 *  skips an existing table and SQLite cannot ALTER a CHECK. The two tests below
 *  create a table in the state a server that predates this slice would be in, then
 *  prove `ensureSellerSchema` converges it. */
describe('D-207 slice 3d·4 — the amount/currency CHECK convergence (offers)', () => {
  /** The load-bearing case: a table whose `pricing_kind IN (...)` list ALREADY
   *  admits `free`/`recurring` (as it would after 3d·3's enum widening) but whose
   *  amount/currency CHECK still only branches `fixed`/`unspecified`. Every enum
   *  member is present, so the membership converger returns early — ONLY the
   *  CHECK-clause detection forces the rebuild. Disarm `admitsCurrentPricingRule`
   *  in `convergeSellerOffersSchema` and this test goes red. */
  it('rebuilds a table whose amount/currency CHECK predates free/recurring', () => {
    const db = openDb();
    db.exec(`
      CREATE TABLE ${SELLER_OFFERS_TABLE} (
        offer_id                 TEXT PRIMARY KEY,
        kind                     TEXT NOT NULL CHECK (kind IN ('document', 'service', 'event', 'reservation', 'physical', 'access')),
        display_name             TEXT NOT NULL,
        description              TEXT NOT NULL,
        pricing_kind             TEXT NOT NULL CHECK (pricing_kind IN ('fixed', 'unspecified', 'free', 'recurring')),
        amount_minor             INTEGER,
        currency                 TEXT,
        fulfillment_recipe_id    TEXT,
        checkout_url             TEXT,
        state                    TEXT NOT NULL CHECK (state IN ('draft', 'active', 'paused', 'archived')),
        created_by_recipe_id     TEXT,
        created_at               INTEGER NOT NULL,
        updated_at               INTEGER NOT NULL,
        CHECK (
          (pricing_kind = 'fixed'
            AND amount_minor IS NOT NULL AND amount_minor > 0
            AND currency IS NOT NULL)
          OR
          (pricing_kind = 'unspecified'
            AND amount_minor IS NULL
            AND currency IS NULL)
        )
      )`);
    // A legacy row that must survive the rebuild verbatim.
    db.prepare(
      `INSERT INTO ${SELLER_OFFERS_TABLE}
         (offer_id, kind, display_name, description, pricing_kind, amount_minor,
          currency, state, created_at, updated_at)
       VALUES ('legacy', 'document', 'Legacy', 'd', 'fixed', 900, 'usd', 'active', ?, ?)`,
    ).run(NOW, NOW);

    // Non-vacuity: the membership converger is SATISFIED — every declared pricing
    // member is already in the table SQL — so the ONLY thing that can force a
    // rebuild is the CHECK-clause detection this slice added.
    const legacySql = storedDdl(db, SELLER_OFFERS_TABLE);
    for (const kind of SELLER_OFFER_PRICING_KINDS) {
      expect(legacySql, `membership should already admit '${kind}'`).toContain(
        `'${kind}'`,
      );
    }
    // And the old CHECK genuinely refuses a free offer today.
    expect(() =>
      db
        .prepare(
          `INSERT INTO ${SELLER_OFFERS_TABLE}
             (offer_id, kind, display_name, description, pricing_kind, amount_minor,
              currency, state, created_at, updated_at)
           VALUES ('free-before', 'document', 'F', 'd', 'free', NULL, NULL, 'draft', ?, ?)`,
        )
        .run(NOW, NOW),
    ).toThrow();

    ensureSellerSchema(db);

    // After convergence a free offer inserts, and the legacy fixed row survived.
    const store = createSellerStore(db);
    const created = store.ensureOffer({
      offer_id: 'free-after',
      kind: 'document',
      display_name: 'Free after',
      description: 'Now reachable.',
      pricing_kind: 'free',
      now: NOW,
    });
    expect(created.result).toBe('created');
    const legacy = db
      .prepare(
        `SELECT pricing_kind, amount_minor FROM ${SELLER_OFFERS_TABLE} WHERE offer_id = 'legacy'`,
      )
      .get() as { pricing_kind: string; amount_minor: number };
    expect(legacy).toEqual({ pricing_kind: 'fixed', amount_minor: 900 });

    // ⛔ Post-converge idempotency: the detection uses `existing.sql.includes(clause)`,
    // and SQLite's RENAME must preserve the CHECK text verbatim or every boot would
    // re-converge. Prove it does NOT rebuild again — a rebuild would DROP+recreate
    // the table, changing the row's rowid.
    const rowidBefore = (
      db
        .prepare(`SELECT rowid AS r FROM ${SELLER_OFFERS_TABLE} WHERE offer_id = 'legacy'`)
        .get() as { r: number }
    ).r;
    ensureSellerSchema(db);
    const rowidAfter = (
      db
        .prepare(`SELECT rowid AS r FROM ${SELLER_OFFERS_TABLE} WHERE offer_id = 'legacy'`)
        .get() as { r: number }
    ).r;
    expect(rowidAfter).toBe(rowidBefore);
  });

  it('leaves a converged offers schema alone on the next boot (idempotent)', () => {
    const db = openDb();
    ensureSellerSchema(db);
    const first = storedDdl(db, SELLER_OFFERS_TABLE);
    ensureSellerSchema(db);
    expect(storedDdl(db, SELLER_OFFERS_TABLE)).toBe(first);
  });
});

describe('D-207 slice 3d·4 — the orders pricing_kind CHECK convergence', () => {
  /** The orders table snapshots `pricing_kind` from the offer at open, so a table
   *  created before the enum widened would refuse a free/recurring order. There was
   *  no orders converger before this slice — remove `convergeSellerOrdersSchema`
   *  from `ensureSellerSchema` and this goes red. */
  it('rebuilds an orders table whose pricing_kind CHECK predates free/recurring', () => {
    const db = openDb();
    db.exec(`
      CREATE TABLE ${SELLER_ORDERS_TABLE} (
        order_key                TEXT PRIMARY KEY,
        order_handle             TEXT NOT NULL UNIQUE,
        offer_id                 TEXT NOT NULL,
        origin_kind              TEXT NOT NULL CHECK (origin_kind IN ('reception_submission', 'seller_customer', 'manual')),
        origin_ref               TEXT NOT NULL,
        phase                    TEXT NOT NULL CHECK (phase IN ('draft', 'pricing', 'awaiting_payment', 'paid', 'fulfilling', 'approved', 'delivering', 'complete', 'needs_owner', 'ambiguous', 'failed', 'expired', 'cancelled', 'refunded')),
        pricing_kind             TEXT NOT NULL CHECK (pricing_kind IN ('fixed', 'unspecified')),
        amount_minor             INTEGER,
        currency                 TEXT,
        fulfillment_recipe_id    TEXT,
        customer_id              TEXT,
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
      )`);
    insertOrder(db, 'ord-fixed', 'oh_fixed', 'fixed');

    // The old CHECK refuses a free order today.
    expect(() => insertOrder(db, 'ord-free-before', 'oh_free_before', 'free')).toThrow();

    ensureSellerSchema(db);

    // After convergence a free and a recurring order insert, and the legacy row survived.
    expect(() => insertOrder(db, 'ord-free-after', 'oh_free_after', 'free')).not.toThrow();
    expect(() => insertOrder(db, 'ord-recur-after', 'oh_recur_after', 'recurring')).not.toThrow();
    const fixed = db
      .prepare(`SELECT pricing_kind FROM ${SELLER_ORDERS_TABLE} WHERE order_key = 'ord-fixed'`)
      .get() as { pricing_kind: string };
    expect(fixed.pricing_kind).toBe('fixed');
  });
});

/** A guard on the derivation itself: the const the SQL CHECK and `ensureOffer` both
 *  read must classify every pricing kind, and match the §4.4a intent. If a future
 *  kind is added to `SELLER_OFFER_PRICING_KINDS` without an amount rule, the
 *  `satisfies Record` makes `SELLER_OFFER_PRICING_REQUIRES_AMOUNT` a compile error;
 *  this pins the four current answers so a silent flip is caught. */
describe('D-207 slice 3d·4 — the pricing-requires-amount partition', () => {
  it('classifies fixed/recurring as priced and unspecified/free as unpriced', () => {
    expect(sellerOfferPricingRequiresAmount('fixed')).toBe(true);
    expect(sellerOfferPricingRequiresAmount('recurring')).toBe(true);
    expect(sellerOfferPricingRequiresAmount('unspecified')).toBe(false);
    expect(sellerOfferPricingRequiresAmount('free')).toBe(false);
  });
});
