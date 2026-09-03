/** D-145 engine-wiring slice 3b.2 - commit Gateway tests. */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_DISPATCH_DEPTH,
  canonicalArgHash,
  projectResolvedArgs,
  type Commit,
  type ContractSnapshot,
  type ExecutionSource,
  type IngredientCategory,
  type StepMeta,
  type StepOptions,
  type TempFileRef,
} from '@recued/contracts';
import {
  createCommitStore,
  createInMemoryCollection,
  type Collection,
  type CommitOutcome,
  type CommitStore,
  type PendingCommitInput,
} from '@recued/storage';

import {
  DispatchDepthExceededError,
  liftExecutor,
  wrapWithCommitGateway,
  type CommitGatewayDeps,
  type CommitRunIdentity,
  type GatewayExecutor,
  type GatewayInner,
} from '../commit-gateway.js';

const DISPATCHED_AT = 1_700_000_000_000;
const COMPLETED_AT = 1_700_000_000_125;

const source = (): ExecutionSource => ({
  channel: 'chat',
  actor: 'user_self',
  chat_session_id: 'chat-1',
  user_id: 'user-1',
});

const contractedSource = (): ExecutionSource => ({
  channel: 'mcp',
  actor: 'contracted_user',
  agent_id: 'agent-1',
  tool_call_id: 'tool-call-1',
  mcp_token_id: 'mcp-token-1',
  contract_id: 'contract-1',
});

const contractSnapshot = (): ContractSnapshot => ({
  contract_id: 'contract-1',
  contract_version: 'v3',
  allowed_tools: ['calendar.write', 'mail.send'],
  approval_required: ['destructive'],
  scope_restrictions: ['data.calendar.read', 'connection.mail.write'],
  resolved_at: DISPATCHED_AT - 100,
});

