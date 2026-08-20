/** Discover — marketplace catalog (all_meta) fetch layer tests. */

import { describe, expect, it, vi } from 'vitest';

import {
  fetchPackCatalog,
  fetchPackRecipeRefs,
  fetchRecipeCatalog,
  parsePackRow,
  parseRecipeRow,
  resolveApexOrigin,
  type CatalogFetch,
} from '../discover/catalog-client.js';

const recipeRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  recipe_id: 'detect-deal-risk',
  publisher_id: 'recued-core',
  publisher_certified: true,
  name: 'Detect Deal Risk',
  description: 'Flags at-risk deals.',
  type: 'action',
  version: 3,
  platforms: ['hubspot'],
  tags: ['sales', 'crm'],
  download_count: 42,
  rating_avg: 4.5,
  rating_count: 8,
  created_at: '2026-01-02T00:00:00Z',
  depends_on: ['recued-core.hubspot'],
  recipe_bundle: 'recued-core/deal-risk-loop',
  ...over,
});

const packRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  slug: 'sales-pack',
  publisher_id: 'recued-core',
  publisher_certified: true,
  name: 'Sales Pack',
  description: 'Sales augmentation.',
  version: 2,
  pack_kind: 'foundation',
  service_kind: 'entity_platform',
  tags: ['sales'],
  download_count: 10,
  item_count: 4,
  recipe_refs: [
    { slug: 'detect-deal-risk', version: 3 },
    { slug: 'review-deal-risk', version: 1 },
  ],
  created_at: '2026-01-01T00:00:00Z',
  ...over,
});

