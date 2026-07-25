/** Entity-targeting guard (design § 8) — the server execute half.
 *
 *  The § 8 rule: manual run allowed for non-targeted recipes; a TARGETED
 *  recipe run without a target → warn + block. The server guard is the
 *  load-bearing end — manual runs arrive from THREE callers (webclient
 *  rpc / chat tools / MCP), so the run modal alone can't carry the rule.
 *  Covered here:
 *
 *   1. The trigger-source scoping matrix on `assertRunTargets` directly:
 *      machine sources exempt (closed list), caller-ish + unknown +
 *      absent sources guarded (fail-closed for new interactive surfaces).
 *   2. The hook wiring through `handleExecute`: a targeted inline recipe
 *      blocks typed (`recipe_target_required`, 400, missing details);
 *      supplying the target lets the same run execute to completion.
 *   3. ORDER: the guard fires BEFORE connection binding — a recipe that
 *      is both targeted and unbound reports the missing target, not
 *      `connection_pick_required` (fail with the most actionable error
 *      first; no pick ask is raised for a run that cannot dispatch).
 */
import { describe, expect, it } from 'vitest';

import { RpcError, type RecipeDefinition } from '@recued/contracts';
import {
  createAuditLogStore,
  createInMemoryCollection,
  type ActivityEntry,
  type AuditEntry,
} from '@recued/storage';

import { assertRunTargets } from '../targeting-guard.js';
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';

/** Corpus-shaped targeted recipe (assess-deal-risk-hubspot pattern) that is
 *  fully executable with zero ingredients — one transform step consuming
 *  the context target. */
const targetedRecipe = (): RecipeDefinition =>
  ({
    recipe_id: 'targeting-guard-spec',
    version: 1,
    ttl: 60,
    metadata: {
      name: 'Targeting guard spec',
      description: 'Targeted via context.entity_id.',
      author: 'spec',
      supported_platforms: [],
    },
    variables: {},
    prefetch_steps: [],
    steps: [
      { id: 'echo', transform: 'coalesce', values: ['{{context.entity_id}}', 'none'] },
    ],
    output: { sidebar: [] },
  }) as unknown as RecipeDefinition;

const minimalDeps = (): ExecuteHandlerDeps => ({
  recipeStore: createRecipeStore('/nonexistent'),
  executorConfig: { manifests: createManifestRegistry('/nonexistent') },
  baseVault: {},
  instanceId: 'targeting-guard-spec',
});

const expectTargetRequired = (fn: () => void): RpcError => {
  let thrown: RpcError | undefined;
  try {
    fn();
  } catch (e) {
    thrown = e as RpcError;
  }
  expect(thrown).toBeInstanceOf(RpcError);
  expect(thrown!.code).toBe('recipe_target_required');
  expect(thrown!.status).toBe(400);
  return thrown!;
};

describe('assertRunTargets — trigger-source scoping', () => {
  const recipe = targetedRecipe();

  it.each([
    'auto_run',
    'backfill',
    'event_trigger',
    'reactive',
    'schedule',
    'scheduled',
    'webhook',
  ])('machine source %s is exempt — no target needed', (trigger_source) => {
    expect(() => assertRunTargets(recipe, { trigger_source })).not.toThrow();
  });

  it.each(['manual', 'chat', 'mcp', 'extension_ws', 'kitchen-ui', 'some-new-surface'])(
    'caller source %s without a target blocks',
    (trigger_source) => {
      expectTargetRequired(() => assertRunTargets(recipe, { trigger_source }));
    },
  );

  it('an ABSENT trigger_source is guarded (fail-closed)', () => {
    expectTargetRequired(() => assertRunTargets(recipe, {}));
  });

  it('carries the missing targets in details and names the key in the message', () => {
    const error = expectTargetRequired(() =>
      assertRunTargets(recipe, { trigger_source: 'manual' }),
    );
    expect(error.details).toEqual({ missing: [{ kind: 'context', key: 'entity_id' }] });
    expect(error.message).toContain("Recipe 'targeting-guard-spec'");
    expect(error.message).toContain('context.entity_id');
  });

  it('a supplied target passes; a non-targeted recipe never blocks', () => {
    expect(() =>
      assertRunTargets(recipe, { trigger_source: 'manual', context: { entity_id: '123' } }),
    ).not.toThrow();
    const nonTargeted = {
      ...targetedRecipe(),
      recipe_id: 'plain',
      steps: [{ id: 's', transform: 'coalesce', values: ['a', 'b'] }],
    } as unknown as RecipeDefinition;
    expect(() => assertRunTargets(nonTargeted, { trigger_source: 'manual' })).not.toThrow();
  });
});

