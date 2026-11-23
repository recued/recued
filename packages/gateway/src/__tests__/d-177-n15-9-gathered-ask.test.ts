/** D-177 §N.15.9 — a round's gathered approval (Q7, "After each round"): the held calls of one op
 *  a round of the owner's chat made, asked once. It lists them all, keeps "Allow in this chat",
 *  drops the answers of one call, and its answer is given to each member's own handler in turn. */

import { describe, expect, it, vi } from 'vitest';
import type { Checkpoint, KindGrantOffer } from '@recued/contracts';
import type { Answer } from '@recued/notification';
import type { CheckpointStore } from '@recued/storage';

import {
  PREFLIGHT_GATHERED_HANDLER_KIND,
  PREFLIGHT_HANDLER_KIND,
  buildGatheredPreflightAsk,
  buildPreflightAsk,
  createGatheredPreflightAnswerHandler,
  preflightAskHoldsCheckpoint,
  registerPreflightHandler,
  type GatheredHoldAsk,
  type PreflightAskContext,
  type PreflightResumer,
} from '../preflight-reconciliation.js';

const KIND: KindGrantOffer = {
  channel: 'chat', actor: 'user_self', channel_session_id: 'chat:chat-a', ingredient_slug: 'mail-send',
  operation_id: 'mail-send', recipe: { recipe_id: 'send-composed-mail', recipe_hash: 'h1' }, risk_tier: 'write',
  name: 'Send an email', ttl_ms: 3_600_000, max_uses: 100,
};

/** A scheduled prompt's standing pre-approval, as its hold offers it (D-341 B3). */
const TRIGGER_OFFER = {
  trigger: { kind: 'prompt_schedule', schedule_id: 'sched-1' }, recipe_id: 'send-composed-mail',
  recipe_sha256: 'a'.repeat(64), op: 'mail-send',
};

const member = (n: number, extra: Record<string, unknown> = {}): GatheredHoldAsk => {
  const checkpoint = {
    checkpoint_id: `cp-${String(n)}`, run_id: `run-${String(n)}`, gated_step_id: 'send', created_at: n,
    step_state: { send: { input: { to: [`guest${String(n)}@example.com`], subject: 'New time' } } },
    preflight_context: {
      tool_slug: 'mail-send', risk_tier: 'write', recipe_title: 'Send a composed email',
      value_labels: { to: { [`guest${String(n)}@example.com`]: `Guest ${String(n)}` } },
      kind_grant: KIND, ...extra,
    },
  } as unknown as Checkpoint;
  const context: PreflightAskContext = {
    recipe_id: 'send-composed-mail', gated_step_id: 'send', tool_slug: 'mail-send', risk_tier: 'write',
    authorization_provenance: { pre_lift_approval: 'ask' },
    session_grant: { ttl_ms: 3_600_000, max_uses: 5, risk_tier: 'write' },
    owner_override_offer: { kind: 'never_ask', ingredient_id: 'mail-send', operation_id: 'mail-send' } as never,
  };
  return { checkpoint, context, item: { summary: 'mail-send', args_preview: { to: [`guest${String(n)}@example.com`], subject: 'New time' } } };
};

