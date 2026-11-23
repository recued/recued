/** D-348 slice 6b — a request's delete of Recued's own records, on its rule, of a record the same
 *  run found itself (Q7).
 *
 *  Recued's own stores declare no record argument and no records path, so a closed list names
 *  each (`chain-own-records.ts`): a task by its id, found by the task list; a message by its
 *  mailbox and record id, found by the mailbox's list or search. A recipe's loop of deletes is
 *  one call on the rule, and each item is checked as it runs.
 *
 *  Driven, not read: the real kernel manifests and executor, the real commit gateway, notification
 *  block, answer path and resumer, and the real chain stores. Only the stores behind the kernel are
 *  stand-ins (`kernelDispatchers`), each answering in its own shape. */

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type { Checkpoint, Commit, ExecutionSource, RecipeDefinition } from '@recued/contracts';
import type { KernelDispatchers } from '@recued/ingredients';
import { registerPreflightHandler } from '@recued/gateway';
import {
  createAuditLogStore, createCommitStore, createInMemoryCollection,
  type ActivityEntry, type AuditEntry, type AuditLogStore, type CheckpointStore,
} from '@recued/storage';
import {
  createAskStore, createNotificationBlock, createNotificationSettingsStore, createUiChannel,
  type NotificationSettings, type PendingAsk,
} from '@recued/notification';

import { CHAIN_REQUEST_STATE_KEY, noteChainHeldRun, openChainRequest } from '../chain-evidence.js';
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createPreflightResumer } from '../preflight-resumer.js';
import { createRecipeStore } from '../recipe-store.js';
import { createChainEvidenceStore } from '../storage/chain-evidence-store.js';
import { createChainRuleStore } from '../storage/chain-rule-store.js';

const DAY = 86_400_000;
// Far from today, so a gate or learner that read the real clock would judge the rule expired.
const START = Date.parse('2025-03-03T09:00:00Z');

const recipeOf = (recipe_id: string, variables: Record<string, unknown>, steps: unknown[]): RecipeDefinition => ({
  recipe_id, version: 1, ttl: 0,
  metadata: { name: recipe_id, description: 'D-348 own deletes.', author: 'd348', supported_platforms: ['server'] },
  variables, prefetch_steps: [], steps, output: { sidebar: [] },
} as unknown as RecipeDefinition);

/** Checks the task list (unless told to skip it), then deletes the tasks it is given. */
const CLEAR = recipeOf('d348-clear-picked-tasks', {
  ids: { label: 'Tasks', type: 'array' },
  skip: { label: 'Skip the list', type: 'boolean', default: false },
}, [
  { id: 'open', ingredient: 'work-entity-list', input: { kind: 'task' }, skip_when: '{{config.skip}} equal true' },
  { id: 'clear', ingredient: 'task-delete', foreach: '{{config.ids}}', input: { id: '{{item}}', tombstone: true } },
]);

/** Searches the inbox for newsletters, then deletes each it matched. */
const SWEEP = recipeOf('d348-sweep-newsletters', {}, [
  { id: 'news', ingredient: 'email-search', input: { slug: 'inbox', query: 'newsletter' } },
  { id: 'clear', ingredient: 'mail-delete', foreach: '{{step.news.matches}}', input: { slug: 'inbox', record_id: '{{item.record_id}}' } },
]);

const server = () => {
  let clock = START;
  const now = () => clock;
  const tasks = new Map<string, { id: string; title: string }>();
  const mail = new Map<string, { record_id: string; subject: string }>();
  const deleted: string[] = [];
  const dispatchers = {
    workEntityList: vi.fn(async (input: { kind: string }) => {
      const entities = input.kind === 'task' ? [...tasks.values()] : [];
      return { entities, total: entities.length };
    }),
    taskDelete: vi.fn(async (input: { id: string }) => {
      deleted.push(`task:${input.id}`);
      tasks.delete(input.id);
      return { ok: true, id: input.id, tombstoned: true };
    }),
    collectionSearch: vi.fn(async (input: { platform: string; slug: string }) => ({
      matches: input.platform === 'mail' && input.slug === 'inbox'
        ? [...mail.values()].map((m) => ({ ...m, received_at: 1, modified_at: 1, hot_fields: { subject: m.subject }, size_bytes: 1, source_id: m.record_id }))
        : [],
    })),
    mailDelete: vi.fn(async (input: { slug: string; record_id: string }) => {
      deleted.push(`mail:${input.slug}:${input.record_id}`);
      mail.delete(input.record_id);
      return { deleted: true, record_id: input.record_id };
    }),
  } as unknown as KernelDispatchers;

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
  recipeStore.register(CLEAR);
  recipeStore.register(SWEEP);
  const db = new Database(':memory:');
  const chainEvidence = createChainEvidenceStore(db);
  const chainRules = createChainRuleStore(db, chainEvidence);
  const deps = {
    recipeStore,
    executorConfig: { manifests: createManifestRegistry(), kernelDispatchers: dispatchers },
    baseVault: {},
    instanceId: 'chain-own-deletes',
    auditLog,
    checkpointStore: checkpoints,
    preflightNotifier: block,
    commitStore: createCommitStore(createInMemoryCollection<Commit>()),
    chainEvidence,
    chainRules,
    now,
  } as unknown as ExecuteHandlerDeps;
  registerPreflightHandler(block, {
    checkpointStore: checkpoints,
    resumer: createPreflightResumer({ getExecuteDeps: () => deps, auditLog }),
  });

  let turn = 0;
  /** One turn of the owner's chat asking `words`, which runs `recipe` with `config`; its ask, if any. */
  const ask = async (words: string, recipe: RecipeDefinition, config: Record<string, unknown> = {}) => {
    turn += 1;
    const turn_id = `turn-${String(turn)}`;
    const source = { channel: 'chat', actor: 'user_self', chat_session_id: 'chat-1', user_id: 'owner-1', turn_id } as ExecutionSource;
    const request = openChainRequest(chainEvidence, { session_id: 'chat-1', turn_id, source, words, at: clock });
    const before = (await askStore.listByStatus('open')).length;
    const response = await handleExecute(deps, {
      recipe_id: recipe.recipe_id, config, trigger_source: 'chat', execution_source: source,
    } as never, { chain_request_key: request?.key_hash });
    const open = await askStore.listByStatus('open');
    const asked = open.length > before ? open.at(-1) : undefined;
    if (asked !== undefined && request !== undefined) {
      noteChainHeldRun(chainEvidence, new Map([[CHAIN_REQUEST_STATE_KEY, request]]), asked.handler_payload.run_id as string, clock);
    }
    return { asked, response };
  };
  const answer = async (pending: PendingAsk, option: 'approve' | 'deny') => {
    await block.submitAnswer({ ask_id: pending.ask_id, option, via: 'ui' });
  };
  const used = async () => (await auditLog.listActivities()).filter((row) => row.action === 'chain_rule_used')
    .map((row) => JSON.parse(row.detail!) as { delete: boolean; uses_remaining: number });
  const addTasks = (...ids: string[]) => { for (const id of ids) tasks.set(id, { id, title: `Task ${id}` }); };
  const addMail = (...ids: string[]) => { for (const id of ids) mail.set(id, { record_id: id, subject: `Newsletter ${id}` }); };
  return { ask, answer, used, deleted, chainRules, addTasks, addMail, now, tick: (ms: number) => { clock += ms; } };
};

