/** D-234 § 234.4 — peer-answer resume binds the exact durable peer hold. */

import type {
  Checkpoint,
  ContractSnapshot,
  ExecutionSource,
  RecipeDefinition,
} from '@recued/contracts';
import { hashForeachCheckpointSource } from '@recued/contracts';
import Database from 'better-sqlite3';
import { canonicalRecipeDefinition, hashRecipe } from '@recued/recipes';
import { buildAuditEntry, type AuditEntry } from '@recued/storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExecuteHandlerDeps } from '../execute-handler.js';

const handleExecuteMock = vi.hoisted(() => vi.fn());

vi.mock('../execute-handler.js', () => ({
  handleExecute: handleExecuteMock,
}));

import { resumePeerHold } from '../peer-hold-resumer.js';
import { continueRecordedPeerAnswer } from '../peer-answer-return.js';
import { createPeerAnswerStore } from '../storage/peer-answer-store.js';
import { createPeerAskOutboxStore } from '../storage/peer-ask-outbox-store.js';

const NOW = Date.parse('2026-09-04T12:00:00.000Z');

const recipe: RecipeDefinition = {
  recipe_id: 'recipe-1',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'Peer answer continuation',
    description: 'test recipe',
    author: 'tester',
    supported_platforms: [],
  },
  variables: {},
  prefetch_steps: [],
  steps: [],
  output: { sidebar: [] },
};
const RECIPE_HASH = hashRecipe(recipe);
/** ⚠ A SECOND CONSTANT ON PURPOSE. `anchor.recipe_hash` and
 *  `checkpoint.recipe_source_hash` are different fields with different bases:
 *  the source hash is of the CANONICAL definition, because `parseRecipe`
 *  rewrites this fixture's legacy `output.sidebar` to `output.render` in place
 *  during a real run. Serving both from one constant only worked while the
 *  producer was equally un-canonical, and hid that the two are not the same
 *  question. */
const RECIPE_SOURCE_HASH = hashRecipe(canonicalRecipeDefinition(recipe));

const source: ExecutionSource = {
  channel: 'chat',
  actor: 'user_self',
  chat_session_id: 'chat-1',
  user_id: 'user-1',
};

const mcpSource: ExecutionSource = {
  channel: 'mcp',
  actor: 'contracted_user',
  agent_id: 'agent-1',
  tool_call_id: 'call-1',
  mcp_token_id: 'token-1',
  contract_id: 'contract-1',
};

const contractSnapshot = (version: string): ContractSnapshot => ({
  contract_id: 'contract-1',
  contract_version: version,
  allowed_tools: ['tester/recipe-1'],
  approval_required: ['write'],
  scope_restrictions: ['data.*'],
  resolved_at: NOW,
});

const anchor = (overrides: Partial<AuditEntry> = {}): AuditEntry => ({
  ...buildAuditEntry({
    recipe_id: 'recipe-1',
    recipe_hash: RECIPE_HASH,
    commit_status: 'awaiting_peer',
    duration_ms: 10,
    errors: [],
    config_snapshot: { tenant: 'original' },
    context_snapshot: { case_id: 'case-1' },
    trigger_url: null,
    trigger_source: 'manual',
    instance_id: 'server-1',
    run_id: 'run-1',
    now: NOW,
    execution_source: source,
    checkpoint_id: 'checkpoint-peer',
  }),
  ...overrides,
});

const checkpoint = (overrides: Partial<Checkpoint> = {}): Checkpoint => ({
  checkpoint_id: 'checkpoint-peer',
  run_id: 'run-1',
  recipe_id: 'recipe-1',
  recipe_source_hash: RECIPE_SOURCE_HASH,
  gated_step_id: 'peer-step',
  step_state: { lookup: { id: 'record-1' } },
  created_at: NOW,
  ...overrides,
});

const executeDeps = {
  recipeStore: { get: vi.fn(() => recipe) },
} as unknown as ExecuteHandlerDeps;

const setup = (
  pausedAnchor: AuditEntry,
  checkpoints: Checkpoint[],
  deps: ExecuteHandlerDeps = executeDeps,
) => ({
  getExecuteDeps: vi.fn(() => deps),
  auditLog: {
    get: vi.fn(async () => pausedAnchor),
    append: vi.fn(async () => {}),
  },
  checkpoints: { listByRun: vi.fn(async () => checkpoints) },
});

