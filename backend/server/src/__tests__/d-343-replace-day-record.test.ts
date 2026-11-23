/** D-343 (the owner, 2026-11-14: "there should be a way for model to ... chat more about it tuning
 *  the content before settling") — a day's record held while an earlier one of the same day waits
 *  in that conversation replaces it. The earlier ask closes everywhere with "Replaced by a newer
 *  version.", its receipt is cancelled (an approval that still arrives runs nothing), its plan is
 *  cancelled with `hold.replaced_at`, and nothing more is said of it: no continuation, no reply. */
import { describe, expect, it, vi } from 'vitest';
import type { ChatPlanProposal } from '@recued/contracts';
import { planApproval, PREFLIGHT_GATHERED_HANDLER_KIND, PREFLIGHT_HANDLER_KIND } from '@recued/gateway';
import { createDayRecordReplacer, createHeldChatWrites, createHeldWriteWithdrawal, HELD_WRITE_REPLACED_NOTE } from '../chat-held-writes.js';

const plan = (id: string, session: string, day: string, extra: Partial<ChatPlanProposal> = {}): ChatPlanProposal => ({
  plan_id: id, session_id: session, turn_id: `t-${id}`, tool: 'episode.record', tier: 1, classification: 'write',
  args: { day, records: [{ title: 'Spanish lesson', outcome: 'done' }] }, args_hash: `h-${id}`, status: 'proposed', created_at: 1,
  hold: { run_id: `run-${id}` }, ...extra,
} as ChatPlanProposal);

const world = (asks: Array<{ ask_id: string; run_ids: string[]; status?: string }>) => {
  const plans = planApproval.createPlanApprovalStore();
  const open = new Map(asks.map((ask) => [ask.ask_id, ask]));
  const block = {
    listUnresolvedAsks: vi.fn(async () => [...open.values()].map((ask) => ({ ask_id: ask.ask_id, status: ask.status ?? 'open',
      handler_kind: ask.run_ids.length > 1 ? PREFLIGHT_GATHERED_HANDLER_KIND : PREFLIGHT_HANDLER_KIND,
      handler_payload: ask.run_ids.length > 1 ? { members: ask.run_ids.map((run_id) => ({ run_id })) } : { run_id: ask.run_ids[0] } })) as never),
    cancelAsk: vi.fn(async (ask_id: string, _options?: { note?: string }) => {
      const ask = open.get(ask_id);
      if (ask === undefined || (ask.status ?? 'open') !== 'open') return 'not_open' as const;
      open.delete(ask_id); return 'cancelled' as const;
    }),
  };
  const receipts = new Map<string, string>(); const checkpoints = new Map<string, string>();
  const gatedActionStore = {
    getBySubject: vi.fn(async (run_id: string) => (receipts.has(run_id) ? { action_ref: `a-${run_id}`, status: receipts.get(run_id) } : null) as never),
    finish: vi.fn(async (ref: string, input: { status: string }) => { receipts.set(ref.slice(2), input.status); return null; }),
  };
  const checkpointStore = {
    listByRun: vi.fn(async (run_id: string) => (checkpoints.has(run_id) ? [{ checkpoint_id: checkpoints.get(run_id)! }] : []) as never),
    delete: vi.fn(async (id: string) => { for (const [run, cp] of checkpoints) if (cp === id) checkpoints.delete(run); }),
  };
  const emitted: unknown[] = [];
  const withdraw = createHeldWriteWithdrawal({ block, checkpointStore, gatedActionStore, plans, emit: (event) => { emitted.push(event); }, now: () => 99 });
  const hold = (p: ChatPlanProposal) => { plans.put(p); receipts.set(p.hold!.run_id, 'awaiting_approval'); checkpoints.set(p.hold!.run_id, `cp-${p.plan_id}`); };
  return { plans, block, receipts, checkpoints, emitted, withdraw, hold, replace: createDayRecordReplacer({ plans, withdraw }) };
};

