/** D-338 slice 2 — "Notify me when it's done", and slice 3's managed schedule, through the real
 *  scheduled-prompt service, turn queue and clock. The turn is stubbed to write its answer; no model
 *  runs. */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shouldSuppressForQuietHours, type InternalToolRegistry } from '@recued/contracts';
import type { NotificationBlock } from '@recued/notification';
import type { AuditLogStore } from '@recued/storage';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createChatOrchestrator } from '../chat-orchestrator.js';
import { createSqliteChatPlanStore } from '../storage/chat-plan-store.js';
import { createQuietHoursStore } from '../storage/quiet-hours-store.js';
import { withQueuedChatTurns } from '../chat-turn-queue.js';
import { createPromptSchedules } from '../prompt-schedules.js';
import { createPromptScheduleDoneRuntime, DONE_TEXT_MAX_CHARS, type PromptScheduleDoneGate } from '../prompt-schedule-done.js';

const NOW = Date.parse('2026-11-04T12:00:00Z');
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const signature = { server_kind: 'recued' as const, version: 'fixture', instance_id: 'done-fixture' };

const fixture = () => {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON'); ensureChatSchema(db);
  const store = createChatStore(db), plans = createSqliteChatPlanStore(db), quiet = createQuietHoursStore(db);
  let at = NOW, answer = 'Leave at 08:10 for the dentist: the A4 is closed.', fail = false, open = true;
  const runTurn = async (input: { queue_turn_id?: string; session_id: string }): Promise<{ turn_id: string }> => {
    if (fail) throw new Error('provider failure');
    await store.appendMessage({ id: `answer:${input.queue_turn_id}`, session_id: input.session_id, role: 'assistant',
      content: answer, turn_id: input.queue_turn_id!, target_server: 'self', ts: at,
      picker_at_send: { display_name: 'Self', signature }, model_used: { provider: 'fixture', model_id: 'fixture' } });
    return { turn_id: input.queue_turn_id! };
  };
  const registry: InternalToolRegistry = { list: () => [], listByTier: () => [], getByName: () => null,
    dispatch: async () => ({ ok: true, result: {} }), subscribeRefresh: () => () => {} };
  const base = createChatOrchestrator({ chatStore: store, registry, selfSignature: signature });
  const queue = withQueuedChatTurns({ ...base, runTurn }, { db, store, pollMs: 10 }).turnQueue!;
  const service = createPromptSchedules({ db, store, instanceId: 'done-fixture', now: () => at, runTurn, queue,
    readPlans: (session, turn) => plans.listForTurn(session, turn) });
  cleanup.push(() => { queue.close(); db.close(); });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const log = vi.fn<AuditLogStore['logActivity']>(async () => {});
  const notify = vi.fn<NotificationBlock['notify']>(async () => {});
  const runtime = (gate?: PromptScheduleDoneGate) => {
    const value = createPromptScheduleDoneRuntime({ db, schedules: service, auditLog: { logActivity: log }, notifier: { notify },
      readAnswer: async (session_id, message_id) => (await store.listMessagePage(session_id, 1, undefined, { around_message_id: message_id }))
        .messages.find(message => message.id === message_id),
      now: () => at, canRun: () => open, getPublicBaseUrl: () => 'https://owner.example.test/',
      isQuiet: time => shouldSuppressForQuietHours({ policy: quiet.read(), instant: time, timeZone: 'UTC' }),
      ...(gate ? { gate } : {}) });
    cleanup.push(() => value.stop()); return value;
  };
  const create = async (id: string, notify_on_done?: boolean) => (await service.create({ title: 'Agenda suggestions',
    prompt: 'Suggest what would help today.', mode: 'recurring', time_zone: 'UTC', cron_expression: '*/5 * * * *',
    ...(notify_on_done !== undefined ? { notify_on_done } : {}) }, id))!;
  const settled = (session: string) => vi.waitFor(async () => {
    const rows = (await queue.snapshot(session)).turns;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some(row => ['queued', 'running', 'cancelling'].includes(row.status))).toBe(false);
  });
  /** The clock admits the run due at `time`, and the queue finishes it. */
  const clockRun = async (session: string, time: number) => { at = time; await service.tick(); await settled(session); };
  return { db, store, quiet, service, runtime, notify, log, create, clockRun, settled,
    answer: (value: string) => { answer = value; }, fail: (value: boolean) => { fail = value; }, open: (value: boolean) => { open = value; },
    clock: (time: number) => { at = time; } };
};

