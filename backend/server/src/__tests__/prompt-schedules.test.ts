import { resolveOwnerRecallCorpusScope } from '../chat-recall-scope.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { buildChatToolRegistryInputs, type ChatToolHandlerDeps } from '../chat-tool-handlers.js';
import Database from 'better-sqlite3';
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OWNER_CONTRACT_ID, opGrantEntry, isExecutionSource, CHAT_RPC_METHODS, SERVER_RPC_METHODS, isReservedLocalRpc,
  type InternalToolRegistry, type ExecutionSource, type PromptSchedule } from '@recued/contracts';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createSqliteChatPlanStore } from '../storage/chat-plan-store.js';
import { planApproval } from '@recued/gateway';
import { createChatOrchestrator, type ChatTurnInput } from '../chat-orchestrator.js';
import { withQueuedChatTurns } from '../chat-turn-queue.js';
import { createPromptSchedules } from '../prompt-schedules.js';
import { handleSend, handleSessionDelete, makeChatHandlers } from '../chat-handler.js';
import type { QueuedChatCommand } from '../storage/chat-turn-queue-store.js';
import { createContractStore } from '../storage/contract-store.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import { createOpAdmissionGate } from '../op-admission-gate.js';
import { createApprovalResumeAuthorityResolver } from '../approval-resume-authority.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createReadGrantChecker } from '../read-grant-checker.js';

const NOW = Date.parse('2026-10-29T12:00:00Z');
const signature = { server_kind: 'recued' as const, version: 'test', instance_id: 'scheduled-prompts' };
const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); vi.restoreAllMocks(); });
const latch = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};
const once = { title: 'Mail summary', prompt: 'Summarize the unread mail in my work mailbox.',
  mode: 'one_shot' as const, time_zone: 'UTC', run_at: new Date(NOW + 60000).toISOString() };
const recurring = { title: once.title, prompt: once.prompt, mode: 'recurring' as const, time_zone: 'UTC', cron_expression: '*/5 * * * *' };
const fixture = (options: { beforeRun?: (input: ChatTurnInput) => Promise<void>; key?: () => Uint8Array | null;
  loseAck?: boolean; beforeSubmit?: (command: QueuedChatCommand) => Promise<void> } = {}) => {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON'); ensureChatSchema(db);
  const store = createChatStore(db, options.key);
  const plans = createSqliteChatPlanStore(db, options.key);
  const registry: InternalToolRegistry = { list: () => [], listByTier: () => [], getByName: () => null,
    dispatch: async () => ({ ok: true, result: {} }), subscribeRefresh: () => () => {} };
  const raw = createChatOrchestrator({ chatStore: store, registry, selfSignature: signature });
  let now = NOW, loseAck = options.loseAck ?? false;
  const inputs: ChatTurnInput[] = [];
  const run = async (input: ChatTurnInput) => {
    inputs.push(input); await options.beforeRun?.(input); return raw.runTurn(input);
  };
  const orchestrator = withQueuedChatTurns({ ...raw, runTurn: run }, { db, store, getKey: options.key, pollMs: 10 });
  const queue = orchestrator.turnQueue!;
  const service = createPromptSchedules({ db, store, instanceId: signature.instance_id, queue: { ...queue,
    async submit(...args) {
      if (options.beforeSubmit) await options.beforeSubmit(args[0]);
      const result = await queue.submit(...args);
      if (loseAck) { loseAck = false; throw new Error('crash after durable admission'); }
      return result;
    },
  }, runTurn: run, getKey: options.key, now: () => now,
  readPlans: (session, turn) => plans.listForTurn(session, turn) });
  orchestrator.promptSchedules = service;
  cleanup.push(() => db.close(), () => queue.close());
  const settled = (session: string) => vi.waitFor(async () => {
    const turns = (await queue.snapshot(session)).turns;
    expect(turns.length).toBeGreaterThan(0);
    expect(turns.some(t => ['queued', 'running', 'cancelling'].includes(t.status))).toBe(false);
  });
  return { db, store, plans, service, queue, orchestrator, runTurn: run, inputs, settled, clock: (at: number) => { now = at; } };
};

