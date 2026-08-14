/** D-181 § 9 (slice 6d) — owner-cancelled run → agent-facing tool result.
 *
 *  Replaces the reverted working-handle (6d-1) per the owner's await model:
 *  a chat/messenger recipe dispatch awaits the run inline; when the OWNER
 *  kills it (or cancels a queued call before dispatch) via the slice-4
 *  active-list surfaces, the run's `ExecuteResponse` carries `run_terminated`,
 *  and the chat tool-loop must surface that as a **non-ok, non-retryable**
 *  result that names the tool (not its args) and tells the agent to resolve
 *  with the user — NOT `{ ok: true, result: <killed run> }`, which reads as a
 *  usable result the agent might re-issue.
 */

import { describe, it, expect } from 'vitest';
import {
  CHAT_DISPATCH_REASONS,
  isChatDispatchReason,
  type ChatDispatchContext,
  type ConnectionMcpAnnotationState,
} from '@recued/contracts';
import {
  buildChatTier1Handlers,
  createChatTier2Dispatch,
  type ChatRecipeExecutor,
  type ChatToolHandlerDeps,
} from '../chat-tool-handlers.js';
import {
  projectRunResultForAgent,
  runCancellationMessage,
} from '../run-result-agent-projection.js';
import {
  MCP_DISPATCH_ERROR_MESSAGES,
  formatMcpDispatchError,
} from '../mcp-internal-tools.js';
import type { ExecuteResponse } from '../types.js';

const ctxInternal = (): ChatDispatchContext => ({
  channel: 'internal_function_call',
  session_id: 's',
  turn_id: 't',
});

const baseResult = (over: Partial<ExecuteResponse>): ExecuteResponse =>
  ({
    recipe_id: 'demo',
    recipe_hash: 'h',
    success: true,
    output: { sidebar: [] },
    steps: [],
    errors: [],
    duration_ms: 1,
    ...over,
  }) as ExecuteResponse;

const execReturning = (result: ExecuteResponse): ChatRecipeExecutor => () => Promise.resolve(result);

const deps = (over: Partial<ChatToolHandlerDeps> = {}): ChatToolHandlerDeps => ({
  getContactStore: () => undefined,
  getCollectionRegistry: () => undefined,
  getAuditLog: () => undefined,
  getEnrichmentStore: () => undefined,
  getRecipeStore: () =>
    ({ ids: () => [], get: () => null, getStored: () => null, listStored: () => [] }) as never,
  getExecutorConfig: () => ({ manifests: { get: () => null } }) as never,
  getExecuteRecipe: () => undefined,
  ...over,
});

const recipeRun = (d: ChatToolHandlerDeps) => buildChatTier1Handlers(d)['recipe.run'];

// ── contract: the new reason ────────────────────────────────────────

describe('D-181 § 9 — run_cancelled dispatch reason', () => {
  it('is a member of the closed reason list', () => {
    expect(CHAT_DISPATCH_REASONS).toContain('run_cancelled');
    expect(isChatDispatchReason('run_cancelled')).toBe(true);
  });
});

// ── the model-facing message ────────────────────────────────────────

describe('D-181 § 9 — runCancellationMessage (model-facing, anti-loop)', () => {
  it('killed → "while it was running" + the tool label + do-not-retry posture', () => {
    const msg = runCancellationMessage('killed', 'acme/weekly-report');
    expect(msg).toContain('"acme/weekly-report"');
    expect(msg).toContain('while it was running');
    expect(msg).toMatch(/NOT a failure/);
    expect(msg).toMatch(/Do NOT run it again/);
    expect(msg).toMatch(/ask how they would like to proceed/);
  });

  it('cancelled_before_dispatch → "before it started executing"', () => {
    const msg = runCancellationMessage('cancelled_before_dispatch', 'demo');
    expect(msg).toContain('"demo"');
    expect(msg).toContain('before it started executing');
    expect(msg).toMatch(/Do NOT run it again/);
  });

  it('never names args — only the supplied label appears', () => {
    const msg = runCancellationMessage('killed', 'demo');
    expect(msg).not.toMatch(/arg|config|\{|\}/);
  });
});

// ── Tier 1: the dispatch result shape ───────────────────────────────

