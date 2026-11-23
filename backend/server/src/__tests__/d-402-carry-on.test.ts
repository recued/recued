/** D-402 slice E4b (§6.6) — "Carry on in Chat" from a run a hand-off stopped.
 *
 *  The owner's rulings (2026-11-17): a hand-off counts as a failed run (slice E4a), and its notice
 *  opens a seeded chat. Proved here:
 *  - the rpc answers the chat kept for the run and the message its composer starts with, and keeps
 *    the chat with its run, for a second click and for slice E4c;
 *  - the notice of a hand-off links that chat, while the automation runs and once it has stopped;
 *  - each of the three unattended runners hands the notice the failing run's id. */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RecipeDefinition, RecipeError } from '@recued/contracts';
import type { NotificationMessage } from '@recued/notification';
import { carryOnDraft, createRunCarryOnStore, makeRunCarryOn, type RunCarryOnSessions } from '../run-carry-on.js';
import { handleExecutionCarryOn, type ChatRpcDeps } from '../chat-handler.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { decideAutomationFailure } from '../automation-failure-reporter.js';
import { createScheduleStore } from '../schedule-store.js';
import { createScheduler } from '../scheduler.js';
import { createCircuitBreakerStore, createServerAutoRunScheduler } from '../auto-run-scheduler.js';
import { createEventTriggersStore } from '../triggers/store.js';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { createEventTriggerDispatcher } from '../triggers/dispatcher.js';
import { stampExecuteResponseAuditRun, type ExecuteResponse } from '../types.js';
import type { ExecuteHandlerDeps } from '../execute-handler.js';

const databases: Database.Database[] = [];
const memory = (): Database.Database => { const db = new Database(':memory:'); databases.push(db); return db; };
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

const REASON = 'The page showed something this recipe has not met: the job went on when shop.example.com showed “In stock”. '
  + 'Carry on from here in the chat; the way taken then can be added to the recipe in Kitchen.';
const handOff = (message = REASON): RecipeError => ({
  error_id: 'e1', code: 'RECIPE_HAND_OFF', message, severity: 'error',
  source: { recipe_id: 'buy-lamp', step_id: 'decide_1', ingredient_slug: null },
  details: {}, timestamp: '2026-11-17T09:00:00Z', retryable: false,
} as RecipeError);

const runs = (rows: Record<string, { recipe_id: string; recipe_hash: string; errors?: RecipeError[] }>) => ({
  get: async (run_id: string) => rows[run_id] ?? null,
});

const fakeSessions = () => {
  const made: string[] = [];
  const titles: string[] = [];
  const sessions: RunCarryOnSessions = {
    exists: (session_id) => made.includes(session_id),
    create: async (title) => { const id = `chat-${String(made.length + 1)}`; made.push(id); titles.push(title); return id; },
  };
  return { made, titles, sessions };
};

describe('D-402 slice E4b — the message the carried-on chat starts with', () => {
  it('quotes the run\'s reason as it gave it, names the recipe, and asks for the page as it is now', () => {
    expect(carryOnDraft({ recipe_name: 'Buy the lamp', reason: REASON })).toBe([
      'Carry on with “Buy the lamp” from where its run stopped. The run said why:',
      REASON,
      '',
      'Look at that page as it is now and tell me what it shows. If the way on is clear, go on; if not, ask me which way to take.',
    ].join('\n'));
    expect(carryOnDraft({ reason: REASON }).split('\n')[0]).toBe('Carry on from where this run stopped. The run said why:');
  });
});

