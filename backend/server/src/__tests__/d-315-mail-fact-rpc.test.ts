/** D-315 slice 1 — the owner's mail templates over rpc (§4, §6.1, ruling 31). */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MailTemplateDefinition } from '@recued/contracts';

import { createMailFactWriter } from '../mail-facts/fact-writer.js';
import { makeMailFactRpcHandlers } from '../mail-facts/mail-fact-rpc-handler.js';
import { createMailFactStore, type MailFactStore } from '../storage/mail-fact-store.js';
import type { WsClient } from '../ws-server.js';

let dir: string;
let db: Database.Database;
let store: MailFactStore;
let rpc: NonNullable<ReturnType<typeof makeMailFactRpcHandlers>>['handlers'];

const owner = { instance_id: 'webclient-1', client_kind: 'webclient' } as WsClient;
const stranger = {} as WsClient;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-315-template-rpc-'));
  db = new Database(join(dir, 'test.db'));
  store = createMailFactStore(db);
  rpc = makeMailFactRpcHandlers({ store })!.handlers;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const ups = (over: Partial<MailTemplateDefinition> = {}): MailTemplateDefinition => ({
  name: 'UPS',
  type: 'shipment',
  entrance: {
    conditions: [
      { field: 'from', op: 'domain_is', value: 'ups.com' },
      { field: 'subject', op: 'contains', value: 'UPS Update' },
    ],
    variables: ['tracking_number'],
  },
  rules: [
    { target: { variable: 'carrier' }, source: 'from_name', find: { kind: 'constant', value: 'UPS' } },
    { target: { variable: 'tracking_number' }, source: 'body', find: { kind: 'after_label', label: 'Tracking Number:' } },
  ],
  html: false,
  ai: { enabled: false },
  ...over,
});

describe('who may call', () => {
  it('only the owner’s paired webclient: never a stranger, a Bridge or the CLI', async () => {
    const bridge = { instance_id: 'bridge-1', client_kind: 'bridge' } as WsClient;
    const cli = { instance_id: 'cli-1', client_kind: 'cli' } as WsClient;
    for (const client of [stranger, bridge, cli]) {
      await expect(rpc['mail_fact.template.list'](undefined, client)).rejects.toMatchObject({ code: 'unauthorized' });
      await expect(rpc['mail_fact.template.create']({ definition: ups() }, client)).rejects.toMatchObject({
        code: 'unauthorized',
      });
    }
    await expect(rpc['mail_fact.template.list'](undefined, owner)).resolves.toMatchObject({ templates: [] });
  });
});

describe('a definition of the wrong shape', () => {
  it('is refused with its problems listed, never a thrown TypeError', async () => {
    const shapes: Record<string, unknown>[] = [
      { entrance: { conditions: [null], variables: [] } },
      { entrance: { conditions: [{ field: '__proto__', op: 'is', value: 'x' }], variables: [] } },
      { entrance: { conditions: [{ field: 'constructor', op: 'is', value: 'x' }], variables: [] } },
      { rules: {} },
      { rules: [null] },
      { rules: [{ target: { variable: 'x' }, source: 'body', find: null }] },
      { ai: { enabled: true, prompt: 'p', pool: 'free_only', slots: [1] } },
      { html: 'yes' },
      { entrance: { conditions: [], variables: [], junk: 'x'.repeat(1024 * 1024) } },
    ];
    for (const over of shapes) {
      await expect(rpc['mail_fact.template.create']({ definition: { ...ups(), ...over } as never }, owner))
        .rejects.toMatchObject({ code: 'bad_request', details: { problems: expect.any(Array) } });
    }
  });

  it('keeps only what a template has, at any depth', async () => {
    const definition = ups();
    const sent = {
      ...definition,
      smuggled: 'x',
      entrance: { ...definition.entrance, extra: 'y', conditions: definition.entrance.conditions.map((c) => ({ ...c, note: 'z' })) },
    };
    const { template } = await rpc['mail_fact.template.create']({ definition: sent as never }, owner);
    expect(JSON.stringify(template)).not.toMatch(/smuggled|extra|note/);
    expect(template.entrance).toEqual(definition.entrance);
  });
});

