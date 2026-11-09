/** D-341 slice B2 — a held write a trigger's run made offers "Always allow for this webhook /
 *  schedule / trigger" on its ask, in place of "Allow this session", and says what it lets happen.
 *  Answered, it approves with the pre-approval the hold offered; the server grants it before the run
 *  goes on (`preflight-resumer.ts`, the server's `d-341-trigger-preapproval.test.ts`). */

import { describe, expect, it, vi } from 'vitest';
import type { Checkpoint, TriggerPreapprovalOffer } from '@recued/contracts';
import type { Answer } from '@recued/notification';
import type { CheckpointStore } from '@recued/storage';

import {
  buildPreflightAsk,
  createPreflightAnswerHandler,
  type PreflightAskContext,
  type PreflightResumer,
} from '../preflight-reconciliation.js';

const OP = 'recued-core.body-signals.daily_metric.batch';
const OFFER: TriggerPreapprovalOffer = {
  trigger: { kind: 'webhook', ingress_id: 'whi_1' }, door_contract_id: 'door-1',
  recipe_id: 'receive-body-metrics-apple-health', recipe_sha256: 'a'.repeat(64), op: OP,
};

const checkpoint = (preflight_context: Record<string, unknown> = { trigger_preapproval: OFFER }): Checkpoint => ({
  checkpoint_id: 'cp-1', run_id: 'run-1', recipe_id: 'receive-body-metrics-apple-health', gated_step_id: 'save',
  step_state: {}, created_at: 1,
  preflight_context: { tool_slug: OP, risk_tier: 'write', recipe_title: 'Receive Apple Health readings', ...preflight_context },
} as Checkpoint);

const context = (overrides: Partial<PreflightAskContext> = {}): PreflightAskContext => ({
  recipe_id: 'receive-body-metrics-apple-health', gated_step_id: 'save', tool_slug: OP, risk_tier: 'write',
  // The exact grant the hold offered too: replaced by the trigger's, which covers the next post.
  session_grant: { ttl_ms: 3_600_000, max_uses: 5, risk_tier: 'write' },
  ...overrides,
});

describe('D-341 slice B2 — the ask offers the trigger\'s pre-approval', () => {
  it('offers "Always allow for this webhook" between approve and deny, and says what it lets happen', () => {
    const built = buildPreflightAsk({ checkpoint: checkpoint(), context: context() });
    expect(built.options).toEqual([
      { id: 'approve', label: 'Approve' },
      { id: 'allow_trigger', label: 'Always allow for this webhook' },
      { id: 'deny', label: 'Deny' },
    ]);
    expect(built.message.text).toContain('\n\n“Always allow for this webhook” stops asking about this write when its'
      + ' webhook runs "Receive Apple Health readings", once a run, until you end it on the webhook\'s page or under'
      + ' Contracts. A change to the recipe asks you again.\n\nApprove?');
    expect(built.message.text).not.toContain("'Allow this session'");
    expect(built.handler.payload.session_grant).toBeUndefined();
  });

  it('a recipe that asks an AI is offered it too, and the ask says its AI decides what it writes (ruling 8)', () => {
    const built = buildPreflightAsk({ checkpoint: checkpoint({ trigger_preapproval: { ...OFFER, asks_ai: true } }), context: context() });
    expect(built.options.map((option) => option.id)).toEqual(['approve', 'allow_trigger', 'deny']);
    expect(built.message.text).toContain('or under Contracts. Its AI decides what it writes. A change to the recipe asks you again.');
  });

  it('names a schedule\'s or an event trigger\'s by its trigger', () => {
    for (const [trigger, label] of [
      [{ kind: 'schedule', schedule_id: 'sch_1' }, 'Always allow for this schedule'],
      [{ kind: 'event_trigger', trigger_id: 'trg_1' }, 'Always allow for this trigger'],
    ] as const) {
      const built = buildPreflightAsk({ checkpoint: checkpoint({ trigger_preapproval: { ...OFFER, trigger, door_contract_id: undefined } }),
        context: context() });
      expect(built.options.map((option) => option.label)).toContain(label);
    }
  });

  it('an offer that no longer reads, a foreach cover or a batch: no such answer, the session grant as before', () => {
    const unread = buildPreflightAsk({ checkpoint: checkpoint({ trigger_preapproval: { ...OFFER, door_contract_id: undefined } }),
      context: context() });
    expect(unread.options.map((option) => option.id)).toEqual(['approve', 'allow_session', 'deny']);
    const cover = buildPreflightAsk({ checkpoint: checkpoint({ trigger_preapproval: OFFER, foreach_cover: { total: 3 } }),
      context: context({ foreach_cover: { total: 3 } }) });
    expect(cover.options.map((option) => option.id)).not.toContain('allow_trigger');
    const none = buildPreflightAsk({ checkpoint: checkpoint({}), context: context() });
    expect(none.options.map((option) => option.id)).toEqual(['approve', 'allow_session', 'deny']);
  });
});

describe('D-341 slice B2 — "Always allow for this …" approves, asking the server to grant it', () => {
  const answer = (option: string): Answer => ({ option, answered_at: 5 } as Answer);
  const run = async (option: string, cp: Checkpoint = checkpoint()) => {
    const store = { get: vi.fn(async () => cp), delete: vi.fn(async () => undefined) } as unknown as CheckpointStore;
    const resumer = { resumeRun: vi.fn(async () => undefined), denyRun: vi.fn(async () => undefined) } as
      PreflightResumer & { resumeRun: ReturnType<typeof vi.fn>; denyRun: ReturnType<typeof vi.fn> };
    const handler = createPreflightAnswerHandler({ checkpointStore: store, resumer });
    await handler(buildPreflightAsk({ checkpoint: cp, context: context() }).handler.payload, answer(option));
    return resumer;
  };

  it('resumes with the grant asked for; a plain approve asks for none; deny denies', async () => {
    expect((await run('allow_trigger')).resumeRun.mock.calls[0]![1]).toMatchObject({ trigger_preapproval_answer: true });
    expect((await run('approve')).resumeRun.mock.calls[0]![1].trigger_preapproval_answer).toBeUndefined();
    const denied = await run('deny');
    expect(denied.resumeRun).not.toHaveBeenCalled();
    expect(denied.denyRun).toHaveBeenCalledTimes(1);
  });

  it('on a hold whose offer no longer reads, it is a plain approve', async () => {
    const resumer = await run('allow_trigger', checkpoint({ trigger_preapproval: { ...OFFER, op: '' } }));
    expect(resumer.resumeRun).toHaveBeenCalledTimes(1);
    expect(resumer.resumeRun.mock.calls[0]![1].trigger_preapproval_answer).toBeUndefined();
  });
});
