/** D-315 §5.1 — Automation's and Kitchen's "A mail fact" row: `triggers.create`
 *  and `triggers.update` take the shorthand a recipe declares (`on`, `fields`,
 *  `where`), validated and compiled as the reconciler compiles a recipe's, so
 *  the row filters exactly as a recipe's would. */

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MAIL_FACT_EVENT_PATTERN, type MailFactTypeSpec } from '@recued/contracts';
import { createWarehouseEventBus } from '@recued/warehouse-events';

import { createEventTriggerDispatcher } from '../triggers/dispatcher.js';
import { handleTriggersCreate, handleTriggersUpdate } from '../triggers/handler.js';
import { createEventTriggersStore, type EventTriggersStore } from '../triggers/store.js';

let db: Database.Database;
let store: EventTriggersStore;
let ids: number;
let owned: MailFactTypeSpec[];

beforeEach(() => {
  db = new Database(':memory:');
  store = createEventTriggersStore(db);
  ids = 0;
  owned = [];
});

// As the server composes it: the rows made here know every kind of email a
// fact here can have, the owner's included (none made yet).
const deps = () => ({ store, genId: () => `t-${(ids += 1)}`, now: () => 1_000, mailFactTypes: () => owned });

const create = (args: Record<string, unknown>) =>
  handleTriggersCreate(deps(), { recipe_id: 'r-1', publisher_id: 'local', ...args });

const dispatch = () => {
  const bus = createWarehouseEventBus();
  const runRecipe = vi.fn().mockResolvedValue({ run_id: 'run-1' });
  const dispatcher = createEventTriggerDispatcher({ bus, store, runtime: { runRecipe }, now: () => 2_000 } as never);
  dispatcher.rebuild();
  // An update, as the writer sends one: the thing before it, in `prev`.
  const emit = (slug: string, record: Record<string, unknown>, changed: string[]) => bus.emit({
    platform: 'mail_fact', slug, entity_type: 'thing', event_kind: 'updated',
    record_id: `thing-${ids += 1}`, at: 1, record, prev: { ...record }, changed_fields: changed,
  });
  return { dispatcher, runRecipe, emit };
};

