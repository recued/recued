/** What "Allow this session" lets a send do afterwards, and what the
 *  approval says it lets it do.
 *
 *  ⚠ Since D-177 §N.15.8 (2026-11-10) the owner's own chat offers "Allow in
 *  this chat" on a held send instead (the op for the hour, any recipient, as
 *  ruled); "Allow this session", this open grant, is what an AI app's held
 *  send offers. So the sends below come from an AI app over MCP, under its
 *  contract, and the grant is bound to that app (N.14).
 *
 *  The owner, reading the approval of an email chat send (2026-10-19): "the
 *  pinned entries: attachments, bcc, cc, references are all empty = [], does
 *  that mean from/to is never in the picture, any empty: [attachments, bcc, cc,
 *  references] will be allowed if choose 'allow this session'?" The grant fixed
 *  the sender and `to` all along; the approval's list was cut before it reached
 *  them, and said nothing of the cut.
 *
 *  Driven, not read: the shipped send-composed-mail recipe, the bundled
 *  mail-send manifest (its `authority_args` decide what the grant fixes), the
 *  real gate, the real notification block and answer path, and the real
 *  session-grant store. Only the delivery is recorded instead of sent. */

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  D165_CONTRACT_SCHEMA, type Checkpoint, type Commit, type ContractSnapshot, type ExecutionSource, type OpenProjection,
  type RecipeDefinition,
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
import { createManifestRegistry } from '../manifest-loader.js';
import { createPreflightResumer } from '../preflight-resumer.js';
import { createRecipeStore } from '../recipe-store.js';
import { createSessionGrantResolver } from '../session-grant-resolver.js';
import { createContractDefinitionStore, type ContractDefinitionStore } from '../storage/contract-definition-store.js';
import { createContractStore } from '../storage/contract-store.js';

const RECIPE = JSON.parse(readFileSync(
  join(__dirname, '../../../../community/recipes/send-composed-mail.json'), 'utf8',
)) as RecipeDefinition;

/** The arguments Chat sent for the owner's live send, as the run's config. */
const FIRST = {
  sender_mail_instance: 'recueddev', to: ['recued.dev@outlook.com'], subject: 'Sender check', body: 'hello',
  cc: [], bcc: [], body_format: 'text', attachments: [], in_reply_to: '', reply_to: '',
  reconciliation_id: null, references: [],
};

const NOW = 1_700_000_000_000;
const APP_TOKEN = 'tok-app';
const APP_CONTRACT = 'ct-app';
/** As the MCP server sends it: the app's contract, which allows the send (and the read of its
 *  attachments) and asks before a write. */
const APP_SNAPSHOT: ContractSnapshot = {
  contract_id: APP_CONTRACT, contract_version: 'v1', allowed_tools: ['mail-send', 'data-file-read'],
  approval_required: ['write', 'admin'], scope_restrictions: [], resolved_at: NOW,
};
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

const inMemoryCheckpointStore = (): CheckpointStore => {
  const rows = new Map<string, Checkpoint>();
  return {
    write: vi.fn(async (c: Checkpoint) => { rows.set(c.checkpoint_id, c); }),
    get: vi.fn(async (id: string) => rows.get(id) ?? null),
    delete: vi.fn(async (id: string) => { rows.delete(id); }),
    listByRun: vi.fn(async (r: string) => [...rows.values()].filter((c) => c.run_id === r)),
    list: vi.fn(async () => [...rows.values()]),
    size: vi.fn(async () => rows.size),
  } as unknown as CheckpointStore;
};

/** One chat session on the owner's server, with "Allow this session" pressed
 *  on its first send. */
const session = async (extra: Partial<ExecuteHandlerDeps> = {}) => {
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
  const sent: Array<{ instance: string; to: string[]; cc?: string[]; subject: string }> = [];
  const deps = {
    recipeStore,
    executorConfig: {
      // No community dir: the registry seeds the bundled kernel manifests,
      // mail-send's `authority_args` among them.
      manifests: createManifestRegistry(),
      kernelDispatchers: {
        mailSend: async (input: { instance: string; to: string[]; cc?: string[]; subject: string }) => {
          sent.push({ instance: input.instance, to: input.to, ...(input.cc !== undefined ? { cc: input.cc } : {}), subject: input.subject });
          return { source_id: 'src', message_id: `m${sent.length}`, sent_at: nowMs, _id: null, _collection: 'data.mail' as const };
        },
      },
    },
    baseVault: {},
    instanceId: 'allow-session-send',
    auditLog,
    checkpointStore: checkpoints,
    preflightNotifier: block,
    // The mint happens at the commit Gateway, which runs only with a commit store.
    commitStore: createCommitStore(createInMemoryCollection<Commit>()),
    sessionGrantResolver: createSessionGrantResolver({ definitionStore, now: () => nowMs }),
    // An AI app's approved run resumes only when the app still holds its contract; here it does.
    approvalResumeAuthority: {
      resolve: ({ execution_source }: { execution_source: ExecutionSource }) => ({
        admitted: true, execution_source, contract_snapshot: APP_SNAPSHOT,
      }),
    },
    listSendCapableMailboxes: () => [
      { name: 'recueddev', address: 'recued.dev@gmail.com', provider: 'Gmail' },
      { name: 'outlook', address: 'recued.dev@outlook.com', provider: 'Outlook' },
    ],
    ...extra,
  } as unknown as ExecuteHandlerDeps;
  registerPreflightHandler(block, {
    checkpointStore: checkpoints,
    resumer: createPreflightResumer({ getExecuteDeps: () => deps, auditLog }),
  });

  let turn = 0;
  const send = async (config: Record<string, unknown>) => {
    turn += 1;
    const source = {
      channel: 'mcp', actor: 'contracted_user', agent_id: 'agent-1', tool_call_id: `call-${turn}`,
      mcp_token_id: APP_TOKEN, contract_id: APP_CONTRACT,
    } as ExecutionSource;
    const before = (await askStore.listByStatus('open')).length;
    const result = await handleExecute(deps, {
      recipe_id: RECIPE.recipe_id, trigger_source: 'mcp', execution_source: source, config,
      contract_snapshot: APP_SNAPSHOT,
    } as never);
    const open = await askStore.listByStatus('open');
    return {
      held: (result as { awaiting_approval?: unknown }).awaiting_approval !== undefined,
      asked: open.length > before,
      ask: open.at(-1),
    };
  };

  // The first send holds and offers "Allow this session"; the owner presses it.
  const first = await send(FIRST);
  expect(first.held).toBe(true);
  expect(first.ask!.options.map((o) => o.id)).toContain('allow_session');
  await block.submitAnswer({ ask_id: first.ask!.ask_id, option: 'allow_session', via: 'ui' });
  const grants = definitionStore.listSessionGrants(`mcp:${APP_TOKEN}`);
  expect(grants, 'pressing it mints one grant').toHaveLength(1);
  expect(sent, 'the approved send went out').toHaveLength(1);
  return { send, sent, grants, firstAsk: first.ask! };
};

