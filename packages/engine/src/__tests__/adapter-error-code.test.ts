/** One rule names a thrown step error, sequential and prefetch alike
 *  (`adapterErrorCode`, in `step-runner.ts`). Before it, a prefetch op's failure was
 *  `NETWORK_ERROR` whatever was thrown, so a Records refusal read "check your
 *  connection" even where the sequential path named it. */

import { describe, expect, it } from 'vitest';

import { ERR, RecordsContractError, SLOT_CANCELLED_ERROR_CODE } from '@recued/contracts';
import type { RecipeDefinition } from '@recued/contracts';

import { runPrefetch } from '../prefetch.js';
import { adapterErrorCode } from '../step-runner.js';
import type { ExecutionContext, IngredientExecutor } from '../types.js';

describe('adapterErrorCode', () => {
  it('keeps a recipe code, maps an rpc or Records code, and names nothing else', () => {
    expect(adapterErrorCode({ code: 'ACTION_DELIVERY_UNCERTAIN' })).toBe('ACTION_DELIVERY_UNCERTAIN');
    expect(adapterErrorCode(new RecordsContractError('records_not_found', 'gone'))).toBe('NOT_FOUND');
    expect(adapterErrorCode({ code: 'bad_request', status: 400 })).toBe('BAD_INPUT');
    expect(adapterErrorCode({ code: 'some_handler_refusal' })).toBeUndefined();
    expect(adapterErrorCode({ code: 'ECONNRESET', status: 404 })).toBeUndefined();
    expect(adapterErrorCode(new Error('plain'))).toBeUndefined();
    expect(adapterErrorCode('records_not_found')).toBeUndefined();
  });

  it('⛔ never passes a bare AI_MODEL_REFUSED through: the step runner needs its diagnostic', () => {
    expect(adapterErrorCode({ code: 'AI_MODEL_REFUSED' })).toBeUndefined();
  });
});

describe('runPrefetch — a failed prefetch op is named as a sequential one is', () => {
  const throwing = (thrown: unknown): ExecutionContext => {
    const ingredientExecutor: IngredientExecutor = async () => { throw thrown; };
    return {
      recipe: {
        recipe_id: 'r1', prefetch_steps: [{ id: 'job', ingredient: 'records-job', input: {} }], steps: [],
      } as unknown as RecipeDefinition,
      stores: { config: {}, step: {} } as unknown as ExecutionContext['stores'],
      ingredientExecutor,
    } as unknown as ExecutionContext;
  };

  it('⛔⛔ a Records refusal is its recipe code, not NETWORK_ERROR', async () => {
    const [log] = await runPrefetch(throwing(new RecordsContractError('records_not_found', "record 'job_1' was not found")));
    expect(log!.error!.code).toBe('NOT_FOUND');
    expect(log!.error!.severity).toBe(ERR.NOT_FOUND);
    expect(log!.error!.message).toMatch(/was not found/);
  });

  it('an error that names nothing still falls back, and a cancelled slot keeps its marker', async () => {
    const [plain] = await runPrefetch(throwing(new Error('socket hang up')));
    expect(plain!.error!.code).toBe('NETWORK_ERROR');
    const [cancelled] = await runPrefetch(throwing(
      Object.assign(new Error('cancelled'), { code: SLOT_CANCELLED_ERROR_CODE }),
    ));
    expect(cancelled!.error!.code).toBe('NETWORK_ERROR');
    expect(cancelled!.error!.details).toEqual({ slot_cancelled: true });
  });
});
