/** D-348 slice 5 — a request's rule at the gateway: a recipe's held send, on the rule the owner
 *  accepted for the request the chat's run was made for, goes out without asking.
 *
 *  Driven, not read: the shipped send-composed-mail recipe, the bundled mail-send manifest, the real
 *  commit gateway, the real notification block and answer path, the real resumer, and the real chain
 *  stores. The round trip is the point: the signature the gate matches is the one the hold recorded
 *  when the owner approved the same call. Only the delivery is recorded instead of sent. */

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { type Checkpoint, type Commit, type ExecutionSource, type RecipeDefinition } from '@recued/contracts';
import { registerPreflightHandler } from '@recued/gateway';
import {
  createAuditLogStore, createCommitStore, createInMemoryCollection,
  type ActivityEntry, type AuditEntry, type AuditLogStore, type CheckpointStore,
} from '@recued/storage';
import {
  createAskStore, createNotificationBlock, createNotificationSettingsStore, createUiChannel,
  type NotificationSettings, type PendingAsk,
} from '@recued/notification';

import { CHAIN_REQUEST_STATE_KEY, noteChainHeldRun, openChainRequest, type TurnChainRequest } from '../chain-evidence.js';
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createPreflightResumer } from '../preflight-resumer.js';
import { createRecipeStore } from '../recipe-store.js';
import { createChainEvidenceStore } from '../storage/chain-evidence-store.js';
import { createChainRuleStore } from '../storage/chain-rule-store.js';

const RECIPE = JSON.parse(readFileSync(
  join(__dirname, '../../../../community/recipes/send-composed-mail.json'), 'utf8',
)) as RecipeDefinition;
const DAY = 86_400_000;
// Far from today, so a gate or learner that read the real clock would judge the rule expired.
const START = Date.parse('2025-03-03T09:00:00Z');

const mail = (to: string): Record<string, unknown> => ({
  sender_mail_instance: 'recueddev', to: [to], subject: 'The new time', body: 'hello',
  cc: [], bcc: [], body_format: 'text', attachments: [], in_reply_to: '', reply_to: '',
  reconciliation_id: null, references: [],
});

