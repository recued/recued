/** D-157 server-wiring - awaiting preflight checkpoint boot sweep. */

import type { Checkpoint } from '@recued/contracts';
import type { PreflightNotifier } from '@recued/gateway';
import { NEVER_ASK_OPERATION_OPTION_ID } from '@recued/gateway';
import {
  buildAuditEntry,
  createAuditLogStore,
  createInMemoryCollection,
  type ActivityEntry,
  type AuditEntry,
  type AuditLogStore,
  type CheckpointStore,
} from '@recued/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sweepAwaitingCheckpoints } from '../preflight-boot-sweep.js';
import {
  createGatedActionStore,
  type GatedActionRecord,
  type GatedActionStore,
} from '../gated-action-store.js';

const NOW = Date.parse('2026-05-22T18:00:00.000Z');

const checkpoint = (overrides: Partial<Checkpoint> = {}): Checkpoint => ({
  checkpoint_id: 'checkpoint-1',
  run_id: 'run-1',
  recipe_id: 'recipe-1',
  gated_step_id: 'gated_step',
  step_state: {},
  created_at: NOW,
  ...overrides,
});

const rawCheckpoint = (overrides: Partial<Checkpoint> = {}): Checkpoint => ({
  checkpoint_id: 'checkpoint-raw-1',
  run_id: 'run-raw-1',
  step_state: {},
  preflight_context: {
    tool_slug: 'deal.create',
    connection_name: 'main-crm',
    risk_tier: 'write',
    reason: 'requires approval',
    egress_bound: { requests: 1, total_bytes: 4096 },
    gated_action_settlement_mode: 'returned_result',
  },
  raw_op: {
    op_id: 'recued-core.hubspot-pack.deal.create',
    catalog_slug: 'hubspot-catalog',
    operation: 'deal.create',
    connection_name: 'main-crm',
    op_args: { dealname: 'Acme' },
    execution_source: {
      channel: 'mcp',
      actor: 'contracted_user',
      agent_id: 'agent-door-1',
      tool_call_id: 'mcp-call-1',
      mcp_token_id: 'token-1',
      contract_id: 'contract-1',
    },
    risk_tier: 'write',
  },
  created_at: NOW,
  ...overrides,
});

const checkpointStore = (
  checkpoints: Checkpoint[],
): CheckpointStore & { list: ReturnType<typeof vi.fn> } => ({
  write: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
  listByRun: vi.fn(),
  list: vi.fn().mockResolvedValue(checkpoints),
  size: vi.fn().mockResolvedValue(checkpoints.length),
}) as unknown as CheckpointStore & { list: ReturnType<typeof vi.fn> };

const auditLog = (): AuditLogStore =>
  createAuditLogStore(
    createInMemoryCollection<AuditEntry>(),
    createInMemoryCollection<ActivityEntry>(),
  );

const anchor = (
  overrides: Partial<AuditEntry> = {},
): AuditEntry => ({
  ...buildAuditEntry({
    recipe_id: 'recipe-1',
    recipe_hash: 'hash-1',
    commit_status: 'awaiting_approval',
    duration_ms: 50,
    errors: [],
    config_snapshot: {},
    trigger_url: null,
    trigger_source: 'manual',
    instance_id: 'server-1',
    run_id: 'run-1',
    now: NOW,
    checkpoint_id: 'checkpoint-1',
  }),
  ...overrides,
});

const continuityFields: Partial<AuditEntry> = {
  context_snapshot: { entity_id: 'deal-1', event: { payload: { amount: 7 } } },
  dish_id: 'dish-1',
  exchange_ref: 'exchange-1',
  exchange_callback_op: 'peer.answer',
  exchange_expected_contract_id: 'contract-1',
  granted_by_recipe: 'seller/workflow-1',
  idempotency_key: 'idempotency-1',
  predecessor_commit_id: 'commit-0',
  execution_source: {
    channel: 'mcp',
    actor: 'contracted_user',
    agent_id: 'agent-1',
    tool_call_id: 'call-1',
    mcp_token_id: 'token-1',
    contract_id: 'contract-1',
  },
  contract_snapshot: {
    contract_id: 'contract-1',
    contract_version: 'v1',
    allowed_tools: ['seller/workflow-1'],
    approval_required: ['write'],
    scope_restrictions: [],
    resolved_at: NOW,
  },
};

