/** Poll-manager / G6 — declarative `event_triggers` reconciler suite.
 *
 *  The recipe-install → trigger-row materializer that replaced the
 *  deleted (never-wired) event-trigger-binder: installed recipes'
 *  declarative entries diff against the store's `origin: 'recipe'`
 *  rows. The user's `enabled` toggle on a managed row must survive
 *  every reconcile; orphans (recipe uninstalled) are removed; the
 *  synthetic markers (`composition.*` reception local-dispatch,
 *  `schedule.*` cron vocabulary) + invalid patterns never materialize.
 *
 *  Authoring sugar (design § 4 compile-down): `on:` entries compile
 *  against the injected vendor registry into pattern + dispatch-filter
 *  rows; raw entries' `filter` now materializes onto the row (the
 *  dispatcher evaluates it — the slice-2 wholesale filter-skip is
 *  closed). */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Dish } from '@recued/contracts';
import {
  reconcileDeclarativeTriggers,
  type StoredRecipeRowLike,
} from '../triggers/declarative-reconciler.js';
import { createEventTriggersStore, type EventTriggersStore } from '../triggers/store.js';
import { createDishStore } from '../dish-store.js';
import { createDishContextStore } from '../dish-context-store.js';
import { registerPreapprovalInvalidator } from '../storage/preapproval-lifecycle.js';

const storedRecipe = (
  recipe_id: string,
  event_triggers: Array<Record<string, unknown>> | undefined,
  publisher_id = 'recued-core',
): StoredRecipeRowLike => ({
  recipe_id,
  publisher_id,
  recipe_json: JSON.stringify({ recipe_id, version: 1, event_triggers }),
});

const dish = (overrides: Partial<Dish> = {}): Dish => ({
  dish_id: 'dsh_test',
  recipe_id: 'r1',
  publisher_id: 'recued-core',
  name: 'test dish',
  is_default: false,
  config_overlay: {},
  enabled: true,
  created_at: 1_000,
  ...overrides,
});