describe('scheduled prompts use durable conversations', () => {
  it('runs the saved request now without moving its recurring timing, and works while paused', async () => {
    const f = fixture(); const schedule = (await f.service.create(recurring, 'manual-recurring'))!;
    const first = await f.service.runNow({ schedule_id: schedule.schedule_id, expected_revision: 1, submission_id: 'manual-first' });
    await f.settled(schedule.session_id);
    expect(await f.service.get(schedule.schedule_id)).toMatchObject({ enabled: true, revision: 1,
      next_run_at: schedule.next_run_at, prompt: recurring.prompt, last_turn_id: first.turn_id });
    const source = (await f.store.listMessages(schedule.session_id))[0]!.execution_source!;
    expect(source).toMatchObject({ channel: 'schedule', actor: 'system',
      prompt_schedule: { trigger: 'manual', revision: 1, due_at: NOW } });
    expect(isExecutionSource(source)).toBe(true);
    expect((await f.store.listMessages(schedule.session_id))[0]!.contributor).toBe('tool_result');
    const paused = (await f.service.control('pause', { schedule_id: schedule.schedule_id }))!;
    const second = await f.service.runNow({ schedule_id: schedule.schedule_id, expected_revision: paused.revision, submission_id: 'manual-paused' });
    await f.settled(schedule.session_id);
    expect(await f.service.get(schedule.schedule_id)).toMatchObject({ enabled: false, revision: paused.revision,
      next_run_at: null, last_turn_id: second.turn_id, last_outcome: { status: 'finished' } });
    expect(f.inputs.map(i => i.message)).toEqual([recurring.prompt, recurring.prompt]);
    expect(await f.store.listMessages(schedule.session_id)).toHaveLength(4);
  });

  it('runs a finished one-off again without rearming it or replaying its occurrence through Chat retry', async () => {
    const f = fixture(); const schedule = (await f.service.create(once, 'manual-one-off'))!;
    f.clock(NOW + 60000); await f.service.tick(); await f.settled(schedule.session_id);
    const manual = await f.service.runNow({ schedule_id: schedule.schedule_id, expected_revision: 1, submission_id: 'repeat-once' });
    await f.settled(schedule.session_id); await f.service.tick();
    expect(await f.service.get(schedule.schedule_id)).toMatchObject({ enabled: false, revision: 1,
      run_at: schedule.run_at, next_run_at: null, last_turn_id: manual.turn_id });
    const retry = await f.queue.retry(schedule.session_id, manual.turn_id, 'generic-chat-retry');
    await f.settled(schedule.session_id);
    expect((await f.queue.snapshot(schedule.session_id)).turns.find(t => t.turn_id === retry.turn_id)?.status).toBe('cancelled');
    expect(f.inputs).toHaveLength(2);
    expect((await f.service.get(schedule.schedule_id)).last_turn_id).toBe(manual.turn_id);
  });

  it('edits a finished one-off request without moving its saved instant or rearming it', async () => {
    const f = fixture(); const schedule = (await f.service.create(once, 'finished-edit'))!;
    f.clock(NOW + 60000); await f.service.tick(); await f.settled(schedule.session_id); f.clock(NOW + 120000);
    const changed = (await f.service.update({ schedule_id: schedule.schedule_id, expected_revision: 1, prompt: 'Review urgent mail only.' }))!;
    expect(changed).toMatchObject({ enabled: false, run_at: schedule.run_at, next_run_at: null, revision: 2 });
    expect(f.service.preview({ mode: 'one_shot', time_zone: 'UTC', run_at: once.run_at }))
      .toMatchObject({ next_runs: [], past_run_at: schedule.run_at });
    await expect(f.service.update({ schedule_id: schedule.schedule_id, expected_revision: 2,
      run_at: new Date(NOW).toISOString() })).rejects.toThrow('future');
    await f.service.runNow({ schedule_id: schedule.schedule_id, expected_revision: 2, submission_id: 'edited-finished-run' });
    await f.settled(schedule.session_id); await f.service.tick();
    expect(f.inputs.map(input => input.message)).toEqual([once.prompt, 'Review urgent mail only.']);
    expect((await f.service.get(schedule.schedule_id)).next_run_at).toBeNull();
  });

  it.each(['approved action', 'held tool'] as const)('keeps an older unfinished %s visible and blocks a new manual run', async kind => {
    const f = fixture(); const schedule = (await f.service.create(recurring, `older-${kind}`))!;
    f.clock(NOW + 300000); await f.service.tick(); await f.settled(schedule.session_id);
    const first = await f.service.get(schedule.schedule_id);
    if (kind === 'approved action') {
      const args = { to: 'owner@example.com' };
      await f.plans.put({ plan_id: 'older-running-action', session_id: schedule.session_id, turn_id: first.last_turn_id!,
        tool: 'mail.send', tier: 1, classification: 'write', args, args_hash: planApproval.computePlanArgsHash(args),
        status: 'proposed', created_at: NOW + 300000 });
      await f.plans.resolve('older-running-action', 'approved', NOW + 300001);
      await f.plans.consumeForDispatch!('older-running-action', NOW + 300002, 'older-resume');
    } else {
      await f.store.toolCalls!.start({ id: 'older-held-tool', session_id: schedule.session_id, turn_id: first.last_turn_id!,
        tool_name: 'recipe.run', role: 'tool', content: 'Waiting', target_server: 'self',
        picker_at_send: { display_name: 'Self', signature }, model_used: { provider: 'test', model_id: 'test' } });
      f.store.toolCalls!.hold('older-held-tool');
    }
    f.clock(NOW + 600000); await f.service.tick(); await f.settled(schedule.session_id);
    const attempt = await f.service.runNow({ schedule_id: schedule.schedule_id, expected_revision: 1, submission_id: 'while-older-action-waits' })
      .then(() => ({ accepted: true }), error => ({ accepted: false, error }));
    if (attempt.accepted) await f.settled(schedule.session_id);
    expect(attempt).toMatchObject({ accepted: false, error: { code: 'conflict' } });
    expect(await f.service.get(schedule.schedule_id)).toMatchObject({ last_outcome: { status: 'finished' }, run_now_available: false,
      pending_work: { status: kind === 'approved action' ? 'running' : 'needs_attention' } });
    expect(f.inputs).toHaveLength(2);
  });

  it('keeps Run now blocked while an action is running even if a sibling action has failed', async () => {
    const f = fixture(); const schedule = (await f.service.create(once, 'partial-action-outcome'))!;
    f.clock(NOW + 60000); await f.service.tick(); await f.settled(schedule.session_id);
    const turn = (await f.service.get(schedule.schedule_id)).last_turn_id!;
    for (const id of ['failed-sibling', 'running-sibling']) {
      const args = { to: `${id}@example.com` };
      await f.plans.put({ plan_id: id, session_id: schedule.session_id, turn_id: turn, tool: 'mail.send', tier: 1,
        classification: 'write', args, args_hash: planApproval.computePlanArgsHash(args), status: 'proposed', created_at: NOW + 60000 });
      await f.plans.resolve(id, 'approved', NOW + 60001);
      await f.plans.consumeForDispatch!(id, NOW + 60002, `${id}-resume`);
    }
    await f.plans.recordExecution!('failed-sibling', { status: 'failed', turn_id: 'failed-sibling-resume', reason: 'execution_error' });
    expect(await f.service.get(schedule.schedule_id)).toMatchObject({ last_outcome: { status: 'running' }, run_now_available: false,
      pending_work: { plan_id: 'running-sibling' } });
  });

  it('rechecks unfinished actions when admitting a manual run after a slow submission', async () => {
    const entered = latch(), release = latch(); cleanup.push(release.release);
    const f = fixture({ beforeSubmit: async command => {
      if (String(command.input.occurrence_id).includes(':manual:')) { entered.release(); await release.promise; }
    } });
    const schedule = (await f.service.create(recurring, 'late-action-admission'))!;
    f.clock(NOW + 300000); await f.service.tick(); await f.settled(schedule.session_id);
    const turn = (await f.service.get(schedule.schedule_id)).last_turn_id!;
    const attempt = f.service.runNow({ schedule_id: schedule.schedule_id, expected_revision: 1, submission_id: 'late-action' })
      .then(() => ({ accepted: true }), error => ({ accepted: false, error }));
    await entered.promise;
    const args = { to: 'owner@example.com' };
    await f.plans.put({ plan_id: 'late-action', session_id: schedule.session_id, turn_id: turn, tool: 'mail.send', tier: 1,
      classification: 'write', args, args_hash: planApproval.computePlanArgsHash(args), status: 'proposed', created_at: NOW + 300001 });
    await f.plans.resolve('late-action', 'approved', NOW + 300002);
    await f.plans.consumeForDispatch!('late-action', NOW + 300003, 'late-action-resume');
    release.release(); const result = await attempt;
    if (result.accepted) await f.settled(schedule.session_id);
    expect(result).toMatchObject({ accepted: false, error: { code: 'conflict' } });
    expect((await f.queue.snapshot(schedule.session_id)).turns).toHaveLength(1);
  });

  it('recovers a lost Run now acknowledgement after service restart and removal without another execution', async () => {
    const key = new Uint8Array(32).fill(51);
    const f = fixture({ key: () => key, loseAck: true }); const schedule = (await f.service.create(recurring, 'manual-lost-reply'))!;
    const request = { schedule_id: schedule.schedule_id, expected_revision: 1, submission_id: 'stable-manual-request' };
    await expect(f.service.runNow(request)).rejects.toThrow('crash after durable admission');
    await f.settled(schedule.session_id);
    const original = (await f.queue.snapshot(schedule.session_id)).turns[0]!;
    await f.service.control('remove', { schedule_id: schedule.schedule_id }); f.queue.close();
    const reopened = withQueuedChatTurns({ ...f.orchestrator, runTurn: f.runTurn }, { db: f.db, store: f.store, getKey: () => key, pollMs: 10 });
    cleanup.push(() => reopened.turnQueue!.close());
    const service = createPromptSchedules({ db: f.db, store: f.store, queue: reopened.turnQueue!, runTurn: f.runTurn,
      instanceId: signature.instance_id,
      getKey: () => key, readPlans: (session, turn) => f.plans.listForTurn(session, turn) });
    expect(await service.runNow(request)).toMatchObject({ turn_id: original.turn_id, status: 'completed', disposition: 'replayed' });
    await expect(service.runNow({ ...request, expected_revision: 2 })).rejects.toThrow('another schedule revision');
    await expect(service.runNow({ ...request, submission_id: 'new-after-remove' })).rejects.toThrow('no longer exists');
    expect(f.inputs).toHaveLength(1);
    const rows = f.db.prepare('SELECT turn_id, payload FROM chat_prompt_occurrences').all() as Array<{ turn_id: string; payload: string }>;
    expect(rows).toHaveLength(1); expect(rows[0]!.turn_id).toBe(original.turn_id);
    expect(rows[0]!.payload).not.toContain(recurring.prompt);
  });

  it.each([true, false])('admits simultaneous Run now requests once when their IDs match: %s', async sameId => {
    const held = latch(); cleanup.push(held.release);
    const f = fixture({ beforeRun: () => held.promise }); const schedule = (await f.service.create(recurring, 'manual-concurrent'))!;
    const requests = ['one', sameId ? 'one' : 'two'].map(submission_id => ({ schedule_id: schedule.schedule_id, expected_revision: 1, submission_id }));
    const results = await Promise.allSettled(requests.map(request => f.service.runNow(request)));
    const receipts = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
    expect(receipts).toHaveLength(sameId ? 2 : 1);
    expect(new Set(receipts.map(receipt => receipt.turn_id)).size).toBe(1);
    await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
    expect((await f.queue.snapshot(schedule.session_id)).turns).toHaveLength(1);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM chat_prompt_occurrences').get()).toEqual({ n: 1 });
    expect(await f.service.get(schedule.schedule_id)).toMatchObject({ next_run_at: schedule.next_run_at, run_now_available: false });
    held.release(); await f.settled(schedule.session_id);
  });

  it('admits only one prompt occurrence when Run now and the clock race, then retains the unclaimed clock tick', async () => {
    const held = latch(); cleanup.push(held.release);
    const f = fixture({ beforeRun: () => held.promise }); const schedule = (await f.service.create(recurring, 'manual-clock-race'))!;
    f.clock(schedule.next_run_at!);
    const [manual] = await Promise.allSettled([f.service.runNow({ schedule_id: schedule.schedule_id, expected_revision: 1, submission_id: 'race' }), f.service.tick()]);
    await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
    expect((await f.queue.snapshot(schedule.session_id)).turns).toHaveLength(1);
    expect((await f.service.get(schedule.schedule_id)).next_run_at).toBe(manual.status === 'fulfilled' ? schedule.next_run_at : NOW + 600000);
    held.release(); await f.settled(schedule.session_id); await f.service.tick(); await f.settled(schedule.session_id);
    expect(f.inputs).toHaveLength(manual.status === 'fulfilled' ? 2 : 1);
    expect((await f.service.get(schedule.schedule_id)).next_run_at).toBe(NOW + 600000);
  });

  it('refuses a Run now admission if the saved request changes while admission is in flight', async () => {
    const entered = latch(), release = latch(); cleanup.push(release.release);
    const f = fixture({ beforeSubmit: async () => { entered.release(); await release.promise; } });
    const schedule = (await f.service.create(recurring, 'manual-edit-race'))!;
    const pending = f.service.runNow({ schedule_id: schedule.schedule_id, expected_revision: 1, submission_id: 'old-edit' });
    const refused = expect(pending).rejects.toThrow('changed');
    await entered.promise;
    await f.service.update({ schedule_id: schedule.schedule_id, expected_revision: 1, prompt: 'Use the edited request.' });
    release.release(); await refused;
    expect((await f.queue.snapshot(schedule.session_id)).turns).toHaveLength(0);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM chat_prompt_occurrences').get()).toEqual({ n: 0 });
    expect(f.inputs).toHaveLength(0);
  });

  it('rolls a manual occurrence back if its queue insert fails and admits the same request after recovery', async () => {
    const f = fixture(); const schedule = (await f.service.create(recurring, 'manual-atomic-insert'))!;
    const request = { schedule_id: schedule.schedule_id, expected_revision: 1, submission_id: 'disk-retry' };
    f.db.exec("CREATE TRIGGER refuse_manual_queue BEFORE INSERT ON chat_turn_queue WHEN NEW.family='scheduled_prompt' BEGIN SELECT RAISE(ABORT, 'queue unavailable'); END;");
    await expect(f.service.runNow(request)).rejects.toThrow('queue unavailable');
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM chat_prompt_occurrences').get()).toEqual({ n: 0 });
    expect((await f.queue.snapshot(schedule.session_id)).turns).toHaveLength(0);
    f.db.exec('DROP TRIGGER refuse_manual_queue');
    await f.service.runNow(request); await f.settled(schedule.session_id);
    expect(f.inputs).toHaveLength(1);
    expect((await f.service.get(schedule.schedule_id)).next_run_at).toBe(schedule.next_run_at);
  });

  it('withdraws a queued manual run on pause and returns its cancelled receipt on retry', async () => {
    const held = latch(); cleanup.push(held.release);
    const f = fixture({ beforeRun: async input => { if (!input.scheduled_prompt) await held.promise; } });
    const schedule = (await f.service.create(recurring, 'manual-queued-pause'))!;
    await handleSend({ store: f.store, orchestrator: f.orchestrator, selfSignature: signature },
      { session_id: schedule.session_id, message: 'Owner turn', submission_id: 'owner-before-manual', picker_state: { current: 'self' } });
    await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
    const request = { schedule_id: schedule.schedule_id, expected_revision: 1, submission_id: 'queued-manual' };
    const accepted = await f.service.runNow(request);
    await f.service.control('pause', { schedule_id: schedule.schedule_id });
    expect(await f.service.runNow(request)).toMatchObject({ turn_id: accepted.turn_id, status: 'cancelled', disposition: 'replayed' });
    held.release(); await f.settled(schedule.session_id); expect(f.inputs).toHaveLength(1);
  });

  it('exposes Run now only to paired clients and refuses a new run while the chat vault is locked', async () => {
    let key: Uint8Array | null = new Uint8Array(32).fill(63);
    const f = fixture({ key: () => key }); const schedule = (await f.service.create(recurring, 'manual-authority'))!;
    const slice = makeChatHandlers({ store: f.store, orchestrator: f.orchestrator, selfSignature: signature })!;
    const handlers = slice.handlers as unknown as Record<string,
      (args: unknown, client: { instance_id: string | null }) => Promise<unknown>>;
    const request = { schedule_id: schedule.schedule_id, expected_revision: 1, submission_id: 'manual-owner' };
    expect(slice.methods).toContain('chat.schedule.run_now');
    expect(CHAT_RPC_METHODS).toContain('chat.schedule.run_now');
    expect(SERVER_RPC_METHODS).toContain('chat.schedule.run_now');
    expect(isReservedLocalRpc('chat.schedule.run_now')).toBe(true);
    await expect(handlers['chat.schedule.run_now']!(request, { instance_id: null })).rejects.toMatchObject({ code: 'unauthorized' });
    key = null;
    await expect(handlers['chat.schedule.run_now']!(request, { instance_id: 'paired' })).rejects.toThrow(/locked/i);
    expect((await f.db.prepare('SELECT COUNT(*) AS n FROM chat_prompt_occurrences').get())).toEqual({ n: 0 });
    key = new Uint8Array(32).fill(63);
    expect(await handlers['chat.schedule.run_now']!(request, { instance_id: 'paired' })).toMatchObject({ disposition: 'accepted' });
    await f.settled(schedule.session_id); expect(f.inputs).toHaveLength(1);
  });

  it('runs a one-off exactly once, records system provenance, and retains its conversation', async () => {
    const f = fixture(); const schedule = (await f.service.create(once, 'first'))!;
    expect(f.store.getSession(schedule.session_id)?.title).toBe(once.title);
    await f.service.tick(); expect(f.inputs).toHaveLength(0);
    f.clock(NOW + 60000); await Promise.all([f.service.tick(), f.service.tick()]); await f.settled(schedule.session_id);
    await f.service.tick(); expect(f.inputs).toHaveLength(1);
    expect(await f.service.get(schedule.schedule_id)).toMatchObject({ enabled: false, next_run_at: null, last_status: 'completed' });
    const messages = await f.store.listMessages(schedule.session_id);
    expect(messages.map(m => m.role)).toEqual(['user', 'assistant']);
    expect(await f.service.get(schedule.schedule_id)).toMatchObject({
      last_outcome: { status: 'finished', message_id: messages[1]!.id }, pending_approvals: null,
    });
    for (const m of messages) {
      expect(m.execution_source).toMatchObject({ channel: 'schedule', actor: 'system', schedule_id: schedule.schedule_id,
        chat_session_id: schedule.session_id, prompt_schedule: { revision: 1, due_at: NOW + 60000 } });
      expect(isExecutionSource(m.execution_source)).toBe(true);
    }
    await f.service.control('remove', { schedule_id: schedule.schedule_id });
    expect(f.store.getSession(schedule.session_id)).not.toBeNull();
    expect(await f.store.listMessages(schedule.session_id)).toHaveLength(2);
    await expect(f.service.create(once, 'first')).rejects.toThrow('removed');
    expect(messages[0]?.contributor).toBe('tool_result');
  });

  it('reuses one session for recurring turns and follow-ups without changing the saved request', async () => {
    const f = fixture(); const schedule = (await f.service.create(recurring, 'repeat'))!;
    f.clock(NOW + 300000); await f.service.tick(); await f.settled(schedule.session_id);
    await handleSend({ store: f.store, orchestrator: f.orchestrator, selfSignature: signature },
      { session_id: schedule.session_id, message: 'Explain the second item.', submission_id: 'follow-up', picker_state: { current: 'self' } });
    await f.settled(schedule.session_id);
    expect(await f.service.get(schedule.schedule_id)).toMatchObject({ revision: 1, enabled: true, prompt: recurring.prompt });
    f.clock(NOW + 600000); await f.service.tick(); await f.settled(schedule.session_id);
    expect(f.inputs.map(i => i.message)).toEqual([recurring.prompt, 'Explain the second item.', recurring.prompt]);
    expect(new Set(f.inputs.map(i => i.session_id)).size).toBe(1);
    expect(new Set(f.inputs.map(i => i.queue_turn_id)).size).toBe(3);
    expect(f.inputs[1]!.scheduled_prompt).toBeUndefined();
  });

  it('keeps older scheduled approvals visible without counting unrelated conversation actions or consuming them', async () => {
    const key = new Uint8Array(32).fill(43);
    const f = fixture({ key: () => key }); const schedule = (await f.service.create(recurring, 'approval-outcome'))!;
    const plans = createSqliteChatPlanStore(f.db, () => key);
    f.clock(NOW + 300000); await f.service.tick(); await f.settled(schedule.session_id);
    const first = await f.service.get(schedule.schedule_id);
    const args = { to: 'owner@example.com', body: 'Review the briefing.' };
    const proposal = { plan_id: 'schedule-approval', session_id: schedule.session_id, turn_id: first.last_turn_id!,
      tool: 'mail.send', tier: 1 as const, classification: 'write' as const, args,
      args_hash: planApproval.computePlanArgsHash(args), status: 'proposed' as const, created_at: NOW + 300000 };
    await plans.put(proposal);
    await plans.linkTurnToMessage!(schedule.session_id, first.last_turn_id!, first.last_outcome!.message_id!);
    await handleSend({ store: f.store, orchestrator: f.orchestrator, selfSignature: signature },
      { session_id: schedule.session_id, message: 'Send a separate note.', submission_id: 'unrelated-follow-up', picker_state: { current: 'self' } });
    await f.settled(schedule.session_id);
    await plans.put({ ...proposal, plan_id: 'ordinary-follow-up', turn_id: f.inputs.at(-1)!.queue_turn_id! });
    expect(await f.service.get(schedule.schedule_id)).toMatchObject({ last_status: 'completed',
      last_outcome: { status: 'needs_approval', plan_id: proposal.plan_id, message_id: first.last_outcome!.message_id },
      pending_approvals: { count: 1, plan_id: proposal.plan_id } });
    expect((await plans.get(proposal.plan_id))?.status).toBe('proposed');
    expect(JSON.stringify(await f.service.list())).not.toContain('owner@example.com');
    await expect(f.service.runNow({ schedule_id: schedule.schedule_id, expected_revision: 1, submission_id: 'while-awaiting-approval' }))
      .rejects.toThrow('waiting');

    f.clock(NOW + 600000); await f.service.tick(); await f.settled(schedule.session_id);
    expect(await f.service.get(schedule.schedule_id)).toMatchObject({ last_outcome: { status: 'finished' },
      pending_approvals: { count: 1, plan_id: proposal.plan_id } });
    await plans.resolve(proposal.plan_id, 'cancelled', NOW + 600001);
    expect(await f.service.get(schedule.schedule_id)).toMatchObject({ last_outcome: { status: 'finished' }, pending_approvals: null });
    expect((await plans.get('ordinary-follow-up'))?.status).toBe('proposed');
    expect(f.inputs).toHaveLength(3);
  });

  it('distinguishes approval, unexecuted approval, active dispatch and uncertain recovery after a finished turn', async () => {
    const f = fixture(); const schedule = (await f.service.create(once, 'dispatch-outcome'))!;
    const plans = createSqliteChatPlanStore(f.db);
    f.clock(NOW + 60000); await f.service.tick(); await f.settled(schedule.session_id);
    const finished = await f.service.get(schedule.schedule_id);
    const args = { to: 'owner@example.com' };
    await plans.put({ plan_id: 'dispatch', session_id: schedule.session_id, turn_id: finished.last_turn_id!,
      tool: 'mail.send', tier: 1, classification: 'write', args, args_hash: planApproval.computePlanArgsHash(args),
      status: 'proposed', created_at: NOW + 60000 });
    await plans.resolve('dispatch', 'approved', NOW + 60001);
    expect(await f.service.get(schedule.schedule_id)).toMatchObject({ last_status: 'completed',
      last_outcome: { status: 'needs_attention', reason: 'awaiting_execution', plan_id: 'dispatch' }, pending_approvals: null });
    await plans.consumeForDispatch!('dispatch', NOW + 60002, 'approval-resume');
    expect(await f.service.get(schedule.schedule_id)).toMatchObject({ last_outcome: { status: 'running' } });
    createSqliteChatPlanStore(f.db);
    expect(await f.service.get(schedule.schedule_id)).toMatchObject({
      last_outcome: { status: 'interrupted', reason: 'outcome_unknown', plan_id: 'dispatch' } });
    expect((await f.queue.snapshot(schedule.session_id)).turns).toHaveLength(1);
  });

  it('reads held, interrupted and failed tool receipts after the chat turn completes, without starting another run', async () => {
    const f = fixture(); const schedule = (await f.service.create(once, 'tool-outcome'))!;
    f.clock(NOW + 60000); await f.service.tick(); await f.settled(schedule.session_id);
    const finished = await f.service.get(schedule.schedule_id);
    const message = { id: 'scheduled-tool', session_id: schedule.session_id, turn_id: finished.last_turn_id!,
      role: 'tool' as const, content: 'Tool call', target_server: 'self',
      picker_at_send: { display_name: 'Self', signature }, model_used: { provider: 'test', model_id: 'test' } };
    const calls = f.store.toolCalls!;
    await calls.start({ ...message, tool_name: 'mail.list' });
    calls.hold(message.id);
    expect(await f.service.get(schedule.schedule_id)).toMatchObject({ last_status: 'completed',
      last_outcome: { status: 'needs_attention', reason: 'action_held' } });
    calls.interrupt(message.id, true);
    expect(await f.service.get(schedule.schedule_id)).toMatchObject({ last_outcome: { status: 'interrupted', reason: 'outcome_unknown' } });
    await f.store.appendMessage({ ...message, id: 'tool-result', content: 'Read failed.',
      tool_call_settlements: [{ message_id: message.id, state: 'failed' }] });
    expect(await f.service.get(schedule.schedule_id)).toMatchObject({ last_status: 'completed',
      last_outcome: { status: 'needs_attention', reason: 'tool_failed' } });
    expect(f.inputs).toHaveLength(1);
  });

  it('reports a failed approved action even when its chat turn finished, without applying it to a later occurrence', async () => {
    const f = fixture(); const schedule = (await f.service.create(recurring, 'action-failure'))!;
    f.clock(NOW + 300000); await f.service.tick(); await f.settled(schedule.session_id);
    const first = await f.service.get(schedule.schedule_id); const args = { to: 'owner@example.com' };
    await f.plans.put({ plan_id: 'failed-action', session_id: schedule.session_id, turn_id: first.last_turn_id!,
      tool: 'mail.send', tier: 1, classification: 'write', args, args_hash: planApproval.computePlanArgsHash(args),
      status: 'proposed', created_at: NOW + 300000 });
    await f.plans.resolve('failed-action', 'approved', NOW + 300001);
    await f.plans.consumeForDispatch!('failed-action', NOW + 300002, 'approval-resume');
    await f.plans.recordExecution!('failed-action', { status: 'failed', turn_id: 'approval-resume', reason: 'execution_error' });
    expect(await f.service.get(schedule.schedule_id)).toMatchObject({ last_status: 'completed',
      last_outcome: { status: 'failed', reason: 'tool_failed', plan_id: 'failed-action' } });
    f.clock(NOW + 600000); await f.service.tick(); await f.settled(schedule.session_id);
    expect(await f.service.get(schedule.schedule_id)).toMatchObject({ last_outcome: { status: 'finished' } });
    expect(f.inputs).toHaveLength(2);
  });

  it('reports a failed request without exposing the execution error or automatically retrying it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = fixture({ beforeRun: async () => { throw new Error('private provider detail'); } });
    const schedule = (await f.service.create(once, 'failed-outcome'))!;
    f.clock(NOW + 60000); await f.service.tick(); await f.settled(schedule.session_id);
    const result = await f.service.get(schedule.schedule_id);
    expect(result).toMatchObject({ enabled: false, last_status: 'failed', last_outcome: { status: 'failed', reason: 'turn_failed' } });
    expect(JSON.stringify(result)).not.toContain('private provider detail');
    await f.service.list(); await f.service.tick(); expect(f.inputs).toHaveLength(1);
  });

  it.each(['pause', 'remove'] as const)('%s withdraws a queued one-off and advances the queue revision even after its clock has been disarmed', async (action) => {
    const held = latch(); cleanup.push(held.release);
    const f = fixture({ beforeRun: async i => { if (!i.scheduled_prompt) await held.promise; } });
    const s = (await f.service.create(once, 'paused-queued'))!;
    await handleSend({ store: f.store, orchestrator: f.orchestrator, selfSignature: signature },
      { session_id: s.session_id, message: 'Current user turn', submission_id: 'owner', picker_state: { current: 'self' } });
    await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
    f.clock(NOW + 60000); await f.service.tick();
    expect(await f.service.get(s.schedule_id)).toMatchObject({ enabled: false, last_status: 'queued' });
    const before = await f.queue.snapshot(s.session_id);
    await f.service.control(action, { schedule_id: s.schedule_id, expected_revision: 1 });
    const after = await f.queue.snapshot(s.session_id);
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(after.turns.at(-1)?.status).toBe('cancelled');
    held.release(); await f.settled(s.session_id);
    expect(f.inputs).toHaveLength(1);
    if (action === 'pause') expect(await f.service.get(s.schedule_id)).toMatchObject({ last_status: 'cancelled' });
    else expect(await f.service.list(s.session_id)).toEqual([]);
  });

  it('pause lets a running occurrence finish and resume schedules a fresh occurrence', async () => {
    const held = latch(); cleanup.push(held.release);
    const f = fixture({ beforeRun: () => held.promise }); const s = (await f.service.create(recurring, 'running'))!;
    f.clock(NOW + 300000); await f.service.tick(); await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
    const paused = (await f.service.control('pause', { schedule_id: s.schedule_id }))!;
    held.release(); await f.settled(s.session_id);
    f.clock(NOW + 900000); await f.service.tick(); expect(f.inputs).toHaveLength(1);
    const resumed = (await f.service.control('resume', { schedule_id: s.schedule_id, expected_revision: paused.revision }))!;
    expect(resumed.next_run_at).toBe(NOW + 1200000);
    f.clock(resumed.next_run_at!); await f.service.tick(); await f.settled(s.session_id); expect(f.inputs).toHaveLength(2);
  });

  it('coalesces missed recurring ticks while an earlier occurrence is still running', async () => {
    const held = latch(); cleanup.push(held.release);
    const f = fixture({ beforeRun: () => held.promise }); const s = (await f.service.create(recurring, 'slow'))!;
    f.clock(NOW + 300000); await f.service.tick(); await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
    f.clock(NOW + 1800000); await f.service.tick();
    expect((await f.queue.snapshot(s.session_id)).turns).toHaveLength(1);
    held.release(); await f.settled(s.session_id); await f.service.tick(); await f.settled(s.session_id);
    expect(f.inputs).toHaveLength(2);
    expect((await f.service.get(s.schedule_id)).next_run_at).toBe(NOW + 2100000);
  });

  it('rotates past a full busy batch, including equal due times, then revisits earlier work after it settles', async () => {
    const held = latch(); cleanup.push(held.release);
    const f = fixture();
    f.queue.register('scheduled_prompt', async (_command, turn) => { await held.promise; return { turn_id: turn }; });
    const busy: PromptSchedule[] = [];
    for (let i = 0; i < 100; i++) busy.push((await f.service.create(recurring, `busy-${i}`))!);
    const ready = (await f.service.create({ ...once, run_at: new Date(NOW + 600000).toISOString() }, 'after-busy'))!;
    f.clock(NOW + 300000); await f.service.tick();
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM chat_prompt_occurrences').get()).toEqual({ n: 100 });
    // The busy schedules stay due at the same time as the ready one-off.
    f.clock(NOW + 900000); await f.service.tick();
    f.clock(NOW + 1200000); await f.service.tick();
    expect(await f.service.get(ready.schedule_id)).toMatchObject({ enabled: false, last_status: 'queued' });
    await f.service.tick();
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM chat_prompt_occurrences').get()).toEqual({ n: 101 });
    held.release(); await f.settled(ready.session_id);
    f.clock(NOW + 1500000); await f.service.tick();
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM chat_prompt_occurrences').get()).toEqual({ n: 201 });
    expect(await f.service.get(busy[0]!.schedule_id)).toMatchObject({ next_run_at: NOW + 1800000 });
    await f.settled(busy.at(-1)!.session_id);
  });

  it('finishes a scan pass instead of following later recurrences past earlier ready schedules', async () => {
    const held = latch(); cleanup.push(held.release);
    const f = fixture();
    f.queue.register('scheduled_prompt', async (_command, turn) => { await held.promise; return { turn_id: turn }; });
    let first: PromptSchedule | undefined;
    for (let i = 0; i < 100; i++) {
      const schedule = (await f.service.create(recurring, `earlier-${i}`))!;
      first ??= schedule;
    }
    f.clock(NOW + 300000); await f.service.tick();
    const later = (await f.service.create({ ...recurring, cron_expression: '2,7,12,17,22,27,32,37,42,47,52,57 * * * *' }, 'later-recurring'))!;
    f.clock(NOW + 900000); await f.service.tick();
    held.release(); await f.settled(later.session_id);
    // Later runs keep becoming due between clock checks. Earlier work must
    // still get another turn once its original occurrence has finished.
    for (const minutes of [20, 25, 30]) {
      f.clock(NOW + minutes * 60000); await f.service.tick(); await f.settled(later.session_id);
    }
    const count = f.db.prepare('SELECT COUNT(*) AS n FROM chat_prompt_occurrences WHERE schedule_id=?')
      .get(first!.schedule_id) as { n: number };
    expect(count.n).toBeGreaterThan(1);
  });

  it('bounds each batch and does not admit future work when the clock moves backwards between batches', async () => {
    const held = latch(); cleanup.push(held.release);
    const f = fixture();
    f.queue.register('scheduled_prompt', async (_command, turn) => { await held.promise; return { turn_id: turn }; });
    let last: PromptSchedule | undefined;
    for (let i = 0; i < 200; i++) last = (await f.service.create(once, `bounded-${i}`))!;
    for (const count of [100, 200]) {
      f.clock(NOW + 60000);
      await f.service.tick();
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM chat_prompt_occurrences').get()).toEqual({ n: count });
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM chat_prompt_schedules WHERE enabled=1').get()).toEqual({ n: 200 - count });
      if (count === 100) {
        f.clock(NOW); await f.service.tick();
        expect(f.db.prepare('SELECT COUNT(*) AS n FROM chat_prompt_occurrences').get()).toEqual({ n: 100 });
      }
    }
    await f.service.tick();
    expect(f.db.prepare('SELECT COUNT(DISTINCT turn_id) AS n FROM chat_prompt_occurrences').get()).toEqual({ n: 200 });
    held.release(); await f.settled(last!.session_id);
  });

  it('recovers a lost admission acknowledgement after rebuilding the schedule service without replaying its occurrence', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = fixture({ loseAck: true }); const s = (await f.service.create(once, 'lost-ack'))!;
    f.clock(NOW + 60000); await f.service.tick(); await f.settled(s.session_id);
    expect((await f.service.get(s.schedule_id)).enabled).toBe(true);
    expect((await f.service.get(s.schedule_id)).scheduling_issue).toBeNull();
    const recovered = createPromptSchedules({ db: f.db, store: f.store, queue: f.queue,
      instanceId: signature.instance_id, runTurn: f.runTurn, now: () => NOW + 60000,
      readPlans: (session, turn) => f.plans.listForTurn(session, turn) });
    await recovered.tick(); await f.settled(s.session_id);
    expect(f.inputs).toHaveLength(1);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM chat_prompt_occurrences').get()).toEqual({ n: 1 });
    expect((await f.service.get(s.schedule_id)).enabled).toBe(false);
  });

  it('does not attribute an old admission failure to a newly edited request', async () => {
    const entered = latch(), release = latch(); cleanup.push(release.release);
    const f = fixture({ beforeSubmit: async () => { entered.release(); await release.promise; throw new Error('PRIVATE queue error'); } });
    const schedule = (await f.service.create(once, 'edit-during-queue-failure'))!;
    f.clock(NOW + 60000); const tick = f.service.tick(); await entered.promise;
    await f.service.update({ schedule_id: schedule.schedule_id, expected_revision: 1, run_at: new Date(NOW + 180000).toISOString() });
    release.release(); await tick;
    expect(await f.service.get(schedule.schedule_id)).toMatchObject({ revision: 2, next_run_at: NOW + 180000, scheduling_issue: null });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM chat_prompt_schedule_notices').get()).toEqual({ n: 0 });
  });

  it('edits use revisions, keep immutable occurrence snapshots, and retain a paused state', async () => {
    const f = fixture(); const s = (await f.service.create(recurring, 'edit'))!;
    f.clock(NOW + 300000); await f.service.tick(); await f.settled(s.session_id);
    await f.service.update({ schedule_id: s.schedule_id, expected_revision: 1, prompt: 'Check the news.' });
    await expect(f.service.update({ schedule_id: s.schedule_id, expected_revision: 1, prompt: 'Stale edit.' })).rejects.toThrow('changed');
    f.clock(NOW + 600000); await f.service.tick(); await f.settled(s.session_id);
    expect(f.inputs.map(i => [i.message, i.scheduled_prompt?.revision])).toEqual([[recurring.prompt, 1], ['Check the news.', 2]]);
    await f.service.control('pause', { schedule_id: s.schedule_id });
    expect(await f.service.update({ schedule_id: s.schedule_id, expected_revision: 3, cron_expression: '0 9 * * *' }))
      .toMatchObject({ enabled: false, next_run_at: null });
  });

  it('deleting the conversation cancels its schedule and queued occurrences', async () => {
    const held = latch(); cleanup.push(held.release);
    const f = fixture({ beforeRun: () => held.promise }); const s = (await f.service.create(recurring, 'delete'))!;
    f.clock(NOW + 300000); await f.service.tick(); await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
    await handleSessionDelete({ store: f.store, orchestrator: f.orchestrator, selfSignature: signature }, { session_id: s.session_id });
    held.release(); await new Promise(resolve => setTimeout(resolve, 30));
    expect(await f.service.list()).toEqual([]); expect(f.store.getSession(s.session_id)).toBeNull();
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM chat_turn_queue').get()).toEqual({ n: 0 });
  });

  it('encrypts prompts and snapshots, refuses a locked vault, and does not create in check mode', async () => {
    let key: Uint8Array | null = new Uint8Array(32).fill(21);
    const f = fixture({ key: () => key });
    expect(await f.service.create(once, 'check', true)).toBeNull(); expect(await f.service.list()).toEqual([]);
    const s = (await f.service.create(once, 'encrypted'))!;
    f.clock(NOW + 60000); await f.service.tick(); await f.settled(s.session_id);
    for (const table of ['chat_prompt_schedules', 'chat_prompt_occurrences']) {
      expect(JSON.stringify(f.db.prepare(`SELECT * FROM ${table}`).all())).not.toContain(once.prompt);
    }
    key = null; await expect(f.service.list()).rejects.toThrow();
    await expect(f.service.create({ ...once, run_at: new Date(NOW + 120000).toISOString() }, 'locked')).rejects.toThrow();
  });

  it('validates timezones, future one-offs, cron cadence, idempotent creation, and scheduler shutdown', async () => {
    const f = fixture();
    for (const input of [{ ...once, run_at: '2026-10-30T09:00:00' }, { ...once, time_zone: 'Bad/Zone' },
      { ...recurring, cron_expression: '* * * * *' }, { ...recurring, cron_expression: '1,59 * * * *' }, { ...recurring, cron_expression: '*/5,2 * * * *' }]) {
      await expect(f.service.create(input, 'bad')).rejects.toThrow();
    }
    const s = (await f.service.create(once, 'duplicate'))!;
    expect(await f.service.create(once, 'duplicate')).toEqual(s);
    await expect(f.service.create({ ...once, prompt: 'different' }, 'duplicate')).rejects.toThrow('creation ID');
    f.clock(NOW + 60000); await f.service.tick(() => true); expect(f.inputs).toHaveLength(0);
    expect((await f.service.get(s.schedule_id)).next_run_at).toBe(NOW + 60000);
    const zoned = (await f.service.create({ ...recurring, cron_expression: '0 9 * * *', time_zone: 'America/Los_Angeles' }, 'zone'))!;
    expect(zoned.next_run_at).toBe(Date.parse('2026-10-29T16:00:00Z'));
  });
});

