import { describe, expect, it } from 'vitest';
import type { OpStep, PackResolutionContext, RecipeDefinition, RecipeStep } from '@recued/contracts';
import { OP_STEP_PASSTHROUGH_KNOBS } from '@recued/contracts';
import { lowerOpStep, lowerOpStepRecipe, unboundPackRefs, type PackOpResolution } from '../op-step-lower.js';
import { CanonicalOpResolutionError, resolveConnectionAgnosticRecipe } from '../connection-agnostic.js';

describe('lowerOpStep (D-182 Slice 5 Increment 2a — unified lowering dispatcher)', () => {
  it('lowers a closed-kind kernel op to a concrete IngredientStep (delegates to Increment 1)', () => {
    const out = lowerOpStep({ id: 'a', op: 'core.ai.prompt', args: { 'llm.prompt': 'x' } });
    expect(out).toEqual({ id: 'a', ingredient: 'core-ai-prompt', input: { 'llm.prompt': 'x' } });
  });

  it('lowers a core.crm.* op to a bare CanonicalOpStep (drops the convention head, keeps connection/args)', () => {
    const step: OpStep = {
      id: 'deal',
      op: 'core.crm.deal.read',
      connection: '{{config.crm}}',
      args: { id: '{{context.entity_id}}' },
    };
    expect(lowerOpStep(step)).toEqual({
      id: 'deal',
      op: 'deal.read',
      connection: '{{config.crm}}',
      args: { id: '{{context.entity_id}}' },
    });
  });

  it('lowers a core.acct.* op to a bare CanonicalOpStep', () => {
    expect(lowerOpStep({ id: 'inv', op: 'core.acct.invoice.search', connection: '{{config.acct}}' })).toEqual({
      id: 'inv',
      op: 'invoice.search',
      connection: '{{config.acct}}',
    });
  });

  it('carries skip_when / fail_on / cache / foreach through the canonical lowering', () => {
    const out = lowerOpStep({
      id: 'd',
      op: 'core.crm.contact.search',
      connection: '{{config.crm}}',
      foreach: '{{step.ids}}',
      skip_when: '{{step.x}} is_null',
      fail_on: '{{step.y}} equal true',
      cache: 'fresh',
    });
    expect(out).toMatchObject({
      op: 'contact.search',
      foreach: '{{step.ids}}',
      skip_when: '{{step.x}} is_null',
      fail_on: '{{step.y}} equal true',
      cache: 'fresh',
    });
  });

  it('preserves the verb verbatim (verb validity is the downstream resolver\'s job)', () => {
    // a bad verb is NOT rejected here — it lowers, then the resolver rejects it.
    expect(lowerOpStep({ id: 'd', op: 'core.crm.deal.frobnicate', connection: '{{config.crm}}' })).toMatchObject({
      op: 'deal.frobnicate',
    });
  });

  it('fails closed on a mis-conventioned op (core.crm.<acct-family>)', () => {
    expect(() => lowerOpStep({ id: 'x', op: 'core.crm.invoice.read', connection: '{{config.crm}}' })).toThrow(
      CanonicalOpResolutionError,
    );
    expect(() => lowerOpStep({ id: 'x', op: 'core.acct.deal.read', connection: '{{config.acct}}' })).toThrow(
      /mis-conventioned/,
    );
  });

  it('lowers core.acct.ledger_account.read (parseOpId admits `_` in an operation segment)', () => {
    // The acct alias `ledger_account` keeps its underscore (warehouse entity-id
    // identity); `OP_SEGMENT_RE` lets parseOpId admit it in the operation remainder,
    // so it lowers instead of failing closed (the resolved gap).
    expect(lowerOpStep({ id: 'la', op: 'core.acct.ledger_account.read', connection: '{{config.acct}}' })).toEqual({
      id: 'la',
      op: 'ledger_account.read',
      connection: '{{config.acct}}',
    });
  });

  it('family-only convention remainder lowers to the bare family (downstream resolver rejects the missing verb)', () => {
    // `core.crm.deal` (no verb) parses (3 segments) → lowers to `{op:"deal"}`; the
    // downstream resolver requires `<entity>.<verb>` and rejects it (one verb-truth
    // source). Pinned so the boundary is explicit.
    expect(lowerOpStep({ id: 'd', op: 'core.crm.deal', connection: '{{config.crm}}' })).toMatchObject({ op: 'deal' });
  });

  it('returns null for a Tier-P pack op (Increment 2b)', () => {
    expect(lowerOpStep({ id: 't', op: 'recued-core.whisper.audio.transcribe', args: { source: 'x' } })).toBeNull();
  });

  it('returns null for a malformed / unknown kernel op', () => {
    expect(lowerOpStep({ id: 'a', op: 'core.bogus.thing' })).toBeNull();
    expect(lowerOpStep({ id: 'b', op: 'not-an-op' })).toBeNull();
    // valid closed-kind (`ai`), unknown op → miss. (`core.ai.embed` is now a real
    // kernel op after the ai→core migration, so use a still-unknown ai op.)
    expect(lowerOpStep({ id: 'c', op: 'core.ai.nonexistent' })).toBeNull();
  });
});

