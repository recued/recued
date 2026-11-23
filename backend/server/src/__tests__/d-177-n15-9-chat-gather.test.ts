/** D-177 §N.15.9 — a round of the owner's chat gathers its held calls of one op (Q7, "After each
 *  round"), and slice K's bookkeeping beside it: a held call is noted waiting once, by its run. */

import { describe, expect, it, vi } from 'vitest';
import type { Checkpoint, ExecutionSource } from '@recued/contracts';
import { PREFLIGHT_GATHERED_HANDLER_KIND, PREFLIGHT_HANDLER_KIND, type PreflightNotifier } from '@recued/gateway';

import { askAfterWaiting, noteAnsweredInTurn, noteWaitingInTurn } from '../chat-carries-on.js';
import {
  beginRoundGather,
  closeRoundGather,
  deferToRound,
  gatherCallKey,
  gatherOpKey,
  gathersInRound,
  heldOnceAsked,
  keptForRound,
  raiseRoundGather,
  readsOnceAsked,
  roundAccepts,
  takeRoundGather,
  type RoundMember,
} from '../chat-gather.js';

const OWNER: ExecutionSource = { channel: 'chat', actor: 'user_self', chat_session_id: 's', user_id: 'u' } as ExecutionSource;
const AI_APP = { channel: 'mcp', actor: 'contracted_user', contract_id: 'ct', mcp_token_id: 't' } as unknown as ExecutionSource;
const SEND = gatherOpKey({ ingredient_slug: 'mail-send', recipe_id: 'send-composed-mail' });
const UPDATE = gatherOpKey({ ingredient_slug: 'hubspot', operation_id: 'deal.update', connection_name: 'hubspot' });

const notifier = () => {
  const asks: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  return {
    asks,
    notifier: {
      ask: vi.fn(async (_message: unknown, _options: unknown, handler: { kind: string; payload: Record<string, unknown> }) => {
        asks.push(handler);
        return { ask_id: `ask-${String(asks.length)}` };
      }),
      registerAskHandler: vi.fn(), notify: vi.fn(),
    } as unknown as PreflightNotifier,
  };
};

const member = (n: number, op_key: string, n2: PreflightNotifier, links: string[] = []): RoundMember => ({
  run_id: `run-${String(n)}`, tool_name: 'recipe.run', call_key: 'recipe.run:send-composed-mail', op_key, notifier: n2,
  checkpoint: {
    checkpoint_id: `cp-${String(n)}`, run_id: `run-${String(n)}`, gated_step_id: 'send', created_at: n, step_state: {},
    preflight_context: { tool_slug: 'mail-send', risk_tier: 'write', recipe_title: 'Send a composed email' },
  } as unknown as Checkpoint,
  context: { recipe_id: 'send-composed-mail', gated_step_id: 'send', tool_slug: 'mail-send', risk_tier: 'write' },
  item: { summary: 'mail-send', args_preview: { to: [`g${String(n)}@example.com`] } },
  link: async (ask_id) => { links.push(`${String(n)}:${ask_id}`); },
});

describe('D-337 slice K — a held call is noted once, by its run', () => {
  it('noted by its handler and by the turn, one answer leaves nothing waiting', () => {
    const state = new Map<string, unknown>();
    noteWaitingInTurn(state, 'kitchen/send', 'run-1');
    noteWaitingInTurn(state, 'kitchen/send', 'run-1');
    expect(askAfterWaiting(OWNER, state)).toBe('kitchen/send');
    noteAnsweredInTurn(state, 'kitchen/send', 'run-1');
    expect(askAfterWaiting(OWNER, state)).toBeUndefined();
  });

  it('two held runs of one tool are two waits; an answer by run takes its own', () => {
    const state = new Map<string, unknown>();
    noteWaitingInTurn(state, 'kitchen/send', 'run-1');
    noteWaitingInTurn(state, 'kitchen/send', 'run-2');
    noteAnsweredInTurn(state, 'kitchen/send', 'run-2');
    expect(askAfterWaiting(OWNER, state)).toBe('kitchen/send');
    // A note with no run (a chat's own write) is taken by its tool.
    noteWaitingInTurn(state, 'work.create');
    noteAnsweredInTurn(state, 'kitchen/send', 'run-1');
    noteAnsweredInTurn(state, 'work.create');
    expect(askAfterWaiting(OWNER, state)).toBeUndefined();
  });
});