describe('create, read, list', () => {
  it('creates an owner template, then gets and lists it', async () => {
    const { template } = await rpc['mail_fact.template.create']({ definition: ups() }, owner);
    expect(template).toMatchObject({ name: 'UPS', type: 'shipment', active: true, revision: 1, origin: { kind: 'owner' } });
    expect((await rpc['mail_fact.template.get']({ template_id: template.template_id }, owner)).template?.name).toBe('UPS');
    expect((await rpc['mail_fact.template.list']({ type: 'shipment' }, owner)).templates).toHaveLength(1);
    expect((await rpc['mail_fact.template.list']({ type: 'bill' }, owner)).templates).toEqual([]);
  });

  it('refuses a definition the validator refuses, with every problem', async () => {
    const bad = ups({ entrance: { conditions: [], variables: ['nope'] } });
    const refusal = rpc['mail_fact.template.create']({ definition: bad }, owner);
    await expect(refusal).rejects.toMatchObject({ code: 'bad_request', status: 400 });
    await expect(refusal).rejects.toMatchObject({
      details: { problems: expect.arrayContaining([expect.stringContaining("'nope' is not a variable of shipment")]) },
    });
    await expect(rpc['mail_fact.template.create']({ definition: ups({ type: 'parcel' as never }) }, owner))
      .rejects.toMatchObject({ code: 'bad_request' });
  });
});

describe('one active template per type and set of conditions (ruling 31)', () => {
  it('refuses a second active twin — the same conditions in another order and case — naming the first', async () => {
    const first = (await rpc['mail_fact.template.create']({ definition: ups() }, owner)).template;
    const twin = ups({
      name: 'UPS again',
      entrance: {
        conditions: [
          { field: 'subject', op: 'contains', value: 'ups update' },
          { field: 'from', op: 'domain_is', value: 'UPS.com' },
        ],
        variables: ['tracking_number'],
      },
    });
    await expect(rpc['mail_fact.template.create']({ definition: twin }, owner)).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
      details: { template_id: first.template_id },
    });
    // Saved switched off, it is allowed; switching it on is refused the same way.
    const off = (await rpc['mail_fact.template.create']({ definition: twin, active: false }, owner)).template;
    await expect(rpc['mail_fact.template.update']({ template_id: off.template_id, active: true }, owner))
      .rejects.toMatchObject({ code: 'conflict' });
    // Once the first is off, the twin may take its place.
    await rpc['mail_fact.template.update']({ template_id: first.template_id, active: false }, owner);
    expect((await rpc['mail_fact.template.update']({ template_id: off.template_id, active: true }, owner)).template.active)
      .toBe(true);
  });

  it('lets a template of another type share the conditions', async () => {
    await rpc['mail_fact.template.create']({ definition: ups() }, owner);
    const purchase = ups({ type: 'purchase', entrance: { ...ups().entrance, variables: [] }, rules: [] });
    await expect(rpc['mail_fact.template.create']({ definition: purchase }, owner)).resolves.toBeDefined();
  });
});

describe('update and delete', () => {
  it('a new definition is a new revision; the type stays; an unknown id is not found', async () => {
    const { template } = await rpc['mail_fact.template.create']({ definition: ups() }, owner);
    const renamed = await rpc['mail_fact.template.update'](
      { template_id: template.template_id, definition: ups({ name: 'UPS notices' }) },
      owner,
    );
    expect(renamed.template).toMatchObject({ name: 'UPS notices', revision: 2 });
    await expect(rpc['mail_fact.template.update'](
      { template_id: template.template_id, definition: ups({ type: 'purchase', entrance: { ...ups().entrance, variables: [] }, rules: [] }) },
      owner,
    )).rejects.toMatchObject({ code: 'bad_request', message: expect.stringContaining('keeps its type') });
    await expect(rpc['mail_fact.template.update']({ template_id: 'mtpl_nope', active: false }, owner))
      .rejects.toMatchObject({ code: 'not_found' });
  });

  it('deleting a template leaves the facts it already read with their email', async () => {
    const { template } = await rpc['mail_fact.template.create']({ definition: ups() }, owner);
    createMailFactWriter({ store, emit: () => {}, now: () => 1 }).write({
      ref: { slug: 'work', record_id: 'mail:1' },
      email: {
        subject: 'UPS Update: On the way',
        body_text: 'Tracking Number: 1Z0000000000000001\n',
        html: null,
        from_address: 'pkginfo@ups.com',
        from_name: 'UPS',
        headers: {},
        labels: [],
        relationships: [],
        attachments: [],
      },
      email_at: 1,
      content_fingerprint: 'mail:1',
      may_trigger: false,
      count_health: true,
    });
    expect(await rpc['mail_fact.template.delete']({ template_id: template.template_id }, owner)).toEqual({ deleted: true });
    expect(await rpc['mail_fact.template.delete']({ template_id: template.template_id }, owner)).toEqual({ deleted: false });
    expect(store.listFacts()).toHaveLength(1);
  });
});

