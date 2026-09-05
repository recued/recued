/** D-196 Paddle + Lemon Squeezy (2026-09-03) — the lifecycle-source CHECK is
 *  compiled into `seller_tiers` and `seller_customers` at CREATE and frozen in
 *  every existing database, so widening `SELLER_LIFECYCLE_SOURCES` alone would be
 *  INERT on a live server: every `paddle` row refused by a CHECK that only knows
 *  the old list, while a fresh-DB suite stays green.
 *
 *  This proves the converger in `ensureSellerSchema` is what makes the new
 *  members real: a database created under the OLD vocabulary refuses a `paddle`
 *  tier BEFORE the boot (so the guard is not vacuous), admits `paddle` and
 *  `lemonsqueezy` tiers and customers AFTER it, keeps every row it had, keeps
 *  its indexes, and is idempotent. It also proves the one guard the older
 *  convergers lack: a live table carrying a column the DDL does not is REFUSED
 *  intact rather than rebuilt with that column's data silently dropped. */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { SELLER_LIFECYCLE_SOURCES } from '@recued/contracts';

import {
  ensureSellerSchema,
  SELLER_CUSTOMERS_TABLE,
  SELLER_TIERS_TABLE,
} from '../storage/seller-store.js';

const LEGACY_SOURCES = ['manual', 'stripe', 'future_provider'] as const;
const legacyEnum = LEGACY_SOURCES.map((s) => `'${s}'`).join(', ');

/** The tables exactly as a server created them before the second provider
 *  existed: same columns, the CHECK over the OLD list. */
const legacyDdl = (extraTierColumn = ''): string => `
  CREATE TABLE ${SELLER_TIERS_TABLE} (
    tier_id                         TEXT PRIMARY KEY,
    door_id                         TEXT NOT NULL,
    lifecycle_source                TEXT NOT NULL CHECK (lifecycle_source IN (${legacyEnum})),
    entitlement_key                 TEXT NOT NULL,
    display_name                    TEXT NOT NULL,
    template_contract_id            TEXT NOT NULL,
    external_entitlement_id         TEXT,
    usage_policy_json               TEXT NOT NULL,
    pass_duration_seconds           INTEGER,
    customer_status_enabled_default INTEGER NOT NULL DEFAULT 0,
    active                          INTEGER NOT NULL DEFAULT 1,
    created_at                      INTEGER NOT NULL,
    updated_at                      INTEGER NOT NULL${extraTierColumn},
    UNIQUE (door_id, lifecycle_source, entitlement_key)
  );
  CREATE INDEX idx_seller_tiers_source ON ${SELLER_TIERS_TABLE} (lifecycle_source, entitlement_key);
  CREATE INDEX idx_seller_tiers_template_contract ON ${SELLER_TIERS_TABLE} (template_contract_id);
  CREATE TABLE ${SELLER_CUSTOMERS_TABLE} (
    customer_id              TEXT PRIMARY KEY,
    lifecycle_source         TEXT NOT NULL CHECK (lifecycle_source IN (${legacyEnum})),
    source_customer_id       TEXT NOT NULL,
    door_id                  TEXT NOT NULL,
    email                    TEXT,
    tier_id                  TEXT NOT NULL,
    contract_id              TEXT NOT NULL,
    inbound_token_id         TEXT,
    mcp_token_id             TEXT,
    external_subscription_id TEXT,
    source_status            TEXT,
    current_period_end       INTEGER,
    grace_until              INTEGER,
    access_state             TEXT NOT NULL CHECK (access_state IN ('active', 'grace', 'closed')),
    claim_email_sent_at      INTEGER,
    claim_email_marker       TEXT,
    status_email_sent_at     INTEGER,
    status_email_marker      TEXT,
    created_at               INTEGER NOT NULL,
    updated_at               INTEGER NOT NULL,
    UNIQUE (lifecycle_source, source_customer_id, door_id)
  );
  CREATE INDEX idx_seller_customers_email ON ${SELLER_CUSTOMERS_TABLE} (email);
  CREATE INDEX idx_seller_customers_contract ON ${SELLER_CUSTOMERS_TABLE} (contract_id);
  CREATE INDEX idx_seller_customers_tier ON ${SELLER_CUSTOMERS_TABLE} (tier_id);
`;