// ── Increment 2b — Tier-P + the recipe-level lowering pass ──

const mkRecipe = (steps: RecipeStep[]): RecipeDefinition => ({
  recipe_id: 'op-step-lower-test',
  version: 1,
  ttl: 300,
  metadata: { name: 'Op-step lower test', description: 'test', author: 'recued-core', supported_platforms: [] },
  variables: {},
  prefetch_steps: [],
  steps,
  output: { sidebar: [] },
});

// `recued-core.whisper` → cli catalog (no connection); `recued-core.gdrive` →
// connection-bound catalog (an http/connection pack op carries a connection slot).
const PACKS: PackOpResolution = new Map([
  ['recued-core.whisper', { catalog_slug: 'whisper', operations: new Set(['audio.transcribe']) }],
  ['recued-core.gdrive', { catalog_slug: 'gdrive', operations: new Set(['file.download', 'file.list']) }],
]);

describe('lowerPackOpStep (D-182 Slice 5 Increment 2b — Tier-P pack-op resolution)', () => {
  it('lowers a connection-less cli pack op to a pass-through catalog fetch keeping the op id', () => {
    const out = lowerOpStepRecipe(
      mkRecipe([{ id: 't', op: 'recued-core.whisper.audio.transcribe', args: { source: '{{config.src}}' } }]),
      PACKS,
    );
    expect(out.steps).toEqual([
      { id: 't', ingredient: 'whisper', input: { operation: 'audio.transcribe', args: { source: '{{config.src}}' } } },
    ]);
  });

  it('carries the per-instance connection slot + passthrough knobs onto a connection-bound pack op', () => {
    const out = lowerOpStepRecipe(
      mkRecipe([
        {
          id: 'dl',
          op: 'recued-core.gdrive.file.download',
          connection: '{{config.drive}}',
          args: { file_id: '{{item.id}}' },
          foreach: '{{step.files}}',
          skip_when: '{{step.x}} is_null',
          fail_on: '{{step.dl}} is_null',
          cache: 'fresh',
        },
      ]),
      PACKS,
    );
    expect(out.steps).toEqual([
      {
        id: 'dl',
        ingredient: 'gdrive',
        connection: '{{config.drive}}',
        input: { operation: 'file.download', args: { file_id: '{{item.id}}' } },
        foreach: '{{step.files}}',
        skip_when: '{{step.x}} is_null',
        fail_on: '{{step.dl}} is_null',
        cache: 'fresh',
      },
    ]);
  });

  it('carries pii_fields + the D-113 approval knobs onto a pack op-step', () => {
    const out = lowerOpStepRecipe(
      mkRecipe([
        {
          id: 'dl',
          op: 'recued-core.gdrive.file.download',
          connection: '{{config.drive}}',
          args: { file_id: '{{config.id}}' },
          pii_fields: ['owner_email'],
          timeout_ms: 300000,
          on_timeout: 'reject',
          prompt: 'Approve downloading this file?',
        },
      ]),
      PACKS,
    );
    expect(out.steps[0]).toMatchObject({
      ingredient: 'gdrive',
      pii_fields: ['owner_email'],
      timeout_ms: 300000,
      on_timeout: 'reject',
      prompt: 'Approve downloading this file?',
    });
  });

  it('defaults args to {} when the pack op-step omits them', () => {
    const out = lowerOpStepRecipe(mkRecipe([{ id: 'l', op: 'recued-core.gdrive.file.list' }]), PACKS);
    expect(out.steps[0]).toEqual({ id: 'l', ingredient: 'gdrive', input: { operation: 'file.list', args: {} } });
  });

  it('fails closed on a pack with no resolved catalog binding (not in the map)', () => {
    expect(() =>
      lowerOpStepRecipe(mkRecipe([{ id: 'x', op: 'alice.unknownpack.do.thing' }]), PACKS),
    ).toThrow(/^step 'x' uses the alice\.unknownpack pack, which is not installed\. Install that pack, then try again\./);
  });

  it('fails closed on a pack op the catalog does not declare', () => {
    expect(() =>
      lowerOpStepRecipe(mkRecipe([{ id: 'x', op: 'recued-core.whisper.audio.translate' }]), PACKS),
    ).toThrow(/^step 'x' uses 'audio\.translate' from the recued-core\.whisper pack, and the installed version has no such operation\. Update that pack, then try again\./);
  });
});

