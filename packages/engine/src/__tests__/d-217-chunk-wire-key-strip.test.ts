/** D-217 slice 2b-ii — a recipe can never address staged plaintext.
 *
 *  🔑 **Why this needs its own file, and why it drives the REAL gateway.**
 *  The `__cu_*` wire keys carry a STAGING TOKEN: a capability over a decrypted
 *  warehouse file sitting on disk for the life of an upload. The engine mints
 *  it, the connection adapter redeems it, and nothing between them is supposed
 *  to be able to name it. `buildApiDispatchInput` is module-private on purpose,
 *  so the only honest way to assert the strip is through `runCatalogOperation`
 *  and out at the executor — exporting the helper for the test's convenience
 *  would prove the helper filters, not that the DISPATCH does.
 *
 *  The precedent is `__rc_*` (SMB-finance slice 3), where a recipe arg forcing
 *  binary capture was closed the same way. The stakes here are higher: `__rc_*`
 *  changes how a RESPONSE is read, `__cu_*` chooses which of the owner's files
 *  leaves the machine.
 *
 *  Spec: D-217 § 9.4.
 */

import { describe, expect, it } from 'vitest';
import {
  CHUNKED_UPLOAD_WIRE_LENGTH_KEY,
  CHUNKED_UPLOAD_WIRE_OFFSET_KEY,
  CHUNKED_UPLOAD_WIRE_PREFIX,
  CHUNKED_UPLOAD_WIRE_TOKEN_KEY,
} from '@recued/contracts';
import type {
  ApiExecutionBinding,
  ConnectionOperationProfile,
  IngredientManifest,
  OperationSpec,
  ProviderSurfaces,
} from '@recued/contracts';

import { runCatalogOperation } from '../catalog-gateway.js';
import type { ExecutionContext, IngredientExecutor } from '../types.js';

const surfacesWith = (binding: ApiExecutionBinding): ProviderSurfaces => ({
  api: {
    transport: 'rest',
    default_base_url: 'https://api.example.com',
    auth: { kind: 'none' },
    executes: { x: binding },
  },
});

const manifest = (): IngredientManifest => ({
  slug: 'pub/cat',
  name: 'Catalog',
  description: '',
  author: 'pub',
  kind: 'connection',
  category: 'action',
  risk_tier: 'read',
  input: {},
  output: {},
  operations: {
    x: { operation_id: 'pub/cat.x', risk_tier: 'read', groups: ['g'] } satisfies OperationSpec,
  },
  surfaces: surfacesWith({
    kind: 'rest',
    method: 'GET',
    path_template: '/x',
  } as ApiExecutionBinding),
});

const profile: ConnectionOperationProfile = { allowed_operations: ['x'] };

const dispatch = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const seen: Record<string, unknown>[] = [];
  const ingredientExecutor: IngredientExecutor = async (_slug, input) => {
    seen.push(input);
    return { ok: true };
  };
  const ctx = {
    recipe: { recipe_id: 'r1' },
    stores: {},
    ingredientExecutor,
    connectionProfileResolver: () => profile,
  } as unknown as ExecutionContext;

  await runCatalogOperation(
    ctx,
    manifest(),
    'pub/cat',
    { operation: 'x', args } as never,
    'primary-connection',
    undefined,
    undefined,
    undefined as never,
  );
  expect(seen).toHaveLength(1);
  return seen[0]!;
};

describe('D-217 — the `__cu_*` chunk keys are engine-owned', () => {
  it('strips a recipe arg that names the staging token', async () => {
    const input = await dispatch({ [CHUNKED_UPLOAD_WIRE_TOKEN_KEY]: 'stolen-token' });
    expect(input[CHUNKED_UPLOAD_WIRE_TOKEN_KEY]).toBeUndefined();
    // And the ordinary wire bits still got built — the strip is a filter, not
    // a fail-closed abort that would hide itself as "the op just doesn't work".
    expect(input.method).toBe('GET');
    expect(input.connection).toBe('primary-connection');
  });

  it('strips the offset and length args too', async () => {
    // Stripping only the token would leave a walk's range addressable by a
    // recipe that raced a live upload.
    const input = await dispatch({
      [CHUNKED_UPLOAD_WIRE_OFFSET_KEY]: 0,
      [CHUNKED_UPLOAD_WIRE_LENGTH_KEY]: 5_000_000,
    });
    expect(input[CHUNKED_UPLOAD_WIRE_OFFSET_KEY]).toBeUndefined();
    expect(input[CHUNKED_UPLOAD_WIRE_LENGTH_KEY]).toBeUndefined();
  });

  it('strips ANY key under the prefix, not just the three we ship', async () => {
    // The rule is the PREFIX. A future `__cu_something` added on the engine
    // side must not need this filter updated to stay unforgeable.
    const input = await dispatch({ [`${CHUNKED_UPLOAD_WIRE_PREFIX}future_key`]: 'x' });
    expect(input[`${CHUNKED_UPLOAD_WIRE_PREFIX}future_key`]).toBeUndefined();
  });

  it('strips a whitespace-padded and upper-cased variant', async () => {
    // Arg names are UNTRUSTED. The `__rc_` filter learned this the same way:
    // a padded key would otherwise reach the adapter, whose own `hasOwn` check
    // is exact.
    const input = await dispatch({
      [` ${CHUNKED_UPLOAD_WIRE_TOKEN_KEY} `]: 'padded',
      ['__CU_STAGED']: 'shouted',
    });
    expect(Object.keys(input).some((k) => k.trim().toLowerCase().startsWith(CHUNKED_UPLOAD_WIRE_PREFIX)))
      .toBe(false);
  });

  it('leaves an ordinary arg with a similar name alone', async () => {
    // The filter must not be so broad it eats legitimate args — a rule that
    // over-strips gets relaxed later by someone who cannot see why it was
    // there.
    const input = await dispatch({ '__customer_id': 'c1', 'cu_offset': 7 });
    expect(input.__customer_id).toBe('c1');
    expect(input.cu_offset).toBe(7);
  });
});
