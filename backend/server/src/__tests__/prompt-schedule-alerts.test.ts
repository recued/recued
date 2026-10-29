import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shouldSuppressForQuietHours } from '@recued/contracts';
import type { NotificationBlock } from '@recued/notification';
import type { AuditLogStore } from '@recued/storage';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createChatOrchestrator } from '../chat-orchestrator.js';
import type { InternalToolRegistry, ResourceReview } from '@recued/contracts';
import { planApproval } from '@recued/gateway';
import { createSqliteChatPlanStore } from '../storage/chat-plan-store.js';
import { createQuietHoursStore } from '../storage/quiet-hours-store.js';
import { withQueuedChatTurns } from '../chat-turn-queue.js';
import { createPromptSchedules } from '../prompt-schedules.js';
import { createPromptScheduleAlertRuntime } from '../prompt-schedule-alert-runtime.js';
import { createEventBus } from '../events/bus.js';
import { settleChatToolCall } from '../storage/chat-tool-call-store.js';
import { recordLocalMutation } from '../local-mutation-context.js';

const NOW = Date.parse('2026-10-29T12:00:00Z');
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const latch = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
type Activity = Parameters<AuditLogStore['logActivity']>[0];
const fixture = () => {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON'); ensureChatSchema(db);
  const store = createChatStore(db), plans = createSqliteChatPlanStore(db), quiet = createQuietHoursStore(db), events = createEventBus();
  let at = NOW, behavior: 'success' | 'fail' | 'decoder_failure' = 'fail', refuse = false, unlocked = true;
  const runTurn = async (input: { queue_turn_id?: string; session_id: string }): Promise<{ turn_id: string }> => {
    if (behavior === 'fail') throw new Error('PRIVATE provider diagnostic and account secret');
    if (behavior === 'decoder_failure') service.recordFailure({ kind: 'chat.transparency', session_id: input.session_id,
      turn_id: input.queue_turn_id!, event: { kind: 'engine.decoder_unavailable', reason: 'provider_failure', site: 'initial' } });
    return { turn_id: input.queue_turn_id! };
  };
  // These tests exercise real admission and terminal queue rows; no model or action runs.
  const registry: InternalToolRegistry = { list: () => [], listByTier: () => [], getByName: () => null,
    dispatch: async () => ({ ok: true, result: {} }), subscribeRefresh: () => () => {} };
  const base = createChatOrchestrator({ chatStore: store, registry,
    selfSignature: { server_kind: 'recued', version: 'fixture', instance_id: 'alert-fixture' } });
  const queued = withQueuedChatTurns({ ...base, runTurn }, { db, store, pollMs: 10 });
  const queue = queued.turnQueue!;
  const service = createPromptSchedules({ db, store, instanceId: 'alert-fixture', now: () => at, runTurn,
    queue: { ...queue, submit: (...args) => {
      if (refuse && !String(args[0].input.occurrence_id).includes(':manual:')) return Promise.reject(new Error('PRIVATE queue failure'));
      return queue.submit(...args);
    } }, readPlans: (session, turn) => plans.listForTurn(session, turn) });
  cleanup.push(() => { queue.close(); db.close(); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const history = new Map<string, Activity>();
  const log = vi.fn(async (activity: Activity) => { history.set(activity.activity_id, activity); });
  const notify = vi.fn<NotificationBlock['notify']>(async () => {});
  const runtime = (extra: Partial<Parameters<typeof createPromptScheduleAlertRuntime>[0]> = {}) => {
    const value = createPromptScheduleAlertRuntime({ db, schedules: service, auditLog: { logActivity: log },
      notifier: { notify }, events, now: () => at, canRun: () => unlocked,
      isQuiet: time => shouldSuppressForQuietHours({ policy: quiet.read(), instant: time, timeZone: 'UTC' }),
      getPublicBaseUrl: () => 'https://owner.example.test/', ...extra });
    cleanup.push(() => value.stop()); return value;
  };
  const create = async (id = 'schedule') => (await service.create({ title: 'Morning briefing', prompt: 'PRIVATE saved request',
    mode: 'recurring', time_zone: 'UTC', cron_expression: '*/5 * * * *' }, id))!;
  const settled = (session: string) => vi.waitFor(async () => {
    const rows = (await queue.snapshot(session)).turns;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some(row => ['queued', 'running', 'cancelling'].includes(row.status))).toBe(false);
  });
  const run = async (schedule: Awaited<ReturnType<typeof create>>, id: string) => {
    await service.runNow({ schedule_id: schedule.schedule_id, expected_revision: schedule.revision, submission_id: id });
    await settled(schedule.session_id);
  };
  return { db, store, plans, quiet, events, service, runtime, log, history, notify, create, run, settled,
    clock: (time: number) => { at = time; }, behavior: (value: typeof behavior) => { behavior = value; },
    refuse: (value: boolean) => { refuse = value; }, unlocked: (value: boolean) => { unlocked = value; } };
};

describe('scheduled prompt failure notices', () => {
  it('retains a native decoder failure despite a completed transport, then recovers only on a later successful run', async () => {
    const f = fixture(), schedule = await f.create(); f.behavior('decoder_failure'); await f.run(schedule, 'provider-refusal');
    expect(await f.service.get(schedule.schedule_id)).toMatchObject({ last_status: 'completed',
      last_outcome: { status: 'failed', reason: 'turn_failed' } });
    f.quiet.write({ enabled: true, from_minute: 11 * 60, to_minute: 13 * 60 }, NOW);
    const first = f.runtime(); await first.tick(); await first.stop();
    expect(f.history.size).toBe(1); expect(f.notify).not.toHaveBeenCalled();
    const second = f.runtime(); await second.tick();
    f.quiet.write({ enabled: false }, NOW); await second.tick(); await second.tick();
    expect(f.notify).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.db.prepare('SELECT * FROM chat_prompt_failure_signals').all())).not.toContain('PRIVATE');
    f.clock(NOW + 1); f.behavior('success'); await f.run(schedule, 'recovered'); await second.tick();
    expect((await f.service.get(schedule.schedule_id)).last_outcome?.status).toBe('finished');
    f.clock(NOW + 2); f.behavior('decoder_failure'); await f.run(schedule, 'failed-again'); await second.tick();
    expect(f.notify).toHaveBeenCalledTimes(2);
  });

  it('ignores failure events for other turns and removed schedules, and does not treat normal Chat completion as a failure', async () => {
    const f = fixture(), schedule = await f.create(); f.behavior('success'); await f.run(schedule, 'success');
    const turn = (await f.service.get(schedule.schedule_id)).last_turn_id!;
    f.service.recordFailure({ kind: 'chat.session_changed', session_id: schedule.session_id, field: 'queue', value: true });
    f.service.recordFailure({ kind: 'chat.transparency', session_id: schedule.session_id, turn_id: 'ordinary-chat-turn',
      event: { kind: 'engine.decoder_unavailable', reason: 'provider_failure', site: 'initial' } });
    f.service.recordFailure({ kind: 'chat.transparency', session_id: 'another-conversation', turn_id: turn,
      event: { kind: 'engine.decoder_unavailable', reason: 'provider_failure', site: 'initial' } });
    expect((await f.service.get(schedule.schedule_id)).last_outcome?.status).toBe('finished');
    await f.service.control('remove', { schedule_id: schedule.schedule_id, expected_revision: 1 });
    f.service.recordFailure({ kind: 'chat.transparency', session_id: schedule.session_id, turn_id: turn,
      event: { kind: 'engine.decoder_unavailable', reason: 'provider_failure', site: 'initial' } });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM chat_prompt_failure_signals').get()).toEqual({ n: 0 });
  });

  it('reports a current queue failure without storing or sending request or provider details, then clears it on admission', async () => {
    const f = fixture(), schedule = await f.create(); f.refuse(true); f.clock(NOW + 300000);
    await f.service.tick();
    const issue = (await f.service.get(schedule.schedule_id)).scheduling_issue;
    expect(issue).toEqual({ code: 'queue_unconfirmed', since_at: NOW + 300000 });
    f.clock(NOW + 360000); await f.service.tick();
    expect((await f.service.get(schedule.schedule_id)).scheduling_issue).toEqual(issue);
    const notices = f.runtime(); await notices.tick();
    expect(f.notify).toHaveBeenCalledOnce();
    expect(f.notify.mock.calls[0]![0]).toMatchObject({ title: 'Scheduled prompt needs attention',
      link_url: `https://owner.example.test/#chat/session/${schedule.session_id}` });
    expect(f.notify.mock.calls[0]![0].text).toContain('could not confirm');
    expect(f.notify.mock.calls[0]![0].text).toContain('Morning briefing');
    expect(JSON.stringify([...f.history.values()])).not.toContain('PRIVATE');
    expect(JSON.stringify(f.db.prepare('SELECT * FROM chat_prompt_schedule_notices').all())).not.toContain('PRIVATE');
    f.refuse(false); f.behavior('success'); await f.service.tick(); await f.settled(schedule.session_id);
    await notices.tick();
    expect((await f.service.get(schedule.schedule_id)).scheduling_issue).toBeNull();
    expect(f.notify).toHaveBeenCalledOnce();
  });

  it('keeps one notice per failed episode across repeated failures and runtime restarts; a successful run starts a new episode', async () => {
    const f = fixture(), schedule = await f.create(); await f.run(schedule, 'first');
    const first = f.runtime(); await first.tick(); await first.tick();
    await f.run(schedule, 'still-failing'); await first.tick();
    expect(f.notify).toHaveBeenCalledOnce();
    await first.stop(); const second = f.runtime(); await second.tick();
    expect(f.notify).toHaveBeenCalledOnce();
    f.behavior('success'); await f.run(schedule, 'recovered'); await second.tick();
    f.behavior('fail'); await f.run(schedule, 'new-failure'); await second.tick();
    expect(f.notify).toHaveBeenCalledTimes(2);
    expect(new Set(f.notify.mock.calls.map(call => call[2]!.persisted_activity_id)).size).toBe(2);
    expect(f.history.size).toBe(2);
    expect(JSON.stringify(f.notify.mock.calls)).not.toContain('PRIVATE');
  });

  it('persists history once while quiet, holds through restart and pushes once after quiet hours end', async () => {
    const f = fixture(), schedule = await f.create(); await f.run(schedule, 'quiet-failure');
    f.quiet.write({ enabled: true, from_minute: 11 * 60, to_minute: 13 * 60 }, NOW);
    const first = f.runtime(); await first.tick(); await first.tick();
    expect(f.history.size).toBe(1); expect(f.log).toHaveBeenCalledOnce(); expect(f.notify).not.toHaveBeenCalled();
    expect([...f.service.heldNoticeIds()]).toEqual([...f.history.keys()]);
    await first.stop(); const second = f.runtime(); await second.tick();
    expect(f.log).toHaveBeenCalledOnce(); expect(f.notify).not.toHaveBeenCalled();
    expect([...f.service.heldNoticeIds()]).toEqual([...f.history.keys()]);
    f.clock(NOW + 3600000); await second.tick(); await second.tick();
    expect(f.notify).toHaveBeenCalledOnce();
    expect(f.notify.mock.calls[0]![2]).toMatchObject({ ui_link_url: `#chat/session/${schedule.session_id}` });
    expect(f.service.heldNoticeIds().size).toBe(0);
  });

  it('suppresses a deferred push if a later run succeeds during quiet hours', async () => {
    const f = fixture(), schedule = await f.create(); await f.run(schedule, 'failed');
    f.quiet.write({ enabled: true, from_minute: 0, to_minute: 23 * 60 }, NOW);
    const notices = f.runtime(); await notices.tick();
    f.behavior('success'); await f.run(schedule, 'fixed'); await notices.tick();
    f.quiet.write({ enabled: false }, NOW); await notices.tick();
    expect(f.history.size).toBe(1); expect(f.notify).not.toHaveBeenCalled();
    expect([...f.service.heldNoticeIds()]).toEqual([...f.history.keys()]);
    f.clock(NOW + 1); f.behavior('fail'); await f.run(schedule, 'later-failure'); await notices.tick();
    expect(f.notify).toHaveBeenCalledOnce();
    expect(f.service.heldNoticeIds().has([...f.history.keys()][0]!)).toBe(true);
    await f.service.control('remove', { schedule_id: schedule.schedule_id, expected_revision: 1 });
    expect(f.service.heldNoticeIds().has([...f.history.keys()][0]!)).toBe(true);
  });

  it('waits for an unlocked vault before reading outcomes or persisting a notice', async () => {
    const f = fixture(), schedule = await f.create(); await f.run(schedule, 'failure');
    const get = vi.spyOn(f.service, 'get'); f.unlocked(false);
    const notices = f.runtime(); await notices.tick();
    expect(get).not.toHaveBeenCalled(); expect(f.log).not.toHaveBeenCalled(); expect(f.notify).not.toHaveBeenCalled();
    f.unlocked(true); await notices.tick(); expect(f.notify).toHaveBeenCalledOnce();
  });

  it('does not keep decrypting unchanged failed requests after their notice was claimed', async () => {
    const f = fixture(), schedule = await f.create(); await f.run(schedule, 'failure');
    const get = vi.spyOn(f.service, 'get'), notices = f.runtime(); await notices.tick();
    const calls = get.mock.calls.length; expect(calls).toBeGreaterThan(0);
    await notices.tick(); await notices.tick(); expect(get).toHaveBeenCalledTimes(calls);
  });

  it('rechecks a completed turn when a recorded action fails later, without alerting for normal approval waits', async () => {
    const f = fixture(), schedule = await f.create(); f.behavior('success'); await f.run(schedule, 'turn');
    const turn = (await f.service.get(schedule.schedule_id)).last_turn_id!;
    const notices = f.runtime(); await notices.tick(); expect(f.notify).not.toHaveBeenCalled();
    await f.plans.put({ plan_id: 'late-action', session_id: schedule.session_id, turn_id: turn, tool: 'mail.send',
      tier: 1, classification: 'write', args: {}, args_hash: planApproval.computePlanArgsHash({}), status: 'proposed', created_at: NOW });
    f.events.emit({ kind: 'chat.session_changed', session_id: schedule.session_id, field: 'queue', value: true });
    await notices.tick(); expect(f.notify).not.toHaveBeenCalled();
    await f.plans.resolve('late-action', 'approved', NOW + 1);
    await f.plans.consumeForDispatch!('late-action', NOW + 2, 'execution');
    await f.plans.recordExecution!('late-action', { status: 'failed', turn_id: 'execution', reason: 'execution_error' });
    f.events.emit({ kind: 'chat.session_changed', session_id: schedule.session_id, field: 'queue', value: true });
    await notices.tick(); expect(f.notify).toHaveBeenCalledOnce();
  });

  it('retains a late failure from an older action after a newer run finished, including across restart', async () => {
    const f = fixture(), schedule = await f.create(); f.behavior('success'); await f.run(schedule, 'first');
    const turn = (await f.service.get(schedule.schedule_id)).last_turn_id!;
    await f.plans.put({ plan_id: 'older-action', session_id: schedule.session_id, turn_id: turn, tool: 'mail.send',
      tier: 1, classification: 'write', args: {}, args_hash: planApproval.computePlanArgsHash({}), status: 'proposed', created_at: NOW });
    await f.plans.resolve('older-action', 'approved', NOW + 1);
    await f.plans.consumeForDispatch!('older-action', NOW + 2, 'older-execution');
    f.clock(NOW + 300000); await f.service.tick(); await f.settled(schedule.session_id);
    expect((await f.service.get(schedule.schedule_id)).last_turn_id).not.toBe(turn);
    const first = f.runtime(); await first.tick(); expect(f.notify).not.toHaveBeenCalled();
    await f.plans.recordExecution!('older-action', { status: 'failed', turn_id: 'older-execution', reason: 'execution_error' });
    // No live event is required: the failure signal commits with the action record.
    expect((await f.service.get(schedule.schedule_id)).last_outcome?.status).toBe('finished');
    await first.tick(); expect(f.notify).toHaveBeenCalledOnce();
    expect(f.notify.mock.calls[0]![0].link_url).toBe(`https://owner.example.test/#chat/session/${schedule.session_id}/plan/older-action`);
    await first.stop(); const second = f.runtime(); await second.tick(); expect(f.notify).toHaveBeenCalledOnce();
    await f.run(schedule, 'later-success'); await second.tick();
    expect(f.db.prepare('SELECT episode_open FROM chat_prompt_schedule_notices WHERE schedule_id=?').get(schedule.schedule_id))
      .toEqual({ episode_open: 0 });
  });

  it.each(['latest', 'older'] as const)('does not report a recovered %s action as failed when its local receipt proves completion', async age => {
    const f = fixture(), schedule = await f.create(); f.behavior('success'); await f.run(schedule, 'first');
    const turn = (await f.service.get(schedule.schedule_id)).last_turn_id!;
    const review: ResourceReview = { schema_version: 1, operation: 'example.update', input_hash: 'a'.repeat(64), captured_at: NOW,
      resources: [{ kind: 'records', key: 'row', label: 'Row', binding: 'binding', version: 'v1',
        precondition: { kind: 'records_revision', value: 0, incarnation: 'original' }, before: { title: 'a' }, after: { title: 'b' } }] };
    await f.plans.put({ plan_id: 'confirmed-action', session_id: schedule.session_id, turn_id: turn, tool: 'work.update',
      tier: 1, classification: 'write', args: {}, args_hash: planApproval.computePlanArgsHash({}), status: 'proposed', created_at: NOW,
      resource_review: review });
    await f.plans.resolve('confirmed-action', 'approved', NOW + 1);
    await f.plans.consumeForDispatch!('confirmed-action', NOW + 2, 'execution');
    if (age === 'older') { f.clock(NOW + 300000); await f.service.tick(); await f.settled(schedule.session_id); }
    await f.plans.recordExecution!('confirmed-action', { status: 'running', turn_id: 'execution' });
    f.db.exec('CREATE TABLE confirmed_effect(value TEXT)');
    await f.plans.runLocalMutation!('confirmed-action', 'execution',
      { channel: 'chat', actor: 'user_self', chat_session_id: schedule.session_id, user_id: 'owner' }, () => {},
      () => f.db.transaction(() => {
        f.db.exec("INSERT INTO confirmed_effect VALUES('committed')"); recordLocalMutation(f.db, 'records', review);
      }).immediate());
    // A restart retains uncertain metadata, while the canonical receipt view proves the write.
    const reopened = createSqliteChatPlanStore(f.db);
    expect(f.db.prepare('SELECT execution_status FROM chat_plans WHERE plan_id=?').pluck().get('confirmed-action')).toBe('unknown');
    expect((await reopened.listForTurn(schedule.session_id, turn))[0]!.execution)
      .toMatchObject({ status: 'completed', recovered_from: 'unknown', local_receipt: { kind: 'records' } });
    expect((await f.service.get(schedule.schedule_id)).last_outcome?.status).toBe('finished');
    const notices = f.runtime(); await notices.tick(); await notices.tick();
    expect(f.notify).not.toHaveBeenCalled(); expect(f.history.size).toBe(0);
    expect(f.db.prepare('SELECT value FROM confirmed_effect').pluck().get()).toBe('committed');
    // Corrupt evidence cannot suppress a genuinely unknown outcome.
    f.db.exec("UPDATE local_mutation_receipts SET data='{}'");
    f.db.exec('UPDATE chat_plans SET execution_updated_at=execution_updated_at+1');
    await notices.tick(); expect(f.notify).toHaveBeenCalledOnce();
  });

  it('links a held tool that fails after a newer response to its retained message', async () => {
    const f = fixture(), schedule = await f.create(); f.behavior('success'); await f.run(schedule, 'first');
    const turn = (await f.service.get(schedule.schedule_id)).last_turn_id!;
    await f.store.toolCalls!.start({ id: 'held-tool', session_id: schedule.session_id, turn_id: turn,
      tool_name: 'recipe.run', role: 'tool', content: 'PRIVATE tool request', target_server: 'self',
      picker_at_send: { display_name: 'Self', signature: { server_kind: 'recued', version: 'fixture', instance_id: 'fixture' } },
      model_used: { provider: 'fixture', model_id: 'fixture' } });
    f.store.toolCalls!.hold('held-tool'); f.clock(NOW + 300000); await f.service.tick(); await f.settled(schedule.session_id);
    const notices = f.runtime(); await notices.tick(); expect(f.notify).not.toHaveBeenCalled();
    settleChatToolCall(f.db, schedule.session_id, { message_id: 'held-tool', state: 'failed' }, NOW + 300001);
    await notices.tick(); expect(f.notify).toHaveBeenCalledOnce();
    expect(f.notify.mock.calls[0]![0].link_url).toBe(`https://owner.example.test/#chat/session/${schedule.session_id}/answer/held-tool`);
    expect(JSON.stringify(f.notify.mock.calls)).not.toContain('PRIVATE');
  });

  it.each(['action', 'tool'] as const)('lets an in-flight %s record a failure after its schedule is removed', async kind => {
    const f = fixture(), schedule = await f.create(); f.behavior('success'); await f.run(schedule, 'first');
    const turn = (await f.service.get(schedule.schedule_id)).last_turn_id!;
    if (kind === 'action') {
      await f.plans.put({ plan_id: 'removed-action', session_id: schedule.session_id, turn_id: turn, tool: 'mail.send',
        tier: 1, classification: 'write', args: {}, args_hash: planApproval.computePlanArgsHash({}), status: 'proposed', created_at: NOW });
      await f.plans.resolve('removed-action', 'approved', NOW + 1);
      await f.plans.consumeForDispatch!('removed-action', NOW + 2, 'removed-execution');
    } else {
      await f.store.toolCalls!.start({ id: 'removed-tool', session_id: schedule.session_id, turn_id: turn,
        tool_name: 'recipe.run', role: 'tool', content: 'Waiting', target_server: 'self',
        picker_at_send: { display_name: 'Self', signature: { server_kind: 'recued', version: 'fixture', instance_id: 'fixture' } },
        model_used: { provider: 'fixture', model_id: 'fixture' } });
    }
    await f.service.control('remove', { schedule_id: schedule.schedule_id, expected_revision: schedule.revision });
    if (kind === 'action') await f.plans.recordExecution!('removed-action', { status: 'failed', turn_id: 'removed-execution', reason: 'execution_error' });
    else settleChatToolCall(f.db, schedule.session_id, { message_id: 'removed-tool', state: 'failed' }, NOW + 3);
    await f.runtime().tick(); expect(f.notify).not.toHaveBeenCalled();
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM chat_prompt_failure_signals').get()).toEqual({ n: 0 });
  });

  it('does not push a notice after its schedule is removed while history is being persisted', async () => {
    const f = fixture(), schedule = await f.create(); await f.run(schedule, 'failure');
    const entered = latch(), release = latch(); cleanup.push(release.release);
    f.log.mockImplementation(async activity => { f.history.set(activity.activity_id, activity); entered.release(); await release.promise; });
    const notices = f.runtime(), tick = notices.tick(); await entered.promise;
    await f.service.control('remove', { schedule_id: schedule.schedule_id, expected_revision: schedule.revision });
    release.release(); await tick;
    expect(f.notify).not.toHaveBeenCalled();
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM chat_prompt_schedule_notices').get()).toEqual({ n: 0 });
  });

  it('rechecks quiet hours and a successful recovery after an asynchronous history write', async () => {
    const f = fixture(), schedule = await f.create(); await f.run(schedule, 'failure');
    const entered = latch(), release = latch(); cleanup.push(release.release);
    f.log.mockImplementation(async activity => { f.history.set(activity.activity_id, activity); entered.release(); await release.promise; });
    const notices = f.runtime(), tick = notices.tick(); await entered.promise;
    f.quiet.write({ enabled: true, from_minute: 0, to_minute: 23 * 60 }, NOW);
    release.release(); await tick; expect(f.notify).not.toHaveBeenCalled();
    f.behavior('success'); await f.run(schedule, 'fixed'); f.quiet.write({ enabled: false }, NOW);
    await notices.tick(); expect(f.notify).not.toHaveBeenCalled();
  });

  it('claims a push only once when two workers evaluate the same failure', async () => {
    const f = fixture(), schedule = await f.create(); await f.run(schedule, 'failure');
    await Promise.all([f.runtime().tick(), f.runtime().tick()]);
    expect(f.notify).toHaveBeenCalledOnce(); expect(f.history.size).toBe(1);
  });

  it('retains history without replaying a claimed push after delivery throws', async () => {
    const f = fixture(), schedule = await f.create(); await f.run(schedule, 'failure');
    f.notify.mockRejectedValue(new Error('channel unavailable'));
    const first = f.runtime(); await first.tick(); await first.stop();
    await f.runtime().tick(); expect(f.notify).toHaveBeenCalledOnce(); expect(f.history.size).toBe(1);
  });

  it('does not hold up clock admission while a notification channel is slow', async () => {
    const f = fixture(), failed = await f.create(); await f.run(failed, 'failure');
    const entered = latch(), release = latch(); cleanup.push(release.release);
    f.notify.mockImplementation(async () => { entered.release(); await release.promise; });
    const tick = f.runtime().tick(); await entered.promise;
    const healthy = await f.create('healthy'); f.behavior('success'); f.clock(NOW + 300000);
    await f.service.tick(); await f.settled(healthy.session_id);
    expect((await f.service.get(healthy.schedule_id)).last_status).toBe('completed');
    release.release(); await tick;
  });

  it('stops before claiming a notice and leaves it recoverable for the next worker', async () => {
    const f = fixture(), schedule = await f.create(); await f.run(schedule, 'failure');
    const entered = latch(), release = latch(); cleanup.push(release.release);
    f.log.mockImplementation(async activity => { f.history.set(activity.activity_id, activity); entered.release(); await release.promise; });
    const first = f.runtime(), tick = first.tick(); await entered.promise;
    const stop = first.stop(); release.release(); await Promise.all([stop, tick]);
    expect(f.notify).not.toHaveBeenCalled();
    await f.runtime().tick(); expect(f.notify).toHaveBeenCalledOnce();
  });
});