const identity = (
  overrides: Partial<CommitRunIdentity> = {},
): CommitRunIdentity => ({
  request_id: 'request-1',
  source: source(),
  channel_session_id: 'chat:chat-1',
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

const expectNoActionIdentity = (pending: PendingCommitInput): void => {
  expect(pending).not.toHaveProperty('arg_shape_hash');
  expect(pending).not.toHaveProperty('canonical_payload_hash');
};

describe('wrapWithCommitGateway', () => {
  it('passes through without writing when identity is absent', async () => {
    const input = { message: 'hello' };
    const output = { ok: true };
    const calls: Array<Parameters<GatewayInner>> = [];
    const inner: GatewayInner = async (...args) => {
      calls.push(args);
      return output;
    };

    const executor = wrapWithCommitGateway(inner, deps({ identity: undefined }));

    await expect(executor(
      'mail.send',
      input,
      { previous: 'value' },
      { cache: 'fresh' },
      { step_id: 'step-1', recipe_id: 'recipe-1' },
    )).resolves.toBe(output);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      'mail.send',
      input,
      { previous: 'value' },
      { cache: 'fresh' },
      { step_id: 'step-1', recipe_id: 'recipe-1' },
      { cached: false },
    ]);
    expect(await store.size()).toBe(0);
  });

  it('writes a pending commit before dispatch and records a succeeded outcome', async () => {
    const input = { calendar_id: 'primary', title: 'Review' };
    const output = { event_id: 'evt-1' };
    const runIdentity = identity({
      source: source(),
      channel_session_id: 'chat:chat-1',
      correlation_id: 'corr-happy',
      request_id: 'request-happy',
      dispatch_depth: 7,
    });
    const inner: GatewayInner = async (slug, args, stepOutput, stepOptions, stepMeta, probe) => {
      expect(slug).toBe('calendar.create');
      expect(args).toBe(input);
      expect(stepOutput).toEqual({ previous: 'done' });
      expect(stepOptions).toEqual({ cache: 'acceptable' });
      expect(stepMeta).toEqual({ step_id: 'step-create', recipe_id: 'recipe-1' });
      expect(probe.cached).toBe(false);

      expect(await store.get('commit-happy')).toEqual({
        commit_id: 'commit-happy',
        kind: 'query',
        ingredient: 'calendar.create',
        tool: 'calendar.create',
        args: input,
        source: runIdentity.source,
        channel_session_id: 'chat:chat-1',
        correlation_id: 'corr-happy',
        request_id: 'request-happy',
        dispatch_depth: 7,
        idempotency_key: 'idem-happy',
        dispatched_at: DISPATCHED_AT,
        status: 'pending',
      });
      return output;
    };

    const executor = wrapWithCommitGateway(inner, deps({
      identity: runIdentity,
      getIngredientCategory: (slug) => {
        expect(slug).toBe('calendar.create');
        return 'data';
      },
      genCommitId: sequence(['commit-happy']),
      genIdempotencyKey: sequence(['idem-happy']),
      now: sequence([DISPATCHED_AT, COMPLETED_AT]),
    }));

    await expect(executor(
      'calendar.create',
      input,
      { previous: 'done' },
      { cache: 'acceptable' },
      { step_id: 'step-create', recipe_id: 'recipe-1' },
    )).resolves.toBe(output);

    expect(await store.get('commit-happy')).toEqual({
      commit_id: 'commit-happy',
      kind: 'query',
      ingredient: 'calendar.create',
      tool: 'calendar.create',
      args: input,
      source: runIdentity.source,
      channel_session_id: 'chat:chat-1',
      correlation_id: 'corr-happy',
      request_id: 'request-happy',
      dispatch_depth: 7,
      idempotency_key: 'idem-happy',
      dispatched_at: DISPATCHED_AT,
      status: 'succeeded',
      output,
      completed_at: COMPLETED_AT,
      duration_ms: 125,
    });
  });

  it('OMITS commit output for a response_capture dispatch (__rc_capture) — bytes never persist (slice 3 / Codex CRITICAL)', async () => {
    // The storage-gdrive file.download surface dispatch carries the engine-owned
    // __rc_capture wire key and returns the raw file body (base64). That body
    // must never land in the durable commit log — the catalog gateway returns a
    // file_ref instead. The commit record is still written (status succeeded),
    // only `output` is omitted.
    const input = { method: 'GET', path: '/files/abc', __rc_capture: '1' };
    const inner: GatewayInner = async () => ({ bytes_b64: 'QUJD', mime_type: 'application/pdf', filename: 'x.pdf' });
    const executor = wrapWithCommitGateway(inner, deps({
      identity: identity({ request_id: 'rc-req', correlation_id: 'rc-corr' }),
      genCommitId: sequence(['commit-rc']),
      genIdempotencyKey: sequence(['idem-rc']),
      now: sequence([DISPATCHED_AT, COMPLETED_AT]),
    }));

    await executor('google-drive', input, {}, {}, { step_id: 's', recipe_id: 'r' });

    const commit = await store.get('commit-rc');
    expect(commit?.status).toBe('succeeded');
    expect(commit).not.toHaveProperty('output');
  });

  it('redacts run-scoped temp paths from durable commit output without changing the live result', async () => {
    const temp: TempFileRef = {
      backing: 'temp',
      path: '/tmp/recued-run-scratch/run-1/op-secret/rendered.md',
      mime_type: 'text/markdown',
      filename: 'rendered.md',
    };
    const output = {
      file_ref: temp,
      hashes: { template: 'a'.repeat(64) },
      nested: [temp],
      malformed_temp: { backing: 'temp', path: '/tmp/also-secret' },
    };
    const executor = wrapWithCommitGateway(async () => output, deps({
      identity: identity({ request_id: 'temp-req', correlation_id: 'temp-corr' }),
      genCommitId: sequence(['commit-temp']),
      genIdempotencyKey: sequence(['idem-temp']),
      now: sequence([DISPATCHED_AT, COMPLETED_AT]),
    }));

    await expect(executor('file-render-markdown-template', {})).resolves.toBe(output);

    const commit = await store.get('commit-temp');
    expect(commit?.output).toEqual({
      file_ref: {
        backing: 'temp',
        ephemeral: true,
        mime_type: 'text/markdown',
        filename: 'rendered.md',
      },
      hashes: output.hashes,
      nested: [{
        backing: 'temp',
        ephemeral: true,
        mime_type: 'text/markdown',
        filename: 'rendered.md',
      }],
      malformed_temp: {
        backing: 'temp',
        ephemeral: true,
        malformed: true,
      },
    });
    expect(JSON.stringify(commit)).not.toContain(temp.path);
    expect(JSON.stringify(commit)).not.toContain('/tmp/also-secret');
  });

  it('omits uninspectable successful output evidence without changing the live result', async () => {
    const output = Object.defineProperty({}, 'hostile', {
      enumerable: true,
      get: () => { throw new Error('getter must not reverse successful dispatch'); },
    });
    const executor = wrapWithCommitGateway(async () => output, deps({
      identity: identity({ request_id: 'hostile-req', correlation_id: 'hostile-corr' }),
      genCommitId: sequence(['commit-hostile']),
      genIdempotencyKey: sequence(['idem-hostile']),
      now: sequence([DISPATCHED_AT, COMPLETED_AT]),
    }));

    await expect(executor('file-render-markdown-template', {})).resolves.toBe(output);
    await expect(store.get('commit-hostile')).resolves.toMatchObject({
      status: 'succeeded',
      output: { omitted: true, reason: 'commit_output_sanitization_failed' },
    });
  });

  it('neutralizes output toJSON hooks that could reintroduce a temp path at storage', async () => {
    const secretPath = '/tmp/recued-run-scratch/run-1/op-secret/from-to-json.md';
    const output = Object.create({
      toJSON: () => ({ backing: 'temp', path: secretPath }),
    }) as Record<string, unknown>;
    output.ok = true;
    const executor = wrapWithCommitGateway(async () => output, deps({
      identity: identity({ request_id: 'to-json-req', correlation_id: 'to-json-corr' }),
      genCommitId: sequence(['commit-to-json']),
      genIdempotencyKey: sequence(['idem-to-json']),
      now: sequence([DISPATCHED_AT, COMPLETED_AT]),
    }));

    await expect(executor('file-render-markdown-template', {})).resolves.toBe(output);
    const commit = await store.get('commit-to-json');
    expect(commit?.output).toEqual({ ok: true });
    expect(JSON.stringify(commit)).not.toContain(secretPath);
  });

  it('includes contract and cognition fields only when identity carries them', async () => {
    const inner: GatewayInner = async () => ({ ok: true });
    const withoutOptional = wrapWithCommitGateway(inner, deps({
      identity: identity(),
      genCommitId: sequence(['commit-without-optional']),
      genIdempotencyKey: sequence(['idem-without-optional']),
      now: sequence([10, 20]),
    }));
    const snapshot = contractSnapshot();
    const withOptional = wrapWithCommitGateway(inner, deps({
      identity: identity({
        source: contractedSource(),
        channel_session_id: 'mcp:agent-1',
        contract_snapshot: snapshot,
        cognition_session_id: 'cognition-1',
      }),
      genCommitId: sequence(['commit-with-optional']),
      genIdempotencyKey: sequence(['idem-with-optional']),
      now: sequence([30, 45]),
    }));

    await withoutOptional('mail.read', {});
    await withOptional('mail.send', {});

    const absent = await store.get('commit-without-optional');
    expect(absent).not.toHaveProperty('contract_snapshot');
    expect(absent).not.toHaveProperty('cognition_session_id');

    const present = await store.get('commit-with-optional');
    expect(present).toMatchObject({
      contract_snapshot: snapshot,
      cognition_session_id: 'cognition-1',
    });
  });

  it('allows the maximum dispatch depth but refuses one past it before dispatch', async () => {
    let allowedCalls = 0;
    const allowed = wrapWithCommitGateway(async () => {
      allowedCalls += 1;
      return { ok: true };
    }, deps({
      identity: identity({ dispatch_depth: MAX_DISPATCH_DEPTH }),
      genCommitId: sequence(['commit-max-depth']),
      genIdempotencyKey: sequence(['idem-max-depth']),
      now: sequence([100, 150]),
    }));

    await allowed('loop.safe', {});

    expect(allowedCalls).toBe(1);
    expect(await store.get('commit-max-depth')).toMatchObject({
      commit_id: 'commit-max-depth',
      dispatch_depth: MAX_DISPATCH_DEPTH,
      status: 'succeeded',
    });

    let refusedCalls = 0;
    const refused = wrapWithCommitGateway(async () => {
      refusedCalls += 1;
      return { ok: true };
    }, deps({
      identity: identity({ dispatch_depth: MAX_DISPATCH_DEPTH + 1 }),
      genCommitId: sequence(['commit-too-deep']),
      genIdempotencyKey: sequence(['idem-too-deep']),
      now: sequence([200, 250]),
    }));

    let thrown: unknown;
    try {
      await refused('loop.unsafe', {});
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(DispatchDepthExceededError);
    expect(thrown).toMatchObject({
      code: 'DISPATCH_DEPTH_EXCEEDED',
      dispatch_depth: MAX_DISPATCH_DEPTH + 1,
      max_dispatch_depth: MAX_DISPATCH_DEPTH,
    });
    expect(refusedCalls).toBe(0);
    expect(await store.get('commit-too-deep')).toBeNull();
    expect(await store.size()).toBe(1);
  });

  it('records failed when the inner executor throws a generic error and propagates that error', async () => {
    const toolError = new Error('tool failed');
    const executor = wrapWithCommitGateway(async () => {
      throw toolError;
    }, deps({
      genCommitId: sequence(['commit-failed']),
      genIdempotencyKey: sequence(['idem-failed']),
      now: sequence([500, 575]),
    }));

    await expect(executor('mail.send', { to: 'ada@example.com' }))
      .rejects.toBe(toolError);

    const row = await store.get('commit-failed');
    expect(row).toMatchObject({
      commit_id: 'commit-failed',
      status: 'failed',
      completed_at: 575,
      duration_ms: 75,
    });
    expect(row).not.toHaveProperty('output');
  });

  it('records in_doubt when the inner error carries ACTION_DELIVERY_UNCERTAIN', async () => {
    const uncertainError = Object.assign(new Error('delivery uncertain'), {
      code: 'ACTION_DELIVERY_UNCERTAIN',
    });
    const executor = wrapWithCommitGateway(async () => {
      throw uncertainError;
    }, deps({
      genCommitId: sequence(['commit-in-doubt']),
      genIdempotencyKey: sequence(['idem-in-doubt']),
      now: sequence([600, 640]),
    }));

    await expect(executor('mail.send', { to: 'ada@example.com' }))
      .rejects.toBe(uncertainError);

    expect(await store.get('commit-in-doubt')).toMatchObject({
      commit_id: 'commit-in-doubt',
      status: 'in_doubt',
      completed_at: 640,
      duration_ms: 40,
    });
  });

  it('terminalizes a provider result observed after run abort as cancelled without output', async () => {
    const controller = new AbortController();
    let resolveInner!: (value: { delivered: true }) => void;
    const innerResult = new Promise<{ delivered: true }>((resolve) => {
      resolveInner = resolve;
    });
    const executor = wrapWithCommitGateway(() => innerResult, deps({
      runAbortSignal: controller.signal,
      genCommitId: sequence(['commit-abandoned']),
      genIdempotencyKey: sequence(['idem-abandoned']),
      now: sequence([650, 690]),
    }));

    const pending = executor('ai.generate', { prompt: 'slow' });
    await vi.waitFor(async () => {
      expect(await store.get('commit-abandoned')).toMatchObject({ status: 'pending' });
    });
    controller.abort();
    resolveInner({ delivered: true });

    await expect(pending).rejects.toMatchObject({ code: 'run_killed' });
    const row = await store.get('commit-abandoned');
    expect(row).toMatchObject({
      commit_id: 'commit-abandoned',
      status: 'cancelled',
      completed_at: 690,
      duration_ms: 40,
    });
    expect(row).not.toHaveProperty('output');
  });

  it('a pre-aborted run burns no use, writes no commit, and never dispatches', async () => {
    const controller = new AbortController();
    controller.abort();
    const reserveDispatchUsage = vi.fn();
    const recordDispatchUse = vi.fn();
    const inner = vi.fn<GatewayInner>();
    const executor = wrapWithCommitGateway(inner, deps({
      runAbortSignal: controller.signal,
      reserveDispatchUsage,
      recordDispatchUse,
      genCommitId: sequence(['commit-never-dispatched']),
      genIdempotencyKey: sequence(['idem-never-dispatched']),
      now: sequence([700]),
    }));

    await expect(executor('mail.send', { to: 'ada@example.com' }))
      .rejects.toMatchObject({ code: 'run_killed' });
    expect(reserveDispatchUsage).not.toHaveBeenCalled();
    expect(recordDispatchUse).not.toHaveBeenCalled();
    expect(inner).not.toHaveBeenCalled();
    expect(await store.size()).toBe(0);
  });

  it('records cached only when the inner marks the per-call probe cached', async () => {
    const cached = wrapWithCommitGateway(async (_slug, _input, _out, _opts, _meta, probe) => {
      probe.cached = true;
      return { cached: 'hit' };
    }, deps({
      genCommitId: sequence(['commit-cache-hit']),
      genIdempotencyKey: sequence(['idem-cache-hit']),
      now: sequence([700, 730]),
    }));
    const uncached = wrapWithCommitGateway(async () => ({ cached: 'miss' }), deps({
      genCommitId: sequence(['commit-cache-miss']),
      genIdempotencyKey: sequence(['idem-cache-miss']),
      now: sequence([800, 840]),
    }));

    await cached('search.lookup', {});
    await uncached('search.lookup', {});

    expect(await store.get('commit-cache-hit')).toMatchObject({
      commit_id: 'commit-cache-hit',
      status: 'succeeded',
      cached: true,
    });
    expect(await store.get('commit-cache-miss')).not.toHaveProperty('cached');
  });

  it('propagates writePending failure without invoking the inner executor', async () => {
    const writeError = new Error('write pending failed');
    let calls = 0;
    const rejectingStore: CommitStore = {
      ...store,
      writePending: async () => {
        throw writeError;
      },
    };
    const executor = wrapWithCommitGateway(async () => {
      calls += 1;
      return { ok: true };
    }, deps({
      commitStore: rejectingStore,
      genCommitId: sequence(['commit-write-failure']),
      genIdempotencyKey: sequence(['idem-write-failure']),
      now: sequence([900, 950]),
    }));

    await expect(executor('mail.send', { to: 'ada@example.com' }))
      .rejects.toBe(writeError);

    expect(calls).toBe(0);
    expect(await store.size()).toBe(0);
  });

  it('treats recordOutcome as best-effort without masking success or the original tool error', async () => {
    const outcomeError = new Error('record outcome failed');
    const recorded: Array<{ commit_id: string; outcome: CommitOutcome }> = [];
    const rejectingOutcomeStore: CommitStore = {
      ...store,
      recordOutcome: async (commit_id, outcome) => {
        recorded.push({ commit_id, outcome });
        throw outcomeError;
      },
    };
    const successResult = { ok: true };
    const success = wrapWithCommitGateway(async () => successResult, deps({
      commitStore: rejectingOutcomeStore,
      genCommitId: sequence(['commit-outcome-success']),
      genIdempotencyKey: sequence(['idem-outcome-success']),
      now: sequence([1_000, 1_030]),
    }));

    await expect(success('mail.read', {})).resolves.toBe(successResult);

    const toolError = new Error('original tool error');
    const failure = wrapWithCommitGateway(async () => {
      throw toolError;
    }, deps({
      commitStore: rejectingOutcomeStore,
      genCommitId: sequence(['commit-outcome-failure']),
      genIdempotencyKey: sequence(['idem-outcome-failure']),
      now: sequence([1_100, 1_160]),
    }));

    await expect(failure('mail.send', {})).rejects.toBe(toolError);

    expect(recorded).toEqual([
      {
        commit_id: 'commit-outcome-success',
        outcome: {
          status: 'succeeded',
          output: successResult,
          completed_at: 1_030,
        },
      },
      {
        commit_id: 'commit-outcome-failure',
        outcome: {
          status: 'failed',
          completed_at: 1_160,
        },
      },
    ]);
    expect(await store.get('commit-outcome-success')).toMatchObject({
      commit_id: 'commit-outcome-success',
      status: 'pending',
    });
    expect(await store.get('commit-outcome-failure')).toMatchObject({
      commit_id: 'commit-outcome-failure',
      status: 'pending',
    });
  });
});

describe('wrapWithCommitGateway D-177 P1b action-identity stamping', () => {
  it('writes pending commits with hashes over projectResolvedArgs(resolveArgsForHash(...))', async () => {
    const input = { to: '{{config.to}}' };
    const resolvedBasis = {
      to: 'ada@example.com',
      optional: undefined,
      list: [undefined, 'stable'],
    };
    const expected = canonicalArgHash(projectResolvedArgs(resolvedBasis));
    const { commitStore, written } = capturePendingStore();
    const resolveArgsForHash = vi.fn(() => resolvedBasis);
    const output = { ok: true };
    const executor = wrapWithCommitGateway(async () => output, deps({
      commitStore,
      resolveArgsForHash,
      genCommitId: sequence(['commit-hashed']),
      genIdempotencyKey: sequence(['idem-hashed']),
      now: sequence([2_000, 2_050]),
    }));

    await expect(executor('mail.send', input)).resolves.toBe(output);

    expect(resolveArgsForHash).toHaveBeenCalledWith('mail.send', input, {
      surfaceDispatch: false,
    });
    expect(written).toHaveLength(1);
    expect(written[0].arg_shape_hash).toBe(expected.arg_shape_hash);
    expect(written[0].canonical_payload_hash).toBe(expected.canonical_payload_hash);
  });

  it('forwards hash exclusions only for trusted catalog surface dispatches', async () => {
    const getHashExcludeArgs = vi.fn(() => undefined);
    const resolveArgsForHash = vi.fn<NonNullable<CommitGatewayDeps['resolveArgsForHash']>>(
      (_slug, input) => input,
    );
    const executor = wrapWithCommitGateway(async () => ({ ok: true }), deps({
      resolveArgsForHash,
      getHashExcludeArgs,
      genCommitId: sequence(['commit-plain', 'commit-surface', 'commit-forged']),
      genIdempotencyKey: sequence(['idem-plain', 'idem-surface', 'idem-forged']),
      now: sequence([2_100, 2_110, 2_200, 2_210, 2_300, 2_310]),
    }));

    await executor('plain.dispatch', {});
    await executor('surface.dispatch', {}, undefined, undefined, {
      step_id: 'step-surface',
      recipe_id: 'recipe-1',
      surface_dispatch: true,
      surface_operation_key: 'issues.create',
    });
    await executor('forged.dispatch', {}, undefined, undefined, {
      step_id: 'step-forged',
      recipe_id: 'recipe-1',
      surface_operation_key: 'issues.delete',
    });

    expect(getHashExcludeArgs).toHaveBeenNthCalledWith(1, 'plain.dispatch', undefined);
    expect(getHashExcludeArgs).toHaveBeenNthCalledWith(
      2,
      'surface.dispatch',
      'issues.create',
    );
    expect(getHashExcludeArgs).toHaveBeenNthCalledWith(3, 'forged.dispatch', undefined);
    expect(resolveArgsForHash.mock.calls.map((c) => c[2])).toEqual([
      { surfaceDispatch: false },
      { surfaceDispatch: true },
      { surfaceDispatch: false },
    ]);
  });

  it('keeps sensitive surface injection out of admission, commits, and raw output', async () => {
    const callbackUrl = 'https://hooks.example/v1/webhooks/opaque-public-id';
    const authorityInput = {
      method: 'POST',
      path: '/resources',
      connection_kind: 'api',
      connection: 'fixture-provider',
      name: 'resource',
    };
    const providerInput = {
      ...authorityInput,
      'body.callback_url': callbackUrl,
    };
    const { commitStore, written } = capturePendingStore();
    const resolveArgsForHash = vi.fn<NonNullable<CommitGatewayDeps['resolveArgsForHash']>>(
      (_slug, input) => input,
    );
    const evaluateAdmission = vi.fn<NonNullable<CommitGatewayDeps['evaluateAdmission']>>(
      () => null,
    );
    const reserveDispatchUsage = vi.fn<NonNullable<CommitGatewayDeps['reserveDispatchUsage']>>();
    const inner = vi.fn<GatewayInner>(async () => ({ callback_url: callbackUrl }));
    const executor = wrapWithCommitGateway(inner, deps({
      commitStore,
      resolveArgsForHash,
      evaluateAdmission,
      reserveDispatchUsage,
      getIngredientCategory: () => 'action',
      genCommitId: sequence(['commit-sensitive-surface']),
      genIdempotencyKey: sequence(['idem-sensitive-surface']),
      now: sequence([2_350, 2_390]),
    }));

    await expect(executor(
      'webhook-operation-fixture',
      providerInput,
      undefined,
      undefined,
      {
        step_id: 'attach-resource',
        surface_dispatch: true,
        surface_operation_key: 'resource.create',
        surface_dispatch_authority_input: authorityInput,
        surface_dispatch_sensitive: true,
      },
    )).resolves.toEqual({ callback_url: callbackUrl });

    expect(evaluateAdmission).toHaveBeenCalledWith(
      'webhook-operation-fixture',
      authorityInput,
      'resource.create',
    );
    expect(resolveArgsForHash).toHaveBeenCalledWith(
      'webhook-operation-fixture',
      authorityInput,
      { surfaceDispatch: true },
    );
    expect(reserveDispatchUsage).toHaveBeenCalledWith(
      'webhook-operation-fixture',
      authorityInput,
      'resource.create',
      'attach-resource',
    );
    expect(written).toHaveLength(1);
    expect(written[0]?.args).toEqual(authorityInput);
    expect(JSON.stringify(written)).not.toContain(callbackUrl);
    expect(inner).toHaveBeenCalledWith(
      'webhook-operation-fixture',
      providerInput,
      undefined,
      undefined,
      expect.not.objectContaining({ surface_dispatch_authority_input: expect.anything() }),
      expect.any(Object),
    );
    const forwardedMeta = inner.mock.calls[0]?.[4];
    expect(forwardedMeta).toMatchObject({ surface_dispatch_sensitive: true });
    expect(forwardedMeta).not.toHaveProperty('surface_dispatch_authority_input');
    const committed = await store.get('commit-sensitive-surface');
    expect(committed).not.toHaveProperty('output');
    expect(JSON.stringify(committed)).not.toContain(callbackUrl);
  });

  it('fails closed when a sensitive surface omits its pre-injection authority input', async () => {
    const inner = vi.fn<GatewayInner>(async () => ({ ok: true }));
    const executor = wrapWithCommitGateway(inner, deps());

    await expect(executor(
      'webhook-operation-fixture',
      { 'body.callback_url': 'https://hooks.example/v1/webhooks/opaque-public-id' },
      undefined,
      undefined,
      {
        step_id: 'attach-resource',
        surface_dispatch: true,
        surface_operation_key: 'resource.create',
        surface_dispatch_sensitive: true,
      },
    )).rejects.toThrow(/missing its pre-injection authority input/);
    expect(inner).not.toHaveBeenCalled();
    await expect(store.get('commit-1')).resolves.toBeNull();
  });

  it('applies exclusions to canonical_payload_hash without changing arg_shape_hash', async () => {
    const resolvedBasis = { to: 'ada@example.com', client_ts: 123 };
    const full = canonicalArgHash(projectResolvedArgs(resolvedBasis));
    const excluded = canonicalArgHash(projectResolvedArgs(resolvedBasis), {
      excludePaths: ['client_ts'],
    });
    const { commitStore, written } = capturePendingStore();
    const executor = wrapWithCommitGateway(async () => ({ ok: true }), deps({
      commitStore,
      resolveArgsForHash: () => resolvedBasis,
      getHashExcludeArgs: () => ['client_ts'],
      genCommitId: sequence(['commit-excluded']),
      genIdempotencyKey: sequence(['idem-excluded']),
      now: sequence([2_400, 2_440]),
    }));

    await executor('mail.send', { to: '{{config.to}}', client_ts: '{{context.now}}' });

    expect(excluded.arg_shape_hash).toBe(full.arg_shape_hash);
    expect(excluded.canonical_payload_hash).not.toBe(full.canonical_payload_hash);
    expect(written[0].arg_shape_hash).toBe(excluded.arg_shape_hash);
    expect(written[0].canonical_payload_hash).toBe(excluded.canonical_payload_hash);
  });

  it('omits hash fields when resolveArgsForHash returns undefined', async () => {
    const { commitStore, written } = capturePendingStore();
    const executor = wrapWithCommitGateway(async () => ({ ok: true }), deps({
      commitStore,
      resolveArgsForHash: () => undefined,
      genCommitId: sequence(['commit-no-basis']),
      genIdempotencyKey: sequence(['idem-no-basis']),
      now: sequence([2_500, 2_550]),
    }));

    await expect(executor('unknown.tool', { q: 'x' })).resolves.toEqual({ ok: true });

    expectNoActionIdentity(written[0]);
  });

  it('omits hash fields and still dispatches when resolveArgsForHash throws', async () => {
    const { commitStore, written } = capturePendingStore();
    const inner = vi.fn<GatewayInner>().mockResolvedValue({ ok: true });
    const executor = wrapWithCommitGateway(inner, deps({
      commitStore,
      resolveArgsForHash: () => {
        throw new Error('cannot resolve hash basis');
      },
      genCommitId: sequence(['commit-resolver-throws']),
      genIdempotencyKey: sequence(['idem-resolver-throws']),
      now: sequence([2_600, 2_660]),
    }));

    await expect(executor('mail.send', { to: 'ada@example.com' })).resolves.toEqual({ ok: true });

    expect(inner).toHaveBeenCalledTimes(1);
    expectNoActionIdentity(written[0]);
  });

  it('omits hash fields and still dispatches when canonicalArgHash rejects the resolved basis', async () => {
    const { commitStore, written } = capturePendingStore();
    const inner = vi.fn<GatewayInner>().mockResolvedValue({ ok: true });
    const executor = wrapWithCommitGateway(inner, deps({
      commitStore,
      resolveArgsForHash: () => ({ n: NaN }),
      genCommitId: sequence(['commit-hash-throws']),
      genIdempotencyKey: sequence(['idem-hash-throws']),
      now: sequence([2_700, 2_770]),
    }));

    await expect(executor('math.send', { n: '{{config.n}}' })).resolves.toEqual({ ok: true });

    expect(inner).toHaveBeenCalledTimes(1);
    expectNoActionIdentity(written[0]);
  });

  it('omits hash fields when resolveArgsForHash is not wired', async () => {
    const { commitStore, written } = capturePendingStore();
    const executor = wrapWithCommitGateway(async () => ({ ok: true }), deps({
      commitStore,
      genCommitId: sequence(['commit-pre-p1b']),
      genIdempotencyKey: sequence(['idem-pre-p1b']),
      now: sequence([2_800, 2_880]),
    }));

    await expect(executor('mail.send', { to: 'ada@example.com' })).resolves.toEqual({ ok: true });

    expectNoActionIdentity(written[0]);
  });

  it('does not call resolveArgsForHash on the no-identity pass-through path', async () => {
    const resolveArgsForHash = vi.fn(() => ({ to: 'ada@example.com' }));
    const inner = vi.fn<GatewayInner>().mockResolvedValue({ ok: true });
    const executor = wrapWithCommitGateway(inner, deps({
      identity: undefined,
      resolveArgsForHash,
    }));

    await expect(executor('mail.send', { to: 'ada@example.com' })).resolves.toEqual({ ok: true });

    expect(resolveArgsForHash).not.toHaveBeenCalled();
    expect(inner).toHaveBeenCalledTimes(1);
    expect(await store.size()).toBe(0);
  });
});

describe('wrapWithCommitGateway recordDispatchUse seam', () => {
  it('fires exactly once with the dispatched slug on a successful dispatch', async () => {
    const output = { ok: true };
    const recordDispatchUse = vi.fn();
    const executor = wrapWithCommitGateway(async () => output, deps({
      recordDispatchUse,
      genCommitId: sequence(['commit-record-success']),
      genIdempotencyKey: sequence(['idem-record-success']),
      now: sequence([1_200, 1_245]),
    }));

    await expect(executor('calendar.create', { title: 'Review' })).resolves.toBe(output);

    expect(recordDispatchUse).toHaveBeenCalledTimes(1);
    // slice 2a — a simple-form dispatch (no stepMeta surface op key) threads undefined.
    expect(recordDispatchUse).toHaveBeenCalledWith('calendar.create', undefined);
    expect(await store.get('commit-record-success')).toMatchObject({
      commit_id: 'commit-record-success',
      status: 'succeeded',
    });
  });

  it('fires on a failed dispatch and still propagates the original error', async () => {
    const toolError = new Error('tool failed after boundary');
    const recordDispatchUse = vi.fn();
    const executor = wrapWithCommitGateway(async () => {
      throw toolError;
    }, deps({
      recordDispatchUse,
      genCommitId: sequence(['commit-record-failed']),
      genIdempotencyKey: sequence(['idem-record-failed']),
      now: sequence([1_300, 1_375]),
    }));

    await expect(executor('mail.send', { to: 'ada@example.com' }))
      .rejects.toBe(toolError);

    expect(recordDispatchUse).toHaveBeenCalledTimes(1);
    expect(recordDispatchUse).toHaveBeenCalledWith('mail.send', undefined);
    expect(await store.get('commit-record-failed')).toMatchObject({
      commit_id: 'commit-record-failed',
      status: 'failed',
    });
  });

  it('fires on an in_doubt dispatch before the uncertain delivery error propagates', async () => {
    const uncertainError = Object.assign(new Error('delivery uncertain'), {
      code: 'ACTION_DELIVERY_UNCERTAIN',
    });
    const recordDispatchUse = vi.fn();
    const executor = wrapWithCommitGateway(async () => {
      throw uncertainError;
    }, deps({
      recordDispatchUse,
      genCommitId: sequence(['commit-record-in-doubt']),
      genIdempotencyKey: sequence(['idem-record-in-doubt']),
      now: sequence([1_400, 1_455]),
    }));

    await expect(executor('mail.send', { to: 'ada@example.com' }))
      .rejects.toBe(uncertainError);

    expect(recordDispatchUse).toHaveBeenCalledTimes(1);
    expect(recordDispatchUse).toHaveBeenCalledWith('mail.send', undefined);
    expect(await store.get('commit-record-in-doubt')).toMatchObject({
      commit_id: 'commit-record-in-doubt',
      status: 'in_doubt',
    });
  });

  it('fires synchronously before writePending and before the inner executor', async () => {
    const order: string[] = [];
    const orderedStore: CommitStore = {
      ...store,
      writePending: async (pending) => {
        order.push('pending');
        await store.writePending(pending);
      },
    };
    const inner: GatewayInner = async () => {
      order.push('inner');
      return { ok: true };
    };
    const executor = wrapWithCommitGateway(inner, deps({
      commitStore: orderedStore,
      recordDispatchUse: (slug) => {
        expect(slug).toBe('calendar.create');
        order.push('use');
      },
      genCommitId: sequence(['commit-record-order']),
      genIdempotencyKey: sequence(['idem-record-order']),
      now: sequence([1_500, 1_525]),
    }));

    await expect(executor('calendar.create', { title: 'Review' })).resolves.toEqual({ ok: true });

    expect(order).toEqual(['use', 'pending', 'inner']);
  });

  it('reserves customer dispatch usage before contract use and effect dispatch', async () => {
    const order: string[] = [];
    const orderedStore: CommitStore = {
      ...store,
      writePending: async (pending) => {
        order.push('pending');
        await store.writePending(pending);
      },
    };
    const input = { 'llm.data': [{ id: 'a' }, { id: 'b' }], 'llm.id_field': 'id' };
    const executor = wrapWithCommitGateway(async () => {
      order.push('inner');
      return { ok: true };
    }, deps({
      commitStore: orderedStore,
      reserveDispatchUsage: (slug, received, operationId, stepId) => {
        expect(slug).toBe('ai-classify');
        expect(received).toBe(input);
        expect(operationId).toBeUndefined();
        expect(stepId).toBe('batch-step');
        order.push('customer-usage');
      },
      recordDispatchUse: () => order.push('contract-use'),
      genCommitId: sequence(['commit-customer-usage-order']),
      genIdempotencyKey: sequence(['idem-customer-usage-order']),
      now: sequence([1_550, 1_575]),
    }));

    await expect(executor(
      'ai-classify',
      input,
      undefined,
      undefined,
      { step_id: 'batch-step' },
    )).resolves.toEqual({ ok: true });
    expect(order).toEqual(['customer-usage', 'contract-use', 'pending', 'inner']);
  });

  it('does not burn contract use or dispatch when customer usage reservation denies', async () => {
    const usageError = new Error('tool_call usage limit exceeded');
    const recordDispatchUse = vi.fn();
    const inner = vi.fn<GatewayInner>().mockResolvedValue({ ok: true });
    const executor = wrapWithCommitGateway(inner, deps({
      reserveDispatchUsage: () => {
        throw usageError;
      },
      recordDispatchUse,
      genCommitId: sequence(['commit-customer-usage-denied']),
      genIdempotencyKey: sequence(['idem-customer-usage-denied']),
      now: sequence([1_580, 1_590]),
    }));

    await expect(executor('ai-classify', { 'llm.data': [] })).rejects.toBe(usageError);
    expect(recordDispatchUse).not.toHaveBeenCalled();
    expect(inner).not.toHaveBeenCalled();
    expect(await store.size()).toBe(0);
  });

  it('fires on the no-op pass-through path before inner without writing a commit', async () => {
    const order: string[] = [];
    const output = { ok: true };
    const inner: GatewayInner = async () => {
      order.push('inner');
      return output;
    };
    const executor = wrapWithCommitGateway(inner, deps({
      identity: undefined,
      recordDispatchUse: (slug) => {
        expect(slug).toBe('mail.read');
        order.push('use');
      },
    }));

    await expect(executor('mail.read', { q: 'inbox' })).resolves.toBe(output);

    expect(order).toEqual(['use', 'inner']);
    expect(await store.size()).toBe(0);
  });

  it('does not fire when dispatch_depth exceeds the gateway ceiling', async () => {
    const recordDispatchUse = vi.fn();
    let innerCalls = 0;
    const executor = wrapWithCommitGateway(async () => {
      innerCalls += 1;
      return { ok: true };
    }, deps({
      identity: identity({ dispatch_depth: MAX_DISPATCH_DEPTH + 1 }),
      recordDispatchUse,
      genCommitId: sequence(['commit-record-too-deep']),
      genIdempotencyKey: sequence(['idem-record-too-deep']),
      now: sequence([1_600, 1_625]),
    }));

    await expect(executor('loop.unsafe', {}))
      .rejects.toBeInstanceOf(DispatchDepthExceededError);

    expect(recordDispatchUse).not.toHaveBeenCalled();
    expect(innerCalls).toBe(0);
    expect(await store.size()).toBe(0);
  });

  it('fires before writePending failure, does not call inner, and propagates the write error', async () => {
    const writeError = new Error('write pending failed after use reservation');
    const recordDispatchUse = vi.fn();
    const inner = vi.fn<GatewayInner>().mockResolvedValue({ ok: true });
    const rejectingStore: CommitStore = {
      ...store,
      writePending: async () => {
        throw writeError;
      },
    };
    const executor = wrapWithCommitGateway(inner, deps({
      commitStore: rejectingStore,
      recordDispatchUse,
      genCommitId: sequence(['commit-record-write-failure']),
      genIdempotencyKey: sequence(['idem-record-write-failure']),
      now: sequence([1_700, 1_725]),
    }));

    await expect(executor('mail.send', { to: 'ada@example.com' }))
      .rejects.toBe(writeError);

    expect(recordDispatchUse).toHaveBeenCalledTimes(1);
    expect(recordDispatchUse).toHaveBeenCalledWith('mail.send', undefined);
    expect(inner).not.toHaveBeenCalled();
    expect(await store.size()).toBe(0);
  });

  it('treats an absent recordDispatchUse dependency as a no-op', async () => {
    const output = { ok: true };
    const inner = vi.fn<GatewayInner>().mockResolvedValue(output);
    const executor = wrapWithCommitGateway(inner, deps({
      genCommitId: sequence(['commit-record-absent']),
      genIdempotencyKey: sequence(['idem-record-absent']),
      now: sequence([1_800, 1_835]),
    }));

    await expect(executor('mail.read', { q: 'inbox' })).resolves.toBe(output);

    expect(inner).toHaveBeenCalledTimes(1);
    expect(await store.get('commit-record-absent')).toMatchObject({
      commit_id: 'commit-record-absent',
      status: 'succeeded',
    });
  });
});

describe('liftExecutor', () => {
  it('adapts a plain executor and leaves the cache probe untouched', async () => {
    const input = { q: 'ada' };
    const stepOutput = { previous: 'ok' };
    const stepOptions: StepOptions = { cache: 'fresh' };
    const stepMeta: StepMeta = { step_id: 'step-1', recipe_id: 'recipe-1' };
    const result = { rows: [1, 2, 3] };
    const calls: Array<Parameters<GatewayExecutor>> = [];
    const plain: GatewayExecutor = async (...args) => {
      calls.push(args);
      return result;
    };
    const probe = { cached: false };

    await expect(liftExecutor(plain)(
      'search.lookup',
      input,
      stepOutput,
      stepOptions,
      stepMeta,
      probe,
    )).resolves.toBe(result);

    expect(calls).toEqual([
      ['search.lookup', input, stepOutput, stepOptions, stepMeta],
    ]);
    expect(probe.cached).toBe(false);
  });
});
