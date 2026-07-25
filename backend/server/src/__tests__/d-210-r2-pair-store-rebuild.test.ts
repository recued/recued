/** D-210 R-2 — the guarded rebuild that lets one endpoint→recipe pair store hold BOTH
 *  kinds of pair.
 *
 *  `reception_intake_recipe_pair.form_definition_id` was `NOT NULL`, which a scheduling
 *  pair (v3) has no value for. `CREATE TABLE IF NOT EXISTS` skips an existing table and
 *  SQLite cannot drop a NOT NULL in place, so a DB created before D-210 would keep a
 *  constraint that rejects every scheduling pair — silently, at the first bind.
 *
 *  These tests drive the rebuild against a DB built with the REAL pre-D-210 DDL rather
 *  than asserting on the current schema, because the whole point of a guarded upgrade is
 *  what it does to a database that already exists. A fresh-boot-only test would pass on a
 *  table that was never migrated. */

import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  receptionPairBinding,
  receptionSchedulingPairBinding,
  type ReceptionPairBinding,
  type RecipeDefinition,
} from '@recued/contracts';
import { ensureReceptionSchema } from '../storage/reception-store.js';
import { createReceptionIntakeRecipePairStore } from '../storage/reception-intake-recipe-pair-store.js';

/** The table exactly as it existed before D-210 — NOT NULL, and (as before D-207) no
 *  `contract_id`, so the rebuild is exercised behind the guarded ALTER that must run
 *  first and grow the column the copy reads. */
const PRE_D210_DDL = `
  CREATE TABLE reception_intake_recipe_pair (
    endpoint_id         TEXT PRIMARY KEY,
    form_definition_id  TEXT NOT NULL,
    binding_blob        TEXT NOT NULL,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL
  );
`;

const recipe = (recipe_id: string, version: number): RecipeDefinition => ({
  recipe_id,
  version,
  ttl: 300,
  metadata: {
    name: 'n',
    description: 'd',
    author: 'local-author',
    supported_platforms: [],
  },
  variables: {},
  prefetch_steps: [],
  steps: [],
  output: { render: [] },
});

const formBinding = (): ReceptionPairBinding => {
  const binding = receptionPairBinding({
    form_config: {
      display_name: 'Brief',
      form_definition: {
        form_definition_id: 'brief-v1',
        fields: [{ name: 'brief', type: 'textarea', label: 'Brief', required: true }],
      },
      submission_processing_rule: {
        // D-210 A.8 slice 2b step 3 — a D-200 pair mints no destination entity:
        // the response row IS the paid deliverable. Was an absent target_kind.
        target_kind: 'form_response',
        fields_to_include_in_target: [],
        fields_to_attach_as_metadata: [],
      },
      anti_spam: {
        honeypot_fields: [],
        rate_limit_per_ip: 5,
        require_proof_of_work: false,
        require_captcha: false,
      },
      required_visitor_fields: { email: 'required' },
    },
    recipe: recipe('brief-router', 1),
    seller_offer_id: null,
  });
  if (binding === null) throw new Error('fixture: form binding failed to derive');
  return binding;
};

const schedulingBinding = (): ReceptionPairBinding => {
  const binding = receptionSchedulingPairBinding({
    required_visitor_fields: {
      name: 'required',
      email: 'required',
      topic: 'optional',
      phone: 'optional',
      notes: 'optional',
    },
    recipe: recipe('booking-router', 2),
  });
  if (binding === null) throw new Error('fixture: scheduling binding failed to derive');
  return binding;
};

const formNotNull = (db: Database.Database): number => {
  const col = (
    db.prepare('PRAGMA table_info(reception_intake_recipe_pair)').all() as {
      name: string;
      notnull: number;
    }[]
  ).find((c) => c.name === 'form_definition_id');
  if (col === undefined) throw new Error('form_definition_id column missing');
  return col.notnull;
};

/** A live pre-D-210 DB carrying one legacy form pair written under the old constraint. */
const legacyDb = (): { db: Database.Database; legacy: ReceptionPairBinding } => {
  const db = new Database(':memory:');
  db.exec(PRE_D210_DDL);
  const legacy = formBinding();
  db.prepare(`
    INSERT INTO reception_intake_recipe_pair
      (endpoint_id, form_definition_id, binding_blob, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
  `).run('ep-form', 'brief-v1', JSON.stringify(legacy), 1000, 2000);
  return { db, legacy };
};