describe('scheduled prompt timing previews', () => {
  it('uses the server clock and save-time calculation without writing or executing, and preserves exact one-off instants', async () => {
    const f = fixture(); f.clock(Date.parse('2026-10-29T08:59:45Z'));
    const timing = { mode: 'recurring' as const, time_zone: 'UTC', cron_expression: '0 9 * * 1-5' };
    const before = f.db.prepare('SELECT total_changes() AS n').get();
    const preview = f.service.preview(timing);
    expect(preview.next_runs.map(at => new Date(at).toISOString())).toEqual([
      '2026-10-29T09:00:00.000Z', '2026-10-30T09:00:00.000Z', '2026-11-02T09:00:00.000Z',
    ]);
    expect(f.service.preview({ mode: 'one_shot', time_zone: 'America/New_York', run_at: '2026-10-29T05:01:27.123-04:00' }))
      .toMatchObject({ next_runs: [Date.parse('2026-10-29T09:01:27.123Z')] });
    expect(f.db.prepare('SELECT total_changes() AS n').get()).toEqual(before); expect(f.inputs).toHaveLength(0);
    const saved = (await f.service.create({ ...recurring, ...timing }, 'preview-save-parity'))!;
    expect(saved.next_run_at).toBe(preview.next_runs[0]);
  });

  it.each([
    { from: '2026-03-08T05:00:00Z', cron: '30 2 * * *', expected: ['2026-03-09T06:30:00.000Z', '2026-03-10T06:30:00.000Z', '2026-03-11T06:30:00.000Z'] },
    { from: '2026-11-01T04:00:00Z', cron: '30 1 * * *', expected: ['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z', '2026-11-02T06:30:00.000Z'] },
  ])('previews the execution clock across daylight-saving changes from $from', ({ from, cron, expected }) => {
    const f = fixture(); f.clock(Date.parse(from));
    expect(f.service.preview({ mode: 'recurring', time_zone: 'America/New_York', cron_expression: cron })
      .next_runs.map(at => new Date(at).toISOString())).toEqual(expected);
  });

  it('bounds sparse previews to one year and rejects caller clock overrides and invalid timing', () => {
    const f = fixture(); const timing = { mode: 'recurring', time_zone: 'UTC', cron_expression: '0 0 1 1 *' };
    const preview = f.service.preview(timing);
    expect(preview.next_runs).toEqual([Date.parse('2027-01-01T00:00:00Z')]);
    expect(preview.window_ends_at).toBeLessThanOrEqual(NOW + 367 * 86400000);
    expect(() => f.service.preview({ ...timing, calculated_at: NOW - 86400000 })).toThrow('Unknown schedule timing field');
    expect(() => f.service.preview({ ...timing, cron_expression: '* * * * *' })).toThrow('five minutes');
    expect(() => f.service.preview({ ...timing, time_zone: 'Bad/Zone' })).toThrow('IANA timezone');
  });

  it('keeps preview paired-only and read-only even when the chat vault is locked', async () => {
    const f = fixture({ key: () => null });
    const slice = makeChatHandlers({ store: f.store, orchestrator: f.orchestrator, selfSignature: signature })!;
    const handlers = slice.handlers as unknown as Record<string,
      (args: unknown, client: { instance_id: string | null }) => Promise<unknown>>;
    const timing = { mode: 'recurring', time_zone: 'UTC', cron_expression: '*/5 * * * *' };
    expect(slice.methods).toContain('chat.schedule.preview'); expect(CHAT_RPC_METHODS).toContain('chat.schedule.preview');
    expect(SERVER_RPC_METHODS).toContain('chat.schedule.preview'); expect(isReservedLocalRpc('chat.schedule.preview')).toBe(true);
    const before = f.db.prepare('SELECT total_changes() AS n').get();
    await expect(handlers['chat.schedule.preview']!(timing, { instance_id: null })).rejects.toMatchObject({ code: 'unauthorized' });
    expect(await handlers['chat.schedule.preview']!(timing, { instance_id: 'paired' })).toMatchObject({
      calculated_at: NOW, next_runs: [NOW + 300000, NOW + 600000, NOW + 900000] });
    expect(f.db.prepare('SELECT total_changes() AS n').get()).toEqual(before); expect(f.inputs).toHaveLength(0);
  });

  it('retains creation-retry compatibility with an encrypted one-off saved before timing validation was shared', async () => {
    const key = new Uint8Array(32).fill(79), f = fixture({ key: () => key });
    const input = { title: once.title, prompt: once.prompt, mode: 'one_shot' as const,
      time_zone: 'America/New_York', run_at: '2026-10-29T08:01:00-04:00' };
    const saved = (await f.service.create(input, 'legacy-one-off-fingerprint'))!;
    const legacyHash = createHmac('sha256', key).update(JSON.stringify(input)).digest('hex');
    f.db.prepare('UPDATE chat_prompt_schedules SET creation_hash=? WHERE schedule_id=?').run(legacyHash, saved.schedule_id);
    expect(await f.service.create(input, 'legacy-one-off-fingerprint')).toEqual(saved);
  });
});

