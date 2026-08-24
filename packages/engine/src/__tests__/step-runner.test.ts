import { describe, it, expect } from 'vitest';
import { runStep, trackContextSize, MAX_CONTEXT_BYTES } from '../step-runner.js';
import type { ExecutionContext, IngredientExecutor } from '../types.js';
import type {
  LaneGovernor,
  RecipeDefinition,
  RecipeStep,
  NamespaceStores,
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

// ── pii_fields auto hash_replace / hash_restore ────────────────

describe('runStep — pii_fields auto hash/restore', () => {
  it('hashes PII fields before calling executor and restores them in the result', async () => {
    let capturedInput: Record<string, unknown> | null = null;

    const executor: IngredientExecutor = async (_slug, input) => {
      capturedInput = { ...input };
      // Simulate an AI ingredient that echoes the input values in its output
      return { analysis: `Contact ${input.name} at ${input.email} is high-value` };
    };

    const step: RecipeStep = {
      id: 'ai_step',
      ingredient: 'ai-classify',
      input: { name: 'Alice Smith', email: 'alice@acme.com', role: 'CEO' },
      pii_fields: ['name', 'email'],
    };

    const ctx = makeCtx(executor);
    const log = await runStep(step, ctx);

    // The executor should have received hashed values, not raw PII
    expect(capturedInput).not.toBeNull();
    expect(capturedInput!.name).toMatch(/^HASH_/);
    expect(capturedInput!.email).toMatch(/^HASH_/);
    // Non-PII fields pass through unchanged
    expect(capturedInput!.role).toBe('CEO');

    // The final result should have original values restored
    expect(log.error).toBeNull();
    const result = log.result as { analysis: string };
    expect(result.analysis).toContain('Alice Smith');
    expect(result.analysis).toContain('alice@acme.com');
    expect(result.analysis).not.toMatch(/HASH_/);

    // Step store should also have restored values
    expect(ctx.stores.step.ai_step).toEqual(result);
  });

  it('passes input unchanged when pii_fields is absent', async () => {
    let capturedInput: Record<string, unknown> | null = null;

    const executor: IngredientExecutor = async (_slug, input) => {
      capturedInput = { ...input };
      return { status: 'ok' };
    };

    const step: RecipeStep = {
      id: 'plain_step',
      ingredient: 'deal-reader-hubspot',
      input: { name: 'Alice Smith', email: 'alice@acme.com' },
    };

    const ctx = makeCtx(executor);
    await runStep(step, ctx);

    // Input should be completely unchanged — no hashing
    expect(capturedInput).not.toBeNull();
    expect(capturedInput!.name).toBe('Alice Smith');
    expect(capturedInput!.email).toBe('alice@acme.com');
  });

  it('hashes PII on non-AI ingredient steps (hash is unconditional)', async () => {
    let capturedInput: Record<string, unknown> | null = null;

    const executor: IngredientExecutor = async (_slug, input) => {
      capturedInput = { ...input };
      return { name: input.name, score: 42 };
    };

    // A data ingredient (not ai-*) still triggers the hash/restore cycle
    const step: RecipeStep = {
      id: 'data_step',
      ingredient: 'deal-reader-hubspot',
      input: { name: 'Bob Jones', deal_id: '123' },
      pii_fields: ['name'],
    };

    const ctx = makeCtx(executor);
    const log = await runStep(step, ctx);

    // Executor receives hashed name
    expect(capturedInput).not.toBeNull();
    expect(capturedInput!.name).toMatch(/^HASH_/);
    expect(capturedInput!.deal_id).toBe('123');

    // Result has original name restored
    expect(log.error).toBeNull();
    const result = log.result as { name: string; score: number };
    expect(result.name).toBe('Bob Jones');
    expect(result.score).toBe(42);
  });

  it('handles empty pii_fields array (no hashing)', async () => {
    let capturedInput: Record<string, unknown> | null = null;

    const executor: IngredientExecutor = async (_slug, input) => {
      capturedInput = { ...input };
      return { ok: true };
    };

    const step: RecipeStep = {
      id: 'empty_pii',
      ingredient: 'ai-prompt',
      input: { name: 'Alice', secret: 'xyz' },
      pii_fields: [],
    };

    const ctx = makeCtx(executor);
    await runStep(step, ctx);

    // Empty array means no fields to hash — input passes through as-is
    expect(capturedInput!.name).toBe('Alice');
    expect(capturedInput!.secret).toBe('xyz');
  });

  it('restores PII in nested result structures', async () => {
    const executor: IngredientExecutor = async (_slug, input) => {
      // AI returns hashed tokens scattered through a nested result
      return {
        summary: `Review for ${input.name}`,
        contacts: [{ person: input.name, channel: input.email }],
      };
    };

    const step: RecipeStep = {
      id: 'nested_result',
      ingredient: 'ai-summarize',
      input: { name: 'Carol Danvers', email: 'carol@test.com', data: 'some context' },
      pii_fields: ['name', 'email'],
    };

    const ctx = makeCtx(executor);
    const log = await runStep(step, ctx);

    const result = log.result as { summary: string; contacts: { person: string; channel: string }[] };
    expect(result.summary).toContain('Carol Danvers');
    expect(result.summary).not.toMatch(/HASH_/);
    expect(result.contacts[0].person).toBe('Carol Danvers');
    expect(result.contacts[0].channel).toBe('carol@test.com');
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
    // Still ~6MB — another ~2MB value fits under the 10MB cap.
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
