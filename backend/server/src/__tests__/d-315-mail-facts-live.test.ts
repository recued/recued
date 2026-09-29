/** D-315 — proven end to end (§10): a real mail collection ingests a real email,
 *  the fact lands, and a recipe subscribed to it runs. Slice 1 with a template;
 *  slice 2 with none — the standards pass and owner requests; slice 3 what the
 *  screens read of it — the facts list, the run it links, the broadcast.
 *
 *  ⛔ WHY THE WHOLE SERVER COMPOSITION, AND NOT A HAND-WIRED HARNESS. Every seam
 *  these slices added is a place a field can be dropped and still typecheck: the
 *  store rides the per-pair stores → the storage context → the collection
 *  context → `composeMailBoot` (which builds the writer) → `composeMailStack`
 *  (which forwards the hooks) → `createMailCollection`; the reads ride the
 *  execution context → the executor config → the kernel dispatchers. So this
 *  composes the server's real contexts over one SQLite file, and only the
 *  network is scripted: `globalThis.fetch`, behind the production default
 *  fetcher, answers as Gmail.
 *
 *      Gmail (scripted) → real provider → real mail collection → real hooks
 *        → fact writer → warehouse bus → the recipe's own `mail_fact.*`
 *        trigger (compiled by the real reconciler, armed through the real rpc)
 *        → dispatcher → handleExecute → the real kernel `core.mail.fact.get`
 *        → a completed run, linked from `trigger_fired` */

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRuntimeConfigStore } from '@recued/config';
import { MAIL_FACT_EVENT_PATTERN, type MailFactThing, type MailTemplateDefinition, type RecipeDefinition } from '@recued/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBootTrace } from '../cli/boot-trace.js';
import { composeEventTriggers } from '../composition/bin/wire-event-triggers.js';
import { makeMailFactRpcHandlers } from '../mail-facts/mail-fact-rpc-handler.js';
import { linkMailFactRuns, mailFactScreensRpcDeps } from '../mail-facts/screens-wiring.js';
import { createLLMConfigManager } from '../llm-config.js';
import { createOAuthAppConfigStore } from '../oauth-app-config-store.js';
import { composeAppContext } from '../serve/compose-app-context.js';
import { composeCollectionContext } from '../serve/compose-collection-context.js';
import {
  composeExecutionContext,
  createExecutionLateBoundRefs,
} from '../serve/compose-execution-context.js';
import { composeStorageContext } from '../serve/compose-storage-context.js';
import { handleTriggersCreate, handleTriggersUpdate } from '../triggers/handler.js';

const OWNER = 'me@owner.example';
const TRACKING = '1Z0000000000000001';
const FEDEX = '986578788855';
const DAY = 86_400_000;

let tmp: string | undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

// ── Gmail, scripted ────────────────────────────────────────────────────

interface GmailMessage {
  readonly id: string;
  readonly at: number;
  /** Gmail's labels for it; INBOX when unsaid. */
  readonly labels?: readonly string[];
  /** The raw RFC 822 message; a UPS notice with `subject` when unsaid. */
  readonly raw?: string;
  readonly subject?: string;
}

