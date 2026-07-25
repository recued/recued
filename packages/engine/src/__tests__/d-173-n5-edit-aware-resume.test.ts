/** D-173 N.5 — edit-aware resume merge (engine half of "editable args at
 *  the approval gate").
 *
 *  D-157's preflight gate ends the run and a binary approve/deny resumes
 *  a fresh execution that re-runs the recipe AS AUTHORED. D-173 N.5 widens
 *  the resume contract: when the admin-only `reception.inbox.approve` rpc
 *  approves-with-edits, it writes the user's edits to
 *  `Checkpoint.arg_overrides`; the host threads them onto
 *  `ExecutionContext.resumeFrom.arg_overrides`; and the engine shallow-
 *  merges them over the GATED STEP's authored/prefilled args before
 *  dispatch — ONLY the gated step's.
 *
 *  These tests drive the engine merge through `executeRecipe(resumeFrom)`
 *  directly, simulating the host having already plumbed checkpoint-sourced
 *  overrides onto `resumeFrom` (the real plumbing — `buildResumeInputs` →
 *  `internal.resume_from` → `resumeFrom` — is covered by the backend
 *  resumer test). They assert BOTH:
 *    - the with-override path merges over the gated step's args (override
 *      keys win, authored keys preserved) and scopes strictly to the gated
 *      step (a downstream non-gated step's args are untouched);
 *    - the no-override resume is byte-identical to today's binary path;
 *  plus a prototype-pollution-safe merge and an absent-checkpoint /
 *  non-checkpoint-sourced negative.
 *
 *  Spec: docs/d-173-spec.md § N.5; docs/d-157-spec.md § A.2 / TR-5.
 */

import { describe, it, expect } from 'vitest';
import {
  executeRecipe,
  type ExecutionContext,
  type IngredientExecutor,
} from '@recued/engine';
import { PreflightRequiredSignal, isPreflightRequiredSignal } from '@recued/contracts';
import type {
  GatewayCallAudit,
  IngredientManifest,
  NamespaceStores,
  RecipeDefinition,
  RecipeStep,
} from '@recued/contracts';
import { runStep } from '../step-runner.js';

const METADATA = {
  name: 'D-173 N.5 edit-aware resume',
  description: 'editable args at the approval gate (engine merge)',
  author: 'test',
  supported_platforms: ['test'],
};

const baseStores = (): NamespaceStores => ({
  vault: {},
  config: {},
  context: {},
  meta: {},
  step: {},
});

const makeRecipe = (steps: RecipeStep[]): RecipeDefinition => ({
  recipe_id: 'd-173-n5-edit-aware-resume',
  version: 1,
  ttl: 300,
  metadata: METADATA,
  variables: {},
  prefetch_steps: [],
  steps,
  output: { sidebar: [] },
});

const asSteps = (s: Array<Record<string, unknown>>): RecipeStep[] =>
  s as unknown as RecipeStep[];

// A two-ingredient recipe: the gated step (`materialize`) carries an
// OBJECT `input` with authored/prefilled args (what the projection op
// would prefill), and a downstream non-gated step (`sync`) also dispatches
// an ingredient with its own authored args. Object inputs pass through to
// the executor unresolved, so we use concrete literal values and read them
// straight off the captured executor calls.
const gatedStepId = 'materialize';
const twoIngredientSteps = (): RecipeStep[] =>
  asSteps([
    {
      id: gatedStepId,
      ingredient: 'materialize-op',
      input: { start_at: 0, calendar_id: 'authored-cal', title: 'Visitor booking' },
    },
    {
      id: 'sync',
      ingredient: 'sync-op',
      input: { calendar_id: 'authored-cal', mode: 'one_way' },
    },
  ]);

interface Captured {
  slug: string;
  input: unknown;
}

/** An executor that gates `materialize-op` on first contact (the pause
 *  phase) and, after that, records every dispatch (the resume phase). */