const append = async (
  log: AuditLogStore,
  entry: AuditEntry,
): Promise<void> => {
  await log.append(entry);
};

const notifier = (
  askImpl: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue({ ask_id: 'ask-new' }),
): PreflightNotifier & { ask: ReturnType<typeof vi.fn> } => ({
  ask: askImpl,
  registerAskHandler: vi.fn(),
}) as unknown as PreflightNotifier & { ask: ReturnType<typeof vi.fn> };

const gatedActionStore = () => {
  const action = {
    action_ref: 'action-raw-1',
    approval_ref: 'action-raw-1',
    status: 'awaiting_approval' as const,
  };
  return {
    action,
    store: {
      getByCheckpoint: vi.fn().mockResolvedValue(null),
      createHeld: vi.fn().mockResolvedValue(action),
      linkApproval: vi.fn().mockImplementation(async (
        _actionRef: string,
        approvalRef: string,
        currentAskId?: string | null,
      ) => ({
        ...action,
        approval_ref: approvalRef,
        ...(typeof currentAskId === 'string'
          ? { current_ask_id: currentAskId }
          : {}),
      })),
    } as unknown as GatedActionStore,
  };
};

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe('sweepAwaitingCheckpoints', () => {
  it('reconstructs a raw-op receipt and re-raises its ask when none survived', async () => {
    const notes = notifier();
    const actions = gatedActionStore();
    const listUnresolvedAsks = vi.fn().mockResolvedValue([]);

    const result = await sweepAwaitingCheckpoints({
      checkpointStore: checkpointStore([rawCheckpoint()]),
      auditLog: auditLog(),
      notifier: notes,
      gatedActionStore: actions.store,
      listUnresolvedAsks,
    });

    expect(result).toMatchObject({
      inspected: 1,
      raised: 1,
      alreadyPaired: 0,
      failed: 0,
      orphaned: 0,
      superseded: 0,
    });
    expect(actions.store.createHeld).toHaveBeenCalledWith({
      run_id: 'run-raw-1',
      gated_step_id: 'raw_op',
      checkpoint_id: 'checkpoint-raw-1',
      ingredient_slug: 'hubspot-catalog',
      operation_id: 'deal.create',
      connection_name: 'main-crm',
      approved_bound: { requests: 1, total_bytes: 4096 },
      settlement_mode: 'returned_result',
    });
    expect(notes.ask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining('recued-core.hubspot-pack.deal.create'),
        text: expect.stringContaining('main-crm'),
      }),
      expect.any(Array),
      expect.objectContaining({
        kind: 'gateway.preflight',
        payload: expect.objectContaining({
          checkpoint_id: 'checkpoint-raw-1',
          run_id: 'run-raw-1',
          raw_op_id: 'recued-core.hubspot-pack.deal.create',
        }),
      }),
    );
    expect(actions.store.linkApproval).toHaveBeenCalledWith(
      'action-raw-1',
      'action-raw-1',
      'ask-new',
    );
  });

  it('links a surviving raw-op ask without raising a duplicate', async () => {
    const notes = notifier();
    const actions = gatedActionStore();
    const listUnresolvedAsks = vi.fn().mockResolvedValue([
      {
        ask_id: 'ask-existing',
        handler_kind: 'gateway.preflight',
        handler_payload: { checkpoint_id: 'checkpoint-raw-1' },
      },
    ]);

    const result = await sweepAwaitingCheckpoints({
      checkpointStore: checkpointStore([rawCheckpoint()]),
      auditLog: auditLog(),
      notifier: notes,
      gatedActionStore: actions.store,
      listUnresolvedAsks,
    });

    expect(result).toMatchObject({
      inspected: 1,
      raised: 0,
      alreadyPaired: 1,
      failed: 0,
      orphaned: 0,
    });
    expect(notes.ask).not.toHaveBeenCalled();
    expect(actions.store.linkApproval).toHaveBeenCalledWith(
      'action-raw-1',
      'action-raw-1',
      'ask-existing',
    );
  });

  it('fails raw-op recovery closed when open asks cannot be read', async () => {
    const notes = notifier();
    const actions = gatedActionStore();

    const result = await sweepAwaitingCheckpoints({
      checkpointStore: checkpointStore([rawCheckpoint()]),
      auditLog: auditLog(),
      notifier: notes,
      gatedActionStore: actions.store,
      listUnresolvedAsks: vi.fn().mockRejectedValue(new Error('ask store unavailable')),
    });

    expect(result).toMatchObject({ raised: 0, alreadyPaired: 0, failed: 1 });
    expect(notes.ask).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(
      'raw-op ask lookup failed',
    ));
  });

  it('does not expose a raw-op ask until its durable receipt exists', async () => {
    const notes = notifier();
    const actions = gatedActionStore();
    actions.store.createHeld = vi.fn().mockRejectedValue(new Error('receipt down'));

    const result = await sweepAwaitingCheckpoints({
      checkpointStore: checkpointStore([rawCheckpoint()]),
      auditLog: auditLog(),
      notifier: notes,
      gatedActionStore: actions.store,
      listUnresolvedAsks: vi.fn().mockResolvedValue([]),
    });

    expect(result).toMatchObject({ raised: 0, failed: 1 });
    expect(notes.ask).not.toHaveBeenCalled();
  });

  it('⛔ counts a PEER hold apart from terminal, and raises nothing — D-234 § 234.4', async () => {
    // A peer hold is skipped here for a good reason — this sweep re-raises
    // PREFLIGHT asks, and a run waiting on another server's owner has no local
    // ask to re-raise; its answer arrives over the wire. But it is NOT terminal,
    // and folding it into that counter makes an accumulating backlog of live
    // conversations read as an accumulating backlog of dead rows.
    //
    // ⚠ The ordering is what this pins: the peer branch must precede the
    // `!== 'awaiting_approval'` branch, or the hold is silently absorbed by it
    // and the counter is right by accident in one direction only.
    const log = auditLog();
    await append(log, anchor({ commit_status: 'awaiting_peer' }));
    const notes = notifier();

    const result = await sweepAwaitingCheckpoints({
      checkpointStore: checkpointStore([checkpoint()]),
      auditLog: log,
      notifier: notes,
    });

    expect(result.heldForPeer).toBe(1);
    expect(result.terminal).toBe(0);
    expect(result.raised).toBe(0);
    expect(notes.ask).not.toHaveBeenCalled();
  });

  it('repairs an awaiting-peer anchor from its known failed operation receipt', async () => {
    const log = auditLog();
    await append(log, anchor({ commit_status: 'awaiting_peer' }));
    const actions = createGatedActionStore(
      createInMemoryCollection<GatedActionRecord>(),
      { now: () => NOW + 100, newActionRef: () => 'action-peer-failed' },
    );
    const held = await actions.createHeld({
      run_id: 'run-1',
      recipe_id: 'recipe-1',
      gated_step_id: 'gated_step',
      checkpoint_id: 'approved-checkpoint',
      ingredient_slug: 'core.peer.ask',
    });
    await actions.finish(held.action_ref, {
      status: 'failed',
      status_message: 'The approved question was not sent because the peer outbox is unavailable.',
      result: {
        exchange_ref: 'exchange-1',
        status: 'failed',
        reason: 'peer_outbox_unavailable',
      },
      observed: { items: 1, succeeded: 0, failed: 1 },
    });
    const checkpoints = checkpointStore([checkpoint()]);

    const result = await sweepAwaitingCheckpoints({
      checkpointStore: checkpoints,
      auditLog: log,
      notifier: notifier(),
      gatedActionStore: actions,
    });

    expect(result).toMatchObject({
      repairedPeerFailures: 1,
      heldForPeer: 0,
      failed: 0,
    });
    expect(await log.get('run-1')).toMatchObject({
      commit_status: 'failed',
      errors: [expect.objectContaining({
        code: 'INGREDIENT_ADAPTER_ALL_FAILED',
        source: expect.objectContaining({
          step_id: 'gated_step',
          ingredient_slug: 'core.peer.ask',
        }),
      })],
    });
    expect(checkpoints.delete).toHaveBeenCalledWith('checkpoint-1');
  });

  it('leaves a peer checkpoint durable when failed-receipt anchor repair cannot land', async () => {
    const log = auditLog();
    await append(log, anchor({ commit_status: 'awaiting_peer' }));
    vi.spyOn(log, 'append').mockRejectedValueOnce(new Error('audit unavailable'));
    const actions = createGatedActionStore(
      createInMemoryCollection<GatedActionRecord>(),
      { now: () => NOW + 100, newActionRef: () => 'action-peer-retry' },
    );
    const held = await actions.createHeld({
      run_id: 'run-1',
      recipe_id: 'recipe-1',
      gated_step_id: 'gated_step',
      checkpoint_id: 'approved-checkpoint',
    });
    await actions.finish(held.action_ref, {
      status: 'failed',
      status_message: 'The peer outbox write failed.',
      result: {
        exchange_ref: 'exchange-1',
        status: 'failed',
        reason: 'peer_outbox_write_failed',
      },
    });
    const checkpoints = checkpointStore([checkpoint()]);

    const result = await sweepAwaitingCheckpoints({
      checkpointStore: checkpoints,
      auditLog: log,
      notifier: notifier(),
      gatedActionStore: actions,
    });

    expect(result).toMatchObject({
      repairedPeerFailures: 0,
      heldForPeer: 0,
      failed: 1,
    });
    expect((await log.get('run-1'))?.commit_status).toBe('awaiting_peer');
    expect(checkpoints.delete).not.toHaveBeenCalled();
  });

  it('re-raises notification.ask and pins the new ask_id', async () => {
    const log = auditLog();
    await append(log, anchor(continuityFields));
    const notes = notifier();

    const result = await sweepAwaitingCheckpoints({
      checkpointStore: checkpointStore([checkpoint()]),
      auditLog: log,
      notifier: notes,
    });

    expect(result).toEqual({
      inspected: 1,
      alreadyPaired: 0,
      raised: 1,
      failed: 0,
      orphaned: 0,
      superseded: 0,
      // D-234 § 234.4 — peer holds are counted apart from `terminal`; they are
      // skipped for the same reason (nothing local to re-raise) but are LIVE.
      heldForPeer: 0,
      repairedPeerFailures: 0,
      terminal: 0,
      // D-210 Phase C — holds left ask-less on purpose because the owner's
      // fanout mode is 'notify'. Zero here: no mode resolver is wired, so
      // the sweep re-raises everything ask-less exactly as before.
      leftPassive: 0,
    });
    expect(notes.ask).toHaveBeenCalledTimes(1);
    expect(notes.ask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Approval required',
        text: expect.stringContaining('recipe-1'),
      }),
      expect.any(Array),
      expect.objectContaining({
        kind: 'gateway.preflight',
        payload: expect.objectContaining({
          checkpoint_id: 'checkpoint-1',
          run_id: 'run-1',
        }),
      }),
    );
    expect(await log.get('run-1')).toMatchObject({
      commit_status: 'awaiting_approval',
      checkpoint_id: 'checkpoint-1',
      ask_id: 'ask-new',
      ...continuityFields,
    });
  });

  it('repairs a surviving recipe ask instead of minting a duplicate render', async () => {
    const log = auditLog();
    await append(log, anchor(continuityFields));
    const notes = notifier();
    const actions = createGatedActionStore(
      createInMemoryCollection<GatedActionRecord>(),
      { now: () => NOW, newActionRef: () => 'action-recipe-1' },
    );
    const held = await actions.createHeld({
      run_id: 'run-1',
      recipe_id: 'recipe-1',
      gated_step_id: 'gated_step',
      checkpoint_id: 'checkpoint-1',
    });

    const result = await sweepAwaitingCheckpoints({
      checkpointStore: checkpointStore([checkpoint()]),
      auditLog: log,
      notifier: notes,
      gatedActionStore: actions,
      listUnresolvedAsks: vi.fn().mockResolvedValue([{
        ask_id: 'ask-survived-commit-error',
        handler_kind: 'gateway.preflight',
        handler_payload: {
          checkpoint_id: 'checkpoint-1',
          run_id: 'run-1',
        },
      }]),
    });

    expect(result).toMatchObject({ alreadyPaired: 1, raised: 0, failed: 0 });
    expect(notes.ask).not.toHaveBeenCalled();
    expect(await log.get('run-1')).toMatchObject({
      checkpoint_id: 'checkpoint-1',
      ask_id: 'ask-survived-commit-error',
      ...continuityFields,
    });
    expect(await actions.get(held.action_ref)).toMatchObject({
      approval_ref: held.action_ref,
      current_ask_id: 'ask-survived-commit-error',
    });
  });

  it('rebuilds a later same-step segment without renewing its predecessor', async () => {
    const log = auditLog();
    await append(log, anchor({ checkpoint_id: 'checkpoint-segment-2' }));
    const notes = notifier();
    let actionSequence = 0;
    const actions = createGatedActionStore(
      createInMemoryCollection<GatedActionRecord>(),
      {
        now: () => NOW,
        newActionRef: () => `action-segment-${actionSequence += 1}`,
      },
    );
    const predecessor = await actions.createHeld({
      run_id: 'run-1',
      recipe_id: 'recipe-1',
      gated_step_id: 'gated_step',
      checkpoint_id: 'checkpoint-segment-1',
    });
    await actions.finish(predecessor.action_ref, {
      status: 'in_doubt',
      status_message: 'The previous dispatch was interrupted.',
      result: { interrupted: true },
      observed: { items: 1, succeeded: 0, failed: 0 },
    });

    const result = await sweepAwaitingCheckpoints({
      checkpointStore: checkpointStore([checkpoint({
        checkpoint_id: 'checkpoint-segment-2',
        gated_action_predecessor_ref: predecessor.action_ref,
        foreach_progress: {
          step_id: 'gated_step',
          next_index: 1,
          source_length: 2,
          source_hash: '1'.repeat(64),
          results: [{ ok: true, item: { id: 'a' }, result: { sent: true } }],
        },
      })]),
      auditLog: log,
      notifier: notes,
      gatedActionStore: actions,
      listUnresolvedAsks: vi.fn().mockResolvedValue([]),
    });

    const current = await actions.getBySubject('run-1', 'gated_step');
    expect(result).toMatchObject({ raised: 1, failed: 0 });
    expect(await actions.get(predecessor.action_ref)).toMatchObject({
      action_ref: 'action-segment-1',
      status: 'in_doubt',
      current_checkpoint_id: 'checkpoint-segment-1',
    });
    expect(current).toMatchObject({
      action_ref: 'action-segment-2',
      status: 'awaiting_approval',
      current_checkpoint_id: 'checkpoint-segment-2',
      current_ask_id: 'ask-new',
    });
    expect(notes.ask).toHaveBeenCalledTimes(1);
    expect(await actions.list()).toHaveLength(2);
  });

  it('fails receipt-backed recipe recovery closed when unresolved asks cannot be read', async () => {
    const log = auditLog();
    await append(log, anchor());
    const notes = notifier();
    const actions = createGatedActionStore(
      createInMemoryCollection<GatedActionRecord>(),
      { now: () => NOW, newActionRef: () => 'action-recipe-lookup-fail' },
    );
    await actions.createHeld({
      run_id: 'run-1',
      recipe_id: 'recipe-1',
      gated_step_id: 'gated_step',
      checkpoint_id: 'checkpoint-1',
    });

    const result = await sweepAwaitingCheckpoints({
      checkpointStore: checkpointStore([checkpoint()]),
      auditLog: log,
      notifier: notes,
      gatedActionStore: actions,
      listUnresolvedAsks: vi.fn().mockRejectedValue(new Error('ask index down')),
    });

    expect(result).toMatchObject({ alreadyPaired: 0, raised: 0, failed: 1 });
    expect(notes.ask).not.toHaveBeenCalled();
    expect(await log.get('run-1')).not.toHaveProperty('ask_id');
  });

  it('leaves an ask-less checkpoint in its live batch decision group', async () => {
    const log = auditLog();
    await append(log, anchor());
    const actions = createGatedActionStore(
      createInMemoryCollection<GatedActionRecord>(),
      { now: () => NOW, newActionRef: () => 'action-batch-1' },
    );
    const held = await actions.createHeld({
      run_id: 'run-1',
      recipe_id: 'recipe-1',
      gated_step_id: 'gated_step',
      checkpoint_id: 'checkpoint-1',
    });
    await actions.linkApproval(held.action_ref, 'batch-1', null);
    const notes = notifier();
    const reconcileOpenBatch = vi.fn().mockImplementation(async () => {
      await actions.linkApproval(held.action_ref, 'batch-1', 'ask-batch-1');
      return { kind: 'reconciled' as const, ask_id: 'ask-batch-1', raised: false };
    });

    const result = await sweepAwaitingCheckpoints({
      checkpointStore: checkpointStore([checkpoint()]),
      auditLog: log,
      notifier: notes,
      gatedActionStore: actions,
      getBatch: vi.fn().mockResolvedValue({
        state: 'open',
        current_ask_id: 'ask-batch-1',
        answer_option: undefined,
        members: [{
          member_id: 'm1',
          checkpoint_id: 'checkpoint-1',
          run_id: 'run-1',
          action_ref: held.action_ref,
          canonical_payload_hash: 'hash',
          summary: 'send mail',
        }],
      }),
      reconcileOpenBatch,
    });

    expect(result).toMatchObject({ alreadyPaired: 1, raised: 0, failed: 0 });
    expect(notes.ask).not.toHaveBeenCalled();
    expect(reconcileOpenBatch).toHaveBeenCalledOnce();
    expect(await actions.get(held.action_ref)).toMatchObject({
      approval_ref: 'batch-1',
      current_ask_id: 'ask-batch-1',
    });
  });

  it('defers an open batch when group repair fails instead of raising a standalone ask', async () => {
    const log = auditLog();
    await append(log, anchor());
    const actions = createGatedActionStore(
      createInMemoryCollection<GatedActionRecord>(),
      { now: () => NOW, newActionRef: () => 'action-batch-deferred' },
    );
    const held = await actions.createHeld({
      run_id: 'run-1',
      recipe_id: 'recipe-1',
      gated_step_id: 'gated_step',
      checkpoint_id: 'checkpoint-1',
    });
    await actions.linkApproval(held.action_ref, 'batch-deferred', null);
    const notes = notifier();

    const result = await sweepAwaitingCheckpoints({
      checkpointStore: checkpointStore([checkpoint()]),
      auditLog: log,
      notifier: notes,
      gatedActionStore: actions,
      getBatch: vi.fn().mockResolvedValue({
        state: 'open',
        current_ask_id: '',
        answer_option: undefined,
        members: [{
          member_id: 'm1',
          checkpoint_id: 'checkpoint-1',
          run_id: 'run-1',
          action_ref: held.action_ref,
          canonical_payload_hash: 'hash',
          summary: 'send mail',
        }],
      }),
      reconcileOpenBatch: vi.fn().mockRejectedValue(new Error('ask index down')),
    });

    expect(result).toMatchObject({ raised: 0, alreadyPaired: 0, failed: 1 });
    expect(notes.ask).not.toHaveBeenCalled();
    expect(await actions.get(held.action_ref)).toMatchObject({
      approval_ref: 'batch-deferred',
    });
  });

  it('finds JOIN membership before receipt linkage even when the standalone newest checkpoint lists first', async () => {
    const log = auditLog();
    await append(log, anchor({ run_id: 'run-older', checkpoint_id: 'checkpoint-older' }));
    await append(log, anchor({ run_id: 'run-newest', checkpoint_id: 'checkpoint-newest' }));
    let actionSeq = 0;
    const actions = createGatedActionStore(
      createInMemoryCollection<GatedActionRecord>(),
      { now: () => NOW, newActionRef: () => `action-reverse-${actionSeq += 1}` },
    );
    const older = await actions.createHeld({
      run_id: 'run-older', gated_step_id: 'gated_step', checkpoint_id: 'checkpoint-older',
    });
    const newest = await actions.createHeld({
      run_id: 'run-newest', gated_step_id: 'gated_step', checkpoint_id: 'checkpoint-newest',
    });
    await actions.linkApproval(older.action_ref, 'batch-reverse', 'ask-v1-stale');
    const notes = notifier();
    const reconcileOpenBatch = vi.fn().mockImplementation(async () => {
      await actions.linkApproval(older.action_ref, 'batch-reverse', 'ask-v2');
      await actions.linkApproval(newest.action_ref, 'batch-reverse', 'ask-v2');
      return { kind: 'reconciled' as const, ask_id: 'ask-v2', raised: true };
    });

    const result = await sweepAwaitingCheckpoints({
      checkpointStore: checkpointStore([
        checkpoint({ run_id: 'run-newest', checkpoint_id: 'checkpoint-newest' }),
        checkpoint({ run_id: 'run-older', checkpoint_id: 'checkpoint-older' }),
      ]),
      auditLog: log,
      notifier: notes,
      gatedActionStore: actions,
      reconcileOpenBatch,
    });

    expect(result).toMatchObject({ raised: 0, alreadyPaired: 2, failed: 0 });
    expect(reconcileOpenBatch.mock.calls[0]?.[0]).toEqual({
      checkpoint_id: 'checkpoint-newest',
    });
    expect(notes.ask).not.toHaveBeenCalled();
    expect(await actions.get(newest.action_ref)).toMatchObject({
      approval_ref: 'batch-reverse', current_ask_id: 'ask-v2',
    });
  });

  it('fails closed when an orphaned batch receipt cannot reset to standalone', async () => {
    const log = auditLog();
    await append(log, anchor());
    const base = createGatedActionStore(
      createInMemoryCollection<GatedActionRecord>(),
      { now: () => NOW, newActionRef: () => 'action-orphaned-batch' },
    );
    const held = await base.createHeld({
      run_id: 'run-1',
      recipe_id: 'recipe-1',
      gated_step_id: 'gated_step',
      checkpoint_id: 'checkpoint-1',
    });
    const grouped = await base.linkApproval(held.action_ref, 'batch-gone', null);
    const actions = {
      ...base,
      getByCheckpoint: vi.fn().mockResolvedValue(grouped),
      get: vi.fn().mockResolvedValue(grouped),
      linkApproval: vi.fn().mockRejectedValue(new Error('receipt store down')),
    } as GatedActionStore;
    const notes = notifier();

    const result = await sweepAwaitingCheckpoints({
      checkpointStore: checkpointStore([checkpoint()]),
      auditLog: log,
      notifier: notes,
      gatedActionStore: actions,
      getBatch: vi.fn().mockResolvedValue(null),
    });

    expect(result).toMatchObject({ alreadyPaired: 0, raised: 0, failed: 1 });
    expect(notes.ask).not.toHaveBeenCalled();
  });

  it('never renews or re-raises a checkpoint superseded by the run anchor', async () => {
    const log = auditLog();
    await append(log, anchor({ checkpoint_id: 'checkpoint-current' }));
    const notes = notifier();

    const result = await sweepAwaitingCheckpoints({
      checkpointStore: checkpointStore([checkpoint({
        checkpoint_id: 'checkpoint-stale',
      })]),
      auditLog: log,
      notifier: notes,
    });

    expect(result).toMatchObject({ superseded: 1, raised: 0, failed: 0 });
    expect(notes.ask).not.toHaveBeenCalled();
  });

  it('re-raises the durable D-211 ruling offer and clamp warning', async () => {
    const log = auditLog();
    await append(log, anchor());
    const notes = notifier();
    const offer = {
      kind: 'never_ask' as const,
      ingredient_id: 'pub/cat',
      operation_id: 'pub/cat.read',
      op_hash: 'a'.repeat(64),
      approval: 'never' as const,
    };

    await sweepAwaitingCheckpoints({
      checkpointStore: checkpointStore([checkpoint({
        preflight_context: {
          tool_slug: 'pub/cat.read',
          risk_tier: 'read',
          owner_override_offer: offer,
          approval_clamped_from: 'never',
        },
      })]),
      auditLog: log,
      notifier: notes,
    });

    const [, options, handler] = notes.ask.mock.calls[0]!;
    expect(options.map((option: { id: string }) => option.id)).toContain(
      NEVER_ASK_OPERATION_OPTION_ID,
    );
    expect(handler.payload.owner_override_offer).toEqual(offer);
    expect(notes.ask.mock.calls[0]![0].text).toContain("stored approval 'never'");
  });

  it('skips anchors that already have ask_id set', async () => {
    const log = auditLog();
    await append(log, anchor({ ask_id: 'ask-existing' }));
    const notes = notifier();

    const result = await sweepAwaitingCheckpoints({
      checkpointStore: checkpointStore([checkpoint()]),
      auditLog: log,
      notifier: notes,
    });

    expect(result.alreadyPaired).toBe(1);
    expect(result.raised).toBe(0);
    expect(notes.ask).not.toHaveBeenCalled();
  });

  it('skips terminal rows and counts them', async () => {
    const log = auditLog();
    await append(log, anchor({ commit_status: 'failed' }));
    const notes = notifier();

    const result = await sweepAwaitingCheckpoints({
      checkpointStore: checkpointStore([checkpoint()]),
      auditLog: log,
      notifier: notes,
    });

    expect(result.terminal).toBe(1);
    expect(result.raised).toBe(0);
    expect(notes.ask).not.toHaveBeenCalled();
  });

  it('counts orphaned checkpoints when no audit row exists', async () => {
    const log = auditLog();
    const notes = notifier();

    const result = await sweepAwaitingCheckpoints({
      checkpointStore: checkpointStore([checkpoint()]),
      auditLog: log,
      notifier: notes,
    });

    expect(result.orphaned).toBe(1);
    expect(result.raised).toBe(0);
    expect(notes.ask).not.toHaveBeenCalled();
  });

  it('continues after a per-row raise failure', async () => {
    const log = auditLog();
    await append(log, anchor({
      run_id: 'run-fail',
      checkpoint_id: 'checkpoint-fail',
    }));
    await append(log, anchor({
      run_id: 'run-ok',
      checkpoint_id: 'checkpoint-ok',
    }));
    const checkpoints = [
      checkpoint({ run_id: 'run-fail', checkpoint_id: 'checkpoint-fail' }),
      checkpoint({ run_id: 'run-ok', checkpoint_id: 'checkpoint-ok' }),
    ];
    const notes = notifier(
      vi.fn()
        .mockRejectedValueOnce(new Error('ask store down'))
        .mockResolvedValueOnce({ ask_id: 'ask-ok' }),
    );

    const result = await sweepAwaitingCheckpoints({
      checkpointStore: checkpointStore(checkpoints),
      auditLog: log,
      notifier: notes,
    });

    expect(result.inspected).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.raised).toBe(1);
    expect(notes.ask).toHaveBeenCalledTimes(2);
    expect(await log.get('run-fail')).not.toHaveProperty('ask_id');
    expect(await log.get('run-ok')).toMatchObject({ ask_id: 'ask-ok' });
  });

  it('counts audit pin failures and continues the sweep', async () => {
    const log = auditLog();
    await append(log, anchor({
      run_id: 'run-pin-fail',
      checkpoint_id: 'checkpoint-pin-fail',
    }));
    await append(log, anchor({
      run_id: 'run-after',
      checkpoint_id: 'checkpoint-after',
    }));
    vi.spyOn(log, 'append')
      .mockRejectedValueOnce(new Error('append down'))
      .mockImplementation(async (entry) => {
        await auditLog().append(entry);
      });
    const notes = notifier(
      vi.fn()
        .mockResolvedValueOnce({ ask_id: 'ask-orphaned' })
        .mockResolvedValueOnce({ ask_id: 'ask-after' }),
    );

    const result = await sweepAwaitingCheckpoints({
      checkpointStore: checkpointStore([
        checkpoint({
          run_id: 'run-pin-fail',
          checkpoint_id: 'checkpoint-pin-fail',
        }),
        checkpoint({ run_id: 'run-after', checkpoint_id: 'checkpoint-after' }),
      ]),
      auditLog: log,
      notifier: notes,
    });

    expect(result.failed).toBe(1);
    expect(result.raised).toBe(1);
    expect(notes.ask).toHaveBeenCalledTimes(2);
  });
});