describe('D-338 a scheduled prompt that notifies when it is done', () => {
  it('sends a finished run\'s answer once, titled as the schedule and linked to the answer', async () => {
    const f = fixture(); const schedule = await f.create('notify', true);
    expect(schedule.notify_on_done).toBe(true);
    await f.clockRun(schedule.session_id, NOW + 300_000);
    const turn = (await f.service.get(schedule.schedule_id)).last_turn_id!;
    const done = f.runtime(); await done.tick(); await done.tick();
    const hash = `#chat/session/${encodeURIComponent(schedule.session_id)}/answer/${encodeURIComponent(`answer:${turn}`)}`;
    expect(f.notify).toHaveBeenCalledOnce();
    expect(f.notify).toHaveBeenCalledWith({ title: 'Agenda suggestions', text: 'Leave at 08:10 for the dentist: the A4 is closed.',
      link_url: `https://owner.example.test/${hash}` }, undefined, { persisted_activity_id: `prompt-done:${schedule.schedule_id}:${turn}`, ui_link_url: hash });
    // The audit trail says it went and where it links; the answer stays in the conversation.
    expect(JSON.stringify(f.log.mock.calls)).not.toContain('dentist');
    // The next run is noticed too.
    await f.clockRun(schedule.session_id, NOW + 600_000); await done.tick();
    expect(f.notify).toHaveBeenCalledTimes(2);
  });

  it('waits out quiet hours, and never sends a run due before notifying was turned on', async () => {
    const f = fixture(); const schedule = await f.create('later');
    expect(schedule.notify_on_done).toBe(false);
    await f.clockRun(schedule.session_id, NOW + 300_000);
    const on = await f.service.update({ schedule_id: schedule.schedule_id, expected_revision: schedule.revision, notify_on_done: true });
    expect(on?.notify_on_done).toBe(true);
    const done = f.runtime(); await done.tick();
    expect(f.notify).not.toHaveBeenCalled();
    f.quiet.write({ enabled: true, from_minute: 11 * 60, to_minute: 13 * 60 }, NOW);
    await f.clockRun(schedule.session_id, NOW + 600_000); await done.tick();
    expect(f.notify).not.toHaveBeenCalled();
    f.quiet.write({ enabled: false }, NOW); await done.tick();
    expect(f.notify).toHaveBeenCalledOnce();
  });

  it('leaves out a Run now, a failed run, a sealed vault, and a schedule that does not notify', async () => {
    const f = fixture(); const notifying = await f.create('notifying', true); const silent = await f.create('silent', false);
    // A minute after notifying was turned on, so only its being a Run now leaves it out.
    f.clock(NOW + 60_000);
    await f.service.runNow({ schedule_id: notifying.schedule_id, expected_revision: notifying.revision, submission_id: 'by-hand' });
    await f.settled(notifying.session_id);
    const done = f.runtime(); await done.tick();
    expect(f.notify).not.toHaveBeenCalled();
    f.fail(true); await f.clockRun(notifying.session_id, NOW + 300_000); await done.tick();
    expect(f.notify).not.toHaveBeenCalled();
    f.fail(false); await f.clockRun(silent.session_id, NOW + 600_000); await f.settled(notifying.session_id);
    f.open(false); await done.tick();
    expect(f.notify).not.toHaveBeenCalled();
    f.open(true); await done.tick();
    // Only the schedule that notifies, for its latest run.
    expect(f.notify.mock.calls.map(([message]) => message.title)).toEqual(['Agenda suggestions']);
    expect(f.notify).toHaveBeenCalledOnce();
    expect((await f.service.get(silent.schedule_id)).last_outcome?.status).toBe('finished');
  });

  it('cuts a long answer and says where the rest is', async () => {
    const f = fixture(); const schedule = await f.create('long', true);
    f.answer(`${'x'.repeat(DONE_TEXT_MAX_CHARS)}END`);
    await f.clockRun(schedule.session_id, NOW + 300_000);
    const done = f.runtime(); await done.tick();
    const text = f.notify.mock.calls[0]![0].text;
    expect(text.startsWith('x'.repeat(DONE_TEXT_MAX_CHARS))).toBe(true);
    expect(text).not.toContain('END');
    expect(text.endsWith('…\n\nOpen the conversation for the rest.')).toBe(true);
  });

  it('lets the schedule\'s owner hold a run\'s notice, or drop it for good', async () => {
    const f = fixture(); const schedule = await f.create('gated', true);
    await f.clockRun(schedule.session_id, NOW + 300_000);
    let verdict: ReturnType<PromptScheduleDoneGate> = 'wait';
    const done = f.runtime(() => verdict); await done.tick();
    expect(f.notify).not.toHaveBeenCalled();
    verdict = 'skip'; await done.tick();
    verdict = 'notify'; await done.tick();
    expect(f.notify).not.toHaveBeenCalled();
    await f.clockRun(schedule.session_id, NOW + 600_000); await done.tick();
    expect(f.notify).toHaveBeenCalledOnce();
  });
});

