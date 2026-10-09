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
import {
  ERR, RecordsContractError, RECORDS_REFUSAL_RECIPE_CODES, RPC_CODES_LEFT_UNNAMED, RPC_REFUSAL_RECIPE_CODES,
} from '@recued/contracts';
import type { NamespaceStores, RecipeDefinition, RecipeStep, RecordsErrorCode } from '@recued/contracts';

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
    // (`BAD_INPUT` was the example here until it joined the union: the ratchet
    // below is what keeps every code an adapter throws a member.)
    const log = await runStep(ingredientStep, throwingCtx({ code: 'NOT_A_RECIPE_ERROR_CODE' }));
    expect(log.error!.code).toBe('NETWORK_ERROR');
  });

  it('⛔ a refused input is BAD_INPUT, not a network error', async () => {
    const log = await runStep(
      ingredientStep,
      throwingCtx({ code: 'BAD_INPUT' }, 'notification-send: "slak" is not a channel'),
    );
    expect(log.error!.code).toBe('BAD_INPUT');
    expect(log.error!.message).toBe('notification-send: "slak" is not a channel');
  });

  it('⛔ a server handler\'s rpc `bad_request` is the same refusal', async () => {
    // What `handleNotificationSend` and 432 other handler sites throw.
    const log = await runStep(ingredientStep, throwingCtx({ code: 'bad_request', status: 400 }));
    expect(log.error!.code).toBe('BAD_INPUT');
  });

  it.each(Object.entries(RPC_REFUSAL_RECIPE_CODES))(
    '⛔ a server handler\'s rpc `%s` is %s, not a network error',
    async (rpcCode, recipeCode) => {
      // Thrown with no status: the table alone decides it.
      const log = await runStep(ingredientStep, throwingCtx({ code: rpcCode }));
      expect(log.error!.code).toBe(recipeCode);
      // The code is a real vocabulary member: its severity comes from `ERR`.
      expect(log.error!.severity).toBe(ERR[recipeCode]);
    },
  );

  it.each([
    [400, 'BAD_INPUT'],
    [403, 'NOT_AUTHORIZED'],
    [404, 'NOT_FOUND'],
    [409, 'CONFLICT'],
    [413, 'BAD_INPUT'],
    [422, 'BAD_INPUT'],
    [423, 'SERVER_LOCKED'],
    [429, 'API_RATE_LIMITED'],
    [500, 'SERVER_ERROR'],
    [503, 'SERVER_ERROR'],
    [507, 'STORAGE_PRESSURE'],
  ])('⛔ an rpc code the table does not name is read by its status: %i is %s', async (status, recipeCode) => {
    // `endpoint_already_revoked`, `file_blob_missing`, `archive_realm_mismatch`:
    // most of the 144 server codes carry a status that already says it.
    const log = await runStep(ingredientStep, throwingCtx({ code: 'some_handler_refusal', status }));
    expect(log.error!.code).toBe(recipeCode);
  });

  it('the table outranks the status where a specific code says it better', async () => {
    // A disabled dish is 409, but running it again cannot help: the owner turned it off.
    const log = await runStep(ingredientStep, throwingCtx({ code: 'dish_disabled', status: 409 }));
    expect(log.error!.code).toBe('NOT_AUTHORIZED');
  });

  it('⛔ an rpc code with no status and no table entry still falls back', async () => {
    const log = await runStep(ingredientStep, throwingCtx({ code: 'some_handler_refusal' }));
    expect(log.error!.code).toBe('NETWORK_ERROR');
  });

  it('⛔ a code left unnamed on purpose stays a network error, whatever its status', async () => {
    for (const code of Object.keys(RPC_CODES_LEFT_UNNAMED)) {
      // 409 would otherwise name it CONFLICT: the list, not the status, keeps it.
      const log = await runStep(ingredientStep, throwingCtx({ code, status: 409 }));
      expect(log.error!.code, code).toBe('NETWORK_ERROR');
    }
  });

  it('⛔ a system error is not read by its status: only an rpc-shaped code is', async () => {
    // `ECONNRESET`, `SQLITE_BUSY`: not a handler's refusal, whatever else it carries.
    const log = await runStep(ingredientStep, throwingCtx({ code: 'ECONNRESET', status: 404 }));
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

describe('runStep — a Records store refusal across the step seam', () => {
  /** The class the store really throws (`store.ts` `fail(...)`): a `records_*`
   *  code and no status. Every one of them used to fall through to NETWORK_ERROR. */
  const refusingCtx = (code: RecordsErrorCode, message: string): ExecutionContext => ({
    recipe: minimalRecipe,
    stores: makeStores(),
    ingredientExecutor: async () => { throw new RecordsContractError(code, message); },
  });

  it('⛔⛔ a stale expected_version is CONFLICT, not "check your connection"', async () => {
    // What invoice-book's billable-hours writes met after the 2026-09-25 release bump.
    const log = await runStep(ingredientStep, refusingCtx('records_conflict', 'stale Records version/revision'));
    expect(log.error!.code).toBe('CONFLICT');
    expect(log.error!.message).toBe('stale Records version/revision');
  });

  it.each(Object.entries(RECORDS_REFUSAL_RECIPE_CODES))(
    '⛔ the store\'s `%s` is %s',
    async (recordsCode, recipeCode) => {
      const log = await runStep(ingredientStep, refusingCtx(recordsCode as RecordsErrorCode, 'refused'));
      expect(log.error!.code).toBe(recipeCode);
      expect(log.error!.severity).toBe(ERR[recipeCode]);
    },
  );
});
