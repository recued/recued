/** D-177 §N.15.8 — "Allow in this chat" on the gateway's holds.
 *
 *  The owner, 2026-11-10: the answer reuses the names the system already shows (§N.15.6 ruling 3),
 *  every op follows its own approval (ruling 2), and Q7's "never an hour of sending" is dropped
 *  (ruling 4). So a held send in the owner's chat offers "Allow in this chat" naming "Send an email",
 *  in place of "Allow this session"; answered so, the chat's next emails go without asking, for the
 *  hour and up to 100.
 *
 *  Driven, not read: the shipped send-composed-mail recipe, the bundled mail-send manifest, the real
 *  commit gateway, the real notification block and answer path, and the real session-grant store.
 *  Only the delivery is recorded instead of sent. */

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  D165_CONTRACT_SCHEMA, KIND_GRANT_OPTION_ID, readKindGrantOffer,
  type Checkpoint, type Commit, type ExecutionSource, type IngredientManifest, type RecipeDefinition,
} from '@recued/contracts';
import { registerPreflightHandler } from '@recued/gateway';
import {
  createAuditLogStore, createCommitStore, createInMemoryCollection,
  type ActivityEntry, type AuditEntry, type AuditLogStore, type CheckpointStore,
} from '@recued/storage';
import {
  createAskStore, createNotificationBlock, createNotificationSettingsStore, createUiChannel,
  type NotificationSettings, type PendingAsk,
} from '@recued/notification';

import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import { gatewayKindGrantOffer } from '../kind-grants.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createPreflightResumer } from '../preflight-resumer.js';
import { createRecipeStore } from '../recipe-store.js';
import { createSessionGrantResolver } from '../session-grant-resolver.js';
import { createContractDefinitionStore, type ContractDefinitionStore } from '../storage/contract-definition-store.js';
import { createContractStore } from '../storage/contract-store.js';
import { heldCallOpLabel } from '../trigger-preapproval-ops.js';
import { raiseRoundGather, type DeferredHold, type RoundMember } from '../chat-gather.js';

const RECIPE = JSON.parse(readFileSync(
  join(__dirname, '../../../../community/recipes/send-composed-mail.json'), 'utf8',
)) as RecipeDefinition;
/** The same recipe under another id: another recipe that sends. */
const OTHER_RECIPE = { ...RECIPE, recipe_id: 'send-another-way' } as RecipeDefinition;

const mail = (to: string, subject: string): Record<string, unknown> => ({
  sender_mail_instance: 'recueddev', to: [to], subject, body: 'hello',
  cc: [], bcc: [], body_format: 'text', attachments: [], in_reply_to: '', reply_to: '',
  reconciliation_id: null, references: [],
});

/** A recipe handed in whole for one call, as the chat's AI writes one or a vendor-neutral op is
 *  built: the call's arguments are in it, so each call is a different recipe. */
const inlineSend = (to: string, subject: string): RecipeDefinition => ({
  recipe_id: 'chat-written-send', version: 1, ttl: 0,
  metadata: { name: 'Send it', description: 'One email.', author: 'chat', supported_platforms: [] },
  variables: {}, prefetch_steps: [],
  steps: [{ id: 'send', ingredient: 'mail-send', input: { ...mail(to, subject), sender_mail_instance: 'recueddev' } }],
  output: { sidebar: [] },
} as unknown as RecipeDefinition);

const NOTE = '“Allow in this chat” stops asking about “Send an email” in this conversation, up to 100 times in the'
  + ' next hour. Its AI decides each one: what it says, and who or what it is for. You can end it sooner under'
  + ' Active passes.';

const NOW = 1_700_000_000_000;
let db: Database.Database;
let definitionStore: ContractDefinitionStore;
let nowMs: number;

beforeEach(() => {
  db = new Database(':memory:');
  nowMs = NOW;
  let seq = 0;
  const contractStore = createContractStore(db, { now: () => nowMs });
  contractStore.seedSchema(D165_CONTRACT_SCHEMA);
  definitionStore = createContractDefinitionStore(contractStore, { now: () => nowMs, newId: () => `ct_${++seq}` });
});
afterEach(() => { db.close(); });