describe('D-177 §N.15.9 — the gathered approval', () => {
  it('lists every member once, keeps "Allow in this chat", and drops the answers of one call', () => {
    const members = [member(1), member(2), member(3)];
    const ask = buildGatheredPreflightAsk(members);
    expect(ask.message.title).toBe('Approve: Send a composed email, 3 actions');
    const lines = ask.message.text.split('\n');
    expect(lines[0]).toBe('"Send a composed email" is waiting for your approval to run 3 actions, all from this chat turn.');
    expect(ask.message.text).toContain('stops asking about “Send an email” in this conversation');
    expect(ask.message.text.trimEnd().endsWith('Approve all 3?')).toBe(true);
    // Every member's recipient, by the name the server knew it by.
    for (const n of [1, 2, 3]) expect(ask.message.text).toContain(`Guest ${String(n)}`);
    expect(ask.options.map((option) => option.id)).toEqual(['approve', 'allow_kind', 'deny']);
    expect(ask.message.text).not.toContain('Allow this session');
  });

  it('with no "Allow in this chat" to offer, it offers no "Allow this session" either', () => {
    // An exact grant minted from one member would match that one call only.
    const plain = (n: number): GatheredHoldAsk => {
      const m = member(n);
      return { ...m, checkpoint: { ...m.checkpoint,
        preflight_context: { ...m.checkpoint.preflight_context, kind_grant: undefined } } as unknown as Checkpoint };
    };
    const ask = buildGatheredPreflightAsk([plain(1), plain(2)]);
    expect(ask.options.map((option) => option.id)).toEqual(['approve', 'deny']);
    expect(ask.message.text).not.toContain('Allow this session');
    // The control: alone, the hold asks as its own would, and that offers it.
    expect(buildGatheredPreflightAsk([plain(1)]).options.map((option) => option.id)).toContain('allow_session');
  });

  it('a scheduled prompt\'s gathered writes keep "Always allow for this scheduled prompt"', () => {
    // D-341: the one answer that stops the prompt asking next time; its trigger and op are every member's.
    const scheduled = (n: number): GatheredHoldAsk => {
      const m = member(n);
      return { ...m, checkpoint: { ...m.checkpoint, preflight_context: { ...m.checkpoint.preflight_context,
        kind_grant: undefined, trigger_preapproval: TRIGGER_OFFER } } as unknown as Checkpoint };
    };
    const ask = buildGatheredPreflightAsk([scheduled(1), scheduled(2)]);
    expect(ask.options.map((option) => option.id)).toEqual(['approve', 'allow_trigger', 'deny']);
    expect(ask.options[1]!.label).toBe('Always allow for this scheduled prompt');
  });

  it('its answer payload is each member\'s own, with every member\'s checkpoint beside them', () => {
    const members = [member(1), member(2)];
    const ask = buildGatheredPreflightAsk(members);
    expect(ask.handler.kind).toBe(PREFLIGHT_GATHERED_HANDLER_KIND);
    expect(ask.handler.payload.checkpoint_ids).toEqual(['cp-1', 'cp-2']);
    expect(ask.handler.payload.members).toEqual(
      members.map((m) => buildPreflightAsk({ checkpoint: m.checkpoint, context: m.context }).handler.payload));
  });

  it('one member asks as its own hold would have', () => {
    const [only] = [member(1)];
    const gathered = buildGatheredPreflightAsk([only]);
    const own = buildPreflightAsk({ checkpoint: only.checkpoint, context: only.context });
    expect(gathered).toEqual(own);
    expect(gathered.handler.kind).toBe(PREFLIGHT_HANDLER_KIND);
  });

  it('an AI\'s direct op, gathered, says how many times', () => {
    const raw = (n: number): GatheredHoldAsk => ({
      checkpoint: { checkpoint_id: `cp-${String(n)}`, run_id: `run-${String(n)}`, step_state: {}, created_at: n,
        preflight_context: { tool_slug: 'deal.update', connection_name: 'hubspot', risk_tier: 'write' } } as unknown as Checkpoint,
      context: { raw_op: { op_id: 'recued-core.hubspot.deal.update' }, tool_slug: 'deal.update', risk_tier: 'write',
        connection_name: 'hubspot' },
      item: { summary: 'deal.update', args_preview: { deal_id: `d-${String(n)}`, stage: 'won' } },
    });
    const ask = buildGatheredPreflightAsk([raw(1), raw(2)]);
    expect(ask.message.text.split('\n')[0]).toContain('2 times, all from this chat turn.');
    expect(ask.message.text.trimEnd().endsWith('Approve all 2?')).toBe(true);
  });

  it('is found by any member\'s checkpoint; a call\'s own ask by its own', () => {
    const gathered = buildGatheredPreflightAsk([member(1), member(2)]);
    const asGathered = { handler_kind: gathered.handler.kind, handler_payload: gathered.handler.payload };
    expect(preflightAskHoldsCheckpoint(asGathered, 'cp-2')).toBe(true);
    expect(preflightAskHoldsCheckpoint(asGathered, 'cp-9')).toBe(false);
    const own = buildPreflightAsk({ checkpoint: member(1).checkpoint, context: member(1).context });
    expect(preflightAskHoldsCheckpoint({ handler_kind: own.handler.kind, handler_payload: own.handler.payload }, 'cp-1'))
      .toBe(true);
    expect(preflightAskHoldsCheckpoint({ handler_kind: 'other', handler_payload: { checkpoint_id: 'cp-1' } }, 'cp-1'))
      .toBe(false);
  });
});

