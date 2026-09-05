/** D-177 P5a batch approval coordinator tests. */

import { describe, expect, it, vi } from 'vitest';

import {
  BATCH_ASK_MAX_MEMBERS,
  type Checkpoint,
  type ExecutionSource,
  type PreflightOverrideOffer,
  type RiskTier,
} from '@recued/contracts';
import type {
  PreflightAskContext,
  PreflightNotifier,
  PreflightResumer,
} from '@recued/gateway';
import {
  RELAX_OPERATION_TO_ASK_OPTION_ID,
} from '@recued/gateway';
import type { Answer } from '@recued/notification';
import {
  createBatchAskStore,
  createInMemoryCollection,
  type BatchAskStore,
  type CheckpointStore,
} from '@recued/storage';

import {
  createBatchApprovalCoordinator,
  type BatchApprovalCoordinator,
  type BatchHoldRegistration,
  type UnresolvedBatchAsk,
} from '../batch-approval.js';
import type { SessionGrantResolver } from '../session-grant-resolver.js';
import {
  createGatedActionStore,
  type GatedActionRecord,
  type GatedActionStore,
} from '../gated-action-store.js';

const NOW = Date.parse('2026-06-10T12:00:00.000Z');

const fakeOverrideWriter = (order?: string[]) =>
  vi.fn(async (_offer: PreflightOverrideOffer): Promise<void> => {
    order?.push('override');
  });

const source = (
  overrides: Partial<{
    chat_session_id: string;
    user_id: string;
    turn_id: string;
  }> = {},
): ExecutionSource => ({
  channel: 'chat',
  actor: 'user_self',
  chat_session_id: 'chat-1',
  user_id: 'user-1',
  turn_id: 'turn-1',
  ...overrides,
});

const checkpoint = (index = 1): Checkpoint => ({
  checkpoint_id: `checkpoint-${index}`,
  run_id: `run-${index}`,
  recipe_id: 'recipe-1',
  gated_step_id: `gated-step-${index}`,
  step_state: { previous: index },
  created_at: NOW + index,
});

const answer = (option: string): Answer => ({
  option,
  answered_at: NOW + 50_000,
});

const hold = (
  index = 1,
  overrides: Partial<BatchHoldRegistration> = {},
): BatchHoldRegistration => {
  const cp = overrides.checkpoint ?? checkpoint(index);
  return {
    source: source(),
    run_id: cp.run_id,
    correlation_id: 'corr-1',
    channel_session_id: 'chat-1',
    ingredient_slug: 'mail.send',
    operation_id: 'mail.send',
    connection_name: 'gmail-primary',
    risk_tier: 'write',
    authorization_provenance: { pre_lift_approval: 'ask' },
    recipe_id: 'recipe-1',
    recipe_hash: 'recipe-hash-1',
    arg_shape_hash: 'arg-shape-1',
    canonical_payload_hash: `payload-${index}`,
    args_preview: { to: `user-${index}@example.test`, subject: `hello ${index}` },
    checkpoint: cp,
    ask_context: {
      tool_slug: 'mail.send',
      risk_tier: 'write',
      reason: 'write tier requires approval',
      authorization_provenance: { pre_lift_approval: 'ask' },
    },
    session_grant_offer: {
      ttl_ms: 3_600_000,
      max_uses: 5,
      risk_tier: 'write',
    },
    ...overrides,
  };
};

const fakeCheckpointStore = (
  checkpoints: readonly Checkpoint[] = [],
): CheckpointStore & {
  rows: Map<string, Checkpoint>;
  get: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
} => {
  const rows = new Map(checkpoints.map((cp) => [cp.checkpoint_id, cp]));
  const store = {
    rows,
    write: vi.fn(async (cp: Checkpoint) => {
      rows.set(cp.checkpoint_id, cp);
    }),
    get: vi.fn(async (checkpoint_id: string) => rows.get(checkpoint_id) ?? null),
    listByRun: vi.fn(async (run_id: string) =>
      [...rows.values()].filter((cp) => cp.run_id === run_id),
    ),
    setArgOverrides: vi.fn().mockImplementation(async (checkpoint_id: string, patch) => {
      const existing = rows.get(checkpoint_id);
      if (existing === undefined) throw new Error(`checkpoint ${checkpoint_id} not found`);
      const updated = { ...existing, ...patch };
      rows.set(checkpoint_id, updated);
      return updated;
    }),
    delete: vi.fn(async (checkpoint_id: string) => {
      rows.delete(checkpoint_id);
    }),
    list: vi.fn(async () => [...rows.values()]),
    size: vi.fn(async () => rows.size),
  };
  return store as unknown as CheckpointStore & typeof store;
};

const fakeResumer = (): PreflightResumer & {
  resumeRun: ReturnType<typeof vi.fn>;
  denyRun: ReturnType<typeof vi.fn>;
} => ({
  resumeRun: vi.fn().mockResolvedValue(undefined),
  denyRun: vi.fn().mockResolvedValue(undefined),
});

const fakeNotifier = (
  order: string[] = [],
): PreflightNotifier & {
  ask: ReturnType<typeof vi.fn>;
  registerAskHandler: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
} => {
  let askSeq = 0;
  return {
    ask: vi.fn(async () => {
      askSeq += 1;
      const ask_id = `ask-${askSeq}`;
      order.push(`ask:${ask_id}`);
      return { ask_id };
    }),
    // D-210 Phase C — the passive twin. Batch approvals never take it
    // (notify mode does not batch), so a call here would be a defect.
    notify: vi.fn(async () => {
      order.push('notify:UNEXPECTED');
    }),
    registerAskHandler: vi.fn<PreflightNotifier['registerAskHandler']>(),
  };
};

const fakeSessionGrantResolver = (): SessionGrantResolver & {
  match: ReturnType<typeof vi.fn>;
  consume: ReturnType<typeof vi.fn>;
  claimBatchMember: ReturnType<typeof vi.fn>;
  mintBatch: ReturnType<typeof vi.fn>;
  mintRawOp: ReturnType<typeof vi.fn>;
  mint: ReturnType<typeof vi.fn>;
} => ({
  match: vi.fn(() => null),
  consume: vi.fn(() => true),
  claimBatchMember: vi.fn(() => false),
  mintBatch: vi.fn(() => 'batch-grant-1'),
  mintRawOp: vi.fn(() => undefined),
  mint: vi.fn<SessionGrantResolver['mint']>(),
});