const inMemoryCheckpointStore = (): CheckpointStore & { rows: Map<string, Checkpoint> } => {
  const rows = new Map<string, Checkpoint>();
  return {
    rows,
    write: vi.fn(async (c: Checkpoint) => { rows.set(c.checkpoint_id, c); }),
    get: vi.fn(async (id: string) => rows.get(id) ?? null),
    delete: vi.fn(async (id: string) => { rows.delete(id); }),
    listByRun: vi.fn(async (r: string) => [...rows.values()].filter((c) => c.run_id === r)),
    list: vi.fn(async () => [...rows.values()]),
    size: vi.fn(async () => rows.size),
  } as unknown as CheckpointStore & { rows: Map<string, Checkpoint> };
};

/** The owner's server, chatting in `chat-1` unless told. */
const server = () => {
  const askStore = createAskStore(createInMemoryCollection<PendingAsk>());
  const block = createNotificationBlock({
    askStore,
    channels: [createUiChannel({ busSink: () => undefined })],
    settingsStore: createNotificationSettingsStore(createInMemoryCollection<NotificationSettings>()),
  });
  const checkpoints = inMemoryCheckpointStore();
  const auditLog = createAuditLogStore(
    createInMemoryCollection<AuditEntry>(), createInMemoryCollection<ActivityEntry>(),
  ) as AuditLogStore;
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(RECIPE);
  recipeStore.register(OTHER_RECIPE);
  const sent: Array<{ to: string[]; subject: string }> = [];
  const deps = {
    recipeStore,
    executorConfig: {
      // No community dir: the registry seeds the bundled kernel manifests.
      manifests: createManifestRegistry(),
      kernelDispatchers: {
        mailSend: async (input: { to: string[]; subject: string }) => {
          sent.push({ to: input.to, subject: input.subject });
          return { source_id: 'src', message_id: `m${sent.length}`, sent_at: nowMs, _id: null, _collection: 'data.mail' as const };
        },
      },
    },
    baseVault: {},
    instanceId: 'gateway-kind-grant',
    auditLog,
    checkpointStore: checkpoints,
    preflightNotifier: block,
    // The gate's grant lookup runs only with a commit store.
    commitStore: createCommitStore(createInMemoryCollection<Commit>()),
    sessionGrantResolver: createSessionGrantResolver({ definitionStore, now: () => nowMs }),
    listSendCapableMailboxes: () => [{ name: 'recueddev', address: 'recued.dev@gmail.com', provider: 'Gmail' }],
  } as unknown as ExecuteHandlerDeps;
  registerPreflightHandler(block, {
    checkpointStore: checkpoints,
    resumer: createPreflightResumer({ getExecuteDeps: () => deps, auditLog }),
  });

  let turn = 0;
  const run = async (
    request: { recipe_id: string; config: Record<string, unknown> } | { recipe: RecipeDefinition },
    chat = 'chat-1',
    /** D-177 §N.15.9 — a round's sink: keep the hold's ask for the round's end. */
    defer_ask?: (hold: DeferredHold) => boolean,
  ) => {
    turn += 1;
    const source = {
      channel: 'chat', actor: 'user_self', chat_session_id: chat, user_id: 'owner-1', turn_id: `turn-${turn}`,
    } as ExecutionSource;
    const before = (await askStore.listByStatus('open')).length;
    const result = await handleExecute(deps, { ...request, trigger_source: 'chat', execution_source: source } as never,
      defer_ask !== undefined ? { defer_ask } : {});
    const open = await askStore.listByStatus('open');
    return {
      held: (result as { awaiting_approval?: unknown }).awaiting_approval !== undefined,
      asked: open.length > before,
      ask: open.at(-1),
    };
  };
  const answer = (ask: PendingAsk, option: string) => block.submitAnswer({ ask_id: ask.ask_id, option, via: 'ui' });
  const kindGrants = (chat = 'chat-1') => definitionStore.listSessionGrants(`chat:${chat}`)
    .filter((grant) => grant.grant_mode === 'kind');
  /** The offer the hold an ask is about keeps on its checkpoint. */
  const heldOffer = (ask: PendingAsk | undefined) => readKindGrantOffer([...checkpoints.rows.values()]
    .find((checkpoint) => checkpoint.run_id === ask?.handler_payload.run_id)?.preflight_context?.kind_grant);
  return { run, answer, kindGrants, heldOffer, sent, askStore, audit: auditLog };
};