describe('D-338 a schedule the Agenda owns', () => {
  const managed = async (f: ReturnType<typeof fixture>) => (await f.service.create({ title: 'Agenda suggestions',
    prompt: 'Suggest.', mode: 'recurring', time_zone: 'UTC', cron_expression: '0 7 * * *', notify_on_done: true },
    'managed', false, { managed_by: 'agenda' }))!;

  it('is left out of every list but its owner\'s', async () => {
    const f = fixture(); const owned = await managed(f); const mine = await f.create('mine');
    expect(owned.managed_by).toBe('agenda');
    expect((await f.service.list()).map(s => s.schedule_id)).toEqual([mine.schedule_id]);
    expect(await f.service.list(owned.session_id)).toEqual([]);
    expect((await f.service.list(undefined, { managed: true })).map(s => s.schedule_id).sort())
      .toEqual([owned.schedule_id, mine.schedule_id].sort());
  });

  it('refuses changes from the screens and tools, and takes them from its owner', async () => {
    const f = fixture(); const owned = await managed(f);
    await expect(f.service.update({ schedule_id: owned.schedule_id, expected_revision: owned.revision, prompt: 'Something else.' }))
      .rejects.toThrow('belongs to the Agenda');
    await expect(f.service.control('pause', { schedule_id: owned.schedule_id, expected_revision: owned.revision }))
      .rejects.toThrow('belongs to the Agenda');
    const paused = await f.service.control('pause', { schedule_id: owned.schedule_id, expected_revision: owned.revision }, false, { managed: true });
    expect(paused?.enabled).toBe(false);
  });

  it('goes with its conversation when the owner deletes that', async () => {
    const f = fixture(); const owned = await managed(f);
    await f.service.beforeDeleteSession(owned.session_id);
    await expect(f.service.get(owned.schedule_id)).rejects.toThrow('no longer exists');
  });

  it('tells a client that a run can notify, from the timing preview', () => {
    const f = fixture();
    expect(f.service.preview({ mode: 'recurring', time_zone: 'UTC', cron_expression: '0 7 * * *' }))
      .toMatchObject({ notify_on_done_available: true });
  });
});
