/** D-196 Seller Economy — local seller tables.
 *
 *  The contract substrate remains the single source for template/customer
 *  `contract_definition` rows. This store owns the adjacent seller metadata:
 *  settings, source-qualified tiers, source-qualified customers, and compact
 *  usage rollups. Rows are local-only and dormant until a seller flow writes
 *  them.
 */

import type Database from 'better-sqlite3';
import {
  LLM_GATEWAY_PAID_ACK_VERSION,
  SELLER_ACCESS_STATES,
  SELLER_LIFECYCLE_SOURCES,
  SELLER_RETIRED_LIFECYCLE_SOURCES,
  SELLER_OFFER_KINDS,
  SELLER_OFFER_ID_MAX_LENGTH,
  SELLER_OFFER_PRICING_KINDS,
  sellerOfferPricingRequiresAmount,
  SELLER_OFFER_STATES,
  SELLER_ORDER_ORIGIN_KINDS,
  SELLER_ORDER_PHASES,
  SELLER_USAGE_KINDS,
  SELLER_USAGE_PERIOD_GRANULARITIES,
  WORK_ENTITY_KINDS,
  isSellerAccessState,
  isSellerLifecycleSource,
  isSellerOfferId,
  isSellerOfferKind,
  isSellerOfferPricingKind,
  isSellerOfferState,
  isSellerOfferStateTransitionAllowed,
  isReceptionLinkButtonUrl,
  isSellerUsageKind,
  isSellerUsagePeriodGranularity,
  type SellerAccessState,
  type SellerCustomer,
  type SellerCustomerUsageRollup,
  type SellerLifecycleSource,
  type SellerOffer,
  type SellerOfferEnsureResult,
  type SellerOfferFulfillmentAttachResult,
  type SellerOfferKind,
  type SellerOfferPricingKind,
  type SellerOfferState,
  type SellerOfferStateTransitionRequest,
  type SellerOfferStateTransitionResult,
  type SellerSettings,
  type SellerTier,
  type SellerUsageKind,
  type SellerUsagePeriodGranularity,
  type TokenUsageReport,
} from '@recued/contracts';

export const SELLER_SETTINGS_TABLE = 'seller_settings';
export const SELLER_OFFERS_TABLE = 'seller_offers';
export const SELLER_ORDERS_TABLE = 'seller_orders';
export const SELLER_TIERS_TABLE = 'seller_tiers';
export const SELLER_CUSTOMERS_TABLE = 'seller_customers';
export const SELLER_CUSTOMER_USAGE_ROLLUPS_TABLE = 'seller_customer_usage_rollups';

const SETTINGS_ID = 'default';
const DEFAULT_GRACE_HOURS = 72;

const sqlEnum = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(', ');

/** The `seller_offers` amount/currency CHECK, DERIVED from
 *  `SELLER_OFFER_PRICING_REQUIRES_AMOUNT` (via `sellerOfferPricingRequiresAmount`)
 *  so it can never fall out of step with `ensureOffer`'s runtime validation
 *  (D-207 §4.4a). A PRICED pricing_kind (`fixed`/`recurring`) must carry a
 *  positive `amount_minor` and a `currency`; an UNPRICED one (`unspecified`/`free`)
 *  must carry neither.
 *
 *  ⛔ Emitted as ONE deterministic line so `convergeSellerOffersSchema` can detect
 *  a materialized table that predates a change to this rule with a plain substring
 *  test. This clause is NOT enum membership, so the membership check that catches a
 *  widened `pricing_kind IN (...)` would miss a change here — the SQL twin of the
 *  CHECK-is-real-exactly-once trap that made slice 1c inert in production. */
const sellerOfferPricingCheckClause = (): string => {
  const priced = SELLER_OFFER_PRICING_KINDS.filter(sellerOfferPricingRequiresAmount);
  const unpriced = SELLER_OFFER_PRICING_KINDS.filter(
    (kind) => !sellerOfferPricingRequiresAmount(kind),
  );
  return (
    `CHECK ( (pricing_kind IN (${sqlEnum(priced)}) `
    + `AND amount_minor IS NOT NULL AND amount_minor > 0 AND currency IS NOT NULL) `
    + `OR (pricing_kind IN (${sqlEnum(unpriced)}) `
    + `AND amount_minor IS NULL AND currency IS NULL) )`
  );
};

/** The one emitter for the `seller_offers` shape. The CREATE below and the
 *  drift-convergence rebuild (`convergeSellerOffersSchema`) both go through it,
 *  so the two can never describe different tables. */
const sellerOffersCreateDdl = (table: string): string => `
    CREATE TABLE IF NOT EXISTS ${table} (
      offer_id                 TEXT PRIMARY KEY,
      kind                     TEXT NOT NULL CHECK (kind IN (${sqlEnum(SELLER_OFFER_KINDS)})),
      display_name             TEXT NOT NULL,
      description              TEXT NOT NULL,
      pricing_kind             TEXT NOT NULL CHECK (pricing_kind IN (${sqlEnum(SELLER_OFFER_PRICING_KINDS)})),
      amount_minor             INTEGER,
      currency                 TEXT,
      fulfillment_recipe_id    TEXT,
      checkout_url             TEXT,
      -- D-196 1d: non-secret generic fulfillment config (JSON map of pointers).
      fulfillment_config       TEXT,
      state                    TEXT NOT NULL CHECK (state IN (${sqlEnum(SELLER_OFFER_STATES)})),
      created_by_recipe_id     TEXT,
      created_at               INTEGER NOT NULL,
      updated_at               INTEGER NOT NULL,
      ${sellerOfferPricingCheckClause()}
    )`;

/** Value migrations for offer `kind` members the vocabulary has RETIRED, keyed
 *  old-value -> current successor. The converge copy rewrites these in flight so
 *  a stored row that predates a retirement lands under the new CHECK instead of
 *  being refused by it.
 *
 *  D-207 §4.1 retired the single pre-D-207 kind `one_time_outcome` in favour of
 *  the general `document` (`kind` became display metadata; the engine reads only
 *  `pricing_kind` + `fulfillment_recipe_id`). Every legacy offer row therefore
 *  carries `one_time_outcome` and must become `document`. */
const RETIRED_OFFER_KIND_SUCCESSORS: Readonly<Record<string, SellerOfferKind>> = {
  one_time_outcome: 'document',
};

/** ⛔ A generated CHECK is a DRIFT TRAP, and this is the SQL twin of the
 *  `door_types` value_shape bug that made D-207 slice 1c inert in production.
 *
 *  The CHECK clauses above are DERIVED from the TypeScript consts — which is
 *  right — but `CREATE TABLE IF NOT EXISTS` SKIPS an existing table, and SQLite
 *  cannot ALTER a CHECK. So the derivation is real exactly once, at creation, and
 *  frozen forever after. Widening `SELLER_OFFER_KINDS` on a live server would
 *  therefore change nothing: every new kind would be rejected by a CHECK compiled
 *  from the old const, while a fresh-DB test suite stayed green.
 *
 *  ⇒ Converge the MATERIALIZED table onto the generated DDL. Widening is the easy
 *  case: every stored row already satisfies the new (looser) CHECK, so the copy is
 *  verbatim. A REMOVAL is a value migration — a stored row can hold a member the
 *  new CHECK no longer admits — and is absorbed ONLY for members with a declared
 *  successor in `RETIRED_OFFER_KIND_SUCCESSORS`, which the copy's SELECT rewrites
 *  in flight. A member removed WITHOUT a remap entry still produces the correct
 *  failure (the copy refuses it) rather than silently dropping or mangling data. */
const convergeSellerOffersSchema = (db: Database.Database): void => {
  const existing = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(SELLER_OFFERS_TABLE) as { sql: string } | undefined;
  // Absent: the CREATE just emitted it from the current consts. Nothing to do.
  if (existing === undefined) return;

  const declared = [...SELLER_OFFER_KINDS, ...SELLER_OFFER_PRICING_KINDS, ...SELLER_OFFER_STATES];
  const admitsEveryDeclaredMember = declared.every((member) =>
    existing.sql.includes(`'${member}'`),
  );
  // The amount/currency CHECK is a hand-shaped rule, not an enum, so widening it
  // (e.g. adding the `free`/`recurring` branches) leaves every enum member already
  // present and would slip past the membership test above. Detect it directly: the
  // materialized table must contain the exact clause the current DDL emits.
  const admitsCurrentPricingRule = existing.sql.includes(sellerOfferPricingCheckClause());
  if (admitsEveryDeclaredMember && admitsCurrentPricingRule) return;

  const rebuildTable = `${SELLER_OFFERS_TABLE}__converge`;
  const columnNames = (table: string): readonly string[] =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (column) => column.name,
    );

  // A `CASE kind WHEN 'retired' THEN 'successor' ... ELSE kind END` read expression
  // that rewrites retired kinds to their successor and passes every other value
  // through. Empty map => plain `kind`.
  const kindRemapWhens = Object.entries(RETIRED_OFFER_KIND_SUCCESSORS)
    .map(([from, to]) => `WHEN '${from}' THEN '${to}'`)
    .join(' ');

  db.transaction(() => {
    db.exec(`DROP TABLE IF EXISTS ${rebuildTable}`);
    db.exec(sellerOffersCreateDdl(rebuildTable));
    // Copy only the columns BOTH shapes have, derived from the live tables rather
    // than a hand-written list that would rot the moment a column is added.
    const carried = columnNames(rebuildTable).filter((column) =>
      columnNames(SELLER_OFFERS_TABLE).includes(column),
    );
    const insertColumns = carried.join(', ');
    // INSERT keeps the plain column list; only the READ is rewritten. SQLite maps
    // INSERT ... SELECT by POSITION, and both projections come from the same
    // `carried` array, so the remapped `kind` expression stays column-aligned.
    const readProjection = carried
      .map((column) =>
        column === 'kind' && kindRemapWhens.length > 0
          ? `CASE kind ${kindRemapWhens} ELSE kind END AS kind`
          : column,
      )
      .join(', ');
    db.exec(
      `INSERT INTO ${rebuildTable} (${insertColumns}) SELECT ${readProjection} FROM ${SELLER_OFFERS_TABLE}`,
    );
    db.exec(`DROP TABLE ${SELLER_OFFERS_TABLE}`);
    db.exec(`ALTER TABLE ${rebuildTable} RENAME TO ${SELLER_OFFERS_TABLE}`);
  })();
};

/** The one emitter for the `seller_orders` shape. The CREATE in
 *  `ensureSellerSchema` and the drift-convergence rebuild
 *  (`convergeSellerOrdersSchema`) both go through it, so the two can never
 *  describe different tables. Mirrors `sellerOffersCreateDdl`. */
