/** D-177 N.11 rule 5 slice D — commit Gateway scoped-grant wiring. */

import { beforeEach, describe, expect, it, vi } from 'vitest';

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
} from '@recued/storage';

import {
  wrapWithCommitGateway,
  type CommitGatewayDeps,
  type CommitRunIdentity,
  type GatewayInner,
  type SessionGrantHooks,
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

const resolvedEmailArgs = {
  connection: 'gmail-primary',
  to: '<ADA@Example.COM>',
  body: { cc: ['grace@example.com'] },
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

const hashBasis = (
  resolved: Record<string, unknown> = resolvedEmailArgs,
) => canonicalArgHash(projectResolvedArgs(resolved));

const surfaceMeta = () => ({
  step_id: 'step-1',
  recipe_id: 'recipe-1',
  surface_dispatch: true,
  surface_operation_key: 'send',
});

const sessionHooks = (
  overrides: Partial<SessionGrantHooks> = {},
): SessionGrantHooks => ({
  match: vi.fn(() => null),
  consume: vi.fn(() => true),
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

describe('wrapWithCommitGateway D-177 rule-5 slice-D scoped destinations', () => {
  it('threads extracted destination_emails into sessionGrants.match on ask verdicts', async () => {
    const expectedHashes = hashBasis();
    const hooks = sessionHooks();
    const getScopedAuthorityPaths = vi.fn(() => ['connection', 'to', 'body.cc']);
    const executor = wrapWithCommitGateway(async () => ({ ok: true }), deps({
      evaluateAdmission: () => askDecision(),
      resolveArgsForHash: () => resolvedEmailArgs,
      getScopedAuthorityPaths,
      sessionGrants: hooks,
    }));

    await expectPreflightRequired(
      executor('mail.send', { to: '{{config.to}}' }, undefined, undefined, surfaceMeta()),
    );

    expect(getScopedAuthorityPaths).toHaveBeenCalledWith('mail.send', 'send');
    expect(hooks.match).toHaveBeenCalledTimes(1);
    expect(hooks.match).toHaveBeenCalledWith({
      channel: 'chat',
      actor: 'user_self',
      channel_session_id: 's',
      ingredient_slug: 'mail.send',
      operation_id: 'send',
      connection_name: 'gmail-primary',
      risk_tier: 'write',
      arg_shape_hash: expectedHashes.arg_shape_hash,
      canonical_payload_hash: expectedHashes.canonical_payload_hash,
      destination_emails: ['ada@example.com', 'grace@example.com'],
    });
    expect(hooks.consume).not.toHaveBeenCalled();
  });

  it('passes the same destination_emails into consume after a successful match', async () => {
    const expectedHashes = hashBasis();
    const hooks = sessionHooks({
      match: vi.fn(() => 'grant-1'),
      consume: vi.fn(() => true),
    });
    const inner = vi.fn<GatewayInner>().mockResolvedValue({ ok: true });
    const executor = wrapWithCommitGateway(inner, deps({
      evaluateAdmission: () => askDecision(),
      resolveArgsForHash: () => resolvedEmailArgs,
      getScopedAuthorityPaths: () => ['connection', 'to', 'body.cc'],
      sessionGrants: hooks,
      genCommitId: sequence(['commit-scoped']),
      genIdempotencyKey: sequence(['idem-scoped']),
      now: sequence([DISPATCHED_AT, COMPLETED_AT]),
    }));

    await expect(
      executor('mail.send', { to: '{{config.to}}' }, undefined, undefined, surfaceMeta()),
    ).resolves.toEqual({ ok: true });

    expect(hooks.match).toHaveBeenCalledTimes(1);
    expect(vi.mocked(hooks.match).mock.calls[0]![0]).toMatchObject({
      destination_emails: ['ada@example.com', 'grace@example.com'],
    });
    expect(hooks.consume).toHaveBeenCalledTimes(1);
    expect(hooks.consume).toHaveBeenCalledWith('grant-1', {
      canonical_payload_hash: expectedHashes.canonical_payload_hash,
      destination_emails: ['ada@example.com', 'grace@example.com'],
    });
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('omits destination_emails when a non-email authority value fails extraction', async () => {
    const hooks = sessionHooks();
    const executor = wrapWithCommitGateway(async () => ({ ok: true }), deps({
      evaluateAdmission: () => askDecision(),
      resolveArgsForHash: () => ({
        connection: 'gmail-primary',
        to: 'msg_123',
      }),
      getScopedAuthorityPaths: () => ['connection', 'to'],
      sessionGrants: hooks,
    }));

    await expectPreflightRequired(
      executor('mail.send', {}, undefined, undefined, surfaceMeta()),
    );

    expect(hooks.match).toHaveBeenCalledTimes(1);
    expect(vi.mocked(hooks.match).mock.calls[0]![0])
      .not.toHaveProperty('destination_emails');
  });

  it('omits destination_emails when getScopedAuthorityPaths is absent', async () => {
    const hooks = sessionHooks();
    const executor = wrapWithCommitGateway(async () => ({ ok: true }), deps({
      evaluateAdmission: () => askDecision(),
      resolveArgsForHash: () => resolvedEmailArgs,
      sessionGrants: hooks,
    }));

    await expectPreflightRequired(
      executor('mail.send', {}, undefined, undefined, surfaceMeta()),
    );

    expect(hooks.match).toHaveBeenCalledTimes(1);
    expect(vi.mocked(hooks.match).mock.calls[0]![0])
      .not.toHaveProperty('destination_emails');
  });
});
