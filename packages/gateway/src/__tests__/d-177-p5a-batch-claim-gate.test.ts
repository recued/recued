/** D-177 P5a batch-claim commit Gateway tests. */

import { describe, expect, it, vi } from 'vitest';

import {
  PreflightRequiredSignal,
  canonicalArgHash,
  isPreflightRequiredSignal,
  projectResolvedArgs,
  type AdmissionDecision,
  type Commit,
  type ExecutionSource,
} from '@recued/contracts';
import {
  createCommitStore,
  createInMemoryCollection,
  type Collection,
  type CommitStore,
  type PendingCommitInput,
} from '@recued/storage';

import {
  wrapWithCommitGateway,
  type CommitGatewayDeps,
  type CommitRunIdentity,
  type GatewayInner,
  type SessionGrantHooks,
} from '../commit-gateway.js';
// NOTE: the store-level claim tests live in
// `backend/server/src/__tests__/d-177-p5a-batch-claim-store.test.ts` —
// `packages/` MUST NOT import `backend/` (public-boundary rule), even in
// tests; this file covers the Gateway seam over stubbed hooks only.

const DISPATCHED_AT = 1_700_000_000_000;
const COMPLETED_AT = 1_700_000_000_125;
const NOW = 1_700_100_000_000;

const source = (): ExecutionSource => ({
  channel: 'chat',
  actor: 'user_self',
  chat_session_id: 's',
  user_id: 'u',
});

const identity = (
  overrides: Partial<CommitRunIdentity> = {},
): CommitRunIdentity => ({
  request_id: 'request-1',
  source: source(),
  channel_session_id: 's',
  correlation_id: 'corr-1',
  dispatch_depth: 2,
  ...overrides,
});

const sequence = <T>(values: readonly T[]): (() => T) => {
  let index = 0;
  return () => {
    if (index >= values.length) {
      throw new Error(`test sequence exhausted at index ${index}`);
    }
    const value = values[index];
    index += 1;
    return value;
  };
};

const askDecision = (
  overrides: Partial<Extract<AdmissionDecision, { verdict: 'ask' }>> = {},
): Extract<AdmissionDecision, { verdict: 'ask' }> => ({
  verdict: 'ask',
  risk_tier: 'write',
  detail: 'approval required',
  ...overrides,
});

const admitDecision: AdmissionDecision = { verdict: 'admit' };

const resolvedArgs = {
  to: 'ada@example.com',
  connection: 'gmail-primary',
  body: { subject: 'hello' },
};

let backing: Collection<Commit>;
let store: CommitStore;

const resetCommitStore = (): void => {
  backing = createInMemoryCollection<Commit>();
  store = createCommitStore(backing);
};

const deps = (
  overrides: Partial<CommitGatewayDeps> = {},
): CommitGatewayDeps => ({
  commitStore: store,
  identity: identity(),
  getIngredientCategory: () => 'data',
  genCommitId: sequence(['commit-1']),
  genIdempotencyKey: sequence(['idem-1']),
  now: sequence([DISPATCHED_AT, COMPLETED_AT]),
  ...overrides,
});

const capturePendingStore = (): {
  commitStore: CommitStore;
  written: PendingCommitInput[];
  order: string[];
} => {
  const written: PendingCommitInput[] = [];
  const order: string[] = [];
  return {
    written,
    order,
    commitStore: {
      ...store,
      writePending: async (pending) => {
        order.push('pending');
        written.push(pending);
        await store.writePending(pending);
      },
    },
  };
};

const hashBasis = (
  resolved: Record<string, unknown> = resolvedArgs,
) => canonicalArgHash(projectResolvedArgs(resolved));

const batchStepMeta = (
  overrides: Record<string, unknown> = {},
) => ({
  step_id: 'step-1',
  recipe_id: 'recipe-1',
  preflight_admitted: true,
  preflight_approved_target: { ingredient_slug: 'mail.send' },
  preflight_batch_claim: {
    contract_id: 'grant-1',
    member_id: 'm1',
  },
  ...overrides,
});