describe('lowerOpStepRecipe (D-182 Slice 5 Increment 2b — recipe-level lowering pass)', () => {
  it('lowers a mixed-tier recipe, leaving transform/guard/concrete + legacy bare-op steps untouched', () => {
    const transform: RecipeStep = { id: 'pick', transform: 'pick', object: '{{step.k}}', keys: ['a'] };
    const guard: RecipeStep = { id: 'g', guard: 'require', condition: '{{step.k}} is_not_null' } as unknown as RecipeStep;
    const concrete: RecipeStep = { id: 'c', ingredient: 'mail-get', input: { id: '1' } };
    const legacyBare: RecipeStep = { id: 'bare', op: 'deal.search', connection: '{{config.crm}}' } as RecipeStep;
    const out = lowerOpStepRecipe(
      mkRecipe([
        { id: 'k', op: 'core.ai.prompt', args: { 'llm.prompt': 'hi' } }, // kernel closed-kind
        { id: 'd', op: 'core.crm.deal.read', connection: '{{config.crm}}' }, // canonical convention
        { id: 't', op: 'recued-core.whisper.audio.transcribe', args: { source: 'x' } }, // Tier-P
        transform,
        guard,
        concrete,
        legacyBare,
      ]),
      PACKS,
    );
    expect(out.steps).toEqual([
      { id: 'k', ingredient: 'core-ai-prompt', input: { 'llm.prompt': 'hi' } },
      { id: 'd', op: 'deal.read', connection: '{{config.crm}}' }, // bare CanonicalOpStep for the next stage
      { id: 't', ingredient: 'whisper', input: { operation: 'audio.transcribe', args: { source: 'x' } } },
      transform,
      guard,
      concrete,
      legacyBare, // 2-segment id → passthrough, resolveConnectionAgnosticRecipe finishes it
    ]);
  });

  it('is a pure passthrough on a recipe with no op-steps (inert on the current corpus)', () => {
    const recipe = mkRecipe([
      { id: 'c', ingredient: 'mail-get', input: { id: '1' } },
      { id: 'm', transform: 'map', array: '{{step.c}}', expression: { x: '{{item.y}}' } },
    ]);
    const out = lowerOpStepRecipe(recipe, new Map());
    expect(out.steps).toEqual(recipe.steps);
  });

  it('fails closed on a well-formed two-tier id that resolves to nothing', () => {
    expect(() => lowerOpStepRecipe(mkRecipe([{ id: 'e', op: 'core.ai.nonexistent' }]), PACKS)).toThrow(
      /resolves to no kernel op or installed pack binding/,
    );
    expect(() => lowerOpStepRecipe(mkRecipe([{ id: 'u', op: 'core.bogus.thing' }]), PACKS)).toThrow(
      CanonicalOpResolutionError,
    );
  });

  it('preserves a mis-conventioned canonical op error (the convention lowering throws)', () => {
    expect(() =>
      lowerOpStepRecipe(mkRecipe([{ id: 'm', op: 'core.crm.invoice.read', connection: '{{config.crm}}' }]), PACKS),
    ).toThrow(/mis-conventioned/);
  });

  it('composition: lowered concrete kernel + Tier-P steps survive resolveConnectionAgnosticRecipe untouched', () => {
    // The load-bearing invariant of the two-pass design: lowerOpStepRecipe runs
    // FIRST and emits concrete `ingredient` steps; the second pass
    // (resolveConnectionAgnosticRecipe) only rewrites `isCanonicalOpStep` matches,
    // so the kernel + Tier-P IngredientSteps pass through unchanged and bind nothing.
    const lowered = lowerOpStepRecipe(
      mkRecipe([
        { id: 'k', op: 'core.ai.prompt', args: { 'llm.prompt': 'hi' } },
        { id: 't', op: 'recued-core.whisper.audio.transcribe', args: { source: 'x' } },
      ]),
      PACKS,
    );
    // No bare canonical op-step remains, so the resolver never reads `ctx` — a
    // dummy context is safe (proves the second pass leaves concrete steps alone).
    const out = resolveConnectionAgnosticRecipe(lowered, {} as unknown as PackResolutionContext);
    expect(out.recipe.steps).toEqual(lowered.steps);
    expect(out.bindings).toEqual([]);
  });

  // ── D-182 Slice 4 — "read ops in prefetch" lowering ──

  it('lowers a Tier-P prefetch op-step to a concrete catalog PrefetchStep (single fetch)', () => {
    const recipe = mkRecipe([{ id: 'k', op: 'core.ai.prompt', args: {} }]);
    (recipe as { prefetch_steps: unknown[] }).prefetch_steps = [
      { id: 'pf', op: 'recued-core.gdrive.file.download', connection: '{{config.gd}}', args: { file_id: 'x' }, optional: true },
    ];
    const out = lowerOpStepRecipe(recipe, PACKS);
    // steps lowered AND prefetch_steps lowered: the Tier-P read concretizes to a
    // catalog-form PrefetchStep (`ingredient` + `{ operation, args }`), keeping the
    // connection top-level + the prefetch-only `optional`.
    expect(out.steps[0]).toEqual({ id: 'k', ingredient: 'core-ai-prompt', input: {} });
    expect(out.prefetch_steps).toEqual([
      {
        id: 'pf',
        ingredient: 'gdrive',
        connection: '{{config.gd}}',
        input: { operation: 'file.download', args: { file_id: 'x' } },
        optional: true,
      },
    ]);
  });

  it('lowers a connection-less kernel closed-kind prefetch op-step to a concrete kernel PrefetchStep', () => {
    const recipe = mkRecipe([]);
    (recipe as { prefetch_steps: unknown[] }).prefetch_steps = [
      { id: 'enr', op: 'core.data.enrichment.list', args: { scope: 'mail' } },
    ];
    const out = lowerOpStepRecipe(recipe, PACKS);
    expect(out.prefetch_steps).toEqual([
      { id: 'enr', ingredient: 'enrichment-list', input: { scope: 'mail' } },
    ]);
  });

  it('a concrete PrefetchStep in prefetch_steps passes through untouched', () => {
    const recipe = mkRecipe([]);
    (recipe as { prefetch_steps: unknown[] }).prefetch_steps = [
      { id: 'pf', ingredient: 'mail-get', input: { id: 'x' } },
    ];
    const out = lowerOpStepRecipe(recipe, PACKS);
    expect(out.prefetch_steps).toEqual([{ id: 'pf', ingredient: 'mail-get', input: { id: 'x' } }]);
  });

  it('throws on a canonical-convention op-step in prefetch_steps (it decomposes — must live in steps)', () => {
    const recipe = mkRecipe([]);
    (recipe as { prefetch_steps: unknown[] }).prefetch_steps = [
      { id: 'pf', op: 'core.crm.deal.read', connection: '{{config.crm}}', args: {} },
    ];
    expect(() => lowerOpStepRecipe(recipe, PACKS)).toThrow(CanonicalOpResolutionError);
    expect(() => lowerOpStepRecipe(recipe, PACKS)).toThrow(/prefetch/i);
  });

  it('throws on a legacy bare canonical op-step in prefetch_steps', () => {
    const recipe = mkRecipe([]);
    (recipe as { prefetch_steps: unknown[] }).prefetch_steps = [
      { id: 'pf', op: 'deal.search', args: {} },
    ];
    expect(() => lowerOpStepRecipe(recipe, PACKS)).toThrow(/not a two-tier op id/);
  });
});

