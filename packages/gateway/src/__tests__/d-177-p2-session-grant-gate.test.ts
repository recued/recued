/** D-177 P2 session-grant commit Gateway tests. */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_DISPATCH_DEPTH,
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
  DispatchDepthExceededError,
  PreflightDeniedError,
  wrapWithCommitGateway,
  type CommitGatewayDeps,
  type CommitRunIdentity,
  type GatewayInner,
  type SessionGrantHooks,
  type SessionGrantGateCall,
} from '../commit-gateway.js';

const DISPATCHED_AT = 1_700_000_000_000;
const COMPLETED_AT = 1_700_000_000_125;

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

const denyDecision: Extract<AdmissionDecision, { verdict: 'deny' }> = {
  verdict: 'deny',
  code: 'tool_not_in_contract',
  detail: 'blocked by policy',
};

const admitDecision: AdmissionDecision = { verdict: 'admit' };

const resolvedWithConnection = {
  to: 'ada@example.com',
  connection: 'gmail-primary',
};
const resolvedWithoutConnection = {
  to: 'ada@example.com',
};

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
  resolved: Record<string, unknown> = resolvedWithConnection,
) => canonicalArgHash(projectResolvedArgs(resolved));

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

describe('wrapWithCommitGateway D-177 P2 session-grant ask branch', () => {
  it('grant-admits an ask, consumes once before other proceed-point effects, and stamps hashes', async () => {
    const { commitStore, written, order } = capturePendingStore();
    const expectedHashes = hashBasis();
    const inner = vi.fn<GatewayInner>().mockImplementation(async () => {
      order.push('inner');
      return { ok: true };
    });
    const sessionGrants: SessionGrantHooks = {
      match: vi.fn(() => 'grant-1'),
      consume: vi.fn(() => {
        order.push('consume');
        return true;
      }),
    };
    const recordDispatchUse = vi.fn(() => {
      order.push('use');
    });
    const executor = wrapWithCommitGateway(inner, deps({
      commitStore,
      evaluateAdmission: () => askDecision(),
      resolveArgsForHash: () => resolvedWithConnection,
      sessionGrants,
      recordDispatchUse,
      genCommitId: sequence(['commit-grant']),
      genIdempotencyKey: sequence(['idem-grant']),
      now: sequence([DISPATCHED_AT, COMPLETED_AT]),
    }));

    await expect(executor('mail.send', { to: '{{config.to}}' }))
      .resolves.toEqual({ ok: true });

    expect(sessionGrants.consume).toHaveBeenCalledTimes(1);
    // D-177 P5a — the proceed-point consume carries the envelope hash so
    // a `grant_mode: 'batch'` consumption can claim its member (exact
    // rows ignore it).
    expect(sessionGrants.consume).toHaveBeenCalledWith('grant-1', {
      canonical_payload_hash: expectedHashes.canonical_payload_hash,
    });
    expect(order).toEqual(['consume', 'use', 'pending', 'inner']);
    expect(recordDispatchUse).toHaveBeenCalledTimes(1);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      commit_id: 'commit-grant',
      arg_shape_hash: expectedHashes.arg_shape_hash,
      canonical_payload_hash: expectedHashes.canonical_payload_hash,
    });
  });

  it('passes the gateway-owned envelope fields to sessionGrants.match', async () => {
    const withConnectionHashes = hashBasis(resolvedWithConnection);
    const withoutConnectionHashes = hashBasis(resolvedWithoutConnection);
    const match = vi.fn<SessionGrantHooks['match']>(() => 'grant-1');
    const consume = vi.fn<SessionGrantHooks['consume']>(() => true);
    const executor = wrapWithCommitGateway(async () => ({ ok: true }), deps({
      evaluateAdmission: () => askDecision({ risk_tier: 'admin' }),
      resolveArgsForHash: (slug) =>
        slug === 'mail.no_connection'
          ? resolvedWithoutConnection
          : resolvedWithConnection,
      sessionGrants: { match, consume },
      genCommitId: sequence(['commit-surface', 'commit-forged', 'commit-no-conn']),
      genIdempotencyKey: sequence(['idem-surface', 'idem-forged', 'idem-no-conn']),
      now: sequence([
        2_000, 2_010,
        2_100, 2_110,
        2_200, 2_210,
      ]),
    }));

    await executor('mail.send', {}, undefined, undefined, {
      step_id: 'step-surface',
      recipe_id: 'recipe-1',
      surface_dispatch: true,
      surface_operation_key: 'mail.send',
    });
    await executor('mail.forged', {}, undefined, undefined, {
      step_id: 'step-forged',
      recipe_id: 'recipe-1',
      surface_operation_key: 'mail.delete',
    });
    await executor('mail.no_connection', {});

    expect(match).toHaveBeenCalledTimes(3);
    expect(match.mock.calls[0][0]).toEqual({
      channel: 'chat',
      actor: 'user_self',
      channel_session_id: 's',
      ingredient_slug: 'mail.send',
      operation_id: 'mail.send',
      connection_name: 'gmail-primary',
      risk_tier: 'admin',
      arg_shape_hash: withConnectionHashes.arg_shape_hash,
      canonical_payload_hash: withConnectionHashes.canonical_payload_hash,
    } satisfies SessionGrantGateCall);
    expect(match.mock.calls[1][0]).toEqual({
      channel: 'chat',
      actor: 'user_self',
      channel_session_id: 's',
      ingredient_slug: 'mail.forged',
      connection_name: 'gmail-primary',
      risk_tier: 'admin',
      arg_shape_hash: withConnectionHashes.arg_shape_hash,
      canonical_payload_hash: withConnectionHashes.canonical_payload_hash,
    } satisfies SessionGrantGateCall);
    expect(match.mock.calls[2][0]).toEqual({
      channel: 'chat',
      actor: 'user_self',
      channel_session_id: 's',
      ingredient_slug: 'mail.no_connection',
      risk_tier: 'admin',
      arg_shape_hash: withoutConnectionHashes.arg_shape_hash,
      canonical_payload_hash: withoutConnectionHashes.canonical_payload_hash,
    } satisfies SessionGrantGateCall);
    expect(consume).toHaveBeenCalledTimes(3);
  });

  it('holds when ask has no matching grant', async () => {
    const { commitStore, written } = capturePendingStore();
    const sessionGrants: SessionGrantHooks = {
      match: vi.fn(() => null),
      consume: vi.fn(() => true),
    };
    const recordDispatchUse = vi.fn();
    const inner = vi.fn<GatewayInner>().mockResolvedValue({ ok: true });
    const executor = wrapWithCommitGateway(inner, deps({
      commitStore,
      evaluateAdmission: () => askDecision(),
      resolveArgsForHash: () => resolvedWithConnection,
      sessionGrants,
      recordDispatchUse,
    }));

    const signal = await expectPreflightRequired(executor('mail.send', {}));

    expect(signal.tool_slug).toBe('mail.send');
    expect(sessionGrants.match).toHaveBeenCalledTimes(1);
    expect(sessionGrants.consume).not.toHaveBeenCalled();
    expect(written).toEqual([]);
    expect(recordDispatchUse).not.toHaveBeenCalled();
    expect(inner).not.toHaveBeenCalled();
  });

  it('treats a throwing match as no-match and holds', async () => {
    const sessionGrants: SessionGrantHooks = {
      match: vi.fn(() => {
        throw new Error('resolver unavailable');
      }),
      consume: vi.fn(() => true),
    };
    const executor = wrapWithCommitGateway(async () => ({ ok: true }), deps({
      evaluateAdmission: () => askDecision(),
      resolveArgsForHash: () => resolvedWithConnection,
      sessionGrants,
    }));

    await expectPreflightRequired(executor('mail.send', {}));

    expect(sessionGrants.match).toHaveBeenCalledTimes(1);
    expect(sessionGrants.consume).not.toHaveBeenCalled();
    expect(await store.size()).toBe(0);
  });

  it('holds without writing or dispatching when matched grant consumption returns false', async () => {
    const { commitStore, written } = capturePendingStore();
    const sessionGrants: SessionGrantHooks = {
      match: vi.fn(() => 'grant-1'),
      consume: vi.fn(() => false),
    };
    const recordDispatchUse = vi.fn();
    const inner = vi.fn<GatewayInner>().mockResolvedValue({ ok: true });
    const executor = wrapWithCommitGateway(inner, deps({
      commitStore,
      evaluateAdmission: () => askDecision(),
      resolveArgsForHash: () => resolvedWithConnection,
      sessionGrants,
      recordDispatchUse,
      genCommitId: sequence(['commit-consume-false']),
      genIdempotencyKey: sequence(['idem-consume-false']),
      now: sequence([DISPATCHED_AT]),
    }));

    await expectPreflightRequired(executor('mail.send', {}));

    expect(sessionGrants.consume).toHaveBeenCalledTimes(1);
    expect(written).toEqual([]);
    expect(recordDispatchUse).not.toHaveBeenCalled();
    expect(inner).not.toHaveBeenCalled();
    expect(await store.size()).toBe(0);
  });

  it('holds without writing or dispatching when matched grant consumption throws', async () => {
    const { commitStore, written } = capturePendingStore();
    const sessionGrants: SessionGrantHooks = {
      match: vi.fn(() => 'grant-1'),
      consume: vi.fn(() => {
        throw new Error('consume failed');
      }),
    };
    const recordDispatchUse = vi.fn();
    const inner = vi.fn<GatewayInner>().mockResolvedValue({ ok: true });
    const executor = wrapWithCommitGateway(inner, deps({
      commitStore,
      evaluateAdmission: () => askDecision(),
      resolveArgsForHash: () => resolvedWithConnection,
      sessionGrants,
      recordDispatchUse,
      genCommitId: sequence(['commit-consume-throws']),
      genIdempotencyKey: sequence(['idem-consume-throws']),
      now: sequence([DISPATCHED_AT]),
    }));

    await expectPreflightRequired(executor('mail.send', {}));

    expect(sessionGrants.consume).toHaveBeenCalledTimes(1);
    expect(written).toEqual([]);
    expect(recordDispatchUse).not.toHaveBeenCalled();
    expect(inner).not.toHaveBeenCalled();
    expect(await store.size()).toBe(0);
  });
});

