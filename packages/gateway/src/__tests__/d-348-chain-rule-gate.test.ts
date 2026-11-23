/** D-348 slice 5 — the rule for a chat request, at the commit gateway.
 *
 *  A held write asks the host for the rule the owner accepted for the request its run was made for,
 *  only where a chain may stand in (`chainMayStandIn`, the check the evidence makes too): no review
 *  lift, the owner's policy before the lift `never` or `ask`, no browser batch putting the owner's
 *  files into a page, below destructive (deletes are slice 6's), and after no D-177 grant, pass or
 *  trigger pre-approval admitted it. The host is given the call's slug, its connection and its
 *  resolved arguments: a chain's call is what it does and to whom. One that admits lets the write
 *  through; anything else asks. The catalog gate's seam is the engine's
 *  `d-348-chain-rule-catalog-gate.test.ts`. */

import { describe, expect, it, vi } from 'vitest';
import {
  PreflightRequiredSignal,
  type AdmissionDecision,
  type ChainRuleHooks,
  type Commit,
  type ExecutionSource,
} from '@recued/contracts';
import { createCommitStore, createInMemoryCollection } from '@recued/storage';

import {
  wrapWithCommitGateway,
  type CommitGatewayDeps,
  type GatewayInner,
  type SessionGrantHooks,
} from '../commit-gateway.js';

const chat: ExecutionSource = { channel: 'chat', actor: 'user_self', chat_session_id: 'chat-1', user_id: 'owner-1' };

// The hold the owner's chat gets for a send set to ask.
const ask = (overrides: Partial<Extract<AdmissionDecision, { verdict: 'ask' }>> = {}): AdmissionDecision => ({
  verdict: 'ask',
  risk_tier: 'write',
  detail: 'Sending asks you first.',
  authorization_provenance: { pre_lift_approval: 'ask' },
  ...overrides,
} as AdmissionDecision);

const STEP = { step_id: 'send', recipe_id: 'send-composed-mail' };
const SEND = { to: ['ann@example.com'], subject: 'The new time' };

const gate = (overrides: Partial<CommitGatewayDeps> = {}, admit: ChainRuleHooks['admit'] = () => 'chain_1') => {
  const inner = vi.fn<GatewayInner>(async () => ({ sent: true }));
  const chainRules = { admit: vi.fn(admit) };
  let n = 0;
  const executor = wrapWithCommitGateway(inner, {
    commitStore: createCommitStore(createInMemoryCollection<Commit>()),
    identity: { request_id: 'run-1', source: chat, channel_session_id: 'chat:chat-1', correlation_id: 'c', dispatch_depth: 0 },
    getIngredientCategory: () => 'action',
    genCommitId: () => `commit-${(n += 1)}`,
    genIdempotencyKey: () => `idem-${n}`,
    evaluateAdmission: () => ask(),
    chainRules,
    ...overrides,
  });
  return { executor, inner, admit: chainRules.admit };
};

const held = async (promise: Promise<unknown>) => {
  await expect(promise).rejects.toBeInstanceOf(PreflightRequiredSignal);
};