const makeRecordingExec = (
  captures: Captured[],
  opts: { gateMaterialize: boolean },
): IngredientExecutor => {
  return async (slug, input) => {
    if (opts.gateMaterialize && slug === 'materialize-op') {
      throw new PreflightRequiredSignal();
    }
    captures.push({ slug, input });
    if (slug === 'materialize-op') return { materialized: true };
    return { synced: true };
  };
};

/** Pause a fresh run on `materialize-op`, returning the awaiting_approval
 *  snapshot the host would persist as a Checkpoint. */
const pauseRun = async (): Promise<Record<string, unknown>> => {
  const ctx: ExecutionContext = {
    recipe: makeRecipe(twoIngredientSteps()),
    stores: baseStores(),
    ingredientExecutor: makeRecordingExec([], { gateMaterialize: true }),
  };
  const paused = await executeRecipe(ctx);
  expect(paused.awaiting_approval).toBeDefined();
  expect(paused.awaiting_approval!.gated_step_id).toBe(gatedStepId);
  return paused.awaiting_approval!.step_state;
};

/** Build a resume context seeded as the host would, with an optional
 *  checkpoint-sourced `arg_overrides`. */
const makeResumeCtx = (
  stepState: Record<string, unknown>,
  captures: Captured[],
  argOverrides?: Record<string, unknown>,
): ExecutionContext => ({
  recipe: makeRecipe(twoIngredientSteps()),
  stores: { ...baseStores(), step: { ...stepState } },
  ingredientExecutor: makeRecordingExec(captures, { gateMaterialize: false }),
  resumeFrom: {
    gated_step_id: gatedStepId,
    ...(argOverrides !== undefined ? { arg_overrides: argOverrides } : {}),
  },
});

describe('D-173 N.5 — with-override resume merge', () => {
  it('shallow-merges arg_overrides over the GATED step\'s authored args (override wins, authored preserved)', async () => {
    const stepState = await pauseRun();
    const captures: Captured[] = [];
    // The inbox edit: move the slot time + repoint the calendar. `title`
    // is NOT edited — it must keep its authored value.
    const resumeCtx = makeResumeCtx(stepState, captures, {
      start_at: 1_700_000_100_000,
      calendar_id: 'edited-cal',
    });
    const resumed = await executeRecipe(resumeCtx);

    expect(resumed.success).toBe(true);
    // The gated dispatch dispatched exactly once on resume (TR-5).
    const materialize = captures.find((c) => c.slug === 'materialize-op');
    expect(materialize).toBeDefined();
    // Override keys win; the un-edited authored `title` is preserved.
    expect(materialize!.input).toEqual({
      start_at: 1_700_000_100_000,
      calendar_id: 'edited-cal',
      title: 'Visitor booking',
    });
  });

  it('scopes strictly to the gated step — a downstream non-gated step\'s args are untouched', async () => {
    const stepState = await pauseRun();
    const captures: Captured[] = [];
    // The same edit repoints `calendar_id` on the GATED step. The
    // downstream `sync` step ALSO has a `calendar_id` arg — it must NOT
    // pick up the override (gated-step-only scoping).
    const resumeCtx = makeResumeCtx(stepState, captures, {
      calendar_id: 'edited-cal',
    });
    await executeRecipe(resumeCtx);

    const sync = captures.find((c) => c.slug === 'sync-op');
    expect(sync).toBeDefined();
    // Byte-identical to the authored sync args — the override did not leak.
    expect(sync!.input).toEqual({ calendar_id: 'authored-cal', mode: 'one_way' });
  });

  it('an override can ADD a key absent from the authored args', async () => {
    const stepState = await pauseRun();
    const captures: Captured[] = [];
    const resumeCtx = makeResumeCtx(stepState, captures, {
      attendee_email: 'visitor@example.com',
    });
    await executeRecipe(resumeCtx);

    const materialize = captures.find((c) => c.slug === 'materialize-op');
    expect(materialize!.input).toEqual({
      start_at: 0,
      calendar_id: 'authored-cal',
      title: 'Visitor booking',
      attendee_email: 'visitor@example.com',
    });
  });
});