describe('D-343 — a newer record of the same day replaces the one waiting for the owner', () => {
  it('withdraws the earlier one quietly, and leaves another day and another conversation alone', async () => {
    const w = world([{ ask_id: 'ask-1', run_ids: ['run-1'] }, { ask_id: 'ask-other-day', run_ids: ['run-2'] },
      { ask_id: 'ask-other-chat', run_ids: ['run-3'] }, { ask_id: 'ask-new', run_ids: ['run-4'] }]);
    w.hold(plan('1', 's1', '2026-11-14')); w.hold(plan('2', 's1', '2026-11-13')); w.hold(plan('3', 's2', '2026-11-14'));
    const newer = plan('4', 's1', '2026-11-14', { args: { day: '2026-11-14', records: [{ title: 'Spanish lesson', outcome: 'done' },
      { title: 'Went for a walk', outcome: 'done' }] } }); w.hold(newer);
    await w.replace({ tool: 'episode.record', args: newer.args as Record<string, unknown>, run_id: 'run-4' });
    // The earlier one: its ask closed with the note, its receipt cancelled, its plan replaced, its checkpoint gone.
    expect(w.block.cancelAsk).toHaveBeenCalledTimes(1);
    expect(w.block.cancelAsk).toHaveBeenCalledWith('ask-1', { note: HELD_WRITE_REPLACED_NOTE });
    expect(w.receipts.get('run-1')).toBe('cancelled');
    expect(w.plans.get('1')).toMatchObject({ status: 'cancelled', resolved_at: 99, hold: { run_id: 'run-1', replaced_at: 99 } });
    expect(w.checkpoints.has('run-1')).toBe(false);
    expect(w.emitted).toEqual([expect.objectContaining({ kind: 'chat.plan_resolved', session_id: 's1' })]);
    // The newer one, another day and another conversation wait as they were.
    for (const id of ['2', '3', '4']) expect(w.plans.get(id)?.status).toBe('proposed');
    for (const run of ['run-2', 'run-3', 'run-4']) expect(w.receipts.get(run)).toBe('awaiting_approval');
  });

  it('stands down when the owner answered first, or when the ask is a round\'s one approval of several', async () => {
    const answered = world([{ ask_id: 'ask-1', run_ids: ['run-1'], status: 'answered' }]);
    answered.hold(plan('1', 's1', '2026-11-14'));
    expect(await answered.withdraw(answered.plans.get('1')!)).toBe('raced');
    expect(answered.plans.get('1')?.status).toBe('proposed');
    expect(answered.receipts.get('run-1')).toBe('awaiting_approval');
    const gathered = world([{ ask_id: 'ask-round', run_ids: ['run-1', 'run-x'] }]);
    gathered.hold(plan('1', 's1', '2026-11-14'));
    expect(await gathered.withdraw(gathered.plans.get('1')!)).toBe('raced');
    expect(gathered.block.cancelAsk).not.toHaveBeenCalled();
  });

  it('says nothing of a replaced record when a stale answer settles it', async () => {
    const plans = planApproval.createPlanApprovalStore();
    plans.put(plan('1', 's1', '2026-11-14', { status: 'cancelled', hold: { run_id: 'run-1', replaced_at: 5 } }));
    const continueConversation = vi.fn(async () => true); const appendMessage = vi.fn(async () => ({}));
    const broadcast = { emit: vi.fn() };
    const writes = createHeldChatWrites({ plans, continueConversation, chatStore: { appendMessage }, broadcast,
      signature: { server_kind: 'recued', version: 't', instance_id: 't' } } as never);
    expect(await writes.settle({ run_id: 'run-1', result: { success: false, denied: true } } as never)).toBe(true);
    expect(continueConversation).not.toHaveBeenCalled();
    expect(appendMessage).not.toHaveBeenCalled();
    expect(broadcast.emit).not.toHaveBeenCalled();
    expect(plans.get('1')?.status).toBe('cancelled');
  });
});
