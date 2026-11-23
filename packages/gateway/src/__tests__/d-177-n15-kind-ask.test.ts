/** D-177 N.15 — a held write the owner's own chat made offers "Allow in this chat" on its ask, in
 *  place of "Allow this session", and says what it lets happen, naming the write as the system
 *  already names it (§N.15.6 ruling 3). Answered, it approves with the grant the hold offered; the
 *  server mints it before the write goes on (`preflight-resumer.ts`, the server's
 *  `d-177-n15-kind-grant.test.ts`). */

import { describe, expect, it, vi } from 'vitest';
import type { Checkpoint, KindGrantOffer, TriggerPreapprovalOffer } from '@recued/contracts';
import type { Answer } from '@recued/notification';
import type { CheckpointStore } from '@recued/storage';

import {
  buildPreflightAsk,
  createPreflightAnswerHandler,
  type PreflightAskContext,
  type PreflightResumer,
} from '../preflight-reconciliation.js';

const OFFER: KindGrantOffer = {
  channel: 'chat', actor: 'user_self', channel_session_id: 'chat:chat-a', ingredient_slug: 'recued:tier1',
  operation_id: 'work.create:task', risk_tier: 'write', name: 'Add a task',
  ttl_ms: 3_600_000, max_uses: 100,
};
const TRIGGER: TriggerPreapprovalOffer = {
  trigger: { kind: 'prompt_schedule', schedule_id: 'ps_1' }, recipe_id: 'ps_1', recipe_sha256: 'a'.repeat(64),
  op: 'work.create:task', asks_ai: true,
};
const NOTE = '“Allow in this chat” stops asking about “Add a task” in this conversation, up to 100 times in the'
  + ' next hour. Its AI decides each one: what it says, and who or what it is for. You can end it sooner under'
  + ' Active passes.';

const checkpoint = (preflight_context: Record<string, unknown> = { kind_grant: OFFER }): Checkpoint => ({
  checkpoint_id: 'cp-1', run_id: 'run-1', step_state: {}, created_at: 1,
  raw_op: { tier1_tool: 'work.create', op_id: 'work.create', catalog_slug: 'recued:tier1', operation: 'work.create',
    connection_name: '', op_args: { kind: 'task', title: 'Call Mia' }, risk_tier: 'write',
    execution_source: { channel: 'chat', actor: 'user_self', chat_session_id: 'chat-a', turn_id: 't', user_id: 'owner' } },
  preflight_context: { tool_slug: 'work.create', risk_tier: 'write', ...preflight_context },
} as unknown as Checkpoint);

const context = (overrides: Partial<PreflightAskContext> = {}): PreflightAskContext => ({
  raw_op: { op_id: 'work.create' }, tool_slug: 'work.create', risk_tier: 'write',
  // Were an exact grant offered too, the kind grant takes its place.
  session_grant: { ttl_ms: 3_600_000, max_uses: 5, risk_tier: 'write' },
  ...overrides,
});