describe('D-402 slice E4b — the chat kept for a run', () => {
  const make = (rows: Parameters<typeof runs>[0], names: Record<string, string> = { 'buy-lamp': 'Buy the lamp' }) => {
    const store = createRunCarryOnStore(memory());
    let now = 1_000;
    const carryOn = makeRunCarryOn({ runs: runs(rows), recipeName: (id) => names[id], store, now: () => now++ });
    return { store, carryOn };
  };

  it('opens one chat for a hand-off, keeps it with the run, and answers the message to send', async () => {
    const { store, carryOn } = make({ 'run-1': { recipe_id: 'buy-lamp', recipe_hash: 'h1', errors: [handOff()] } });
    const { titles, sessions } = fakeSessions();
    const answer = await carryOn('run-1', sessions);
    expect(answer).toEqual({ ok: true, session_id: 'chat-1', draft: carryOnDraft({ recipe_name: 'Buy the lamp', reason: REASON }) });
    expect(titles).toEqual(['Carry on: Buy the lamp']);
    expect(store.bySession('chat-1')).toEqual({
      run_id: 'run-1', session_id: 'chat-1', recipe_id: 'buy-lamp', recipe_hash: 'h1', step_id: 'decide_1', created_at: 1_000,
    });
  });

  it('a second click opens the same chat; one deleted since gives a new one', async () => {
    const { store, carryOn } = make({ 'run-1': { recipe_id: 'buy-lamp', recipe_hash: 'h1', errors: [handOff()] } });
    const { made, sessions } = fakeSessions();
    expect(await carryOn('run-1', sessions)).toMatchObject({ ok: true, session_id: 'chat-1' });
    expect(await carryOn('run-1', sessions)).toMatchObject({ ok: true, session_id: 'chat-1' });
    expect(made).toEqual(['chat-1']);
    made.splice(0);
    expect(await carryOn('run-1', sessions)).toMatchObject({ ok: true, session_id: 'chat-1' });
    expect(made).toEqual(['chat-1']);
    expect(store.byRun('run-1')?.session_id).toBe('chat-1');
  });

  it('two clicks at once open one chat', async () => {
    const { carryOn } = make({ 'run-1': { recipe_id: 'buy-lamp', recipe_hash: 'h1', errors: [handOff()] } });
    const { made, sessions } = fakeSessions();
    const [first, second] = await Promise.all([carryOn('run-1', sessions), carryOn('run-1', sessions)]);
    expect(first).toEqual(second);
    expect(made).toEqual(['chat-1']);
  });

  it('a recipe since removed: the chat and its message without its name', async () => {
    const { carryOn } = make({ 'run-1': { recipe_id: 'buy-lamp', recipe_hash: 'h1', errors: [handOff()] } }, {});
    const { titles, sessions } = fakeSessions();
    expect(await carryOn('run-1', sessions)).toMatchObject({ ok: true, draft: carryOnDraft({ reason: REASON }) });
    expect(titles).toEqual(['Carry on a stopped run']);
  });

  it('refuses a run it keeps no record of, and one that did not stop at a hand-off, opening nothing', async () => {
    const guard = { ...handOff('Guard triggered'), code: 'RECIPE_GUARD_TRIGGERED' } as RecipeError;
    const { carryOn } = make({
      'run-guard': { recipe_id: 'buy-lamp', recipe_hash: 'h1', errors: [guard] },
      'run-ok': { recipe_id: 'buy-lamp', recipe_hash: 'h1' },
    });
    const { made, sessions } = fakeSessions();
    expect(await carryOn('run-gone', sessions)).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await carryOn('run-guard', sessions)).toMatchObject({ ok: false, reason: 'not_a_hand_off' });
    expect(await carryOn('run-ok', sessions)).toMatchObject({ ok: false, reason: 'not_a_hand_off' });
    expect(made).toEqual([]);
  });
});