const journalSetup = async (options: {
  pausedAnchor?: AuditEntry;
  pausedCheckpoint?: Checkpoint;
  pausedCheckpoints?: Checkpoint[];
  executeDeps?: ExecuteHandlerDeps;
} = {}) => {
  const db = new Database(':memory:');
  const outbox = createPeerAskOutboxStore(db);
  const answers = createPeerAnswerStore(db);
  outbox.stage({
    exchange_ref: 'exchange-1',
    run_id: 'run-1',
    gated_step_id: 'peer-step',
    checkpoint_id: 'checkpoint-peer',
    action_ref: 'action-1',
    connection: 'peer-bob',
    label: 'review',
    offered: ['yes'],
    created_at: NOW,
    delivery: {
      recipient_fingerprint: 'peer-fingerprint-1',
      spec: {
        connection: 'peer-bob',
        label: 'review',
        question: 'Ship it?',
        options: [{ id: 'yes', label: 'Yes' }],
        on_timeout: 'wait',
        via: 'direct',
      },
    },
  });
  outbox.activate('exchange-1');
  answers.record({
    exchange_ref: 'exchange-1',
    peer_contract_id: 'peer-contract-1',
    answered: true,
    option: 'yes',
    at: NOW,
  });
  let current: AuditEntry | null = options.pausedAnchor ?? anchor();
  const deps = {
    getExecuteDeps: vi.fn(() => options.executeDeps ?? executeDeps),
    auditLog: {
      get: vi.fn(async () => current),
      append: vi.fn(async (entry: AuditEntry) => { current = entry; }),
    },
    checkpoints: {
      listByRun: vi.fn(async () => options.pausedCheckpoints
        ?? [options.pausedCheckpoint ?? checkpoint()]),
    },
    outbox,
  };
  return {
    db,
    outbox,
    answers,
    deps,
    getAnchor: () => current,
    setAnchor: (next: AuditEntry | null) => { current = next; },
  };
};

beforeEach(() => {
  handleExecuteMock.mockReset();
  handleExecuteMock.mockResolvedValue(undefined);
});