describe('reconcileDeclarativeTriggers', () => {
  let db: Database.Database;
  let store: EventTriggersStore;
  let mintCounter: number;

  beforeEach(() => {
    db = new Database(':memory:');
    store = createEventTriggersStore(db);
    mintCounter = 0;
  });

  afterEach(() => {
    db.close();
  });

  const reconcile = (rows: StoredRecipeRowLike[]) =>
    reconcileDeclarativeTriggers({
      store,
      listStored: () => rows,
      now: () => 5_000,
      mintTriggerId: () => `t-test-${++mintCounter}`,
    });

  it('materializes declared entries as DISARMED origin:recipe rows (D-179 P5c default-off)', () => {
    const result = reconcile([
      storedRecipe('trio-hubspot', [
        { event: 'data.connection.api.hubspot.deal.**.updated' },
      ]),
    ]);
    expect(result).toMatchObject({ created: 1, removed: 0, changed: true });

    const rows = store.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recipe_id: 'trio-hubspot',
      publisher_id: 'recued-core',
      pattern: 'data.connection.api.hubspot.deal.**.updated',
      // Owner decision 2026-06-12: installing a pack never silently
      // arms reactive automation — the user enables in #automation.
      enabled: false,
      origin: 'recipe',
    });
  });

  it('leaves D-221 record pointers exclusively on the transactional outbox path', () => {
    const result = reconcile([
      storedRecipe('records-watcher', [
        { event: 'record.created', filter: { kind: 'job' } },
        { event: 'record.*' },
      ]),
    ]);
    expect(result).toMatchObject({ created: 0, skipped: 2, changed: false });
    expect(store.list()).toEqual([]);
  });

  it('is idempotent and PRESERVES the user enabled toggle + row identity across reconciles', () => {
    reconcile([storedRecipe('r1', [{ event: 'data.connection.api.hubspot.deal.**.updated' }])]);
    const row = store.list()[0]!;
    store.update(row.trigger_id, { enabled: false }); // governance disarm

    const second = reconcile([
      storedRecipe('r1', [{ event: 'data.connection.api.hubspot.deal.**.updated' }]),
    ]);
    expect(second).toMatchObject({ created: 0, removed: 0, changed: false });
    const after = store.list()[0]!;
    expect(after.trigger_id).toBe(row.trigger_id);
    expect(after.enabled).toBe(false); // disarm sticks
  });

  it('removes managed rows whose recipe was uninstalled — but never user-origin rows', () => {
    reconcile([storedRecipe('r1', [{ event: 'data.connection.api.hubspot.deal.**.updated' }])]);
    store.create({
      trigger_id: 't-user-1',
      recipe_id: 'r1',
      publisher_id: 'recued-core',
      pattern: 'data.mail.**.created',
      enabled: true,
      created_at: 1,
      origin: 'user',
    });

    const result = reconcile([]);
    expect(result).toMatchObject({ created: 0, removed: 1, changed: true });
    const rows = store.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.trigger_id).toBe('t-user-1');
  });

  it('dissolves managed dishes on declaration removal but leaves user dishes intact', () => {
    const dishStore = createDishStore(db);
    const dishContextStore = createDishContextStore(db);

    reconcile([storedRecipe('managed-recipe', [{ event: 'data.mail.**.created' }])]);
    const managedRow = store.list()[0]!;
    dishStore.set(dish({
      dish_id: 'dsh_managed',
      recipe_id: managedRow.recipe_id,
      publisher_id: managedRow.publisher_id,
      managed_by_trigger_id: managedRow.trigger_id,
    }));
    dishContextStore.set('dsh_managed', { step1: { total: 7 } });
    store.update(managedRow.trigger_id, { dish_id: 'dsh_managed' });

    const removedManaged = reconcileDeclarativeTriggers({
      store,
      listStored: () => [],
      dishStore,
      dishContextStore,
      now: () => 5_000,
      mintTriggerId: () => 't-unused',
    });
    expect(removedManaged).toMatchObject({ removed: 1, changed: true });
    expect(dishStore.get('dsh_managed')).toBeNull();
    expect(dishContextStore.get('dsh_managed')).toBeNull();

    reconcile([storedRecipe('user-dish-recipe', [{ event: 'data.mail.**.updated' }])]);
    const userBoundRow = store.list()[0]!;
    dishStore.set(dish({
      dish_id: 'dsh_user',
      recipe_id: userBoundRow.recipe_id,
      publisher_id: userBoundRow.publisher_id,
    }));
    dishContextStore.set('dsh_user', { step1: { total: 9 } });
    store.update(userBoundRow.trigger_id, { dish_id: 'dsh_user' });

    const removedUserBound = reconcileDeclarativeTriggers({
      store,
      listStored: () => [],
      dishStore,
      dishContextStore,
      now: () => 5_000,
      mintTriggerId: () => 't-unused-2',
    });
    expect(removedUserBound).toMatchObject({ removed: 1, changed: true });
    expect(dishStore.get('dsh_user')).not.toBeNull();
    expect(dishContextStore.get('dsh_user')).toEqual({ step1: { total: 9 } });
  });

  it('skips synthetic markers (composition.* / schedule.*) + invalid patterns, materializes filtered entries, and dedupes within a recipe', () => {
    const result = reconcile([
      storedRecipe('mixed', [
        { event: 'composition.reception_form_submission' },
        { event: 'schedule.cron', filter: { cron: '0 9 * * *' } },
        { event: 'data.mail.**.created', filter: { 'record.folder': 'inbox' } },
        { event: 'not a pattern!!' },
        { event: 'data.connection.api.hubspot.deal.**.updated' },
        { event: 'data.connection.api.hubspot.deal.**.updated' }, // duplicate
        { event: '' },
      ]),
      storedRecipe('malformed-json', undefined),
    ]);
    expect(result).toMatchObject({ created: 2, skipped: 4 });
    const rows = store.list();
    expect(rows).toHaveLength(2);
    const filtered = rows.find((r) => r.pattern === 'data.mail.**.created');
    expect(filtered?.filter).toEqual({ 'record.folder': 'inbox' });
  });

  it('a recipe row with unparseable JSON is skipped cleanly', () => {
    const result = reconcileDeclarativeTriggers({
      store,
      listStored: () => [
        { recipe_id: 'bad', publisher_id: 'p', recipe_json: '{nope' },
        storedRecipe('good', [{ event: 'data.connection.api.salesforce.opportunity.**.updated' }]),
      ],
      now: () => 1,
      mintTriggerId: () => 't-x',
    });
    expect(result.created).toBe(1);
  });

  it('an empty filter object does NOT skip and stores no filter', () => {
    const result = reconcile([
      storedRecipe('r1', [{ event: 'data.connection.api.hubspot.deal.**.updated', filter: {} }]),
    ]);
    expect(result.created).toBe(1);
    expect(result.skipped).toBe(0);
    expect(store.list()[0]!.filter).toBeUndefined();
  });

  // ── Authoring sugar (design § 4 compile-down) ──────────────────

  const REGISTRY = [
    { vendor: 'hubspot', entity: 'deal', crm_alias: 'deal' as const },
    { vendor: 'salesforce', entity: 'opportunity', crm_alias: 'deal' as const },
    { vendor: 'hubspot', entity: 'contact', crm_alias: 'contact' as const },
  ];

  const reconcileWithRegistry = (rows: StoredRecipeRowLike[]) =>
    reconcileDeclarativeTriggers({
      store,
      listStored: () => rows,
      getVendorEntities: () => REGISTRY,
      now: () => 5_000,
      mintTriggerId: () => `t-test-${++mintCounter}`,
    });

  it('compiles an alias sugar entry into one row per registry vendor, carrying fields + where as the dispatch filter', () => {
    const result = reconcileWithRegistry([
      storedRecipe('surface-stalling-deals', [
        { on: 'deal.changed', fields: ['stage', 'amount'], where: { stage: 'negotiation' } },
      ]),
    ]);
    expect(result).toMatchObject({ created: 2, skipped: 0, changed: true });

    const patterns = store.list().map((r) => r.pattern).sort();
    expect(patterns).toEqual([
      'data.connection.api.hubspot.deal.**.updated',
      'data.connection.api.salesforce.opportunity.**.updated',
    ]);
    for (const row of store.list()) {
      expect(row.fields).toEqual(['stage', 'amount']);
      expect(row.filter).toEqual({ 'record.stage': 'negotiation' });
      expect(row.origin).toBe('recipe');
    }
  });

  it('compiles vendor-form + shorthand sugar without a registry (built-in-free forms)', () => {
    const result = reconcile([
      storedRecipe('multi', [
        { on: 'acmecrm.invoice.created', connection: 'acmecrm' },
        { on: 'message.received', connection: 'slack' },
        { on: 'reception.request' },
      ]),
    ]);
    expect(result.created).toBe(3);
    const patterns = store.list().map((r) => r.pattern).sort();
    expect(patterns).toEqual([
      'data.connection.api.acmecrm.invoice.acmecrm.invoice.created',
      'data.messenger.slack.message.created',
      'data.reception.*.request.created',
    ]);
  });

  it('materializes accepted form-response sugar as a disarmed, form-narrowed row', () => {
    const result = reconcile([
      storedRecipe('process-client-intake', [{
        on: 'form_response.accepted',
        where: { form_definition_id: 'client-intake' },
      }]),
    ]);

    expect(result).toMatchObject({ created: 1, skipped: 0, changed: true });
    expect(store.list()).toEqual([
      expect.objectContaining({
        recipe_id: 'process-client-intake',
        pattern: 'data.form_response.accepted.response.created',
        filter: { 'record.form_definition_id': 'client-intake' },
        enabled: false,
        origin: 'recipe',
      }),
    ]);
  });

  it('skips malformed accepted-response narrowing instead of materializing an over-firing row', () => {
    const result = reconcile([
      storedRecipe('typo-form-filter', [{
        on: 'form_response.accepted',
        where: { form_defintion_id: 'client-intake' },
      }]),
    ]);

    expect(result).toMatchObject({ created: 0, skipped: 1, changed: false });
    expect(store.list()).toEqual([]);
  });

  it('an alias entry with zero registry coverage skips and self-heals once the registry grows', () => {
    const rows = [storedRecipe('r1', [{ on: 'account.changed' }])];
    const first = reconcileWithRegistry(rows);
    expect(first).toMatchObject({ created: 0, skipped: 1 });

    const grown = reconcileDeclarativeTriggers({
      store,
      listStored: () => rows,
      getVendorEntities: () => [
        ...REGISTRY,
        { vendor: 'hubspot', entity: 'company', crm_alias: 'account' as const },
      ],
      now: () => 6_000,
      mintTriggerId: () => `t-test-${++mintCounter}`,
    });
    expect(grown).toMatchObject({ created: 1, changed: true });
    expect(store.list()[0]!.pattern).toBe('data.connection.api.hubspot.company.**.updated');
  });

  it('unparseable sugar skips; missing getVendorEntities leaves alias forms uncovered but vendor forms alive', () => {
    const result = reconcile([
      storedRecipe('r1', [
        { on: 'deal.changed' }, // alias, no registry injected → zero coverage
        { on: 'totally bogus' },
        { on: 'deal.exploded' }, // bad verb
        { on: 'acmecrm.invoice.changed' }, // vendor form needs no registry
      ]),
    ]);
    expect(result).toMatchObject({ created: 1, skipped: 3 });
  });

  it('PRESERVES enabled-stickiness when a pre-sugar row (no filter columns) meets its unchanged raw declaration', () => {
    // Materialize, disarm, then reconcile again with the registry-aware
    // deps — the declaration key must be identical for unchanged raw
    // entries across the sugar upgrade (filter/fields both absent).
    reconcile([storedRecipe('r1', [{ event: 'data.connection.api.hubspot.deal.**.updated' }])]);
    const row = store.list()[0]!;
    store.update(row.trigger_id, { enabled: false });

    const after = reconcileWithRegistry([
      storedRecipe('r1', [{ event: 'data.connection.api.hubspot.deal.**.updated' }]),
    ]);
    expect(after).toMatchObject({ created: 0, removed: 0, changed: false });
    expect(store.list()[0]!.trigger_id).toBe(row.trigger_id);
    expect(store.list()[0]!.enabled).toBe(false);
  });

  it('editing a sugar entry\'s where re-mints the row (declaration identity includes the filter)', () => {
    const before = [storedRecipe('r1', [{ on: 'hubspot.deal.changed', where: { stage: 'a' } }])];
    reconcile(before);
    const firstRow = store.list()[0]!;
    store.update(firstRow.trigger_id, { enabled: false });

    const result = reconcile([
      storedRecipe('r1', [{ on: 'hubspot.deal.changed', where: { stage: 'b' } }]),
    ]);
    expect(result).toMatchObject({ created: 1, removed: 1, changed: true });
    const row = store.list()[0]!;
    expect(row.trigger_id).not.toBe(firstRow.trigger_id);
    // D-296 — a recipe's ONE trigger carries its armed state across a changed
    // declaration; this one was disarmed first, so it stays disarmed.
    expect(row.enabled).toBe(false);
    expect(row.filter).toEqual({ 'record.stage': 'b' });
  });

  describe('⛔ D-296 — an update that changes a recipe\'s trigger', () => {
    const withDishes = (rows: StoredRecipeRowLike[], dishStore = createDishStore(db), dishContextStore = createDishContextStore(db)) =>
      reconcileDeclarativeTriggers({
        store,
        listStored: () => rows,
        dishStore,
        dishContextStore,
        now: () => 5_000,
        mintTriggerId: () => `t-test-${++mintCounter}`,
      });

    /** One armed trigger with its managed settings dish + continuity, as the
     *  enable path leaves it. */
    const armWithSettings = (dishStore: ReturnType<typeof createDishStore>, contexts: ReturnType<typeof createDishContextStore>) => {
      const row = store.list()[0]!;
      dishStore.set(dish({
        dish_id: 'dsh_settings', recipe_id: row.recipe_id, publisher_id: row.publisher_id,
        config_overlay: { sender_mail_instance: 'work' }, managed_by_trigger_id: row.trigger_id,
      }));
      contexts.set('dsh_settings', { last: { seen: 3 } });
      store.update(row.trigger_id, { enabled: true, dish_id: 'dsh_settings', watch_interval_ms: 60_000 });
      return row;
    };

    it('a recipe whose ONE trigger changes keeps it armed, with its settings, interval and continuity', () => {
      const dishStore = createDishStore(db);
      const contexts = createDishContextStore(db);
      withDishes([storedRecipe('notify-visitor', [{ event: 'data.calendar.**.updated' }])], dishStore, contexts);
      const before = armWithSettings(dishStore, contexts);

      const result = withDishes([storedRecipe('notify-visitor', [{ event: 'data.work.booking.item.updated' }])], dishStore, contexts);
      expect(result).toMatchObject({ created: 1, removed: 1 });
      const after = store.list()[0]!;
      expect(after.trigger_id).not.toBe(before.trigger_id);
      expect(after).toMatchObject({
        pattern: 'data.work.booking.item.updated', enabled: true, dish_id: 'dsh_settings', watch_interval_ms: 60_000,
      });
      // The dish moved with it — and now answers to the new row…
      expect(dishStore.get('dsh_settings')).toMatchObject({
        config_overlay: { sender_mail_instance: 'work' }, managed_by_trigger_id: after.trigger_id,
      });
      expect(contexts.get('dsh_settings')).toEqual({ last: { seen: 3 } });
      // …so an uninstall still dissolves it.
      withDishes([], dishStore, contexts);
      expect(dishStore.get('dsh_settings')).toBeNull();
    });

    it('carries its last outcome too — Automation shows it', () => {
      withDishes([storedRecipe('tripped', [{ event: 'data.calendar.**.updated' }])]);
      const before = store.list()[0]!;
      store.update(before.trigger_id, { last_fired_at: 4_000, last_error: 'mailbox refused' });
      withDishes([storedRecipe('tripped', [{ event: 'data.work.booking.item.updated' }])]);
      expect(store.list()[0]).toMatchObject({
        pattern: 'data.work.booking.item.updated', enabled: false, last_fired_at: 4_000, last_error: 'mailbox refused',
      });
    });

    it('⛔ a row a reviewed execution parks is ON for the owner, and is carried armed', () => {
      // D-261 parks an armed row (`enabled: false`) while a reviewed execution
      // owns its next fire, and restores it when that retires — which it
      // cannot do for a row the update removed.
      registerPreapprovalInvalidator(db, (kind, key) =>
        db.prepare('UPDATE preapproval_activations SET retired_at = 1 WHERE target_kind = ? AND target_key = ?')
          .run(kind, key).changes);
      withDishes([storedRecipe('parked', [{ event: 'data.calendar.**.updated' }])]);
      const before = store.list()[0]!;
      store.update(before.trigger_id, { enabled: false });
      db.prepare(`INSERT INTO preapproval_activations(future_ref, target_kind, target_key, target_incarnation,
        target_revision, original_enabled, owner_mode, due_at, selector_sequence)
        VALUES ('fx_1', 'next_trigger', ?, 'inc', 1, 1, 'owner', NULL, 0)`).run(before.trigger_id);
      expect(store.get(before.trigger_id)!.enabled).toBe(false);
      expect(store.ownerEnabled(before.trigger_id)).toBe(true);

      withDishes([storedRecipe('parked', [{ event: 'data.work.booking.item.updated' }])]);
      const after = store.list()[0]!;
      expect(after).toMatchObject({ pattern: 'data.work.booking.item.updated', enabled: true });
      // The reviewed execution was for the OLD trigger: it is retired, not moved.
      expect(db.prepare('SELECT retired_at FROM preapproval_activations WHERE future_ref = ?').get('fx_1'))
        .toEqual({ retired_at: 1 });
    });

    it('a count that changes cannot be paired either: two become one, one becomes two — all switched off', () => {
      withDishes([
        storedRecipe('merge', [{ event: 'data.mail.**.created' }, { event: 'data.mail.**.updated' }]),
        storedRecipe('split', [{ event: 'data.file.**.created' }]),
      ]);
      for (const row of store.list()) store.update(row.trigger_id, { enabled: true });
      withDishes([
        storedRecipe('merge', [{ event: 'data.mail.**.deleted' }]),
        storedRecipe('split', [{ event: 'data.file.**.updated' }, { event: 'data.file.**.deleted' }]),
      ]);
      expect(store.list().map((row) => [row.recipe_id, row.pattern, row.enabled]).sort()).toEqual([
        ['merge', 'data.mail.**.deleted', false],
        ['split', 'data.file.**.deleted', false],
        ['split', 'data.file.**.updated', false],
      ]);
    });

    it('a recipe with SEVERAL triggers cannot be paired: the changed one is switched off, the rest untouched', () => {
      const dishStore = createDishStore(db);
      const contexts = createDishContextStore(db);
      withDishes([storedRecipe('two', [{ event: 'data.mail.**.created' }, { event: 'data.mail.**.updated' }])], dishStore, contexts);
      for (const row of store.list()) store.update(row.trigger_id, { enabled: true });
      withDishes([storedRecipe('two', [{ event: 'data.mail.**.created' }, { event: 'data.mail.**.deleted' }])], dishStore, contexts);
      expect(store.list().map((row) => [row.pattern, row.enabled]).sort()).toEqual([
        ['data.mail.**.created', true],
        ['data.mail.**.deleted', false],
      ]);
    });
  });

  it('key-order and fields-order changes do NOT re-mint rows (canonical identity)', () => {
    reconcile([
      storedRecipe('r1', [
        { on: 'hubspot.deal.changed', fields: ['b', 'a'], where: { x: 1, y: 2 } },
      ]),
    ]);
    const firstId = store.list()[0]!.trigger_id;
    const result = reconcile([
      storedRecipe('r1', [
        { on: 'hubspot.deal.changed', fields: ['a', 'b'], where: { y: 2, x: 1 } },
      ]),
    ]);
    expect(result).toMatchObject({ created: 0, removed: 0, changed: false });
    expect(store.list()[0]!.trigger_id).toBe(firstId);
  });
});