it('scheduled prompt tools use current owner grants and resume under their original system identity', () => {
  const db = new Database(':memory:'); cleanup.push(() => db.close());
  const contracts = createContractStore(db), grants = createContractGrantEntryStore(contracts);
  const definitions = createContractDefinitionStore(contracts);
  const gate = createOpAdmissionGate({ grantEntryStore: grants, definitionStore: definitions });
  const source: ExecutionSource = { channel: 'schedule', actor: 'system', cron: '0 9 * * *', schedule_id: 'ps', chat_session_id: 'session', turn_id: 'turn',
    prompt_schedule: { schedule_id: 'ps', occurrence_id: 'ps:1:1', revision: 1, due_at: 1, cron: '0 9 * * *', trigger: 'manual' } };
  expect(resolveOwnerRecallCorpusScope(source, definitions)?.governing_contract_id).toBe(OWNER_CONTRACT_ID);
  expect(gate.isOwnerGoverned(source)).toBe(true); expect(gate.isOpGranted(source, 'core.mail.send')).toBe(true);
  grants.set(OWNER_CONTRACT_ID, opGrantEntry('core.mail.send'), false, NOW);
  expect(gate.isOpGranted(source, 'core.mail.send')).toBe(false);
  const authority = createApprovalResumeAuthorityResolver({ manifests: createManifestRegistry(), opAdmissionGate: gate });
  expect(authority.resolve({ execution_source: source, required_raw_op_id: 'core.mail.send' })).toMatchObject({ admitted: false });
  expect(authority.resolve({ execution_source: source })).toEqual({ admitted: true, execution_source: source });
  expect(isExecutionSource({ ...source, contract_id: OWNER_CONTRACT_ID })).toBe(false);
});