describe('D-177 §N.15.9 — the round gathers what it repeats', () => {
  const calls = [
    { tool: 'recipe.run', args: { recipe_id: 'send-composed-mail', config: { to: ['a@x.y'] } } },
    { tool: 'recipe.run', args: { recipe_id: 'send-composed-mail', config: { to: ['b@x.y'] } } },
    { tool: 'recipe.run', args: { recipe_id: 'weekly-digest' } },
    { tool: 'recued_op_hubspot.deal.update', args: { deal_id: '1' } },
  ];

  it('only a call the round repeats, in the owner\'s own conversation', () => {
    const state = new Map<string, unknown>();
    beginRoundGather(state, 0, calls);
    expect(gathersInRound(state, OWNER, 'recipe.run', calls[0]!.args)).toBe(true);
    expect(gathersInRound(state, OWNER, 'recipe.run', calls[2]!.args)).toBe(false);
    expect(gathersInRound(state, OWNER, 'recued_op_hubspot.deal.update', {})).toBe(false);
    expect(gathersInRound(state, AI_APP, 'recipe.run', calls[0]!.args)).toBe(false);
    // A recipe the AI writes in the call is one kind of call; a recipe named by id another.
    expect(gatherCallKey('recipe.run', { recipe: {} })).toBe('recipe.run:(written)');
    expect(gatherCallKey('kitchen/send', { to: 'a' })).toBe('kitchen/send');
  });

  it('keeps holds of one op, says which runs it kept, and takes no other op', () => {
    const state = new Map<string, unknown>();
    beginRoundGather(state, 0, calls);
    const { notifier: n } = notifier();
    expect(roundAccepts(state, 'recipe.run:send-composed-mail')).toBe(true);
    expect(deferToRound(state, member(1, SEND, n))).toBe(true);
    expect(deferToRound(state, member(2, SEND, n))).toBe(true);
    expect(keptForRound(state, 'run-2')).toBe(true);
    expect(keptForRound(state, 'run-9')).toBe(false);
    // A kept hold holds later asks back, as a held call does.
    expect(askAfterWaiting(OWNER, state)).toBe('recipe.run');
    // Another op is not taken, and the round takes no more after it.
    expect(deferToRound(state, member(3, UPDATE, n))).toBe(false);
    expect(deferToRound(state, member(4, SEND, n))).toBe(false);
    expect(takeRoundGather(state).map((m) => m.run_id)).toEqual(['run-1', 'run-2']);
    expect(takeRoundGather(state)).toEqual([]);
  });

  it('a call not asked closes the round; a call of an earlier round still waiting holds it shut', () => {
    const state = new Map<string, unknown>();
    beginRoundGather(state, 0, calls);
    closeRoundGather(state);
    expect(roundAccepts(state, 'recipe.run:send-composed-mail')).toBe(false);
    expect(gathersInRound(state, OWNER, 'recipe.run', calls[0]!.args)).toBe(false);
    const next = new Map<string, unknown>();
    noteWaitingInTurn(next, 'kitchen/other', 'run-0');
    beginRoundGather(next, 1, calls);
    expect(roundAccepts(next, 'recipe.run:send-composed-mail')).toBe(false);
  });

  it('a new round returns what an earlier one left unasked', () => {
    const state = new Map<string, unknown>();
    beginRoundGather(state, 0, calls);
    const { notifier: n } = notifier();
    deferToRound(state, member(1, SEND, n));
    expect(beginRoundGather(state, 1, calls).map((m) => m.run_id)).toEqual(['run-1']);
    expect(keptForRound(state, 'run-1')).toBe(false);
  });
});

