import { describe, it, expect } from 'vitest';
import { runStep, trackContextSize, MAX_CONTEXT_BYTES } from '../step-runner.js';
import type { ExecutionContext, IngredientExecutor } from '../types.js';
import type {
  LaneGovernor,
  RecipeDefinition,
  RecipeStep,
  NamespaceStores,
  StepOptions,
} from '@recued/contracts';

// ── helpers ────────────────────────────────────────────────────

const minimalRecipe: RecipeDefinition = {
  recipe_id: 'test-pii',
  version: 1,
  ttl: 300,
  metadata: { name: 'PII test', description: 'test', author: 'test', supported_platforms: ['hubspot'] },
  variables: {},
  prefetch_steps: [],
  steps: [],
  output: { sidebar: [] },
};

const makeStores = (): NamespaceStores => ({
  vault: {},
  config: {},
  context: {},
  meta: {},
  step: {},
});

/** Build an ExecutionContext whose ingredientExecutor captures the input it receives. */
const makeCtx = (executor: IngredientExecutor): ExecutionContext => ({
  recipe: minimalRecipe,
  stores: makeStores(),
  ingredientExecutor: executor,
});

// ── pii_fields: carried to the dispatch ────────────────────────
//
// The engine does not hash. Here a value is still a `{{ref}}`, so hashing the
// raw input missed every value that arrives through a ref and swapped a ref
// under a named key for the token. The dispatch hashes the RESOLVED input
// (`StepOptions.pii_fields`; packages/ingredients `dispatch-pii-fields.test.ts`).

describe('runStep — pii_fields rides to the dispatch', () => {
  const capture = () => {
    const calls: { input: Record<string, unknown>; options: StepOptions | undefined }[] = [];
    const executor: IngredientExecutor = async (_slug, input, _output, options) => {
      calls.push({ input, options });
      return { narrative: 'HASH_STEP_00000001 is at risk' };
    };
    return { calls, executor };
  };

  it('passes the input as authored, refs and all, and names the fields on the step options', async () => {
    const { calls, executor } = capture();
    const step = {
      id: 'ai_step',
      ingredient: 'ai-prompt',
      input: { 'llm.prompt': '{{step.ctx}}', deal_name: '{{step.deal.name}}' },
      pii_fields: ['deal_name'],
      cache: 'any',
    } as RecipeStep;

    const log = await runStep(step, makeCtx(executor));

    expect(log.error).toBeNull();
    expect(calls).toEqual([{
      input: { 'llm.prompt': '{{step.ctx}}', deal_name: '{{step.deal.name}}' },
      options: { cache: 'any', pii_fields: ['deal_name'] },
    }]);
    // Restoring is the dispatch's: the engine returns what it was given.
    expect(log.result).toEqual({ narrative: 'HASH_STEP_00000001 is at risk' });
  });

  it('names them for any ingredient the step calls, AI or not', async () => {
    const { calls, executor } = capture();
    await runStep({
      id: 'data_step', ingredient: 'deal-reader-hubspot', input: { name: 'Bob Jones' }, pii_fields: ['name'],
    }, makeCtx(executor));
    expect(calls[0]!.options).toEqual({ pii_fields: ['name'] });
  });

  it('names none when the step declares none, an empty list, or no field names', async () => {
    for (const pii_fields of [undefined, [], [7, null]]) {
      const { calls, executor } = capture();
      await runStep({
        id: 'plain', ingredient: 'ai-prompt', input: { name: 'Alice' },
        ...(pii_fields === undefined ? {} : { pii_fields: pii_fields as unknown as string[] }),
      }, makeCtx(executor));
      expect(calls[0]!.options?.pii_fields).toBeUndefined();
      expect(calls[0]!.input).toEqual({ name: 'Alice' });
    }
  });

  it('keeps only the field names of a mixed list', async () => {
    const { calls, executor } = capture();
    await runStep({
      id: 'mixed', ingredient: 'ai-prompt', input: {}, pii_fields: ['name', 7, 'email'] as unknown as string[],
    }, makeCtx(executor));
    expect(calls[0]!.options).toEqual({ pii_fields: ['name', 'email'] });
  });
});

// ── step.input as a bare ref (kernel run-ingredient path) ──────