it('scheduled work reads and write review use current owner grants without admitting ordinary system jobs', async () => {
  const f = fixture(), contracts = createContractStore(f.db), grants = createContractGrantEntryStore(contracts);
  const gate = createOpAdmissionGate({ grantEntryStore: grants, definitionStore: createContractDefinitionStore(contracts) });
  ensureWorkEntitySchema(f.db); const work = createWorkEntityStore(f.db); autoRegisterRecuedBuiltinSources(work);
  work.writeTask({ id: 'scheduled-task', source_id: 'recued.task', title: 'Review briefing' }, NOW);
  const resolver = createWorkEntityResolver(work), checker = createReadGrantChecker({ isGranted: () => true }, OWNER_CONTRACT_ID);
  const crud = { store: work, resolver, dispatchers: createWorkEntityDispatchers({ store: work, resolver }) };
  const deps: ChatToolHandlerDeps = { getContactStore: () => undefined, getCollectionRegistry: () => undefined, getAuditLog: () => undefined,
    getEnrichmentStore: () => undefined, getRecipeStore: () => { throw new Error('unused'); },
    getExecutorConfig: () => { throw new Error('unused'); }, getExecuteRecipe: () => undefined,
    getOpAdmissionGate: () => gate, getWorkEntityResolver: () => resolver, getWorkEntityCrudDeps: () => crud,
    getReadGrantResolver: () => ({ resolveForSource: () => checker, resolveForContract: () => checker }) };
  const tools = buildChatToolRegistryInputs(deps);
  const source: ExecutionSource = { channel: 'schedule', actor: 'system', cron: 'one_shot', schedule_id: 'ps', chat_session_id: 'S', turn_id: 'T',
    prompt_schedule: { schedule_id: 'ps', occurrence_id: 'ps:1:1', revision: 1, due_at: 1, cron: 'one_shot' } };
  const ctx = { channel: 'internal_function_call' as const, session_id: 'S', turn_id: 'T', execution_source: source };
  expect(await tools.tier1Handlers['work.read']!({ kind: 'task', id: 'scheduled-task' }, ctx)).toMatchObject({ ok: true, result: { found: true, entity: { title: 'Review briefing' } } });
  expect(await tools.tier1Checks['work.update']({ kind: 'task', id: 'scheduled-task', done: true }, ctx)).toBeNull();
  expect(work.readTask('scheduled-task')!.done).toBe(false);
  grants.set(OWNER_CONTRACT_ID, opGrantEntry('core.work-entity.read'), false, NOW);
  expect(await tools.tier1Handlers['work.read']!({ kind: 'task', id: 'scheduled-task' }, ctx)).toMatchObject({ ok: true, result: { found: false, entity: null, hint: expect.any(String) } });
  grants.set(OWNER_CONTRACT_ID, opGrantEntry('core.work-entity.task.mark-done'), false, NOW);
  expect(await tools.tier1Checks['work.update']({ kind: 'task', id: 'scheduled-task', done: true }, ctx)).toMatchObject({ ok: false });
  grants.set(OWNER_CONTRACT_ID, opGrantEntry('core.work-entity.read'), true, NOW);
  grants.set(OWNER_CONTRACT_ID, opGrantEntry('core.work-entity.task.mark-done'), true, NOW);
  const ordinary: ExecutionSource = { channel: 'schedule', actor: 'system', cron: 'one_shot', source_recipe: 'ordinary-recipe' };
  expect(await tools.tier1Handlers['work.read']!({ kind: 'task', id: 'scheduled-task' }, { ...ctx, execution_source: ordinary })).toMatchObject({ ok: true, result: { found: false, entity: null, hint: expect.any(String) } });
  expect(await tools.tier1Checks['work.update']({ kind: 'task', id: 'scheduled-task', done: true }, { ...ctx, execution_source: ordinary })).toMatchObject({ ok: false });
});

