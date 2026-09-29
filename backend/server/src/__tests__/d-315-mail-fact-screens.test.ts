/** D-315 slice 3 — what the Mail facts screens read (§6, §6.4): the facts list
 *  a page of emails at a time, its filters, the run links and their cascade,
 *  the per-email status behind the mail detail view's actions, and the
 *  announcements the screens refresh on. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  CollectionRecord,
  MailFact,
  MailFactEmailRef,
  MailFactThing,
  MailTemplateDefinition,
} from '@recued/contracts';

import { SERVER_RPC_METHODS } from '@recued/contracts';

import { createMailFactWriter, type MailFactChange, type MailFactWriter } from '../mail-facts/fact-writer.js';
import { makeMailFactRpcHandlers, type MailFactMailAccess, type MailFactRpcDeps } from '../mail-facts/mail-fact-rpc-handler.js';
import { mailFactScreensRpcDeps } from '../mail-facts/screens-wiring.js';
import type { MailFactSourceEmail } from '../mail-facts/rules-pass.js';
import { createMailFactStore, type MailFactRunLink, type MailFactStore } from '../storage/mail-fact-store.js';
import type { WsClient } from '../ws-server.js';

const DAY = 86_400_000;
const owner = { instance_id: 'webclient-1', client_kind: 'webclient' } as WsClient;

let dir: string;
let db: Database.Database;
let store: MailFactStore;
let ids: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-315-screens-'));
  db = new Database(join(dir, 'test.db'));
  ids = 0;
  store = createMailFactStore(db, { now: () => 5_000, mintId: (prefix) => `${prefix}_${(ids += 1)}` });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const ref = (record_id: string, slug = 'work'): MailFactEmailRef => ({ slug, record_id });

const fact = (fact_id: string, email: MailFactEmailRef, over: Partial<MailFact> = {}): MailFact => ({
  fact_id,
  type: 'shipment',
  template_id: 'mtpl_ship',
  email,
  email_at: 1_000,
  position: 0,
  identity_keys: [],
  thing_id: null,
  variables: {},
  passes: {},
  data: null,
  missing: [],
  refused: [],
  complete: true,
  source_hash: 'h',
  revision: 1,
  created_at: 1,
  ...over,
});

const thing = (thing_id: string, variables: MailFactThing['variables'], type: MailFact['type'] = 'shipment'): void =>
  store.saveThing({
    thing_id,
    type,
    identity_keys: [],
    variables,
    passes: {},
    variable_email_at: {},
    last_email_at: 1,
    missing: [],
    complete: true,
    created_at: 1,
    updated_at: 1,
  });

const run = (email: MailFactEmailRef, thing_id: string, over: Partial<MailFactRunLink> = {}): MailFactRunLink => ({
  email,
  thing_id,
  trigger_id: 'trg_1',
  recipe_id: 'recipe-alert',
  run_id: 'run-1',
  outcome: 'completed',
  at: 9_000,
  ...over,
});

const page = (query: Partial<Parameters<MailFactStore['listFactPage']>[0]> = {}) =>
  store.listFactPage({ limit: 50, ...query });

const pageIds = (query: Partial<Parameters<MailFactStore['listFactPage']>[0]> = {}): string[][] =>
  page(query).emails.map((email) => email.facts.map((f) => f.fact_id));

describe('the page: whole emails, newest first', () => {
  beforeEach(() => {
    store.insertFact(fact('a2', ref('mail:a'), { email_at: 3_000, position: 1 }));
    store.insertFact(fact('a1', ref('mail:a'), { email_at: 3_000, position: 0 }));
    store.insertFact(fact('b1', ref('mail:b'), { email_at: 2_000 }));
    store.insertFact(fact('d1', ref('mail:d'), { email_at: 2_000 }));
    store.insertFact(fact('c1', ref('mail:c'), { email_at: 1_000 }));
  });

  it('keeps one email’s facts together, in the email’s own order', () => {
    expect(pageIds()).toEqual([['a1', 'a2'], ['d1'], ['b1'], ['c1']]);
  });

  it('pages by email and resumes after the last one, through a tie on the date', () => {
    const first = page({ limit: 2 });
    expect(first.emails.map((e) => e.email.record_id)).toEqual(['mail:a', 'mail:d']);
    expect(first.more).toBe(true);
    const last = first.emails[1]!;
    const second = page({ limit: 2, before: { email_at: last.email_at, slug: last.email.slug, record_id: last.email.record_id } });
    expect(second.emails.map((e) => e.email.record_id)).toEqual(['mail:b', 'mail:c']);
    expect(second.more).toBe(false);
  });
});

describe('the filters (§6.4)', () => {
  beforeEach(() => {
    thing('thing_delivered', { state: 'delivered' });
    thing('thing_moving', { state: 'in_transit' });
    // The thing moved on: this fact said in_transit, its thing is delivered now.
    store.insertFact(fact('old_news', ref('mail:1'), { thing_id: 'thing_delivered', variables: { state: 'in_transit' } }));
    store.insertFact(fact('moving', ref('mail:2'), { thing_id: 'thing_moving', variables: { state: 'in_transit' }, complete: false }));
    store.insertFact(fact('unpaired', ref('mail:3'), { template_id: null, variables: { state: 'delivered' } }));
    store.insertFact(fact('bill', ref('mail:4'), { type: 'subscription', thing_id: 'thing_sub', variables: { notice: 'price_change' } }));
    thing('thing_sub', { state: 'active', notice: 'price_change' }, 'subscription');
    store.recordRun(run(ref('mail:2'), 'thing_moving'));
    // A run of the same thing from ANOTHER email is not this email's run.
    store.recordRun(run(ref('mail:9'), 'thing_delivered'));
  });

  const flat = (query: Partial<Parameters<MailFactStore['listFactPage']>[0]>): string[] => pageIds(query).flat().sort();

  it('state is what the row shows: the thing’s, or an unpaired fact’s own', () => {
    expect(flat({ state: 'delivered' })).toEqual(['old_news', 'unpaired']);
    expect(flat({ state: 'in_transit' })).toEqual(['moving']);
  });

  it('type, notice, and the template — null meaning the standards pass alone', () => {
    expect(flat({ type: 'subscription' })).toEqual(['bill']);
    expect(flat({ notice: 'price_change' })).toEqual(['bill']);
    expect(flat({ template_id: null })).toEqual(['unpaired']);
    expect(flat({ template_id: 'mtpl_ship' })).toEqual(['bill', 'moving', 'old_news']);
  });

  it('complete, unpaired, and whether the email’s facts started a run', () => {
    expect(flat({ complete: false })).toEqual(['moving']);
    expect(flat({ unpaired: true })).toEqual(['unpaired']);
    expect(flat({ unpaired: false })).toEqual(['bill', 'moving', 'old_news']);
    expect(flat({ has_run: true })).toEqual(['moving']);
    expect(flat({ has_run: false })).toEqual(['bill', 'old_news', 'unpaired']);
  });

  it('one email’s facts', () => {
    expect(flat({ email: ref('mail:3') })).toEqual(['unpaired']);
  });
});

describe('run links follow their email', () => {
  it('are listed per email, oldest first', () => {
    store.recordRun(run(ref('mail:1'), 'thing_1', { run_id: 'run-2', at: 20 }));
    store.recordRun(run(ref('mail:1'), 'thing_1', { run_id: undefined, outcome: 'failed', at: 10 }));
    expect(store.runsForEmail(ref('mail:1')).map((r) => [r.run_id, r.outcome])).toEqual([
      [undefined, 'failed'],
      ['run-2', 'completed'],
    ]);
  });

  it('move with a moved email, and go with a deleted one', () => {
    store.recordRun(run(ref('mail:1'), 'thing_1'));
    store.recordRun(run(ref('mail:2'), 'thing_2'));
    store.rekeyEmail('work', 'mail:1', 'mail:1b');
    expect(store.runsForEmail(ref('mail:1'))).toEqual([]);
    expect(store.runsForEmail(ref('mail:1b'))).toHaveLength(1);
    store.deleteRunsForEmails('work', ['mail:1b']);
    expect(store.runsForEmail(ref('mail:1b'))).toEqual([]);
    expect(store.runsForEmail(ref('mail:2'))).toHaveLength(1);
  });
});

// ── The writer: its cascade and its announcements ───────────────────────────

const email = (over: Partial<MailFactSourceEmail> = {}): MailFactSourceEmail => ({
  subject: 'Your parcel',
  body_text: 'UPS 1Z999AA10123456784',
  html: null,
  from_address: 'ship@shop.example',
  from_name: 'Shop',
  headers: {},
  labels: ['INBOX'],
  relationships: [],
  attachments: [],
  ...over,
});

const writerWith = (changes: MailFactChange[]): MailFactWriter =>
  createMailFactWriter({ store, emit: () => {}, now: () => 5_000, onChanged: (what) => changes.push(what) });

const input = (record_id: string, over: Partial<MailFactSourceEmail> = {}) => ({
  ref: ref(record_id),
  email: email(over),
  email_at: 1_000,
  content_fingerprint: `${record_id}:${over.body_text ?? ''}`,
  may_trigger: true,
  count_health: true,
});

describe('the writer tells the screens what moved', () => {
  it('facts, when an email’s facts are written — and nothing when it is re-read unchanged', () => {
    const changes: MailFactChange[] = [];
    const writer = writerWith(changes);
    writer.write(input('m1'));
    expect(changes).toEqual(['facts']);
    writer.write(input('m1'));
    expect(changes).toEqual(['facts']);
  });

  it('nothing for an email that gives no facts and had none', () => {
    const changes: MailFactChange[] = [];
    writerWith(changes).write(input('m1', { body_text: 'Hello there' }));
    expect(changes).toEqual([]);
  });

  it('templates, when a template met its conditions and did not enter', () => {
    const definition: MailTemplateDefinition = {
      name: 'Shop orders',
      type: 'purchase',
      entrance: { conditions: [{ field: 'from', op: 'is', value: 'ship@shop.example' }], variables: ['order_id'] },
      rules: [{ target: { variable: 'order_id' }, source: 'body', find: { kind: 'after_label', label: 'Order:' } }],
      html: false,
      ai: { enabled: false },
    };
    store.createTemplate({ definition, origin: { kind: 'owner' } });
    const changes: MailFactChange[] = [];
    writerWith(changes).write(input('m1', { body_text: 'Thanks for shopping' }));
    expect(changes).toEqual(['templates']);
  });

  it('an email’s runs go with it — also when a re-read had already dropped its facts', () => {
    const changes: MailFactChange[] = [];
    const writer = writerWith(changes);
    writer.write(input('m1'));
    const [written] = store.factsForEmail(ref('m1'));
    store.recordRun(run(ref('m1'), written!.thing_id!));
    writer.removeEmails('work', ['m1']);
    expect(store.runsForEmail(ref('m1'))).toEqual([]);
    expect(changes).toEqual(['facts', 'facts']);

    store.recordRun(run(ref('m2'), 'thing_gone'));
    writer.removeEmails('work', ['m2']);
    expect(store.runsForEmail(ref('m2'))).toEqual([]);
    expect(changes).toEqual(['facts', 'facts']); // no facts went, so nothing to redraw
  });
});

// ── The rpc ─────────────────────────────────────────────────────────────────

const mailRecords = new Map<string, CollectionRecord>();
const stored = (record_id: string, hot: Record<string, unknown>, received_at: number, body = ''): void => {
  mailRecords.set(`work/${record_id}`, {
    record_id,
    received_at,
    modified_at: received_at,
    hot_fields: hot,
    size_bytes: body.length,
    source_id: record_id,
    body_inline: body,
  });
};
const mail: MailFactMailAccess = {
  get: (slug, record_id) => mailRecords.get(`${slug}/${record_id}`) ?? null,
  body: async (record) => record.body_inline ?? null,
  retentionDays: (slug) => (slug === 'work' ? 30 : null),
};

const rpcWith = (over: Partial<MailFactRpcDeps> = {}) =>
  makeMailFactRpcHandlers({ store, mail, ...over })!.handlers;

beforeEach(() => mailRecords.clear());

describe('mail_fact.facts.list', () => {
  beforeEach(() => {
    thing('thing_1', { state: 'delivered', tracking_number: '1Z1' });
    thing('thing_2', { state: 'in_transit', tracking_number: '1Z2' });
    store.insertFact(fact('f1', ref('mail:a'), { email_at: 3_000, position: 0, thing_id: 'thing_1' }));
    store.insertFact(fact('f2', ref('mail:a'), { email_at: 3_000, position: 1, thing_id: 'thing_2' }));
    store.insertFact(fact('f3', ref('mail:gone'), { email_at: 1_000, thing_id: 'thing_1' }));
    stored('mail:a', { from: 'ship@shop.example', subject: 'Two parcels' }, 3_000);
    store.recordRun(run(ref('mail:a'), 'thing_1', { run_id: 'run-1' }));
    store.recordRun(run(ref('mail:a'), 'thing_2', { run_id: 'run-2', outcome: 'held', recipe_id: 'recipe-gone' }));
  });

  it('gives each fact its email, its thing, its place among the email’s facts, and its runs', async () => {
    const rpc = rpcWith({
      runStatusOf: async (run_id) => (run_id === 'run-1' ? 'succeeded' : null),
      recipeNameOf: (recipe_id) => (recipe_id === 'recipe-alert' ? 'Parcel alert' : null),
    });
    const { rows, next_cursor } = await rpc['mail_fact.facts.list'](undefined, owner);
    expect(next_cursor).toBeUndefined();
    expect(rows.map((row) => row.fact.fact_id)).toEqual(['f1', 'f2', 'f3']);
    expect(rows[0]).toMatchObject({
      email: { slug: 'work', record_id: 'mail:a', from: 'ship@shop.example', subject: 'Two parcels', at: 3_000, goes_at: 3_000 + 30 * DAY },
      thing: { thing_id: 'thing_1', variables: { state: 'delivered' } },
      of_email: { index: 1, count: 2 },
      runs: [{ recipe_id: 'recipe-alert', recipe_name: 'Parcel alert', run_id: 'run-1', outcome: 'completed', status: 'succeeded' }],
    });
    // The other parcel's run is on its own row; a run the log no longer holds
    // keeps its outcome and has no status, and a removed recipe no name.
    expect(rows[1]).toMatchObject({ of_email: { index: 2, count: 2 } });
    expect(rows[1]!.runs).toEqual([
      { trigger_id: 'trg_1', recipe_id: 'recipe-gone', run_id: 'run-2', outcome: 'held', at: 9_000 },
    ]);
    // An email no longer stored: the fact is shown, its email is not.
    expect(rows[2]).toMatchObject({ email: null, runs: [] });
    expect(rows[2]).not.toHaveProperty('mailbox_removed');
  });

  it('says when an email’s mailbox was removed: its mail and facts are kept', async () => {
    store.insertFact(fact('f9', { slug: 'home', record_id: 'mail:h' }, { email_at: 5_000 }));
    const { rows } = await rpcWith()['mail_fact.facts.list'](undefined, owner);
    expect(rows[0]).toMatchObject({ fact: { fact_id: 'f9' }, email: null, mailbox_removed: true });
    // Its detail says so rather than that the email is gone.
    await expect(rpcWith()['mail_fact.email.get']({ slug: 'home', record_id: 'mail:h' }, owner))
      .rejects.toMatchObject({ code: 'not_found', message: 'That email’s mailbox was removed from this server.' });
    await expect(rpcWith()['mail_fact.email.get'](ref('mail:nope'), owner))
      .rejects.toMatchObject({ code: 'not_found', message: 'That email is no longer stored.' });
  });

  it('pages by email through its cursor', async () => {
    const rpc = rpcWith();
    const first = await rpc['mail_fact.facts.list']({ limit: 1 }, owner);
    expect(first.rows.map((row) => row.fact.fact_id)).toEqual(['f1', 'f2']);
    expect(first.next_cursor).toEqual({ email_at: 3_000, slug: 'work', record_id: 'mail:a' });
    const second = await rpc['mail_fact.facts.list']({ limit: 1, before: first.next_cursor! }, owner);
    expect(second.rows.map((row) => row.fact.fact_id)).toEqual(['f3']);
    expect(second.next_cursor).toBeUndefined();
  });

  it('counts the whole email even when a filter shows one of its facts', async () => {
    const { rows } = await rpcWith()['mail_fact.facts.list']({ state: 'in_transit' }, owner);
    expect(rows.map((row) => [row.fact.fact_id, row.of_email])).toEqual([['f2', { index: 2, count: 2 }]]);
  });

  it('shows no email without the mail access, rather than failing', async () => {
    const { rows } = await makeMailFactRpcHandlers({ store })!.handlers['mail_fact.facts.list'](undefined, owner);
    expect(rows.every((row) => row.email === null)).toBe(true);
  });

  it('refuses a query it cannot read, and a stranger', async () => {
    const rpc = rpcWith();
    for (const bad of [
      { limit: 0 },
      { limit: 1.5 },
      { before: { email_at: 'x', slug: 'work', record_id: 'mail:a' } },
      { template_id: '' },
      { unpaired: 'yes' },
      { email: { slug: 'work' } },
    ]) {
      await expect(rpc['mail_fact.facts.list'](bad as never, owner)).rejects.toMatchObject({ code: 'bad_request' });
    }
    await expect(rpc['mail_fact.facts.list'](undefined, {} as WsClient)).rejects.toMatchObject({ code: 'unauthorized' });
  });
});

describe('mail_fact.email.get — the mail detail view’s two actions (§6, §9)', () => {
  it('says how many facts the email gave, and that it is not a security notice', async () => {
    store.insertFact(fact('f1', ref('mail:a')));
    stored('mail:a', { from: 'ship@shop.example', subject: 'Your parcel' }, 1_000, 'Tracking 1Z1');
    await expect(rpcWith()['mail_fact.email.get'](ref('mail:a'), owner))
      .resolves.toEqual({ fact_count: 1, security_notice: false });
  });

  it('recognizes a security notice from its stored subject or body', async () => {
    stored('mail:code', { from: 'no-reply@bank.example', subject: 'Your sign-in' }, 1_000, 'Your verification code is 123456');
    await expect(rpcWith()['mail_fact.email.get'](ref('mail:code'), owner))
      .resolves.toEqual({ fact_count: 0, security_notice: true });
  });

  it('answers not_found for an email no longer stored, and not_configured without mail', async () => {
    await expect(rpcWith()['mail_fact.email.get'](ref('mail:nope'), owner)).rejects.toMatchObject({ code: 'not_found' });
    await expect(makeMailFactRpcHandlers({ store })!.handlers['mail_fact.email.get'](ref('mail:a'), owner))
      .rejects.toMatchObject({ code: 'not_configured' });
    await expect(rpcWith()['mail_fact.email.get']({ slug: 'work' } as never, owner)).rejects.toMatchObject({ code: 'bad_request' });
  });
});

describe('a template change is announced to every Templates view', () => {
  const definition: MailTemplateDefinition = {
    name: 'Shop',
    type: 'shipment',
    entrance: { conditions: [{ field: 'from', op: 'is', value: 'ship@shop.example' }], variables: [] },
    rules: [],
    html: false,
    ai: { enabled: false },
  };

  it('on create, update, delete and a standards switch — and not on a refusal', async () => {
    const onTemplatesChanged = vi.fn();
    const rpc = rpcWith({ onTemplatesChanged });
    const { template } = await rpc['mail_fact.template.create']({ definition }, owner);
    await expect(rpc['mail_fact.template.create']({ definition }, owner)).rejects.toMatchObject({ code: 'conflict' });
    await rpc['mail_fact.template.update']({ template_id: template.template_id, active: false }, owner);
    await rpc['mail_fact.standards.set']({ type: 'shipment', on: false }, owner);
    await rpc['mail_fact.template.delete']({ template_id: template.template_id }, owner);
    await rpc['mail_fact.template.delete']({ template_id: template.template_id }, owner);
    expect(onTemplatesChanged).toHaveBeenCalledTimes(4);
  });

  it('a failing announcement never fails the change', async () => {
    const rpc = rpcWith({ onTemplatesChanged: () => { throw new Error('bus down'); } });
    await expect(rpc['mail_fact.template.create']({ definition }, owner)).resolves.toMatchObject({
      template: { name: 'Shop' },
    });
  });
});

describe('every mail_fact.* method answers the owner’s webclient only (§6)', () => {
  // Read from the registry, so a method added later is held to it too.
  const methods = SERVER_RPC_METHODS.filter((method) => method.startsWith('mail_fact.'));

  it('the handlers are exactly the registered methods', () => {
    expect(methods).toHaveLength(21);
    expect(Object.keys(rpcWith()).sort()).toEqual([...methods].sort());
  });

  it('refuses a Bridge, the CLI and an unpaired client before it reads anything', async () => {
    const handlers = rpcWith() as unknown as Record<string, (args: unknown, client: WsClient) => Promise<unknown>>;
    const strangers = [
      { instance_id: 'bridge-1', client_kind: 'bridge' },
      { instance_id: 'cli-1', client_kind: 'cli' },
      { client_kind: 'webclient' },
      {},
    ] as unknown as WsClient[];
    for (const method of methods) {
      for (const client of strangers) {
        await expect(handlers[method]!(undefined, client), `${method} for ${JSON.stringify(client)}`)
          .rejects.toMatchObject({ code: 'unauthorized' });
      }
    }
  });
});

describe('the screens’ wiring', () => {
  it('reads an attachment again only when the ingest stored its file (data.file, received)', () => {
    const files = new Map([['file:stored', { record_id: 'file:stored' }]]);
    const registry = {
      list: () => [],
      get: (platform: string, slug: string) => (platform === 'file' && slug === 'received'
        ? { get: (id: string) => files.get(id) ?? null }
        : undefined),
    };
    const deps = mailFactScreensRpcDeps({
      store,
      recipeStore: { get: () => undefined } as never,
      mail: { registry: registry as never, instances: { get: () => null }, blobs: {} as never },
      writer: createMailFactWriter({ store, emit: () => {}, now: () => 1 }),
    });
    const editor = deps.editor as unknown as { fileStored?: (id: string) => boolean };
    expect(editor.fileStored?.('file:stored')).toBe(true);
    expect(editor.fileStored?.('file:gone')).toBe(false);
  });

  it('reads an attachment again as the type its file was stored with, which the ingest read from its bytes', () => {
    const files = new Map([['file:pdf', { record_id: 'file:pdf', hot_fields: { mime_type: 'application/pdf' } }]]);
    const registry = {
      list: () => [],
      get: (platform: string, slug: string) => (platform === 'file' && slug === 'received'
        ? { get: (id: string) => files.get(id) ?? null }
        : undefined),
    };
    const deps = mailFactScreensRpcDeps({
      store,
      recipeStore: { get: () => undefined } as never,
      mail: { registry: registry as never, instances: { get: () => null }, blobs: {} as never },
      writer: createMailFactWriter({ store, emit: () => {}, now: () => 1 }),
    });
    // The editor's and a backfill's readings share these (`storedEmailOf`).
    const editor = deps.editor as unknown as { storedFileType?: (id: string) => string | undefined };
    expect(editor.storedFileType?.('file:pdf')).toBe('application/pdf');
    expect(editor.storedFileType?.('file:gone')).toBeUndefined();
  });

  it('reads a moved email’s attachments by every id a move took it from — its files keep the first', () => {
    const deps = mailFactScreensRpcDeps({
      store,
      recipeStore: { get: () => undefined } as never,
      mail: { registry: { list: () => [], get: () => undefined } as never, instances: { get: () => null }, blobs: {} as never },
      writer: createMailFactWriter({ store, emit: () => {}, now: () => 1 }),
    });
    store.recordEmailMove('work', 'mail:first', 'mail:then', 1);
    store.recordEmailMove('work', 'mail:then', 'mail:now', 2);
    // The editor's reads and a backfill's share these.
    const editor = deps.editor as unknown as { formerRecordIds?: (slug: string, record_id: string) => readonly string[] };
    expect(editor.formerRecordIds?.('work', 'mail:now')).toEqual(['mail:then', 'mail:first']);
    expect(editor.formerRecordIds?.('work', 'mail:first')).toEqual([]);
  });
});