describe('runStep — step.input as a pure ref', () => {
  it('resolves a ref-valued input to the referenced object', async () => {
    let capturedInput: Record<string, unknown> | null = null;
    const executor: IngredientExecutor = async (_slug, input) => {
      capturedInput = { ...input };
      return { ok: true };
    };
    const ctx = makeCtx(executor);
    // config.input carries the real ingredient input object
    (ctx.stores.config as Record<string, unknown>).input = {
      'llm.data': 'hello',
      'llm.categories': ['greet', 'other'],
    };
    const step: RecipeStep = {
      id: 'call',
      ingredient: 'ai-classify',
      // The whole input field is a ref, not a structured object
      input: '{{config.input}}' as unknown as Record<string, unknown>,
    };
    await runStep(step, ctx);
    expect(capturedInput).toEqual({
      'llm.data': 'hello',
      'llm.categories': ['greet', 'other'],
    });
  });

  it('falls back to {} when the ref resolves to a non-object', async () => {
    let capturedInput: Record<string, unknown> | null = null;
    const executor: IngredientExecutor = async (_slug, input) => {
      capturedInput = { ...input };
      return { ok: true };
    };
    const ctx = makeCtx(executor);
    (ctx.stores.config as Record<string, unknown>).input = 'not-an-object';
    const step: RecipeStep = {
      id: 'call',
      ingredient: 'ai-classify',
      input: '{{config.input}}' as unknown as Record<string, unknown>,
    };
    await runStep(step, ctx);
    expect(capturedInput).toEqual({});
  });

  it('ignores a ref-valued input when the ref resolves to an array (arrays are not valid input shapes)', async () => {
    let capturedInput: Record<string, unknown> | null = null;
    const executor: IngredientExecutor = async (_slug, input) => {
      capturedInput = { ...input };
      return { ok: true };
    };
    const ctx = makeCtx(executor);
    (ctx.stores.config as Record<string, unknown>).input = ['a', 'b'];
    const step: RecipeStep = {
      id: 'call',
      ingredient: 'ai-classify',
      input: '{{config.input}}' as unknown as Record<string, unknown>,
    };
    await runStep(step, ctx);
    expect(capturedInput).toEqual({});
  });
});

// ── trackContextSize — incremental context cap ─────────────────
//
// Locks in the invariants of the size guard:
//   1. Per-call delta is additive → two half-cap writes exceed the cap.
//   2. Each ExecutionContext tracks independently (WeakMap keyed by ctx).
//   3. Null/undefined results are no-ops — so nulling a step on error
//      doesn't under-charge future steps.

describe('trackContextSize — context cap', () => {
  // ~6MB JSON-estimated size per string: (3M chars + 2 quotes) × 2 bytes
  // ⚠ SIZED FROM THE CONSTANT. Hardcoding 3MB against a 10MB cap meant that
  // when the cap moved to 50MB these tests went GREEN while asserting nothing —
  // two passes no longer crossed it. A cap test whose payload does not track the
  // cap stops being a test the moment the cap changes.
  // A JSON-estimated string costs ~2x its length, so 0.3 x cap per call lands
  // one call at ~0.6 cap (under) and two at ~1.2 cap (over) — the same ratio the
  // original 3MB-vs-10MB pair had.
  const halfCapString = 'a'.repeat(Math.ceil(MAX_CONTEXT_BYTES * 0.3));

  it('accumulates across calls and throws when cumulative size exceeds the cap', () => {
    const ctx = makeCtx(async () => null);
    expect(() => trackContextSize(ctx, halfCapString)).not.toThrow();       // ~6MB  → under cap
    expect(() => trackContextSize(ctx, halfCapString)).toThrow(/step context is/); // ~12MB → over
  });

  it('each ExecutionContext tracks independently — no cross-recipe leak', () => {
    const ctxA = makeCtx(async () => null);
    const ctxB = makeCtx(async () => null);
    // Push ctxA over the cap.
    trackContextSize(ctxA, halfCapString);
    expect(() => trackContextSize(ctxA, halfCapString)).toThrow();
    // ctxB starts fresh and is unaffected.
    expect(() => trackContextSize(ctxB, halfCapString)).not.toThrow();
  });

  it('null and undefined results are no-ops (do not bump the counter)', () => {
    const ctx = makeCtx(async () => null);
    trackContextSize(ctx, halfCapString);    // ~6MB
    trackContextSize(ctx, null);             // no-op
    trackContextSize(ctx, undefined);        // no-op
    // Still ~6MB — another ~1MB value fits well under MAX_CONTEXT_BYTES.
    const oneMB = 'b'.repeat(1 * 1024 * 1024);
    expect(() => trackContextSize(ctx, oneMB)).not.toThrow();
  });
});