const jsonResponse = (body: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

describe('resolveApexOrigin', () => {
  it('honours an explicit override (trailing slash trimmed)', () => {
    expect(resolveApexOrigin({ override: 'https://mirror.example.com/' })).toBe(
      'https://mirror.example.com',
    );
  });
  it('⛔ the HOST no longer selects the apex — the build does', () => {
    // Was "maps a staging host to the <mirror> apex". A mirror build sets
    // `--cloud-apex`; source names only the product domain (see cloud-apex.ts).
    // Any host resolves to the built-in apex, which pins the removal: if
    // host-sniffing returns, this fails.
    expect(resolveApexOrigin({ hostname: 'app.mirror.example' })).toBe('https://recued.com');
  });
  it('maps a prod host to the recued apex', () => {
    expect(resolveApexOrigin({ hostname: 'app.recued.com' })).toBe('https://recued.com');
  });
  it('defaults a LAN / localhost webclient to the public prod apex', () => {
    expect(resolveApexOrigin({ hostname: '192.168.1.20' })).toBe('https://recued.com');
    expect(resolveApexOrigin({ hostname: 'localhost' })).toBe('https://recued.com');
  });
});

describe('parseRecipeRow / parsePackRow', () => {
  it('parses a well-formed recipe row (incl. depends_on)', () => {
    expect(parseRecipeRow(recipeRow())).toMatchObject({
      recipe_id: 'detect-deal-risk',
      version: 3,
      platforms: ['hubspot'],
      publisher_certified: true,
      depends_on: ['recued-core.hubspot'],
      recipe_bundle: 'recued-core/deal-risk-loop',
    });
    // absent/garbage depends_on → [] (deps box treats it as kernel-only).
    expect(parseRecipeRow(recipeRow({ depends_on: undefined }))?.depends_on).toEqual([]);
    expect(parseRecipeRow(recipeRow({ depends_on: [1, 'ok', null] }))?.depends_on).toEqual(['ok']);
  });
  it('drops a recipe row missing its identity', () => {
    expect(parseRecipeRow(recipeRow({ recipe_id: undefined }))).toBeNull();
    expect(parseRecipeRow(recipeRow({ name: 123 }))).toBeNull();
    expect(parseRecipeRow('nope')).toBeNull();
  });
  it('coerces wrong-typed numeric/array fields to safe defaults', () => {
    const row = parseRecipeRow(recipeRow({ version: 'x', tags: [1, 'ok', null], download_count: null }));
    expect(row).not.toBeNull();
    expect(row?.version).toBe(0);
    expect(row?.tags).toEqual(['ok']);
    expect(row?.download_count).toBe(0);
  });
  it('omits publisher_certified when not a boolean', () => {
    const row = parseRecipeRow(recipeRow({ publisher_certified: undefined }));
    expect(row).not.toHaveProperty('publisher_certified');
  });
  it('parses a well-formed pack row + keeps service_kind', () => {
    expect(parsePackRow(packRow())).toMatchObject({
      slug: 'sales-pack',
      version: 2,
      service_kind: 'entity_platform',
      item_count: 4,
      recipe_refs: [
        { slug: 'detect-deal-risk', version: 3 },
        { slug: 'review-deal-risk', version: 1 },
      ],
    });
  });
  it('drops a pack row missing its slug + omits absent service_kind', () => {
    expect(parsePackRow(packRow({ slug: undefined }))).toBeNull();
    const row = parsePackRow(packRow({ service_kind: undefined }));
    expect(row).not.toHaveProperty('service_kind');
  });
  it('fails pack recipe refs closed instead of accepting a partial projection', () => {
    expect(parsePackRow(packRow({
      recipe_refs: [
        { slug: 'detect-deal-risk', version: 3 },
        { slug: 'broken' },
      ],
    }))?.recipe_refs).toEqual([]);
    expect(parsePackRow(packRow({
      recipe_refs: [
        { slug: 'same', version: 1 },
        { slug: 'same', version: 1 },
      ],
    }))?.recipe_refs).toEqual([]);
  });
});

describe('fetchRecipeCatalog / fetchPackCatalog', () => {
  it('fetches the recipes corpus from the resolved apex with a CORS-simple GET (Accept only)', async () => {
    const fetchFn = vi.fn<CatalogFetch>(async () =>
      jsonResponse([recipeRow(), recipeRow({ recipe_id: 'other' })]),
    );
    const res = await fetchRecipeCatalog({ origin: 'https://recued.com', fetchFn });
    // Only a safelisted `Accept` header → no preflight; freshness rides the HTTP
    // cache, so no If-None-Match/If-Modified-Since is sent.
    const init = fetchFn.mock.calls[0][1] as RequestInit;
    expect(fetchFn).toHaveBeenCalledWith(
      'https://recued.com/catalog/recipes.json',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
    expect(init.headers).not.toHaveProperty('If-None-Match');
    expect(init.headers).not.toHaveProperty('If-Modified-Since');
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') throw new Error('expected ok');
    expect(res.rows).toHaveLength(2);
  });

  it('drops malformed rows in an otherwise-good corpus', async () => {
    const fetchFn = vi.fn<CatalogFetch>(async () =>
      jsonResponse([packRow(), { slug: null }, packRow({ slug: 'p2' }), 'garbage']),
    );
    const res = await fetchPackCatalog({ origin: 'https://recued.com', fetchFn });
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') throw new Error('expected ok');
    expect(res.rows.map((r) => r.slug)).toEqual(['sales-pack', 'p2']);
  });

  it('returns an error result (with httpStatus) on a non-ok response — never throws', async () => {
    const fetchFn = vi.fn<CatalogFetch>(async () => new Response('nope', { status: 503 }));
    const res = await fetchPackCatalog({ origin: 'https://recued.com', fetchFn });
    expect(res.status).toBe('error');
    if (res.status !== 'error') throw new Error('expected error');
    expect(res.httpStatus).toBe(503);
  });

  it('folds a network/CORS throw into an error result', async () => {
    const fetchFn = vi.fn<CatalogFetch>(async () => {
      throw new TypeError('Failed to fetch');
    });
    const res = await fetchRecipeCatalog({ origin: 'https://recued.com', fetchFn });
    expect(res.status).toBe('error');
    if (res.status !== 'error') throw new Error('expected error');
    expect(res.message).toContain("Couldn't reach the marketplace");
  });

  it('folds a malformed JSON body into an error result', async () => {
    const fetchFn = vi.fn<CatalogFetch>(async () =>
      new Response('{not json', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const res = await fetchPackCatalog({ origin: 'https://recued.com', fetchFn });
    expect(res.status).toBe('error');
  });
});


describe('fetchPackRecipeRefs (membership from the per-pack install artifact)', () => {
  /** `recipe_refs` left the meta catalog: it is pack MEMBERSHIP, which belongs
   *  to `/packs/<slug>.json`, and carrying it in the meta was the only reason
   *  the catalog's server-side read had to touch all 927 manifests. */
  const fetchOf = (body: unknown, ok = true): CatalogFetch =>
    (async () => new Response(JSON.stringify(body), { status: ok ? 200 : 503 })) as CatalogFetch;

  const manifest = (over: Record<string, unknown> = {}) => ({
    slug: 'task-closure', publisher: 'recued-core',
    recipes: [{ slug: 'watch-task', version: 2 }, { slug: 'create-task', version: 1 }],
    ...over,
  });

  it('reads membership from the artifact', async () => {
    expect(await fetchPackRecipeRefs('task-closure', { fetchFn: fetchOf(manifest()) }))
      .toEqual([{ slug: 'create-task', version: 1 }, { slug: 'watch-task', version: 2 }]);
  });

  it('requests the slug it was asked for', async () => {
    let seen = '';
    const fetchFn = (async (url: string) => {
      seen = String(url);
      return new Response(JSON.stringify(manifest()), { status: 200 });
    }) as unknown as CatalogFetch;
    await fetchPackRecipeRefs('task-closure', { fetchFn, origin: 'https://recued.com' });
    expect(seen).toBe('https://recued.com/packs/task-closure.json');
  });

  it('REFUSES a manifest that names a different pack', async () => {
    // The projection applied this identity guard before extracting; a manifest
    // that does not name the pack it was served for cannot speak for its
    // membership, whatever the URL said.
    expect(await fetchPackRecipeRefs('task-closure', { fetchFn: fetchOf(manifest({ slug: 'other-pack' })) }))
      .toEqual([]);
  });

  it('fails CLOSED on a manifest the validator rejects', async () => {
    // Same fail-closed validator the worker ran — conflicting versions for one
    // slug reject the WHOLE projection rather than picking one.
    const conflicting = manifest({
      recipes: [{ slug: 'watch-task', version: 2 }, { slug: 'watch-task', version: 3 }],
    });
    expect(await fetchPackRecipeRefs('task-closure', { fetchFn: fetchOf(conflicting) })).toEqual([]);
  });

  it('returns [] rather than throwing on a bad response or a dead network', async () => {
    expect(await fetchPackRecipeRefs('task-closure', { fetchFn: fetchOf(manifest(), false) })).toEqual([]);
    const boom = (async () => { throw new Error('offline'); }) as unknown as CatalogFetch;
    expect(await fetchPackRecipeRefs('task-closure', { fetchFn: boom })).toEqual([]);
  });
});