// ── D-182 watcher prototype — core.watch.time + trigger_steps lowering ──

describe('D-182 watcher prototype — core.watch.time lowering', () => {
  const TIME_ARGS = {
    weekdays: '{{config.weekdays}}',
    start_hour: '{{config.start_hour}}',
    end_hour: '{{config.end_hour}}',
  };

  it('lowers the kernel watch op to its backing time-watcher ingredient (closed-kind path)', () => {
    // core.watch.time is a registered closed-kind kernel op now, so the unified
    // dispatcher resolves it exactly like core.ai.* — args ride through as input.
    expect(lowerOpStep({ id: 'morning', op: 'core.watch.time', args: TIME_ARGS })).toEqual({
      id: 'morning',
      ingredient: 'time-watcher',
      input: TIME_ARGS,
    });
  });

  it('lowers a core.watch.time op-step living in trigger_steps (the canary — mirrors today.json)', () => {
    // The trigger phase runs through the engine's runStep, so a watcher op-step in
    // trigger_steps must lower to its concrete ingredient identically to a `steps`
    // op-step. A non-op trigger step (transform predicate) passes through untouched.
    const passthrough: RecipeStep = {
      id: 'extra_gate',
      transform: 'compare',
      left: '{{step.morning.should_run}}',
      operator: 'equal',
      value: true,
    } as unknown as RecipeStep;
    const recipe: RecipeDefinition = {
      ...mkRecipe([{ id: 'today', op: 'core.ai.prompt', args: { 'llm.prompt': 'x' } }]),
      trigger_steps: [
        { id: 'morning', op: 'core.watch.time', args: TIME_ARGS },
        passthrough,
      ],
    };
    const out = lowerOpStepRecipe(recipe, PACKS);
    // trigger_steps lowered: the watcher op → concrete time-watcher ingredient;
    // the transform gate is left alone.
    expect(out.trigger_steps).toEqual([
      { id: 'morning', ingredient: 'time-watcher', input: TIME_ARGS },
      passthrough,
    ]);
    // steps still lower as before (the shared per-step lowering is unchanged).
    expect(out.steps).toEqual([{ id: 'today', ingredient: 'core-ai-prompt', input: { 'llm.prompt': 'x' } }]);
  });

  it('leaves trigger_steps absent when the recipe declares none (no empty-array injection)', () => {
    const out = lowerOpStepRecipe(mkRecipe([{ id: 'k', op: 'core.ai.prompt', args: {} }]), PACKS);
    expect(out.trigger_steps).toBeUndefined();
  });

  it('carries skip_when through a watcher op-step lowering (per-tick gating preserved)', () => {
    const recipe: RecipeDefinition = {
      ...mkRecipe([]),
      trigger_steps: [
        { id: 'morning', op: 'core.watch.time', args: TIME_ARGS, skip_when: '{{context.server.available}} equal false' },
      ],
    };
    const out = lowerOpStepRecipe(recipe, PACKS);
    expect(out.trigger_steps?.[0]).toEqual({
      id: 'morning',
      ingredient: 'time-watcher',
      input: TIME_ARGS,
      skip_when: '{{context.server.available}} equal false',
    });
  });
});