describe('D-177 §N.15.9 — the gathered answer goes to each member', () => {
  it('is registered beside a call\'s own answer', () => {
    const kinds: string[] = [];
    registerPreflightHandler({ registerAskHandler: (kind: string) => { kinds.push(kind); } } as never,
      { checkpointStore: {} as CheckpointStore, resumer: {} as PreflightResumer });
    expect(kinds).toEqual([PREFLIGHT_HANDLER_KIND, PREFLIGHT_GATHERED_HANDLER_KIND]);
  });

  const run = async (option: string, opts: { failOn?: string; offer?: typeof TRIGGER_OFFER } = {}) => {
    const members = [1, 2, 3].map((n) => (opts.offer === undefined ? member(n) : member(n, { trigger_preapproval: opts.offer })));
    const byId = new Map(members.map((m) => [m.checkpoint.checkpoint_id, m.checkpoint]));
    const store = {
      get: vi.fn(async (id: string) => byId.get(id) ?? null),
      delete: vi.fn(async (id: string) => { byId.delete(id); }),
    } as unknown as CheckpointStore;
    const resumer = {
      resumeRun: vi.fn(async (cp: Checkpoint) => {
        if (cp.checkpoint_id === opts.failOn) throw new Error('resume failed');
      }),
      denyRun: vi.fn(async () => undefined),
    } as PreflightResumer & { resumeRun: ReturnType<typeof vi.fn>; denyRun: ReturnType<typeof vi.fn> };
    const handler = createGatheredPreflightAnswerHandler({ checkpointStore: store, resumer });
    const ask = buildGatheredPreflightAsk(members);
    const outcome = await Promise.resolve(handler(ask.handler.payload, { option, answered_at: 5 } as Answer))
      .then(() => 'ok', (e: Error) => e.message);
    return { resumer, outcome, left: [...byId.keys()] };
  };

  it('approve resumes each, in order, and consumes each hold', async () => {
    const { resumer, outcome, left } = await run('approve');
    expect(outcome).toBe('ok');
    expect(resumer.resumeRun.mock.calls.map(([cp]) => (cp as Checkpoint).run_id)).toEqual(['run-1', 'run-2', 'run-3']);
    expect(resumer.resumeRun.mock.calls.every(([, ctx]) => (ctx as { kind_grant_answer?: true }).kind_grant_answer === undefined))
      .toBe(true);
    expect(left).toEqual([]);
  });

  it('"Allow in this chat" grants once, with the first member, and approves the rest', async () => {
    const { resumer } = await run('allow_kind');
    expect(resumer.resumeRun.mock.calls.map(([, ctx]) => (ctx as { kind_grant_answer?: true }).kind_grant_answer))
      .toEqual([true, undefined, undefined]);
  });

  it('"Always allow for this scheduled prompt" too: with the first member, the rest approved', async () => {
    const { resumer } = await run('allow_trigger', { offer: TRIGGER_OFFER });
    expect(resumer.resumeRun.mock.calls.map(([, ctx]) => (ctx as { trigger_preapproval_answer?: true }).trigger_preapproval_answer))
      .toEqual([true, undefined, undefined]);
    expect(resumer.resumeRun).toHaveBeenCalledTimes(3);
  });

  it('deny declines each', async () => {
    const { resumer } = await run('deny');
    expect(resumer.denyRun).toHaveBeenCalledTimes(3);
    expect(resumer.resumeRun).not.toHaveBeenCalled();
  });

  it('one member failing still answers the others, then says so', async () => {
    const { resumer, outcome, left } = await run('approve', { failOn: 'cp-2' });
    expect(resumer.resumeRun).toHaveBeenCalledTimes(3);
    expect(outcome).toBe('resume failed');
    // The failed member's hold is kept for the retry; the others are consumed.
    expect(left).toEqual(['cp-2']);
  });
});

describe('D-177 §N.15.9 (1c-b) — a round\'s gathered approval of the chat\'s own writes', () => {
  /** A task the owner's chat would add, held as its own approval holds it. */
  const task = (n: number, title: string): GatheredHoldAsk => {
    const checkpoint = {
      checkpoint_id: `cp-t${String(n)}`, run_id: `run-t${String(n)}`, step_state: {}, created_at: n,
      raw_op: { tier1_tool: 'work.create', op_id: 'work.create', catalog_slug: 'recued:tier1', operation: 'work.create',
        connection_name: '', op_args: { kind: 'task', title }, risk_tier: 'write',
        execution_source: { channel: 'chat', actor: 'user_self', chat_session_id: 'chat-a', turn_id: 't', user_id: 'owner' } },
      preflight_context: { tool_slug: 'work.create', risk_tier: 'write', change_in_chat: 'Guests', kind_grant: {
        channel: 'chat', actor: 'user_self', channel_session_id: 'chat:chat-a', ingredient_slug: 'recued:tier1',
        operation_id: 'work.create:task', risk_tier: 'write', name: 'Add a task', ttl_ms: 3_600_000, max_uses: 100 } },
    } as unknown as Checkpoint;
    return {
      checkpoint,
      context: { raw_op: { op_id: 'work.create' }, tool_slug: 'work.create', risk_tier: 'write' },
      // What the hold hands the round: its tool and its arguments as they ran.
      item: { summary: 'work.create', args_preview: { kind: 'task', title } },
    };
  };

  it('says what it wants as one of them would, how many times, and lists each by its words', () => {
    const ask = buildGatheredPreflightAsk([task(1, 'Call Ann'), task(2, 'Call Ben'), task(3, 'Call Cara')]);
    expect(ask.message.title).toBe('Approve: Add a task, 3 actions');
    expect(ask.message.text.split('\n')[0]).toBe('The AI in your chat wants to add a task 3 times, all from this chat turn.');
    for (const title of ['Call Ann', 'Call Ben', 'Call Cara']) expect(ask.message.text).toContain(title);
    // Its kind, by the title, never the tool's id.
    expect(ask.message.text).not.toContain('kind: task');
    expect(ask.options.map((option) => option.id)).toEqual(['approve', 'allow_kind', 'deny']);
    // An approval of several takes no change to one of them.
    expect(ask.message.text).not.toContain('To change it first');
  });

  it('one held write asks as its own approval would, its change offered', () => {
    const only = task(1, 'Call Ann');
    expect(buildGatheredPreflightAsk([only])).toEqual(buildPreflightAsk({ checkpoint: only.checkpoint, context: only.context }));
    expect(buildGatheredPreflightAsk([only]).message.text).toContain('To change it first, open the chat “Guests” in Recued.');
  });
});