it('model schedule tools check owner authority and the grant before asking or writing', async () => {
  const f = fixture();
  const contracts = createContractStore(f.db), grants = createContractGrantEntryStore(contracts);
  const definitions = createContractDefinitionStore(contracts);
  const gate = createOpAdmissionGate({ grantEntryStore: grants, definitionStore: definitions });
  const deps: ChatToolHandlerDeps = {
    getContactStore: () => undefined, getCollectionRegistry: () => undefined, getAuditLog: () => undefined,
    getEnrichmentStore: () => undefined, getRecipeStore: () => { throw new Error('unused'); },
    getExecutorConfig: () => { throw new Error('unused'); }, getExecuteRecipe: () => undefined,
    getOpAdmissionGate: () => gate, getPromptSchedules: () => f.service,
  };
  const tools = buildChatToolRegistryInputs(deps);
  const ctx = { channel: 'internal_function_call' as const, session_id: 'owner', turn_id: 'create-turn',
    execution_source: { channel: 'chat' as const, actor: 'user_self' as const, chat_session_id: 'owner', user_id: 'owner', turn_id: 'create-turn' } };
  await tools.tier1Checks['schedule.run_prompt'](once, ctx);
  expect(await f.service.list()).toEqual([]);
  expect(await tools.tier1Handlers['schedule.run_prompt']!(once, ctx)).toMatchObject({ ok: true });
  expect(await f.service.list()).toHaveLength(1);
  grants.set(OWNER_CONTRACT_ID, opGrantEntry('core.schedule.prompt'), false, NOW);
  expect(await tools.tier1Handlers['schedule.run_prompt']!(once, { ...ctx, turn_id: 'denied' })).toMatchObject({ ok: false });
  grants.set(OWNER_CONTRACT_ID, opGrantEntry('core.schedule.prompt'), true, NOW);
  expect(await tools.tier1Handlers['schedule.run_prompt']!(once, { channel: 'mcp_wire',
    execution_source: { channel: 'mcp', actor: 'contracted_user', mcp_token_id: 'remote', contract_id: 'remote', agent_id: 'remote', tool_call_id: 'remote' } })).toMatchObject({ ok: false });
  expect(await f.service.list()).toHaveLength(1);
});


it('chat.send cannot forge scheduled provenance', async () => {
  const f = fixture(); f.store.createSession({ id: 'owner-session' });
  const input = { session_id: 'owner-session', message: 'Hello', submission_id: 'untrusted', picker_state: { current: 'self' as const },
    scheduled_prompt: { schedule_id: 'ps', occurrence_id: 'ps:1:1', revision: 1, due_at: 1, cron: 'one_shot' } };
  await handleSend({ store: f.store, orchestrator: f.orchestrator, selfSignature: signature }, input);
  await f.settled('owner-session'); expect(f.inputs[0]?.scheduled_prompt).toBeUndefined();
  expect((await f.store.listMessages('owner-session'))[0]?.contributor).toBe('user');
});