describe('D-173 N.5 — no-override resume is byte-identical to today', () => {
  it('resume with NO arg_overrides dispatches the gated step with its authored args unchanged', async () => {
    const stepState = await pauseRun();

    // Resume WITHOUT overrides (the binary approve path).
    const noOverrideCaptures: Captured[] = [];
    const noOverrideCtx = makeResumeCtx(stepState, noOverrideCaptures);
    const resumed = await executeRecipe(noOverrideCtx);
    expect(resumed.success).toBe(true);

    const materialize = noOverrideCaptures.find((c) => c.slug === 'materialize-op');
    // The gated step's authored args reach the executor verbatim — the
    // edit-aware merge is inert when `arg_overrides` is absent.
    expect(materialize!.input).toEqual({
      start_at: 0,
      calendar_id: 'authored-cal',
      title: 'Visitor booking',
    });
    // The downstream step is likewise unchanged.
    const sync = noOverrideCaptures.find((c) => c.slug === 'sync-op');
    expect(sync!.input).toEqual({ calendar_id: 'authored-cal', mode: 'one_way' });
  });

  it('an EMPTY arg_overrides object is a no-op (no keys to merge)', async () => {
    const stepState = await pauseRun();
    const captures: Captured[] = [];
    const resumeCtx = makeResumeCtx(stepState, captures, {});
    await executeRecipe(resumeCtx);

    const materialize = captures.find((c) => c.slug === 'materialize-op');
    expect(materialize!.input).toEqual({
      start_at: 0,
      calendar_id: 'authored-cal',
      title: 'Visitor booking',
    });
  });

  it('does not mutate the recipe\'s authored input literal across runs', async () => {
    // Pause, then resume twice — once with an override, once without. The
    // second (no-override) resume must still see the pristine authored
    // args, proving the merge created a NEW object rather than mutating
    // the step literal. (Each run builds a fresh recipe instance, but this
    // guards the merge-immutability contract explicitly.)
    const stepState = await pauseRun();

    const withCaptures: Captured[] = [];
    await executeRecipe(
      makeResumeCtx(stepState, withCaptures, { calendar_id: 'edited-cal' }),
    );
    expect(
      (withCaptures.find((c) => c.slug === 'materialize-op')!.input as Record<string, unknown>)
        .calendar_id,
    ).toBe('edited-cal');

    const withoutCaptures: Captured[] = [];
    await executeRecipe(makeResumeCtx(stepState, withoutCaptures));
    expect(
      (withoutCaptures.find((c) => c.slug === 'materialize-op')!.input as Record<string, unknown>)
        .calendar_id,
    ).toBe('authored-cal');
  });
});

describe('D-173 N.5 — prototype-pollution-safe merge', () => {
  it('drops __proto__ / constructor / prototype OWN override keys (corrupted/hostile checkpoint)', async () => {
    const stepState = await pauseRun();
    const captures: Captured[] = [];
    // A hostile on-disk checkpoint. `JSON.parse` is exactly how the SQLite
    // collection deserializes a checkpoint blob, and it produces an OWN
    // enumerable `__proto__` key (unlike an object literal, which sets the
    // prototype) — so `Object.entries` sees it and the merge must drop it.
    // `isCheckpoint` already narrows arg_overrides to a plain object; this
    // is the defense-in-depth at the merge itself.
    const hostileOverrides = JSON.parse(
      '{"calendar_id":"edited-cal","__proto__":{"polluted":true},"constructor":{"polluted":true}}',
    ) as Record<string, unknown>;
    const resumeCtx = makeResumeCtx(stepState, captures, hostileOverrides);
    await executeRecipe(resumeCtx);

    const materialize = captures.find((c) => c.slug === 'materialize-op');
    const merged = materialize!.input as Record<string, unknown>;
    // The legitimate override applied.
    expect(merged.calendar_id).toBe('edited-cal');
    // No prototype pollution — Object.prototype stays clean and the merged
    // object carries no own polluting keys.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(merged, 'constructor')).toBe(false);
    expect((merged as { polluted?: unknown }).polluted).toBeUndefined();
  });
});

