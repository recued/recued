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
 *  closed).
 *
 *  D-319 — one set of rows per DISH: a recipe's declared triggers are made
 *  once for each dish it is switched on as, bound to it and narrowed by its
 *  own template setting; a recipe with no dish has none. Unless a test says
 *  otherwise, each recipe here has one dish, `dsh_<recipe_id>`. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  dishTriggerSettings,
  reconcileDeclarativeTriggers,
  type ReconcilerDish,
  type StoredRecipeRowLike,
} from '../triggers/declarative-reconciler.js';
import { createEventTriggersStore, type EventTriggersStore } from '../triggers/store.js';
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

const dishOf = (recipe_id: string, config_overlay: Record<string, unknown> = {}, dish_id = `dsh_${recipe_id}`): ReconcilerDish =>
  ({ dish_id, recipe_id, config_overlay });

describe('reconcileDeclarativeTriggers', () => {
  let db: Database.Database;
  let store: EventTriggersStore;
  let mintCounter: number;
  /** The dishes the reconcile sees; `null` ⇒ one per recipe it is given. */
  let dishes: ReconcilerDish[] | null;

  beforeEach(() => {
    db = new Database(':memory:');
    store = createEventTriggersStore(db);
    mintCounter = 0;
    dishes = null;
  });

  afterEach(() => {
    db.close();
  });

  const listDishes = (rows: StoredRecipeRowLike[]) => () => dishes ?? rows.map((row) => dishOf(row.recipe_id));

  const reconcile = (rows: StoredRecipeRowLike[]) =>
    reconcileDeclarativeTriggers({
      store,
      listStored: () => rows,
      listDishes: listDishes(rows),
      now: () => 5_000,
      mintTriggerId: () => `t-test-${++mintCounter}`,
    });

  it('materializes declared entries as DISARMED origin:recipe rows of the recipe’s dish (D-179 P5c default-off)', () => {
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
      dish_id: 'dsh_trio-hubspot',
      pattern: 'data.connection.api.hubspot.deal.**.updated',
      // The reconciler never starts anything by itself: switching the dish
      // on does (D-319 § 3.3; owner decision 2026-06-12 for P5c).
      enabled: false,
      origin: 'recipe',
    });
  });

  describe('D-319 — one set of rows per dish', () => {
    const watcher = () => storedRecipe('watcher', [
      { event: 'data.mail.**.created' },
      { event: 'data.mail.**.updated' },
    ]);

    it('a recipe with no dish has no rows: nothing of it is switched on', () => {
      dishes = [];
      expect(reconcile([watcher()])).toMatchObject({ created: 0, changed: false });
      expect(store.list()).toEqual([]);
    });

    it('each dish gets its own copy of every trigger, bound to it; a second dish adds its own, off', () => {
      dishes = [dishOf('watcher', {}, 'dsh_work')];
      reconcile([watcher()]);
      for (const row of store.list()) store.update(row.trigger_id, { enabled: true });

      dishes = [dishOf('watcher', {}, 'dsh_work'), dishOf('watcher', {}, 'dsh_home')];
      expect(reconcile([watcher()])).toMatchObject({ created: 2, removed: 0 });
      expect(store.list().map((row) => [row.dish_id, row.pattern, row.enabled]).sort()).toEqual([
        ['dsh_home', 'data.mail.**.created', false],
        ['dsh_home', 'data.mail.**.updated', false],
        ['dsh_work', 'data.mail.**.created', true],
        ['dsh_work', 'data.mail.**.updated', true],
      ]);
    });

    it('a dish removed takes its rows; the other dish keeps its own, on as they were', () => {
      dishes = [dishOf('watcher', {}, 'dsh_work'), dishOf('watcher', {}, 'dsh_home')];
      reconcile([watcher()]);
      for (const row of store.list()) store.update(row.trigger_id, { enabled: true });
      const work = store.list().filter((row) => row.dish_id === 'dsh_work').map((row) => row.trigger_id).sort();

      dishes = [dishOf('watcher', {}, 'dsh_work')];
      expect(reconcile([watcher()])).toMatchObject({ created: 0, removed: 2 });
      expect(store.list().map((row) => row.trigger_id).sort()).toEqual(work);
      expect(store.list().every((row) => row.enabled)).toBe(true);
    });

    it('⛔ a row made before D-319, with no dish, matches no dish and is removed', () => {
      store.create({
        trigger_id: 't-legacy', recipe_id: 'watcher', publisher_id: 'recued-core', pattern: 'data.mail.**.created',
        enabled: true, created_at: 1, origin: 'recipe',
      });
      reconcile([watcher()]);
      expect(store.get('t-legacy')).toBeNull();
      expect(store.list().every((row) => row.dish_id === 'dsh_watcher' && !row.enabled)).toBe(true);
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
    const rows = [
      { recipe_id: 'bad', publisher_id: 'p', recipe_json: '{nope' },
      storedRecipe('good', [{ event: 'data.connection.api.salesforce.opportunity.**.updated' }]),
    ];
    const result = reconcileDeclarativeTriggers({
      store,
      listStored: () => rows,
      listDishes: listDishes(rows),
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
      listDishes: listDishes(rows),
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
      listDishes: listDishes(rows),
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
    const withDishes = (rows: StoredRecipeRowLike[]) => reconcile(rows);

    /** One armed trigger with a poll interval, as switching its dish on leaves it. */
    const arm = () => {
      const row = store.list()[0]!;
      store.update(row.trigger_id, { enabled: true, watch_interval_ms: 60_000 });
      return row;
    };

    it('a recipe whose ONE trigger changes keeps it armed, on its dish, with its interval', () => {
      withDishes([storedRecipe('notify-visitor', [{ event: 'data.calendar.**.updated' }])]);
      const before = arm();

      const result = withDishes([storedRecipe('notify-visitor', [{ event: 'data.work.booking.item.updated' }])]);
      expect(result).toMatchObject({ created: 1, removed: 1 });
      const after = store.list()[0]!;
      expect(after.trigger_id).not.toBe(before.trigger_id);
      expect(after).toMatchObject({
        pattern: 'data.work.booking.item.updated', enabled: true, dish_id: 'dsh_notify-visitor', watch_interval_ms: 60_000,
      });
    });

    it('D-319 — each dish carries its own row, by the same rule', () => {
      dishes = [dishOf('notify-visitor', {}, 'dsh_a'), dishOf('notify-visitor', {}, 'dsh_b')];
      withDishes([storedRecipe('notify-visitor', [{ event: 'data.calendar.**.updated' }])]);
      const a = store.list().find((row) => row.dish_id === 'dsh_a')!;
      store.update(a.trigger_id, { enabled: true });

      withDishes([storedRecipe('notify-visitor', [{ event: 'data.work.booking.item.updated' }])]);
      expect(store.list().map((row) => [row.dish_id, row.pattern, row.enabled]).sort()).toEqual([
        ['dsh_a', 'data.work.booking.item.updated', true],
        ['dsh_b', 'data.work.booking.item.updated', false],
      ]);
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
      withDishes([storedRecipe('two', [{ event: 'data.mail.**.created' }, { event: 'data.mail.**.updated' }])]);
      for (const row of store.list()) store.update(row.trigger_id, { enabled: true });
      withDishes([storedRecipe('two', [{ event: 'data.mail.**.created' }, { event: 'data.mail.**.deleted' }])]);
      expect(store.list().map((row) => [row.pattern, row.enabled]).sort()).toEqual([
        ['data.mail.**.created', true],
        ['data.mail.**.deleted', false],
      ]);
    });
  });

  describe('D-315 §5.1 — a trigger narrowed to its dish’s template (D-319: per dish)', () => {
    /** The dish's settings: its `mail_template` settings hold template ids. */
    let held: Record<string, string>;
    beforeEach(() => { held = {}; });
    const withTemplates = (rows: StoredRecipeRowLike[]) => {
      dishes = [dishOf('parcels', { ...held })];
      return reconcile(rows);
    };
    const parcels = (triggers: Array<Record<string, unknown>> = [
      { on: 'mail_fact.shipment', fields: ['state'], template_variable: 'template' },
    ]) => storedRecipe('parcels', triggers);

    it('makes no row until the setting holds a template, then one narrowed to it, off', () => {
      expect(withTemplates([parcels()])).toMatchObject({ created: 0, skipped: 1 });
      expect(store.list()).toEqual([]);
      held['template'] = 'mtpl_a';
      expect(withTemplates([parcels()])).toMatchObject({ created: 1 });
      expect(store.list()).toEqual([expect.objectContaining({
        pattern: 'data.mail_fact.shipment.thing.*', filter: { 'record.template': 'mtpl_a' }, fields: ['state'],
        enabled: false, dish_id: 'dsh_parcels',
      })]);
    });

    it('⛔ follows the dish’s pick in place: the same row, on as it was, its history kept', () => {
      held['template'] = 'mtpl_a';
      withTemplates([parcels()]);
      const before = store.list()[0]!;
      store.update(before.trigger_id, { enabled: true, last_fired_at: 4_000 });

      held['template'] = 'mtpl_b';
      expect(withTemplates([parcels()])).toMatchObject({ created: 0, removed: 0, repointed: 1, changed: true });
      expect(store.list()).toEqual([expect.objectContaining({
        trigger_id: before.trigger_id, filter: { 'record.template': 'mtpl_b' }, enabled: true, dish_id: 'dsh_parcels', last_fired_at: 4_000,
      })]);
      // Nothing moved: nothing to do.
      expect(withTemplates([parcels()])).toMatchObject({ repointed: 0, changed: false });
    });

    it('two dishes of one recipe read two templates: each dish’s row narrowed to its own', () => {
      dishes = [dishOf('parcels', { template: 'mtpl_work' }, 'dsh_work'), dishOf('parcels', { template: 'mtpl_home' }, 'dsh_home')];
      reconcile([parcels()]);
      expect(store.list().map((row) => [row.dish_id, row.filter?.['record.template']]).sort()).toEqual([
        ['dsh_home', 'mtpl_home'],
        ['dsh_work', 'mtpl_work'],
      ]);
      // One dish picks another: only its row moves.
      const work = store.list().find((row) => row.dish_id === 'dsh_work')!;
      dishes = [dishOf('parcels', { template: 'mtpl_new' }, 'dsh_work'), dishOf('parcels', { template: 'mtpl_home' }, 'dsh_home')];
      expect(reconcile([parcels()])).toMatchObject({ repointed: 1, created: 0, removed: 0 });
      expect(store.get(work.trigger_id)!.filter).toEqual({ 'record.template': 'mtpl_new' });
    });

    it('keeps the rest of its narrowing', () => {
      held['template'] = 'mtpl_a';
      const narrowed = parcels([{ on: 'mail_fact.shipment', where: { state: 'delivered' }, template_variable: 'template' }]);
      withTemplates([narrowed]);
      held['template'] = 'mtpl_b';
      withTemplates([narrowed]);
      expect(store.list().map((row) => row.filter)).toEqual([{ 'record.state': 'delivered', 'record.template': 'mtpl_b' }]);
    });

    it('re-points the one whose setting moved, beside another that did not', () => {
      held['a'] = 'mtpl_1';
      held['b'] = 'mtpl_2';
      const two = parcels([
        { on: 'mail_fact.shipment', template_variable: 'a' },
        { on: 'mail_fact.shipment', template_variable: 'b' },
      ]);
      withTemplates([two]);
      for (const row of store.list()) store.update(row.trigger_id, { enabled: true });
      const ids = store.list().map((row) => row.trigger_id).sort();
      held['a'] = 'mtpl_3';
      expect(withTemplates([two])).toMatchObject({ repointed: 1, created: 0, removed: 0 });
      expect(store.list().map((row) => row.trigger_id).sort()).toEqual(ids);
      expect(store.list().map((row) => [row.filter?.['record.template'], row.enabled]).sort()).toEqual([
        ['mtpl_2', true],
        ['mtpl_3', true],
      ]);
    });

    it('does not guess when two moved at once: they are made again, off, as any unpaired change', () => {
      held['a'] = 'mtpl_1';
      held['b'] = 'mtpl_2';
      const two = parcels([
        { on: 'mail_fact.shipment', template_variable: 'a' },
        { on: 'mail_fact.shipment', template_variable: 'b' },
      ]);
      withTemplates([two]);
      for (const row of store.list()) store.update(row.trigger_id, { enabled: true });
      held['a'] = 'mtpl_3';
      held['b'] = 'mtpl_4';
      expect(withTemplates([two])).toMatchObject({ repointed: 0, created: 2, removed: 2 });
      expect(store.list().every((row) => !row.enabled)).toBe(true);
    });

    it('removes the row when the setting no longer holds a template', () => {
      held['template'] = 'mtpl_a';
      withTemplates([parcels()]);
      delete held['template'];
      expect(withTemplates([parcels()])).toMatchObject({ removed: 1 });
      expect(store.list()).toEqual([]);
    });
  });

  /** 2026-10-05 — `data.file.{{config.file_slug}}.*.created`: each dish's row
   *  watches the folder its setting names, where `data.file.*.*.created`
   *  started a run for a file in every folder and the recipe stopped the
   *  ones it did not want (each still a run in the history). */
  describe('a pattern part a dish’s setting fills', () => {
    const FOLDER = { file_slug: { label: 'Folder to watch', type: 'file_slug' } };
    const arrivals = (
      event_triggers: Array<Record<string, unknown>> = [{ event: 'data.file.{{config.file_slug}}.*.created' }],
      variables: Record<string, unknown> = FOLDER,
    ): StoredRecipeRowLike => ({
      recipe_id: 'arrivals',
      publisher_id: 'recued-core',
      recipe_json: JSON.stringify({ recipe_id: 'arrivals', version: 1, variables, event_triggers }),
    });
    const patterns = () => store.list().map((row) => [row.dish_id, row.pattern, row.enabled]).sort();

    it('each dish gets a row for its own folder, off; a dish with none chosen gets none', () => {
      dishes = [
        dishOf('arrivals', { file_slug: 'scans' }, 'dsh_scans'),
        dishOf('arrivals', { file_slug: 'invoices' }, 'dsh_invoices'),
        dishOf('arrivals', {}, 'dsh_unset'),
      ];
      expect(reconcile([arrivals()])).toMatchObject({ created: 2, skipped: 1 });
      expect(patterns()).toEqual([
        ['dsh_invoices', 'data.file.invoices.*.created', false],
        ['dsh_scans', 'data.file.scans.*.created', false],
      ]);
    });

    it('a dish that keeps the recipe’s default watches the default, as its runs read it', () => {
      dishes = [dishOf('arrivals', {})];
      reconcile([arrivals(undefined, { file_slug: { label: 'Folder to watch', type: 'file_slug', default: 'inbox' } })]);
      expect(patterns()).toEqual([['dsh_arrivals', 'data.file.inbox.*.created', false]]);
      // A primitive default is a default too (`extractVariableDefault`).
      store.remove(store.list()[0]!.trigger_id);
      reconcile([arrivals(undefined, { file_slug: 'outbox' })]);
      expect(patterns()).toEqual([['dsh_arrivals', 'data.file.outbox.*.created', false]]);
    });

    it.each([
      ['a wildcard, which would watch every folder', '*'],
      ['a value with a dot, which would shift the parts', 'a.b'],
      ['an empty value', ''],
      ['a value that is not text', 42],
    ])('⛔ %s makes no row', (_label, value) => {
      dishes = [dishOf('arrivals', { file_slug: value })];
      expect(reconcile([arrivals()])).toMatchObject({ created: 0, skipped: 1 });
      expect(store.list()).toEqual([]);
    });

    it('⛔ follows the dish’s pick in place: the same row, on as it was, its history kept', () => {
      dishes = [dishOf('arrivals', { file_slug: 'scans' })];
      reconcile([arrivals()]);
      const before = store.list()[0]!;
      store.update(before.trigger_id, { enabled: true, last_fired_at: 4_000 });

      dishes = [dishOf('arrivals', { file_slug: 'invoices' })];
      expect(reconcile([arrivals()])).toMatchObject({ created: 0, removed: 0, repointed: 1, changed: true });
      expect(store.list()).toEqual([expect.objectContaining({
        trigger_id: before.trigger_id, pattern: 'data.file.invoices.*.created', enabled: true, last_fired_at: 4_000,
      })]);
      expect(reconcile([arrivals()])).toMatchObject({ repointed: 0, changed: false });
    });

    /** Where D-296's carry cannot pair (a dish with two rows), the follow
     *  still keeps each row on. */
    it('two triggers on one setting: both rows follow the pick, on', () => {
      const both = arrivals([
        { event: 'data.file.{{config.file_slug}}.*.created' },
        { event: 'data.file.{{config.file_slug}}.*.updated' },
      ]);
      dishes = [dishOf('arrivals', { file_slug: 'scans' })];
      reconcile([both]);
      for (const row of store.list()) store.update(row.trigger_id, { enabled: true });
      const ids = store.list().map((row) => row.trigger_id).sort();

      dishes = [dishOf('arrivals', { file_slug: 'invoices' })];
      expect(reconcile([both])).toMatchObject({ repointed: 2, created: 0, removed: 0 });
      expect(store.list().map((row) => row.trigger_id).sort()).toEqual(ids);
      expect(patterns()).toEqual([
        ['dsh_arrivals', 'data.file.invoices.*.created', true],
        ['dsh_arrivals', 'data.file.invoices.*.updated', true],
      ]);
    });

    it('an update that narrows a `*` to the setting keeps the dish’s row, on', () => {
      dishes = [dishOf('arrivals', { file_slug: 'scans' })];
      reconcile([arrivals([{ event: 'data.file.*.*.created' }, { event: 'data.file.*.*.deleted' }])]);
      for (const row of store.list()) store.update(row.trigger_id, { enabled: true });
      const created = store.list().find((row) => row.pattern.endsWith('.created'))!;

      expect(reconcile([arrivals([
        { event: 'data.file.{{config.file_slug}}.*.created' },
        { event: 'data.file.*.*.deleted' },
      ])])).toMatchObject({ repointed: 1, created: 0, removed: 0 });
      expect(store.get(created.trigger_id)).toMatchObject({ pattern: 'data.file.scans.*.created', enabled: true });
    });

    it('the row goes when the dish’s folder is cleared', () => {
      dishes = [dishOf('arrivals', { file_slug: 'scans' })];
      reconcile([arrivals()]);
      dishes = [dishOf('arrivals', { file_slug: '' })];
      expect(reconcile([arrivals()])).toMatchObject({ removed: 1 });
      expect(store.list()).toEqual([]);
    });
  });

  it('a dish reads its group’s settings under its own (`dishTriggerSettings`)', () => {
    const groups: Record<string, Record<string, unknown>> = { g_work: { file_slug: 'scans', channels: ['slack'] } };
    const grouped = { ...dishOf('arrivals', { channels: ['in_app'] }), group_id: 'g_work' };
    expect(dishTriggerSettings(grouped, (id) => groups[id]).config_overlay).toEqual({ file_slug: 'scans', channels: ['in_app'] });
    const alone = dishOf('arrivals', { file_slug: 'invoices' });
    expect(dishTriggerSettings(alone, (id) => groups[id])).toBe(alone);
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