const insertTier = (db: Database.Database, source: string, id: string): void => {
  db.prepare(
    `INSERT INTO ${SELLER_TIERS_TABLE} (tier_id, door_id, lifecycle_source, entitlement_key,
       display_name, template_contract_id, usage_policy_json, created_at, updated_at)
     VALUES (?, 'door_main', ?, ?, ?, 'ct_template', '{}', 1, 1)`,
  ).run(id, source, `${source}-key`, `${source} tier`);
};

const insertCustomer = (db: Database.Database, source: string, id: string): void => {
  db.prepare(
    `INSERT INTO ${SELLER_CUSTOMERS_TABLE} (customer_id, lifecycle_source, source_customer_id,
       door_id, tier_id, contract_id, access_state, created_at, updated_at)
     VALUES (?, ?, ?, 'door_main', 'tier_x', 'ct_x', 'active', 1, 1)`,
  ).run(id, source, `${source}-customer`);
};

const tableSql = (db: Database.Database, table: string): string =>
  (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { sql: string }).sql;

const indexNames = (db: Database.Database, table: string): string[] =>
  (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`)
    .all(table) as { name: string }[]).map((row) => row.name).sort();

describe('seller_tiers / seller_customers converge onto the current lifecycle-source list', () => {
  it('the new members are really in the vocabulary', () => {
    expect(SELLER_LIFECYCLE_SOURCES).toContain('paddle');
    expect(SELLER_LIFECYCLE_SOURCES).toContain('lemonsqueezy');
  });

  it('a database created under the old list refuses paddle before the boot and admits it after, keeping rows and indexes', () => {
    const db = new Database(':memory:');
    try {
      db.exec(legacyDdl());
      insertTier(db, 'stripe', 'tier_stripe');
      insertCustomer(db, 'stripe', 'cust_stripe');

      // The guard is not vacuous: the OLD CHECK really rejects the new member.
      expect(() => insertTier(db, 'paddle', 'tier_paddle_early')).toThrow(/CHECK constraint failed/);
      expect(() => insertCustomer(db, 'lemonsqueezy', 'cust_ls_early')).toThrow(/CHECK constraint failed/);

      ensureSellerSchema(db);

      for (const table of [SELLER_TIERS_TABLE, SELLER_CUSTOMERS_TABLE]) {
        const sql = tableSql(db, table);
        expect(sql, `${table} CHECK admits paddle`).toContain("'paddle'");
        expect(sql, `${table} CHECK admits lemonsqueezy`).toContain("'lemonsqueezy'");
      }
      // Every row a server had survives the rebuild verbatim.
      expect(db.prepare(`SELECT tier_id, lifecycle_source FROM ${SELLER_TIERS_TABLE}`).all())
        .toEqual([{ tier_id: 'tier_stripe', lifecycle_source: 'stripe' }]);
      expect(db.prepare(`SELECT customer_id, lifecycle_source FROM ${SELLER_CUSTOMERS_TABLE}`).all())
        .toEqual([{ customer_id: 'cust_stripe', lifecycle_source: 'stripe' }]);
      // And the new members are admitted where they were refused a moment ago.
      insertTier(db, 'paddle', 'tier_paddle');
      insertTier(db, 'lemonsqueezy', 'tier_ls');
      insertCustomer(db, 'paddle', 'cust_paddle');
      insertCustomer(db, 'lemonsqueezy', 'cust_ls');
      expect(db.prepare(`SELECT count(*) AS n FROM ${SELLER_TIERS_TABLE}`).get()).toEqual({ n: 3 });
      expect(db.prepare(`SELECT count(*) AS n FROM ${SELLER_CUSTOMERS_TABLE}`).get()).toEqual({ n: 3 });
      // The rebuild recreated the indexes in the same boot, not the next one.
      expect(indexNames(db, SELLER_TIERS_TABLE)).toEqual(expect.arrayContaining([
        'idx_seller_tiers_source', 'idx_seller_tiers_template_contract',
      ]));
      expect(indexNames(db, SELLER_CUSTOMERS_TABLE)).toEqual(expect.arrayContaining([
        'idx_seller_customers_email', 'idx_seller_customers_contract', 'idx_seller_customers_tier',
      ]));
      // Idempotent: a second boot finds nothing to converge and changes no DDL.
      const before = [tableSql(db, SELLER_TIERS_TABLE), tableSql(db, SELLER_CUSTOMERS_TABLE)];
      ensureSellerSchema(db);
      expect([tableSql(db, SELLER_TIERS_TABLE), tableSql(db, SELLER_CUSTOMERS_TABLE)]).toEqual(before);
      expect(db.prepare(`SELECT count(*) AS n FROM ${SELLER_TIERS_TABLE}`).get()).toEqual({ n: 3 });
    } finally {
      db.close();
    }
  });

  it('narrows a CHECK that still admits the retired placeholder, and refuses while a row carries it', () => {
    const db = new Database(':memory:');
    try {
      db.exec(legacyDdl());
      insertTier(db, 'stripe', 'tier_stripe');
      expect(tableSql(db, SELLER_TIERS_TABLE)).toContain("'future_provider'");

      ensureSellerSchema(db);
      // Widened for the new members AND narrowed: the retired word is gone from the CHECK.
      expect(tableSql(db, SELLER_TIERS_TABLE)).not.toContain("'future_provider'");
      expect(tableSql(db, SELLER_CUSTOMERS_TABLE)).not.toContain("'future_provider'");
      expect(() => insertTier(db, 'future_provider', 'tier_placeholder')).toThrow(/CHECK constraint failed/);
      expect(db.prepare(`SELECT count(*) AS n FROM ${SELLER_TIERS_TABLE}`).get()).toEqual({ n: 1 });
    } finally {
      db.close();
    }

    const held = new Database(':memory:');
    try {
      held.exec(legacyDdl());
      insertTier(held, 'future_provider', 'tier_placeholder');
      // A row under the retired source: the boot must not silently drop or
      // re-label it — it refuses with the count and the word, table intact.
      expect(() => ensureSellerSchema(held))
        .toThrow(/converge refused: seller_tiers still holds 1 row\(s\) under retired lifecycle_source 'future_provider'/);
      expect(tableSql(held, SELLER_TIERS_TABLE)).toContain("'future_provider'");
      expect(held.prepare(`SELECT count(*) AS n FROM ${SELLER_TIERS_TABLE}`).get()).toEqual({ n: 1 });
    } finally {
      held.close();
    }
  });

  it('refuses, intact, a live table that carries a column the current DDL does not', () => {
    const db = new Database(':memory:');
    try {
      db.exec(legacyDdl(',\n    legacy_note TEXT'));
      insertTier(db, 'stripe', 'tier_stripe');
      expect(() => ensureSellerSchema(db)).toThrow(/converge refused: seller_tiers carries column\(s\).*legacy_note/);
      // Nothing was rebuilt: the old CHECK, the extra column, and the row all remain.
      const sql = tableSql(db, SELLER_TIERS_TABLE);
      expect(sql).toContain('legacy_note');
      expect(sql).not.toContain("'paddle'");
      expect(db.prepare(`SELECT count(*) AS n FROM ${SELLER_TIERS_TABLE}`).get()).toEqual({ n: 1 });
      expect(
        db.prepare(`SELECT name FROM sqlite_master WHERE name = ?`).get(`${SELLER_TIERS_TABLE}__converge`),
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