describe('D-177 N.15 — the ask offers "Allow in this chat"', () => {
  it('between approve and deny, in place of "Allow this session", and says what it lets happen', () => {
    const built = buildPreflightAsk({ checkpoint: checkpoint(), context: context() });
    expect(built.options).toEqual([
      { id: 'approve', label: 'Approve' },
      { id: 'allow_kind', label: 'Allow in this chat' },
      { id: 'deny', label: 'Deny' },
    ]);
    expect(built.message.text).toContain(`\n\n${NOTE}\n\nApprove?`);
    expect(built.handler.payload.session_grant).toBeUndefined();
    expect(built.handler.payload.kind_grant_decision_version).toBe(1);
  });

  it('never beside a trigger\'s pre-approval, on a review the owner gives each time, a batch or a cover', () => {
    const trigger = buildPreflightAsk({ checkpoint: checkpoint({ kind_grant: OFFER, trigger_preapproval: TRIGGER }), context: context() });
    expect(trigger.options.map((option) => option.id)).toEqual(['approve', 'allow_trigger', 'deny']);
    for (const lift_reason of ['review_commitment', 'review_quote_signoff'] as const) {
      const reviewed = buildPreflightAsk({ checkpoint: checkpoint(), context: context({
        session_grant: undefined, authorization_provenance: { pre_lift_approval: 'ask', lift_reason } as never,
      }) });
      expect(reviewed.options.map((option) => option.id)).not.toContain('allow_kind');
    }
    // A send is no exception (D-177 §N.15.6): a hold stored with the removed send lift's mark offers it.
    const send = buildPreflightAsk({ checkpoint: checkpoint(), context: context({
      authorization_provenance: { pre_lift_approval: 'never', lift_reason: 'review_send' } as never,
    }) });
    expect(send.options.map((option) => option.id)).toContain('allow_kind');
    const cover = buildPreflightAsk({ checkpoint: checkpoint({ kind_grant: OFFER, foreach_cover: { total: 3 } }),
      context: context({ foreach_cover: { total: 3 } }) });
    expect(cover.options.map((option) => option.id)).not.toContain('allow_kind');
  });

  it('a recipe\'s held send, and the AI\'s held pack op on its connection, offer it in the op\'s own words', () => {
    const send = buildPreflightAsk({
      checkpoint: { ...checkpoint({ kind_grant: { ...OFFER, ingredient_slug: 'mail-send', operation_id: 'mail-send',
        name: 'Send an email', recipe: { recipe_id: 'send-to-person', recipe_hash: 'h1' } } }), raw_op: undefined } as never,
      context: { recipe_id: 'send-to-person', gated_step_id: 'send', tool_slug: 'mail-send', risk_tier: 'write',
        session_grant: { ttl_ms: 3_600_000, max_uses: 5, risk_tier: 'write' } } as PreflightAskContext,
    });
    expect(send.options.map((option) => option.label)).toEqual(['Approve', 'Allow in this chat', 'Deny']);
    expect(send.message.text).toContain('“Allow in this chat” stops asking about “Send an email” in this conversation');
    const deal = buildPreflightAsk({
      checkpoint: checkpoint({ kind_grant: { ...OFFER, ingredient_slug: 'recued-core/hubspot-catalog',
        operation_id: 'recued-core/hubspot-catalog.deal.update', connection_name: 'hubspot', name: 'Update a deal' } }),
      context: context({ raw_op: { op_id: 'hubspot.deal.update' }, connection_name: 'hubspot' }),
    });
    expect(deal.options.map((option) => option.id)).toEqual(['approve', 'allow_kind', 'deny']);
    expect(deal.message.text).toContain('stops asking about “Update a deal” in this conversation');
  });

  it('an offer that no longer reads, or one wider than the ruled bounds, offers nothing new', () => {
    for (const offer of [{ ...OFFER, max_uses: 101 }, { ...OFFER, ttl_ms: 3_600_001 }, { ...OFFER, actor: 'system' },
      { ...OFFER, channel: 'schedule' }, { ...OFFER, name: '' }]) {
      const built = buildPreflightAsk({ checkpoint: checkpoint({ kind_grant: offer }), context: context() });
      expect(built.options.map((option) => option.id)).toEqual(['approve', 'allow_session', 'deny']);
    }
  });
});

describe('D-177 N.15 — "Allow in this chat" approves, asking the server to grant it', () => {
  const answer = (option: string): Answer => ({ option, answered_at: 5 } as Answer);
  const run = async (option: string, cp: Checkpoint = checkpoint(), legacy = false) => {
    const store = { get: vi.fn(async () => cp), delete: vi.fn(async () => undefined) } as unknown as CheckpointStore;
    const resumer = { resumeRun: vi.fn<PreflightResumer['resumeRun']>(async () => undefined),
      denyRun: vi.fn<PreflightResumer['denyRun']>(async () => undefined) };
    const handler = createPreflightAnswerHandler({ checkpointStore: store, resumer });
    const payload = buildPreflightAsk({ checkpoint: cp, context: context() }).handler.payload;
    if (legacy) delete payload.kind_grant_decision_version;
    await handler(payload, answer(option));
    return resumer;
  };

  it('resumes with the grant asked for; a plain approve asks for none', async () => {
    expect((await run('allow_kind')).resumeRun.mock.calls[0]![1]).toMatchObject({
      kind_grant_answer: true, kind_grant_decision_version: 1 });
    expect((await run('approve')).resumeRun.mock.calls[0]![1].kind_grant_answer).toBeUndefined();
  });

  it('a legacy saved answer retains action approval without authorizing a new kind grant', async () => {
    const resumer = await run('allow_kind', checkpoint(), true);
    expect(resumer.resumeRun).toHaveBeenCalledTimes(1);
    expect(resumer.resumeRun.mock.calls[0]![1].kind_grant_decision_version).toBeUndefined();
  });

  it('on a hold whose offer no longer reads, it is a plain approve', async () => {
    const resumer = await run('allow_kind', checkpoint({ kind_grant: { ...OFFER, operation_id: '' } }));
    expect(resumer.resumeRun).toHaveBeenCalledTimes(1);
    expect(resumer.resumeRun.mock.calls[0]![1].kind_grant_answer).toBeUndefined();
  });
});