const harness = (
  opts: {
    checkpoints?: readonly Checkpoint[];
    order?: string[];
    sessionGrantResolver?: ReturnType<typeof fakeSessionGrantResolver>;
    upsertOverride?: ReturnType<typeof fakeOverrideWriter>;
    gatedActionStore?: GatedActionStore;
    listUnresolvedAsks?: ReturnType<typeof vi.fn<
      () => Promise<ReadonlyArray<UnresolvedBatchAsk>>
    >>;
  } = {},
): {
  coordinator: BatchApprovalCoordinator;
  batchAskStore: BatchAskStore;
  checkpointStore: ReturnType<typeof fakeCheckpointStore>;
  resumer: ReturnType<typeof fakeResumer>;
  notifier: ReturnType<typeof fakeNotifier>;
  cancelAsk: ReturnType<typeof vi.fn>;
  sessionGrantResolver: ReturnType<typeof fakeSessionGrantResolver>;
  upsertOverride: ReturnType<typeof fakeOverrideWriter>;
  listUnresolvedAsks: ReturnType<typeof vi.fn<
    () => Promise<ReadonlyArray<UnresolvedBatchAsk>>
  >>;
} => {
  const batchAskStore = createBatchAskStore(createInMemoryCollection());
  const checkpointStore = fakeCheckpointStore(opts.checkpoints ?? []);
  const resumer = fakeResumer();
  const notifier = fakeNotifier(opts.order);
  const cancelAsk = vi.fn(async (ask_id: string) => {
    opts.order?.push(`cancel:${ask_id}`);
    return 'cancelled' as const;
  });
  const sessionGrantResolver = opts.sessionGrantResolver ?? fakeSessionGrantResolver();
  const upsertOverride = opts.upsertOverride ?? fakeOverrideWriter(opts.order);
  const listUnresolvedAsks = opts.listUnresolvedAsks
    ?? vi.fn<() => Promise<ReadonlyArray<UnresolvedBatchAsk>>>().mockResolvedValue([]);
  let batchSeq = 0;
  let now = NOW;
  const coordinator = createBatchApprovalCoordinator({
    batchAskStore,
    checkpointStore,
    resumer,
    notifier,
    listUnresolvedAsks,
    cancelAsk,
    sessionGrantResolver,
    upsertOverride,
    ...(opts.gatedActionStore !== undefined
      ? { gatedActionStore: opts.gatedActionStore }
      : {}),
    now: () => {
      now += 1_000;
      return now;
    },
    newBatchId: () => {
      batchSeq += 1;
      return `batch-${batchSeq}`;
    },
  });
  return {
    coordinator,
    batchAskStore,
    checkpointStore,
    resumer,
    notifier,
    cancelAsk,
    sessionGrantResolver,
    upsertOverride,
    listUnresolvedAsks,
  };
};

const payloadFromAsk = (
  notifier: ReturnType<typeof fakeNotifier>,
  callIndex: number,
): Record<string, unknown> =>
  notifier.ask.mock.calls[callIndex]![2].payload as Record<string, unknown>;

const createCrashBatch = async (
  h: ReturnType<typeof harness>,
  registrations: readonly BatchHoldRegistration[],
  currentAskId = '',
): Promise<void> => {
  const first = registrations[0]!;
  const row = await h.batchAskStore.create({
    batch_id: 'batch-crash',
    unit_kind: 'turn',
    unit_id: first.channel_session_id,
    ingredient_slug: first.ingredient_slug,
    ...(first.operation_id !== undefined ? { operation_id: first.operation_id } : {}),
    ...(first.connection_name !== undefined ? { connection_name: first.connection_name } : {}),
    channel: first.source.channel,
    actor: first.source.actor,
    channel_session_id: first.channel_session_id,
    risk_tier: first.risk_tier,
    recipe_id: first.recipe_id,
    recipe_hash: first.recipe_hash,
    arg_shape_hash: first.arg_shape_hash,
    source: first.source,
    current_ask_id: currentAskId,
    created_at: NOW,
  }, {
    checkpoint_id: first.checkpoint.checkpoint_id,
    run_id: first.run_id,
    ...(first.action_ref !== undefined ? { action_ref: first.action_ref } : {}),
    canonical_payload_hash: first.canonical_payload_hash,
    summary: typeof first.args_preview?.to === 'string'
      ? first.args_preview.to
      : 'held action',
    ...(first.args_preview !== undefined ? { args_preview: first.args_preview } : {}),
  });
  for (const registration of registrations.slice(1)) {
    await h.batchAskStore.addMember(row.batch_id, {
      checkpoint_id: registration.checkpoint.checkpoint_id,
      run_id: registration.run_id,
      ...(registration.action_ref !== undefined
        ? { action_ref: registration.action_ref }
        : {}),
      canonical_payload_hash: registration.canonical_payload_hash,
      summary: typeof registration.args_preview?.to === 'string'
        ? registration.args_preview.to
        : 'held action',
      ...(registration.args_preview !== undefined
        ? { args_preview: registration.args_preview }
        : {}),
    }, NOW + 1);
  }
};