describe('D-402 slice E4b — the rpc', () => {
  it('opens the chat the way chat.session.create does, in the owner\'s chat store', async () => {
    const db = memory();
    ensureChatSchema(db);
    const chats = createChatStore(db);
    const carryOn = makeRunCarryOn({
      runs: runs({ 'run-1': { recipe_id: 'buy-lamp', recipe_hash: 'h1', errors: [handOff()] } }),
      recipeName: () => 'Buy the lamp', store: createRunCarryOnStore(db), now: () => 1_000,
    });
    const deps = { store: chats, executionCarryOn: carryOn, now: () => 1_000 } as unknown as ChatRpcDeps;
    const answer = await handleExecutionCarryOn(deps, { run_id: 'run-1' });
    if (!answer.ok) throw new Error('expected a chat');
    expect(chats.getSession(answer.session_id)?.title).toBe('Carry on: Buy the lamp');
    expect(await handleExecutionCarryOn(deps, { run_id: 'run-1' })).toEqual(answer);
    await expect(handleExecutionCarryOn(deps, { run_id: '' })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(handleExecutionCarryOn(deps, {})).rejects.toMatchObject({ code: 'bad_request' });
    await expect(handleExecutionCarryOn({} as ChatRpcDeps, { run_id: 'run-1' })).rejects.toMatchObject({ code: 'not_configured' });
  });
});

describe('D-402 slice E4b — the notice of a hand-off links its chat', () => {
  const unit = { kind: 'schedule', id: 'sch_1', recipe_id: 'buy-lamp', name: 'Buy the lamp' } as const;
  const decide = (input: Partial<Parameters<typeof decideAutomationFailure>[0]>) => decideAutomationFailure({
    unit, code: 'RECIPE_HAND_OFF', reason: REASON, prior_consecutive_failures: 0, threshold: 3, ...input,
  });

  it('while the automation runs, and once it has stopped', () => {
    expect(decide({ run_id: 'run 1/a' }).notice).toEqual({
      title: 'Buy the lamp failed',
      text: `${REASON} Open it to carry on in Chat. Recued will stop this automation if it fails 3 times.`,
      link_url: '#chat/carry-on/run%201%2Fa',
    });
    const stopped = decide({ run_id: 'run-1', prior_consecutive_failures: 2 });
    expect(stopped).toMatchObject({ disarm: true });
    expect(stopped.notice?.title).toBe('Buy the lamp has stopped');
    expect(stopped.notice?.text).toContain('Open it to carry on in Chat. It will not run again until you re-arm it.');
    expect(stopped.notice?.link_url).toBe('#chat/carry-on/run-1');
  });

  it('without its run, or for another failure, the notice keeps the automation\'s rules', () => {
    expect(decide({}).notice?.link_url).toBe('#automation/buy-lamp');
    expect(decide({}).notice?.text).not.toContain('carry on in Chat');
    expect(decide({ code: 'NETWORK_ERROR', run_id: 'run-1' }).notice?.link_url).toBe('#automation/buy-lamp');
  });
});

describe('D-402 slice E4b — each unattended runner hands the notice its run', () => {
  const failed = (run_id: string): ExecuteResponse => stampExecuteResponseAuditRun({
    recipe_id: 'buy-lamp', recipe_hash: 'h1', success: false, output: { sidebar: [] }, steps: [],
    errors: [handOff()], duration_ms: 1, validation_issues: [],
  } as unknown as ExecuteResponse, run_id);

  it('a schedule', async () => {
    const store = createScheduleStore(memory());
    store.set({ schedule_id: 's1', recipe_id: 'buy-lamp', cron_expression: '* * * * *', enabled: true,
      next_run_at: 1_000, last_run_at: null, last_status: null, last_error: null, created_at: 0 } as never);
    const notices: NotificationMessage[] = [];
    const sched = createScheduler({
      store, executeDeps: {} as ExecuteHandlerDeps, now: () => 1_000,
      onAutomationFailure: (notice) => { notices.push(notice); },
      execute: (async () => failed('run-sched')) as never,
    });
    await sched.tick();
    expect(notices.map((notice) => notice.link_url)).toEqual(['#chat/carry-on/run-sched']);
  });

  it('an automatic run', async () => {
    const notices: NotificationMessage[] = [];
    const recipe = { recipe_id: 'buy-lamp', version: 1, ttl: 300, auto_run: { interval_ms: 30_000 },
      metadata: { name: 'Buy the lamp', description: 'x', author: 'me', supported_platforms: ['test'] }, steps: [] } as unknown as RecipeDefinition;
    let fires = 0;
    const handle = createServerAutoRunScheduler({
      // The roster is built from the stored recipes (`listStored`).
      recipeStore: { get: (id: string) => (id === 'buy-lamp' ? recipe : null), size: () => 1, ids: () => ['buy-lamp'],
        listStored: () => [{ recipe_id: 'buy-lamp', publisher_id: 'local', version: 1, recipe_hash: 'h1',
          recipe_json: JSON.stringify(recipe), source: 'inline', installed_at: 0, pack_slug: null }] } as never,
      dishStore: { get: (dish_id: string) => ({ dish_id, recipe_id: dish_id, enabled: true }) as never,
        listByRecipe: (recipe_id: string) => [{ dish_id: recipe_id, recipe_id, enabled: true } as never] },
      execute: async () => { fires += 1; return failed('run-auto'); },
      circuitStore: createCircuitBreakerStore(memory()), now: () => 1_000,
      setTimer: () => 1, clearTimer: () => {},
      onAutomationFailure: (notice) => { notices.push(notice); },
    });
    await handle.refreshRoster();
    await handle.tick();
    expect(fires).toBe(1);
    expect(notices.map((notice) => notice.link_url)).toEqual(['#chat/carry-on/run-auto']);
  });

  it('a trigger, whose failed run throws carrying its id', async () => {
    const store = createEventTriggersStore(memory());
    const bus = createWarehouseEventBus();
    const notices: NotificationMessage[] = [];
    store.create({ trigger_id: 't-1', recipe_id: 'buy-lamp', publisher_id: 'local',
      pattern: 'data.email.work.message.created', enabled: true, created_at: 1_000 } as never);
    const runRecipe = vi.fn().mockRejectedValue(Object.assign(new Error(REASON), { code: 'RECIPE_HAND_OFF', run_id: 'run-trig' }));
    const dispatcher = createEventTriggerDispatcher({
      bus, store, runtime: { runRecipe }, now: () => 10_000, autoDisableAfterErrors24h: 10,
      onAutomationFailure: (notice: NotificationMessage) => { notices.push(notice); },
    } as never);
    dispatcher.rebuild();
    bus.emit({ platform: 'email', slug: 'work', entity_type: 'message', event_kind: 'created', record_id: 'msg-1', at: 9_500 } as never);
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(runRecipe).toHaveBeenCalledTimes(1);
    expect(notices.map((notice) => notice.link_url)).toEqual(['#chat/carry-on/run-trig']);
  });
});