const sellerOrdersCreateDdl = (table: string): string => `
    CREATE TABLE IF NOT EXISTS ${table} (
      -- D-207 §4.2. F7: TWO identifiers. The key is deterministic (idempotency,
      -- provider correlation) and therefore GUESSABLE, so it never leaves the
      -- server; the handle is a CSPRNG token and is the only id a visitor sees.
      order_key                TEXT PRIMARY KEY,
      order_handle             TEXT NOT NULL UNIQUE,
      offer_id                 TEXT NOT NULL,
      origin_kind              TEXT NOT NULL CHECK (origin_kind IN (${sqlEnum(SELLER_ORDER_ORIGIN_KINDS)})),
      origin_ref               TEXT NOT NULL,
      phase                    TEXT NOT NULL CHECK (phase IN (${sqlEnum(SELLER_ORDER_PHASES)})),
      -- Snapshotted from the offer at open, so a later offer edit cannot change
      -- what a customer already agreed to pay.
      pricing_kind             TEXT NOT NULL CHECK (pricing_kind IN (${sqlEnum(SELLER_OFFER_PRICING_KINDS)})),
      -- SERVER-COMPUTED from the owner-authored offer. No op accepts an amount
      -- from a caller, so no visitor value can ever reach this column.
      amount_minor             INTEGER,
      currency                 TEXT,
      fulfillment_recipe_id    TEXT,
      customer_id              TEXT,
      -- D-196 §4.5. The tier this order SELLS, snapshotted at open from the
      -- OPENING recipe's dish and immutable after. The entitlement KEY, not a
      -- tier row id: the key survives a tier re-sync; row ids do not. NULL for
      -- orders that sell no standing access.
      entitlement_key          TEXT,
      -- D-196 1d: the offer's non-secret fulfillment_config, snapshotted at open
      -- (JSON string, verbatim copy of the offer's) and immutable after.
      fulfillment_config       TEXT,
      provider                 TEXT,
      provider_session_id      TEXT,
      provider_payment_id      TEXT,
      checkout_url             TEXT,
      artifact_ref             TEXT,
      artifact_hash            TEXT,
      linked_work_entity_kind  TEXT CHECK (linked_work_entity_kind IS NULL OR linked_work_entity_kind IN (${sqlEnum(WORK_ENTITY_KINDS)})),
      linked_work_entity_id    TEXT,
      error_code               TEXT,
      revision                 INTEGER NOT NULL,
      created_at               INTEGER NOT NULL,
      updated_at               INTEGER NOT NULL,
      paid_at                  INTEGER,
      expires_at               INTEGER,
      CHECK (length(order_key) > 0),
      CHECK (length(order_handle) > 0),
      CHECK (revision >= 0),
      -- Either both link columns are set or neither is. A half-link is a
      -- provenance field that lies.
      CHECK (
        (linked_work_entity_kind IS NULL AND linked_work_entity_id IS NULL)
        OR
        (linked_work_entity_kind IS NOT NULL AND linked_work_entity_id IS NOT NULL)
      )
    )`;

/** ⛔ The orders `pricing_kind` / `phase` / `origin_kind` / `linked_work_entity_kind`
 *  CHECKs are DERIVED from TypeScript consts, and — exactly like the offers table —
 *  a generated CHECK is real only at creation (`CREATE TABLE IF NOT EXISTS` skips an
 *  existing table; SQLite cannot ALTER a CHECK). An orders table created before
 *  `SELLER_OFFER_PRICING_KINDS` gained `free`/`recurring` would therefore still
 *  reject a `free`/`recurring` order — whose `pricing_kind` is snapshotted from the
 *  offer at open — while a fresh-DB suite stayed green. Converge it.
 *
 *  Unlike the offers converger this needs NO value remap: the order vocabularies
 *  only ever WIDENED (nothing retired), so every stored row already satisfies the
 *  looser CHECK and the copy is verbatim. A future REMOVAL without a remap still
 *  fails the copy (correct) rather than mangling a row.
 *
 *  ⚠ A converge boot rebuilds the table without its indexes; the
 *  `CREATE INDEX IF NOT EXISTS` statements in `ensureSellerSchema` recreate them on
 *  the next boot (the offers converger behaves identically). */
const convergeSellerOrdersSchema = (db: Database.Database): void => {
  const existing = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(SELLER_ORDERS_TABLE) as { sql: string } | undefined;
  // Absent: the CREATE just emitted it from the current consts. Nothing to do.
  if (existing === undefined) return;

  const declared = [
    ...SELLER_ORDER_ORIGIN_KINDS,
    ...SELLER_ORDER_PHASES,
    ...SELLER_OFFER_PRICING_KINDS,
    ...WORK_ENTITY_KINDS,
  ];
  if (declared.every((member) => existing.sql.includes(`'${member}'`))) return;

  const rebuildTable = `${SELLER_ORDERS_TABLE}__converge`;
  const columnNames = (table: string): readonly string[] =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (column) => column.name,
    );

  db.transaction(() => {
    db.exec(`DROP TABLE IF EXISTS ${rebuildTable}`);
    db.exec(sellerOrdersCreateDdl(rebuildTable));
    // Copy only the columns BOTH shapes have (verbatim — no value remap needed).
    const carried = columnNames(rebuildTable).filter((column) =>
      columnNames(SELLER_ORDERS_TABLE).includes(column),
    );
    const columnList = carried.join(', ');
    db.exec(
      `INSERT INTO ${rebuildTable} (${columnList}) SELECT ${columnList} FROM ${SELLER_ORDERS_TABLE}`,
    );
    db.exec(`DROP TABLE ${SELLER_ORDERS_TABLE}`);
    db.exec(`ALTER TABLE ${rebuildTable} RENAME TO ${SELLER_ORDERS_TABLE}`);
  })();
};

/** The one emitter for the `seller_tiers` shape — the CREATE in
 *  `ensureSellerSchema` and the drift-convergence rebuild both go through it,
 *  so the two can never describe different tables. Mirrors `sellerOrdersCreateDdl`. */
const sellerTiersCreateDdl = (table: string): string => `
    CREATE TABLE IF NOT EXISTS ${table} (
      tier_id                         TEXT PRIMARY KEY,
      door_id                         TEXT NOT NULL,
      lifecycle_source                TEXT NOT NULL CHECK (lifecycle_source IN (${sqlEnum(SELLER_LIFECYCLE_SOURCES)})),
      entitlement_key                 TEXT NOT NULL,
      display_name                    TEXT NOT NULL,
      template_contract_id            TEXT NOT NULL,
      external_entitlement_id         TEXT,
      usage_policy_json               TEXT NOT NULL,
      pass_duration_seconds           INTEGER,
      customer_status_enabled_default INTEGER NOT NULL DEFAULT 0,
      active                          INTEGER NOT NULL DEFAULT 1,
      created_at                      INTEGER NOT NULL,
      updated_at                      INTEGER NOT NULL,
      UNIQUE (door_id, lifecycle_source, entitlement_key)
    )`;

const sellerTiersIndexDdl = (): string => `
    CREATE INDEX IF NOT EXISTS idx_seller_tiers_source
      ON ${SELLER_TIERS_TABLE} (lifecycle_source, entitlement_key);
    CREATE INDEX IF NOT EXISTS idx_seller_tiers_template_contract
      ON ${SELLER_TIERS_TABLE} (template_contract_id);`;

/** The one emitter for the `seller_customers` shape. See `sellerTiersCreateDdl`. */
const sellerCustomersCreateDdl = (table: string): string => `
    CREATE TABLE IF NOT EXISTS ${table} (
      customer_id              TEXT PRIMARY KEY,
      lifecycle_source         TEXT NOT NULL CHECK (lifecycle_source IN (${sqlEnum(SELLER_LIFECYCLE_SOURCES)})),
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
      access_state             TEXT NOT NULL CHECK (access_state IN (${sqlEnum(SELLER_ACCESS_STATES)})),
      claim_email_sent_at      INTEGER,
      claim_email_marker       TEXT,
      status_email_sent_at     INTEGER,
      status_email_marker      TEXT,
      created_at               INTEGER NOT NULL,
      updated_at               INTEGER NOT NULL,
      UNIQUE (lifecycle_source, source_customer_id, door_id)
    )`;

const sellerCustomersIndexDdl = (): string => `
    CREATE INDEX IF NOT EXISTS idx_seller_customers_email
      ON ${SELLER_CUSTOMERS_TABLE} (email);
    CREATE INDEX IF NOT EXISTS idx_seller_customers_contract
      ON ${SELLER_CUSTOMERS_TABLE} (contract_id);
    CREATE INDEX IF NOT EXISTS idx_seller_customers_tier
      ON ${SELLER_CUSTOMERS_TABLE} (tier_id);`;

/** ⛔ THE LIFECYCLE-SOURCE CHECK IS A DRIFT TRAP, exactly like the offers /
 *  orders ones above: `CHECK (lifecycle_source IN (…))` is compiled from
 *  `SELLER_LIFECYCLE_SOURCES` at CREATE and frozen in every existing database.
 *  Adding `paddle` / `lemonsqueezy` to the const would otherwise change nothing
 *  on a live server — every Paddle tier or customer row rejected by a CHECK that
 *  only knows `manual` / `stripe` / the old placeholder, while a fresh-DB
 *  suite stayed green. That is the INERT-vocabulary trap: the member exists in
 *  code and is refused by the one store that matters.
 *
 *  Widens for new members and narrows for `SELLER_RETIRED_LIFECYCLE_SOURCES`
 *  (refusing while a row still carries one), so the copy is verbatim. Two
 *  guards the
 *  older convergers do not carry: the live table must not hold a column the
 *  emitter lacks (a rebuild would silently DROP that column's data — refuse
 *  and let a human look), and the indexes are recreated in the same
 *  transaction rather than on the next boot. */
const convergeLifecycleSourceTable = (
  db: Database.Database,
  table: string,
  createDdl: (name: string) => string,
  indexDdl: () => string,
): void => {
  const existing = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { sql: string } | undefined;
  // Absent: the CREATE just emitted it from the current consts. Nothing to do.
  if (existing === undefined) return;
  const declared = [...SELLER_LIFECYCLE_SOURCES, ...SELLER_ACCESS_STATES];
  const missing = declared.some((member) => !existing.sql.includes(`'${member}'`));
  // A CHECK compiled under an older list may still ADMIT a member the
  // vocabulary has since retired; narrow it too, so the store refuses what the
  // code no longer names. ⛔ Only after proving no live row still carries it —
  // the copy below would fail the new CHECK, and the message should say why.
  const retired = SELLER_RETIRED_LIFECYCLE_SOURCES.filter((member) =>
    existing.sql.includes(`'${member}'`));
  if (!missing && retired.length === 0) return;
  for (const member of retired) {
    const held = db
      .prepare(`SELECT count(*) AS n FROM ${table} WHERE lifecycle_source = ?`)
      .get(member) as { n: number };
    if (held.n > 0) {
      throw new Error(
        `seller schema converge refused: ${table} still holds ${held.n} row(s) under `
          + `retired lifecycle_source '${member}' — migrate or delete them before this boot`,
      );
    }
  }

  const rebuildTable = `${table}__converge`;
  const columnNames = (name: string): readonly string[] =>
    (db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]).map(
      (column) => column.name,
    );
  db.transaction(() => {
    db.exec(`DROP TABLE IF EXISTS ${rebuildTable}`);
    db.exec(createDdl(rebuildTable));
    const liveColumns = columnNames(table);
    const targetColumns = columnNames(rebuildTable);
    const orphaned = liveColumns.filter((column) => !targetColumns.includes(column));
    if (orphaned.length > 0) {
      db.exec(`DROP TABLE ${rebuildTable}`);
      throw new Error(
        `seller schema converge refused: ${table} carries column(s) the current DDL `
          + `does not — ${orphaned.join(', ')} — and a rebuild would drop their data`,
      );
    }
    const carried = targetColumns.filter((column) => liveColumns.includes(column));
    const columnList = carried.join(', ');
    db.exec(`INSERT INTO ${rebuildTable} (${columnList}) SELECT ${columnList} FROM ${table}`);
    db.exec(`DROP TABLE ${table}`);
    db.exec(`ALTER TABLE ${rebuildTable} RENAME TO ${table}`);
    db.exec(indexDdl());
  })();
};