describe('createBatchApprovalCoordinator registerHold', () => {
  it('re-renders one ask for a fresh open row whose v1 ask never persisted', async () => {
    const cp = checkpoint(1);
    const actions = createGatedActionStore(
      createInMemoryCollection<GatedActionRecord>(),
      { newActionRef: () => 'action-fresh-crash', now: () => NOW },
    );
    const action = await actions.createHeld({
      run_id: cp.run_id,
      gated_step_id: cp.gated_step_id!,
      checkpoint_id: cp.checkpoint_id,
    });
    const h = harness({ checkpoints: [cp], gatedActionStore: actions });
    await createCrashBatch(h, [hold(1, { checkpoint: cp, action_ref: action.action_ref })]);

    await expect(h.coordinator.reconcileOpenBatch({
      checkpoint_id: cp.checkpoint_id,
    })).resolves.toEqual({
      kind: 'reconciled', ask_id: 'ask-1', raised: true,
    });

    expect(h.notifier.ask).toHaveBeenCalledTimes(1);
    expect(payloadFromAsk(h.notifier, 0)).toMatchObject({
      batch_id: 'batch-crash', payload_version: 1,
    });
    expect(await h.batchAskStore.get('batch-crash')).toMatchObject({
      state: 'open', payload_version: 1, current_ask_id: 'ask-1',
    });
    expect(await actions.get(action.action_ref)).toMatchObject({
      approval_ref: 'batch-crash', current_ask_id: 'ask-1',
    });
  });

  it('adopts an exact-version durable ask instead of rendering a duplicate', async () => {
    const cp = checkpoint(1);
    const actions = createGatedActionStore(
      createInMemoryCollection<GatedActionRecord>(),
      { newActionRef: () => 'action-surviving-ask', now: () => NOW },
    );
    const action = await actions.createHeld({
      run_id: cp.run_id,
      gated_step_id: cp.gated_step_id!,
      checkpoint_id: cp.checkpoint_id,
    });
    const exactAsk = {
      ask_id: 'ask-surviving-v1',
      handler_kind: 'gateway.preflight',
      handler_payload: { batch_id: 'batch-crash', payload_version: 1 },
    };
    const h = harness({
      checkpoints: [cp],
      gatedActionStore: actions,
      listUnresolvedAsks: vi.fn<
        () => Promise<ReadonlyArray<UnresolvedBatchAsk>>
      >().mockResolvedValue([exactAsk]),
    });
    await createCrashBatch(h, [hold(1, { checkpoint: cp, action_ref: action.action_ref })]);

    await expect(h.coordinator.reconcileOpenBatch({
      checkpoint_id: cp.checkpoint_id,
    })).resolves.toEqual({
      kind: 'reconciled', ask_id: exactAsk.ask_id, raised: false,
    });

    expect(h.notifier.ask).not.toHaveBeenCalled();
    expect(await h.batchAskStore.get('batch-crash')).toMatchObject({
      current_ask_id: exactAsk.ask_id,
    });
    expect(await actions.get(action.action_ref)).toMatchObject({
      approval_ref: 'batch-crash', current_ask_id: exactAsk.ask_id,
    });
  });

  it('re-renders the bumped JOIN version, repairs every receipt, and cancels the stale ask', async () => {
    const cp1 = checkpoint(1);
    const cp2 = checkpoint(2);
    let actionSeq = 0;
    const actions = createGatedActionStore(
      createInMemoryCollection<GatedActionRecord>(),
      { newActionRef: () => `action-join-${actionSeq += 1}`, now: () => NOW },
    );
    const first = await actions.createHeld({
      run_id: cp1.run_id, gated_step_id: cp1.gated_step_id!, checkpoint_id: cp1.checkpoint_id,
    });
    const second = await actions.createHeld({
      run_id: cp2.run_id, gated_step_id: cp2.gated_step_id!, checkpoint_id: cp2.checkpoint_id,
    });
    const oldAsk = {
      ask_id: 'ask-v1-stale',
      handler_kind: 'gateway.preflight',
      handler_payload: { batch_id: 'batch-crash', payload_version: 1 },
    };
    const h = harness({
      checkpoints: [cp1, cp2],
      gatedActionStore: actions,
      listUnresolvedAsks: vi.fn<
        () => Promise<ReadonlyArray<UnresolvedBatchAsk>>
      >().mockResolvedValue([oldAsk]),
    });
    await createCrashBatch(h, [
      hold(1, { checkpoint: cp1, action_ref: first.action_ref }),
      hold(2, { checkpoint: cp2, action_ref: second.action_ref }),
    ], oldAsk.ask_id);
    await actions.linkApproval(first.action_ref, 'batch-crash', oldAsk.ask_id);

    await expect(h.coordinator.reconcileOpenBatch({
      checkpoint_id: cp2.checkpoint_id,
    })).resolves.toEqual({
      kind: 'reconciled', ask_id: 'ask-1', raised: true,
    });

    expect(payloadFromAsk(h.notifier, 0)).toMatchObject({
      batch_id: 'batch-crash', payload_version: 2,
    });
    expect(h.cancelAsk).toHaveBeenCalledTimes(1);
    expect(h.cancelAsk).toHaveBeenCalledWith('ask-v1-stale');
    expect(await Promise.all([
      actions.get(first.action_ref),
      actions.get(second.action_ref),
    ])).toEqual([
      expect.objectContaining({ approval_ref: 'batch-crash', current_ask_id: 'ask-1' }),
      expect.objectContaining({ approval_ref: 'batch-crash', current_ask_id: 'ask-1' }),
    ]);
  });

  it('creates a row and raises a v1 ask with batch payload, session grant offer, and legacy fields', async () => {
    const h = harness();

    await expect(h.coordinator.registerHold(hold())).resolves.toEqual({
      kind: 'registered',
      ask_id: 'ask-1',
      approval_ref: 'batch-1',
    });

    expect(h.notifier.ask).toHaveBeenCalledTimes(1);
    const [message, options, handler] = h.notifier.ask.mock.calls[0]!;
    expect(message.text).toContain('user-1@example.test');
    expect(options.map((option: { id: string }) => option.id)).toEqual([
      'approve',
      'allow_session',
      'deny',
    ]);
    expect(handler.payload).toMatchObject({
      checkpoint_id: 'checkpoint-1',
      run_id: 'run-1',
      recipe_id: 'recipe-1',
      gated_step_id: 'gated-step-1',
      tool_slug: 'mail.send',
      risk_tier: 'write',
      reason: 'write tier requires approval',
      authorization_provenance: { pre_lift_approval: 'ask' },
      session_grant: {
        ttl_ms: 3_600_000,
        max_uses: 5,
        risk_tier: 'write',
      },
      batch_id: 'batch-1',
      payload_version: 1,
    });
    expect(await h.batchAskStore.get('batch-1')).toMatchObject({
      batch_id: 'batch-1',
      state: 'open',
      payload_version: 1,
      current_ask_id: 'ask-1',
      members: [
        expect.objectContaining({
          member_id: 'm1',
          checkpoint_id: 'checkpoint-1',
          canonical_payload_hash: 'payload-1',
        }),
      ],
    });
  });

  it('joins a same-key second hold, cancels the old ask after the successful v2 raise, and drops session_grant', async () => {
    const order: string[] = [];
    const h = harness({ order });

    await h.coordinator.registerHold(hold(1));
    await expect(h.coordinator.registerHold(hold(2))).resolves.toEqual({
      kind: 'registered',
      ask_id: 'ask-2',
      approval_ref: 'batch-1',
    });

    expect(order).toEqual(['ask:ask-1', 'ask:ask-2', 'cancel:ask-1']);
    const v2Payload = payloadFromAsk(h.notifier, 1);
    expect(v2Payload).toMatchObject({
      batch_id: 'batch-1',
      payload_version: 2,
      checkpoint_id: 'checkpoint-2',
    });
    expect(v2Payload).not.toHaveProperty('session_grant');
    expect(h.notifier.ask.mock.calls[1]![1].map((option: { id: string }) => option.id))
      .toEqual(['approve', 'deny']);
    expect(await h.batchAskStore.get('batch-1')).toMatchObject({
      payload_version: 2,
      current_ask_id: 'ask-2',
      members: [
        expect.objectContaining({ member_id: 'm1' }),
        expect.objectContaining({ member_id: 'm2', checkpoint_id: 'checkpoint-2' }),
      ],
    });
  });

  it('links every member receipt to one stable batch while ask ids re-render', async () => {
    const order: string[] = [];
    let actionSequence = 0;
    const actions = createGatedActionStore(
      createInMemoryCollection<GatedActionRecord>(),
      {
        newActionRef: () => `action-${actionSequence += 1}`,
        now: () => NOW,
      },
    );
    const linkApproval = actions.linkApproval.bind(actions);
    vi.spyOn(actions, 'linkApproval').mockImplementation(async (
      actionRef,
      approvalRef,
      currentAskId,
    ) => {
      order.push(`link:${actionRef}:${approvalRef}:${currentAskId ?? 'pending'}`);
      return linkApproval(actionRef, approvalRef, currentAskId);
    });
    const first = await actions.createHeld({
      run_id: 'run-1',
      gated_step_id: 'gated-step-1',
      checkpoint_id: 'checkpoint-1',
    });
    const second = await actions.createHeld({
      run_id: 'run-2',
      gated_step_id: 'gated-step-2',
      checkpoint_id: 'checkpoint-2',
    });
    const h = harness({ gatedActionStore: actions, order });

    await h.coordinator.registerHold(hold(1, { action_ref: first.action_ref }));
    expect(order.slice(0, 3)).toEqual([
      'link:action-1:batch-1:pending',
      'ask:ask-1',
      'link:action-1:batch-1:ask-1',
    ]);
    expect(await actions.get(first.action_ref)).toMatchObject({
      approval_ref: 'batch-1',
      current_ask_id: 'ask-1',
    });

    await h.coordinator.registerHold(hold(2, { action_ref: second.action_ref }));

    expect(await actions.get(first.action_ref)).toMatchObject({
      approval_ref: 'batch-1',
      current_ask_id: 'ask-2',
    });
    expect(await actions.get(second.action_ref)).toMatchObject({
      approval_ref: 'batch-1',
      current_ask_id: 'ask-2',
    });
    expect(await h.batchAskStore.get('batch-1')).toMatchObject({
      members: [
        expect.objectContaining({ action_ref: first.action_ref }),
        expect.objectContaining({ action_ref: second.action_ref }),
      ],
    });
  });

  it('does not join a facet-mismatched hold with a different arg_shape_hash', async () => {
    const h = harness();

    await h.coordinator.registerHold(hold(1));
    await h.coordinator.registerHold(hold(2, { arg_shape_hash: 'arg-shape-2' }));

    expect(h.cancelAsk).not.toHaveBeenCalled();
    const rows = await h.batchAskStore.list();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.arg_shape_hash)).toEqual([
      'arg-shape-1',
      'arg-shape-2',
    ]);
    expect(rows.map((row) => row.payload_version)).toEqual([1, 1]);
  });

  it('registers read+ask but falls back for destructive and pre-lift always', async () => {
    const h = harness();
    await expect(h.coordinator.registerHold(hold(1, {
      risk_tier: 'read',
      ask_context: {
        tool_slug: 'mail.send',
        risk_tier: 'read',
        reason: 'read tier requires approval',
        authorization_provenance: { pre_lift_approval: 'ask' },
      },
      session_grant_offer: {
        ttl_ms: 3_600_000,
        max_uses: 5,
        risk_tier: 'read',
      },
    }))).resolves.toMatchObject({ kind: 'registered' });
    await expect(h.coordinator.registerHold(hold(2, {
      risk_tier: 'destructive',
    }))).resolves.toEqual({ kind: 'fallback' });
    await expect(h.coordinator.registerHold(hold(3, {
      authorization_provenance: { pre_lift_approval: 'always' },
    }))).resolves.toEqual({ kind: 'fallback' });

    expect(await h.batchAskStore.list()).toHaveLength(1);
    expect(h.notifier.ask).toHaveBeenCalledTimes(1);
  });

  it('falls back when the same-key batch is already at the member cap', async () => {
    const h = harness();

    for (let i = 1; i <= BATCH_ASK_MAX_MEMBERS; i += 1) {
      await expect(h.coordinator.registerHold(hold(i))).resolves.toMatchObject({
        kind: 'registered',
      });
    }

    await expect(
      h.coordinator.registerHold(hold(BATCH_ASK_MAX_MEMBERS + 1)),
    ).resolves.toEqual({ kind: 'fallback' });

    expect(h.notifier.ask).toHaveBeenCalledTimes(BATCH_ASK_MAX_MEMBERS);
    expect(await h.batchAskStore.get('batch-1')).toMatchObject({
      payload_version: BATCH_ASK_MAX_MEMBERS,
      members: expect.arrayContaining([
        expect.objectContaining({ member_id: `m${BATCH_ASK_MAX_MEMBERS}` }),
      ]),
    });
  });

  it('terminalizes a fresh row and falls back when the v1 raise fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const actions = createGatedActionStore(
      createInMemoryCollection<GatedActionRecord>(),
      { newActionRef: () => 'action-fresh-fallback', now: () => NOW },
    );
    const held = await actions.createHeld({
      run_id: 'run-1',
      gated_step_id: 'gated-step-1',
      checkpoint_id: 'checkpoint-1',
    });
    const h = harness({ gatedActionStore: actions });
    h.notifier.ask.mockRejectedValueOnce(new Error('notification unavailable'));

    await expect(h.coordinator.registerHold(hold(1, {
      action_ref: held.action_ref,
    }))).resolves.toEqual({
      kind: 'fallback',
    });

    expect(await h.batchAskStore.get('batch-1')).toMatchObject({
      state: 'answered',
      payload_version: 1,
    });
    expect(await actions.get(held.action_ref)).toMatchObject({
      approval_ref: held.action_ref,
    });
    expect(await actions.get(held.action_ref)).not.toHaveProperty('current_ask_id');
    expect(warnSpy).toHaveBeenCalled();
  });

  it('adopts a fresh batch ask that persisted before its raise acknowledgement failed', async () => {
    const actions = createGatedActionStore(
      createInMemoryCollection<GatedActionRecord>(),
      { newActionRef: () => 'action-fresh-adopted', now: () => NOW },
    );
    const held = await actions.createHeld({
      run_id: 'run-1',
      gated_step_id: 'gated-step-1',
      checkpoint_id: 'checkpoint-1',
    });
    const listUnresolvedAsks = vi.fn<
      () => Promise<ReadonlyArray<UnresolvedBatchAsk>>
    >().mockResolvedValue([{
      ask_id: 'ask-persisted-v1',
      handler_kind: 'gateway.preflight',
      handler_payload: { batch_id: 'batch-1', payload_version: 1 },
    }]);
    const h = harness({ gatedActionStore: actions, listUnresolvedAsks });
    h.notifier.ask.mockRejectedValueOnce(new Error('lost acknowledgement after commit'));

    await expect(h.coordinator.registerHold(hold(1, {
      action_ref: held.action_ref,
    }))).resolves.toEqual({
      kind: 'registered',
      ask_id: 'ask-persisted-v1',
      approval_ref: 'batch-1',
    });

    expect(await h.batchAskStore.get('batch-1')).toMatchObject({
      state: 'open',
      payload_version: 1,
      current_ask_id: 'ask-persisted-v1',
    });
    expect(await actions.get(held.action_ref)).toMatchObject({
      approval_ref: 'batch-1',
      current_ask_id: 'ask-persisted-v1',
    });
  });

  it('verifies cleanup before fallback when a batch receipt link commits then throws', async () => {
    const actions = createGatedActionStore(
      createInMemoryCollection<GatedActionRecord>(),
      { newActionRef: () => 'action-ambiguous-link', now: () => NOW },
    );
    const held = await actions.createHeld({
      run_id: 'run-1',
      gated_step_id: 'gated-step-1',
      checkpoint_id: 'checkpoint-1',
    });
    const link = actions.linkApproval.bind(actions);
    const get = actions.get.bind(actions);
    let linkCalls = 0;
    vi.spyOn(actions, 'linkApproval').mockImplementation(async (...args) => {
      linkCalls += 1;
      const result = await link(...args);
      if (linkCalls === 1) throw new Error('adapter failed after commit');
      return result;
    });
    vi.spyOn(actions, 'get')
      .mockRejectedValueOnce(new Error('read-back unavailable'))
      .mockImplementation(get);
    const h = harness({ gatedActionStore: actions });

    await expect(h.coordinator.registerHold(hold(1, {
      action_ref: held.action_ref,
    }))).resolves.toEqual({ kind: 'fallback' });

    expect(h.notifier.ask).not.toHaveBeenCalled();
    expect(await h.batchAskStore.get('batch-1')).toMatchObject({ state: 'answered' });
    expect(await get(held.action_ref)).toMatchObject({
      approval_ref: held.action_ref,
    });
  });

  it('rejects without exposing an ask when standalone receipt rollback cannot be proven', async () => {
    const actions = createGatedActionStore(
      createInMemoryCollection<GatedActionRecord>(),
      { newActionRef: () => 'action-reset-fails', now: () => NOW },
    );
    const held = await actions.createHeld({
      run_id: 'run-1',
      gated_step_id: 'gated-step-1',
      checkpoint_id: 'checkpoint-1',
    });
    const link = actions.linkApproval.bind(actions);
    const get = actions.get.bind(actions);
    let linkCalls = 0;
    vi.spyOn(actions, 'linkApproval').mockImplementation(async (...args) => {
      linkCalls += 1;
      if (linkCalls === 1) {
        await link(...args);
        throw new Error('batch link outcome unavailable');
      }
      throw new Error('standalone reset unavailable');
    });
    let getCalls = 0;
    vi.spyOn(actions, 'get').mockImplementation(async (actionRef) => {
      getCalls += 1;
      if (getCalls === 1) throw new Error('first read-back unavailable');
      return get(actionRef);
    });
    const h = harness({ gatedActionStore: actions });

    await expect(h.coordinator.registerHold(hold(1, {
      action_ref: held.action_ref,
    }))).rejects.toThrow(/standalone receipt rollback failed/);

    expect(h.notifier.ask).not.toHaveBeenCalled();
    expect(await h.batchAskStore.get('batch-1')).toMatchObject({ state: 'answered' });
    expect(await get(held.action_ref)).toMatchObject({ approval_ref: 'batch-1' });
  });

  it('rolls back a joined member and falls back when the join re-raise fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let actionSequence = 0;
    const actions = createGatedActionStore(
      createInMemoryCollection<GatedActionRecord>(),
      {
        newActionRef: () => `action-rerender-${actionSequence += 1}`,
        now: () => NOW,
      },
    );
    const first = await actions.createHeld({
      run_id: 'run-1',
      gated_step_id: 'gated-step-1',
      checkpoint_id: 'checkpoint-1',
    });
    const second = await actions.createHeld({
      run_id: 'run-2',
      gated_step_id: 'gated-step-2',
      checkpoint_id: 'checkpoint-2',
    });
    const h = harness({ gatedActionStore: actions });
    h.notifier.ask.mockResolvedValueOnce({ ask_id: 'ask-1' });
    h.notifier.ask.mockRejectedValueOnce(new Error('rerender failed'));

    await h.coordinator.registerHold(hold(1, { action_ref: first.action_ref }));
    await expect(h.coordinator.registerHold(hold(2, {
      action_ref: second.action_ref,
    }))).resolves.toEqual({
      kind: 'fallback',
    });

    expect(h.cancelAsk).not.toHaveBeenCalled();
    expect(await h.batchAskStore.get('batch-1')).toMatchObject({
      state: 'open',
      payload_version: 1,
      current_ask_id: 'ask-1',
      members: [expect.objectContaining({ member_id: 'm1' })],
    });
    expect(await actions.get(first.action_ref)).toMatchObject({
      approval_ref: 'batch-1',
      current_ask_id: 'ask-1',
    });
    expect(await actions.get(second.action_ref)).toMatchObject({
      approval_ref: second.action_ref,
    });
    expect(await actions.get(second.action_ref)).not.toHaveProperty('current_ask_id');
    expect(warnSpy).toHaveBeenCalled();
  });

  it('adopts a joined batch re-render that persisted before its raise acknowledgement failed', async () => {
    let actionSequence = 0;
    const actions = createGatedActionStore(
      createInMemoryCollection<GatedActionRecord>(),
      {
        newActionRef: () => `action-rerender-adopted-${actionSequence += 1}`,
        now: () => NOW,
      },
    );
    const first = await actions.createHeld({
      run_id: 'run-1', gated_step_id: 'gated-step-1', checkpoint_id: 'checkpoint-1',
    });
    const second = await actions.createHeld({
      run_id: 'run-2', gated_step_id: 'gated-step-2', checkpoint_id: 'checkpoint-2',
    });
    const listUnresolvedAsks = vi.fn<
      () => Promise<ReadonlyArray<UnresolvedBatchAsk>>
    >().mockResolvedValue([
      {
        ask_id: 'ask-1',
        handler_kind: 'gateway.preflight',
        handler_payload: { batch_id: 'batch-1', payload_version: 1 },
      },
      {
        ask_id: 'ask-persisted-v2',
        handler_kind: 'gateway.preflight',
        handler_payload: { batch_id: 'batch-1', payload_version: 2 },
      },
    ]);
    const h = harness({ gatedActionStore: actions, listUnresolvedAsks });
    h.notifier.ask
      .mockResolvedValueOnce({ ask_id: 'ask-1' })
      .mockRejectedValueOnce(new Error('lost rerender acknowledgement after commit'));

    await h.coordinator.registerHold(hold(1, { action_ref: first.action_ref }));
    await expect(h.coordinator.registerHold(hold(2, {
      action_ref: second.action_ref,
    }))).resolves.toEqual({
      kind: 'registered',
      ask_id: 'ask-persisted-v2',
      approval_ref: 'batch-1',
    });

    expect(await h.batchAskStore.get('batch-1')).toMatchObject({
      state: 'open',
      payload_version: 2,
      current_ask_id: 'ask-persisted-v2',
      members: [
        expect.objectContaining({ action_ref: first.action_ref }),
        expect.objectContaining({ action_ref: second.action_ref }),
      ],
    });
    expect(await actions.get(first.action_ref)).toMatchObject({
      approval_ref: 'batch-1', current_ask_id: 'ask-persisted-v2',
    });
    expect(await actions.get(second.action_ref)).toMatchObject({
      approval_ref: 'batch-1', current_ask_id: 'ask-persisted-v2',
    });
    expect(h.cancelAsk).toHaveBeenCalledWith('ask-1');
  });

  it('does not expose a fallback ask when a joined-member rollback is refused', async () => {
    let actionSequence = 0;
    const actions = createGatedActionStore(
      createInMemoryCollection<GatedActionRecord>(),
      {
        newActionRef: () => `action-rollback-${actionSequence += 1}`,
        now: () => NOW,
      },
    );
    const first = await actions.createHeld({
      run_id: 'run-1', gated_step_id: 'gated-step-1', checkpoint_id: 'checkpoint-1',
    });
    const second = await actions.createHeld({
      run_id: 'run-2', gated_step_id: 'gated-step-2', checkpoint_id: 'checkpoint-2',
    });
    const h = harness({ gatedActionStore: actions });
    await h.coordinator.registerHold(hold(1, { action_ref: first.action_ref }));

    const link = actions.linkApproval.bind(actions);
    vi.spyOn(actions, 'linkApproval').mockImplementation(async (
      actionRef,
      approvalRef,
      currentAskId,
    ) => {
      if (actionRef === second.action_ref && approvalRef === 'batch-1') {
        throw new Error('second member cannot link');
      }
      return link(actionRef, approvalRef, currentAskId);
    });
    vi.spyOn(h.batchAskStore, 'removeMember').mockResolvedValue('not_rolled_back');

    await expect(h.coordinator.registerHold(hold(2, {
      action_ref: second.action_ref,
    }))).rejects.toThrow(/could not be rolled back/);

    expect(h.notifier.ask).toHaveBeenCalledTimes(1);
    expect(await h.batchAskStore.get('batch-1')).toMatchObject({
      payload_version: 2,
      members: [
        expect.objectContaining({ action_ref: first.action_ref }),
        expect.objectContaining({ action_ref: second.action_ref }),
      ],
    });
  });

  it('keeps a raised batch ask authoritative when its presentation pointer write fails', async () => {
    const actions = createGatedActionStore(
      createInMemoryCollection<GatedActionRecord>(),
      { newActionRef: () => 'action-pointer-fails', now: () => NOW },
    );
    const held = await actions.createHeld({
      run_id: 'run-1', gated_step_id: 'gated-step-1', checkpoint_id: 'checkpoint-1',
    });
    const h = harness({ gatedActionStore: actions });
    vi.spyOn(h.batchAskStore, 'setCurrentAsk')
      .mockRejectedValue(new Error('pointer store unavailable'));

    await expect(h.coordinator.registerHold(hold(1, {
      action_ref: held.action_ref,
    }))).resolves.toEqual({
      kind: 'registered',
      ask_id: 'ask-1',
      approval_ref: 'batch-1',
    });

    expect(h.notifier.ask).toHaveBeenCalledTimes(1);
    expect(await actions.get(held.action_ref)).toMatchObject({
      approval_ref: 'batch-1',
      current_ask_id: 'ask-1',
    });
    expect(await h.batchAskStore.get('batch-1')).toMatchObject({
      state: 'open',
      current_ask_id: '',
    });
  });
});

