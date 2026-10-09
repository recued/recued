/** D-313 — how a server handler's refusal is named: the table, then the status. */

import { describe, expect, it } from 'vitest';
import {
  ERR, recipeCodeForRpcRefusal, recipeCodeForRpcStatus, RECORDS_REFUSAL_RECIPE_CODES, RPC_REFUSAL_RECIPE_CODES,
} from '../index.js';

describe('recipeCodeForRpcRefusal', () => {
  it('every table entry is a recipe code', () => {
    expect(Object.values(RPC_REFUSAL_RECIPE_CODES).filter((code) => !Object.hasOwn(ERR, code))).toEqual([]);
    expect(Object.values(RECORDS_REFUSAL_RECIPE_CODES).filter((code) => !Object.hasOwn(ERR, code))).toEqual([]);
  });

  it('⛔ names every Records store refusal, which used to fall through to NETWORK_ERROR', () => {
    expect(recipeCodeForRpcRefusal('records_conflict', undefined)).toBe('CONFLICT');
    expect(recipeCodeForRpcRefusal('records_not_found', undefined)).toBe('NOT_FOUND');
    expect(recipeCodeForRpcRefusal('records_invalid', undefined)).toBe('BAD_INPUT');
    expect(recipeCodeForRpcRefusal('records_unauthorized', undefined)).toBe('NOT_AUTHORIZED');
    // Thirteen codes, one per member of the closed `RecordsErrorCode` union.
    expect(Object.keys(RECORDS_REFUSAL_RECIPE_CODES)).toHaveLength(13);
  });

  it('reads the table before the status', () => {
    expect(recipeCodeForRpcRefusal('dish_disabled', 409)).toBe('NOT_AUTHORIZED');
    expect(recipeCodeForRpcRefusal('locked', undefined)).toBe('SERVER_LOCKED');
    expect(recipeCodeForRpcRefusal('endpoint_already_revoked', 409)).toBe('CONFLICT');
  });

  it('⛔ reads only an rpc-shaped code: a system error is not a refusal', () => {
    expect(recipeCodeForRpcRefusal('ECONNRESET', 404)).toBeUndefined();
    expect(recipeCodeForRpcRefusal('toString', 400)).toBeUndefined();
    expect(recipeCodeForRpcRefusal('toString', undefined)).toBeUndefined();
  });

  it('names nothing without a table entry or a status', () => {
    expect(recipeCodeForRpcRefusal('some_refusal', undefined)).toBeUndefined();
    expect(recipeCodeForRpcRefusal('some_refusal', '404')).toBeUndefined();
    expect(recipeCodeForRpcRefusal('cancelled', 499)).toBeUndefined();
  });
});

describe('recipeCodeForRpcStatus', () => {
  it('names each class of status, and leaves what is no refusal', () => {
    expect(recipeCodeForRpcStatus(418)).toBe('BAD_INPUT');
    expect(recipeCodeForRpcStatus(599)).toBe('SERVER_ERROR');
    expect(recipeCodeForRpcStatus(423)).toBe('SERVER_LOCKED');
    expect(recipeCodeForRpcStatus(499)).toBeUndefined();
    expect(recipeCodeForRpcStatus(302)).toBeUndefined();
    expect(recipeCodeForRpcStatus(Number.NaN)).toBeUndefined();
  });
});
