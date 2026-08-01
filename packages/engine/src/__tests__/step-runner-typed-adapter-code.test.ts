/** An adapter's own typed `RecipeErrorCode` survives the step seam.
 *
 *  Before this, four carriers (`cli_failure`, `container_pick`, `create_plan`,
 *  `AI_MODEL_REFUSED`) were the only codes that crossed, and every other throw
 *  became the catch-all `NETWORK_ERROR`. That erased `ACTION_DELIVERY_UNCERTAIN`
 *  — the code that means "the write may have landed, verify before retrying" —
 *  and replaced its remedy with "check your connection and try again".
 *
 *  The membership test is derived from `ERR` (a `Record<RecipeErrorCode, _>`, so
 *  its own keys ARE the union and the typechecker keeps them exact). These tests
 *  pin BOTH directions: a member survives, a non-member does not. */

import { describe, expect, it } from 'vitest';

import { runStep } from '../step-runner.js';
import type { ExecutionContext, IngredientExecutor } from '../types.js';
import { ERR } from '@recued/contracts';
import type { NamespaceStores, RecipeDefinition, RecipeStep } from '@recued/contracts';

const minimalRecipe: RecipeDefinition = {
  recipe_id: 'run-ingredient',
  version: 1,
  ttl: 300,
  metadata: { name: 'run', description: 'test', author: 'recued', supported_platforms: [] },
  variables: {},
  prefetch_steps: [],
  steps: [],
  output: { sidebar: [] },
};

const makeStores = (): NamespaceStores => ({
  vault: {}, config: {}, context: {}, meta: {}, step: {},
});

/** A ctx whose ingredient executor throws the shape `IngredientError` produces:
 *  a plain Error carrying `code` + `details`, and nothing else. */
const throwingCtx = (
  thrown: Record<string, unknown>,
  message = 'adapter failed',
): ExecutionContext => {
  const executor: IngredientExecutor = async () => {
    throw Object.assign(new Error(message), thrown);
  };
  return { recipe: minimalRecipe, stores: makeStores(), ingredientExecutor: executor };
};

const ingredientStep = { id: 'call', ingredient: 'connection-api', input: {} } as unknown as RecipeStep;


describe('runStep — an adapter\'s typed code across the step seam', () => {
  it('preserves ACTION_DELIVERY_UNCERTAIN — the write-may-have-landed code', async () => {
    const log = await runStep(
      ingredientStep,
      throwingCtx({ code: 'ACTION_DELIVERY_UNCERTAIN', details: { status: 502 } }),
    );
    expect(log.error!.code).toBe('ACTION_DELIVERY_UNCERTAIN');
  });

  it('preserves MAIL_SEND_SELF_LOOP_TO', async () => {
    const log = await runStep(
      ingredientStep,
      throwingCtx({ code: 'MAIL_SEND_SELF_LOOP_TO' }),
    );
    expect(log.error!.code).toBe('MAIL_SEND_SELF_LOOP_TO');
  });

  // ── the guard's POSITIVE case is above; these are the cases it must REFUSE ──

  it('⛔ a code OUTSIDE RecipeErrorCode falls back — no arbitrary string escapes', async () => {
    // `BAD_INPUT` is really thrown by adapters today and is NOT a union member.
    const log = await runStep(ingredientStep, throwingCtx({ code: 'BAD_INPUT' }));
    expect(log.error!.code).toBe('NETWORK_ERROR');
  });

  it('⛔ an INHERITED key is not a member — hasOwn, not `in`', async () => {
    // `'toString'` is on Object.prototype, so a bare `in` check would admit it
    // and put a non-code into a field typed as a closed union.
    const log = await runStep(ingredientStep, throwingCtx({ code: 'toString' }));
    expect(log.error!.code).toBe('NETWORK_ERROR');
  });

  it('⛔ a non-string code falls back', async () => {
    const log = await runStep(ingredientStep, throwingCtx({ code: 42 }));
    expect(log.error!.code).toBe('NETWORK_ERROR');
  });

  it('⛔ an OBJECT that stringifies to a real code falls back — the typeof check', async () => {
    // ⚠ `42` above cannot prove the `typeof === 'string'` guard: `Object.hasOwn`
    // rejects it anyway, so that mutant survives. This is the witness that
    // separates them — `hasOwn` coerces the key and ACCEPTS this object, so
    // without the typeof check a non-string would be cast to `RecipeErrorCode`
    // and land in the audit row as an object.
    const code = { toString: () => 'ACTION_DELIVERY_UNCERTAIN' };
    expect(Object.hasOwn(ERR, code as unknown as string)).toBe(true); // the guard is load-bearing
    const log = await runStep(ingredientStep, throwingCtx({ code }));
    expect(log.error!.code).toBe('NETWORK_ERROR');
  });

  it('an ordinary throw with no code stays NETWORK_ERROR', async () => {
    const log = await runStep(ingredientStep, throwingCtx({}, 'plain boom'));
    expect(log.error!.code).toBe('NETWORK_ERROR');
    expect(log.error!.message).toBe('plain boom');
  });

  // ── deliberate exclusions ──

  it('the TRANSFORM branch is untouched — a failing transform still codes TRANSFORM_ERROR', async () => {
    // ⚠ This pins the branch, NOT the `type !== 'transform'` guard. That guard
    // has no honest positive case: transforms run through `runTransform`, never
    // the ingredient executor, and nothing on that path throws a coded error
    // (`runTransform` throws a bare `Error` for an unknown name; the codes that
    // LOOK transform-ish, e.g. `TRANSFORM_INVALID_INPUT`, are thrown by
    // ingredients). The guard is defensive, and a fixture forcing a code onto a
    // transform would be testing the fixture. What is real and worth pinning is
    // that the branch still answers TRANSFORM_ERROR after the edit.
    const log = await runStep(
      { id: 'shape', transform: 'no_such_transform', fields: [] } as unknown as RecipeStep,
      // The executor is never reached on a transform step; it is present only
      // because `ExecutionContext` requires it.
      throwingCtx({ code: 'ACTION_DELIVERY_UNCERTAIN' }),
    );
    expect(log.error!.code).toBe('TRANSFORM_ERROR');
  });

  it('a bare AI_MODEL_REFUSED is NOT promoted — D-200 requires its diagnostic', async () => {
    // No `retryable: false`, no `details.finish_reason` → the D-200 branch
    // rejects it, and the generic path must not promote it behind D-200's back.
    const log = await runStep(ingredientStep, throwingCtx({ code: 'AI_MODEL_REFUSED' }));
    expect(log.error!.code).toBe('NETWORK_ERROR');
  });

  it('⛔ adapter DETAILS are still dropped — they carry addresses', async () => {
    const log = await runStep(
      ingredientStep,
      throwingCtx({
        code: 'MAIL_SEND_SELF_LOOP_TO',
        details: { account_email: 'someone@example.com', offending: 'someone@example.com' },
      }),
    );
    expect(log.error!.code).toBe('MAIL_SEND_SELF_LOOP_TO');
    expect(JSON.stringify(log.error!.details)).not.toContain('@');
  });
});