describe('createBatchApprovalCoordinator handleAnswer', () => {
  it('denies every member, consumes checkpoints, and marks the row answered', async () => {
    const cp1 = checkpoint(1);
    const cp2 = checkpoint(2);
    const h = harness({ checkpoints: [cp1, cp2] });
    await h.coordinator.registerHold(hold(1, { checkpoint: cp1 }));
    await h.coordinator.registerHold(hold(2, { checkpoint: cp2 }));

    await expect(
      h.coordinator.hooks.handleAnswer(payloadFromAsk(h.notifier, 1), answer('deny')),
    ).resolves.toBe('handled');

    expect(h.resumer.denyRun).toHaveBeenCalledTimes(2);
    expect(h.resumer.denyRun.mock.calls.map((call) => call[0].checkpoint_id)).toEqual([
      'checkpoint-1',
      'checkpoint-2',
    ]);
    expect(h.checkpointStore.delete).toHaveBeenCalledWith('checkpoint-1');
    expect(h.checkpointStore.delete).toHaveBeenCalledWith('checkpoint-2');
    expect(await h.batchAskStore.get('batch-1')).toMatchObject({
      state: 'answered',
      answer_option: 'deny',
    });
  });

  it('approves a single member without a batch claim and threads allow_session through readSessionGrantPayload', async () => {
    const cp = checkpoint(1);
    const h = harness({ checkpoints: [cp] });
    await h.coordinator.registerHold(hold(1, { checkpoint: cp }));

    await expect(
      h.coordinator.hooks.handleAnswer(
        payloadFromAsk(h.notifier, 0),
        answer('allow_session'),
      ),
    ).resolves.toBe('handled');

    expect(h.sessionGrantResolver.mintBatch).not.toHaveBeenCalled();
    expect(h.resumer.resumeRun).toHaveBeenCalledTimes(1);
    const [, context] = h.resumer.resumeRun.mock.calls[0]!;
    expect(context).toMatchObject({
      recipe_id: 'recipe-1',
      gated_step_id: 'gated-step-1',
      tool_slug: 'mail.send',
      risk_tier: 'write',
      approved_at: NOW + 50_000,
      session_grant: {
        ttl_ms: 3_600_000,
        max_uses: 5,
        risk_tier: 'write',
      },
    } satisfies Partial<PreflightAskContext>);
    expect(context).not.toHaveProperty('batch_claim');
    expect(h.checkpointStore.delete).toHaveBeenCalledWith('checkpoint-1');
  });

  it('approves multiple members by minting one batch grant and resuming each member with its claim', async () => {
    const cp1 = checkpoint(1);
    const cp2 = checkpoint(2);
    const h = harness({ checkpoints: [cp1, cp2] });
    await h.coordinator.registerHold(hold(1, { checkpoint: cp1 }));
    await h.coordinator.registerHold(hold(2, { checkpoint: cp2 }));

    await expect(
      h.coordinator.hooks.handleAnswer(payloadFromAsk(h.notifier, 1), answer('approve')),
    ).resolves.toBe('handled');

    expect(h.sessionGrantResolver.mintBatch).toHaveBeenCalledTimes(1);
    expect(h.sessionGrantResolver.mintBatch).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'chat',
      actor: 'user_self',
      channel_session_id: 'chat-1',
      ingredient_slug: 'mail.send',
      operation_id: 'mail.send',
      connection_name: 'gmail-primary',
      recipe_id: 'recipe-1',
      recipe_hash: 'recipe-hash-1',
      arg_shape_hash: 'arg-shape-1',
      risk_tier: 'write',
      approved_action_ref: 'batch-1',
      members: [
        { member_id: 'm1', canonical_payload_hash: 'payload-1' },
        { member_id: 'm2', canonical_payload_hash: 'payload-2' },
      ],
    }));
    expect(h.resumer.resumeRun).toHaveBeenCalledTimes(2);
    expect(h.resumer.resumeRun.mock.calls.map((call) => call[1].approved_at)).toEqual([
      NOW + 50_000,
      NOW + 50_000,
    ]);
    expect(h.resumer.resumeRun.mock.calls.map((call) => call[1].batch_claim)).toEqual([
      { contract_id: 'batch-grant-1', member_id: 'm1' },
      { contract_id: 'batch-grant-1', member_id: 'm2' },
    ]);
    expect(h.checkpointStore.delete).toHaveBeenCalledWith('checkpoint-1');
    expect(h.checkpointStore.delete).toHaveBeenCalledWith('checkpoint-2');
    expect(await h.batchAskStore.get('batch-1')).toMatchObject({ state: 'answered' });
  });

  it('resumes multiple approved members without batch_claim when mintBatch returns undefined', async () => {
    const resolver = fakeSessionGrantResolver();
    resolver.mintBatch.mockReturnValue(undefined);
    const cp1 = checkpoint(1);
    const cp2 = checkpoint(2);
    const h = harness({ checkpoints: [cp1, cp2], sessionGrantResolver: resolver });
    await h.coordinator.registerHold(hold(1, { checkpoint: cp1 }));
    await h.coordinator.registerHold(hold(2, { checkpoint: cp2 }));

    await expect(
      h.coordinator.hooks.handleAnswer(payloadFromAsk(h.notifier, 1), answer('approve')),
    ).resolves.toBe('handled');

    expect(h.sessionGrantResolver.mintBatch).toHaveBeenCalledTimes(1);
    expect(h.resumer.resumeRun).toHaveBeenCalledTimes(2);
    for (const [, context] of h.resumer.resumeRun.mock.calls) {
      expect(context).not.toHaveProperty('batch_claim');
    }
    expect(await h.batchAskStore.get('batch-1')).toMatchObject({ state: 'answered' });
  });

  it('handles stale versions without resuming or marking answered', async () => {
    const h = harness({ checkpoints: [checkpoint(1), checkpoint(2)] });
    await h.coordinator.registerHold(hold(1));
    await h.coordinator.registerHold(hold(2));
    const stalePayload = payloadFromAsk(h.notifier, 0);
    const markAnswered = vi.spyOn(h.batchAskStore, 'markAnswered');

    await expect(
      h.coordinator.hooks.handleAnswer(stalePayload, answer('approve')),
    ).resolves.toBe('handled');

    expect(h.resumer.resumeRun).not.toHaveBeenCalled();
    expect(h.resumer.denyRun).not.toHaveBeenCalled();
    expect(markAnswered).not.toHaveBeenCalled();
    expect(await h.batchAskStore.get('batch-1')).toMatchObject({
      state: 'open',
      payload_version: 2,
    });
  });

  it('version-guards a standing-ruling answer before persisting it', async () => {
    const offer = {
      kind: 'relax_to_ask' as const,
      ingredient_id: 'mail.send',
      operation_id: 'mail.send',
      op_hash: 'a'.repeat(64),
      approval: 'ask' as const,
    };
    const h = harness({ checkpoints: [checkpoint(1), checkpoint(2)] });
    await h.coordinator.registerHold(hold(1, {
      ask_context: {
        tool_slug: 'mail.send',
        risk_tier: 'write',
        owner_override_offer: offer,
      },
    }));
    const stalePayload = payloadFromAsk(h.notifier, 0);
    await h.coordinator.registerHold(hold(2, {
      ask_context: {
        tool_slug: 'mail.send',
        risk_tier: 'write',
        owner_override_offer: offer,
      },
    }));

    await expect(h.coordinator.hooks.handleAnswer(
      stalePayload,
      answer(RELAX_OPERATION_TO_ASK_OPTION_ID),
    )).resolves.toBe('handled');

    expect(h.upsertOverride).not.toHaveBeenCalled();
    expect(h.resumer.resumeRun).not.toHaveBeenCalled();
    expect(await h.batchAskStore.get('batch-1')).toMatchObject({
      state: 'open',
      payload_version: 2,
    });
  });

  it('persists a live standing ruling and treats the held call as approved', async () => {
    const cp = checkpoint(1);
    const offer = {
      kind: 'relax_to_ask' as const,
      ingredient_id: 'mail.send',
      operation_id: 'mail.send',
      op_hash: 'a'.repeat(64),
      approval: 'ask' as const,
    };
    const h = harness({ checkpoints: [cp] });
    await h.coordinator.registerHold(hold(1, {
      checkpoint: cp,
      ask_context: {
        tool_slug: 'mail.send',
        risk_tier: 'write',
        owner_override_offer: offer,
      },
    }));

    await expect(h.coordinator.hooks.handleAnswer(
      payloadFromAsk(h.notifier, 0),
      answer(RELAX_OPERATION_TO_ASK_OPTION_ID),
    )).resolves.toBe('handled');

    expect(h.upsertOverride).toHaveBeenCalledWith(offer);
    expect(h.resumer.resumeRun).toHaveBeenCalledTimes(1);
    expect(h.resumer.denyRun).not.toHaveBeenCalled();
    expect(await h.batchAskStore.get('batch-1')).toMatchObject({
      state: 'answered',
      answer_option: RELAX_OPERATION_TO_ASK_OPTION_ID,
    });
  });

  it('re-enters a closing same-version answer and skips missing checkpoints gracefully', async () => {
    const h = harness();
    await h.coordinator.registerHold(hold(1));
    await h.coordinator.registerHold(hold(2));
    const payload = payloadFromAsk(h.notifier, 1);
    await h.batchAskStore.close('batch-1', 2, 'approve', NOW + 60_000);

    await expect(
      h.coordinator.hooks.handleAnswer(payload, answer('approve')),
    ).resolves.toBe('handled');

    expect(h.checkpointStore.get).toHaveBeenCalledWith('checkpoint-1');
    expect(h.checkpointStore.get).toHaveBeenCalledWith('checkpoint-2');
    expect(h.resumer.resumeRun).not.toHaveBeenCalled();
    expect(h.checkpointStore.delete).not.toHaveBeenCalled();
    expect(await h.batchAskStore.get('batch-1')).toMatchObject({
      state: 'answered',
      answer_option: 'approve',
    });
  });

  it('falls back when a v1 answer references a missing batch row', async () => {
    const h = harness();

    await expect(
      h.coordinator.hooks.handleAnswer(
        { batch_id: 'missing-batch', payload_version: 1 },
        answer('approve'),
      ),
    ).resolves.toBe('fallback');

    expect(h.resumer.resumeRun).not.toHaveBeenCalled();
    expect(h.sessionGrantResolver.mintBatch).not.toHaveBeenCalled();
  });

  it('handles a v2 answer for a missing row without resuming', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const h = harness();

    await expect(
      h.coordinator.hooks.handleAnswer(
        { batch_id: 'missing-batch', payload_version: 2 },
        answer('approve'),
      ),
    ).resolves.toBe('handled');

    expect(h.resumer.resumeRun).not.toHaveBeenCalled();
    expect(h.resumer.denyRun).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('propagates a mid-loop resumeRun failure without marking the batch answered', async () => {
    const cp1 = checkpoint(1);
    const cp2 = checkpoint(2);
    const h = harness({ checkpoints: [cp1, cp2] });
    await h.coordinator.registerHold(hold(1, { checkpoint: cp1 }));
    await h.coordinator.registerHold(hold(2, { checkpoint: cp2 }));
    h.resumer.resumeRun
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('resume failed'));
    const markAnswered = vi.spyOn(h.batchAskStore, 'markAnswered');

    await expect(
      h.coordinator.hooks.handleAnswer(payloadFromAsk(h.notifier, 1), answer('approve')),
    ).rejects.toThrow('resume failed');

    expect(h.resumer.resumeRun).toHaveBeenCalledTimes(2);
    expect(h.checkpointStore.delete).toHaveBeenCalledWith('checkpoint-1');
    expect(h.checkpointStore.delete).not.toHaveBeenCalledWith('checkpoint-2');
    expect(markAnswered).not.toHaveBeenCalled();
    expect(await h.batchAskStore.get('batch-1')).toMatchObject({
      state: 'closing',
      answer_option: 'approve',
    });
  });
});