describe('D-173 N.5 — negative: overrides only flow from resumeFrom (boundary)', () => {
  it('arg_overrides placed in stores/context does NOT reach the gated dispatch (not a conduit)', async () => {
    const stepState = await pauseRun();
    const captures: Captured[] = [];
    // Simulate a hostile caller trying to inject overrides through the
    // namespace stores / context rather than the checkpoint-sourced
    // resumeFrom channel. The engine reads overrides ONLY from
    // resumeFrom.arg_overrides — these must be ignored.
    const ctx: ExecutionContext = {
      recipe: makeRecipe(twoIngredientSteps()),
      stores: {
        ...baseStores(),
        step: { ...stepState },
        // a bogus injection site
        context: { arg_overrides: { calendar_id: 'INJECTED' } } as Record<string, unknown>,
      },
      ingredientExecutor: makeRecordingExec(captures, { gateMaterialize: false }),
      // resumeFrom carries NO arg_overrides — the binary path.
      resumeFrom: { gated_step_id: gatedStepId },
    };
    await executeRecipe(ctx);

    const materialize = captures.find((c) => c.slug === 'materialize-op');
    // The gated step dispatched with PRISTINE authored args — the
    // store/context injection was never consulted.
    expect(materialize!.input).toEqual({
      start_at: 0,
      calendar_id: 'authored-cal',
      title: 'Visitor booking',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// N.5 §3 — approve-with-edits `approved_target` reconciliation.
//
// The engine has NO special-case relaxation for an edited resume: the
// recompute is an APPROVE-TIME act of the admin-only `reception.inbox.
// approve` rpc, which (re)computes `approved_target` from the MERGED args
// and writes it onto the checkpoint alongside `arg_overrides`. On resume
// the gated step's `connection` is re-resolved AFTER the 3b merge applies
// the override, so the dispatch's re-resolved `(slug, operation_id,
// connection_name)` reflects the edit — and the engine's EXISTING exact-
// match drift guard verifies it against the recomputed `approved_target`.
//
// These tests drive the FULL `runStep` → merge → resolveCatalogConnection
// → catalog gate path with a catalog-form manifest, exercising the gate's
// op-identity binding against an edited connection.
// ─────────────────────────────────────────────────────────────────────

const writeCatalogManifest: IngredientManifest = {
  slug: 'reception-catalog',
  name: 'Reception (catalog)',
  description: '',
  author: 'recued-core',
  kind: 'connection',
  category: 'action',
  risk_tier: 'read',
  input: { operation: null, args: null },
  output: { result: 'result' },
  operations: {
    'booking.create': {
      operation_id: 'recued-core/reception.booking.create',
      risk_tier: 'write',
      groups: ['recued-core/reception.bookings.write'],
      approval: 'ask',
    },
  },
  surfaces: {
    api: {
      transport: 'rest',
      default_base_url: 'https://api.example.com',
      auth: { kind: 'none' },
      executes: {
        'booking.create': {
          kind: 'rest', method: 'POST', path_template: '/bookings',
        },
      },
    },
  },
};

const makeCatalogCtx = (
  argOverrides: Record<string, unknown> | undefined,
  approvedTargetConnection: string,
): {
  ctx: ExecutionContext;
  executorCalls: Array<{ slug: string; input: Record<string, unknown> }>;
  auditCalls: GatewayCallAudit[];
} => {
  const executorCalls: Array<{ slug: string; input: Record<string, unknown> }> = [];
  const auditCalls: GatewayCallAudit[] = [];
  const ingredientExecutor: IngredientExecutor = async (slug, input) => {
    executorCalls.push({ slug, input: input as Record<string, unknown> });
    return { ok: true };
  };
  const ctx = {
    recipe: { recipe_id: 'reception-r', steps: [] },
    stores: { config: {}, step: {} },
    ingredientExecutor,
    // D-209 Slice B — an anonymous RECEPTION dispatch (the door this resume path
    // serves) resolves the LOW `read` ceiling, so the write booking HOLDS and the
    // approved_target drift guard engages (an owner `admin` ceiling would relax the
    // write to admit and skip the re-ask — the wrong posture for a public door).
    execution_source: {
      channel: 'reception',
      actor: 'anonymous',
      reception_id: 'rc1',
    },
    manifestGetter: (slug: string) =>
      slug === 'reception-catalog' ? writeCatalogManifest : null,
    // The connection-keyed profile grants the operation on whatever
    // connection it resolves to (the test's axis is op-identity match,
    // not grant).
    connectionProfileResolver: () => ({
      allowed_operations: ['booking.create'],
    }),
    onGatewayCall: (e: GatewayCallAudit) => {
      auditCalls.push(e);
    },
    // The host-injected resume state: the consumed checkpoint's
    // arg_overrides + the RECOMPUTED approved_target. (Round 2's
    // reception.inbox.approve writes both; here the test plays that role.)
    resumeFrom: {
      gated_step_id: 'create',
      ...(argOverrides !== undefined ? { arg_overrides: argOverrides } : {}),
      approved_target: {
        ingredient_slug: 'reception-catalog',
        operation_id: 'recued-core/reception.booking.create',
        connection_name: approvedTargetConnection,
      },
    },
  } as unknown as ExecutionContext;
  return { ctx, executorCalls, auditCalls };
};

// The gated step: a write op whose connection comes from `input.connection`
// (the connection-adapter fallback `resolveCatalogConnection` consults), so
// an `arg_overrides.connection` edit re-points the resolved connection.
const catalogGatedStep = (): RecipeStep =>
  ({
    id: 'create',
    ingredient: 'reception-catalog',
    input: {
      operation: 'booking.create',
      connection: 'authored-conn',
      args: { slot: ' 9am' },
    },
  } as unknown as RecipeStep);

describe('D-173 N.5 §3 — approved_target reconciliation (recomputed at approve time)', () => {
  it('ADMITS an edited resume when the recomputed approved_target matches the post-merge connection', async () => {
    // The admin edited the destination connection; reception.inbox.approve
    // recomputed approved_target.connection_name to the EDITED connection.
    const { ctx, executorCalls, auditCalls } = makeCatalogCtx(
      { connection: 'edited-conn' },
      'edited-conn',
    );
    const log = await runStep(catalogGatedStep(), ctx);

    // No re-ask — the call admitted and dispatched once.
    expect(log.error).toBeNull();
    expect(log.result).toEqual({ ok: true });
    expect(executorCalls).toHaveLength(1);
    // The dispatch ran against the EDITED connection (the merge re-pointed
    // `input.connection` before resolveCatalogConnection read it).
    expect(executorCalls[0].input).toMatchObject({
      method: 'POST',
      path: '/bookings',
      connection: 'edited-conn',
    });
    expect(auditCalls.filter((e) => e.outcome === 'success')).toHaveLength(1);
  });

  it('RE-ASKS when approved_target was NOT recomputed (stale = pre-edit connection) — drift guard intact on the edited path', async () => {
    // The override re-points the connection to `edited-conn`, but
    // approved_target still names the PRE-edit `authored-conn` (a stale /
    // un-recomputed target). The exact-match drift guard must re-ask: the
    // engine never blindly trusts an edited resume.
    const { ctx, executorCalls, auditCalls } = makeCatalogCtx(
      { connection: 'edited-conn' },
      'authored-conn',
    );
    let caught: unknown;
    try {
      await runStep(catalogGatedStep(), ctx);
    } catch (e) {
      caught = e;
    }

    expect(isPreflightRequiredSignal(caught)).toBe(true);
    // The re-ask names the CURRENT (post-merge) identity — a fresh ask for
    // the drifted call, fail closed.
    expect(caught).toMatchObject({
      operation_id: 'recued-core/reception.booking.create',
      connection_name: 'edited-conn',
    });
    // No dispatch, no success audit (the call never happened).
    expect(executorCalls).toHaveLength(0);
    expect(auditCalls.filter((e) => e.outcome === 'success')).toHaveLength(0);
  });

  it('ADMITS a no-edit binary resume against the authored connection (byte-identical drift-guard path)', async () => {
    // Control: no arg_overrides at all. The authored connection resolves,
    // approved_target matches it, the call admits — exactly today's path.
    const { ctx, executorCalls } = makeCatalogCtx(undefined, 'authored-conn');
    const log = await runStep(catalogGatedStep(), ctx);

    expect(log.error).toBeNull();
    expect(executorCalls).toHaveLength(1);
    expect(executorCalls[0].input).toMatchObject({ connection: 'authored-conn' });
  });
});

// ─────────────────────────────────────────────────────────────────────
// N.5 (args-aware) — THE BUG FIX. A catalog-op step compiles to
// `{ operation, args }` and the catalog gateway dispatches
// `asRecord(input.args)`. The inbox `reception.inbox.approve` writes the
// validated edits as FLAT allowlist keys — the args payload's OWN field
// names (`slot` / `title` / `source_id`), NOT wrapped in an `args` envelope.
// Before the fix the engine merged those FLAT over `input`, so an edit
// landed BESIDE `input.args` and the gateway silently ignored it
// (approve-as-prefilled worked; approve-WITH-edits dropped the edit).
//
// These tests drive the FULL `runStep` → args-aware merge → catalog gate →
// REST surface dispatch path with a CONTENT edit delivered the way the rpc
// really writes it (flat allowlist key) — NO `{ args: … }` workaround — and
// prove the edit reaches `input.args` (visible folded into the dispatched
// wire input the materialize would consume). `buildApiDispatchInput` folds
// each `input.args` key to a top-level wire key, so a reached args field
// surfaces as a top-level key on the captured executor call.
// ─────────────────────────────────────────────────────────────────────

// A catalog manifest whose REST binding folds the args payload to the wire
// (POST /bookings). `slot` / `title` are CONTENT fields of `input.args`.
const contentCatalogManifest: IngredientManifest = {
  slug: 'reception-content-catalog',
  name: 'Reception content (catalog)',
  description: '',
  author: 'recued-core',
  kind: 'connection',
  category: 'action',
  risk_tier: 'read',
  input: { operation: null, args: null },
  output: { result: 'result' },
  operations: {
    'booking.create': {
      operation_id: 'recued-core/reception.booking.create',
      risk_tier: 'write',
      groups: ['recued-core/reception.bookings.write'],
      // auto-admit (grant present) so the dispatch runs and we can inspect
      // the wire payload the gateway built from `input.args`.
      approval: 'never',
    },
  },
  surfaces: {
    api: {
      transport: 'rest',
      default_base_url: 'https://api.example.com',
      auth: { kind: 'none' },
      executes: {
        'booking.create': {
          kind: 'rest', method: 'POST', path_template: '/bookings',
        },
      },
    },
  },
};

const makeContentCatalogCtx = (
  argOverrides: Record<string, unknown> | undefined,
  extraStores?: Record<string, unknown>,
): {
  ctx: ExecutionContext;
  executorCalls: Array<{ slug: string; input: Record<string, unknown> }>;
} => {
  const executorCalls: Array<{ slug: string; input: Record<string, unknown> }> = [];
  const ingredientExecutor: IngredientExecutor = async (slug, input) => {
    executorCalls.push({ slug, input: input as Record<string, unknown> });
    return { ok: true };
  };
  const ctx = {
    recipe: { recipe_id: 'reception-content-r', steps: [] },
    stores: { config: {}, step: {}, ...(extraStores ?? {}) },
    ingredientExecutor,
    manifestGetter: (slug: string) =>
      slug === 'reception-content-catalog' ? contentCatalogManifest : null,
    connectionProfileResolver: () => ({
      allowed_operations: ['booking.create'],
    }),
    resumeFrom: {
      gated_step_id: 'create',
      ...(argOverrides !== undefined ? { arg_overrides: argOverrides } : {}),
      approved_target: {
        ingredient_slug: 'reception-content-catalog',
        operation_id: 'recued-core/reception.booking.create',
        connection_name: 'authored-conn',
      },
    },
  } as unknown as ExecutionContext;
  return { ctx, executorCalls };
};

// The gated catalog-op step: `{ operation, connection, args:{…} }` — the
// N.18-compiled shape with the projection payload PREFILLED in `args`.
const contentCatalogStep = (): RecipeStep =>
  ({
    id: 'create',
    ingredient: 'reception-content-catalog',
    input: {
      operation: 'booking.create',
      connection: 'authored-conn',
      args: { slot: 'authored-9am', title: 'Authored title' },
    },
  } as unknown as RecipeStep);

describe('D-157 N.5 (args-aware) — a CONTENT edit reaches input.args (the bug fix)', () => {
  it('merges a FLAT allowlist content edit INTO input.args (not flat beside it) — the gateway dispatch carries the EDITED value', async () => {
    // The inbox approved WITH an edit on `slot` (a content field of the
    // projection payload), written FLAT the way `reception.inbox.approve`
    // really writes it — NOT `{ args: { slot } }`.
    const { ctx, executorCalls } = makeContentCatalogCtx({ slot: 'edited-3pm' });
    const log = await runStep(contentCatalogStep(), ctx);

    expect(log.error).toBeNull();
    expect(log.result).toEqual({ ok: true });
    expect(executorCalls).toHaveLength(1);
    // `buildApiDispatchInput` folds each `input.args` key to the wire. The
    // EDITED `slot` reached `input.args` (would-be ignored under the old flat
    // merge) and the UN-edited `title` kept its authored value.
    expect(executorCalls[0].input).toMatchObject({
      method: 'POST',
      path: '/bookings',
      connection: 'authored-conn',
      slot: 'edited-3pm',
      title: 'Authored title',
    });
    // The edit did NOT leak to a flat top-level `input` key bypassing `args`
    // — there is no second `slot` source; the single folded value is the edit.
    expect(executorCalls[0].input.slot).toBe('edited-3pm');
  });

  it('an edit can ADD an args field absent from the prefilled payload', async () => {
    const { ctx, executorCalls } = makeContentCatalogCtx({
      attendee_email: 'visitor@example.com',
    });
    await runStep(contentCatalogStep(), ctx);

    expect(executorCalls[0].input).toMatchObject({
      slot: 'authored-9am',
      title: 'Authored title',
      attendee_email: 'visitor@example.com',
    });
  });

  it('splits a MIXED override: a structural `connection` stays top-level while a content key descends into `args` (one override, both effects)', async () => {
    // A single override carrying BOTH a structural identity key (`connection`)
    // and a content key (`title`). The structural key must re-point the
    // top-level `input.connection` (so `resolveCatalogConnection` reads it),
    // while the content key must land in `input.args` (so the gateway folds
    // it). approved_target is recomputed to the edited connection (the §3
    // reconciliation), so the gate ADMITS.
    const { ctx, executorCalls } = makeContentCatalogCtx({
      connection: 'authored-conn', // unchanged identity — admit
      title: 'Edited title',
    });
    await runStep(contentCatalogStep(), ctx);

    expect(executorCalls).toHaveLength(1);
    expect(executorCalls[0].input).toMatchObject({
      connection: 'authored-conn', // structural override resolved top-level
      slot: 'authored-9am',
      title: 'Edited title', // content override folded from input.args
    });
  });
});

describe('D-157 N.5 (args-aware) — no-override resume on a catalog-op step is byte-identical', () => {
  it('a no-override resume dispatches the gated catalog-op step with its prefilled args unchanged', async () => {
    const { ctx, executorCalls } = makeContentCatalogCtx(undefined);
    const log = await runStep(contentCatalogStep(), ctx);

    expect(log.error).toBeNull();
    expect(executorCalls).toHaveLength(1);
    expect(executorCalls[0].input).toMatchObject({
      method: 'POST',
      path: '/bookings',
      connection: 'authored-conn',
      slot: 'authored-9am',
      title: 'Authored title',
    });
  });

  it('an EMPTY arg_overrides object is a no-op on a catalog-op step (prefilled args reach the wire)', async () => {
    const { ctx, executorCalls } = makeContentCatalogCtx({});
    await runStep(contentCatalogStep(), ctx);

    expect(executorCalls[0].input).toMatchObject({
      slot: 'authored-9am',
      title: 'Authored title',
    });
  });
});

describe('D-157 N.5 (args-aware) — Boundary preserved on the catalog-op path', () => {
  it('does NOT mutate the step\'s authored args literal — a content merge produces a fresh input.args object', async () => {
    const step = contentCatalogStep();
    const authoredArgs = (step as unknown as { input: { args: Record<string, unknown> } })
      .input.args;
    const { ctx } = makeContentCatalogCtx({ slot: 'edited-3pm' });
    await runStep(step, ctx);

    // The step's own authored `args` literal is untouched — the merge cloned
    // it (so a re-run of the same recipe instance sees pristine args).
    expect(authoredArgs).toEqual({ slot: 'authored-9am', title: 'Authored title' });
  });

  it('a content override placed in stores/context does NOT reach input.args (overrides flow ONLY from resumeFrom)', async () => {
    // A hostile caller seeds a bogus override on the namespace stores. The
    // engine reads overrides ONLY from resumeFrom.arg_overrides — the
    // store/context value is never consulted. resumeFrom carries NO overrides
    // (the binary path), so the prefilled args reach the wire pristine.
    const { ctx, executorCalls } = makeContentCatalogCtx(undefined, {
      context: { arg_overrides: { slot: 'INJECTED' } },
    });
    await runStep(contentCatalogStep(), ctx);

    expect(executorCalls[0].input).toMatchObject({
      slot: 'authored-9am', // pristine — the injection was never consulted
      title: 'Authored title',
    });
    expect(executorCalls[0].input.slot).not.toBe('INJECTED');
  });

  it('drops a prototype-sensitive content override key on the catalog-op path (corrupted/hostile checkpoint)', async () => {
    // A hostile on-disk checkpoint with a __proto__ override key alongside a
    // legitimate content edit. JSON.parse produces an OWN enumerable
    // __proto__ key (how the SQLite blob deserializes); the args-aware merge
    // must drop it at the args level too — no pollution into input.args.
    const hostileOverrides = JSON.parse(
      '{"slot":"edited-3pm","__proto__":{"polluted":true},"constructor":{"polluted":true}}',
    ) as Record<string, unknown>;
    const { ctx, executorCalls } = makeContentCatalogCtx(hostileOverrides);
    await runStep(contentCatalogStep(), ctx);

    // The legitimate edit applied into args.
    expect(executorCalls[0].input.slot).toBe('edited-3pm');
    // No prototype pollution — Object.prototype stays clean.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // No own polluting key smuggled onto the dispatched wire input.
    expect((executorCalls[0].input as { polluted?: unknown }).polluted).toBeUndefined();
  });
});