// Round-12 audit fix (T2 Q1) — the Tier-P lowering consumes the same shared
// knob list as the kernel lowering; this is the pack-branch half of the
// total-carry ratchet (the old hand-kept spread here also dropped `fail_kind`).
describe('Tier-P lowering — total knob carry (round-12 T2 Q1)', () => {
  it('carries every OP_STEP_PASSTHROUGH_KNOBS member onto the concrete catalog step', () => {
    const out = lowerOpStepRecipe(
      mkRecipe([
        {
          id: 't',
          op: 'recued-core.whisper.audio.transcribe',
          args: { source: '{{config.src}}' },
          skip_when: '{{step.x}} is_null',
          fail_on: '{{step.y}} equal true',
          fail_kind: 'policy',
          cache: 'fresh',
          foreach: '{{step.rows}}',
          pii_fields: ['source'],
          timeout_ms: 60_000,
          on_timeout: 'reject',
          prompt: 'Transcribe this file?',
          pages: 'all',
        },
      ]),
      PACKS,
    );
    const step = out.steps[0] as Record<string, unknown>;
    expect(step).toMatchObject({
      ingredient: 'whisper',
      input: { operation: 'audio.transcribe', args: { source: '{{config.src}}' } },
      skip_when: '{{step.x}} is_null',
      fail_on: '{{step.y}} equal true',
      fail_kind: 'policy',
      cache: 'fresh',
      foreach: '{{step.rows}}',
      pii_fields: ['source'],
      timeout_ms: 60_000,
      on_timeout: 'reject',
      prompt: 'Transcribe this file?',
      pages: 'all',
    });
    for (const knob of OP_STEP_PASSTHROUGH_KNOBS) {
      expect(knob in step, `knob '${knob}' must survive the Tier-P lowering`).toBe(true);
    }
  });
});