describe('a template a recipe brought (§5.2)', () => {
  const recipeOrigin = { kind: 'recipe' as const, publisher: 'recued-core', recipe: 'shop-parcels', variable: 'template', version: 1 };
  const brought = (): string => store.createTemplate({
    definition: ups({ ai: { enabled: false, prompt: 'Read the delivery window.', slots: ['data.window'], pool: 'free_only' } }),
    origin: recipeOrigin,
  }).template_id;

  beforeEach(() => {
    rpc = makeMailFactRpcHandlers({ store, recipeNameOf: (id) => (id === 'shop-parcels' ? 'Shop parcels' : null) })!.handlers;
  });

  it('⛔ refuses a change to its rules, naming the recipe: they update with the recipe', async () => {
    const id = brought();
    await expect(rpc['mail_fact.template.update']({ template_id: id, definition: ups({ name: 'Mine now' }) }, owner))
      .rejects.toMatchObject({
        code: 'conflict',
        message: '“UPS” comes with the recipe Shop parcels: its rules update with the recipe. Duplicate it to edit.',
        details: { recipe_id: 'shop-parcels' },
      });
    // Nor its AI's prompt, which is the recipe's too.
    await expect(rpc['mail_fact.template.update']({
      template_id: id,
      definition: ups({ ai: { enabled: true, prompt: 'Something else.', slots: ['data.window'], pool: 'free_only' } }),
    }, owner)).rejects.toMatchObject({ code: 'conflict' });
    expect(store.getTemplate(id)!.revision).toBe(1);
  });

  it('lets the owner switch it and its AI on or off, and pick the pool', async () => {
    const id = brought();
    const on = await rpc['mail_fact.template.update']({
      template_id: id,
      definition: ups({ ai: { enabled: true, prompt: 'Read the delivery window.', slots: ['data.window'], pool: 'byok_only' } }),
    }, owner);
    expect(on.template.ai).toEqual({ enabled: true, prompt: 'Read the delivery window.', slots: ['data.window'], pool: 'byok_only' });
    expect((await rpc['mail_fact.template.update']({ template_id: id, active: false }, owner)).template.active).toBe(false);
  });

  it('⛔ refuses to delete it: it goes with the recipe', async () => {
    const id = brought();
    await expect(rpc['mail_fact.template.delete']({ template_id: id }, owner)).rejects.toMatchObject({
      code: 'conflict',
      message: '“UPS” comes with the recipe Shop parcels and goes with it. Switch it off instead, or uninstall the recipe.',
    });
    expect(store.getTemplate(id)).not.toBeNull();
  });

  it('duplicates to edit through the recipe templates, and says so when there are none', async () => {
    const id = brought();
    await expect(rpc['mail_fact.template.duplicate']({ template_id: id }, owner)).rejects.toMatchObject({ code: 'not_configured' });
    const copy = { ...store.getTemplate(id)!, template_id: 'mtpl_copy', origin: { kind: 'owner' as const } };
    const duplicate = vi.fn((template_id: string) => (template_id === id ? copy : null));
    rpc = makeMailFactRpcHandlers({ store, recipeTemplates: { duplicate } })!.handlers;
    expect(await rpc['mail_fact.template.duplicate']({ template_id: id }, owner)).toEqual({ template: copy });
    await expect(rpc['mail_fact.template.duplicate']({ template_id: 'mtpl_nope' }, owner)).rejects.toMatchObject({ code: 'not_found' });
    await expect(rpc['mail_fact.template.duplicate']({ template_id: id }, stranger)).rejects.toMatchObject({ code: 'unauthorized' });
  });
});