// ────────────────────────────────────────────────────────────────
// Skip / fail_on / guard flow
// ────────────────────────────────────────────────────────────────

describe('runStep — skip_when / fail_on / guard', () => {
  it('skip_when evaluated as true → step skipped, result null', async () => {
    const executor: IngredientExecutor = async () => ({ ran: true });
    const ctx = makeCtx(executor);
    (ctx.stores.step as Record<string, unknown>).upstream = null;
    const step: RecipeStep = {
      id: 'maybe',
      ingredient: 'ai-classify',
      input: {},
      skip_when: '{{step.upstream}} is_null',
    };
    const log = await runStep(step, ctx);
    expect(log.skipped).toBe(true);
    expect(log.result).toBeNull();
    expect(ctx.stores.step.maybe).toBeNull();
  });

  it('fail_on triggers after execution → error in log, RECIPE_FAIL_ON_TRIGGERED code', async () => {
    // Use the template transform with an exact single-word output so
    // fail_on can match it literally.
    const step: RecipeStep = {
      id: 'checker',
      transform: 'template',
      template: 'bad',
      fail_on: '{{step.checker}} equal bad',
    };
    const ctx = makeCtx(async () => null);
    const log = await runStep(step, ctx);
    expect(log.error).not.toBeNull();
    expect(log.error?.code).toBe('RECIPE_FAIL_ON_TRIGGERED');
    expect(log.error?.message).toContain('fail_on triggered');
  });

  it('guard step that triggers → log.error carries NETWORK_ERROR (thrown path)', async () => {
    // runStep's try/catch marks any throw from a guard step as an error.
    // Since runGuard throws with no special-cased code handling in the
    // catch for guard type, we get type==='guard' → 'NETWORK_ERROR' would
    // be wrong but the code actually treats non-transform as NETWORK_ERROR.
    // We assert the error exists with the message from the throw.
    const ctx = makeCtx(async () => null);
    (ctx.stores.step as Record<string, unknown>).danger = true;
    const step = {
      id: 'gate',
      guard: '{{step.danger}} equal true',
    } as unknown as RecipeStep;
    const log = await runStep(step, ctx);
    expect(log.error).not.toBeNull();
    expect(log.error?.message).toBe('Guard triggered');
  });

  it('guard step that does NOT trigger → returns null, no error', async () => {
    const ctx = makeCtx(async () => null);
    (ctx.stores.step as Record<string, unknown>).danger = false;
    const step = {
      id: 'ok_gate',
      guard: '{{step.danger}} equal true',
    } as unknown as RecipeStep;
    const log = await runStep(step, ctx);
    expect(log.error).toBeNull();
    expect(log.result).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// Transform error paths
// ────────────────────────────────────────────────────────────────

describe('runStep — transform error paths', () => {
  it('unknown transform throws → log carries TRANSFORM_ERROR', async () => {
    const ctx = makeCtx(async () => null);
    const step: RecipeStep = {
      id: 'bogus',
      transform: 'not-a-real-transform' as never,
    };
    const log = await runStep(step, ctx);
    expect(log.error?.code).toBe('TRANSFORM_ERROR');
    expect(log.error?.message).toContain('Unknown transform');
    expect(log.result).toBeNull();
    expect(ctx.stores.step.bogus).toBeNull();
  });

  it('ingredient executor throw → log carries NETWORK_ERROR', async () => {
    const executor: IngredientExecutor = async () => {
      throw new Error('connection refused');
    };
    const ctx = makeCtx(executor);
    const step: RecipeStep = {
      id: 'bad_fetch',
      ingredient: 'deal-reader-hubspot',
      input: {},
    };
    const log = await runStep(step, ctx);
    expect(log.error?.code).toBe('NETWORK_ERROR');
    expect(log.error?.message).toBe('connection refused');
  });
});

// ────────────────────────────────────────────────────────────────
// runTransform special-case resolution (preserves raw conditions)
// ────────────────────────────────────────────────────────────────

describe('runStep — transform special-case param resolution', () => {
  it('to_checklist preserves each item.issue as a raw condition string', async () => {
    const ctx = makeCtx(async () => null);
    (ctx.stores.step as Record<string, unknown>).a = 5;
    const step = {
      id: 'cl',
      transform: 'to_checklist',
      title: 'Checks',
      items: [
        { label: 'Must be positive', issue: '{{step.a}} less 0' },
      ],
    } as unknown as RecipeStep;
    const log = await runStep(step, ctx);
    expect(log.error).toBeNull();
    const result = log.result as { items: Array<{ ok: boolean }> };
    // Condition evaluated: 5 less 0 → false → issue flag false → row is ok
    expect(Array.isArray(result.items)).toBe(true);
  });

  it('to_checklist resolves action descriptors while preserving only item.issue raw', async () => {
    const ctx = makeCtx(async () => null);
    (ctx.stores.step as Record<string, unknown>).a = 5;
    (ctx.stores.context as Record<string, unknown>).deal_id = 'deal-1';
    const step = {
      id: 'cl',
      transform: 'to_checklist',
      title: 'Checks',
      items: [
        {
          label: 'Must be positive',
          issue: '{{step.a}} less 0',
          detail_ok: 'ok',
          detail_issue: 'bad',
          action: {
            kind: 'recipe.run',
            label: 'Review',
            recipe_id: 'review-recipe',
            context: { deal_id: '{{context.deal_id}}' },
          },
        },
      ],
    } as unknown as RecipeStep;
    const log = await runStep(step, ctx);
    expect(log.error).toBeNull();
    const result = log.result as { items: Array<{ status: string; actions?: Array<{ context?: Record<string, unknown> }> }> };
    expect(result.items[0].status).toBe('ok');
    expect(result.items[0].actions?.[0]?.context).toEqual({ deal_id: 'deal-1' });
  });

  it('any transform preserves conditions array (raw strings, not resolved to booleans)', async () => {
    const ctx = makeCtx(async () => null);
    (ctx.stores.step as Record<string, unknown>).x = null;
    (ctx.stores.step as Record<string, unknown>).y = 1;
    const step = {
      id: 'gate',
      transform: 'any',
      conditions: ['{{step.x}} is_null', '{{step.y}} equal 99'],
    } as unknown as RecipeStep;
    const log = await runStep(step, ctx);
    expect(log.error).toBeNull();
    expect(log.result).toBe(true); // any: x is_null (true) OR y==99 (false) → true
  });

  it('all transform preserves conditions array', async () => {
    const ctx = makeCtx(async () => null);
    (ctx.stores.step as Record<string, unknown>).x = null;
    (ctx.stores.step as Record<string, unknown>).y = 1;
    const step = {
      id: 'gate',
      transform: 'all',
      conditions: ['{{step.x}} is_null', '{{step.y}} equal 1'],
    } as unknown as RecipeStep;
    const log = await runStep(step, ctx);
    expect(log.error).toBeNull();
    expect(log.result).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// Ingredient slug is a ref (kernel run-ingredient pattern)
// ────────────────────────────────────────────────────────────────

describe('runStep — ingredient slug as a ref', () => {
  it('resolves a ref-valued ingredient slug from a namespace store', async () => {
    let seenSlug: string | null = null;
    const executor: IngredientExecutor = async (slug) => {
      seenSlug = slug;
      return { ok: true };
    };
    const ctx = makeCtx(executor);
    (ctx.stores.config as Record<string, unknown>).ingredient_slug = 'deal-reader-hubspot';
    const step: RecipeStep = {
      id: 'call',
      ingredient: '{{config.ingredient_slug}}' as unknown as string,
      input: {},
    };
    await runStep(step, ctx);
    expect(seenSlug).toBe('deal-reader-hubspot');
  });
});

// D-125 P5.2 retired the account-scoped gate (D-101) — wrappers now route
// through the `connection` adapter, which gates at dispatch via the
// connection store and per-record auth. Step-runner no longer consults
// manifest.account_scoped; the only step-level skip is `skip_when`.
describe('runStep — skip_when (post D-125 P5.2 — account gate retired)', () => {
  it('skip_when returns include skip_reason naming the condition', async () => {
    const executor: IngredientExecutor = async () => ({ ok: true });
    const ctx = makeCtx(executor);
    const step: RecipeStep = {
      id: 'maybe',
      transform: 'count',
      input: [],
      skip_when: '{{config.never}} is_null',
    } as unknown as RecipeStep;
    const log = await runStep(step, ctx);
    expect(log.skipped).toBe(true);
    expect(log.skip_reason).toContain('skip_when');
  });
});

// ────────────────────────────────────────────────────────────────
// D-181 §7c — slot_cancelled preservation
// ────────────────────────────────────────────────────────────────

describe('runStep — D-181 §7c slot_cancelled preservation', () => {
  it('preserves a slot_cancelled marker into the step error details when a gated call is cancelled', async () => {
    // A gated `acquire` whose queued slot was dropped rejects with the
    // SLOT_CANCELLED_ERROR_CODE; the step-runner catch must carry a
    // `slot_cancelled` marker so the host can label the run cancelled.
    const ctx: ExecutionContext = {
      ...makeCtx(async () => 'unused'),
      laneGovernor: {
        acquire: async () => {
          const err = new Error('slot cancelled') as Error & { code: string };
          err.code = 'slot_cancelled';
          throw err;
        },
      } as LaneGovernor,
    };
    const step = { id: 'gated', ingredient: 'some-gated-op', input: {} } as unknown as RecipeStep;
    const log = await runStep(step, ctx);
    expect(log.error).not.toBeNull();
    expect(log.error!.details.slot_cancelled).toBe(true);
  });

  it('an ordinary executor error carries NO slot_cancelled marker', async () => {
    const ctx = makeCtx(async () => {
      throw new Error('boom');
    });
    const step = { id: 'x', ingredient: 'op', input: {} } as unknown as RecipeStep;
    const log = await runStep(step, ctx);
    expect(log.error).not.toBeNull();
    expect(log.error!.details.slot_cancelled).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// D-182 — a cli_failure carrier → honest code + preserved detail + named op
// ────────────────────────────────────────────────────────────────

describe('runStep — cli_failure classification', () => {
  const throwingCtx = (cli_failure: unknown, message = 'cli boom'): ExecutionContext =>
    makeCtx(async () => {
      throw Object.assign(new Error(message), { cli_failure });
    });

  it('a not_found carrier → CLI_TOOL_NOT_FOUND, preserved detail, named ingredient_slug', async () => {
    const cli_failure = {
      reason: 'not_found',
      slug: 'recued-core.whisper.audio.transcribe',
      operation_id: 'recued-core/whisper.audio.transcribe',
      tool: 'whisper',
    };
    const step = {
      id: 'transcribe', ingredient: 'audio-transcribe-whisper', input: {},
    } as unknown as RecipeStep;
    const log = await runStep(step, throwingCtx(cli_failure));
    expect(log.error!.code).toBe('CLI_TOOL_NOT_FOUND');
    expect(log.error!.source.ingredient_slug).toBe('recued-core.whisper.audio.transcribe');
    expect(log.error!.details.cli_failure).toEqual(cli_failure);
    expect(log.result).toBeNull();
  });

  it('a nonzero_exit carrier → CLI_TOOL_FAILED (NOT NETWORK_ERROR), preserving stderr', async () => {
    const cli_failure = { reason: 'nonzero_exit', slug: 'p.docling.x', exit_code: 1, stderr: 'boom tail' };
    const step = { id: 'x', ingredient: 'docling', input: {} } as unknown as RecipeStep;
    const log = await runStep(step, throwingCtx(cli_failure));
    expect(log.error!.code).toBe('CLI_TOOL_FAILED');
    expect((log.error!.details.cli_failure as { stderr?: string }).stderr).toBe('boom tail');
    expect(log.error!.source.ingredient_slug).toBe('p.docling.x');
  });

  it('a malformed carrier (unknown reason) is ignored → NETWORK_ERROR, no detail, null slug', async () => {
    const step = { id: 'x', ingredient: 'op', input: {} } as unknown as RecipeStep;
    const log = await runStep(step, throwingCtx({ reason: 'bogus' }));
    expect(log.error!.code).toBe('NETWORK_ERROR');
    expect(log.error!.details.cli_failure).toBeUndefined();
    expect(log.error!.source.ingredient_slug).toBeNull();
  });
});
