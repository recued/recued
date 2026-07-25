/** D-119 Phase 2 — `fetchBundleByUrl` + `assertPlainRecipeSubmission`.
 *
 *  Covers:
 *    - successful fetch returning a wrapped bundle
 *    - successful fetch falling through bare-recipe → auto-wrapped
 *    - finalUrl reflects redirect-followed URL (`response.url`)
 *    - HTTP error → BundleFetchError 'http'
 *    - non-JSON response → BundleFetchError 'parse'
 *    - validation failure → BundleFetchError 'validation'
 *    - publish gate accepts plain recipe submissions
 *    - publish gate rejects every bundle reserved field
 */

import { describe, it, expect } from 'vitest';

import type { RecipeDefinition } from '@recued/contracts';
import {
  BundleFetchError,
  assertPlainRecipeSubmission,
  fetchBundleByUrl,
} from '../bundle-fetch.js';

const validRecipe: RecipeDefinition = {
  recipe_id: 'detect-deal-risk-hubspot',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'Detect Deal Risk',
    description: 'Flag deals at risk of slipping.',
    author: 'recued-core',
    supported_platforms: ['hubspot'],
    tags: ['hubspot', 'sales', 'crm'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [
    { id: 'noop', transform: 'to_list', input: 'x' } as unknown as RecipeDefinition['steps'][number],
  ],
  output: { sidebar: [] },
};

const mockFetch = (
  body: unknown,
  opts: { ok?: boolean; status?: number; statusText?: string; finalUrl?: string; nonJson?: boolean } = {},
): typeof globalThis.fetch => async (input: unknown): Promise<Response> => {
  const ok = opts.ok ?? true;
  const status = opts.status ?? 200;
  const statusText = opts.statusText ?? 'OK';
  const url = opts.finalUrl ?? (typeof input === 'string' ? input : '');
  const json = opts.nonJson
    ? () => Promise.reject(new Error('not json'))
    : () => Promise.resolve(body);
  return { ok, status, statusText, url, json } as unknown as Response;
};

describe('fetchBundleByUrl — happy paths', () => {
  it('returns a wrapped bundle and the final URL', async () => {
    const fetchFn = mockFetch({
      bundle_version: 1,
      recipe: validRecipe,
      ingredients: [],
    }, { finalUrl: 'https://recipes.example.com/r' });
    const result = await fetchBundleByUrl('https://short.ly/r', fetchFn);
    expect(result.bundle.recipe.recipe_id).toBe('detect-deal-risk-hubspot');
    expect(result.finalUrl).toBe('https://recipes.example.com/r');
  });

  it('auto-wraps a bare recipe payload', async () => {
    const fetchFn = mockFetch(validRecipe);
    const result = await fetchBundleByUrl('https://x.io/r', fetchFn);
    expect(result.bundle.recipe).toEqual(validRecipe);
    expect(result.bundle.ingredients).toBeUndefined();
  });

  it('falls back to the request URL when response.url is empty', async () => {
    const fetchFn = mockFetch(validRecipe, { finalUrl: '' });
    const result = await fetchBundleByUrl('https://x.io/r', fetchFn);
    expect(result.finalUrl).toBe('https://x.io/r');
  });
});

describe('fetchBundleByUrl — error paths', () => {
  it('throws BundleFetchError(http) for a non-2xx response', async () => {
    const fetchFn = mockFetch(null, { ok: false, status: 404, statusText: 'Not Found' });
    await expect(fetchBundleByUrl('https://x.io/r', fetchFn))
      .rejects.toMatchObject({
        name: 'BundleFetchError',
        kind: 'http',
        details: { status: 404 },
      } as Partial<BundleFetchError>);
  });

  it('throws BundleFetchError(parse) for a non-JSON response', async () => {
    const fetchFn = mockFetch('<html>not json</html>', { nonJson: true });
    await expect(fetchBundleByUrl('https://x.io/r', fetchFn))
      .rejects.toMatchObject({ name: 'BundleFetchError', kind: 'parse' } as Partial<BundleFetchError>);
  });

  it('throws BundleFetchError(validation) when JSON loads but parseBundle fails', async () => {
    const fetchFn = mockFetch({ recipe: { recipe_id: '' } });
    await expect(fetchBundleByUrl('https://x.io/r', fetchFn))
      .rejects.toMatchObject({ name: 'BundleFetchError', kind: 'validation' } as Partial<BundleFetchError>);
  });

  it('throws BundleFetchError(network) when fetch itself rejects', async () => {
    const fetchFn = (async () => { throw new Error('boom'); }) as unknown as typeof globalThis.fetch;
    await expect(fetchBundleByUrl('https://x.io/r', fetchFn))
      .rejects.toMatchObject({ name: 'BundleFetchError', kind: 'network' } as Partial<BundleFetchError>);
  });
});

describe('assertPlainRecipeSubmission — publish gate', () => {
  it('accepts a plain recipe submission', () => {
    expect(assertPlainRecipeSubmission({ recipe: validRecipe })).toEqual({ ok: true });
  });

  it('accepts an empty object (no recipe field — separate validator catches that)', () => {
    expect(assertPlainRecipeSubmission({})).toEqual({ ok: true });
  });

  it('accepts null / non-object input (other validators handle those)', () => {
    expect(assertPlainRecipeSubmission(null)).toEqual({ ok: true });
    expect(assertPlainRecipeSubmission([])).toEqual({ ok: true });
    expect(assertPlainRecipeSubmission(42)).toEqual({ ok: true });
  });

  it('rejects submissions carrying `ingredients`', () => {
    const result = assertPlainRecipeSubmission({ recipe: validRecipe, ingredients: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('BUNDLE_NOT_PUBLISHABLE');
      expect(result.field).toBe('ingredients');
    }
  });

  it('rejects submissions carrying `signature`', () => {
    const result = assertPlainRecipeSubmission({
      recipe: validRecipe,
      signature: { algorithm: 'ed25519', publisher_pubkey: 'X', signature: 'Y' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe('signature');
  });

  it('rejects submissions carrying `bundle_version`', () => {
    const result = assertPlainRecipeSubmission({ recipe: validRecipe, bundle_version: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe('bundle_version');
  });

  it('ignores inherited bundle-only fields', () => {
    const body = Object.create({ bundle_version: 1, ingredients: [], signature: {} });
    body.recipe = validRecipe;
    expect(assertPlainRecipeSubmission(body)).toEqual({ ok: true });
  });
});