describe('D-177 §N.15.8 — a recipe\'s held send in the owner\'s chat', () => {
  it('offers "Allow in this chat" naming "Send an email", in place of "Allow this session"', async () => {
    const s = server();
    const first = await s.run({ recipe_id: RECIPE.recipe_id, config: mail('dana@example.com', 'Minutes') });
    expect(first.held).toBe(true);
    expect(first.ask!.options.map((option) => option.label)).toEqual(['Approve', 'Allow in this chat', 'Deny']);
    expect(first.ask!.message.text).toContain(NOTE);
    expect(s.heldOffer(first.ask)).toMatchObject({
      channel: 'chat', actor: 'user_self', channel_session_id: 'chat:chat-1',
      ingredient_slug: 'mail-send', operation_id: 'mail-send', name: 'Send an email', risk_tier: 'write',
      recipe: { recipe_id: RECIPE.recipe_id }, ttl_ms: 3_600_000, max_uses: 100,
    });
  });

  it('answered so, the send goes out, and the chat\'s next sends to anyone go without asking', async () => {
    const s = server();
    const first = await s.run({ recipe_id: RECIPE.recipe_id, config: mail('dana@example.com', 'Minutes') });
    await s.answer(first.ask!, KIND_GRANT_OPTION_ID);
    await vi.waitFor(() => expect(s.sent).toHaveLength(1));
    const [grant] = s.kindGrants();
    expect(grant).toMatchObject({
      grant_kind: 'session', grant_mode: 'kind', risk_tier: 'write', display_name: 'Allowed in this chat — Send an email',
      scope: { channels: ['chat'], actors: ['user_self'], ingredient_ids: ['mail-send'], operation_ids: ['mail-send'] },
      bound_recipe: { recipe_id: RECIPE.recipe_id }, uses_remaining: 100,
    });
    // Other people, other subjects: the AI decides each one, what it says and whom it goes to.
    for (const [to, subject] of [['priya@example.com', 'Agenda'], ['omar@example.com', 'Slides'], ['lee@example.com', 'Notes']]) {
      const next = await s.run({ recipe_id: RECIPE.recipe_id, config: mail(to!, subject!) });
      expect(next.held, to).toBe(false);
      expect(next.asked, to).toBe(false);
    }
    expect(s.sent.map((m) => m.to[0])).toEqual(['dana@example.com', 'priya@example.com', 'omar@example.com', 'lee@example.com']);
    expect(s.kindGrants()[0]!.uses_remaining).toBe(97);
  });

  it('only in that conversation, and only for that recipe as it is now', async () => {
    const s = server();
    const first = await s.run({ recipe_id: RECIPE.recipe_id, config: mail('dana@example.com', 'Minutes') });
    await s.answer(first.ask!, KIND_GRANT_OPTION_ID);
    await vi.waitFor(() => expect(s.sent).toHaveLength(1));
    expect((await s.run({ recipe_id: RECIPE.recipe_id, config: mail('a@example.com', 'x') }, 'chat-2')).held).toBe(true);
    expect((await s.run({ recipe_id: OTHER_RECIPE.recipe_id, config: mail('a@example.com', 'x') })).held).toBe(true);
    // Nor does it cover the AI's own call of the same op.
    expect((await s.run({ recipe: inlineSend('a@example.com', 'x') })).held).toBe(true);
    expect(s.sent).toHaveLength(1);
  });

  it('a plain yes grants nothing: the next send asks again', async () => {
    const s = server();
    const first = await s.run({ recipe_id: RECIPE.recipe_id, config: mail('dana@example.com', 'Minutes') });
    await s.answer(first.ask!, 'approve');
    await vi.waitFor(() => expect(s.sent).toHaveLength(1));
    expect(s.kindGrants()).toEqual([]);
    expect((await s.run({ recipe_id: RECIPE.recipe_id, config: mail('dana@example.com', 'Again') })).held).toBe(true);
  });
});