describe('triggers.create with the shorthand', () => {
  it('makes the row a recipe’s declaration would: pattern, strict filter, changed-fields gate', async () => {
    const { trigger } = await create({ on: 'mail_fact', fields: ['state'], where: { state: 'delivered' } });
    expect(trigger).toMatchObject({
      pattern: MAIL_FACT_EVENT_PATTERN,
      filter: { 'record.state': 'delivered' },
      fields: ['state'],
      enabled: true,
      origin: 'user',
    });
  });

  it('refuses what could never match, with every problem — this server knows every kind', async () => {
    await expect(create({ on: 'mail_fact', where: { state: 'Delivered' } }))
      .rejects.toMatchObject({ code: 'bad_request', details: { problems: [expect.stringContaining("'where.state' must be a state")] } });
    await expect(create({ on: 'mail_fact', where: { items: 'x' } })).rejects.toMatchObject({
      code: 'bad_request',
      details: { problems: ["'where.items': no kind of email on this server has a variable 'items'"] },
    });
    await expect(create({ on: 'mail_fact.parcel' })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(create({ on: 'mail_fact.shipment', where: { state: 'overdue' } })).rejects.toMatchObject({
      code: 'bad_request',
      details: { problems: ["'where.state' must be one of label_created, in_transit, out_for_delivery, delivered, exception, returned"] },
    });
  });

  it('makes a row on one kind: its pattern names the kind (ruling 43)', async () => {
    const { trigger } = await create({ on: 'mail_fact.shipment', fields: ['state'], where: { state: 'delivered' } });
    expect(trigger).toMatchObject({
      pattern: 'data.mail_fact.shipment.thing.*', filter: { 'record.state': 'delivered' }, fields: ['state'],
    });
  });

  it('takes `on` or `pattern`, not both, and no narrowing without `on`', async () => {
    await expect(create({ on: 'mail_fact', pattern: 'data.mail.*.message.created' }))
      .rejects.toMatchObject({ code: 'bad_request' });
    await expect(create({ pattern: 'data.mail.*.message.created', fields: ['subject'] }))
      .rejects.toMatchObject({ code: 'bad_request' });
  });

  it('refuses a shorthand that fans out to more than one event', async () => {
    // A CRM alias names one row per vendor; only a recipe's reconcile keeps them in step.
    await expect(create({ on: 'deal.changed' })).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('filters at dispatch like a recipe’s row: a delivered thing of any kind wakes it', async () => {
    const { trigger } = await create({ on: 'mail_fact', fields: ['state'], where: { state: 'delivered' } });
    const { dispatcher, runRecipe, emit } = dispatch();
    emit('shipment', { state: 'in_transit' }, ['state']);
    emit('shipment', { state: 'delivered' }, ['carrier']);
    emit('shipment', { state: 'delivered' }, ['state']);
    // A kind the owner made, with a delivered state of its own.
    emit('custom_wine_club', { state: 'delivered', club: 'The Club' }, ['state']);
    await dispatcher.drained();
    expect(runRecipe).toHaveBeenCalledTimes(2);
    expect(runRecipe.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ trigger_id: trigger.trigger_id }),
      expect.objectContaining({ trigger_id: trigger.trigger_id }),
    ]);
  });

  it('wakes on a repeat email only a row that asked for every email (ruling 44)', async () => {
    const everyChange = await create({ on: 'mail_fact.shipment' });
    const stateChanges = await create({ on: 'mail_fact.shipment', fields: ['state'] });
    const everyEmail = await create({ on: 'mail_fact.shipment', fields: ['last_email_at'] });
    const { dispatcher, runRecipe, emit } = dispatch();
    // A carrier's "still in transit": nothing but the time changed.
    emit('shipment', { state: 'in_transit', last_email_at: 2_000 }, ['last_email_at']);
    await dispatcher.drained();
    expect(runRecipe.mock.calls.map((call) => call[0].trigger_id)).toEqual([everyEmail.trigger.trigger_id]);
    // The delivery changes the state too: a change for every row.
    emit('shipment', { state: 'delivered', last_email_at: 3_000 }, ['state', 'last_email_at']);
    await dispatcher.drained();
    expect(runRecipe.mock.calls.slice(1).map((call) => call[0].trigger_id).sort()).toEqual(
      [everyChange.trigger.trigger_id, stateChanges.trigger.trigger_id, everyEmail.trigger.trigger_id].sort(),
    );
  });

  it('is not woken by a thing whose kind lacks what it filters on', async () => {
    // A shipment has no notice. Were a missing path passed, as it is for a
    // doorbell event, every shipment would wake a reminder's recipe.
    await create({ on: 'mail_fact', where: { notice: 'reminder' } });
    const { dispatcher, runRecipe, emit } = dispatch();
    emit('shipment', { state: 'delivered', carrier: 'UPS' }, ['state']);
    emit('bill', { state: 'issued', notice: null }, ['state']);
    emit('bill', { state: 'overdue', notice: 'reminder' }, ['notice']);
    await dispatcher.drained();
    expect(runRecipe).toHaveBeenCalledTimes(1);
  });
});

describe('triggers.update with the shorthand', () => {
  it('re-narrows a row, and a bare pattern change drops the filter compiled for the old one', async () => {
    const { trigger } = await create({ on: 'mail_fact', where: { state: 'delivered' } });
    const renarrowed = (await handleTriggersUpdate(deps(), {
      trigger_id: trigger.trigger_id, on: 'mail_fact', fields: ['notice'], where: { notice: 'reminder' },
    })).trigger;
    expect(renarrowed).toMatchObject({
      pattern: MAIL_FACT_EVENT_PATTERN, filter: { 'record.notice': 'reminder' }, fields: ['notice'],
    });
    const bare = (await handleTriggersUpdate(deps(), { trigger_id: trigger.trigger_id, pattern: 'data.mail.*.message.created' })).trigger;
    expect(bare.pattern).toBe('data.mail.*.message.created');
    expect(bare.filter).toBeUndefined();
    expect(bare.fields).toBeUndefined();
  });

  it('leaves a recipe’s row to its recipe', async () => {
    store.create({
      trigger_id: 't-recipe', recipe_id: 'r-1', publisher_id: 'local', origin: 'recipe',
      pattern: MAIL_FACT_EVENT_PATTERN, enabled: false, created_at: 1,
      filter: { 'record.state': 'delivered' }, fields: ['state'],
    });
    await expect(handleTriggersUpdate(deps(), { trigger_id: 't-recipe', on: 'mail_fact', where: { notice: 'reminder' } }))
      .rejects.toMatchObject({ code: 'bad_request' });
    // A bare pattern edit keeps the reconciler's filter, as it always has.
    const kept = (await handleTriggersUpdate(deps(), { trigger_id: 't-recipe', pattern: MAIL_FACT_EVENT_PATTERN })).trigger;
    expect(kept.filter).toEqual({ 'record.state': 'delivered' });
  });
});