type Server = ReturnType<typeof server>;

/** Five days of the request, each loop of deletes approved once and run; then the owner accepts
 *  its rule with its delete. */
const ruled = async (day: (s: Server, n: number) => Promise<{ asked?: PendingAsk }>, perDay: number) => {
  const s = server();
  for (const n of [1, 2, 3, 4, 5]) {
    const { asked } = await day(s, n);
    expect(asked, `day ${String(n)} asks`).toBeDefined();
    await s.answer(asked!, 'approve');
    await vi.waitFor(() => expect(s.deleted).toHaveLength(n * perDay));
    s.tick(DAY);
  }
  const [suggestion] = await s.chainRules.listSuggestions(s.now());
  expect(suggestion!.members).toEqual([]);
  expect(suggestion!.deletes.map((view) => view.signature)).toEqual([expect.objectContaining({ pins: {}, delete: true })]);
  const { rule } = await s.chainRules.accept(suggestion!.key_hash, { deletes: true }, s.now());
  return { s, rule };
};

describe('D-348 slice 6b — a recipe\'s loop of task deletes, of tasks its own run listed', () => {
  const WORDS = 'Clear the tasks I picked';
  const day = (s: Server, n: number) => {
    const ids = [`t_${String(n)}a`, `t_${String(n)}b`];
    s.addTasks(...ids);
    return s.ask(WORDS, CLEAR, { ids });
  };

  it('the loop, once learned, deletes each listed task without asking, one use each', async () => {
    const { s, rule } = await ruled(day, 2);
    s.addTasks('t_6a', 't_6b');
    const { asked } = await s.ask(WORDS, CLEAR, { ids: ['t_6a', 't_6b'] });
    expect(asked).toBeUndefined();
    expect(s.deleted.slice(10)).toEqual(['task:t_6a', 'task:t_6b']);
    expect(await s.used()).toEqual([
      { rule_id: rule.rule_id, uses_remaining: 99, delete: true },
      { rule_id: rule.rule_id, uses_remaining: 98, delete: true },
    ].map(({ uses_remaining, delete: d }) => expect.objectContaining({ uses_remaining, delete: d })));
  });

  it('⛔ a task the run did not list asks; so does every task when the run read no list', async () => {
    const { s } = await ruled(day, 2);
    // The list holds t_6a; t_9z is only named, by the run's setting.
    s.addTasks('t_6a');
    const only = await s.ask(WORDS, CLEAR, { ids: ['t_9z'] });
    expect(only.asked).toBeDefined();
    await s.answer(only.asked!, 'deny');
    const unread = await s.ask(WORDS, CLEAR, { ids: ['t_6a'], skip: true });
    expect(unread.asked).toBeDefined();
    await s.answer(unread.asked!, 'deny');
    expect(s.deleted).toHaveLength(10);
    expect(await s.used()).toEqual([]);
  });
});

describe('D-348 slice 6b — a recipe\'s loop of mail deletes, of the messages its own search matched', () => {
  it('learned, it deletes each matched message without asking', async () => {
    const WORDS = 'Sweep the newsletters';
    const { s } = await ruled((server, n) => {
      server.addMail(`m_${String(n)}a`, `m_${String(n)}b`, `m_${String(n)}c`);
      return server.ask(WORDS, SWEEP);
    }, 3);
    s.addMail('m_6a', 'm_6b');
    const { asked } = await s.ask(WORDS, SWEEP);
    expect(asked).toBeUndefined();
    expect(s.deleted.slice(15)).toEqual(['mail:inbox:m_6a', 'mail:inbox:m_6b']);
    expect(await s.used()).toHaveLength(2);
  });
});

