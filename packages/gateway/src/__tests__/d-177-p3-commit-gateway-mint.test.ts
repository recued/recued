/** D-177 P3 session-grant mint branch tests. */

import {
  PreflightRequiredSignal,
  canonicalArgHash,
  isPreflightRequiredSignal,
  projectResolvedArgs,
  type AdmissionDecision,
  type Commit,
  type ExecutionSource,
  type StepMeta,
} from '@recued/contracts';
import {
  wrapWithCommitGateway,
  type CommitGatewayDeps,
  type CommitRunIdentity,
  type GatewayInner,
  type SessionGrantHooks,
  type SessionGrantMintGateCall,
} from '@recued/gateway';
import {
  createCommitStore,
  createInMemoryCollection,
  type Collection,
  type CommitStore,
  type PendingCommitInput,
} from '@recued/storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const DISPATCHED_AT = 1_700_000_000_000;
const COMPLETED_AT = DISPATCHED_AT + 100;

const source = (): ExecutionSource => ({
  channel: 'chat',
  actor: 'user_self',
  chat_session_id: 'chat-1',
  user_id: 'user-1',
});

const identity = (
  overrides: Partial<CommitRunIdentity> = {},
): CommitRunIdentity => ({
  request_id: 'run-1',
  source: source(),
  channel_session_id: 'chat-1',
  correlation_id: 'corr-1',
  dispatch_depth: 0,
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

const resolvedArgs = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  to: 'ada@example.test',
  body: 'hello',
  ...overrides,
});

const resumeMeta = (
  overrides: Partial<StepMeta> = {},
): StepMeta => ({
  step_id: 'step-1',
  recipe_id: 'recipe-1',
  preflight_admitted: true,
  preflight_approved_target: { ingredient_slug: 'mail.send' },
  preflight_session_grant: {
    ttl_ms: 3_600_000,
    max_uses: 5,
    risk_tier: 'write',
  },
  ...overrides,
});

let backing: Collection<Commit>;
let store: CommitStore;

beforeEach(() => {
  backing = createInMemoryCollection<Commit>();
  store = createCommitStore(backing);
});

const deps = (
  overrides: Partial<CommitGatewayDeps> = {},
): CommitGatewayDeps => ({
  commitStore: store,
  identity: identity(),
  getIngredientCategory: () => 'action',
  genCommitId: sequence(['commit-1']),
  genIdempotencyKey: sequence(['idem-1']),
  now: sequence([DISPATCHED_AT, COMPLETED_AT]),
  ...overrides,
});

const capturePendingStore = (): {
  commitStore: CommitStore;
  written: PendingCommitInput[];
} => {
  const written: PendingCommitInput[] = [];
  return {
    written,
    commitStore: {
      ...store,
      writePending: async (pending) => {
        written.push(pending);
        await store.writePending(pending);
      },
    },
  };
};

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