const expectPreflightRequired = async (
  promise: Promise<unknown>,
): Promise<PreflightRequiredSignal> => {
  let thrown: unknown;
  try {
    await promise;
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(PreflightRequiredSignal);
  expect(isPreflightRequiredSignal(thrown)).toBe(true);
  return thrown as PreflightRequiredSignal;
};

const sessionHooks = (
  overrides: Partial<SessionGrantHooks> = {},
): SessionGrantHooks => ({
  match: vi.fn(() => null),
  consume: vi.fn(() => true),
  claimBatchMember: vi.fn(() => true),
  ...overrides,
});

describe('wrapWithCommitGateway D-177 P5a batch claim path', () => {
  it('claims a batch member before recordDispatchUse and writePending, then dispatches', async () => {
    resetCommitStore();
    const { commitStore, written, order } = capturePendingStore();
    const expected = hashBasis();
    const hooks = sessionHooks({
      claimBatchMember: vi.fn(() => {
        order.push('claim');
        return true;
      }),
    });
    const recordDispatchUse = vi.fn(() => {
      order.push('use');
    });
    const inner = vi.fn<GatewayInner>().mockImplementation(async () => {
      order.push('inner');
      return { ok: true };
    });
    const executor = wrapWithCommitGateway(inner, deps({
      commitStore,
      evaluateAdmission: () => askDecision(),
      resolveArgsForHash: () => resolvedArgs,
      sessionGrants: hooks,
      recordDispatchUse,
      genCommitId: sequence(['commit-batch']),
      genIdempotencyKey: sequence(['idem-batch']),
      now: sequence([DISPATCHED_AT, COMPLETED_AT]),
    }));

    await expect(
      executor('mail.send', { to: '{{config.to}}' }, undefined, undefined, batchStepMeta()),
    ).resolves.toEqual({ ok: true });

    expect(hooks.claimBatchMember).toHaveBeenCalledWith('grant-1', 'm1', {
      arg_shape_hash: expected.arg_shape_hash,
      canonical_payload_hash: expected.canonical_payload_hash,
    });
    expect(order).toEqual(['claim', 'use', 'pending', 'inner']);
    expect(recordDispatchUse).toHaveBeenCalledTimes(1);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      commit_id: 'commit-batch',
      arg_shape_hash: expected.arg_shape_hash,
      canonical_payload_hash: expected.canonical_payload_hash,
    });
  });

  it('re-holds without commit, recordDispatchUse, or dispatch when claim returns false', async () => {
    resetCommitStore();
    const { commitStore, written } = capturePendingStore();
    const hooks = sessionHooks({ claimBatchMember: vi.fn(() => false) });
    const recordDispatchUse = vi.fn();
    const inner = vi.fn<GatewayInner>().mockResolvedValue({ ok: true });
    const executor = wrapWithCommitGateway(inner, deps({
      commitStore,
      evaluateAdmission: () => askDecision(),
      resolveArgsForHash: () => resolvedArgs,
      sessionGrants: hooks,
      recordDispatchUse,
      genCommitId: sequence(['commit-no-claim']),
      genIdempotencyKey: sequence(['idem-no-claim']),
      now: sequence([DISPATCHED_AT]),
    }));

    await expectPreflightRequired(
      executor('mail.send', {}, undefined, undefined, batchStepMeta()),
    );

    expect(hooks.claimBatchMember).toHaveBeenCalledTimes(1);
    expect(written).toEqual([]);
    expect(recordDispatchUse).not.toHaveBeenCalled();
    expect(inner).not.toHaveBeenCalled();
    expect(await store.size()).toBe(0);
  });

  it('re-holds when claimBatchMember is absent on sessionGrants', async () => {
    resetCommitStore();
    const hooks: SessionGrantHooks = {
      match: vi.fn(() => null),
      consume: vi.fn(() => true),
    };
    const inner = vi.fn<GatewayInner>().mockResolvedValue({ ok: true });
    const executor = wrapWithCommitGateway(inner, deps({
      evaluateAdmission: () => askDecision(),
      resolveArgsForHash: () => resolvedArgs,
      sessionGrants: hooks,
      genCommitId: sequence(['commit-absent-claim']),
      genIdempotencyKey: sequence(['idem-absent-claim']),
      now: sequence([DISPATCHED_AT]),
    }));

    await expectPreflightRequired(
      executor('mail.send', {}, undefined, undefined, batchStepMeta()),
    );

    expect(hooks.match).not.toHaveBeenCalled();
    expect(hooks.consume).not.toHaveBeenCalled();
    expect(inner).not.toHaveBeenCalled();
    expect(await store.size()).toBe(0);
  });

  it('re-holds without calling claimBatchMember when hashes are unavailable', async () => {
    resetCommitStore();
    const hooks = sessionHooks({ claimBatchMember: vi.fn(() => true) });
    const executor = wrapWithCommitGateway(async () => ({ ok: true }), deps({
      evaluateAdmission: () => askDecision(),
      sessionGrants: hooks,
      genCommitId: sequence(['commit-no-hash']),
      genIdempotencyKey: sequence(['idem-no-hash']),
      now: sequence([DISPATCHED_AT]),
    }));

    await expectPreflightRequired(
      executor('mail.send', {}, undefined, undefined, batchStepMeta()),
    );

    expect(hooks.claimBatchMember).not.toHaveBeenCalled();
    expect(await store.size()).toBe(0);
  });

  it('strips the preflight_batch_claim marker before forwarding stepMeta', async () => {
    resetCommitStore();
    const hooks = sessionHooks();
    const inner = vi.fn<GatewayInner>().mockResolvedValue({ ok: true });
    const executor = wrapWithCommitGateway(inner, deps({
      evaluateAdmission: () => askDecision(),
      resolveArgsForHash: () => resolvedArgs,
      sessionGrants: hooks,
      genCommitId: sequence(['commit-strip']),
      genIdempotencyKey: sequence(['idem-strip']),
      now: sequence([DISPATCHED_AT, COMPLETED_AT]),
    }));

    await expect(
      executor('mail.send', {}, undefined, undefined, batchStepMeta({
        surface_dispatch: true,
        surface_operation_key: 'mail.send',
      })),
    ).resolves.toEqual({ ok: true });

    expect(inner).toHaveBeenCalledTimes(1);
    expect(inner.mock.calls[0]![4]).toEqual({
      step_id: 'step-1',
      recipe_id: 'recipe-1',
      surface_dispatch: true,
      surface_operation_key: 'mail.send',
    });
  });

  it('never claims a batch member on admit verdicts', async () => {
    resetCommitStore();
    const hooks = sessionHooks({ claimBatchMember: vi.fn(() => true) });
    const inner = vi.fn<GatewayInner>().mockResolvedValue({ ok: true });
    const executor = wrapWithCommitGateway(inner, deps({
      evaluateAdmission: () => admitDecision,
      resolveArgsForHash: () => resolvedArgs,
      sessionGrants: hooks,
      genCommitId: sequence(['commit-admit']),
      genIdempotencyKey: sequence(['idem-admit']),
      now: sequence([DISPATCHED_AT, COMPLETED_AT]),
    }));

    await expect(
      executor('mail.send', {}, undefined, undefined, batchStepMeta()),
    ).resolves.toEqual({ ok: true });

    expect(hooks.claimBatchMember).not.toHaveBeenCalled();
    expect(hooks.match).not.toHaveBeenCalled();
    expect(hooks.consume).not.toHaveBeenCalled();
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('re-holds when claimBatchMember throws', async () => {
    resetCommitStore();
    const hooks = sessionHooks({
      claimBatchMember: vi.fn(() => {
        throw new Error('claim failed');
      }),
    });
    const recordDispatchUse = vi.fn();
    const inner = vi.fn<GatewayInner>().mockResolvedValue({ ok: true });
    const executor = wrapWithCommitGateway(inner, deps({
      evaluateAdmission: () => askDecision(),
      resolveArgsForHash: () => resolvedArgs,
      sessionGrants: hooks,
      recordDispatchUse,
      genCommitId: sequence(['commit-throws']),
      genIdempotencyKey: sequence(['idem-throws']),
      now: sequence([DISPATCHED_AT]),
    }));

    await expectPreflightRequired(
      executor('mail.send', {}, undefined, undefined, batchStepMeta()),
    );

    expect(hooks.claimBatchMember).toHaveBeenCalledTimes(1);
    expect(recordDispatchUse).not.toHaveBeenCalled();
    expect(inner).not.toHaveBeenCalled();
    expect(await store.size()).toBe(0);
  });

  it('raises PreflightRequiredSignal with action hashes and args_preview', async () => {
    resetCommitStore();
    const expected = hashBasis();
    const preview = projectResolvedArgs(resolvedArgs);
    const executor = wrapWithCommitGateway(async () => ({ ok: true }), deps({
      evaluateAdmission: () => askDecision({ detail: 'needs owner review' }),
      resolveArgsForHash: () => resolvedArgs,
      genCommitId: sequence(['commit-signal']),
      genIdempotencyKey: sequence(['idem-signal']),
      now: sequence([DISPATCHED_AT]),
    }));

    const signal = await expectPreflightRequired(executor('mail.send', {}));

    expect(signal.tool_slug).toBe('mail.send');
    expect(signal.risk_tier).toBe('write');
    expect(signal.reason).toBe('needs owner review');
    expect(signal.arg_shape_hash).toBe(expected.arg_shape_hash);
    expect(signal.canonical_payload_hash).toBe(expected.canonical_payload_hash);
    expect(signal.args_preview).toEqual(preview);
  });

  it('omits args_preview for oversized resolved args while keeping hashes on the signal', async () => {
    resetCommitStore();
    const oversized = { body: 'x'.repeat(4_200), connection: 'gmail-primary' };
    const expected = hashBasis(oversized);
    const executor = wrapWithCommitGateway(async () => ({ ok: true }), deps({
      evaluateAdmission: () => askDecision(),
      resolveArgsForHash: () => oversized,
      genCommitId: sequence(['commit-big']),
      genIdempotencyKey: sequence(['idem-big']),
      now: sequence([DISPATCHED_AT]),
    }));

    const signal = await expectPreflightRequired(executor('mail.send', {}));

    expect(signal.arg_shape_hash).toBe(expected.arg_shape_hash);
    expect(signal.canonical_payload_hash).toBe(expected.canonical_payload_hash);
    expect(signal.args_preview).toBeUndefined();
  });
});
