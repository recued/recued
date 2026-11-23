/** D-348 slice 1 — a recipe's held step, answered: the resumer keeps the owner's answer with what the
 *  call is, before the run proceeds, and the run's outcome when it settles. (A chat write, a raw op,
 *  is driven whole in `d-348-chain-evidence-turns.test.ts`.) */

import Database from 'better-sqlite3';
import type { Checkpoint, ExecutionSource } from '@recued/contracts';
import { chainCallSignatureHash } from '@recued/contracts';
import type { PreflightAskContext } from '@recued/gateway';
import {
  buildAuditEntry,
  createAuditLogStore,
  createInMemoryCollection,
  type ActivityEntry,
  type AuditEntry,
} from '@recued/storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExecuteHandlerDeps } from '../execute-handler.js';
import { CHAIN_REQUEST_STATE_KEY, noteChainHeldRun, openChainRequest } from '../chain-evidence.js';
import { createChainEvidenceStore } from '../storage/chain-evidence-store.js';

const handleExecuteMock = vi.hoisted(() => vi.fn());
vi.mock('../execute-handler.js', () => ({ handleExecute: handleExecuteMock }));

import { createPreflightResumer } from '../preflight-resumer.js';

const NOW = Date.parse('2026-11-10T18:00:00.000Z');
const source: ExecutionSource = { channel: 'chat', actor: 'user_self', chat_session_id: 'chat-a', user_id: 'owner', turn_id: 't1' };

// No `recipe_source_hash`: the resumer would check it against a stored recipe (the version is in the
// call's signature, `d-348-chain-signature.test.ts`).
const held: Checkpoint = {
  checkpoint_id: 'cp-1', run_id: 'run-1', recipe_id: 'send-composed-mail', gated_step_id: 'send',
  step_state: { send: { input: { to: ['ann@example.com'], subject: 'The new time' } } }, created_at: NOW,
  approved_target: { ingredient_slug: 'mail-send' },
  // Why the gate asked, as it records it: a chain may stand in for that (`chainMayStandIn`).
  preflight_context: { tool_slug: 'mail-send', risk_tier: 'write', authorization_provenance: { pre_lift_approval: 'ask' } },
} as unknown as Checkpoint;
const context = { recipe_id: 'send-composed-mail', gated_step_id: 'send', tool_slug: 'mail-send', risk_tier: 'write' } as PreflightAskContext;

/** The run's anchor, paused at a checkpoint. */
const anchor = (checkpoint_id: string): AuditEntry => buildAuditEntry({
  recipe_id: 'send-composed-mail', recipe_hash: 'h1', commit_status: 'awaiting_approval', duration_ms: 1, errors: [],
  config_snapshot: {}, trigger_source: 'chat', instance_id: 'server-1', process_id: 'process-1', run_id: 'run-1', now: NOW,
  execution_source: source, checkpoint_id,
});

const fixture = async () => {
  const auditLog = createAuditLogStore(createInMemoryCollection<AuditEntry>(), createInMemoryCollection<ActivityEntry>());
  await auditLog.append(anchor('cp-1'));
  const db = new Database(':memory:');
  const chains = createChainEvidenceStore(db);
  // The turn that held it, as the orchestrator notes it.
  const state = new Map<string, unknown>([[CHAIN_REQUEST_STATE_KEY,
    openChainRequest(chains, { session_id: 'chat-a', turn_id: 't1', source, words: 'Tell Ann the new time', at: NOW })]]);
  noteChainHeldRun(chains, state, 'run-1', NOW);
  const executeDeps = {
    recipeStore: { get: vi.fn(() => null), list: vi.fn(() => []) },
    executorConfig: { manifests: { get: vi.fn(() => undefined) } },
    baseVault: {},
    chainEvidence: chains,
  } as unknown as ExecuteHandlerDeps;
  const resumer = createPreflightResumer({ auditLog, getExecuteDeps: () => executeDeps });
  const calls = () => db.prepare('SELECT * FROM chain_calls').all() as Array<Record<string, unknown>>;
  return { resumer, calls, auditLog, anchor };
};

beforeEach(() => {
  handleExecuteMock.mockReset();
  handleExecuteMock.mockResolvedValue({
    recipe_id: 'send-composed-mail', recipe_hash: 'h1', success: true, output: {}, steps: [], errors: [], duration_ms: 1,
  });
});

describe('D-348 — a recipe\'s held step, answered', () => {
  it('approved: kept with what the step is, before the run proceeds, then how it ended', async () => {
    const f = await fixture();
    let keptBeforeTheRun: unknown[] | undefined;
    handleExecuteMock.mockImplementation(async () => {
      keptBeforeTheRun = f.calls();
      return { recipe_id: 'send-composed-mail', recipe_hash: 'h1', success: true, output: {}, steps: [], errors: [], duration_ms: 1 };
    });
    await f.resumer.resumeRun(held, context);
    expect(keptBeforeTheRun).toHaveLength(1);
    expect(f.calls()[0]).toMatchObject({
      checkpoint_id: 'cp-1', run_id: 'run-1', request_id: 't1', answer: 'approved', outcome: 'ran',
      signature_hash: chainCallSignatureHash({
        op: 'step:send-composed-mail@|mail-send||', pins: { to: ['ann@example.com'] },
      }),
    });
  });

  it('⛔ a run that stops again for a later step\'s approval has not ended: both calls take how it ends', async () => {
    const f = await fixture();
    // The host writes the run's new pause, as it does when a later step holds.
    handleExecuteMock.mockImplementationOnce(async () => {
      await f.auditLog.append(f.anchor('cp-2'));
      return { recipe_id: 'send-composed-mail', recipe_hash: 'h1', success: false, awaiting_approval: true,
        output: {}, steps: [], errors: [], duration_ms: 1 };
    });
    await f.resumer.resumeRun(held, context);
    expect(f.calls()[0]).toMatchObject({ checkpoint_id: 'cp-1', answer: 'approved', outcome: null });
    await f.resumer.resumeRun({ ...held, checkpoint_id: 'cp-2', gated_step_id: 'post' } as Checkpoint, context);
    expect(f.calls().map((row) => [row.checkpoint_id, row.outcome])).toEqual([['cp-1', 'ran'], ['cp-2', 'ran']]);
  });

  it('a run that failed is kept as failed', async () => {
    const f = await fixture();
    handleExecuteMock.mockResolvedValue({
      recipe_id: 'send-composed-mail', recipe_hash: 'h1', success: false, output: {}, steps: [],
      errors: [{ code: 'X', message: 'no' }], duration_ms: 1,
    });
    await f.resumer.resumeRun(held, context);
    expect(f.calls()[0]).toMatchObject({ answer: 'approved', outcome: 'failed' });
  });

  it('refused: kept as refused', async () => {
    const f = await fixture();
    await f.resumer.denyRun(held, context);
    expect(f.calls()[0]).toMatchObject({ answer: 'refused', outcome: null });
    expect(handleExecuteMock).not.toHaveBeenCalled();
  });
});