describe('wrapWithCommitGateway D-177 P2 non-grant paths', () => {
  it('never consults grants on deny verdicts', async () => {
    const sessionGrants: SessionGrantHooks = {
      match: vi.fn(() => 'grant-1'),
      consume: vi.fn(() => true),
    };
    const executor = wrapWithCommitGateway(async () => ({ ok: true }), deps({
      evaluateAdmission: () => denyDecision,
      resolveArgsForHash: () => resolvedWithConnection,
      sessionGrants,
    }));

    await expect(executor('mail.send', {})).rejects.toBeInstanceOf(PreflightDeniedError);

    expect(sessionGrants.match).not.toHaveBeenCalled();
    expect(sessionGrants.consume).not.toHaveBeenCalled();
    expect(await store.size()).toBe(0);
  });

  it('never consults or consumes grants on admit verdicts', async () => {
    const sessionGrants: SessionGrantHooks = {
      match: vi.fn(() => 'grant-1'),
      consume: vi.fn(() => true),
    };
    const inner = vi.fn<GatewayInner>().mockResolvedValue({ ok: true });
    const executor = wrapWithCommitGateway(inner, deps({
      evaluateAdmission: () => admitDecision,
      resolveArgsForHash: () => resolvedWithConnection,
      sessionGrants,
      genCommitId: sequence(['commit-admit']),
      genIdempotencyKey: sequence(['idem-admit']),
      now: sequence([DISPATCHED_AT, COMPLETED_AT]),
    }));

    await expect(executor('mail.send', {})).resolves.toEqual({ ok: true });

    expect(sessionGrants.match).not.toHaveBeenCalled();
    expect(sessionGrants.consume).not.toHaveBeenCalled();
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('treats resume-approved ask as upstream human approval, not a session grant', async () => {
    const sessionGrants: SessionGrantHooks = {
      match: vi.fn(() => 'grant-1'),
      consume: vi.fn(() => true),
    };
    const inner = vi.fn<GatewayInner>().mockResolvedValue({ ok: true });
    const executor = wrapWithCommitGateway(inner, deps({
      evaluateAdmission: () => askDecision(),
      resolveArgsForHash: () => resolvedWithConnection,
      sessionGrants,
      genCommitId: sequence(['commit-resume']),
      genIdempotencyKey: sequence(['idem-resume']),
      now: sequence([DISPATCHED_AT, COMPLETED_AT]),
    }));

    await expect(executor('mail.send', {}, undefined, undefined, {
      step_id: 'step-1',
      recipe_id: 'recipe-1',
      preflight_admitted: true,
      preflight_approved_target: { ingredient_slug: 'mail.send' },
    })).resolves.toEqual({ ok: true });

    expect(sessionGrants.match).not.toHaveBeenCalled();
    expect(sessionGrants.consume).not.toHaveBeenCalled();
    expect(inner).toHaveBeenCalledTimes(1);
    expect(inner.mock.calls[0][4]).toEqual({
      step_id: 'step-1',
      recipe_id: 'recipe-1',
    });
  });

  it('holds identity-less ask dispatches and never runs session-grant lookup', async () => {
    const sessionGrants: SessionGrantHooks = {
      match: vi.fn(() => 'grant-1'),
      consume: vi.fn(() => true),
    };
    const inner = vi.fn<GatewayInner>().mockResolvedValue({ ok: true });
    const executor = wrapWithCommitGateway(inner, deps({
      identity: undefined,
      evaluateAdmission: () => askDecision(),
      resolveArgsForHash: () => resolvedWithConnection,
      sessionGrants,
    }));

    await expectPreflightRequired(executor('mail.send', {}));

    expect(sessionGrants.match).not.toHaveBeenCalled();
    expect(sessionGrants.consume).not.toHaveBeenCalled();
    expect(inner).not.toHaveBeenCalled();
    expect(await store.size()).toBe(0);
  });

  it('holds asks without grant lookup when action hashes are unavailable', async () => {
    const cases: ReadonlyArray<{
      name: string;
      resolveArgsForHash?: CommitGatewayDeps['resolveArgsForHash'];
    }> = [
      { name: 'resolver absent' },
      { name: 'resolver returns undefined', resolveArgsForHash: () => undefined },
      {
        name: 'resolver throws',
        resolveArgsForHash: () => {
          throw new Error('cannot resolve');
        },
      },
    ];

    for (const testCase of cases) {
      const sessionGrants: SessionGrantHooks = {
        match: vi.fn(() => 'grant-1'),
        consume: vi.fn(() => true),
      };
      const executor = wrapWithCommitGateway(async () => ({ ok: true }), deps({
        evaluateAdmission: () => askDecision(),
        resolveArgsForHash: testCase.resolveArgsForHash,
        sessionGrants,
      }));

      await expectPreflightRequired(executor(`mail.${testCase.name}`, {}));

      expect(sessionGrants.match, testCase.name).not.toHaveBeenCalled();
      expect(sessionGrants.consume, testCase.name).not.toHaveBeenCalled();
      expect(await store.size(), testCase.name).toBe(0);
    }
  });

  it('refuses depth-exceeded dispatches after match but before consume', async () => {
    const sessionGrants: SessionGrantHooks = {
      match: vi.fn(() => 'grant-1'),
      consume: vi.fn(() => true),
    };
    const executor = wrapWithCommitGateway(async () => ({ ok: true }), deps({
      identity: identity({ dispatch_depth: MAX_DISPATCH_DEPTH + 1 }),
      evaluateAdmission: () => askDecision(),
      resolveArgsForHash: () => resolvedWithConnection,
      sessionGrants,
      genCommitId: sequence(['commit-too-deep']),
      genIdempotencyKey: sequence(['idem-too-deep']),
      now: sequence([DISPATCHED_AT]),
    }));

    await expect(executor('mail.send', {}))
      .rejects.toBeInstanceOf(DispatchDepthExceededError);

    expect(sessionGrants.match).toHaveBeenCalledTimes(1);
    expect(sessionGrants.consume).not.toHaveBeenCalled();
    expect(await store.size()).toBe(0);
  });

  it('holds asks exactly as before when sessionGrants is not wired', async () => {
    const recordDispatchUse = vi.fn();
    const inner = vi.fn<GatewayInner>().mockResolvedValue({ ok: true });
    const executor = wrapWithCommitGateway(inner, deps({
      evaluateAdmission: () => askDecision(),
      resolveArgsForHash: () => resolvedWithConnection,
      recordDispatchUse,
    }));

    await expectPreflightRequired(executor('mail.send', {}));

    expect(recordDispatchUse).not.toHaveBeenCalled();
    expect(inner).not.toHaveBeenCalled();
    expect(await store.size()).toBe(0);
  });

  it('still stamps action hashes on plain admit dispatches', async () => {
    const { commitStore, written } = capturePendingStore();
    const expected = hashBasis(resolvedWithConnection);
    const executor = wrapWithCommitGateway(async () => ({ ok: true }), deps({
      commitStore,
      evaluateAdmission: () => admitDecision,
      resolveArgsForHash: () => resolvedWithConnection,
      genCommitId: sequence(['commit-hashed-admit']),
      genIdempotencyKey: sequence(['idem-hashed-admit']),
      now: sequence([DISPATCHED_AT, COMPLETED_AT]),
    }));

    await expect(executor('mail.send', { to: '{{config.to}}' }))
      .resolves.toEqual({ ok: true });

    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      arg_shape_hash: expected.arg_shape_hash,
      canonical_payload_hash: expected.canonical_payload_hash,
    });
  });
});