const upsNotice = (m: GmailMessage): string =>
  [
    'From: "UPS" <pkginfo@ups.com>',
    `To: ${OWNER}`,
    `Subject: ${m.subject ?? 'UPS Update'}`,
    `Message-ID: <${m.id}@ups.example>`,
    `Date: ${new Date(m.at).toUTCString()}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    `Tracking Number: ${TRACKING}`,
    '',
  ].join('\r\n');

/** A model the server can call, as an OpenAI-compatible endpoint answers: it
 *  is shown the request body exactly as it left the server. */
const LLM_BASE_URL = 'https://llm.example.test/v1';
type ScriptedModel = (requestBody: string) => unknown;

/** The mailbox's current messages, served as the Gmail REST API would; and,
 *  when given, a model answering at `LLM_BASE_URL`. */
const scriptGmail = (mailbox: GmailMessage[], model?: ScriptedModel): void => {
  const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (model !== undefined && url.href === `${LLM_BASE_URL}/chat/completions`) {
      const answer = await model(typeof init?.body === 'string' ? init.body : '');
      return json({
        id: 'cmpl-1',
        object: 'chat.completion',
        model: 'test-model',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(answer) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    }
    const path = url.pathname.replace('/gmail/v1/users/me', '');
    if (path === '/profile') return json({ emailAddress: OWNER, historyId: '100' });
    if (path === '/history') return json({ historyId: '100' });
    if (path === '/messages') {
      return json({ messages: mailbox.map((m) => ({ id: m.id, threadId: m.id })), resultSizeEstimate: mailbox.length });
    }
    const one = /^\/messages\/([^/]+)$/.exec(path);
    const message = one ? mailbox.find((m) => m.id === decodeURIComponent(one[1]!)) : undefined;
    if (message !== undefined && url.searchParams.get('format') === 'raw') {
      return json({
        id: message.id,
        threadId: message.id,
        labelIds: message.labels ?? ['INBOX'],
        raw: Buffer.from(message.raw ?? upsNotice(message)).toString('base64url'),
        internalDate: String(message.at),
      });
    }
    return new Response(JSON.stringify({ error: `unscripted ${url.href}` }), { status: 404 });
  });
};

const mailRecordId = (sourceId: string): string =>
  `mail:${createHash('sha256').update(sourceId).digest('hex').slice(0, 32)}`;

// ── The server, composed ───────────────────────────────────────────────

/** The server's real contexts over one SQLite file, with a Gmail account
 *  connected and the given recipes installed, their triggers switched on. */
const bootLive = async (
  recipes: readonly RecipeDefinition[],
  templates: readonly MailTemplateDefinition[] = [],
  opts: {
    /** What the server does before its trigger dispatcher subscribes — at
     *  boot, its mailboxes start (`startBootRecoveryAndAdapters` runs before
     *  `composeListeners`). */
    beforeTriggers?: (ctx: { mailStack: NonNullable<ReturnType<typeof composeCollectionContext>['mailStack']> }) => Promise<void>;
  } = {},
) => {
  tmp = mkdtempSync(join(tmpdir(), 'd-315-live-'));
  const dbPath = join(tmp, 'server.db');
  const runtimeConfig = createRuntimeConfigStore({});
  const storage = await composeStorageContext({
    dbPath,
    bootTrace: createBootTrace({ entrypoint: 'serve-entry', profile: 'serve', command: 'serve', env: {} }),
    runtimeConfig,
    vaultQuotas: { perPublisherBytes: 1_000_000, totalBytes: 5_000_000 },
  });
  const lateBound = createExecutionLateBoundRefs();
  const app = composeAppContext({
    db: storage.db,
    dbPath,
    envLlmConfig: storage.envLlmConfig,
    gateRegistry: storage.gateRegistry,
    auditLog: storage.auditLog,
    eventBus: storage.eventBus,
    serverInstanceId: storage.serverInstanceId,
    recipeStore: storage.recipeStore,
    pairedInstances: storage.pairedInstances,
    workEntityStore: storage.workEntityStoreRef,
    chatLateBound: lateBound,
  });
  // D-212 — the server's secrets and the CAS need an unlocked vault.
  await app.keys!.init({ password: 'd-315-live-passphrase' });
  const collection = composeCollectionContext({
    db: storage.db,
    dbPath,
    runtimeConfig,
    manifests: storage.manifests,
    baseVault: storage.baseVault,
    auditLog: storage.auditLog,
    cacheBlobs: app.cacheBlobs,
    warehouseBus: app.warehouseBus,
    contactStore: app.contactStoreRef,
    mailFactStore: storage.mailFactStoreRef,
    gateRegistry: storage.gateRegistry,
    accountStore: storage.accountStore,
    eventBus: storage.eventBus,
    keys: app.keys,
    connectionStore: app.connectionStoreRef,
    workEntityStore: storage.workEntityStoreRef,
    enrichmentCascade: app.enrichmentCascadeRef,
    // As the server wires it (start-post-storage-app-collection-execution-runtime).
    ...(app.privateAiCall ? { privateAiCall: app.privateAiCall } : {}),
  });
  const execution = await composeExecutionContext({
    storage,
    app,
    collection,
    baseVault: storage.baseVault,
    lateBound,
    env: {},
  });
  const facts = storage.mailFactStoreRef!;
  // The screens' rpc, wired as the server wires it (compose-listeners).
  const screens = makeMailFactRpcHandlers(mailFactScreensRpcDeps({
    store: facts,
    mail: {
      registry: collection.collectionRegistry,
      instances: collection.mailStack!.instances,
      blobs: app.cacheBlobs!,
    },
    auditLog: storage.auditLog!,
    recipeStore: storage.recipeStore,
    eventBus: storage.eventBus,
    ...(collection.mailFactWriter ? { writer: collection.mailFactWriter } : {}),
    aiSettled: collection.mailFactAiSettled,
    ...(app.privateAiCall ? { privateAiCall: app.privateAiCall } : {}),
  }))!.handlers;
  const client = { instance_id: 'webclient', client_kind: 'webclient' } as never;

  // The owner connected a Gmail account (the app's credentials, the grant).
  createOAuthAppConfigStore(storage.db!, { getEncryptionKey: app.keys!.keyProvider('server-data') })
    .setIssuer('google', 'client-id', 'client-secret');
  await storage.accountStore!.set('gmail.work.access_token', 'at');
  await storage.accountStore!.set('gmail.work.refresh_token', 'rt');
  await storage.accountStore!.set('gmail.work.expires_at', String(Date.now() + 3_600_000));
  collection.mailStack!.instances.upsert({
    platform: 'mail',
    slug: 'work',
    adapter_type: 'gmail',
    config: { account_email: OWNER },
    caps: {},
    auth_state: 'healthy',
    last_synced_at: null,
  } as never);

  // The owner's templates, through the rpc the webclient calls.
  for (const definition of templates) {
    await screens['mail_fact.template.create']({ definition }, client);
  }

  // The recipes are installed; their triggers start off, and the owner
  // switches each on.
  for (const recipe of recipes) storage.recipeStore.save(recipe, 'local', 'inline');
  await opts.beforeTriggers?.({ mailStack: collection.mailStack! });
  const triggers = composeEventTriggers({
    db: storage.db,
    warehouseBus: app.warehouseBus,
    executeDeps: execution.executeDeps,
    auditLog: storage.auditLog,
    eventBus: storage.eventBus,
    localManifestStore: undefined,
    onFired: linkMailFactRuns(facts),
    // As compose-listeners wires it: a row made here knows every kind here.
    mailFactTypes: () => facts.listCustomTypes(),
  })!;
  const rows = new Map<string, string>();
  for (const recipe of recipes) {
    const row = triggers.store.list().find((t) => t.recipe_id === recipe.recipe_id);
    expect(row?.enabled).toBe(false);
    await handleTriggersUpdate(triggers.triggersDeps, { trigger_id: row!.trigger_id, enabled: true });
    rows.set(recipe.recipe_id, row!.trigger_id);
  }
  // As compose-listeners does once the dispatcher (and the pre-approval
  // driver) are there: the fact events held until then go out.
  await collection.mailFactEvents.open(() => triggers.dispatcher.room());

  const fired = async () =>
    (await storage.auditLog!.listActivities()).filter((a) => a.action === 'trigger_fired');
  const close = async (): Promise<void> => {
    triggers.dispatcher.dispose();
    await collection.mailStack!.disposeAll();
    storage.db?.close();
  };
  return { storage, collection, facts, screens, client, triggers, mailStack: collection.mailStack!, rows, fired, close };
};

const recipe = (
  recipe_id: string,
  trigger: Record<string, unknown>,
  steps: Record<string, unknown>[],
): RecipeDefinition => ({
  recipe_id,
  version: 1,
  ttl: 0,
  metadata: { name: recipe_id, description: `Test recipe ${recipe_id}.`, author: 'test', supported_platforms: [] },
  variables: {},
  event_triggers: [trigger],
  prefetch_steps: [],
  steps,
  output: { sidebar: [] },
}) as unknown as RecipeDefinition;

// ── Slice 1 ────────────────────────────────────────────────────────────

const upsTemplate: MailTemplateDefinition = {
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
    {
      target: { variable: 'state' },
      source: 'subject',
      find: {
        kind: 'keyword_map',
        cases: [
          { contains: 'Delivered', value: 'delivered' },
          { contains: 'On the way', value: 'in_transit' },
        ],
      },
    },
  ],
  html: false,
  ai: { enabled: false },
};

/** Wakes when a parcel is delivered, and reads the parcel through the kernel.
 *  Each `fail_on` holds the run unless it read the delivered parcel it was woken
 *  for — so only a correct read ends `completed`. */
const parcelDelivered = recipe(
  'd315-parcel-delivered',
  { on: 'mail_fact', fields: ['state'], where: { state: 'delivered' } },
  [
    {
      id: 'parcel',
      op: 'core.mail.fact.get',
      args: { id: '{{context.event.payload.record_id}}' },
      fail_on: '{{step.parcel.thing.variables.state}} not_equal delivered',
    },
    {
      id: 'tracking',
      transform: 'coalesce',
      values: ['{{step.parcel.thing.variables.tracking_number}}'],
      fail_on: `{{step.tracking}} not_equal ${TRACKING}`,
    },
  ],
);

describe('D-315 slice 1, live', () => {
  it('a delivered parcel read from a real mailbox runs the recipe subscribed to it', async () => {
    const live = await bootLive([parcelDelivered], [upsTemplate]);
    try {
      // First sync: the backfill finds a parcel on the way. Past mail: its fact
      // is stored and triggers nothing.
      const mailbox: GmailMessage[] = [{ id: 'g1', subject: 'UPS Update: On the way', at: Date.now() - 2 * DAY }];
      scriptGmail(mailbox);
      await live.mailStack.startAll();
      await live.triggers.dispatcher.drained();
      expect(live.facts.listFacts()).toHaveLength(1);
      const [thing] = live.facts.listThings() as MailFactThing[];
      expect(thing?.variables).toMatchObject({ carrier: 'UPS', tracking_number: TRACKING, state: 'in_transit' });

      // The server restarts; the delivery notice arrived while it was down. It is
      // news, and the parcel's state changes to delivered.
      await live.mailStack.pauseSync();
      mailbox.push({ id: 'g2', subject: 'UPS Update: Delivered', at: Date.now() - 60_000 });
      await live.mailStack.resumeSync();
      await live.triggers.dispatcher.drained();

      expect(live.facts.getThing(thing!.thing_id)?.variables.state).toBe('delivered');
      const fired = await live.fired();
      expect(fired).toHaveLength(1);
      expect(fired[0]).toMatchObject({
        target: `${live.rows.get(parcelDelivered.recipe_id)!}|${thing!.thing_id}`,
        detail: 'completed',
        recipe_id: parcelDelivered.recipe_id,
      });
      // The link names the run the recipe actually made.
      const run = await live.storage.auditLog!.get(fired[0]!.run_id!);
      expect(run).toMatchObject({ recipe_id: parcelDelivered.recipe_id, trigger_source: 'event_trigger' });

      // Deleting the email takes its fact along; the parcel goes back to what
      // the remaining email says, silently.
      const mail = live.collection.collectionRegistry.get('mail', 'work')!;
      expect(mail.delete(mailRecordId('g2'))).toBe(true);
      expect(live.facts.listFacts()).toHaveLength(1);
      expect(live.facts.getThing(thing!.thing_id)?.variables.state).toBe('in_transit');
      await live.triggers.dispatcher.drained();
      expect(await live.fired()).toHaveLength(1);
    } finally {
      await live.close();
    }
  }, 60_000);
});

describe('D-315 — a restart’s scan (§5)', () => {
  it('runs the recipe for mail that came while the server was down, though its trigger subscribes after the scan', async () => {
    const live = await bootLive([parcelDelivered], [upsTemplate], {
      // As the server boots: the mailbox, synced before, starts, and its scan
      // reads the delivery notice that came while the server was down — news —
      // before the trigger dispatcher subscribes.
      beforeTriggers: async ({ mailStack }) => {
        mailStack.instances.markBackfillComplete('mail', 'work');
        scriptGmail([{ id: 'g1', subject: 'UPS Update: Delivered', at: Date.now() - 60_000 }]);
        await mailStack.startAll();
      },
    });
    try {
      expect(live.facts.factRecordsForEmail({ slug: 'work', record_id: mailRecordId('g1') })).toMatchObject([{ announced: true }]);
      await live.triggers.dispatcher.drained();
      const fired = await live.fired();
      expect(fired).toMatchObject([{ detail: 'completed', recipe_id: parcelDelivered.recipe_id }]);
      const run = await live.storage.auditLog!.get(fired[0]!.run_id!);
      expect(run).toMatchObject({ trigger_source: 'event_trigger' });
    } finally {
      await live.close();
    }
  }, 60_000);
});

// ── Slice 2 ────────────────────────────────────────────────────────────

/** A shop's shipping notice whose only parcel is in its schema.org markup. */
const shippingNotice = (id: string, at: number): string =>
  [
    'From: "The Shop" <orders@shop.example>',
    `To: ${OWNER}`,
    'Subject: Your order has shipped',
    `Message-ID: <${id}@shop.example>`,
    `Date: ${new Date(at).toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Your order has shipped.',
    '--b1',
    'Content-Type: text/html; charset=utf-8',
    '',
    `<html><head><script type="application/ld+json">${JSON.stringify({
      '@context': 'http://schema.org',
      '@type': 'ParcelDelivery',
      carrier: { '@type': 'Organization', name: 'FedEx' },
      trackingNumber: FEDEX,
      partOfOrder: { '@type': 'Order', orderNumber: 'A-77', merchant: { '@type': 'Organization', name: 'The Shop' } },
    })}</script></head><body><p>Your order has shipped.</p></body></html>`,
    '--b1--',
    '',
  ].join('\r\n');

/** The owner, mailing their own `+remind` address. */
const toSelf = (id: string, at: number): string =>
  [
    `From: Me <${OWNER}>`,
    'To: me+remind@owner.example',
    'Subject: water the plants',
    `Message-ID: <${id}@owner.example>`,
    `Date: ${new Date(at).toUTCString()}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Every Sunday.',
    '',
  ].join('\r\n');

// No kind: a tracking number is what a shipment has, and a request does not.
const anyShipment = recipe('d315-any-shipment', { on: 'mail_fact', fields: ['tracking_number'] }, [
  { id: 'parcel', op: 'core.mail.fact.get', args: { id: '{{context.event.payload.record_id}}' } },
  {
    id: 'tracking',
    transform: 'coalesce',
    values: ['{{step.parcel.thing.variables.tracking_number}}'],
    fail_on: `{{step.tracking}} not_equal ${FEDEX}`,
  },
]);

// A shipment has no tag: strict across kinds, it never wakes this one.
const remind = recipe('d315-remind', { on: 'mail_fact', where: { tag: 'remind' } }, [
  {
    id: 'request',
    op: 'core.mail.fact.get',
    args: { id: '{{context.event.payload.record_id}}' },
    fail_on: '{{step.request.thing.variables.tag}} not_equal remind',
  },
]);

describe('D-315 slice 2, live — with no template', () => {
  it('a parcel in a shop’s markup and a request mailed to one’s own +tag each run their recipe; a forged one does not', async () => {
    const live = await bootLive([anyShipment, remind]);
    try {
      const mailbox: GmailMessage[] = [];
      scriptGmail(mailbox);
      await live.mailStack.startAll();
      await live.triggers.dispatcher.drained();

      await live.mailStack.pauseSync();
      const now = Date.now();
      mailbox.push(
        { id: 'p1', at: now - 60_000, raw: shippingNotice('p1', now - 60_000) },
        // Sent to oneself: Gmail stores one message with both labels.
        { id: 'r1', at: now - 30_000, labels: ['SENT', 'INBOX'], raw: toSelf('r1', now - 30_000) },
        // Anyone can write the owner's address in From: it arrives in the inbox
        // only, and the provider's record says the account did not send it.
        { id: 'f1', at: now - 20_000, labels: ['INBOX'], raw: toSelf('f1', now - 20_000) },
      );
      await live.mailStack.resumeSync();
      await live.triggers.dispatcher.drained();

      const shipments = live.facts.listFacts({ type: 'shipment' });
      expect(shipments).toHaveLength(1);
      expect(shipments[0]).toMatchObject({ template_id: null, passes: { tracking_number: 'standard' } });
      expect(shipments[0]?.variables).toMatchObject({ carrier: 'FedEx', tracking_number: FEDEX, order_id: 'A-77' });
      const requests = live.facts.listFacts({ type: 'owner_request' });
      expect(requests.map((r) => r.variables.message_id)).toEqual(['r1@owner.example']);

      const fired = await live.fired();
      expect(fired.map((f) => [f.recipe_id, f.detail]).sort()).toEqual([
        ['d315-any-shipment', 'completed'],
        ['d315-remind', 'completed'],
      ]);
      expect(fired.find((f) => f.recipe_id === 'd315-remind')?.target)
        .toBe(`${live.rows.get('d315-remind')!}|${requests[0]!.thing_id}`);
    } finally {
      await live.close();
    }
  }, 60_000);
});

// ── Slice 3 ────────────────────────────────────────────────────────────

describe('D-315 slice 3, live — what the screens read', () => {
  it('the facts list shows each email’s fact, with the run on the row of the email that started it', async () => {
    const live = await bootLive([parcelDelivered], [upsTemplate]);
    const broadcast: string[] = [];
    // From cursor 0: the owner's template was created while the server booted.
    live.storage.eventBus!.subscribe('screens', { kinds: ['mail_fact'], cursor_since: 0 }, (event) => {
      if (event.kind === 'mail_fact') broadcast.push(event.subkind);
    });
    try {
      const mailbox: GmailMessage[] = [{ id: 'g1', subject: 'UPS Update: On the way', at: Date.now() - 2 * DAY }];
      scriptGmail(mailbox);
      await live.mailStack.startAll();
      await live.triggers.dispatcher.drained();
      await live.mailStack.pauseSync();
      const deliveredAt = Date.now() - 60_000;
      mailbox.push({ id: 'g2', subject: 'UPS Update: Delivered', at: deliveredAt });
      await live.mailStack.resumeSync();
      await live.triggers.dispatcher.drained();
      const [fired] = await live.fired();
      expect(fired).toMatchObject({ detail: 'completed' });

      const { rows } = await live.screens['mail_fact.facts.list'](undefined, live.client);
      expect(rows.map((row) => row.email?.subject)).toEqual(['UPS Update: Delivered', 'UPS Update: On the way']);
      const [delivered, onTheWay] = rows;
      // Both emails are about one parcel; the run is the delivery's.
      expect(delivered!.thing?.thing_id).toBe(onTheWay!.thing?.thing_id);
      expect(delivered).toMatchObject({
        email: {
          slug: 'work',
          record_id: mailRecordId('g2'),
          from: 'pkginfo@ups.com',
          goes_at: delivered!.email!.at + 365 * DAY,
        },
        thing: { variables: { state: 'delivered' } },
        of_email: { index: 1, count: 1 },
        runs: [{
          recipe_id: parcelDelivered.recipe_id,
          recipe_name: parcelDelivered.recipe_id,
          run_id: fired!.run_id,
          outcome: 'completed',
          status: 'succeeded',
        }],
      });
      expect(onTheWay!.runs).toEqual([]);
      expect(Math.abs(delivered!.email!.at - deliveredAt)).toBeLessThan(1_000);

      // The mail detail view's actions read the stored email.
      await expect(live.screens['mail_fact.email.get']({ slug: 'work', record_id: mailRecordId('g2') }, live.client))
        .resolves.toEqual({ fact_count: 1, security_notice: false });

      // The editor reads the email again from Gmail itself (`format=raw`): the
      // sender's name, which the stored row does not keep, comes back.
      const content = await live.screens['mail_fact.email.read']({ slug: 'work', record_id: mailRecordId('g2') }, live.client);
      expect(content).toMatchObject({ read: 'provider', from_name: 'UPS', email: { subject: 'UPS Update: Delivered' } });
      expect(content.body_text).toContain(`Tracking Number: ${TRACKING}`);
      // Preview over the real mailbox: the source, then the other UPS email.
      const preview = await live.screens['mail_fact.template.preview'](
        { definition: upsTemplate, source: { email: { slug: 'work', record_id: mailRecordId('g2') } } },
        live.client,
      );
      expect(preview.source).toMatchObject({ read: 'provider', outcome: 'entered' });
      expect(preview.source?.facts[0]?.variables).toMatchObject({ state: 'delivered', tracking_number: TRACKING });
      expect(preview.recent.map((r) => [r.email?.subject, r.read, r.outcome])).toEqual([
        ['UPS Update: On the way', 'provider', 'entered'],
      ]);

      // The screens were told: templates at once (the owner's create), facts
      // within the announcer's second.
      await new Promise((r) => { setTimeout(r, 1_200); });
      expect(broadcast).toContain('templates');
      expect(broadcast).toContain('facts');

      // Deleting the email takes its run link along with its fact.
      live.collection.collectionRegistry.get('mail', 'work')!.delete(mailRecordId('g2'));
      expect(live.facts.runsForEmail({ slug: 'work', record_id: mailRecordId('g2') })).toEqual([]);
    } finally {
      live.storage.eventBus!.unsubscribe('screens');
      await live.close();
    }
  }, 60_000);

  it('a backfill reads mail that came before its template, and a recipe it runs is stamped as a backfill', async () => {
    // No template yet: the mailbox's first sync stores the email.
    const live = await bootLive([parcelDelivered]);
    try {
      scriptGmail([{ id: 'g1', subject: 'UPS Update: Delivered', at: Date.now() - 2 * DAY }]);
      await live.mailStack.startAll();
      await live.triggers.dispatcher.drained();
      expect(await live.fired()).toEqual([]);

      // The owner makes the template now, and asks for the past mail, recipes included.
      const { template } = await live.screens['mail_fact.template.create']({ definition: upsTemplate }, live.client);
      const job = await live.screens['mail_fact.backfill.start'](
        { template_id: template.template_id, days: 30, run_recipes: true },
        live.client,
      );
      expect(job).toMatchObject({ status: 'running', run_recipes: true });
      await vi.waitFor(async () => {
        expect((await live.screens['mail_fact.backfill.get'](undefined, live.client)).job?.status).toBe('done');
      });
      await live.triggers.dispatcher.drained();
      expect((await live.screens['mail_fact.backfill.get'](undefined, live.client)).job)
        .toMatchObject({ total: 1, read: 1, stored_copies: 0 });

      const [fired] = await live.fired();
      expect(fired).toMatchObject({ detail: 'completed', recipe_id: parcelDelivered.recipe_id });
      const run = await live.storage.auditLog!.get(fired!.run_id!);
      expect(run).toMatchObject({ trigger_source: 'backfill', run_mode: 'backfill' });
    } finally {
      await live.close();
    }
  }, 60_000);

  it('the server composition wires what these proofs wire', () => {
    const source = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '..', 'serve/compose-listeners.ts'),
      'utf-8',
    );
    expect(source).toMatch(/mailFactRpcDeps: mailFactScreensRpcDeps\(\{\s*store: storage\.mailFactStoreRef,/);
    expect(source).toContain('onFired: linkMailFactRuns(\n            storage.mailFactStoreRef,');
    expect(source).toContain('writer: collection.mailFactWriter');
    // A backfill that runs recipes waits for the AI's answer to one email
    // before the next, through the AI pass the collection context built.
    expect(source).toContain('aiSettled: collection.mailFactAiSettled,');
    // A backfill that runs recipes waits for room in the trigger queue, and a
    // run the pre-approval recovery clock starts goes on the dispatcher's books.
    expect(source).toContain('triggerRoom: () => eventTriggersBundle.dispatcher.room()');
    expect(source).toContain('settleRecoveredTrigger: eventTriggersBundle.settleRecovered');
    // An AI answer that may start recipes waits for room in the same queue.
    expect(source).toContain('collection.mailFactTriggerRoom.current = () => eventTriggersBundle.dispatcher.room();');
    // The fact events held since the mailboxes started go out once the
    // dispatcher is subscribed and the pre-approval driver is there: after
    // both are composed, and once.
    const opens = [...source.matchAll(/collection\.mailFactEvents\.open\(/g)];
    expect(opens).toHaveLength(1);
    expect(source).toContain('void collection.mailFactEvents.open(eventTriggersBundle ? () => eventTriggersBundle.dispatcher.room() : undefined);');
    expect(opens[0]!.index!).toBeGreaterThan(source.indexOf('const eventTriggersBundle = composeEventTriggers('));
    expect(opens[0]!.index!).toBeGreaterThan(source.indexOf('await storage.preapprovalStorage!.recover()'));
    const preapproval = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '..', 'composition/bin/wire-preapproval.ts'),
      'utf-8',
    );
    expect(preapproval).toContain('settleRecovered: deps.settleRecoveredTrigger');
    // Slice 4: the AI pass calls through the chat's privacy layer.
    const post = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '..', 'serve/start-post-storage-app-collection-execution-runtime.ts'),
      'utf-8',
    );
    expect(post).toContain('privateAiCall: app.privateAiCall');
    // What a restart left queued is resumed only once the mailboxes are live:
    // any sooner, every job would find its email "gone".
    const collectionSource = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '..', 'serve/compose-collection-context.ts'),
      'utf-8',
    );
    const started = collectionSource.indexOf('registerMailCollections(mailStack, collectionRegistry);');
    const resume = collectionSource.indexOf('mailFactAi?.kick();', started);
    expect(started).toBeGreaterThan(0);
    expect(resume - started).toBeGreaterThan(0);
    expect(resume - started).toBeLessThan(300);
    // The only other kick is the writer's, after a commit that queued a call.
    expect([...collectionSource.matchAll(/mailFactAi\??\.kick\(\)/g)]).toHaveLength(2);
    expect(collectionSource).toContain('onAiQueued: () => mailFactAi?.kick()');
    expect(collectionSource).toContain('mailFactAiSettled: (email: MailFactEmailRef) => mailFactAi?.untilSettled(email) ?? Promise.resolve(0),');
    expect(collectionSource).toContain('triggerRoom: () => mailFactTriggerRoom.current?.() ?? Promise.resolve()');
    // The writer emits through the hold, never straight onto the bus.
    expect(collectionSource).toContain('emit: mailFactEvents.emit,');
    expect(collectionSource).not.toMatch(/createMailFactWriter\(\{[^}]*emit: \(event\) => warehouseBus\.emit/);
    // The sweep of emails a live mailbox no longer holds runs then too.
    const sweep = collectionSource.indexOf('void sweepGoneEmails(', started);
    expect(sweep - started).toBeGreaterThan(0);
    expect(sweep - started).toBeLessThan(600);
    // Slice 5: a row made here is checked against every kind here, the owner's included.
    expect(source).toContain('mailFactTypes: () => storage.mailFactStoreRef!.listCustomTypes()');
    expect(source).toContain('...(app.privateAiCall ? { privateAiCall: app.privateAiCall } : {})');
  });
});

// ── Slice 4 ────────────────────────────────────────────────────────────

const shopOrder = (id: string, at: number): string =>
  [
    'From: "Shop Orders" <orders@shop.example>',
    `To: ${OWNER}`,
    'Subject: Your order A-1',
    `Message-ID: <${id}@shop.example>`,
    `Date: ${new Date(at).toUTCString()}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Thank you for your order A-1.',
    'Total: EUR 12,50',
    'Questions? Write to orders@shop.example.',
    '',
  ].join('\r\n');

/** The rules read the merchant; the order id — its identity — and the total
 *  are the AI's, as the template allows (ruling 39). */
const shopTemplate: MailTemplateDefinition = {
  name: 'Shop orders',
  type: 'purchase',
  entrance: { conditions: [{ field: 'from', op: 'is', value: 'orders@shop.example' }], variables: [] },
  rules: [{ target: { variable: 'merchant' }, source: 'from_name', find: { kind: 'whole' } }],
  html: false,
  ai: { enabled: true, prompt: 'Order confirmations from the shop.', slots: ['order_id', 'total'], pool: 'free_only' },
};

/** Runs only when it reads the order the AI read. */
const orderPlaced = recipe(
  'd315-order-placed',
  { on: 'mail_fact', fields: ['order_id'] },
  [
    {
      id: 'order',
      op: 'core.mail.fact.get',
      args: { id: '{{context.event.payload.record_id}}' },
      fail_on: '{{step.order.thing.variables.order_id}} not_equal A-1',
    },
  ],
);

describe('D-315 slice 4, live — the AI pass', () => {
  it('reads what the rules left, through the chat’s privacy layer, and only then starts the recipe', async () => {
    const live = await bootLive([orderPlaced], [shopTemplate]);
    try {
      // The owner's free model.
      createLLMConfigManager(live.storage.db!).upsertPoolEntry({
        id: 'free-1', type: 'api', provider: 'openai-compatible', model: 'test-model', api_key: 'k',
        base_url: LLM_BASE_URL, speed: 'quality', supports_json: true, enabled: true,
      });
      const sent: string[] = [];
      const mailbox: GmailMessage[] = [];
      scriptGmail(mailbox, (body) => {
        sent.push(body);
        return { facts: [{ position: 0, values: { order_id: 'A-1', total: 'EUR 12,50' } }] };
      });
      await live.mailStack.startAll();
      await live.mailStack.pauseSync();
      const at = Date.now() - 60_000;
      mailbox.push({ id: 'o1', at, raw: shopOrder('o1', at) });
      await live.mailStack.resumeSync();
      await vi.waitFor(() => expect(live.facts.countAiJobs()).toBe(0), { timeout: 15_000 });
      await live.triggers.dispatcher.drained();

      // One call, for the one email: it read the order, and never the
      // shop's address, which went aliased wherever it appeared.
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain('order A-1');
      expect(sent[0]).not.toContain('orders@shop.example');
      const [fact] = live.facts.listFacts();
      expect(fact).toMatchObject({
        ai: { state: 'read', filled: ['order_id', 'total'] },
        passes: { merchant: 'rule', order_id: 'ai', total: 'ai' },
        variables: expect.objectContaining({ merchant: 'Shop Orders', order_id: 'A-1' }),
      });
      // The thing was found after the AI, and the recipe read what it filled.
      const [fired] = await live.fired();
      expect(fired).toMatchObject({ detail: 'completed', recipe_id: orderPlaced.recipe_id });
    } finally {
      await live.close();
    }
  }, 60_000);

  it('drafts a template from the email the owner chose, through the same seam, and maps it back', async () => {
    const live = await bootLive([]);
    try {
      createLLMConfigManager(live.storage.db!).upsertPoolEntry({
        id: 'free-1', type: 'api', provider: 'openai-compatible', model: 'test-model', api_key: 'k',
        base_url: LLM_BASE_URL, speed: 'quality', supports_json: true, enabled: true,
      });
      const sent: string[] = [];
      scriptGmail([], (body) => {
        sent.push(body);
        // The model writes the sender as it was shown it: aliased.
        const shown = /m\d+@d\d+\.invalid/.exec(body)?.[0] ?? 'missing';
        return {
          type: 'purchase',
          name: 'Shop orders',
          entrance: { conditions: [{ field: 'from', op: 'is', value: shown }], variables: ['order_id'] },
          rules: [
            { target: { variable: 'merchant' }, source: 'from_name', find: { kind: 'whole' } },
            { target: { variable: 'order_id' }, source: 'subject', find: { kind: 'pattern', pattern: 'order (\\S+)' } },
          ],
        };
      });
      const result = await live.screens['mail_fact.template.draft']({
        source: {
          sample: {
            from: 'Shop Orders <orders@shop.example>',
            subject: 'Your order A-1',
            body: 'Thank you for your order A-1.\nQuestions? Write to orders@shop.example.',
          },
        },
      }, live.client);
      expect(sent).toHaveLength(1);
      expect(sent[0]).not.toContain('orders@shop.example');
      // Mapped back: the condition names the real sender; nothing was saved.
      expect(result.dropped).toEqual([]);
      expect(result.definition).toMatchObject({
        type: 'purchase',
        ai: { enabled: false },
        entrance: { conditions: [{ field: 'from', op: 'is', value: 'orders@shop.example' }], variables: ['order_id'] },
      });
      expect(live.facts.listTemplates()).toEqual([]);
    } finally {
      await live.close();
    }
  }, 60_000);
});

describe('D-315 §6.3, live — a backfill tells each email as it came, the AI’s answers included', () => {
  it('an older notice the AI completes is told before a newer one the rules read whole', async () => {
    const read = [{ id: 'parcel', op: 'core.mail.fact.get', args: { id: '{{context.event.payload.record_id}}' } }];
    const stateWatch = recipe('d315-state-watch', { on: 'mail_fact.shipment', fields: ['state'] }, read);
    // No template yet: the mailbox's first sync stores the mail.
    const live = await bootLive([stateWatch]);
    try {
      createLLMConfigManager(live.storage.db!).upsertPoolEntry({
        id: 'free-1', type: 'api', provider: 'openai-compatible', model: 'test-model', api_key: 'k',
        base_url: LLM_BASE_URL, speed: 'quality', supports_json: true, enabled: true,
      });
      const older = Date.now() - 3 * DAY;
      const newer = Date.now() - DAY;
      const delivered = upsNotice({ id: 'g2', subject: 'UPS Update: Delivered', at: newer })
        .replace(`Tracking Number: ${TRACKING}`, `Tracking Number: ${TRACKING}\r\nNote: left at the door`);
      // The older notice has no note: the AI fills it. It answers once the
      // newer email is read — or, when nothing reads it first, a moment later.
      scriptGmail([
        { id: 'g1', subject: 'UPS Update: On the way', at: older },
        { id: 'g2', at: newer, raw: delivered },
      ], async () => {
        const until = Date.now() + 500;
        while (live.facts.factsForEmail({ slug: 'work', record_id: mailRecordId('g2') }).length === 0 && Date.now() < until) {
          await new Promise((resolve) => { setTimeout(resolve, 10); });
        }
        return { facts: [{ position: 0, values: { 'data.note': 'arriving soon' } }] };
      });
      await live.mailStack.startAll();
      await live.triggers.dispatcher.drained();
      expect(await live.fired()).toEqual([]);

      const { template } = await live.screens['mail_fact.template.create']({
        definition: {
          ...upsTemplate,
          rules: [...upsTemplate.rules, { target: { data: 'note' }, source: 'body', find: { kind: 'after_label', label: 'Note:' } }],
          ai: { enabled: true, prompt: 'Fill the delivery note.', slots: ['data.note'], pool: 'free_only' },
        },
      }, live.client);
      await live.screens['mail_fact.backfill.start']({ template_id: template.template_id, days: 30, run_recipes: true }, live.client);
      await vi.waitFor(async () => {
        expect((await live.screens['mail_fact.backfill.get'](undefined, live.client)).job?.status).toBe('done');
      }, { timeout: 15_000 });
      await live.triggers.dispatcher.drained();

      // In transit, then delivered: the recipe watching the state woke for each.
      const [thing] = live.facts.listThings() as MailFactThing[];
      expect(thing?.variables.state).toBe('delivered');
      expect((await live.screens['mail_fact.backfill.get'](undefined, live.client)).job).toMatchObject({ read: 2, events: 2 });
      const runs = (await live.fired()).filter((f) => f.recipe_id === stateWatch.recipe_id && f.detail === 'completed');
      expect(runs).toHaveLength(2);
    } finally {
      await live.close();
    }
  }, 60_000);
});

// ── Slice 5 ────────────────────────────────────────────────────────────

describe('D-315 rulings 43 and 44, live — every email, or only a change', () => {
  it('a repeat “on the way” wakes the recipe that asked for every email, and not the one watching the state', async () => {
    const read = [{ id: 'parcel', op: 'core.mail.fact.get', args: { id: '{{context.event.payload.record_id}}' } }];
    const everyEmail = recipe('d315-every-email', { on: 'mail_fact.shipment', fields: ['last_email_at'] }, read);
    const stateWatch = recipe('d315-state-watch', { on: 'mail_fact.shipment', fields: ['state'] }, read);
    const everyChange = recipe('d315-every-change', { on: 'mail_fact.shipment' }, read);
    const live = await bootLive([everyEmail, stateWatch, everyChange], [upsTemplate]);
    try {
      const mailbox: GmailMessage[] = [];
      scriptGmail(mailbox);
      await live.mailStack.startAll();
      for (const [id, ago] of [['g1', 120_000], ['g2', 60_000]] as const) {
        await live.mailStack.pauseSync();
        mailbox.push({ id, subject: 'UPS Update: On the way', at: Date.now() - ago });
        await live.mailStack.resumeSync();
        await live.triggers.dispatcher.drained();
      }
      const [thing] = live.facts.listThings() as MailFactThing[];
      expect(live.facts.listFacts()).toHaveLength(2);
      expect(thing?.variables.state).toBe('in_transit');
      const fired = await live.fired();
      const runs = (recipe_id: string) => fired.filter((f) => f.recipe_id === recipe_id && f.detail === 'completed');
      // The first email is news to all three; the repeat, only to the one that asked.
      expect(runs('d315-every-email')).toHaveLength(2);
      expect(runs('d315-state-watch')).toHaveLength(1);
      expect(runs('d315-every-change')).toHaveLength(1);
      expect(fired).toHaveLength(4);
    } finally {
      await live.close();
    }
  }, 60_000);
});

describe('D-315 slice 5, live — a kind of email the owner made', () => {
  it('is made and read by its template, and starts both a recipe’s own trigger and the row Automation made', async () => {
    // A recipe installed BEFORE the kind exists, watching a variable only the
    // kind will have: a trigger watches variables, never a kind (ruling 42).
    const boxWatched = recipe('d315-box-watched', { on: 'mail_fact', fields: ['box_id'] }, [{
      id: 'box',
      op: 'core.mail.fact.get',
      args: { id: '{{context.event.payload.record_id}}' },
      fail_on: '{{step.box.thing.variables.box_id}} not_equal WB-1204',
    }]);
    const live = await bootLive([boxWatched]);
    try {
      // The owner makes the kind, and a template that reads it.
      await live.screens['mail_fact.type.create']({
        spec: {
          id: 'custom_wine_club_box',
          name: 'Wine club box',
          description: 'A box from the wine club.',
          variables: [
            { name: 'club', kind: 'text', required: true },
            { name: 'box_id', kind: 'id', required: true },
          ],
          states: ['shipped', 'delivered'],
          notices: [],
          identity: [['club', 'box_id']],
        },
      }, live.client);
      await live.screens['mail_fact.template.create']({
        definition: {
          name: 'The club',
          type: 'custom_wine_club_box',
          entrance: { conditions: [{ field: 'from', op: 'is', value: 'boxes@club.example' }], variables: ['club', 'box_id'] },
          rules: [
            { target: { variable: 'club' }, source: 'from_name', find: { kind: 'whole' } },
            { target: { variable: 'box_id' }, source: 'body', find: { kind: 'after_label', label: 'Box:' } },
            { target: { variable: 'state' }, source: 'subject', find: { kind: 'keyword_map', cases: [{ contains: 'shipped', value: 'shipped' }] } },
          ],
          html: false,
          ai: { enabled: false },
        },
      }, live.client);

      // A recipe that runs only when it reads the box it was woken for, and
      // the row Automation makes for it: a state only the owner's kind has,
      // which this server's check knows now.
      const boxShipped = recipe('d315-box-shipped', {}, [{
        id: 'box',
        op: 'core.mail.fact.get',
        args: { id: '{{context.event.payload.record_id}}' },
        fail_on: '{{step.box.thing.variables.box_id}} not_equal WB-1204',
      }]);
      delete (boxShipped as { event_triggers?: unknown }).event_triggers;
      live.storage.recipeStore.save(boxShipped, 'local', 'inline');
      const { trigger } = await handleTriggersCreate(live.triggers.triggersDeps, {
        recipe_id: boxShipped.recipe_id, publisher_id: 'local',
        on: 'mail_fact', fields: ['state'], where: { state: 'shipped' },
      });
      expect(trigger).toMatchObject({ pattern: MAIL_FACT_EVENT_PATTERN, enabled: true });

      const mailbox: GmailMessage[] = [];
      scriptGmail(mailbox);
      await live.mailStack.startAll();
      await live.mailStack.pauseSync();
      const at = Date.now() - 60_000;
      mailbox.push({
        id: 'b1',
        at,
        raw: [
          'From: "The Wine Club" <boxes@club.example>',
          `To: ${OWNER}`,
          'Subject: Your box has shipped',
          'Message-ID: <b1@club.example>',
          `Date: ${new Date(at).toUTCString()}`,
          'Content-Type: text/plain; charset=utf-8',
          '',
          'Box: WB-1204',
          '',
        ].join('\r\n'),
      });
      await live.mailStack.resumeSync();
      await live.triggers.dispatcher.drained();

      const [thing] = live.facts.listThings() as MailFactThing[];
      expect(thing).toMatchObject({ type: 'custom_wine_club_box', variables: expect.objectContaining({ club: 'The Wine Club', box_id: 'WB-1204', state: 'shipped' }) });
      const fired = await live.fired();
      expect(fired.map((f) => [f.recipe_id, f.detail, f.target]).sort()).toEqual([
        [boxShipped.recipe_id, 'completed', `${trigger.trigger_id}|${thing!.thing_id}`],
        [boxWatched.recipe_id, 'completed', `${live.rows.get(boxWatched.recipe_id)!}|${thing!.thing_id}`],
      ]);
    } finally {
      await live.close();
    }
  }, 60_000);
});