describe('handleExecute wiring', () => {
  it('blocks a targeted inline run without a target, typed', async () => {
    let thrown: RpcError | undefined;
    try {
      await handleExecute(minimalDeps(), {
        recipe: targetedRecipe(),
        trigger_source: 'chat',
      });
    } catch (e) {
      thrown = e as RpcError;
    }
    expect(thrown).toBeInstanceOf(RpcError);
    expect(thrown!.code).toBe('recipe_target_required');
    expect(thrown!.details).toEqual({ missing: [{ kind: 'context', key: 'entity_id' }] });
  });

  it('the SAME run with the target supplied executes to completion', async () => {
    const response = await handleExecute(minimalDeps(), {
      recipe: targetedRecipe(),
      trigger_source: 'chat',
      context: { entity_id: 'deal-42' },
    });
    expect(response.success).toBe(true);
    expect(response.steps.find((s) => s.id === 'echo')).toMatchObject({ skipped: false });
    expect(response.errors).toEqual([]);
  });

  it('fires BEFORE connection binding — targeted + unbound reports the target, not the pick', async () => {
    const canonical = {
      ...targetedRecipe(),
      recipe_id: 'targeted-and-unbound',
      variables: { crm: { label: 'CRM', type: 'connection', connection_kind: 'api', default: '' } },
      steps: [
        { id: 'read', op: 'deal.read', args: { id: '{{context.entity_id}}' } },
      ],
    } as unknown as RecipeDefinition;
    let thrown: RpcError | undefined;
    try {
      await handleExecute(minimalDeps(), {
        recipe: canonical,
        trigger_source: 'manual',
      });
    } catch (e) {
      thrown = e as RpcError;
    }
    expect(thrown).toBeInstanceOf(RpcError);
    expect(thrown!.code).toBe('recipe_target_required');
  });

  it('a TERMINAL run never persists caller context on its audit row', async () => {
    // `context_snapshot` is paused-anchors-only (caller context can carry
    // page text — no reason to copy it into every retained audit row).
    const log = createAuditLogStore(
      createInMemoryCollection<AuditEntry>(),
      createInMemoryCollection<ActivityEntry>(),
    );
    const response = await handleExecute(
      { ...minimalDeps(), auditLog: log },
      {
        recipe: targetedRecipe(),
        trigger_source: 'chat',
        context: { entity_id: 'deal-42' },
      },
    );
    expect(response.success).toBe(true);
    const [entry] = await log.listRecent(1);
    expect(entry?.commit_status).toBe('succeeded');
    expect(entry?.context_snapshot).toBeUndefined();
  });

  it('a preflight RESUME skips the guard — the anchor rebuild carries no context', async () => {
    // `buildResumeInputs` (preflight-resumer.ts) re-dispatches an approved
    // held run with the anchor's config but NO caller context; the original
    // dispatch already passed the guard, so re-guarding would block the
    // approved resume of a context-targeted run.
    const response = await handleExecute(
      minimalDeps(),
      { recipe: targetedRecipe(), trigger_source: 'chat' },
      { run_id: 'resume-1', resume_from: { gated_step_id: 'echo', step_state: {} } },
    );
    expect(response.success).toBe(true);
  });

  it('machine dispatch of the same recipe passes the guard (event_trigger)', async () => {
    const response = await handleExecute(minimalDeps(), {
      recipe: targetedRecipe(),
      trigger_source: 'event_trigger',
    });
    // The guard let it through; the run itself completes on the coalesce
    // fallback (the trigger normally injects context.event — engine field).
    expect(response.success).toBe(true);
    expect(response.steps.find((s) => s.id === 'echo')).toMatchObject({ skipped: false });
  });
});