describe('a template as a recipe’s starter, for its author (§5.2)', () => {
  const withEditor = () => makeMailFactRpcHandlers({
    store,
    editor: {
      mailboxes: () => [{ accountEmail: 'me@owner.example' }] as never,
      standardsOff: () => new Set(),
      blobs: {} as never,
      relationshipsOf: (address) => (address === 'friend@example.com' ? ['family'] : address === 'shop@example.com' ? ['other'] : []),
    },
  })!.handlers;

  it('drops what belongs to this server, and keeps the rest — the AI’s prompt included', async () => {
    const { template } = await rpc['mail_fact.template.create']({ definition: ups() }, owner);
    const { starter } = await withEditor()['mail_fact.template.starter']({ template_id: template.template_id }, owner);
    expect(starter).toEqual(ups());
    expect(starter).not.toHaveProperty('template_id');
    expect(starter).not.toHaveProperty('health');
    expect(starter).not.toHaveProperty('origin');
  });

  it('⛔ refuses, naming where, the owner’s own address and a sender they know — a shop is fine', async () => {
    const own = (await rpc['mail_fact.template.create']({
      definition: ups({ rules: [...ups().rules, { target: { data: 'to' }, source: 'body', find: { kind: 'after_label', label: 'For me@owner.example:' } }] }),
    }, owner)).template;
    await expect(withEditor()['mail_fact.template.starter']({ template_id: own.template_id }, owner)).rejects.toMatchObject({
      code: 'bad_request',
      details: { problems: expect.arrayContaining([expect.stringMatching(/^rules\[2\]\.find\.label: /)]) },
    });
    // A sender's address is no leak in itself — a shop's is the point — but the
    // owner's own is: only their server knows it is theirs.
    const mine = (await rpc['mail_fact.template.create']({
      definition: ups({ name: 'To myself', entrance: { conditions: [{ field: 'from', op: 'is', value: 'Me@Owner.Example' }], variables: ['tracking_number'] } }),
    }, owner)).template;
    await expect(withEditor()['mail_fact.template.starter']({ template_id: mine.template_id }, owner)).rejects.toMatchObject({
      details: { problems: ["entrance.conditions[0].value: holds its author's own address or name"] },
    });
    const friend = (await rpc['mail_fact.template.create']({
      definition: ups({ name: 'Friend', entrance: { conditions: [{ field: 'from', op: 'is', value: 'Friend@Example.com' }], variables: ['tracking_number'] } }),
    }, owner)).template;
    await expect(withEditor()['mail_fact.template.starter']({ template_id: friend.template_id }, owner)).rejects.toMatchObject({
      message: expect.stringContaining('names a sender in its author'),
    });
    const shop = (await rpc['mail_fact.template.create']({
      definition: ups({ name: 'Shop', entrance: { conditions: [{ field: 'from', op: 'is', value: 'shop@example.com' }], variables: ['tracking_number'] } }),
    }, owner)).template;
    await expect(withEditor()['mail_fact.template.starter']({ template_id: shop.template_id }, owner)).resolves.toBeDefined();
    await expect(withEditor()['mail_fact.template.starter']({ template_id: 'mtpl_nope' }, owner)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('twins are read as the entrance reads them (ruling 31)', () => {
  it('⛔ fullwidth letters and a leading @ are the same conditions', async () => {
    await rpc['mail_fact.template.create']({ definition: ups() }, owner);
    const twin = ups({
      name: 'UPS again',
      entrance: {
        conditions: [
          { field: 'from', op: 'domain_is', value: '@ＵＰＳ.com' },
          { field: 'subject', op: 'contains', value: 'ＵＰＳ Update' },
        ],
        variables: ['tracking_number'],
      },
    });
    await expect(rpc['mail_fact.template.create']({ definition: twin }, owner)).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('the standards switches (ruling 10)', () => {
  it('lists every standards type, on by default, and switches one', async () => {
    const before = await rpc['mail_fact.standards.get'](undefined, owner);
    expect(before.standards).toEqual([
      { type: 'shipment', on: true },
      { type: 'purchase', on: true },
      { type: 'bill', on: true },
      { type: 'reservation', on: true },
      { type: 'owner_request', on: true },
    ]);
    expect(await rpc['mail_fact.standards.set']({ type: 'bill', on: false }, owner)).toEqual({ type: 'bill', on: false });
    expect((await rpc['mail_fact.standards.get'](undefined, owner)).standards).toContainEqual({ type: 'bill', on: false });
  });

  it('refuses a type the standards pass does not read, and a stranger', async () => {
    await expect(rpc['mail_fact.standards.set']({ type: 'lead' as never, on: false }, owner))
      .rejects.toMatchObject({ code: 'bad_request' });
    await expect(rpc['mail_fact.standards.set']({ type: 'bill', on: 'no' as never }, owner))
      .rejects.toMatchObject({ code: 'bad_request' });
    await expect(rpc['mail_fact.standards.get'](undefined, stranger)).rejects.toMatchObject({ code: 'unauthorized' });
  });
});
