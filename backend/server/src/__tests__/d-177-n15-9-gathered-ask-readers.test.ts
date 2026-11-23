/** D-177 §N.15.9 — a round's gathered approval is read where a held call's own approval is: the
 *  holds it answers (`preflightAskHolds`), and a reviewed execution that stopped closes the holds
 *  it lists, and the approval once every one of them stopped. */

import { describe, expect, it, vi } from 'vitest';
import { isPreflightApprovalKind, preflightAskHolds } from '@recued/gateway';

import { createHeldPlanAskAnswerer } from '../chat-held-writes.js';
import { createAskChatPlanFinder } from '../history-handler.js';
import { closeStoppedHoldAsks } from '../preapproval-notifications.js';

const own = (n: number) => ({
  ask_id: `ask-own-${String(n)}`, handler_kind: 'gateway.preflight',
  handler_payload: { checkpoint_id: `cp-${String(n)}`, run_id: `run-${String(n)}`, recipe_id: 'r' },
});
const gathered = (...ns: number[]) => ({
  ask_id: 'ask-gathered', handler_kind: 'gateway.preflight.gathered',
  handler_payload: {
    members: ns.map((n) => own(n).handler_payload),
    checkpoint_ids: ns.map((n) => `cp-${String(n)}`),
  },
});

describe('the holds an approval answers', () => {
  it('a call\'s own: its one; a gathered one: each member\'s; any other ask: none', () => {
    expect(preflightAskHolds(own(1))).toEqual([{ checkpoint_id: 'cp-1', run_id: 'run-1' }]);
    expect(preflightAskHolds(gathered(1, 2))).toEqual([
      { checkpoint_id: 'cp-1', run_id: 'run-1' }, { checkpoint_id: 'cp-2', run_id: 'run-2' },
    ]);
    expect(preflightAskHolds({ handler_kind: 'gateway.in_doubt', handler_payload: { checkpoint_id: 'cp-1' } })).toEqual([]);
    // A member it cannot read names no hold.
    expect(preflightAskHolds({ handler_kind: 'gateway.preflight.gathered', handler_payload: { members: [null, 'x', {}] } }))
      .toEqual([]);
    expect(isPreflightApprovalKind('gateway.preflight.gathered')).toBe(true);
    expect(isPreflightApprovalKind('gateway.preflight')).toBe(true);
    expect(isPreflightApprovalKind('gateway.in_doubt')).toBe(false);
  });
});

describe('a reviewed execution that stopped closes the approvals of its holds', () => {
  const run = async (asks: ReadonlyArray<ReturnType<typeof own> | ReturnType<typeof gathered>>, stoppedRuns: readonly string[]) => {
    const cancelAsk = vi.fn(async (_ask_id: string) => 'cancelled' as const);
    const finish = vi.fn(async (_action_ref: string, _input: unknown) => null);
    await closeStoppedHoldAsks({
      block: { listOpenAsks: async () => asks as never, cancelAsk },
      checkpointWasStopped: (_checkpoint_id, run_id) => stoppedRuns.includes(run_id),
      gatedActions: {
        getByCheckpoint: async (checkpoint_id: string) =>
          ({ action_ref: `action-${checkpoint_id}`, run_id: checkpoint_id.replace('cp-', 'run-') }) as never,
        finish,
      },
    });
    return {
      cancelled: cancelAsk.mock.calls.map(([ask_id]) => ask_id),
      finished: finish.mock.calls.map(([action_ref]) => action_ref),
    };
  };

  it('a call\'s own approval closes with its stopped hold, as before', async () => {
    expect(await run([own(1), own(2)], ['run-1'])).toEqual({ cancelled: ['ask-own-1'], finished: ['action-cp-1'] });
  });

  it('a gathered one with one stopped hold stays open for the rest; that hold\'s receipt is closed', async () => {
    expect(await run([gathered(1, 2, 3)], ['run-2'])).toEqual({ cancelled: [], finished: ['action-cp-2'] });
  });

  it('…and closes once every hold it lists stopped', async () => {
    expect(await run([gathered(1, 2)], ['run-1', 'run-2']))
      .toEqual({ cancelled: ['ask-gathered'], finished: ['action-cp-1', 'action-cp-2'] });
  });
});

describe('D-177 §N.15.9 (1c-b) — a card of the chat\'s own writes answers its round\'s one approval', () => {
  const OPTIONS = [{ id: 'approve' }, { id: 'allow_kind' }, { id: 'deny' }];
  const blockWith = (ask: Record<string, unknown>) => {
    const submitAnswer = vi.fn(async () => 'answered' as const);
    return { submitAnswer, block: { listUnresolvedAsks: async () => [{ status: 'open', options: OPTIONS, ...ask }], submitAnswer } };
  };

  it('found by any member\'s run, it tells every run it answered; another card of the group finds it answered', async () => {
    const { block, submitAnswer } = blockWith(gathered(1, 2, 3));
    const answer = createHeldPlanAskAnswerer(block as never);
    const together: string[] = [];
    expect(await answer('run-2', 'approve', undefined, { together: (runs) => { together.push(...runs); } })).toBe('answered');
    expect(submitAnswer).toHaveBeenCalledWith({ ask_id: 'ask-gathered', option: 'approve', via: 'ui' });
    expect(together).toEqual(['run-1', 'run-2', 'run-3']);
    expect(await answer('run-3', 'approve')).toBe('closed');
    expect(submitAnswer).toHaveBeenCalledTimes(1);
  });

  it('a change to one of them is refused, and nothing is answered', async () => {
    const { block, submitAnswer } = blockWith(gathered(1, 2));
    const before = vi.fn(async () => undefined);
    expect(await createHeldPlanAskAnswerer(block as never)('run-1', 'approve', before, { edited: true })).toBe('ignored');
    expect(before).not.toHaveBeenCalled();
    expect(submitAnswer).not.toHaveBeenCalled();
  });

  it('a call\'s own ask is answered as before, with its change, and tells no one else', async () => {
    const { block, submitAnswer } = blockWith(own(1));
    const together = vi.fn();
    expect(await createHeldPlanAskAnswerer(block as never)('run-1', 'approve', undefined, { edited: true, together })).toBe('answered');
    expect(submitAnswer).toHaveBeenCalledTimes(1);
    expect(together).not.toHaveBeenCalled();
  });
});

describe('D-177 §N.15.9 (1c-b) — the Approvals page names the group\'s card of a round\'s one approval', () => {
  /** A held save waiting for its answer: its card can change it, on its own. */
  const save = (run_id: string) => ({
    plan_id: `plan-${run_id}`, session_id: 'chat-a', status: 'proposed', hold: { run_id },
    editable_args: ['claim'], args: { claim: { subject: 'Mia' } },
  });
  const find = createAskChatPlanFinder({ findByHoldRun: async (run_id: string) => save(run_id) } as never);

  it('by its first hold, and never as one a change can be made to', async () => {
    expect(await find({ ...gathered(1, 2), status: 'open' } as never)).toEqual({ session_id: 'chat-a', plan_id: 'plan-run-1' });
    // The control: a held save asked on its own is changeable on its card.
    expect(await find({ ...own(1), status: 'open' } as never))
      .toEqual({ session_id: 'chat-a', plan_id: 'plan-run-1', changeable: true });
  });
});