describe('D-210 R-2 — pair store rebuild (form_definition_id NOT NULL → nullable)', () => {
  it('drops the NOT NULL on a DB that predates D-210', () => {
    const { db } = legacyDb();
    expect(formNotNull(db)).toBe(1);

    ensureReceptionSchema(db);

    expect(formNotNull(db)).toBe(0);
  });

  it('carries every legacy row through the rebuild byte-for-byte', () => {
    const { db, legacy } = legacyDb();

    ensureReceptionSchema(db);

    const store = createReceptionIntakeRecipePairStore(db);
    const survived = store.findByEndpoint('ep-form');
    expect(survived).not.toBeNull();
    // The pair_revision IS the pin between a rendered form and the recipe that will
    // process it. A rebuild that altered one byte would stale every live door.
    expect(survived!.binding).toEqual(legacy);
    expect(survived!.created_at).toBe(1000);
    expect(survived!.updated_at).toBe(2000);
  });

  it('persists a scheduling pair, with the column NULL, once rebuilt', () => {
    const { db } = legacyDb();
    ensureReceptionSchema(db);
    const store = createReceptionIntakeRecipePairStore(db);
    const sched = schedulingBinding();

    store.upsert({ endpoint_id: 'ep-sched', binding: sched, now: 5000 });

    expect(store.findByEndpoint('ep-sched')!.binding).toEqual(sched);
    expect(
      (db.prepare(
        'SELECT form_definition_id FROM reception_intake_recipe_pair WHERE endpoint_id = ?',
      ).get('ep-sched') as { form_definition_id: string | null }).form_definition_id,
    ).toBeNull();
  });

  it('holds both kinds at once and links a door to a scheduling pair', () => {
    const { db } = legacyDb();
    ensureReceptionSchema(db);
    const store = createReceptionIntakeRecipePairStore(db);
    store.upsert({ endpoint_id: 'ep-sched', binding: schedulingBinding(), now: 5000 });

    // The D-207 door link is the ONLY route from a dispatch back to its authority; it
    // must work on a v3 or a paired booking would run contract-free.
    expect(store.setContractId({ endpoint_id: 'ep-sched', contract_id: 'ctr-1' })).toBe(true);

    expect(store.findByEndpoint('ep-sched')!.contract_id).toBe('ctr-1');
    expect(store.findByEndpoint('ep-form')).not.toBeNull();
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM reception_intake_recipe_pair')
        .get() as { n: number }).n,
    ).toBe(2);
  });

  it('is idempotent across boots and leaves no rebuild table behind', () => {
    const { db } = legacyDb();
    ensureReceptionSchema(db);
    const store = createReceptionIntakeRecipePairStore(db);
    store.upsert({ endpoint_id: 'ep-sched', binding: schedulingBinding(), now: 5000 });

    ensureReceptionSchema(db);
    ensureReceptionSchema(db);

    expect(store.findByEndpoint('ep-form')).not.toBeNull();
    expect(store.findByEndpoint('ep-sched')).not.toBeNull();
    expect(formNotNull(db)).toBe(0);
    expect(
      (db.prepare(
        `SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'reception_intake_recipe_pair_rebuild'`,
      ).get() as { n: number }).n,
    ).toBe(0);
  });

  it('rebuilds a fresh DB to the nullable shape without any migration', () => {
    const db = new Database(':memory:');

    ensureReceptionSchema(db);

    expect(formNotNull(db)).toBe(0);
    const store = createReceptionIntakeRecipePairStore(db);
    store.upsert({ endpoint_id: 'ep-sched', binding: schedulingBinding(), now: 5000 });
    expect(store.findByEndpoint('ep-sched')!.binding.version).toBe(3);
  });

  it('refuses a row whose column disagrees with its blob, in BOTH directions', () => {
    const { db } = legacyDb();
    ensureReceptionSchema(db);
    const store = createReceptionIntakeRecipePairStore(db);
    const insert = db.prepare(`
      INSERT INTO reception_intake_recipe_pair
        (endpoint_id, form_definition_id, binding_blob, created_at, updated_at, contract_id)
        VALUES (?, ?, ?, ?, ?, NULL)
    `);

    // A scheduling pair beside a leftover form id — evidence of a writer that thinks
    // scheduling has a form.
    insert.run('ep-a', 'brief-v1', JSON.stringify(schedulingBinding()), 1, 2);
    expect(() => store.findByEndpoint('ep-a')).toThrow(/closed row contract/);

    // A form pair whose id was cleared — the cross-check must not be satisfied by NULL
    // just because v3 legitimises NULL.
    insert.run('ep-b', null, JSON.stringify(formBinding()), 1, 2);
    expect(() => store.findByEndpoint('ep-b')).toThrow(/closed row contract/);
  });
});