export const ensureSellerSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${SELLER_SETTINGS_TABLE} (
      settings_id                  TEXT PRIMARY KEY CHECK (settings_id = '${SETTINGS_ID}'),
      default_grace_hours          INTEGER NOT NULL,
      sender_mail_instance_id      TEXT,
      status_policy_json           TEXT NOT NULL,
      email_policy_json            TEXT NOT NULL,
      -- D-196 §4.9 / I-7: the one-time paid-llm_gateway route-rights
      -- acknowledgment. Nullable — a fresh server has never monetized a gateway.
      llm_gateway_paid_ack_at      INTEGER,
      llm_gateway_paid_ack_version TEXT,
      created_at                   INTEGER NOT NULL,
      updated_at                   INTEGER NOT NULL
    );

    ${sellerOffersCreateDdl(SELLER_OFFERS_TABLE)};
    CREATE INDEX IF NOT EXISTS idx_seller_offers_state
      ON ${SELLER_OFFERS_TABLE} (state, updated_at DESC);

    ${sellerOrdersCreateDdl(SELLER_ORDERS_TABLE)};
    CREATE INDEX IF NOT EXISTS idx_seller_orders_offer
      ON ${SELLER_ORDERS_TABLE} (offer_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_seller_orders_phase
      ON ${SELLER_ORDERS_TABLE} (phase, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_seller_orders_origin
      ON ${SELLER_ORDERS_TABLE} (origin_kind, origin_ref);

    ${sellerTiersCreateDdl(SELLER_TIERS_TABLE)};
    ${sellerTiersIndexDdl()}

    ${sellerCustomersCreateDdl(SELLER_CUSTOMERS_TABLE)};
    ${sellerCustomersIndexDdl()}

    CREATE TABLE IF NOT EXISTS ${SELLER_CUSTOMER_USAGE_ROLLUPS_TABLE} (
      contract_id        TEXT NOT NULL,
      usage_kind         TEXT NOT NULL CHECK (usage_kind IN (${sqlEnum(SELLER_USAGE_KINDS)})),
      period_granularity TEXT NOT NULL CHECK (period_granularity IN (${sqlEnum(SELLER_USAGE_PERIOD_GRANULARITIES)})),
      period_start       INTEGER NOT NULL,
      units              INTEGER NOT NULL CHECK (units >= 0),
      created_at         INTEGER NOT NULL,
      updated_at         INTEGER NOT NULL,
      PRIMARY KEY (contract_id, usage_kind, period_granularity, period_start)
    );
    CREATE INDEX IF NOT EXISTS idx_seller_usage_contract_period
      ON ${SELLER_CUSTOMER_USAGE_ROLLUPS_TABLE} (contract_id, period_start);
  `);

  // D-250 § D — MEASURED provider tokens beside the METERED units, on the row
  // that already exists for this `(contract_id, usage_kind, period)`.
  //
  // ⛔ WHY COLUMNS AND NOT A NEW `usage_kind`. `usage_kind` carries a SQL CHECK
  // baked into the CREATE TABLE, and `CREATE TABLE IF NOT EXISTS` leaves an
  // existing database on its OLD constraint — so adding a value to
  // `SELLER_USAGE_KINDS` would pass on a fresh install and fail every INSERT on
  // every server already running. This is self-hosted: there is no deploy order
  // anyone controls.
  //
  // ⛔ AND THEY ARE A MEASUREMENT, NOT A METER. `units` is admitted BEFORE a call
  // (reserve → commit); tokens are knowable only AFTER it returns, so they can
  // never gate that call. Recording them as a metered kind would imply a plan
  // could limit them, which this substrate cannot honestly enforce.
  //
  // ⚠ NULLABLE, NO DEFAULT 0 — "never measured" must stay distinguishable from
  // "measured zero", the same rule `AuditEntry.total_usage` follows. Every row
  // written before this shipped reads NULL, and a reader must not sum it as 0.
  const usageColumns = (
    db.prepare(`PRAGMA table_info(${SELLER_CUSTOMER_USAGE_ROLLUPS_TABLE})`).all() as
      { name: string }[]
  ).map((column) => column.name);
  for (const column of [
    'tokens_input', 'tokens_output', 'tokens_total', 'provider_calls',
  ]) {
    if (!usageColumns.includes(column)) {
      db.exec(
        `ALTER TABLE ${SELLER_CUSTOMER_USAGE_ROLLUPS_TABLE} ADD COLUMN ${column} INTEGER`,
      );
    }
  }

  // D-196 §4.9 / I-7 — plain nullable column adds on a `seller_settings` table
  // that predates the paid-gateway acknowledgment. PRAGMA-guarded => idempotent.
  // No CHECK is involved, so the ADD COLUMN precedent below is sufficient here.
  const settingsColumns = (
    db.prepare(`PRAGMA table_info(${SELLER_SETTINGS_TABLE})`).all() as { name: string }[]
  ).map((column) => column.name);
  if (!settingsColumns.includes('llm_gateway_paid_ack_at')) {
    db.exec(`ALTER TABLE ${SELLER_SETTINGS_TABLE} ADD COLUMN llm_gateway_paid_ack_at INTEGER`);
  }
  if (!settingsColumns.includes('llm_gateway_paid_ack_version')) {
    db.exec(`ALTER TABLE ${SELLER_SETTINGS_TABLE} ADD COLUMN llm_gateway_paid_ack_version TEXT`);
  }

  // A plain column add on a table that predates it. PRAGMA-guarded => idempotent,
  // safe on every boot. (This is the codebase precedent; it is NOT sufficient for
  // the CHECK clauses, which SQLite cannot ALTER — see below.)
  const offerColumns = (
    db.prepare(`PRAGMA table_info(${SELLER_OFFERS_TABLE})`).all() as { name: string }[]
  ).map((column) => column.name);
  if (!offerColumns.includes('checkout_url')) {
    db.exec(`ALTER TABLE ${SELLER_OFFERS_TABLE} ADD COLUMN checkout_url TEXT`);
  }
  // D-196 1d — the offer's non-secret generic fulfillment config.
  if (!offerColumns.includes('fulfillment_config')) {
    db.exec(`ALTER TABLE ${SELLER_OFFERS_TABLE} ADD COLUMN fulfillment_config TEXT`);
  }

  // D-196 §4.5 — same plain-column-add pattern for an orders table that predates
  // `entitlement_key`. Runs BEFORE the converge so a rebuild triggered by a CHECK
  // change copies the column instead of silently dropping it.
  const orderColumns = (
    db.prepare(`PRAGMA table_info(${SELLER_ORDERS_TABLE})`).all() as { name: string }[]
  ).map((column) => column.name);
  if (!orderColumns.includes('entitlement_key')) {
    db.exec(`ALTER TABLE ${SELLER_ORDERS_TABLE} ADD COLUMN entitlement_key TEXT`);
  }
  // D-196 1d — the offer's fulfillment_config snapshotted onto the order.
  if (!orderColumns.includes('fulfillment_config')) {
    db.exec(`ALTER TABLE ${SELLER_ORDERS_TABLE} ADD COLUMN fulfillment_config TEXT`);
  }

  convergeSellerOffersSchema(db);
  convergeSellerOrdersSchema(db);
  convergeLifecycleSourceTable(db, SELLER_TIERS_TABLE, sellerTiersCreateDdl, sellerTiersIndexDdl);
  convergeLifecycleSourceTable(
    db,
    SELLER_CUSTOMERS_TABLE,
    sellerCustomersCreateDdl,
    sellerCustomersIndexDdl,
  );
};

export class SellerStoreValidationError extends Error {
  constructor(detail: string) {
    super(`seller_store_invalid: ${detail}`);
    this.name = 'SellerStoreValidationError';
  }
}

export class SellerStoreConflictError extends Error {
  constructor(detail: string) {
    super(`seller_store_conflict: ${detail}`);
    this.name = 'SellerStoreConflictError';
  }
}

export interface SellerSettingsUpsertInput {
  readonly default_grace_hours?: number;
  readonly sender_mail_instance_id?: string | null;
  readonly status_policy_json?: Readonly<Record<string, unknown>>;
  readonly email_policy_json?: Readonly<Record<string, unknown>>;
  readonly now: number;
}

/** Core Seller offer creation is ensure-only in this slice: a recipe can
 * idempotently establish a draft, but cannot silently edit or activate an
 * existing row. State changes remain an owner Seller-surface decision. */
export interface SellerOfferEnsureInput {
  readonly offer_id: string;
  readonly kind: SellerOfferKind;
  readonly display_name: string;
  readonly description?: string;
  readonly pricing_kind: SellerOfferPricingKind;
  readonly amount_minor?: number | null;
  readonly currency?: string | null;
  readonly fulfillment_recipe_id?: string | null;
  /** D-207 ruling (C) — the owner-created, provider-hosted checkout URL that lets
   *  a public form sell with zero anonymous writes. Fenced by
   *  `isReceptionLinkButtonUrl`, which is the SAME predicate the renderer uses to
   *  decide whether to emit an href: the store can therefore never accept a
   *  target the public page would refuse to render, and vice versa. */
  readonly checkout_url?: string | null;
  /** D-196 1d — non-secret generic fulfillment config (pointers the fulfillment
   *  recipe reads). Undefined/null => stored as SQL NULL. Recipe-settable via the
   *  `seller-offer-ensure` allow-list; a secret stays owner-only by living in the
   *  vault and being referenced, never stored here in the clear. */
  readonly fulfillment_config?: Readonly<Record<string, unknown>> | null;
  readonly created_by_recipe_id?: string | null;
  readonly now: number;
}

export interface SellerOfferFulfillmentAttachInput {
  readonly offer_id: string;
  /** Engine-stamped recipe provenance. This is both the required creator and
   * the only permitted fulfillment target. */
  readonly recipe_id: string;
  readonly now: number;
}

export interface SellerOfferListQuery {
  readonly kind?: SellerOfferKind;
  readonly state?: SellerOfferState;
}

export interface SellerOfferStateTransitionInput
  extends SellerOfferStateTransitionRequest {
  readonly now: number;
}

export interface SellerTierUpsertInput {
  readonly tier_id: string;
  readonly door_id: string;
  readonly lifecycle_source: SellerLifecycleSource;
  readonly entitlement_key: string;
  /** Required on create; undefined preserves the existing value on update. */
  readonly display_name?: string;
  /** Required on create; undefined preserves the existing value on update. */
  readonly template_contract_id?: string;
  readonly external_entitlement_id?: string | null;
  readonly usage_policy_json?: Readonly<Record<string, unknown>>;
  readonly pass_duration_seconds?: number | null;
  readonly customer_status_enabled_default?: boolean;
  readonly active?: boolean;
  readonly now: number;
}

export interface SellerCustomerUpsertInput {
  readonly customer_id: string;
  readonly lifecycle_source: SellerLifecycleSource;
  readonly source_customer_id: string;
  readonly door_id: string;
  /** undefined preserves an existing email on update; null explicitly clears. */
  readonly email?: string | null;
  readonly tier_id: string;
  readonly contract_id: string;
  readonly inbound_token_id?: string | null;
  readonly mcp_token_id?: string | null;
  readonly external_subscription_id?: string | null;
  readonly source_status?: string | null;
  readonly current_period_end?: number | null;
  readonly grace_until?: number | null;
  readonly access_state: SellerAccessState;
  readonly claim_email_sent_at?: number | null;
  readonly claim_email_marker?: string | null;
  readonly status_email_sent_at?: number | null;
  readonly status_email_marker?: string | null;
  readonly now: number;
}

export interface SellerUsageRecordInput {
  readonly contract_id: string;
  readonly usage_kind: SellerUsageKind;
  readonly period_granularity: SellerUsagePeriodGranularity;
  readonly period_start: number;
  readonly units: number;
  readonly now: number;
}

/** D-250 § D — one measured provider result against a customer's contract. */
export interface SellerTokenUsageRecordInput {
  readonly contract_id: string;
  readonly usage_kind: SellerUsageKind;
  readonly period_granularity: SellerUsagePeriodGranularity;
  readonly period_start: number;
  readonly usage: TokenUsageReport;
  readonly now: number;
}

export interface SellerCustomerListQuery {
  readonly lifecycle_source?: SellerLifecycleSource;
  readonly tier_id?: string;
  readonly contract_id?: string;
  readonly email?: string;
  readonly access_state?: SellerAccessState;
}

export interface SellerClaimEmailDeliveryReservationInput {
  readonly customer_id: string;
  /** Opaque, non-secret identity for the exact claim being delivered. */
  readonly marker: string;
  readonly now: number;
}

export interface SellerClaimEmailDeliverySentInput
  extends SellerClaimEmailDeliveryReservationInput {
  readonly sent_at: number;
}

export interface SellerStore {
  getSettings(): SellerSettings;
  upsertSettings(input: SellerSettingsUpsertInput): SellerSettings;
  /** D-196 §4.9 / I-7 — stamp the one-time paid-`llm_gateway` route-rights
   *  acknowledgment (`llm_gateway_paid_ack_at = now`,
   *  `llm_gateway_paid_ack_version = LLM_GATEWAY_PAID_ACK_VERSION`), preserving
   *  every other settings field. A dedicated writer, deliberately separate from
   *  `upsertSettings`: a routine grace/sender/policy edit must never toggle the
   *  acknowledgment, and re-acknowledging simply refreshes the stamp
   *  (idempotent, append-only in spirit). */
  acknowledgeLlmGatewayPaid(input: { readonly now: number }): SellerSettings;
  ensureOffer(input: SellerOfferEnsureInput): SellerOfferEnsureResult;
  attachOfferFulfillmentRecipe(
    input: SellerOfferFulfillmentAttachInput,
  ): SellerOfferFulfillmentAttachResult;
  transitionOfferState(
    input: SellerOfferStateTransitionInput,
  ): SellerOfferStateTransitionResult;
  getOffer(offer_id: string): SellerOffer | null;
  listOffers(query?: SellerOfferListQuery): SellerOffer[];
  upsertTier(input: SellerTierUpsertInput): SellerTier;
  getTier(tier_id: string): SellerTier | null;
  findTier(input: {
    door_id: string;
    lifecycle_source: SellerLifecycleSource;
    entitlement_key: string;
  }): SellerTier | null;
  listTiers(query?: {
    door_id?: string;
    lifecycle_source?: SellerLifecycleSource;
    active?: boolean;
  }): SellerTier[];
  upsertCustomer(input: SellerCustomerUpsertInput): SellerCustomer;
  getCustomer(customer_id: string): SellerCustomer | null;
  findCustomerBySource(input: {
    lifecycle_source: SellerLifecycleSource;
    source_customer_id: string;
    door_id: string;
  }): SellerCustomer | null;
  listCustomers(query?: SellerCustomerListQuery): SellerCustomer[];
  /** D-196 §6.3 — the customers whose access is driven by a live provider
   *  subscription: subscription-backed, still open, on ONE lifecycle source.
   *
   *  Three filters, each load-bearing, which is why this is its own read rather
   *  than a `listCustomers` query (which can express none of them: it has no
   *  subscription predicate, and its `access_state` filter is exact-match, so
   *  it cannot say "not closed"):
   *
   *  - `external_subscription_id IS NOT NULL` — a customer without one is not
   *    subscription-backed. It is a one-time pass, where expiry does the work
   *    (§6.2); there is no provider subscription to converge it against.
   *  - `access_state != 'closed'` — a closed customer has nothing left to
   *    converge, and every lifecycle call REFUSES one (`requireOpenCustomer`
   *    throws on extend/swap; close is a redundant re-close). Sweeping them
   *    would burn a provider read per cycle to produce a throw.
   *  - `lifecycle_source = ?` — ⛔ the caller reads provider truth from ONE
   *    provider's API. A subscription id is only meaningful to the account that
   *    issued it, so handing another provider's (or a hand-set `manual`) row's id
   *    to the Stripe reader is at best a 404 and at worst convergence against
   *    the wrong account's subscription. The source is a required arg, never a
   *    default, so a new provider cannot be swept by an existing one's reader
   *    just by appearing in the table. */
  listOpenSubscriptionCustomers(query: {
    lifecycle_source: SellerLifecycleSource;
  }): SellerCustomer[];
  /** Atomically reserve the customer's empty claim-mail slot. A present marker
   *  with a null sent timestamp is a durable in-flight/attempted state. */
  reserveClaimEmailDelivery(input: SellerClaimEmailDeliveryReservationInput): boolean;
  /** Complete only the matching reservation. This narrow CAS avoids replacing
   *  customer lifecycle fields with a stale snapshot after network I/O. */
  markClaimEmailDeliverySent(input: SellerClaimEmailDeliverySentInput): boolean;
  /** D-250 § D — set ONLY a tier's usage policy, whatever its lifecycle source.
   *
   *  ⛔ WHY A NARROW METHOD AND NOT `upsertTier`. `upsertTier` is keyed on
   *  `(door_id, lifecycle_source, entitlement_key)` and THROWS a conflict when a
   *  stored tier's source differs from the request's — which is correct, and is
   *  exactly why a Stripe-minted tier could not have a limit set on it through
   *  any existing path: `upsertSellerManualTier` hard-codes
   *  `lifecycle_source: 'manual'`, so it conflicts on every synced tier. A
   *  narrow setter reaches those tiers without giving the seller a way to edit
   *  the identity fields the sync owns. */
  setTierUsagePolicy(input: {
    readonly tier_id: string;
    readonly usage_policy_json: Readonly<Record<string, unknown>>;
    readonly now: number;
  }): SellerTier;
  recordUsage(input: SellerUsageRecordInput): SellerCustomerUsageRollup;
  /** D-250 § D — accumulate MEASURED tokens onto the same rollup row.
   *  ⛔ NEVER moves `units`: a measurement must not change a billing count. */
  recordTokenUsage(input: SellerTokenUsageRecordInput): SellerCustomerUsageRollup;
  getUsageRollup(input: {
    contract_id: string;
    usage_kind: SellerUsageKind;
    period_granularity: SellerUsagePeriodGranularity;
    period_start: number;
  }): SellerCustomerUsageRollup | null;
  listUsageRollups(contract_id: string): SellerCustomerUsageRollup[];
}

interface SettingsRow {
  settings_id: string;
  default_grace_hours: number;
  sender_mail_instance_id: string | null;
  status_policy_json: string;
  email_policy_json: string;
  llm_gateway_paid_ack_at: number | null;
  llm_gateway_paid_ack_version: string | null;
  created_at: number;
  updated_at: number;
}

interface OfferRow {
  offer_id: string;
  kind: string;
  display_name: string;
  description: string;
  pricing_kind: string;
  amount_minor: number | null;
  currency: string | null;
  fulfillment_recipe_id: string | null;
  checkout_url: string | null;
  fulfillment_config: string | null;
  state: string;
  created_by_recipe_id: string | null;
  created_at: number;
  updated_at: number;
}

interface TierRow {
  tier_id: string;
  door_id: string;
  lifecycle_source: string;
  entitlement_key: string;
  display_name: string;
  template_contract_id: string;
  external_entitlement_id: string | null;
  usage_policy_json: string;
  pass_duration_seconds: number | null;
  customer_status_enabled_default: number;
  active: number;
  created_at: number;
  updated_at: number;
}

interface CustomerRow {
  customer_id: string;
  lifecycle_source: string;
  source_customer_id: string;
  door_id: string;
  email: string | null;
  tier_id: string;
  contract_id: string;
  inbound_token_id: string | null;
  mcp_token_id: string | null;
  external_subscription_id: string | null;
  source_status: string | null;
  current_period_end: number | null;
  grace_until: number | null;
  access_state: string;
  claim_email_sent_at: number | null;
  claim_email_marker: string | null;
  status_email_sent_at: number | null;
  status_email_marker: string | null;
  created_at: number;
  updated_at: number;
}

interface UsageRow {
  contract_id: string;
  usage_kind: string;
  period_granularity: string;
  period_start: number;
  units: number;
  // D-250 § D — NULL on every row written before the columns existed, and on
  // any period whose work was never measured. Never coerce to 0 on read.
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_total: number | null;
  provider_calls: number | null;
  created_at: number;
  updated_at: number;
}

const parseJsonObject = (raw: string): Readonly<Record<string, unknown>> => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to empty object. Write paths only persist JSON objects; this
    // is defense in depth for hand-edited or restored rows.
  }
  return {};
};

const jsonObject = (value: Readonly<Record<string, unknown>> | undefined): string =>
  JSON.stringify(value ?? {});

/** D-196 1d — parse a NULLABLE JSON-object column: a null/absent column stays
 *  null (the field was never set), a present string parses to an object. Unlike
 *  `parseJsonObject`, absence is distinct from an empty map. */
export const parseNullableJsonObject = (
  raw: string | null,
): Readonly<Record<string, unknown>> | null =>
  raw === null ? null : parseJsonObject(raw);

/** D-196 1d — validate + serialize the offer's `fulfillment_config` for storage.
 *  Undefined/null => SQL NULL. A present value must be a plain JSON object (not an
 *  array/primitive) and serialize within a small bound — the config is a handful
 *  of pointers, never a payload. An empty object is preserved (an explicit
 *  "config present but empty"), distinct from null. */
const FULFILLMENT_CONFIG_MAX_BYTES = 8192;
const cleanFulfillmentConfig = (
  value: Readonly<Record<string, unknown>> | null | undefined,
): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new SellerStoreValidationError('fulfillment_config must be a JSON object');
  }
  const serialized = JSON.stringify(value);
  if (serialized.length > FULFILLMENT_CONFIG_MAX_BYTES) {
    throw new SellerStoreValidationError(
      `fulfillment_config must serialize to at most ${FULFILLMENT_CONFIG_MAX_BYTES} bytes`,
    );
  }
  return serialized;
};

const cleanString = (value: string, field: string): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new SellerStoreValidationError(`${field} must be a non-empty string`);
  }
  return trimmed;
};

const cleanBoundedString = (
  value: string,
  field: string,
  maxChars: number,
): string => {
  const cleaned = cleanString(value, field);
  if (cleaned.length > maxChars) {
    throw new SellerStoreValidationError(`${field} must be at most ${maxChars} characters`);
  }
  return cleaned;
};

const cleanOfferId = (value: string): string => {
  const cleaned = cleanBoundedString(
    value,
    'offer_id',
    SELLER_OFFER_ID_MAX_LENGTH,
  );
  if (!isSellerOfferId(cleaned)) {
    throw new SellerStoreValidationError(
      'offer_id must use lowercase letters, digits, dot, underscore, or hyphen',
    );
  }
  return cleaned;
};

const cleanOfferDescription = (value: string | undefined): string => {
  const cleaned = value?.trim() ?? '';
  if (cleaned.length > 2_000) {
    throw new SellerStoreValidationError(
      'description must be at most 2000 characters',
    );
  }
  return cleaned;
};

const cleanOfferCurrency = (value: string | null | undefined): string | null => {
  if (value === undefined || value === null) return null;
  const cleaned = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(cleaned)) {
    throw new SellerStoreValidationError(
      'currency must be a 3-letter ISO 4217 code',
    );
  }
  return cleaned;
};

const cleanNullableString = (value: string | null | undefined): string | null => {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
};

const cleanEmail = (value: string | null | undefined): string | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length === 0 ? null : trimmed;
};

const requireWholeNumberOrNull = (
  value: number | null | undefined,
  field: string,
): number | null => {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < 0) {
    throw new SellerStoreValidationError(`${field} must be a non-negative integer`);
  }
  return value;
};

const requireWholeNumber = (value: number, field: string): number => {
  if (!Number.isInteger(value) || value < 0) {
    throw new SellerStoreValidationError(`${field} must be a non-negative integer`);
  }
  return value;
};

const requirePositiveUsageUnits = (value: number): number => {
  if (!Number.isInteger(value) || value <= 0) {
    throw new SellerStoreValidationError('units must be a positive integer');
  }
  return value;
};

const assertLifecycleSource = (value: SellerLifecycleSource): void => {
  if (!isSellerLifecycleSource(value)) {
    throw new SellerStoreValidationError(`unknown lifecycle_source: ${String(value)}`);
  }
};

const assertOfferKind = (value: SellerOfferKind): void => {
  if (!isSellerOfferKind(value)) {
    throw new SellerStoreValidationError(`unknown offer kind: ${String(value)}`);
  }
};

const assertOfferPricingKind = (value: SellerOfferPricingKind): void => {
  if (!isSellerOfferPricingKind(value)) {
    throw new SellerStoreValidationError(`unknown offer pricing_kind: ${String(value)}`);
  }
};

const assertOfferState = (value: SellerOfferState): void => {
  if (!isSellerOfferState(value)) {
    throw new SellerStoreValidationError(`unknown offer state: ${String(value)}`);
  }
};

const assertAccessState = (value: SellerAccessState): void => {
  if (!isSellerAccessState(value)) {
    throw new SellerStoreValidationError(`unknown access_state: ${String(value)}`);
  }
};

const assertUsage = (
  usage_kind: SellerUsageKind,
  period_granularity: SellerUsagePeriodGranularity,
): void => {
  if (!isSellerUsageKind(usage_kind)) {
    throw new SellerStoreValidationError(`unknown usage_kind: ${String(usage_kind)}`);
  }
  if (!isSellerUsagePeriodGranularity(period_granularity)) {
    throw new SellerStoreValidationError(
      `unknown period_granularity: ${String(period_granularity)}`,
    );
  }
};

const settingsFromRow = (row: SettingsRow | undefined): SellerSettings => {
  if (!row) {
    return {
      default_grace_hours: DEFAULT_GRACE_HOURS,
      sender_mail_instance_id: null,
      status_policy_json: {},
      email_policy_json: {},
      llm_gateway_paid_ack_at: null,
      llm_gateway_paid_ack_version: null,
      created_at: null,
      updated_at: null,
    };
  }
  return {
    default_grace_hours: row.default_grace_hours,
    sender_mail_instance_id: row.sender_mail_instance_id,
    status_policy_json: parseJsonObject(row.status_policy_json),
    email_policy_json: parseJsonObject(row.email_policy_json),
    llm_gateway_paid_ack_at: row.llm_gateway_paid_ack_at,
    llm_gateway_paid_ack_version: row.llm_gateway_paid_ack_version,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
};

const offerFromRow = (row: OfferRow): SellerOffer => ({
  offer_id: row.offer_id,
  kind: row.kind as SellerOfferKind,
  display_name: row.display_name,
  description: row.description,
  pricing_kind: row.pricing_kind as SellerOfferPricingKind,
  amount_minor: row.amount_minor,
  currency: row.currency,
  fulfillment_recipe_id: row.fulfillment_recipe_id,
  checkout_url: row.checkout_url,
  fulfillment_config: parseNullableJsonObject(row.fulfillment_config),
  state: row.state as SellerOfferState,
  created_by_recipe_id: row.created_by_recipe_id,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const tierFromRow = (row: TierRow): SellerTier => ({
  tier_id: row.tier_id,
  door_id: row.door_id,
  lifecycle_source: row.lifecycle_source as SellerLifecycleSource,
  entitlement_key: row.entitlement_key,
  display_name: row.display_name,
  template_contract_id: row.template_contract_id,
  external_entitlement_id: row.external_entitlement_id,
  usage_policy_json: parseJsonObject(row.usage_policy_json),
  pass_duration_seconds: row.pass_duration_seconds,
  customer_status_enabled_default: row.customer_status_enabled_default === 1,
  active: row.active === 1,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const customerFromRow = (row: CustomerRow): SellerCustomer => ({
  customer_id: row.customer_id,
  lifecycle_source: row.lifecycle_source as SellerLifecycleSource,
  source_customer_id: row.source_customer_id,
  door_id: row.door_id,
  email: row.email,
  tier_id: row.tier_id,
  contract_id: row.contract_id,
  inbound_token_id: row.inbound_token_id,
  mcp_token_id: row.mcp_token_id,
  external_subscription_id: row.external_subscription_id,
  source_status: row.source_status,
  current_period_end: row.current_period_end,
  grace_until: row.grace_until,
  access_state: row.access_state as SellerAccessState,
  claim_email_sent_at: row.claim_email_sent_at,
  claim_email_marker: row.claim_email_marker,
  status_email_sent_at: row.status_email_sent_at,
  status_email_marker: row.status_email_marker,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const usageFromRow = (row: UsageRow): SellerCustomerUsageRollup => ({
  contract_id: row.contract_id,
  usage_kind: row.usage_kind as SellerUsageKind,
  period_granularity: row.period_granularity as SellerUsagePeriodGranularity,
  period_start: row.period_start,
  units: row.units,
  // ⛔ D-250 § D — ANOTHER ENUMERATING COPIER. A column added to the table and
  // not named here is dropped on every read with no type error, exactly as
  // `buildAuditEntry` has repeatedly dropped audit fields. `!= null` keeps NULL
  // (never measured) distinct from 0 (measured, cost nothing).
  ...(row.tokens_input != null ? { tokens_input: row.tokens_input } : {}),
  ...(row.tokens_output != null ? { tokens_output: row.tokens_output } : {}),
  ...(row.tokens_total != null ? { tokens_total: row.tokens_total } : {}),
  ...(row.provider_calls != null ? { provider_calls: row.provider_calls } : {}),
  created_at: row.created_at,
  updated_at: row.updated_at,
});

export const createSellerStore = (db: Database.Database): SellerStore => {
  ensureSellerSchema(db);

  const settingsStmt = db.prepare(
    `SELECT * FROM ${SELLER_SETTINGS_TABLE} WHERE settings_id = ?`,
  );
  const upsertSettingsStmt = db.prepare(`
    INSERT INTO ${SELLER_SETTINGS_TABLE}
      (settings_id, default_grace_hours, sender_mail_instance_id,
       status_policy_json, email_policy_json, created_at, updated_at)
    VALUES
      (@settings_id, @default_grace_hours, @sender_mail_instance_id,
       @status_policy_json, @email_policy_json, @created_at, @updated_at)
    ON CONFLICT (settings_id) DO UPDATE SET
      default_grace_hours = excluded.default_grace_hours,
      sender_mail_instance_id = excluded.sender_mail_instance_id,
      status_policy_json = excluded.status_policy_json,
      email_policy_json = excluded.email_policy_json,
      updated_at = excluded.updated_at
  `);
  // D-196 §4.9 / I-7 — the paid-gateway acknowledgment writer. On a fresh row it
  // seeds the other settings from the caller's preserved snapshot; on an existing
  // row it touches ONLY the ack columns + updated_at, so grace/sender/policy edits
  // are never disturbed and the ack cannot be toggled by a routine settings write.
  const acknowledgeLlmGatewayPaidStmt = db.prepare(`
    INSERT INTO ${SELLER_SETTINGS_TABLE}
      (settings_id, default_grace_hours, sender_mail_instance_id,
       status_policy_json, email_policy_json,
       llm_gateway_paid_ack_at, llm_gateway_paid_ack_version,
       created_at, updated_at)
    VALUES
      (@settings_id, @default_grace_hours, @sender_mail_instance_id,
       @status_policy_json, @email_policy_json,
       @llm_gateway_paid_ack_at, @llm_gateway_paid_ack_version,
       @created_at, @updated_at)
    ON CONFLICT (settings_id) DO UPDATE SET
      llm_gateway_paid_ack_at = excluded.llm_gateway_paid_ack_at,
      llm_gateway_paid_ack_version = excluded.llm_gateway_paid_ack_version,
      updated_at = excluded.updated_at
  `);

  const getOfferStmt = db.prepare(
    `SELECT * FROM ${SELLER_OFFERS_TABLE} WHERE offer_id = ?`,
  );
  const listOffersStmt = db.prepare(
    `SELECT * FROM ${SELLER_OFFERS_TABLE} ORDER BY updated_at DESC, offer_id ASC`,
  );
  const insertOfferStmt = db.prepare(`
    INSERT INTO ${SELLER_OFFERS_TABLE}
      (offer_id, kind, display_name, description, pricing_kind, amount_minor,
       currency, fulfillment_recipe_id, checkout_url, fulfillment_config, state,
       created_by_recipe_id, created_at, updated_at)
    VALUES
      (@offer_id, @kind, @display_name, @description, @pricing_kind, @amount_minor,
       @currency, @fulfillment_recipe_id, @checkout_url, @fulfillment_config, @state,
       @created_by_recipe_id, @created_at, @updated_at)
  `);
  const transitionOfferStateStmt = db.prepare(`
    UPDATE ${SELLER_OFFERS_TABLE}
       SET state = @next_state,
           updated_at = @updated_at
     WHERE offer_id = @offer_id
       AND state = @expected_state
       AND updated_at = @expected_updated_at
  `);
  const attachOfferFulfillmentRecipeStmt = db.prepare(`
    UPDATE ${SELLER_OFFERS_TABLE}
       SET fulfillment_recipe_id = @recipe_id,
           updated_at = @updated_at
     WHERE offer_id = @offer_id
       AND created_by_recipe_id = @recipe_id
       AND fulfillment_recipe_id IS NULL
       AND state <> 'archived'
       AND updated_at = @expected_updated_at
  `);
  const getTierStmt = db.prepare(`SELECT * FROM ${SELLER_TIERS_TABLE} WHERE tier_id = ?`);
  const findTierStmt = db.prepare(`
    SELECT * FROM ${SELLER_TIERS_TABLE}
     WHERE door_id = ? AND lifecycle_source = ? AND entitlement_key = ?
     LIMIT 1
  `);
  const listTiersStmt = db.prepare(
    `SELECT * FROM ${SELLER_TIERS_TABLE} ORDER BY updated_at DESC, tier_id ASC`,
  );
  const upsertTierStmt = db.prepare(`
    INSERT INTO ${SELLER_TIERS_TABLE}
      (tier_id, door_id, lifecycle_source, entitlement_key, display_name,
       template_contract_id, external_entitlement_id, usage_policy_json,
       pass_duration_seconds, customer_status_enabled_default, active,
       created_at, updated_at)
    VALUES
      (@tier_id, @door_id, @lifecycle_source, @entitlement_key, @display_name,
       @template_contract_id, @external_entitlement_id, @usage_policy_json,
       @pass_duration_seconds, @customer_status_enabled_default, @active,
       @created_at, @updated_at)
    ON CONFLICT (tier_id) DO UPDATE SET
      door_id = excluded.door_id,
      lifecycle_source = excluded.lifecycle_source,
      entitlement_key = excluded.entitlement_key,
      display_name = excluded.display_name,
      template_contract_id = excluded.template_contract_id,
      external_entitlement_id = excluded.external_entitlement_id,
      usage_policy_json = excluded.usage_policy_json,
      pass_duration_seconds = excluded.pass_duration_seconds,
      customer_status_enabled_default = excluded.customer_status_enabled_default,
      active = excluded.active,
      updated_at = excluded.updated_at
  `);

  const getCustomerStmt = db.prepare(
    `SELECT * FROM ${SELLER_CUSTOMERS_TABLE} WHERE customer_id = ?`,
  );
  const findCustomerStmt = db.prepare(`
    SELECT * FROM ${SELLER_CUSTOMERS_TABLE}
     WHERE lifecycle_source = ? AND source_customer_id = ? AND door_id = ?
     LIMIT 1
  `);
  const listCustomersStmt = db.prepare(
    `SELECT * FROM ${SELLER_CUSTOMERS_TABLE} ORDER BY updated_at DESC, customer_id ASC`,
  );
  const listCustomersByContractStmt = db.prepare(
    `SELECT * FROM ${SELLER_CUSTOMERS_TABLE}
      WHERE contract_id = ?
      ORDER BY updated_at DESC, customer_id ASC`,
  );
  // D-196 §6.3 — see `listOpenSubscriptionCustomers` on the interface for why
  // each of the three predicates is load-bearing.
  const listOpenSubscriptionCustomersStmt = db.prepare(
    `SELECT * FROM ${SELLER_CUSTOMERS_TABLE}
      WHERE lifecycle_source = ?
        AND external_subscription_id IS NOT NULL
        AND access_state != 'closed'
      ORDER BY updated_at DESC, customer_id ASC`,
  );
  const upsertCustomerStmt = db.prepare(`
    INSERT INTO ${SELLER_CUSTOMERS_TABLE}
      (customer_id, lifecycle_source, source_customer_id, door_id, email,
       tier_id, contract_id, inbound_token_id, mcp_token_id,
       external_subscription_id, source_status, current_period_end, grace_until,
       access_state, claim_email_sent_at, claim_email_marker,
       status_email_sent_at, status_email_marker, created_at, updated_at)
    VALUES
      (@customer_id, @lifecycle_source, @source_customer_id, @door_id, @email,
       @tier_id, @contract_id, @inbound_token_id, @mcp_token_id,
       @external_subscription_id, @source_status, @current_period_end, @grace_until,
       @access_state, @claim_email_sent_at, @claim_email_marker,
       @status_email_sent_at, @status_email_marker, @created_at, @updated_at)
    ON CONFLICT (customer_id) DO UPDATE SET
      email = excluded.email,
      tier_id = excluded.tier_id,
      contract_id = excluded.contract_id,
      inbound_token_id = excluded.inbound_token_id,
      mcp_token_id = excluded.mcp_token_id,
      external_subscription_id = excluded.external_subscription_id,
      source_status = excluded.source_status,
      current_period_end = excluded.current_period_end,
      grace_until = excluded.grace_until,
      access_state = excluded.access_state,
      claim_email_sent_at = excluded.claim_email_sent_at,
      claim_email_marker = excluded.claim_email_marker,
      status_email_sent_at = excluded.status_email_sent_at,
      status_email_marker = excluded.status_email_marker,
      updated_at = excluded.updated_at
  `);
  const reserveClaimEmailDeliveryStmt = db.prepare(`
    UPDATE ${SELLER_CUSTOMERS_TABLE}
       SET claim_email_marker = @marker,
           claim_email_sent_at = NULL,
           updated_at = @now
     WHERE customer_id = @customer_id
       AND claim_email_marker IS NULL
       AND claim_email_sent_at IS NULL
  `);
  const markClaimEmailDeliverySentStmt = db.prepare(`
    UPDATE ${SELLER_CUSTOMERS_TABLE}
       SET claim_email_sent_at = @sent_at,
           updated_at = @now
     WHERE customer_id = @customer_id
       AND claim_email_marker = @marker
       AND claim_email_sent_at IS NULL
  `);

  const getUsageStmt = db.prepare(`
    SELECT * FROM ${SELLER_CUSTOMER_USAGE_ROLLUPS_TABLE}
     WHERE contract_id = ?
       AND usage_kind = ?
       AND period_granularity = ?
       AND period_start = ?
  `);
  const listUsageStmt = db.prepare(`
    SELECT * FROM ${SELLER_CUSTOMER_USAGE_ROLLUPS_TABLE}
     WHERE contract_id = ?
     ORDER BY period_start DESC, usage_kind ASC
  `);
  const recordUsageStmt = db.prepare(`
    INSERT INTO ${SELLER_CUSTOMER_USAGE_ROLLUPS_TABLE}
      (contract_id, usage_kind, period_granularity, period_start,
       units, created_at, updated_at)
    VALUES
      (@contract_id, @usage_kind, @period_granularity, @period_start,
       @units, @created_at, @updated_at)
    ON CONFLICT (contract_id, usage_kind, period_granularity, period_start)
      DO UPDATE SET
        units = units + excluded.units,
        updated_at = excluded.updated_at
  `);

  /** D-250 § D — accumulate MEASURED provider tokens onto the rollup row.
   *
   *  ⚠ `units: 0` on the INSERT arm is deliberate and not a placeholder: this
   *  write records no new metered unit, only what the already-metered work
   *  actually cost. The conflict arm adds 0 to `units`, leaving the meter
   *  untouched — a token write must never move a billing count. */
  /** D-250 § D — ⛔ TOUCHES ONE COLUMN. Identity (`door_id`,
   *  `lifecycle_source`, `entitlement_key`, `external_entitlement_id`,
   *  `template_contract_id`) is owned by whatever minted the tier and must not
   *  be reachable from a policy edit. */
  const setTierUsagePolicyStmt = db.prepare(`
    UPDATE ${SELLER_TIERS_TABLE}
       SET usage_policy_json = @usage_policy_json,
           updated_at = @updated_at
     WHERE tier_id = @tier_id
  `);

  const recordTokenUsageStmt = db.prepare(`
    INSERT INTO ${SELLER_CUSTOMER_USAGE_ROLLUPS_TABLE}
      (contract_id, usage_kind, period_granularity, period_start,
       units, tokens_input, tokens_output, tokens_total, provider_calls,
       created_at, updated_at)
    VALUES
      (@contract_id, @usage_kind, @period_granularity, @period_start,
       0, @tokens_input, @tokens_output, @tokens_total, @provider_calls,
       @created_at, @updated_at)
    ON CONFLICT (contract_id, usage_kind, period_granularity, period_start)
      DO UPDATE SET
        tokens_input   = COALESCE(tokens_input, 0)   + excluded.tokens_input,
        tokens_output  = COALESCE(tokens_output, 0)  + excluded.tokens_output,
        tokens_total   = COALESCE(tokens_total, 0)   + excluded.tokens_total,
        provider_calls = COALESCE(provider_calls, 0) + excluded.provider_calls,
        updated_at = excluded.updated_at
  `);

  const readSettingsRow = (): SettingsRow | undefined =>
    settingsStmt.get(SETTINGS_ID) as SettingsRow | undefined;

  const readOffer = (offer_id: string): OfferRow | undefined =>
    getOfferStmt.get(offer_id) as OfferRow | undefined;

  const readTier = (tier_id: string): TierRow | undefined =>
    getTierStmt.get(tier_id) as TierRow | undefined;

  const readTierBySource = (
    door_id: string,
    lifecycle_source: SellerLifecycleSource,
    entitlement_key: string,
  ): TierRow | undefined =>
    findTierStmt.get(door_id, lifecycle_source, entitlement_key) as TierRow | undefined;

  const readCustomer = (customer_id: string): CustomerRow | undefined =>
    getCustomerStmt.get(customer_id) as CustomerRow | undefined;

  const readCustomerBySource = (
    lifecycle_source: SellerLifecycleSource,
    source_customer_id: string,
    door_id: string,
  ): CustomerRow | undefined =>
    findCustomerStmt.get(lifecycle_source, source_customer_id, door_id) as
      | CustomerRow
      | undefined;

  return {
    getSettings() {
      return settingsFromRow(readSettingsRow());
    },
    upsertSettings(input) {
      const existing = settingsFromRow(readSettingsRow());
      const default_grace_hours =
        input.default_grace_hours ?? existing.default_grace_hours;
      if (!Number.isInteger(default_grace_hours) || default_grace_hours < 0) {
        throw new SellerStoreValidationError(
          'default_grace_hours must be a non-negative integer',
        );
      }
      const created_at = existing.created_at ?? input.now;
      upsertSettingsStmt.run({
        settings_id: SETTINGS_ID,
        default_grace_hours,
        sender_mail_instance_id:
          input.sender_mail_instance_id === undefined
            ? existing.sender_mail_instance_id
            : cleanNullableString(input.sender_mail_instance_id),
        status_policy_json:
          input.status_policy_json === undefined
            ? JSON.stringify(existing.status_policy_json)
            : jsonObject(input.status_policy_json),
        email_policy_json:
          input.email_policy_json === undefined
            ? JSON.stringify(existing.email_policy_json)
            : jsonObject(input.email_policy_json),
        created_at,
        updated_at: input.now,
      });
      return this.getSettings();
    },
    acknowledgeLlmGatewayPaid(input) {
      const existing = settingsFromRow(readSettingsRow());
      acknowledgeLlmGatewayPaidStmt.run({
        settings_id: SETTINGS_ID,
        default_grace_hours: existing.default_grace_hours,
        sender_mail_instance_id: existing.sender_mail_instance_id,
        status_policy_json: JSON.stringify(existing.status_policy_json),
        email_policy_json: JSON.stringify(existing.email_policy_json),
        llm_gateway_paid_ack_at: input.now,
        llm_gateway_paid_ack_version: LLM_GATEWAY_PAID_ACK_VERSION,
        created_at: existing.created_at ?? input.now,
        updated_at: input.now,
      });
      return this.getSettings();
    },
    ensureOffer(input) {
      assertOfferKind(input.kind);
      assertOfferPricingKind(input.pricing_kind);
      const offer_id = cleanOfferId(input.offer_id);
      const display_name = cleanBoundedString(input.display_name, 'display_name', 160);
      const description = cleanOfferDescription(input.description);
      const fulfillment_recipe_id = input.fulfillment_recipe_id === undefined
        || input.fulfillment_recipe_id === null
        ? null
        : cleanBoundedString(
            input.fulfillment_recipe_id,
            'fulfillment_recipe_id',
            256,
          );
      const created_by_recipe_id = input.created_by_recipe_id === undefined
        || input.created_by_recipe_id === null
        ? null
        : cleanBoundedString(
            input.created_by_recipe_id,
            'created_by_recipe_id',
            256,
          );
      // Fail closed at the storage boundary: a checkout URL that the public
      // renderer would refuse must never reach the row, or the owner would see a
      // configured offer whose button silently does not render.
      let checkout_url: string | null = null;
      if (input.checkout_url !== undefined && input.checkout_url !== null) {
        if (!isReceptionLinkButtonUrl(input.checkout_url)) {
          throw new SellerStoreValidationError(
            'checkout_url must be an absolute HTTPS URL',
          );
        }
        checkout_url = input.checkout_url;
      }
      const fulfillment_config = cleanFulfillmentConfig(input.fulfillment_config);
      const now = requireWholeNumber(input.now, 'now');

      // Derived from the SAME partition the storage CHECK is generated from
      // (`SELLER_OFFER_PRICING_REQUIRES_AMOUNT`, D-207 §4.4a), so this runtime
      // validation and the SQL fence can never disagree: PRICED (`fixed`/
      // `recurring`) requires a positive amount + currency; UNPRICED
      // (`unspecified`/`free`) requires neither.
      let amount_minor: number | null = null;
      let currency: string | null = null;
      if (sellerOfferPricingRequiresAmount(input.pricing_kind)) {
        if (
          !Number.isSafeInteger(input.amount_minor)
          || (input.amount_minor ?? 0) <= 0
        ) {
          throw new SellerStoreValidationError(
            `amount_minor must be a positive safe integer for ${input.pricing_kind} pricing`,
          );
        }
        amount_minor = input.amount_minor as number;
        currency = cleanOfferCurrency(input.currency);
        if (currency === null) {
          throw new SellerStoreValidationError(
            `currency is required for ${input.pricing_kind} pricing`,
          );
        }
      } else if (
        input.amount_minor !== undefined
        && input.amount_minor !== null
      ) {
        throw new SellerStoreValidationError(
          `amount_minor must be absent for ${input.pricing_kind} pricing`,
        );
      } else if (input.currency !== undefined && input.currency !== null) {
        throw new SellerStoreValidationError(
          `currency must be absent for ${input.pricing_kind} pricing`,
        );
      }

      const existing = readOffer(offer_id);
      if (existing) {
        const sameDefinition = existing.kind === input.kind
          && existing.display_name === display_name
          && existing.description === description
          && existing.pricing_kind === input.pricing_kind
          && existing.amount_minor === amount_minor
          && existing.currency === currency
          && existing.fulfillment_recipe_id === fulfillment_recipe_id
          // Omitting this would make a re-ensure with a DIFFERENT checkout URL
          // return `existing` carrying the OLD one — the caller would believe it
          // had set the target, and the button would keep pointing somewhere else.
          && existing.checkout_url === checkout_url
          // Same rationale for the fulfillment config: a re-ensure that changed it
          // must conflict, never quietly hand back the stale config. Both sides are
          // the serialized column string (deterministic for a stable object).
          && existing.fulfillment_config === fulfillment_config;
        if (!sameDefinition) {
          throw new SellerStoreConflictError(
            `offer_id '${offer_id}' already exists with a different definition`,
          );
        }
        return { result: 'existing', offer: offerFromRow(existing) };
      }

      insertOfferStmt.run({
        offer_id,
        kind: input.kind,
        display_name,
        description,
        pricing_kind: input.pricing_kind,
        amount_minor,
        currency,
        fulfillment_recipe_id,
        checkout_url,
        fulfillment_config,
        state: 'draft',
        created_by_recipe_id,
        created_at: now,
        updated_at: now,
      });
      return { result: 'created', offer: offerFromRow(readOffer(offer_id)!) };
    },
    attachOfferFulfillmentRecipe(input) {
      const offer_id = cleanOfferId(input.offer_id);
      const recipe_id = cleanBoundedString(input.recipe_id, 'recipe_id', 256);
      const now = requireWholeNumber(input.now, 'now');
      if (!Number.isSafeInteger(now)) {
        throw new SellerStoreValidationError('now must be a safe integer');
      }

      const existing = readOffer(offer_id);
      if (!existing) {
        throw new SellerStoreValidationError(
          `offer_id '${offer_id}' does not exist`,
        );
      }
      if (existing.created_by_recipe_id !== recipe_id) {
        throw new SellerStoreConflictError(
          `offer_id '${offer_id}' was not created by recipe '${recipe_id}'`,
        );
      }
      if (existing.fulfillment_recipe_id === recipe_id) {
        return { result: 'unchanged', offer: offerFromRow(existing) };
      }
      if (existing.fulfillment_recipe_id !== null) {
        throw new SellerStoreConflictError(
          `offer_id '${offer_id}' already points at a different fulfillment recipe`,
        );
      }
      if (existing.state === 'archived') {
        throw new SellerStoreConflictError(
          `offer_id '${offer_id}' is archived and cannot be changed`,
        );
      }
      if (!Number.isSafeInteger(existing.updated_at + 1)) {
        throw new SellerStoreValidationError(
          `offer_id '${offer_id}' cannot advance its optimistic row token`,
        );
      }
      const updated_at = Math.max(now, existing.updated_at + 1);
      const update = attachOfferFulfillmentRecipeStmt.run({
        offer_id,
        recipe_id,
        expected_updated_at: existing.updated_at,
        updated_at,
      });
      if (update.changes !== 1) {
        const settled = readOffer(offer_id);
        if (settled?.fulfillment_recipe_id === recipe_id) {
          return { result: 'unchanged', offer: offerFromRow(settled) };
        }
        throw new SellerStoreConflictError(
          `offer_id '${offer_id}' changed during fulfillment-link attachment`,
        );
      }
      return {
        result: 'updated',
        offer: offerFromRow(readOffer(offer_id)!),
      };
    },
    transitionOfferState(input) {
      const offer_id = cleanOfferId(input.offer_id);
      assertOfferState(input.expected_state);
      assertOfferState(input.next_state);
      const expected_updated_at = requireWholeNumber(
        input.expected_updated_at,
        'expected_updated_at',
      );
      const now = requireWholeNumber(input.now, 'now');
      if (!Number.isSafeInteger(expected_updated_at)) {
        throw new SellerStoreValidationError(
          'expected_updated_at must be a safe integer',
        );
      }
      if (!Number.isSafeInteger(now)) {
        throw new SellerStoreValidationError('now must be a safe integer');
      }
      if (!isSellerOfferStateTransitionAllowed(
        input.expected_state,
        input.next_state,
      )) {
        throw new SellerStoreValidationError(
          `offer state transition ${input.expected_state} -> ${input.next_state} is not allowed`,
        );
      }

      const existing = readOffer(offer_id);
      if (!existing) {
        throw new SellerStoreValidationError(
          `offer_id '${offer_id}' does not exist`,
        );
      }
      if (existing.state === input.next_state) {
        return { result: 'unchanged', offer: offerFromRow(existing) };
      }
      if (existing.state !== input.expected_state) {
        throw new SellerStoreConflictError(
          `offer_id '${offer_id}' expected state '${input.expected_state}' but found '${existing.state}'`,
        );
      }
      if (existing.updated_at !== expected_updated_at) {
        throw new SellerStoreConflictError(
          `offer_id '${offer_id}' expected updated_at '${expected_updated_at}' but found '${existing.updated_at}'`,
        );
      }
      if (!Number.isSafeInteger(existing.updated_at + 1)) {
        throw new SellerStoreValidationError(
          `offer_id '${offer_id}' cannot advance its optimistic row token`,
        );
      }
      const updated_at = Math.max(now, existing.updated_at + 1);

      const update = transitionOfferStateStmt.run({
        offer_id,
        expected_state: input.expected_state,
        expected_updated_at,
        next_state: input.next_state,
        updated_at,
      });
      if (update.changes !== 1) {
        const settled = readOffer(offer_id);
        if (settled?.state === input.next_state) {
          return { result: 'unchanged', offer: offerFromRow(settled) };
        }
        throw new SellerStoreConflictError(
          `offer_id '${offer_id}' changed during state transition`,
        );
      }
      return {
        result: 'updated',
        offer: offerFromRow(readOffer(offer_id)!),
      };
    },
    getOffer(offer_id) {
      const row = readOffer(cleanOfferId(offer_id));
      return row ? offerFromRow(row) : null;
    },
    listOffers(query) {
      let offers = (listOffersStmt.all() as OfferRow[]).map(offerFromRow);
      if (query?.kind !== undefined) {
        assertOfferKind(query.kind);
        offers = offers.filter((offer) => offer.kind === query.kind);
      }
      if (query?.state !== undefined) {
        assertOfferState(query.state);
        offers = offers.filter((offer) => offer.state === query.state);
      }
      return offers;
    },
    upsertTier(input) {
      assertLifecycleSource(input.lifecycle_source);
      const requestedTierId = cleanString(input.tier_id, 'tier_id');
      const requestedDoorId = cleanString(input.door_id, 'door_id');
      const requestedEntitlementKey = cleanString(
        input.entitlement_key,
        'entitlement_key',
      );
      const bySource = readTierBySource(
        requestedDoorId,
        input.lifecycle_source,
        requestedEntitlementKey,
      );
      const byId = readTier(requestedTierId);
      if (byId && bySource && byId.tier_id !== bySource.tier_id) {
        throw new SellerStoreConflictError(
          `tier_id ${input.tier_id} conflicts with source-qualified tier ${bySource.tier_id}`,
        );
      }
      if (
        byId
        && (
          byId.door_id !== requestedDoorId
          || byId.lifecycle_source !== input.lifecycle_source
          || byId.entitlement_key !== requestedEntitlementKey
        )
      ) {
        throw new SellerStoreConflictError(
          `tier_id ${requestedTierId} is already bound to `
            + `${byId.lifecycle_source}/${byId.door_id}/${byId.entitlement_key}`,
        );
      }
      const existing = bySource ?? byId;
      const current = existing ? tierFromRow(existing) : null;
      const tier_id = existing?.tier_id ?? requestedTierId;
      const created_at = existing?.created_at ?? input.now;
      const display_name = input.display_name === undefined
        ? current?.display_name
        : cleanString(input.display_name, 'display_name');
      if (display_name === undefined) {
        throw new SellerStoreValidationError('display_name is required when creating a tier');
      }
      const template_contract_id = input.template_contract_id === undefined
        ? current?.template_contract_id
        : cleanString(input.template_contract_id, 'template_contract_id');
      if (template_contract_id === undefined) {
        throw new SellerStoreValidationError(
          'template_contract_id is required when creating a tier',
        );
      }
      upsertTierStmt.run({
        tier_id,
        door_id: requestedDoorId,
        lifecycle_source: input.lifecycle_source,
        entitlement_key: requestedEntitlementKey,
        display_name,
        template_contract_id,
        external_entitlement_id:
          input.external_entitlement_id === undefined
            ? current?.external_entitlement_id ?? null
            : cleanNullableString(input.external_entitlement_id),
        usage_policy_json:
          input.usage_policy_json === undefined
            ? JSON.stringify(current?.usage_policy_json ?? {})
            : jsonObject(input.usage_policy_json),
        pass_duration_seconds:
          input.pass_duration_seconds === undefined
            ? current?.pass_duration_seconds ?? null
            : requireWholeNumberOrNull(
                input.pass_duration_seconds,
                'pass_duration_seconds',
              ),
        customer_status_enabled_default:
          (input.customer_status_enabled_default
            ?? current?.customer_status_enabled_default
            ?? false)
            ? 1
            : 0,
        active: (input.active ?? current?.active ?? true) ? 1 : 0,
        created_at,
        updated_at: input.now,
      });
      return tierFromRow(readTier(tier_id)!);
    },
    getTier(tier_id) {
      const row = readTier(cleanString(tier_id, 'tier_id'));
      return row ? tierFromRow(row) : null;
    },
    findTier(input) {
      assertLifecycleSource(input.lifecycle_source);
      const row = readTierBySource(
        cleanString(input.door_id, 'door_id'),
        input.lifecycle_source,
        cleanString(input.entitlement_key, 'entitlement_key'),
      );
      return row ? tierFromRow(row) : null;
    },
    listTiers(query) {
      let rows = (listTiersStmt.all() as TierRow[]).map(tierFromRow);
      if (query?.door_id !== undefined) {
        const door_id = cleanString(query.door_id, 'door_id');
        rows = rows.filter((row) => row.door_id === door_id);
      }
      if (query?.lifecycle_source !== undefined) {
        assertLifecycleSource(query.lifecycle_source);
        rows = rows.filter((row) => row.lifecycle_source === query.lifecycle_source);
      }
      if (query?.active !== undefined) {
        rows = rows.filter((row) => row.active === query.active);
      }
      return rows;
    },
    upsertCustomer(input) {
      assertLifecycleSource(input.lifecycle_source);
      assertAccessState(input.access_state);
      const source_customer_id = cleanString(
        input.source_customer_id,
        'source_customer_id',
      );
      const door_id = cleanString(input.door_id, 'door_id');
      const tier_id = cleanString(input.tier_id, 'tier_id');
      const tier = readTier(tier_id);
      if (!tier) {
        throw new SellerStoreValidationError(
          'tier_id must reference an existing seller_tiers row',
        );
      }
      if (tier.lifecycle_source !== input.lifecycle_source || tier.door_id !== door_id) {
        throw new SellerStoreValidationError(
          'tier_id must match customer lifecycle_source and door_id',
        );
      }
      const bySource = readCustomerBySource(
        input.lifecycle_source,
        source_customer_id,
        door_id,
      );
      const customer_id = cleanString(input.customer_id, 'customer_id');
      const byId = readCustomer(customer_id);
      if (
        byId
        && (
          byId.lifecycle_source !== input.lifecycle_source
          || byId.source_customer_id !== source_customer_id
          || byId.door_id !== door_id
        )
      ) {
        throw new SellerStoreConflictError(
          `customer_id '${customer_id}' is already bound to `
            + `${byId.lifecycle_source}/${byId.door_id}/${byId.source_customer_id}`,
        );
      }
      if (bySource && bySource.customer_id !== customer_id) {
        throw new SellerStoreConflictError(
          `${input.lifecycle_source}/${door_id}/${source_customer_id} is already bound to `
            + `customer_id '${bySource.customer_id}'`,
        );
      }
      const existing = byId ?? bySource;
      const cleanedEmail = cleanEmail(input.email);
      const created_at = existing?.created_at ?? input.now;
      upsertCustomerStmt.run({
        customer_id,
        lifecycle_source: input.lifecycle_source,
        source_customer_id,
        door_id,
        email: cleanedEmail === undefined ? existing?.email ?? null : cleanedEmail,
        tier_id,
        contract_id: cleanString(input.contract_id, 'contract_id'),
        inbound_token_id:
          input.inbound_token_id === undefined
            ? existing?.inbound_token_id ?? null
            : cleanNullableString(input.inbound_token_id),
        mcp_token_id:
          input.mcp_token_id === undefined
            ? existing?.mcp_token_id ?? null
            : cleanNullableString(input.mcp_token_id),
        external_subscription_id:
          input.external_subscription_id === undefined
            ? existing?.external_subscription_id ?? null
            : cleanNullableString(input.external_subscription_id),
        source_status:
          input.source_status === undefined
            ? existing?.source_status ?? null
            : cleanNullableString(input.source_status),
        current_period_end:
          input.current_period_end === undefined
            ? existing?.current_period_end ?? null
            : requireWholeNumberOrNull(input.current_period_end, 'current_period_end'),
        grace_until:
          input.grace_until === undefined
            ? existing?.grace_until ?? null
            : requireWholeNumberOrNull(input.grace_until, 'grace_until'),
        access_state: input.access_state,
        claim_email_sent_at:
          input.claim_email_sent_at === undefined
            ? existing?.claim_email_sent_at ?? null
            : requireWholeNumberOrNull(input.claim_email_sent_at, 'claim_email_sent_at'),
        claim_email_marker:
          input.claim_email_marker === undefined
            ? existing?.claim_email_marker ?? null
            : cleanNullableString(input.claim_email_marker),
        status_email_sent_at:
          input.status_email_sent_at === undefined
            ? existing?.status_email_sent_at ?? null
            : requireWholeNumberOrNull(input.status_email_sent_at, 'status_email_sent_at'),
        status_email_marker:
          input.status_email_marker === undefined
            ? existing?.status_email_marker ?? null
            : cleanNullableString(input.status_email_marker),
        created_at,
        updated_at: input.now,
      });
      return customerFromRow(readCustomer(customer_id)!);
    },
    getCustomer(customer_id) {
      const row = readCustomer(cleanString(customer_id, 'customer_id'));
      return row ? customerFromRow(row) : null;
    },
    findCustomerBySource(input) {
      assertLifecycleSource(input.lifecycle_source);
      const row = readCustomerBySource(
        input.lifecycle_source,
        cleanString(input.source_customer_id, 'source_customer_id'),
        cleanString(input.door_id, 'door_id'),
      );
      return row ? customerFromRow(row) : null;
    },
    listCustomers(query) {
      let rows = (query?.contract_id !== undefined
        ? listCustomersByContractStmt.all(cleanString(query.contract_id, 'contract_id'))
        : listCustomersStmt.all()) as CustomerRow[];
      let customers = rows.map(customerFromRow);
      if (query?.lifecycle_source !== undefined) {
        assertLifecycleSource(query.lifecycle_source);
        customers = customers.filter((row) => row.lifecycle_source === query.lifecycle_source);
      }
      if (query?.tier_id !== undefined) {
        const tier_id = cleanString(query.tier_id, 'tier_id');
        customers = customers.filter((row) => row.tier_id === tier_id);
      }
      if (query?.email !== undefined) {
        const email = cleanEmail(query.email);
        if (email === undefined || email === null) {
          throw new SellerStoreValidationError(
            'email filter must be a non-empty string',
          );
        }
        customers = customers.filter((row) => row.email === email);
      }
      if (query?.access_state !== undefined) {
        assertAccessState(query.access_state);
        customers = customers.filter((row) => row.access_state === query.access_state);
      }
      return customers;
    },

    listOpenSubscriptionCustomers(query) {
      assertLifecycleSource(query.lifecycle_source);
      const rows = listOpenSubscriptionCustomersStmt.all(
        query.lifecycle_source,
      ) as CustomerRow[];
      return rows.map(customerFromRow);
    },
    reserveClaimEmailDelivery(input) {
      const result = reserveClaimEmailDeliveryStmt.run({
        customer_id: cleanString(input.customer_id, 'customer_id'),
        marker: cleanString(input.marker, 'marker'),
        now: requireWholeNumber(input.now, 'now'),
      });
      return result.changes === 1;
    },
    markClaimEmailDeliverySent(input) {
      const result = markClaimEmailDeliverySentStmt.run({
        customer_id: cleanString(input.customer_id, 'customer_id'),
        marker: cleanString(input.marker, 'marker'),
        sent_at: requireWholeNumber(input.sent_at, 'sent_at'),
        now: requireWholeNumber(input.now, 'now'),
      });
      return result.changes === 1;
    },
    setTierUsagePolicy(input) {
      const tier_id = cleanString(input.tier_id, 'tier_id');
      const existing = readTier(tier_id);
      if (!existing) {
        throw new SellerStoreValidationError(`unknown tier_id: ${tier_id}`);
      }
      setTierUsagePolicyStmt.run({
        tier_id,
        usage_policy_json: jsonObject(input.usage_policy_json),
        updated_at: input.now,
      });
      return tierFromRow(readTier(tier_id)!);
    },

    recordUsage(input) {
      assertUsage(input.usage_kind, input.period_granularity);
      const units = requirePositiveUsageUnits(input.units);
      if (!Number.isInteger(input.period_start) || input.period_start < 0) {
        throw new SellerStoreValidationError('period_start must be a non-negative integer');
      }
      const contract_id = cleanString(input.contract_id, 'contract_id');
      recordUsageStmt.run({
        contract_id,
        usage_kind: input.usage_kind,
        period_granularity: input.period_granularity,
        period_start: input.period_start,
        units,
        created_at: input.now,
        updated_at: input.now,
      });
      const row = getUsageStmt.get(
        contract_id,
        input.usage_kind,
        input.period_granularity,
        input.period_start,
      ) as UsageRow | undefined;
      return usageFromRow(row!);
    },

    recordTokenUsage(input) {
      assertUsage(input.usage_kind, input.period_granularity);
      if (!Number.isInteger(input.period_start) || input.period_start < 0) {
        throw new SellerStoreValidationError('period_start must be a non-negative integer');
      }
      const contract_id = cleanString(input.contract_id, 'contract_id');
      // ⚠ Non-finite counts are DROPPED, never coerced — a NaN summed into a
      // billing-adjacent column is a confident wrong number, and this is the
      // one surface where that is expensive. Same policy `deriveRunYield`
      // applies to a malformed tally.
      const whole = (v: number | undefined): number =>
        typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
      recordTokenUsageStmt.run({
        contract_id,
        usage_kind: input.usage_kind,
        period_granularity: input.period_granularity,
        period_start: input.period_start,
        tokens_input: whole(input.usage.input_tokens),
        tokens_output: whole(input.usage.output_tokens),
        tokens_total: whole(input.usage.total_tokens),
        provider_calls: whole(input.usage.provider_calls ?? 1),
        created_at: input.now,
        updated_at: input.now,
      });
      const row = getUsageStmt.get(
        contract_id,
        input.usage_kind,
        input.period_granularity,
        input.period_start,
      ) as UsageRow | undefined;
      return usageFromRow(row!);
    },
    getUsageRollup(input) {
      assertUsage(input.usage_kind, input.period_granularity);
      const row = getUsageStmt.get(
        cleanString(input.contract_id, 'contract_id'),
        input.usage_kind,
        input.period_granularity,
        input.period_start,
      ) as UsageRow | undefined;
      return row ? usageFromRow(row) : null;
    },
    listUsageRollups(contract_id) {
      return (listUsageStmt.all(cleanString(contract_id, 'contract_id')) as UsageRow[])
        .map(usageFromRow);
    },
  };
};