describe('wrapWithCommitGateway D-177 P3 session-grant mint branch', () => {
  it('mints once from a resume-admitted ask dispatch and strips private markers', async () => {
    const { commitStore, written } = capturePendingStore();
    const expectedHashes = canonicalArgHash(projectResolvedArgs(resolvedArgs()));
    const inner = vi.fn<GatewayInner>().mockResolvedValue({ ok: true });
    const mint = vi.fn<NonNullable<SessionGrantHooks['mint']>>();
    const match = vi.fn<SessionGrantHooks['match']>(() => null);
    const sessionGrants: SessionGrantHooks = {
      match,
      consume: vi.fn(() => true),
      mint,
    };
    const executor = wrapWithCommitGateway(inner, deps({
      commitStore,
      evaluateAdmission: () => askDecision(),
      resolveArgsForHash: () => resolvedArgs(),
      sessionGrants,
    }));

    await expect(executor('mail.send', { to: '{{config.to}}' }, undefined, undefined, resumeMeta()))
      .resolves.toEqual({ ok: true });

    expect(mint).toHaveBeenCalledTimes(1);
    expect(mint).toHaveBeenCalledWith({
      channel: 'chat',
      actor: 'user_self',
      channel_session_id: 'chat-1',
      ingredient_slug: 'mail.send',
      risk_tier: 'write',
      arg_shape_hash: expectedHashes.arg_shape_hash,
      canonical_payload_hash: expectedHashes.canonical_payload_hash,
      ttl_ms: 3_600_000,
      max_uses: 5,
      approved_action_ref: 'run-1',
    } satisfies SessionGrantMintGateCall);
    expect(match).not.toHaveBeenCalled();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      arg_shape_hash: expectedHashes.arg_shape_hash,
      canonical_payload_hash: expectedHashes.canonical_payload_hash,
    });
    expect(inner).toHaveBeenCalledTimes(1);
    expect(inner.mock.calls[0]![4]).toEqual({
      step_id: 'step-1',
      recipe_id: 'recipe-1',
    });
    expect(inner.mock.calls[0]![4]).not.toHaveProperty('preflight_admitted');
    expect(inner.mock.calls[0]![4]).not.toHaveProperty('preflight_approved_target');
    expect(inner.mock.calls[0]![4]).not.toHaveProperty('preflight_session_grant');
  });

  it('skips mint on tier drift while still admitting the resumed dispatch', async () => {
    const inner = vi.fn<GatewayInner>().mockResolvedValue({ ok: true });
    const mint = vi.fn<NonNullable<SessionGrantHooks['mint']>>();
    const executor = wrapWithCommitGateway(inner, deps({
      evaluateAdmission: () => askDecision({ risk_tier: 'admin' }),
      resolveArgsForHash: () => resolvedArgs(),
      sessionGrants: {
        match: vi.fn(() => null),
        consume: vi.fn(() => true),
        mint,
      },
    }));

    await expect(executor('mail.send', {}, undefined, undefined, resumeMeta()))
      .resolves.toEqual({ ok: true });

    expect(mint).not.toHaveBeenCalled();
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('does not mint on a plain-approve resume marker', async () => {
    const mint = vi.fn<NonNullable<SessionGrantHooks['mint']>>();
    const executor = wrapWithCommitGateway(vi.fn<GatewayInner>().mockResolvedValue({ ok: true }), deps({
      evaluateAdmission: () => askDecision(),
      resolveArgsForHash: () => resolvedArgs(),
      sessionGrants: {
        match: vi.fn(() => null),
        consume: vi.fn(() => true),
        mint,
      },
    }));

    await expect(executor(
      'mail.send',
      {},
      undefined,
      undefined,
      resumeMeta({ preflight_session_grant: undefined }),
    )).resolves.toEqual({ ok: true });

    expect(mint).not.toHaveBeenCalled();
  });

  it('raises a fresh ask on non-resumed dispatches with no matching grant', async () => {
    const mint = vi.fn<NonNullable<SessionGrantHooks['mint']>>();
    const match = vi.fn<SessionGrantHooks['match']>(() => null);
    const inner = vi.fn<GatewayInner>().mockResolvedValue({ ok: true });
    const executor = wrapWithCommitGateway(inner, deps({
      evaluateAdmission: () => askDecision(),
      resolveArgsForHash: () => resolvedArgs(),
      sessionGrants: {
        match,
        consume: vi.fn(() => true),
        mint,
      },
    }));

    const signal = await expectPreflightRequired(executor('mail.send', {}));

    expect(signal.tool_slug).toBe('mail.send');
    expect(match).toHaveBeenCalledTimes(1);
    expect(mint).not.toHaveBeenCalled();
    expect(inner).not.toHaveBeenCalled();
  });

  it('swallows mint hook failures and dispatches the approved call', async () => {
    const inner = vi.fn<GatewayInner>().mockResolvedValue({ ok: true });
    const mint = vi.fn<NonNullable<SessionGrantHooks['mint']>>(() => {
      throw new Error('mint failed');
    });
    const executor = wrapWithCommitGateway(inner, deps({
      evaluateAdmission: () => askDecision(),
      resolveArgsForHash: () => resolvedArgs(),
      sessionGrants: {
        match: vi.fn(() => null),
        consume: vi.fn(() => true),
        mint,
      },
    }));

    await expect(executor('mail.send', {}, undefined, undefined, resumeMeta()))
      .resolves.toEqual({ ok: true });

    expect(mint).toHaveBeenCalledTimes(1);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('does not mint when action hashes are unavailable', async () => {
    const mint = vi.fn<NonNullable<SessionGrantHooks['mint']>>();
    const inner = vi.fn<GatewayInner>().mockResolvedValue({ ok: true });
    const executor = wrapWithCommitGateway(inner, deps({
      evaluateAdmission: () => askDecision(),
      sessionGrants: {
        match: vi.fn(() => null),
        consume: vi.fn(() => true),
        mint,
      },
    }));

    await expect(executor('mail.send', {}, undefined, undefined, resumeMeta()))
      .resolves.toEqual({ ok: true });

    expect(mint).not.toHaveBeenCalled();
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('tolerates P2-shaped session grant hooks with no mint hook', async () => {
    const inner = vi.fn<GatewayInner>().mockResolvedValue({ ok: true });
    const sessionGrants: SessionGrantHooks = {
      match: vi.fn(() => null),
      consume: vi.fn(() => true),
    };
    const executor = wrapWithCommitGateway(inner, deps({
      evaluateAdmission: () => askDecision(),
      resolveArgsForHash: () => resolvedArgs(),
      sessionGrants,
    }));

    await expect(executor('mail.send', {}, undefined, undefined, resumeMeta()))
      .resolves.toEqual({ ok: true });

    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('forwards surface operation keys only from trusted surface dispatches', async () => {
    const mint = vi.fn<NonNullable<SessionGrantHooks['mint']>>();
    const executor = wrapWithCommitGateway(vi.fn<GatewayInner>().mockResolvedValue({ ok: true }), deps({
      evaluateAdmission: () => askDecision(),
      resolveArgsForHash: () => resolvedArgs(),
      sessionGrants: {
        match: vi.fn(() => null),
        consume: vi.fn(() => true),
        mint,
      },
      genCommitId: sequence(['commit-surface', 'commit-forged']),
      genIdempotencyKey: sequence(['idem-surface', 'idem-forged']),
      now: sequence([DISPATCHED_AT, COMPLETED_AT, DISPATCHED_AT + 1, COMPLETED_AT + 1]),
    }));

    await executor('mail.send', {}, undefined, undefined, resumeMeta({
      surface_dispatch: true,
      surface_operation_key: 'deal.read',
    }));
    await executor('mail.send', {}, undefined, undefined, resumeMeta({
      surface_operation_key: 'deal.read',
    }));

    expect(mint).toHaveBeenCalledTimes(2);
    expect(mint.mock.calls[0]![0].operation_id).toBe('deal.read');
    expect(mint.mock.calls[1]![0]).not.toHaveProperty('operation_id');
  });

  it('pins the resolved connection name on the mint context', async () => {
    const mint = vi.fn<NonNullable<SessionGrantHooks['mint']>>();
    const executor = wrapWithCommitGateway(vi.fn<GatewayInner>().mockResolvedValue({ ok: true }), deps({
      evaluateAdmission: () => askDecision(),
      resolveArgsForHash: () => resolvedArgs({ connection: 'gmail-primary' }),
      sessionGrants: {
        match: vi.fn(() => null),
        consume: vi.fn(() => true),
        mint,
      },
    }));

    await executor('mail.send', {}, undefined, undefined, resumeMeta());

    expect(mint).toHaveBeenCalledTimes(1);
    expect(mint.mock.calls[0]![0].connection_name).toBe('gmail-primary');
  });
});
