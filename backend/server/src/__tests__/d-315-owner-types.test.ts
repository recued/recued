/** D-315 §4.5 — kinds of email the owner makes: saved through the rpc, checked
 *  on their own and against every other kind, grown but never cut, deleted only
 *  once no template reads them — and then read, stored and subscribed to like a
 *  built-in one, on this server. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAIL_FACT_EVENT_PATTERN, recipeEventTriggerNotes, type MailFactTypeSpec, type MailTemplateDefinition } from '@recued/contracts';
import { createWarehouseEventBus, type WarehouseEvent } from '@recued/warehouse-events';

import { createMailFactWriter } from '../mail-facts/fact-writer.js';
import { makeMailFactRpcHandlers } from '../mail-facts/mail-fact-rpc-handler.js';
import type { MailFactSourceEmail } from '../mail-facts/rules-pass.js';
import { createMailFactStore, type MailFactStore } from '../storage/mail-fact-store.js';
import { createEventTriggerDispatcher } from '../triggers/dispatcher.js';
import { handleTriggersCreate, switchOffUserTriggers } from '../triggers/handler.js';
import { createEventTriggersStore } from '../triggers/store.js';
import type { WsClient } from '../ws-server.js';

const owner = { instance_id: 'webclient-1', client_kind: 'webclient' } as WsClient;

let db: Database.Database;
let store: MailFactStore;
let templatesChanged: ReturnType<typeof vi.fn<() => void>>;
let factsChanged: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  db = new Database(':memory:');
  store = createMailFactStore(db);
  templatesChanged = vi.fn<() => void>();
  factsChanged = vi.fn<() => void>();
});

afterEach(() => db.close());

const rpc = () => makeMailFactRpcHandlers({
  store,
  onTemplatesChanged: templatesChanged,
  onFactsChanged: factsChanged,
})!.handlers;

const wine = (over: Partial<MailFactTypeSpec> = {}): MailFactTypeSpec => ({
  id: 'custom_wine_club',
  name: 'Wine club box',
  description: 'A box from the wine club.',
  variables: [
    { name: 'club', kind: 'text', required: true },
    { name: 'box_id', kind: 'id', required: true },
    { name: 'colour', kind: 'enum', required: false, values: ['red', 'white'] },
  ],
  states: ['shipped', 'delivered'],
  notices: [],
  identity: [['club', 'box_id']],
  ...over,
});

describe('making a kind of email', () => {
  it('saves it on this server, keeping only what a type has', async () => {
    const { type } = await rpc()['mail_fact.type.create']({ spec: { ...wine(), smuggled: 'x' } as never }, owner);
    expect(type).toEqual(wine());
    expect((await rpc()['mail_fact.type.list'](undefined, owner)).types).toEqual([wine()]);
    expect(templatesChanged).toHaveBeenCalled();
  });

  it('refuses one with problems, one already made, and a name another kind has', async () => {
    await expect(rpc()['mail_fact.type.create']({ spec: wine({ variables: [] }) }, owner))
      .rejects.toMatchObject({ code: 'bad_request', details: { problems: expect.arrayContaining(['a kind of email needs at least one variable']) } });
    await rpc()['mail_fact.type.create']({ spec: wine() }, owner);
    await expect(rpc()['mail_fact.type.create']({ spec: wine({ name: 'Another' }) }, owner))
      .rejects.toMatchObject({ code: 'conflict' });
    await expect(rpc()['mail_fact.type.create']({ spec: wine({ id: 'custom_parcels', name: 'shipment ' }) }, owner))
      .rejects.toMatchObject({ code: 'conflict', message: 'A kind of email is already called “Shipment”.' });
    await expect(rpc()['mail_fact.type.create']({ spec: wine({ id: 'custom_boxes', name: 'WINE CLUB BOX' }) }, owner))
      .rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('an account reference in a kind of email (§3.1)', () => {
  it('is refused as anything but text: it holds an account’s last four characters', async () => {
    const withAccount = (kind: 'number' | 'text') => wine({
      variables: [...wine().variables, { name: 'account_ref', kind, required: false }],
    });
    await expect(rpc()['mail_fact.type.create']({ spec: withAccount('number') }, owner))
      .rejects.toMatchObject({ code: 'bad_request', details: { problems: [expect.stringMatching(/'account_ref' holds an account's last four characters: it is text/)] } });
    await expect(rpc()['mail_fact.type.create']({ spec: withAccount('text') }, owner)).resolves.toMatchObject({ type: { id: 'custom_wine_club' } });
  });
});

describe('a kind sent in the wrong shape', () => {
  it('is refused with each wrong entry named, never saved without it', async () => {
    await expect(rpc()['mail_fact.type.create']({
      spec: {
        ...wine(),
        variables: [...wine().variables, 'b', null, 5, { name: 'x', kind: 'text' }],
        states: ['shipped', 3, null],
        identity: [['club', 'box_id'], [], 7],
      } as never,
    }, owner)).rejects.toMatchObject({
      code: 'bad_request',
      details: {
        problems: expect.arrayContaining([
          'variables[3] must have a name, a kind and whether it is needed',
          'variables[6] must have a name, a kind and whether it is needed',
          'states[1] must be a word',
          'identity[1] must name at least one variable',
          'identity[2] must be a list',
        ]),
      },
    });
    expect(store.listCustomTypes()).toEqual([]);
  });
});

describe('changing one', () => {
  it('lets it grow, and refuses a cut', async () => {
    await rpc()['mail_fact.type.create']({ spec: wine() }, owner);
    const grown = wine({
      variables: [...wine().variables.slice(0, 2), { name: 'colour', kind: 'enum', required: false, values: ['red', 'white', 'rose'] }],
      states: ['shipped', 'delivered', 'returned'],
    });
    expect((await rpc()['mail_fact.type.update']({ spec: grown }, owner)).type).toEqual(grown);
    await expect(rpc()['mail_fact.type.update']({ spec: wine({ variables: wine().variables.slice(0, 2) }) }, owner))
      .rejects.toMatchObject({ code: 'bad_request', message: expect.stringContaining("variable 'colour' cannot be removed") });
    await expect(rpc()['mail_fact.type.update']({ spec: wine({ id: 'custom_nope' }) }, owner))
      .rejects.toMatchObject({ code: 'not_found' });
  });

  it('reads its mail again with what it grew: a backfill after a value is added takes it', async () => {
    await rpc()['mail_fact.type.create']({ spec: wine() }, owner);
    const { template } = await rpc()['mail_fact.template.create']({
      definition: {
        name: 'The club', type: 'custom_wine_club',
        entrance: { conditions: [{ field: 'from', op: 'is', value: 'boxes@club.example' }], variables: ['club', 'box_id'] },
        rules: [
          { target: { variable: 'club' }, source: 'from_name', find: { kind: 'whole' } },
          { target: { variable: 'box_id' }, source: 'body', find: { kind: 'after_label', label: 'Box:' } },
          { target: { variable: 'colour' }, source: 'body', find: { kind: 'after_label', label: 'Colour:' } },
        ],
        html: false, ai: { enabled: false },
      },
    }, owner);
    const writer = createMailFactWriter({ store, now: () => 1_000, emit: () => {} });
    const ref = { slug: 'work', record_id: 'mail:1' };
    const box: MailFactSourceEmail = {
      subject: 'Your box', body_text: 'Box: B-1\nColour: rose\n', html: null, from_address: 'boxes@club.example',
      from_name: 'The club', headers: {}, labels: ['INBOX'], relationships: [], attachments: [],
    };
    // As a backfill reads it: the same email, again.
    const backfill = (): void => {
      writer.write({
        ref, email: box, email_at: 900, content_fingerprint: 'box-1', may_trigger: false, count_health: true,
        force: true, backfill_template: template.template_id,
      });
    };
    backfill();
    // 'rose' is not one of its values yet.
    expect(store.factsForEmail(ref)[0]!.variables.colour).toBeNull();
    const before = store.factRecordsForEmail(ref)[0]!.source_hash;

    // Renamed: nothing it reads changed, and a reading stays — the AI's answers
    // with it, where it asked the AI.
    await rpc()['mail_fact.type.update']({ spec: wine({ name: 'Wine club delivery', description: 'A delivery.' }) }, owner);
    backfill();
    expect(store.factRecordsForEmail(ref)[0]!.source_hash).toBe(before);

    await rpc()['mail_fact.type.update']({
      spec: wine({
        name: 'Wine club delivery', description: 'A delivery.',
        variables: [...wine().variables.slice(0, 2), { name: 'colour', kind: 'enum', required: false, values: ['red', 'white', 'rose'] }],
      }),
    }, owner);
    backfill();
    expect(store.factsForEmail(ref)[0]!.variables.colour).toBe('rose');
  });
});

describe('a kind saved before a name was reserved', () => {
  it('can still be changed: the name it had stays, and none new may take one', async () => {
    const before = wine({
      variables: [...wine().variables, { name: 'last_email_at', kind: 'text', required: false }],
    });
    store.saveCustomType(before);
    const grown = { ...before, states: [...before.states, 'returned'] };
    expect((await rpc()['mail_fact.type.update']({ spec: grown }, owner)).type).toEqual(grown);
    await expect(rpc()['mail_fact.type.update']({
      spec: { ...grown, variables: [...grown.variables, { name: 'thing_id', kind: 'text', required: false }] },
    }, owner)).rejects.toMatchObject({ code: 'bad_request', message: expect.stringContaining("'thing_id' is a reserved name") });
  });
});

describe('what tells one thing from another, sent in another order', () => {
  it('is kept as saved: the same order still joins the thing it joined', async () => {
    await rpc()['mail_fact.type.create']({ spec: wine() }, owner);
    await rpc()['mail_fact.template.create']({
      definition: {
        name: 'The club', type: 'custom_wine_club',
        entrance: { conditions: [{ field: 'from', op: 'is', value: 'boxes@club.example' }], variables: ['club', 'box_id'] },
        rules: [
          { target: { variable: 'club' }, source: 'from_name', find: { kind: 'whole' } },
          { target: { variable: 'box_id' }, source: 'body', find: { kind: 'after_label', label: 'Box:' } },
        ],
        html: false, ai: { enabled: false },
      },
    }, owner);
    const writer = createMailFactWriter({ store, emit: () => {}, now: () => 5 });
    const box = (record_id: string, at: number) => writer.write({
      ref: { slug: 'work', record_id },
      email: { subject: 'Your box', body_text: 'Box: WB-1204', html: null, from_address: 'boxes@club.example', from_name: 'The Wine Club',
        headers: {}, labels: [], relationships: [], attachments: [] },
      email_at: at, content_fingerprint: record_id, may_trigger: true, count_health: true,
    });
    box('mail:1', 1);
    // The same identity, its variables named in the other order: no change.
    const { type } = await rpc()['mail_fact.type.update']({ spec: wine({ identity: [['box_id', 'club']] }) }, owner);
    expect(type.identity).toEqual([['club', 'box_id']]);
    box('mail:2', 2);
    expect(store.listThings()).toHaveLength(1);
  });
});

describe('a number that tells one thing from another', () => {
  it('keeps 1.25, 125 and -125 apart', async () => {
    await rpc()['mail_fact.type.create']({
      spec: wine({ variables: [{ name: 'club', kind: 'text', required: true }, { name: 'lot', kind: 'number', required: true }], identity: [['club', 'lot']] }),
    }, owner);
    await rpc()['mail_fact.template.create']({
      definition: {
        name: 'Lots', type: 'custom_wine_club',
        entrance: { conditions: [{ field: 'from', op: 'is', value: 'boxes@club.example' }], variables: ['club', 'lot'] },
        rules: [
          { target: { variable: 'club' }, source: 'from_name', find: { kind: 'whole' } },
          { target: { variable: 'lot' }, source: 'body', find: { kind: 'after_label', label: 'Lot:' } },
        ],
        html: false,
        ai: { enabled: false },
      },
    }, owner);
    const writer = createMailFactWriter({ store, emit: () => {}, now: () => 5 });
    for (const [i, lot] of ['1.25', '125', '-125'].entries()) {
      writer.write({
        ref: { slug: 'work', record_id: `mail:${i}` },
        email: {
          subject: 'Your lot', body_text: `Lot: ${lot}`, html: null, from_address: 'boxes@club.example', from_name: 'The Wine Club',
          headers: {}, labels: [], relationships: [], attachments: [],
        },
        email_at: 1 + i, content_fingerprint: `c${i}`, may_trigger: true, count_health: true,
      });
    }
    expect(store.listThings().map((thing) => thing.variables.lot).sort()).toEqual([-125, 1.25, 125]);
  });
});

describe('deleting one', () => {
  const template: MailTemplateDefinition = {
    name: 'The club',
    type: 'custom_wine_club',
    entrance: { conditions: [{ field: 'from', op: 'is', value: 'boxes@club.example' }], variables: ['club', 'box_id'] },
    rules: [
      { target: { variable: 'club' }, source: 'from_name', find: { kind: 'whole' } },
      { target: { variable: 'box_id' }, source: 'body', find: { kind: 'after_label', label: 'Box:' } },
      { target: { variable: 'state' }, source: 'subject', find: { kind: 'keyword_map', cases: [{ contains: 'shipped', value: 'shipped' }] } },
    ],
    html: false,
    ai: { enabled: false },
  };
  const email: MailFactSourceEmail = {
    subject: 'Your box has shipped', body_text: 'Box: WB-1204', html: null,
    from_address: 'boxes@club.example', from_name: 'The Wine Club', headers: {}, labels: [], relationships: [], attachments: [],
  };

  it('is refused while a template reads it; then its facts and things go with it', async () => {
    await rpc()['mail_fact.type.create']({ spec: wine() }, owner);
    const { template: made } = await rpc()['mail_fact.template.create']({ definition: template }, owner);
    const events: WarehouseEvent[] = [];
    const writer = createMailFactWriter({ store, emit: (event) => events.push(event), now: () => 5 });
    writer.write({
      ref: { slug: 'work', record_id: 'mail:1' }, email, email_at: 1, content_fingerprint: 'c', may_trigger: true, count_health: true,
    });
    // Read, stored and announced like a built-in kind.
    expect(store.listFacts()).toEqual([expect.objectContaining({ type: 'custom_wine_club', variables: expect.objectContaining({ box_id: 'WB-1204', state: 'shipped' }) })]);
    expect(events).toEqual([expect.objectContaining({ platform: 'mail_fact', slug: 'custom_wine_club', event_kind: 'created' })]);

    await expect(rpc()['mail_fact.type.delete']({ type_id: 'custom_wine_club' }, owner))
      .rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('“The club”') });
    await rpc()['mail_fact.template.delete']({ template_id: made.template_id }, owner);
    expect(await rpc()['mail_fact.type.delete']({ type_id: 'custom_wine_club' }, owner)).toEqual({ deleted: true });
    expect(store.listFacts()).toEqual([]);
    expect(store.listThings()).toEqual([]);
    expect(store.listCustomTypes()).toEqual([]);
    expect(factsChanged).toHaveBeenCalled();
  });
});

describe('deleting what a trigger is narrowed to (§5.1)', () => {
  it('switches off the rows made here that could never fire again, and leaves a recipe’s own', async () => {
    store.saveCustomType(wine());
    const triggers = createEventTriggersStore(db);
    let ids = 0;
    const deps = { store: triggers, genId: () => `t-${(ids += 1)}`, now: () => 1, mailFactTypes: () => store.listCustomTypes() };
    const handlers = makeMailFactRpcHandlers({
      store,
      switchOffTriggers: (match) => switchOffUserTriggers(deps, match),
    })!.handlers;
    const { template } = await handlers['mail_fact.template.create']({
      definition: {
        name: 'The club', type: 'custom_wine_club',
        entrance: { conditions: [{ field: 'from', op: 'is', value: 'boxes@club.example' }], variables: ['club', 'box_id'] },
        rules: [
          { target: { variable: 'club' }, source: 'from_name', find: { kind: 'whole' } },
          { target: { variable: 'box_id' }, source: 'body', find: { kind: 'after_label', label: 'Box:' } },
        ],
        html: false, ai: { enabled: false },
      },
    }, owner);
    const narrowed = (await handleTriggersCreate(deps, {
      recipe_id: 'r-1', publisher_id: 'local', on: 'mail_fact', where: { template: template.template_id },
    })).trigger;
    const onKind = (await handleTriggersCreate(deps, { recipe_id: 'r-1', publisher_id: 'local', on: 'mail_fact.custom_wine_club' })).trigger;
    const anyKind = (await handleTriggersCreate(deps, { recipe_id: 'r-1', publisher_id: 'local', on: 'mail_fact', fields: ['state'] })).trigger;
    const recipeRow = triggers.create({
      trigger_id: 'recipe-1', recipe_id: 'r-2', publisher_id: 'p', pattern: MAIL_FACT_EVENT_PATTERN.replace('*', 'custom_wine_club'),
      enabled: true, created_at: 1, origin: 'recipe',
    } as never);

    await handlers['mail_fact.template.delete']({ template_id: template.template_id }, owner);
    expect(triggers.get(narrowed.trigger_id)?.enabled).toBe(false);
    expect(triggers.get(onKind.trigger_id)?.enabled).toBe(true);

    await handlers['mail_fact.type.delete']({ type_id: 'custom_wine_club' }, owner);
    expect(triggers.get(onKind.trigger_id)?.enabled).toBe(false);
    expect(triggers.get(anyKind.trigger_id)?.enabled).toBe(true);
    expect(triggers.get(recipeRow.trigger_id)?.enabled).toBe(true);
  });
});

describe('subscribing to one (§5.1)', () => {
  it('is watched by its variables, not its kind: a row made here is checked against it, a recipe only told', async () => {
    store.saveCustomType(wine());
    const triggers = createEventTriggersStore(db);
    let ids = 0;
    const deps = { store: triggers, genId: () => `t-${(ids += 1)}`, now: () => 1, mailFactTypes: () => store.listCustomTypes() };
    const { trigger } = await handleTriggersCreate(deps, {
      recipe_id: 'r-1', publisher_id: 'local', on: 'mail_fact', fields: ['state'], where: { colour: 'white' },
    });
    expect(trigger).toMatchObject({ pattern: MAIL_FACT_EVENT_PATTERN, filter: { 'record.colour': 'white' }, fields: ['state'] });
    await expect(handleTriggersCreate(deps, { recipe_id: 'r-1', publisher_id: 'local', on: 'mail_fact', where: { colour: 'rose' } }))
      .rejects.toMatchObject({ code: 'bad_request', details: { problems: ["'where.colour': no kind of email on this server has the colour 'rose'"] } });
    // A recipe's own trigger may watch it too; its check, which knows no
    // owner's kinds, notes that only a kind made on a server has it.
    expect(recipeEventTriggerNotes({ on: 'mail_fact', where: { colour: 'white' } })).toEqual([
      "'where.colour': no built-in kind of email has a variable 'colour' — only a kind made on the owner’s server can start it",
    ]);

    // It fires on the kind's own events.
    const bus = createWarehouseEventBus();
    const runRecipe = vi.fn().mockResolvedValue({ run_id: 'run-1' });
    const dispatcher = createEventTriggerDispatcher({ bus, store: triggers, runtime: { runRecipe }, now: () => 2 } as never);
    dispatcher.rebuild();
    bus.emit({
      platform: 'mail_fact', slug: 'custom_wine_club', entity_type: 'thing', event_kind: 'updated',
      record_id: 'thing-1', at: 1, record: { state: 'delivered', colour: 'white' }, changed_fields: ['state'],
    });
    await dispatcher.drained();
    expect(runRecipe).toHaveBeenCalledTimes(1);
    expect(runRecipe.mock.calls[0]?.[0]).toMatchObject({ trigger_id: trigger.trigger_id });
  });
});