describe('resumePeerHold durable binding', () => {
  it('resumes only the anchor-pointed peer checkpoint, not the newest row', async () => {
    const matching = checkpoint();
    const newerApproval = checkpoint({
      checkpoint_id: 'checkpoint-later-approval',
      gated_step_id: 'approval-step',
      step_state: { wrong: true },
      created_at: NOW + 1,
    });
    const deps = setup(anchor(), [newerApproval, matching]);

    await expect(resumePeerHold(
      { run_id: 'run-1', gated_step_id: 'peer-step' },
      deps,
    )).resolves.toEqual({ kind: 'resumed' });

    expect(deps.checkpoints.listByRun).toHaveBeenCalledWith('run-1');
    expect(handleExecuteMock).toHaveBeenCalledTimes(1);
    expect(handleExecuteMock.mock.calls[0]![1]).toMatchObject({
      recipe_id: 'recipe-1',
      config: { tenant: 'original' },
      context: { case_id: 'case-1' },
    });
    expect(handleExecuteMock.mock.calls[0]![2]).toMatchObject({
      run_id: 'run-1',
      resume_from: {
        gated_step_id: 'peer-step',
        step_state: matching.step_state,
      },
    });
  });

  it('rebuilds fresh authority and restores foreach, PII, and host provenance', async () => {
    const freshSnapshot = contractSnapshot('fresh');
    const resolve = vi.fn(() => ({
      admitted: true as const,
      execution_source: mcpSource,
      contract_snapshot: freshSnapshot,
    }));
    const depsForResume = {
      recipeStore: { get: vi.fn(() => recipe) },
      approvalResumeAuthority: { resolve },
    } as unknown as ExecuteHandlerDeps;
    const piiLedgers = {
      sid: 1,
      ledger_seq: 2,
      handles: ['pii:1'],
      by_kind_real_value: [],
      by_kind_base_alias: [],
      counters: [],
      sibling_counters: [],
      pre_scan_literals: [],
    };
    const foreachProgress = {
      step_id: 'peer-step',
      next_index: 1,
      source_length: 2,
      source_hash: hashForeachCheckpointSource(['first', 'second']),
      results: [{ ok: true, result: 'first' }],
    };
    const paused = anchor({
      execution_source: mcpSource,
      contract_snapshot: contractSnapshot('stale'),
      granted_by_recipe: 'tester/recipe-1',
      process_id: 'process-1',
      dish_id: 'dish-1',
      exchange_ref: 'outer-exchange',
    });
    const saved = checkpoint({
      foreach_progress: foreachProgress,
      pii_ledgers: piiLedgers,
    });

    await resumePeerHold(
      { run_id: 'run-1', gated_step_id: 'peer-step' },
      setup(paused, [saved], depsForResume),
    );

    expect(resolve).toHaveBeenCalledWith({
      execution_source: mcpSource,
      required_bearer_tool_names: ['tester/recipe-1'],
    });
    expect(handleExecuteMock.mock.calls[0]![1]).toMatchObject({
      execution_source: mcpSource,
      contract_snapshot: freshSnapshot,
      instance_id: 'server-1',
      process_id: 'process-1',
      dish_id: 'dish-1',
    });
    expect(handleExecuteMock.mock.calls[0]![1].contract_snapshot)
      .not.toEqual(contractSnapshot('stale'));
    expect(handleExecuteMock.mock.calls[0]![2]).toMatchObject({
      run_id: 'run-1',
      granted_by_recipe: 'tester/recipe-1',
      exchange_ref: 'outer-exchange',
      resume_from: {
        gated_step_id: 'peer-step',
        foreach_progress: foreachProgress,
        pii_ledgers: piiLedgers,
      },
    });
  });

  it('terminalizes without executing when live authority was revoked before the answer', async () => {
    const resolve = vi.fn(() => ({
      admitted: false as const,
      reason: 'bearer_inactive' as const,
      detail: 'bearer was revoked while waiting for the peer',
    }));
    const depsForResume = {
      recipeStore: { get: vi.fn(() => recipe) },
      approvalResumeAuthority: { resolve },
    } as unknown as ExecuteHandlerDeps;
    const h = await journalSetup({
      pausedAnchor: anchor({ execution_source: mcpSource }),
      executeDeps: depsForResume,
    });
    const row = h.outbox.get('exchange-1')!;

    await expect(continueRecordedPeerAnswer(row, {
      outbox: h.outbox,
      resume: async (target) => {
        await resumePeerHold(target, h.deps);
      },
    })).resolves.toBe(true);

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(handleExecuteMock).not.toHaveBeenCalled();
    expect(h.getAnchor()).toMatchObject({
      commit_status: 'failed',
      errors: [expect.objectContaining({
        code: 'RECIPE_POLICY_DENIED',
        details: { authority_reason: 'bearer_inactive' },
      })],
    });
    expect(h.outbox.getDelivery('exchange-1')).toBeNull();
  });

  it('terminalizes without executing when the stored recipe changed while waiting', async () => {
    const h = await journalSetup({
      pausedCheckpoint: checkpoint({ recipe_source_hash: 'prior-recipe-hash' }),
    });
    const row = h.outbox.get('exchange-1')!;

    await expect(continueRecordedPeerAnswer(row, {
      outbox: h.outbox,
      resume: async (target) => {
        await resumePeerHold(target, h.deps);
      },
    })).resolves.toBe(true);

    expect(handleExecuteMock).not.toHaveBeenCalled();
    expect(h.getAnchor()).toMatchObject({
      commit_status: 'failed',
      errors: [expect.objectContaining({
        code: 'RECIPE_VALIDATION_FAILED',
        details: expect.objectContaining({
          reason: 'peer_checkpoint_recipe_drift',
          expected_source_hash: 'prior-recipe-hash',
        }),
      })],
    });
    expect(h.outbox.getDelivery('exchange-1')).toBeNull();
  });

  it('skips a downstream awaiting_approval anchor instead of replaying the peer step', async () => {
    const deps = setup(anchor({ commit_status: 'awaiting_approval' }), [checkpoint()]);

    await expect(resumePeerHold(
      { run_id: 'run-1', gated_step_id: 'peer-step' },
      deps,
    )).resolves.toMatchObject({
      kind: 'skipped',
      reason: expect.stringContaining('not awaiting_peer'),
    });

    expect(deps.checkpoints.listByRun).not.toHaveBeenCalled();
    expect(handleExecuteMock).not.toHaveBeenCalled();
  });

  it('skips an awaiting_peer anchor without its durable checkpoint pointer', async () => {
    const paused = anchor();
    delete paused.checkpoint_id;
    const deps = setup(paused, [checkpoint()]);

    await expect(resumePeerHold(
      { run_id: 'run-1', gated_step_id: 'peer-step' },
      deps,
    )).resolves.toMatchObject({
      kind: 'skipped',
      reason: expect.stringContaining('has no checkpoint_id'),
    });

    expect(deps.checkpoints.listByRun).not.toHaveBeenCalled();
    expect(handleExecuteMock).not.toHaveBeenCalled();
  });

  it('skips when the anchor-pointed checkpoint is absent', async () => {
    const deps = setup(anchor(), [checkpoint({ checkpoint_id: 'checkpoint-other' })]);

    await expect(resumePeerHold(
      { run_id: 'run-1', gated_step_id: 'peer-step' },
      deps,
    )).resolves.toMatchObject({
      kind: 'skipped',
      reason: expect.stringContaining('checkpoint_id=checkpoint-peer not found'),
    });

    expect(handleExecuteMock).not.toHaveBeenCalled();
  });

  it('skips when the anchor-pointed checkpoint belongs to another gated step', async () => {
    const deps = setup(anchor(), [checkpoint({ gated_step_id: 'different-step' })]);

    await expect(resumePeerHold(
      { run_id: 'run-1', gated_step_id: 'peer-step' },
      deps,
    )).resolves.toMatchObject({
      kind: 'skipped',
      reason: expect.stringContaining("not 'peer-step'"),
    });

    expect(handleExecuteMock).not.toHaveBeenCalled();
  });

  it('turns a missing final audit outcome after post-peer effects into durable in_doubt', async () => {
    const h = await journalSetup();

    await expect(resumePeerHold(
      { run_id: 'run-1', gated_step_id: 'peer-step', exchange_ref: 'exchange-1' },
      h.deps,
    )).resolves.toMatchObject({ kind: 'skipped' });

    expect(handleExecuteMock).toHaveBeenCalledTimes(1);
    expect(h.getAnchor()).toMatchObject({
      commit_status: 'in_doubt',
      errors: [expect.objectContaining({
        details: expect.objectContaining({
          reason: 'peer_answer_continuation_interrupted',
        }),
      })],
    });
    expect(h.outbox.getDelivery('exchange-1')).toMatchObject({
      continuation_claimed: true,
    });

    await resumePeerHold(
      { run_id: 'run-1', gated_step_id: 'peer-step', exchange_ref: 'exchange-1' },
      h.deps,
    );
    expect(handleExecuteMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the no-replay claim when an accepted delivery plan later becomes unreadable', async () => {
    const h = await journalSetup();
    h.outbox.markDelivered('exchange-1');
    h.db.prepare('UPDATE peer_ask_outbox SET delivery_json = ? WHERE exchange_ref = ?')
      .run('{"spec":', 'exchange-1');
    expect(h.outbox.getDelivery('exchange-1')).toMatchObject({
      checkpoint_id: 'checkpoint-peer',
      delivery_state: 'delivered',
    });
    expect(h.outbox.getDelivery('exchange-1')?.delivery).toBeUndefined();

    await resumePeerHold(
      { run_id: 'run-1', gated_step_id: 'peer-step', exchange_ref: 'exchange-1' },
      h.deps,
    );
    await resumePeerHold(
      { run_id: 'run-1', gated_step_id: 'peer-step', exchange_ref: 'exchange-1' },
      h.deps,
    );

    expect(handleExecuteMock).toHaveBeenCalledTimes(1);
    expect(h.outbox.getDelivery('exchange-1')).toMatchObject({
      continuation_claimed: true,
    });
  });

  it('reconciles a crash after continuation claim without replaying any effect', async () => {
    const h = await journalSetup();
    expect(h.outbox.claimContinuation('exchange-1', 'checkpoint-peer')).toBe('claimed');

    await expect(resumePeerHold(
      { run_id: 'run-1', gated_step_id: 'peer-step', exchange_ref: 'exchange-1' },
      h.deps,
    )).resolves.toMatchObject({
      kind: 'skipped',
      reason: expect.stringContaining('without replay'),
    });

    expect(handleExecuteMock).not.toHaveBeenCalled();
    expect(h.getAnchor()).toMatchObject({ commit_status: 'in_doubt' });
  });

  it('retains the answer journal when its exact checkpoint cannot be verified', async () => {
    const h = await journalSetup({ pausedCheckpoints: [] });
    const row = h.outbox.get('exchange-1')!;

    await expect(continueRecordedPeerAnswer(row, {
      outbox: h.outbox,
      resume: async (target) => {
        await resumePeerHold(target, h.deps);
      },
    })).rejects.toThrow('checkpoint_id=checkpoint-peer not found');

    expect(handleExecuteMock).not.toHaveBeenCalled();
    expect(h.outbox.getDelivery('exchange-1')).not.toBeNull();
  });

  it('closes the answer journal without replay when a prior continuation already wrote its terminal anchor', async () => {
    const h = await journalSetup();
    expect(h.outbox.claimContinuation('exchange-1', 'checkpoint-peer')).toBe('claimed');
    h.setAnchor(anchor({ commit_status: 'succeeded', checkpoint_id: undefined }));
    const row = h.outbox.get('exchange-1')!;

    await expect(continueRecordedPeerAnswer(row, {
      outbox: h.outbox,
      resume: async (target) => {
        await resumePeerHold(target, h.deps);
      },
    })).resolves.toBe(true);

    expect(handleExecuteMock).not.toHaveBeenCalled();
    expect(h.outbox.getDelivery('exchange-1')).toBeNull();
  });
});