describe('event_triggers store — added columns', () => {
  it('idempotently ALTERs a pre-G6 table (origin / filter / fields) and reads legacy rows cleanly', () => {
    const db = new Database(':memory:');
    // Simulate a pre-G6 table (none of the added columns) with a legacy row.
    db.exec(`
      CREATE TABLE event_triggers (
        trigger_id     TEXT PRIMARY KEY,
        recipe_id      TEXT NOT NULL,
        publisher_id   TEXT NOT NULL,
        pattern        TEXT NOT NULL,
        enabled        INTEGER NOT NULL DEFAULT 1,
        created_at     INTEGER NOT NULL,
        last_fired_at  INTEGER,
        last_error     TEXT,
        config_patch   TEXT
      );
      INSERT INTO event_triggers (trigger_id, recipe_id, publisher_id, pattern, enabled, created_at)
      VALUES ('t-legacy', 'r1', 'p', 'data.mail.**', 1, 1000);
    `);

    const store = createEventTriggersStore(db);
    const legacy = store.get('t-legacy');
    expect(legacy?.origin).toBe('user');
    expect(legacy?.filter).toBeUndefined();
    expect(legacy?.fields).toBeUndefined();

    // Second open over the already-altered table — the pragma guard
    // must skip the ALTERs instead of throwing duplicate-column.
    const store2 = createEventTriggersStore(db);
    expect(store2.count()).toBe(1);
    db.close();
  });

  it('round-trips filter + fields through create / get / listEnabled', () => {
    const db = new Database(':memory:');
    const store = createEventTriggersStore(db);
    store.create({
      trigger_id: 't-f1',
      recipe_id: 'r1',
      publisher_id: 'p',
      pattern: 'data.connection.api.hubspot.deal.**.updated',
      enabled: true,
      created_at: 1,
      origin: 'recipe',
      filter: { 'record.stage': 'negotiation', record_id: 'deal_9' },
      fields: ['stage', 'amount'],
    });
    const row = store.listEnabled()[0]!;
    expect(row.filter).toEqual({ 'record.stage': 'negotiation', record_id: 'deal_9' });
    expect(row.fields).toEqual(['stage', 'amount']);

    // Empty shapes normalize to absent — NULL in the column, no key on
    // the wire row.
    store.create({
      trigger_id: 't-f2',
      recipe_id: 'r1',
      publisher_id: 'p',
      pattern: 'data.mail.**.created',
      enabled: true,
      created_at: 2,
      filter: {},
      fields: [],
    });
    const empty = store.get('t-f2')!;
    expect(empty.filter).toBeUndefined();
    expect(empty.fields).toBeUndefined();
    db.close();
  });
});