describe('D-177 §N.15.8 — an inline recipe carries the AI\'s own call', () => {
  it('its grant names no recipe, and covers the next inline calls whatever their arguments', async () => {
    const s = server();
    const first = await s.run({ recipe: inlineSend('dana@example.com', 'Minutes') });
    expect(first.held).toBe(true);
    const offer = s.heldOffer(first.ask);
    expect(offer).toMatchObject({ ingredient_slug: 'mail-send', operation_id: 'mail-send', name: 'Send an email' });
    expect(offer!.recipe).toBeUndefined();
    await s.answer(first.ask!, KIND_GRANT_OPTION_ID);
    await vi.waitFor(() => expect(s.sent).toHaveLength(1));
    expect(s.kindGrants()[0]!.bound_recipe).toBeUndefined();
    // Each call is a different recipe (its arguments are in it), and each goes without asking.
    for (const to of ['priya@example.com', 'omar@example.com']) {
      expect((await s.run({ recipe: inlineSend(to, `For ${to}`) })).held, to).toBe(false);
    }
    expect(s.sent).toHaveLength(3);
    // A stored recipe's send is not the AI's own call: it asks.
    expect((await s.run({ recipe_id: RECIPE.recipe_id, config: mail('a@example.com', 'x') })).held).toBe(true);
  });
});

describe('D-177 §N.15.8 — who is offered it, and for what', () => {
  const chat = { channel: 'chat', actor: 'user_self', chat_session_id: 'c', user_id: 'u' } as ExecutionSource;
  const held = (over: Partial<Parameters<typeof gatewayKindGrantOffer>[0]> = {}) => gatewayKindGrantOffer({
    source: chat, channel_session_id: 'chat:c', ingredient_slug: 'hubspot-catalog',
    operation_id: 'recued-core/hubspot-catalog.deal.update', connection_name: 'hubspot', risk_tier: 'write',
    provenance: { pre_lift_approval: 'ask' }, single: true, resource_review: false, name: 'Update a deal', ...over,
  });

  it('the owner\'s chat and messenger chat; never the app, a schedule, an AI app or a chat under a contract', () => {
    expect(held()).toMatchObject({ operation_id: 'recued-core/hubspot-catalog.deal.update', connection_name: 'hubspot' });
    const messenger = { channel: 'messenger', actor: 'user_self', vendor: 'telegram', from: '42' } as ExecutionSource;
    expect(held({ source: messenger, channel_session_id: 'messenger:telegram:42' })?.channel).toBe('messenger');
    for (const source of [
      { channel: 'user', actor: 'user_self', user_id: 'u', client_token_id: 't' },
      { channel: 'schedule', actor: 'system', cron: '0 9 * * *', source_recipe: 'r' },
      { channel: 'mcp', actor: 'contracted_user', agent_id: 'a', tool_call_id: 'c', mcp_token_id: 't', contract_id: 'ct' },
      { ...chat, contract_id: 'ct-household' },
    ] as ExecutionSource[]) {
      expect(held({ source })).toBeUndefined();
    }
    expect(held({ source: undefined })).toBeUndefined();
  });

  it('a write held by its own approval, one call, with a name; never a delete, an always, a review or a cover', () => {
    expect(held({ provenance: { pre_lift_approval: 'never' } })).toBeDefined();
    for (const over of [
      { risk_tier: 'destructive' }, { risk_tier: 'admin' }, { risk_tier: 'read' },
      { provenance: { pre_lift_approval: 'always' } }, { provenance: undefined },
      { provenance: { pre_lift_approval: 'ask', lift_reason: 'review_commitment' } },
      { single: false }, { resource_review: true }, { name: undefined }, { name: '  ' },
      { ingredient_slug: undefined }, { channel_session_id: undefined },
    ]) {
      expect(held(over), JSON.stringify(over)).toBeUndefined();
    }
  });

  it('a single-op ingredient is its own op; an empty connection is none; a stored recipe is bound', () => {
    const offer = held({ ingredient_slug: 'mail-send', operation_id: undefined, connection_name: '', name: 'Send an email',
      recipe: { recipe_id: 'r', recipe_hash: 'h' } });
    expect(offer).toMatchObject({ ingredient_slug: 'mail-send', operation_id: 'mail-send', recipe: { recipe_id: 'r', recipe_hash: 'h' } });
    expect(offer!.connection_name).toBeUndefined();
  });

  it('names a held op as the system already does, and not at all by its id', () => {
    const catalog = {
      slug: 'hubspot-catalog', kind: 'catalog', operations: {
        'deal.update': { operation_id: 'recued-core/hubspot-catalog.deal.update', description: 'Update a deal. Changes the fields given.' },
        'deal.note': { operation_id: 'recued-core/hubspot-catalog.deal.note' },
      },
    } as unknown as IngredientManifest;
    const manifests = (slug: string) => (slug === 'hubspot-catalog' ? catalog : createManifestRegistry().get(slug));
    expect(heldCallOpLabel({ slug: 'mail-send' }, manifests)).toBe('Send an email');
    expect(heldCallOpLabel({ slug: 'hubspot-catalog', operation_id: 'recued-core/hubspot-catalog.deal.update' }, manifests))
      .toBe('Update a deal');
    // The gate may record the op by its key, too.
    expect(heldCallOpLabel({ slug: 'hubspot-catalog', operation_id: 'deal.update' }, manifests)).toBe('Update a deal');
    expect(heldCallOpLabel({ slug: 'hubspot-catalog', operation_id: 'recued-core/hubspot-catalog.deal.note' }, manifests))
      .toBeUndefined();
    expect(heldCallOpLabel({ slug: 'hubspot-catalog' }, manifests)).toBeUndefined();
    expect(heldCallOpLabel({ slug: 'no-such-thing' }, manifests)).toBeUndefined();
  });
});