describe('D-181 § 9 — recipe.run surfaces a cancelled run as non-ok', () => {
  it('a killed run → ok:false, reason run_cancelled, detail echoes recipe_id', async () => {
    const result = await recipeRun(
      deps({ getExecuteRecipe: () => execReturning(baseResult({ success: false, run_terminated: 'killed' })) }),
    )({ recipe_id: 'demo' }, ctxInternal());
    expect(result).toEqual({
      ok: false,
      reason: 'run_cancelled',
      detail: runCancellationMessage('killed', 'demo'),
    });
  });

  it('a cancelled-in-queue run → ok:false with the before-dispatch wording', async () => {
    const result = await recipeRun(
      deps({
        getExecuteRecipe: () =>
          execReturning(baseResult({ success: false, run_terminated: 'cancelled_before_dispatch' })),
      }),
    )({ recipe_id: 'demo' }, ctxInternal());
    expect(result).toMatchObject({ ok: false, reason: 'run_cancelled' });
    if (!result.ok) expect(result.detail).toContain('before it started executing');
  });

  it('an ordinary SUCCESS is untouched (ok:true, result passthrough)', async () => {
    const ok = baseResult({ success: true });
    const result = await recipeRun(deps({ getExecuteRecipe: () => execReturning(ok) }))(
      { recipe_id: 'demo' },
      ctxInternal(),
    );
    expect(result).toEqual({ ok: true, result: ok });
  });

  it('an ordinary FAILURE (no run_terminated) is NOT reclassified as cancelled', async () => {
    const failed = baseResult({ success: false, errors: [{ message: 'step blew up' }] });
    const result = await recipeRun(deps({ getExecuteRecipe: () => execReturning(failed) }))(
      { recipe_id: 'demo' },
      ctxInternal(),
    );
    // A plain failure surfaces `run_failed` detail (chat-tool-handlers.ts:313) but is
    // NOT reclassified as cancelled — no `run_terminated`.
    expect(result).toEqual({ ok: true, result: failed, run_failed: { detail: 'step blew up' } });
  });

  it('a HELD-for-approval run still projects to the awaiting_approval shape', async () => {
    const held = baseResult({ success: false, awaiting_approval: true });
    const result = await recipeRun(deps({ getExecuteRecipe: () => execReturning(held) }))(
      { recipe_id: 'demo' },
      ctxInternal(),
    );
    expect(result).toMatchObject({
      ok: true,
      result: { status: 'awaiting_approval', awaiting_approval: true, recipe_id: 'demo' },
    });
  });
});

// ── cross-tier labels ───────────────────────────────────────────────

describe('D-181 § 9 — cancellation echo names the tool the agent called', () => {
  it('Tier 2 killed → echoes the recipe id', async () => {
    const dispatch = createChatTier2Dispatch(
      deps({
        getExecuteRecipe: () =>
          execReturning(baseResult({ recipe_id: 'weekly-report', success: false, run_terminated: 'killed' })),
        getRecipeStore: () =>
          ({
            ids: () => ['weekly-report'],
            get: (id: string) => (id === 'weekly-report' ? ({ recipe_id: 'weekly-report', steps: [] } as never) : null),
            getStored: () => null,
            listStored: () => [],
          }) as never,
      }),
    );
    const result = await dispatch('acme/weekly-report', {}, ctxInternal());
    expect(result).toEqual({
      ok: false,
      reason: 'run_cancelled',
      detail: runCancellationMessage('killed', 'weekly-report'),
    });
  });

  // ⛔ D-228 slice 4 — the Tier-3 cancellation echo test is DELETED with its
  // subject. It asserted that a killed `<connection>.<tool>` run echoed the name
  // the AGENT called rather than the kernel run-ingredient recipe; there is no
  // Tier-3 dispatch any more (an MCP tool reaches chat as a `recued_op_*` pack
  // operation). The property it protected — the echo names what the caller
  // asked for — is still covered by the Tier-2 sibling directly above.

  it('a killed run → {status:cancelled, cancelled:true, recipe_id, message}', () => {
    const projected = projectRunResultForAgent(baseResult({ success: false, run_terminated: 'killed' }));
    expect(projected).toEqual({
      status: 'cancelled',
      cancelled: true,
      recipe_id: 'demo',
      message: runCancellationMessage('killed', 'demo'),
    });
  });

  it('cancellation wins over awaiting_approval (terminal owner action)', () => {
    const projected = projectRunResultForAgent(
      baseResult({ success: false, run_terminated: 'killed', awaiting_approval: true }),
    );
    expect(projected).toMatchObject({ status: 'cancelled', cancelled: true });
  });

  it('a non-terminated success / failure passes through unchanged', () => {
    const ok = baseResult({ success: true });
    expect(projectRunResultForAgent(ok)).toBe(ok);
    const failed = baseResult({ success: false, errors: [{ message: 'x' }] });
    expect(projectRunResultForAgent(failed)).toBe(failed);
  });

  it('a held (non-terminated) run still projects to awaiting_approval', () => {
    const projected = projectRunResultForAgent(baseResult({ success: false, awaiting_approval: true }));
    expect(projected).toMatchObject({ status: 'awaiting_approval', awaiting_approval: true });
  });
});

// ── MCP surface consistency ─────────────────────────────────────────

describe('D-181 § 9 — MCP error envelope carries the cancellation copy', () => {
  it('formatMcpDispatchError appends the do-not-retry detail to the base', () => {
    const detail = runCancellationMessage('killed', 'demo');
    const formatted = formatMcpDispatchError({ ok: false, reason: 'run_cancelled', detail });
    expect(formatted).toContain(MCP_DISPATCH_ERROR_MESSAGES.run_cancelled);
    expect(formatted).toContain(detail);
  });
});