describe('D-348 slice 5 — the commit gateway asks the host for the request\'s rule', () => {
  it('one that admits lets the held write through; the host is given the call, its account and its resolved arguments', async () => {
    const { executor, inner, admit } = gate({
      resolveArgsForHash: () => ({ ...SEND, connection: 'work-mail' }),
    });
    await expect(executor('mail-send', SEND, undefined, undefined, STEP)).resolves.toEqual({ sent: true });
    expect(admit).toHaveBeenCalledWith({
      slug: 'mail-send', connection_name: 'work-mail', risk_tier: 'write', args: { ...SEND, connection: 'work-mail' },
    });
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('none, a host that fails, or no host: the write asks, and nothing runs', async () => {
    for (const { executor, inner } of [
      gate({}, () => null),
      gate({}, () => { throw new Error('store unreadable'); }),
      gate({ chainRules: undefined }),
    ]) {
      await held(executor('mail-send', SEND, undefined, undefined, STEP));
      expect(inner).not.toHaveBeenCalled();
    }
  });

  it('⛔ is not asked where no chain may stand in: "always ask", any review, a file put into a page', async () => {
    const upload = { target: '*://example.test/*', page: '7:ABCDEF0123', steps: [{ do: 'upload', ref: 'e7', file: `file:${'b'.repeat(32)}` }] };
    const cases: Array<[string, Partial<CommitGatewayDeps>, string, Record<string, unknown>]> = [
      ['always', { evaluateAdmission: () => ask({ authorization_provenance: { pre_lift_approval: 'always' } }) }, 'mail-send', SEND],
      ...(['review_send', 'review_commitment', 'review_quote_signoff', 'review_approval_workflow', 'review_customer_payment', 'quality'] as const)
        .map((lift_reason): [string, Partial<CommitGatewayDeps>, string, Record<string, unknown>] => [lift_reason, {
          evaluateAdmission: () => ask({ authorization_provenance: { pre_lift_approval: 'ask', lift_reason } }) }, 'mail-send', SEND]),
      ['an upload', {}, 'core-dom-act', upload],
    ];
    for (const [name, overrides, slug, input] of cases) {
      const { executor, inner, admit } = gate(overrides);
      await held(executor(slug, input, undefined, undefined, STEP));
      expect(admit, name).not.toHaveBeenCalled();
      expect(inner, name).not.toHaveBeenCalled();
    }
    // The control: the same page clicked is asked about.
    const click = gate();
    await expect(click.executor('core-dom-act', { ...upload, steps: [{ do: 'click', ref: 'e12' }] }, undefined, undefined, STEP))
      .resolves.toEqual({ sent: true });
  });

  it('`never` before the floor raised it is waivable too', async () => {
    const { executor, inner } = gate({ evaluateAdmission: () => ask({ authorization_provenance: { pre_lift_approval: 'never' } }) });
    await expect(executor('mail-send', SEND, undefined, undefined, STEP)).resolves.toEqual({ sent: true });
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('a D-177 grant or a trigger pre-approval that admitted is spent instead; a write needing no ask, or a resumed approval, asks none', async () => {
    const sessionGrants: SessionGrantHooks = { match: () => 'grant-1', consume: () => true };
    const granted = gate({ sessionGrants, resolveArgsForHash: () => ({ ...SEND }) });
    await expect(granted.executor('mail-send', SEND, undefined, undefined, STEP)).resolves.toEqual({ sent: true });
    expect(granted.admit).not.toHaveBeenCalled();

    const preapproved = gate({ triggerPreapprovals: { admit: () => 'tpa_1' } });
    await expect(preapproved.executor('mail-send', SEND, undefined, undefined, STEP)).resolves.toEqual({ sent: true });
    expect(preapproved.admit).not.toHaveBeenCalled();

    const allowed = gate({ evaluateAdmission: (): AdmissionDecision => ({ verdict: 'admit' }) });
    await expect(allowed.executor('mail-send', SEND, undefined, undefined, STEP)).resolves.toEqual({ sent: true });
    expect(allowed.admit).not.toHaveBeenCalled();

    const resumed = gate();
    await expect(resumed.executor('mail-send', SEND, undefined, undefined, {
      ...STEP, preflight_admitted: true, preflight_approved_target: { ingredient_slug: 'mail-send' },
    })).resolves.toEqual({ sent: true });
    expect(resumed.admit).not.toHaveBeenCalled();
  });

  it('slice 6b — a delete of Recued\'s own is asked about too, at its floor\'s `always`; the host decides', async () => {
    const del = gate({
      evaluateAdmission: () => ask({ risk_tier: 'destructive', authorization_provenance: { pre_lift_approval: 'always' } }),
      resolveArgsForHash: () => ({ id: 'task-9' }),
    }, () => null);
    await held(del.executor('task-delete', { id: '{{item.id}}' }, undefined, undefined, STEP));
    expect(del.admit).toHaveBeenCalledWith({ slug: 'task-delete', risk_tier: 'destructive', args: { id: 'task-9' } });
    expect(del.inner).not.toHaveBeenCalled();
  });

  it('slice 6b — tells the host what each call it dispatched returned, with the arguments it resolved', async () => {
    const returned = vi.fn<NonNullable<ChainRuleHooks['returned']>>();
    const inner = vi.fn<GatewayInner>(async () => ({ entities: [{ id: 'task-9' }], total: 1 }));
    const executor = wrapWithCommitGateway(inner, {
      commitStore: createCommitStore(createInMemoryCollection<Commit>()),
      identity: { request_id: 'run-1', source: chat, channel_session_id: 'chat:chat-1', correlation_id: 'c', dispatch_depth: 0 },
      getIngredientCategory: () => 'data',
      genCommitId: () => 'commit-1',
      genIdempotencyKey: () => 'idem-1',
      evaluateAdmission: (): AdmissionDecision => ({ verdict: 'admit' }),
      resolveArgsForHash: () => ({ kind: 'task' }),
      chainRules: { admit: () => null, returned },
    });
    await expect(executor('work-entity-list', { kind: '{{config.kind}}' }, undefined, undefined, STEP))
      .resolves.toEqual({ entities: [{ id: 'task-9' }], total: 1 });
    expect(returned).toHaveBeenCalledWith({ slug: 'work-entity-list', args: { kind: 'task' }, result: { entities: [{ id: 'task-9' }], total: 1 } });
  });

  it('slice 6b — tells nothing of a call that failed or a catalog op\'s dispatch, and a host that throws fails nothing', async () => {
    const returned = vi.fn<NonNullable<ChainRuleHooks['returned']>>();
    const make = (inner: GatewayInner, onReturned: NonNullable<ChainRuleHooks['returned']> = returned) => wrapWithCommitGateway(inner, {
      commitStore: createCommitStore(createInMemoryCollection<Commit>()),
      identity: { request_id: 'run-1', source: chat, channel_session_id: 'chat:chat-1', correlation_id: 'c', dispatch_depth: 0 },
      getIngredientCategory: () => 'data',
      genCommitId: () => 'commit-1',
      genIdempotencyKey: () => 'idem-1',
      evaluateAdmission: (): AdmissionDecision => ({ verdict: 'admit' }),
      chainRules: { admit: () => null, returned: onReturned },
    });
    await expect(make(vi.fn<GatewayInner>(async () => { throw new Error('store down'); }))('work-entity-list', { kind: 'task' }, undefined, undefined, STEP))
      .rejects.toThrow('store down');
    await make(vi.fn<GatewayInner>(async () => ({ ok: true })))('hubspot-catalog', { operation: 'deal.search' }, undefined, undefined,
      { ...STEP, surface_dispatch: true, surface_operation_key: 'deal.search' });
    expect(returned).not.toHaveBeenCalled();
    const throwing = make(vi.fn<GatewayInner>(async () => ({ entities: [] })), () => { throw new Error('full'); });
    await expect(throwing('work-entity-list', { kind: 'task' }, undefined, undefined, STEP)).resolves.toEqual({ entities: [] });
  });

  it('each held write asks again: one use covers one call', async () => {
    let left = 1;
    const { executor, inner, admit } = gate({}, () => (left-- > 0 ? 'chain_1' : null));
    await expect(executor('mail-send', SEND, undefined, undefined, STEP)).resolves.toEqual({ sent: true });
    await held(executor('mail-send', SEND, undefined, undefined, STEP));
    expect(admit).toHaveBeenCalledTimes(2);
    expect(inner).toHaveBeenCalledTimes(1);
  });
});

describe('D-348 §7.8 — a write a standing permission lets through keeps a review of its change, so it can be undone', () => {
  const EDIT = { slug: 'local', source_id: 'meeting', patch: { summary: 'Team sync' } };
  const review = {
    schema_version: 1, operation: 'calendar-update', input_hash: 'a'.repeat(64), captured_at: 1,
    resources: [{ kind: 'calendar', key: 'local:meeting', label: 'Meeting', binding: 'local', version: 'v1',
      before: { summary: 'Meeting' }, after: { summary: 'Team sync' }, precondition: { kind: 'local_version', value: 'v1' } }],
  };
  /** The host's review hooks and local-change hook, as the server composes them: what ran under what. */
  const local = () => {
    const capture = vi.fn(() => review);
    const runs: Array<{ review: unknown; chain_rule: unknown }> = [];
    return {
      deps: {
        resourceReview: { capture, run: <T>(_review: unknown, effect: () => T): T => effect() },
        localMutations: {
          run: async <T>(call: { review: unknown; commit?: Commit }, dispatch: () => T | Promise<T>): Promise<T> => {
            runs.push({ review: call.review, chain_rule: call.commit?.chain_rule });
            return dispatch();
          },
        },
      } as unknown as Partial<CommitGatewayDeps>,
      capture, runs,
    };
  };

  it('let through by the request\'s rule: under a review, its commit naming the rule', async () => {
    const l = local();
    const { executor, inner } = gate(l.deps);
    await expect(executor('calendar-update', EDIT, undefined, undefined, STEP)).resolves.toEqual({ sent: true });
    expect(l.runs).toEqual([{ review, chain_rule: { id: 'chain_1' } }]);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('by a grant or a trigger\'s pre-approval: under a review too, naming no rule', async () => {
    const sessionGrants: SessionGrantHooks = { match: () => 'grant-1', consume: () => true };
    for (const permission of [{ sessionGrants }, { triggerPreapprovals: { admit: () => 'tpa_1' } }]) {
      const l = local();
      const { executor } = gate({ ...l.deps, ...permission, resolveArgsForHash: () => ({ ...EDIT }) });
      await expect(executor('calendar-update', EDIT, undefined, undefined, STEP)).resolves.toEqual({ sent: true });
      expect(l.runs).toEqual([{ review, chain_rule: undefined }]);
    }
  });

  it('a write that needs no ask runs as it did, with no review; one left to ask runs nothing', async () => {
    const allowed = local();
    const admit = gate({ ...allowed.deps, evaluateAdmission: (): AdmissionDecision => ({ verdict: 'admit' }) });
    await expect(admit.executor('calendar-update', EDIT, undefined, undefined, STEP)).resolves.toEqual({ sent: true });
    expect(allowed.runs).toEqual([]);
    expect(allowed.capture).not.toHaveBeenCalled();

    const asked = local();
    const hold = gate(asked.deps, () => null);
    await held(hold.executor('calendar-update', EDIT, undefined, undefined, STEP));
    expect(asked.runs).toEqual([]);
    expect(hold.inner).not.toHaveBeenCalled();
  });
});