describe('D-177 §N.15.9 — a round\'s held sends, kept and asked once (Q7, "After each round")', () => {
  /** A round of three sends: each hold kept for the round's end, then one approval for all. */
  const round = async (s: ReturnType<typeof server>) => {
    const kept: RoundMember[] = [];
    const keep = (hold: DeferredHold) => { kept.push({ ...hold, tool_name: 'recipe.run', call_key: 'recipe.run:send' }); return true; };
    for (const to of ['dana@example.com', 'priya@example.com', 'omar@example.com']) {
      const sent = await s.run({ recipe_id: RECIPE.recipe_id, config: mail(to, 'New time') }, 'chat-1', keep);
      // Held, and asked nothing yet.
      expect(sent.held).toBe(true);
      expect(sent.asked).toBe(false);
    }
    expect(await s.askStore.listByStatus('open')).toEqual([]);
    await raiseRoundGather(kept);
    const open = await s.askStore.listByStatus('open');
    expect(open).toHaveLength(1);
    return { kept, ask: open[0]! };
  };

  it('one approval lists all three, and a yes sends each, as listed', async () => {
    const s = server();
    const { kept, ask } = await round(s);
    expect(ask.message.title).toBe('Approve: Send a composed email, 3 actions');
    expect(ask.options.map((option) => option.id)).toEqual(['approve', 'allow_kind', 'deny']);
    for (const to of ['dana@example.com', 'priya@example.com', 'omar@example.com']) expect(ask.message.text).toContain(to);
    // Each hold's anchor records the approval it waits on, so a restart raises none again.
    for (const member of kept) expect((await s.audit.get(member.run_id))?.ask_id).toBe(ask.ask_id);
    await s.answer(ask, 'approve');
    await vi.waitFor(() => expect(s.sent).toHaveLength(3));
    expect(s.sent.map((m) => m.to[0])).toEqual(['dana@example.com', 'priya@example.com', 'omar@example.com']);
    expect(s.kindGrants()).toEqual([]);
  });

  it('"Allow in this chat" sends all three and grants the hour once', async () => {
    const s = server();
    const { ask } = await round(s);
    await s.answer(ask, 'allow_kind');
    await vi.waitFor(() => expect(s.sent).toHaveLength(3));
    expect(s.kindGrants()).toHaveLength(1);
    // The next send in this chat goes without asking.
    expect((await s.run({ recipe_id: RECIPE.recipe_id, config: mail('lee@example.com', 'Also') })).held).toBe(false);
  });

  it('a no sends none', async () => {
    const s = server();
    const { ask } = await round(s);
    await s.answer(ask, 'deny');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(s.sent).toEqual([]);
  });

  it('a hold the round does not take asks at once, as before', async () => {
    const s = server();
    const sent = await s.run({ recipe_id: RECIPE.recipe_id, config: mail('dana@example.com', 'x') }, 'chat-1', () => false);
    expect(sent.held).toBe(true);
    expect(sent.asked).toBe(true);
  });
});
