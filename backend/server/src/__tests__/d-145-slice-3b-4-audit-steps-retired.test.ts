/** D-145 engine-wiring slice 3b.4 — audit steps retirement.
 *
 *  The recipe-run audit surfaces are run-level envelopes now. Per-call
 *  detail remains on the live execute response and the D-153 commit log.
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  IngredientManifest,
  RecipeDefinition,
  RecipeError,
} from '@recued/contracts';
import {
  buildAuditEntry,
  buildExportEntry,
  type AuditEntry,
  type AuditEntryInput,
  type AuditExportLinkRow,
} from '@recued/storage';

import { projectAuditEntryForMcp } from '../chat-tool-handlers.js';
import {
  handleExecute,
  type ExecuteHandlerDeps,
} from '../execute-handler.js';
import {
  createManifestRegistry,
  type ManifestRegistry,
} from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';

const retiredStepsPayload = [
  {
    id: 'legacy-step',
    type: 'ingredient',
    skipped: false,
    duration_ms: 12,
    result: { secret: 'legacy-step-result-must-not-surface' },
  },
] as const;

const mkError = (overrides: Partial<RecipeError> = {}): RecipeError => ({
  error_id: 'err-3b4',
  code: 'NETWORK_ERROR',
  message: 'fetch failed at /private/tmp/customer.json',
  severity: 'error',
  source: {
    recipe_id: 'd-145-slice-3b-4',
    step_id: 'send_http',
    ingredient_slug: 'slice-3b-4-http',
  },
  details: { vendor_token: 'vendor-secret-token' },
  timestamp: '2026-05-20T12:00:00.000Z',
  retryable: false,
  ...overrides,
});

const baseAuditEntry = (
  overrides: Partial<AuditEntry> = {},
): AuditEntry => ({
  run_id: 'run-3b4',
  recipe_id: 'd-145-slice-3b-4',
  recipe_hash: 'hash-3b4',
  started_at: 1_800_000_000_000,
  finished_at: 1_800_000_000_037,
  duration_ms: 37,
  commit_status: 'failed',
  config_snapshot: { threshold: 7, mode: 'audit-envelope' },
  errors: [mkError()],
  trigger_url: 'https://example.test/opportunity/42',
  trigger_source: 'manual',
  instance_id: 'server-test-1',
  ...overrides,
});

const withRetiredSteps = (
  entry: AuditEntry,
): AuditEntry & { steps: typeof retiredStepsPayload } => ({
  ...entry,
  steps: retiredStepsPayload,
});

const buildManifest = (
  overrides: Partial<IngredientManifest> = {},
): IngredientManifest =>
  ({
    slug: 'slice-3b-4-http',
    name: 'Slice 3b.4 HTTP',
    description: 'HTTP fixture for live execute response step coverage.',
    author: 'test',
    kind: 'http',
    category: 'action',
    risk_tier: 'write',
    version: 1,
    input: {
      method: 'POST',
      url: 'https://example.test/execute',
    },
    output: { ok: 'ok' },
    ...overrides,
  }) as IngredientManifest;

const ingredientStep = (
  input: Record<string, unknown>,
): RecipeDefinition['steps'][number] =>
  ({
    id: 'send_http',
    ingredient: 'slice-3b-4-http',
    input,
  }) as RecipeDefinition['steps'][number];

const buildRecipe = (
  input: Record<string, unknown>,
): RecipeDefinition =>
  ({
    recipe_id: 'd-145-slice-3b-4-live-steps',
    version: 1,
    ttl: 60,
    metadata: {
      name: 'D-145 slice 3b.4 live steps',
      description: 'Minimal recipe fixture for live execute response steps.',
      author: 'test',
      supported_platforms: ['test'],
      tags: ['test', 'd-145', 'steps'],
    },
    variables: {},
    prefetch_steps: [],
    steps: [ingredientStep(input)],
    output: { sidebar: [] },
  }) as RecipeDefinition;

const registerManifests = (
  registry: ManifestRegistry,
  manifests: readonly IngredientManifest[],
): void => {
  for (const manifest of manifests) registry.register(manifest);
};

const makeExecuteDeps = (
  recipe: RecipeDefinition,
  manifests: readonly IngredientManifest[],
): ExecuteHandlerDeps => {
  const registry = createManifestRegistry('/nonexistent');
  registerManifests(registry, manifests);
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(recipe);
  return {
    recipeStore,
    executorConfig: { manifests: registry },
    baseVault: {},
    instanceId: 'server-test-1',
  };
};

describe('D-145 slice 3b.4 audit envelope retirement', () => {
  it('buildAuditEntry emits no steps property while preserving run envelope fields', () => {
    const err = mkError();
    const input: AuditEntryInput & { steps: typeof retiredStepsPayload } = {
      recipe_id: 'd-145-slice-3b-4',
      recipe_hash: 'hash-3b4',
      commit_status: 'failed',
      duration_ms: 37,
      errors: [err],
      config_snapshot: { threshold: 7, mode: 'audit-envelope' },
      run_id: 'run-3b4-build',
      now: 1_800_000_000_037,
      steps: retiredStepsPayload,
    };

    const entry = buildAuditEntry(input);

    expect('steps' in entry).toBe(false);
    expect(entry.run_id).toBe('run-3b4-build');
    expect(entry.recipe_id).toBe('d-145-slice-3b-4');
    expect(entry.recipe_hash).toBe('hash-3b4');
    expect(entry.commit_status).toBe('failed');
    expect(entry.duration_ms).toBe(37);
    expect(entry.finished_at).toBe(1_800_000_000_037);
    expect(entry.started_at).toBe(1_800_000_000_000);
    expect(entry.config_snapshot).toEqual({
      threshold: 7,
      mode: 'audit-envelope',
    });
    expect(entry.errors).toEqual([err]);
  });

  it('buildExportEntry emits no step_metadata while preserving id, recipe, errors, and links', () => {
    const entry = withRetiredSteps(baseAuditEntry({ run_id: 'run-3b4-export' }));
    const links: AuditExportLinkRow[] = [
      {
        memory_id: entry.run_id,
        entity_id: 'deal-42',
        kind: 'source_record',
        ts: 1_800_000_000_040,
      },
    ];

    const exported = buildExportEntry(entry, links);

    expect('step_metadata' in exported).toBe(false);
    expect(exported.id).toBe('run-3b4-export');
    expect(exported.recipe_id).toBe(entry.recipe_id);
    expect(exported.errors).toEqual([
      {
        code: 'NETWORK_ERROR',
        message: 'fetch failed at /private/tmp/customer.json',
        step_id: 'send_http',
      },
    ]);
    expect(exported.links).toEqual([
      {
        entity_id: 'deal-42',
        kind: 'source_record',
        ts: 1_800_000_000_040,
      },
    ]);
  });

  it('projectAuditEntryForMcp emits no steps while preserving identifiers and redacted errors', () => {
    const entry = withRetiredSteps(baseAuditEntry({
      run_id: 'run-3b4-mcp',
      process_id: 'proc-3b4',
      output_string: 'failed: NETWORK_ERROR',
      recipe_insight_id: 42,
      event_at: 1_799_999_999_000,
      run_mode: 'live',
      backfill: {
        missed_cycles: 2,
        last_run_at_before: 1_799_990_000_000,
      },
    }));

    const projected = projectAuditEntryForMcp(entry);

    expect('steps' in projected).toBe(false);
    expect(projected.run_id).toBe(entry.run_id);
    expect(projected.recipe_id).toBe(entry.recipe_id);
    expect(projected.recipe_hash).toBe(entry.recipe_hash);
    expect(projected.started_at).toBe(entry.started_at);
    expect(projected.finished_at).toBe(entry.finished_at);
    expect(projected.duration_ms).toBe(entry.duration_ms);
    expect(projected.commit_status).toBe(entry.commit_status);
    expect(projected.trigger_url).toBe(entry.trigger_url);
    expect(projected.trigger_source).toBe(entry.trigger_source);
    expect(projected.instance_id).toBe(entry.instance_id);
    expect(projected.process_id).toBe(entry.process_id);
    expect(projected.output_string).toBe(entry.output_string);
    expect(projected.recipe_insight_id).toBe(entry.recipe_insight_id);
    expect(projected.event_at).toBe(entry.event_at);
    expect(projected.run_mode).toBe(entry.run_mode);
    expect(projected.backfill).toEqual(entry.backfill);
    expect(projected.errors).toEqual([
      {
        error_id: 'err-3b4',
        code: 'NETWORK_ERROR',
        severity: 'error',
        retryable: false,
        source: {
          recipe_id: 'd-145-slice-3b-4',
          step_id: 'send_http',
          ingredient_slug: 'slice-3b-4-http',
        },
      },
    ]);
    expect('message' in projected.errors[0]!).toBe(false);
    expect('details' in projected.errors[0]!).toBe(false);
    expect('timestamp' in projected.errors[0]!).toBe(false);
    expect(JSON.stringify(projected)).not.toContain(
      'legacy-step-result-must-not-surface',
    );
  });
});

describe('D-145 slice 3b.4 live execute response guard', () => {
  it('keeps live-run ExecuteResponse.steps populated', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const recipe = buildRecipe({ body: { message: 'keep live steps' } });
      const deps = makeExecuteDeps(recipe, [buildManifest()]);

      const result = await handleExecute(deps, {
        recipe_id: recipe.recipe_id,
        trigger_source: 'manual',
      });

      expect(result.success).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0]).toMatchObject({
        id: 'send_http',
        type: 'ingredient',
        skipped: false,
        error: null,
      });
      expect(result.steps[0]!.duration_ms).toEqual(expect.any(Number));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