describe('D-177 §N.15.9 — the round\'s end asks once per op', () => {
  it('two or more of one op: one gathered approval, its id on each hold', async () => {
    const { notifier: n, asks } = notifier();
    const links: string[] = [];
    const raised = await raiseRoundGather([member(1, SEND, n, links), member(2, SEND, n, links), member(3, SEND, n, links)]);
    expect(raised).toHaveLength(3);
    expect(asks).toHaveLength(1);
    expect(asks[0]!.kind).toBe(PREFLIGHT_GATHERED_HANDLER_KIND);
    expect(asks[0]!.payload.checkpoint_ids).toEqual(['cp-1', 'cp-2', 'cp-3']);
    expect(links).toEqual(['1:ask-1', '2:ask-1', '3:ask-1']);
  });

  it('one member asks as its own hold would have; two ops are two approvals', async () => {
    const { notifier: n, asks } = notifier();
    await raiseRoundGather([member(1, SEND, n), member(2, UPDATE, n), member(3, UPDATE, n)]);
    expect(asks.map((ask) => ask.kind)).toEqual([PREFLIGHT_HANDLER_KIND, PREFLIGHT_GATHERED_HANDLER_KIND]);
  });

  it('a raise that fails leaves the holds to the boot sweep, and says nothing went out', async () => {
    const failing = {
      ask: vi.fn(async () => { throw new Error('block down'); }), registerAskHandler: vi.fn(), notify: vi.fn(),
    } as unknown as PreflightNotifier;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await raiseRoundGather([member(1, SEND, failing), member(2, SEND, failing)])).toEqual([]);
    warn.mockRestore();
  });
});

describe('D-329 — a kept call is told where the round\'s ask went, as a call asked on its own is', () => {
  const HELD = { ok: true, result: { status: 'awaiting_approval' }, run_held: { kind: 'approval', gathered: true }, run_id: 'run-1' } as const;
  const told = (channels: readonly string[]) => ({ ...HELD, result: { status: 'awaiting_approval', approval_elsewhere: channels.join('+') } });

  it('the channels are read once per approval, by its ask, and each member carries them', async () => {
    const { notifier: n } = notifier();
    const read: string[] = [];
    const withChannels = (k: number): RoundMember => ({
      ...member(k, SEND, n), askChannels: async (ask_id) => { read.push(ask_id); return ['ui', 'telegram']; },
    });
    const raised = await raiseRoundGather([withChannels(1), withChannels(2)]);
    expect(read).toEqual(['ask-1']);
    expect(raised.map((m) => [m.run_id, m.ask_id, m.approval_channels])).toEqual([
      ['run-1', 'ask-1', ['ui', 'telegram']], ['run-2', 'ask-1', ['ui', 'telegram']],
    ]);
  });

  it('a failed read names nowhere: the ask still counts as out', async () => {
    const { notifier: n } = notifier();
    const raised = await raiseRoundGather([
      { ...member(1, SEND, n), askChannels: () => { throw new Error('index down'); } },
      { ...member(2, SEND, n), askChannels: () => { throw new Error('index down'); } },
    ]);
    expect(raised.map((m) => m.approval_channels)).toEqual([undefined, undefined]);
  });

  it('its held result is re-formed by its handler with them; with none, it reads as it was', async () => {
    const state = new Map<string, unknown>();
    beginRoundGather(state, 0, []);
    const { notifier: n } = notifier();
    deferToRound(state, member(1, SEND, n));
    readsOnceAsked(state, 'run-1', told);
    readsOnceAsked(state, 'run-9', () => { throw new Error('not kept: never asked for'); });
    const [kept] = takeRoundGather(state);
    expect(heldOnceAsked({ ...kept!, ask_id: 'ask-1', approval_channels: ['telegram'] }, HELD))
      .toEqual(told(['telegram']));
    expect(heldOnceAsked({ ...kept!, ask_id: 'ask-1', approval_channels: [] }, HELD)).toBe(HELD);
    expect(heldOnceAsked({ ...kept!, ask_id: 'ask-1' }, HELD)).toBe(HELD);
    expect(heldOnceAsked({ ...member(2, SEND, n), ask_id: 'ask-1', approval_channels: ['telegram'] }, HELD)).toBe(HELD);
  });
});