const server = () => {
  let clock = START;
  const now = () => clock;
  const askStore = createAskStore(createInMemoryCollection<PendingAsk>());
  const block = createNotificationBlock({
    askStore,
    channels: [createUiChannel({ busSink: () => undefined })],
    settingsStore: createNotificationSettingsStore(createInMemoryCollection<NotificationSettings>()),
  });
  const rows = new Map<string, Checkpoint>();
  const checkpoints = {
    write: vi.fn(async (c: Checkpoint) => { rows.set(c.checkpoint_id, c); }),
    get: vi.fn(async (id: string) => rows.get(id) ?? null),
    delete: vi.fn(async (id: string) => { rows.delete(id); }),
    listByRun: vi.fn(async (r: string) => [...rows.values()].filter((c) => c.run_id === r)),
    list: vi.fn(async () => [...rows.values()]),
    size: vi.fn(async () => rows.size),
  } as unknown as CheckpointStore;
  const auditLog = createAuditLogStore(
    createInMemoryCollection<AuditEntry>(), createInMemoryCollection<ActivityEntry>(),
  ) as AuditLogStore;
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(RECIPE);
  const db = new Database(':memory:');
  const chainEvidence = createChainEvidenceStore(db);
  const chainRules = createChainRuleStore(db, chainEvidence);
  const sent: string[][] = [];
  const deps = {
    recipeStore,
    executorConfig: {
      manifests: createManifestRegistry(),
      kernelDispatchers: {
        mailSend: async (input: { to: string[] }) => {
          sent.push(input.to);
          return { source_id: 'src', message_id: `m${sent.length}`, sent_at: clock, _id: null, _collection: 'data.mail' as const };
        },
      },
    },
    baseVault: {},
    instanceId: 'chain-gateway',
    auditLog,
    checkpointStore: checkpoints,
    preflightNotifier: block,
    commitStore: createCommitStore(createInMemoryCollection<Commit>()),
    listSendCapableMailboxes: () => [{ name: 'recueddev', address: 'recued.dev@gmail.com', provider: 'Gmail' }],
    chainEvidence,
    chainRules,
    now,
  } as unknown as ExecuteHandlerDeps;
  registerPreflightHandler(block, {
    checkpointStore: checkpoints,
    resumer: createPreflightResumer({ getExecuteDeps: () => deps, auditLog }),
  });

  let turn = 0;
  /** One turn of the owner's chat asking `words`, whose run sends to `to`: the request opened as
   *  the turn driver opens it, the run given its key as the chat's tools give it, and a hold noted
   *  as the orchestrator notes one. */
  const ask = async (words: string, to: string, opts: { carryKey?: boolean } = {}) => {
    turn += 1;
    const turn_id = `turn-${String(turn)}`;
    const source = { channel: 'chat', actor: 'user_self', chat_session_id: 'chat-1', user_id: 'owner-1', turn_id } as ExecutionSource;
    const request = openChainRequest(chainEvidence, { session_id: 'chat-1', turn_id, source, words, at: clock });
    const turn_state = new Map<string, unknown>(request !== undefined ? [[CHAIN_REQUEST_STATE_KEY, request]] : []);
    const before = (await askStore.listByStatus('open')).length;
    await handleExecute(deps, {
      recipe_id: RECIPE.recipe_id, config: mail(to), trigger_source: 'chat', execution_source: source,
    } as never, opts.carryKey === false ? {} : { chain_request_key: (request as TurnChainRequest | undefined)?.key_hash });
    const open = await askStore.listByStatus('open');
    const asked = open.length > before ? open.at(-1) : undefined;
    if (asked !== undefined) noteChainHeldRun(chainEvidence, turn_state, asked.handler_payload.run_id as string, clock);
    return asked;
  };
  const approve = async (pending: PendingAsk) => {
    await block.submitAnswer({ ask_id: pending.ask_id, option: 'approve', via: 'ui' });
  };
  const deny = async (pending: PendingAsk) => {
    await block.submitAnswer({ ask_id: pending.ask_id, option: 'deny', via: 'ui' });
  };
  const used = async () => (await auditLog.listActivities()).filter((row) => row.action === 'chain_rule_used');
  return { ask, approve, deny, sent, chainRules, used, now, tick: (ms: number) => { clock += ms; } };
};

describe('D-348 slice 5 — a request\'s rule at the gateway', () => {
  /** Three days of the request, each send approved and sent; then the owner accepts its rule. */
  const ruled = async () => {
    const s = server();
    for (const n of [1, 2, 3]) {
      const held = await s.ask('Tell Ann the new time', 'ann@example.com');
      expect(held).toBeDefined();
      await s.approve(held!);
      await vi.waitFor(() => expect(s.sent).toHaveLength(n));
      s.tick(DAY);
    }
    const [suggestion] = await s.chainRules.listSuggestions(s.now());
    expect(suggestion!.members.map((view) => view.signature?.pins)).toEqual([expect.objectContaining({ to: ['ann@example.com'] })]);
    const { rule } = await s.chainRules.accept(suggestion!.key_hash, {}, s.now());
    return { s, rule };
  };

  it('the same send, to the same person: it goes out without asking, as the hold recorded it', async () => {
    const { s, rule } = await ruled();
    expect(await s.ask('Tell Ann the new time', 'ann@example.com')).toBeUndefined();
    expect(s.sent).toHaveLength(4);
    expect((await s.used()).map((row) => JSON.parse(row.detail!))).toEqual([
      { rule_id: rule.rule_id, uses_remaining: 99, delete: false },
    ]);
  });

  it('another recipient, another wording, or a run that carries no request: it asks', async () => {
    const { s } = await ruled();
    // Each answered no before the next: an identical send while one waits is that ask, not a new one.
    for (const [words, to, opts] of [
      ['Tell Ann the new time', 'ben@example.com', {}],
      ['Let Ann know the new time', 'ann@example.com', {}],
      ['Tell Ann the new time', 'ann@example.com', { carryKey: false }],
    ] as const) {
      const held = await s.ask(words, to, opts);
      expect(held).toBeDefined();
      await s.deny(held!);
    }
    expect(s.sent).toHaveLength(3);
    expect(await s.used()).toEqual([]);
  });
});
