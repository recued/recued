/** D-344 slice D — a scheduled prompt picks its model, as the chat's picker offers it, and its runs
 *  use it. The owner: "for schedule-prompt we never allow user to pick the slot as it should". Through
 *  the real schedules, queue and orchestrator, as `prompt-schedules.test.ts` drives them. */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatModelSourceId, InternalToolRegistry } from '@recued/contracts';

import { createChatOrchestrator, type ChatTurnInput } from '../chat-orchestrator.js';
import { withQueuedChatTurns } from '../chat-turn-queue.js';
import { createPromptSchedules } from '../prompt-schedules.js';
import { createSqliteChatPlanStore } from '../storage/chat-plan-store.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';

const NOW = Date.parse('2026-11-06T12:00:00Z');
const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
const recurring = { title: 'Weekly review', prompt: 'Review what I finished this week.', mode: 'recurring' as const,
  time_zone: 'UTC', cron_expression: '0 9 * * 1' };

const fixture = () => {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON'); ensureChatSchema(db);
  const store = createChatStore(db);
  const plans = createSqliteChatPlanStore(db);
  const registry: InternalToolRegistry = { list: () => [], listByTier: () => [], getByName: () => null,
    dispatch: async () => ({ ok: true, result: {} }), subscribeRefresh: () => () => {} };
  const raw = createChatOrchestrator({ chatStore: store, registry,
    selfSignature: { server_kind: 'recued', version: 'test', instance_id: 'schedule-model' } });
  const inputs: ChatTurnInput[] = [];
  const run = async (input: ChatTurnInput) => { inputs.push(input); return raw.runTurn(input); };
  const orchestrator = withQueuedChatTurns({ ...raw, runTurn: run }, { db, store, pollMs: 10 });
  const queue = orchestrator.turnQueue!;
  // The live configuration's answer for a source, as the composition root reads it.
  const modelPrefFor = vi.fn((source_id: ChatModelSourceId) => source_id === 'free_pool'
    ? { current: 'free_pool' as const, source_id }
    : { current: 'byok' as const, model_hint: source_id === 'slot_2' ? 'quality' as const : 'fast' as const, source_id });
  const service = createPromptSchedules({ db, store, instanceId: 'schedule-model', queue, runTurn: run, now: () => NOW,
    readPlans: (session, turn) => plans.listForTurn(session, turn), modelPrefFor });
  orchestrator.promptSchedules = service;
  cleanup.push(() => db.close(), () => queue.close());
  const settled = (session: string) => vi.waitFor(async () => {
    const turns = (await queue.snapshot(session)).turns;
    expect(turns.length).toBeGreaterThan(0);
    expect(turns.some(t => ['queued', 'running', 'cancelling'].includes(t.status))).toBe(false);
  });
  return { service, inputs, settled, modelPrefFor };
};

describe('D-344 slice D — a scheduled prompt\'s model', () => {
  it('is saved with the schedule, named on every read, changed and cleared by an edit', async () => {
    const f = fixture();
    const plain = (await f.service.create(recurring, 'plain'))!;
    expect(plain.model_source_id).toBeNull();
    const chosen = (await f.service.create({ ...recurring, model_source_id: 'slot_2' }, 'chosen'))!;
    expect(chosen.model_source_id).toBe('slot_2');
    expect((await f.service.get(chosen.schedule_id)).model_source_id).toBe('slot_2');
    const freed = (await f.service.update({ schedule_id: chosen.schedule_id, expected_revision: chosen.revision,
      model_source_id: 'free_pool' }))!;
    expect(freed.model_source_id).toBe('free_pool');
    // An edit that leaves it alone keeps it.
    const retitled = (await f.service.update({ schedule_id: chosen.schedule_id, expected_revision: freed.revision, title: 'Review' }))!;
    expect(retitled.model_source_id).toBe('free_pool');
    const cleared = (await f.service.update({ schedule_id: chosen.schedule_id, expected_revision: retitled.revision,
      model_source_id: null }))!;
    expect(cleared.model_source_id).toBeNull();
  });

  it('refuses a model that is not a slot, the free pool or the chat\'s default, and the preview says it takes one', async () => {
    const f = fixture();
    await expect(f.service.create({ ...recurring, model_source_id: 'slot_9' }, 'bad')).rejects.toThrow(/Model must be/);
    const { title: _title, prompt: _prompt, ...timing } = recurring;
    expect(f.service.preview(timing)).toMatchObject({ model_choice_available: true });
  });

  it('a run takes the schedule\'s model as the turn\'s, read when it starts; one with none takes the chat\'s default', async () => {
    const f = fixture();
    const chosen = (await f.service.create({ ...recurring, model_source_id: 'slot_2' }, 'run-chosen'))!;
    await f.service.runNow({ schedule_id: chosen.schedule_id, expected_revision: chosen.revision, submission_id: 'first' });
    await f.settled(chosen.session_id);
    expect(f.modelPrefFor).toHaveBeenCalledWith('slot_2');
    expect(f.inputs.at(-1)!.model_pref).toEqual({ current: 'byok', model_hint: 'quality', source_id: 'slot_2' });
    const plain = (await f.service.create(recurring, 'run-plain'))!;
    await f.service.runNow({ schedule_id: plain.schedule_id, expected_revision: plain.revision, submission_id: 'second' });
    await f.settled(plain.session_id);
    expect(f.inputs.at(-1)!.model_pref).toBeUndefined();
  });
});