describe('unboundPackRefs — every pack the lowering would refuse as not installed', () => {
  const withPhases = (
    steps: RecipeStep[],
    trigger: RecipeStep[] = [],
    prefetch: unknown[] = [],
  ): RecipeDefinition => ({
    ...mkRecipe(steps),
    ...(trigger.length > 0 ? { trigger_steps: trigger } : {}),
    prefetch_steps: prefetch as RecipeDefinition['prefetch_steps'],
  });

  it('⛔ names ALL of them, across steps, trigger_steps and prefetch_steps, each once in first-use order', () => {
    // The lowering throws at the first; an owner who installed that one and tried
    // again would be told about the next.
    const recipe = withPhases(
      [
        { id: 'a', op: 'alice.ledger.batch.post' },
        { id: 'b', op: 'recued-core.whisper.audio.transcribe' }, // bound
        { id: 'c', op: 'alice.ledger.entry.get' }, // same pack again
        { id: 'd', op: 'bob.bank.line.search' },
      ],
      [{ id: 'w', op: 'carol.feed.watch.new' }],
      [{ id: 'pf', op: 'dave.sheet.row.read' }],
    );
    expect(unboundPackRefs(recipe, PACKS)).toEqual([
      'alice.ledger', 'bob.bank', 'carol.feed', 'dave.sheet',
    ]);
  });

  it('lists nothing the lowering can bind or never binds against a pack', () => {
    const recipe = withPhases([
      { id: 'k', op: 'core.ai.prompt', args: {} }, // kernel
      { id: 'd', op: 'core.crm.deal.read', connection: '{{config.crm}}' }, // canonical convention
      { id: 'bare', op: 'deal.search', connection: '{{config.crm}}' } as RecipeStep, // legacy bare op
      { id: 'c', ingredient: 'mail-get', input: { id: '1' } }, // concrete
      { id: 't', op: 'recued-core.gdrive.file.list' }, // bound
    ]);
    expect(unboundPackRefs(recipe, PACKS)).toEqual([]);
  });

  it('a pack that is bound but lacks the operation is not listed: that refusal says to update it', () => {
    const recipe = mkRecipe([{ id: 'x', op: 'recued-core.whisper.audio.translate' }]);
    expect(unboundPackRefs(recipe, PACKS)).toEqual([]);
    expect(() => lowerOpStepRecipe(recipe, PACKS)).toThrow(/Update that pack/);
  });

  it('takes any "can this be bound" answer, so a caller can count the packs an install brings in', () => {
    const recipe = mkRecipe([
      { id: 'a', op: 'alice.ledger.batch.post' },
      { id: 'd', op: 'bob.bank.line.search' },
    ]);
    const coming = new Set(['alice.ledger']);
    expect(unboundPackRefs(recipe, { has: (ref) => PACKS.has(ref) || coming.has(ref) })).toEqual(['bob.bank']);
  });

  it('⛔ agrees with the lowering: empty exactly when it lowers, and its first is the pack the lowering names', () => {
    const cases: RecipeDefinition[] = [
      mkRecipe([{ id: 't', op: 'recued-core.whisper.audio.transcribe' }]),
      mkRecipe([{ id: 'x', op: 'alice.ledger.batch.post' }, { id: 'y', op: 'bob.bank.line.search' }]),
      withPhases([{ id: 'k', op: 'core.ai.prompt', args: {} }], [{ id: 'w', op: 'carol.feed.watch.new' }]),
      withPhases([{ id: 'k', op: 'core.ai.prompt', args: {} }], [], [
        { id: 'pf', op: 'dave.sheet.row.read' },
      ]),
      withPhases([{ id: 'g', op: 'recued-core.gdrive.file.download' }], [], [
        { id: 'pf', op: 'recued-core.gdrive.file.list' },
      ]),
    ];
    for (const recipe of cases) {
      const unbound = unboundPackRefs(recipe, PACKS);
      let thrown: string | null = null;
      try {
        lowerOpStepRecipe(recipe, PACKS);
      } catch (e) {
        thrown = (e as Error).message;
      }
      if (unbound.length === 0) {
        expect(thrown, JSON.stringify(recipe.steps)).toBeNull();
      } else {
        expect(thrown).toMatch(new RegExp(`uses the ${unbound[0]!.replace('.', '\\.')} pack, which is not installed`));
      }
    }
  });
});