describe('"Allow this session" on an AI app\'s send', () => {
  it('is an open grant that fixes the sender and every recipient field, by value', async () => {
    const { grants } = await session();
    const grant = grants[0]!;
    expect(grant.grant_mode).toBe('open');
    const projection = grant.open_projection as OpenProjection | undefined;
    const fixed = Object.fromEntries((projection?.args ?? []).map((a) => [a.path, a.derived_pinned]));
    expect(Object.keys(fixed).sort()).toEqual([
      'attachments', 'bcc', 'cc', 'in_reply_to', 'reconciliation_id', 'references', 'reply_to',
      'sender_mail_instance', 'to',
    ]);
    expect(fixed.to).toEqual(['recued.dev@outlook.com']);
    expect(fixed.sender_mail_instance).toBe('recueddev');
  });

  it('the approval says what stays fixed, the sender and recipient first, and what may change', async () => {
    const { firstAsk } = await session();
    expect(firstAsk.message.text).toContain([
      // In the owner's words: the recipe by its title, each field as the card's
      // rows name it.
      '\'Allow this session\' lets "Send a composed email" do this up to 5 more times within 1 hour '
        + 'without asking you, as long as these stay exactly as they are now:',
      '- From: recued.dev@gmail.com (Gmail)',
      '- To: recued.dev@outlook.com',
      '- these stay empty: Attachments, BCC, CC, In reply to, Reconciliation ID, References, Reply to',
      'These may change from one run to the next: Body, Body format, Subject. '
        + 'A change to anything above asks you again.',
    ].join('\n'));
  });

  it('D-336 — a recipient who is a contact is named in what stays fixed', async () => {
    const contactStore = {
      resolveCanonicalEmail: (email: string) => ({ canonical_email: email, chain_depth: 0 }),
      get: (email: string) => (email === 'recued.dev@outlook.com' ? { email, name: 'Dana Whitfield' } : null),
    };
    const { firstAsk, grants } = await session({ contactStore } as never);
    // This ask lists no call lines; `held-send-mailbox-address` covers those and the card.
    expect(firstAsk.message.text).toContain('\n- To: Dana Whitfield <recued.dev@outlook.com>\n');
    // Display only: the grant still fixes the address.
    const projection = grants[0]!.open_projection as OpenProjection | undefined;
    expect(projection?.args.find((a) => a.path === 'to')?.derived_pinned).toEqual(['recued.dev@outlook.com']);
  });

  it('"up to 5 more times": five more go without asking, and the sixth asks', async () => {
    const { send, sent } = await session();
    for (let i = 1; i <= 5; i += 1) {
      const next = await send({ ...FIRST, subject: `Follow-up ${i}` });
      expect(next.held, `follow-up ${i}`).toBe(false);
    }
    const sixth = await send({ ...FIRST, subject: 'Follow-up 6' });
    expect(sixth.held).toBe(true);
    expect(sent).toHaveLength(6);
  });

  it('the same sender to the same recipient with a new subject and body goes without asking', async () => {
    const { send, sent } = await session();
    const next = await send({ ...FIRST, subject: 'Another one', body: 'a different text' });
    expect(next.held).toBe(false);
    expect(next.asked).toBe(false);
    expect(sent.map((m) => m.subject)).toEqual(['Sender check', 'Another one']);
  });

  it.each([
    ['another recipient', { to: ['someone.else@example.com'] }],
    ['an added recipient', { to: ['recued.dev@outlook.com', 'someone.else@example.com'] }],
    ['another sending mailbox', { sender_mail_instance: 'outlook' }],
    ['a cc', { cc: ['someone.else@example.com'] }],
    ['a bcc', { bcc: ['someone.else@example.com'] }],
  ] as const)('%s asks again, and nothing is sent', async (_name, change) => {
    const { send, sent } = await session();
    const next = await send({ ...FIRST, ...change });
    expect(next.held).toBe(true);
    expect(next.asked).toBe(true);
    expect(sent).toHaveLength(1);
  });
});
