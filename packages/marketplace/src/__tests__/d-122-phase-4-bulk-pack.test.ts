/** D-122 Phase 4 — marketplace-side resolver + cost estimator. */

import { describe, expect, it } from 'vitest';
import {
  BULK_INSTALL_PACK_VERSION,
  BULK_PACK_INSTALL_PERMISSION,
  type BulkPackManifest,
  type RecipeDefinition,
} from '@recued/contracts';
import {
  BulkPackFetchError,
  estimatePackCost,
  fetchBulkPackBySlug,
  fetchBulkPackByUrl,
  resolveBulkPack,
  type ResolvedPackRecipe,
} from '../index.js';
import type { MarketplaceRecipeResult } from '../client.js';

const baseManifest: BulkPackManifest = {
  manifest_version: BULK_INSTALL_PACK_VERSION,
  slug: 'personal-crm-foundation',
  publisher: 'recued-core',
  name: 'Personal CRM Foundation',
  description: 'Ten foundational extraction recipes.',
  version: 1,
  recipes: [
    { slug: 'extract-contact-from-mail', version: 1 },
    { slug: 'classify-mail-thread', version: 1 },
  ],
  requires: [BULK_PACK_INSTALL_PERMISSION],
  tags: ['pack:personal-crm', 'alerts'],
};

const stubFetch = (
  status: number,
  body: unknown,
): typeof globalThis.fetch =>
  ((async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof globalThis.fetch);

const networkErrorFetch = (): typeof globalThis.fetch =>
  ((async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof globalThis.fetch);

// Synthetic reactive recipe — no runs_on (post-rip).
const reactiveRecipe = (recipe_id: string): RecipeDefinition =>
  ({
    recipe_id,
    metadata: { name: recipe_id, description: '', author: 'recued-core' },
    auto_run: true,
    steps: [],
  } as unknown as RecipeDefinition);

const resolvedFor = (recipe: RecipeDefinition, version = 1): ResolvedPackRecipe => ({
  slug: recipe.recipe_id,
  pinned_version: version,
  recipe: {
    recipe_id: recipe.recipe_id,
    publisher_id: 'recued-core',
    version,
    recipe_hash: 'hash',
    recipe,
  } satisfies MarketplaceRecipeResult,
});

// ────────────────────────────────────────────────────────────────
// fetchBulkPackBySlug
// ────────────────────────────────────────────────────────────────

describe('D-122 Phase 4 — fetchBulkPackBySlug', () => {
  it('returns a parsed manifest from a BARE apex body (no envelope)', async () => {
    // The apex `/packs/<slug>.json` serves the manifest un-enveloped.
    const fetchFn = stubFetch(200, baseManifest);
    const got = await fetchBulkPackBySlug('personal-crm-foundation', fetchFn);
    expect(got).not.toBeNull();
    expect(got?.slug).toBe('personal-crm-foundation');
    expect(got?.recipes).toHaveLength(2);
  });

  it('still accepts a legacy { data, meta } envelope (belt-and-suspenders)', async () => {
    const fetchFn = stubFetch(200, {
      data: baseManifest,
      meta: { request_id: 'r', timestamp: 't' },
    });
    const got = await fetchBulkPackBySlug('personal-crm-foundation', fetchFn);
    expect(got).not.toBeNull();
    expect(got?.slug).toBe('personal-crm-foundation');
    expect(got?.recipes).toHaveLength(2);
  });

  it('returns a parsed manifest when fetched manifest_version is 2', async () => {
    const fetchFn = stubFetch(200, {
      data: {
        ...baseManifest,
        manifest_version: 2,
        artifact_type: 'pack',
        pack_kind: 'app_pack',
        recipes: [],
        contents: [
          { type: 'recipe', slug: 'extract-contact-from-mail', version: 1 },
          { type: 'ingredient', ingredient_id: 'recued-core/github', ingredient_version: 1 },
        ],
      },
      meta: { request_id: 'r', timestamp: 't' },
    });
    const got = await fetchBulkPackBySlug('personal-crm-foundation', fetchFn);
    expect(got).not.toBeNull();
    expect(got?.manifest_version).toBe(2);
    expect(got?.recipes).toEqual([{ slug: 'extract-contact-from-mail', version: 1 }]);
    expect(got?.contents?.some((c) => c.type === 'ingredient')).toBe(true);
  });

  it('returns null on 404', async () => {
    const fetchFn = stubFetch(404, { error: 'not found' });
    const got = await fetchBulkPackBySlug('does-not-exist', fetchFn);
    expect(got).toBeNull();
  });

  it('throws http BulkPackFetchError on non-404 errors', async () => {
    const fetchFn = stubFetch(500, { error: 'boom' });
    await expect(fetchBulkPackBySlug('any', fetchFn)).rejects.toMatchObject({
      kind: 'http',
    });
  });

  it('throws network BulkPackFetchError when fetch rejects', async () => {
    const fetchFn = networkErrorFetch();
    await expect(fetchBulkPackBySlug('any', fetchFn)).rejects.toMatchObject({
      kind: 'network',
    });
  });

  // D-165 — v1 + v2 are both supported now; only a version strictly newer
  // than the current max (v2) is the upgrade-prompt case. `+ 2` = v3.
  it('throws version BulkPackFetchError when manifest_version is newer than the max supported', async () => {
    const fetchFn = stubFetch(200, {
      data: { ...baseManifest, manifest_version: BULK_INSTALL_PACK_VERSION + 2 },
      meta: { request_id: 'r', timestamp: 't' },
    });
    await expect(fetchBulkPackBySlug('any', fetchFn)).rejects.toMatchObject({
      kind: 'version',
    });
  });

  it('throws validation BulkPackFetchError when payload fails parse', async () => {
    const fetchFn = stubFetch(200, {
      data: { manifest_version: BULK_INSTALL_PACK_VERSION, slug: 'bad', recipes: [] },
      meta: { request_id: 'r', timestamp: 't' },
    });
    await expect(fetchBulkPackBySlug('any', fetchFn)).rejects.toBeInstanceOf(
      BulkPackFetchError,
    );
    await expect(fetchBulkPackBySlug('any', fetchFn)).rejects.toMatchObject({
      kind: 'validation',
    });
  });
});

// ────────────────────────────────────────────────────────────────
// fetchBulkPackByUrl (Packs R22 Delta 4 — Add-a-pack from a direct URL)
// ────────────────────────────────────────────────────────────────

describe('Packs R22 Delta 4 — fetchBulkPackByUrl', () => {
  const url = 'https://example.com/my-pack.json';

  it('parses a manifest from a BARE body (no marketplace envelope)', async () => {
    const fetchFn = stubFetch(200, baseManifest);
    const got = await fetchBulkPackByUrl(url, fetchFn);
    expect(got.slug).toBe('personal-crm-foundation');
    expect(got.recipes).toHaveLength(2);
  });

  it('parses a manifest from an ENVELOPED body (marketplace-style)', async () => {
    const fetchFn = stubFetch(200, {
      data: baseManifest,
      meta: { request_id: 'r', timestamp: 't' },
    });
    const got = await fetchBulkPackByUrl(url, fetchFn);
    expect(got.slug).toBe('personal-crm-foundation');
  });

  it('parses a BARE manifest that carries a stray top-level data field (no envelope mis-unwrap)', async () => {
    // Codex fold: the bare manifest has its own `data` field. A
    // `body?.data ?? body` coalesce would extract that stray field and fail to
    // parse; the shape gate (top-level `manifest_version`) reads the manifest.
    const fetchFn = stubFetch(200, { ...baseManifest, data: { junk: true } });
    const got = await fetchBulkPackByUrl(url, fetchFn);
    expect(got.slug).toBe('personal-crm-foundation');
    expect(got.recipes).toHaveLength(2);
  });

  it('parses a v2 manifest', async () => {
    const fetchFn = stubFetch(200, {
      ...baseManifest,
      manifest_version: 2,
      artifact_type: 'pack',
      pack_kind: 'app_pack',
      recipes: [],
      contents: [
        { type: 'recipe', slug: 'extract-contact-from-mail', version: 1 },
      ],
    });
    const got = await fetchBulkPackByUrl(url, fetchFn);
    expect(got.manifest_version).toBe(2);
  });

  it('throws http BulkPackFetchError on 404 (NOT null — a wrong URL is a hard error)', async () => {
    const fetchFn = stubFetch(404, { error: 'not found' });
    await expect(fetchBulkPackByUrl(url, fetchFn)).rejects.toMatchObject({
      kind: 'http',
      details: { status: 404 },
    });
  });

  it('throws http BulkPackFetchError on a 500', async () => {
    const fetchFn = stubFetch(500, { error: 'boom' });
    await expect(fetchBulkPackByUrl(url, fetchFn)).rejects.toMatchObject({
      kind: 'http',
    });
  });

  it('throws network BulkPackFetchError when fetch rejects', async () => {
    const fetchFn = networkErrorFetch();
    await expect(fetchBulkPackByUrl(url, fetchFn)).rejects.toMatchObject({
      kind: 'network',
    });
  });

  it('throws version BulkPackFetchError when manifest_version is newer than the max', async () => {
    const fetchFn = stubFetch(200, {
      ...baseManifest,
      manifest_version: BULK_INSTALL_PACK_VERSION + 2,
    });
    await expect(fetchBulkPackByUrl(url, fetchFn)).rejects.toMatchObject({
      kind: 'version',
    });
  });

  it('throws validation BulkPackFetchError when payload fails parse', async () => {
    const fetchFn = stubFetch(200, {
      manifest_version: BULK_INSTALL_PACK_VERSION,
      slug: 'bad',
      recipes: [],
    });
    await expect(fetchBulkPackByUrl(url, fetchFn)).rejects.toMatchObject({
      kind: 'validation',
    });
  });
});

// ────────────────────────────────────────────────────────────────
// resolveBulkPack
// ────────────────────────────────────────────────────────────────

describe('D-122 Phase 4 — resolveBulkPack', () => {
  const recipeARow: MarketplaceRecipeResult = {
    recipe_id: 'extract-contact-from-mail',
    publisher_id: 'recued-core',
    version: 1,
    recipe_hash: 'a',
    recipe: reactiveRecipe('extract-contact-from-mail'),
  };
  const recipeBRow: MarketplaceRecipeResult = {
    recipe_id: 'classify-mail-thread',
    publisher_id: 'recued-core',
    version: 1,
    recipe_hash: 'b',
    recipe: reactiveRecipe('classify-mail-thread'),
  };

  // Apex install fetch — `/recipes/<slug>.json`. Wraps each recipe in the legacy
  // `{ data, meta }` envelope (still accepted by shape-detection); the `.json`
  // suffix on the apex path is stripped back to the bare slug for lookup.
  const recipeFetch = (rows: Record<string, MarketplaceRecipeResult | null>): typeof globalThis.fetch =>
    ((async (url: string) => {
      const slug = decodeURIComponent(url.split('/').pop() ?? '').replace(/\.json$/, '');
      const row = rows[slug];
      if (row == null) {
        return {
          ok: false,
          status: 404,
          statusText: 'Not Found',
          json: async () => ({ error: 'not found' }),
          text: async () => '',
        };
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ data: row, meta: { request_id: 'r', timestamp: 't' } }),
        text: async () => JSON.stringify({ data: row }),
      };
    }) as unknown as typeof globalThis.fetch);

  it('returns ready=true when every recipe resolves at the pinned version', async () => {
    const result = await resolveBulkPack(baseManifest, recipeFetch({
      'extract-contact-from-mail': recipeARow,
      'classify-mail-thread': recipeBRow,
    }));
    expect(result.ready).toBe(true);
    expect(result.recipes).toHaveLength(2);
    expect(result.recipes.every((r) => r.recipe != null)).toBe(true);
  });

  it('marks not_found when the slug is missing from the marketplace', async () => {
    const result = await resolveBulkPack(baseManifest, recipeFetch({
      'extract-contact-from-mail': recipeARow,
      'classify-mail-thread': null,
    }));
    expect(result.ready).toBe(false);
    const missing = result.recipes.find((r) => r.slug === 'classify-mail-thread');
    expect(missing?.failure).toBe('not_found');
  });

  it('marks version_drift when the marketplace returns a different version', async () => {
    const drift = { ...recipeBRow, version: 2 };
    const result = await resolveBulkPack(baseManifest, recipeFetch({
      'extract-contact-from-mail': recipeARow,
      'classify-mail-thread': drift,
    }));
    expect(result.ready).toBe(false);
    const drifted = result.recipes.find((r) => r.slug === 'classify-mail-thread');
    expect(drifted?.failure).toBe('version_drift');
    // Version-drift surfaces the recipe row so the dialog can show the
    // alternate version to the user.
    expect(drifted?.recipe?.version).toBe(2);
  });

  it('marks fetch_error and surfaces the message when fetch throws', async () => {
    const errorFetch = ((async (url: string) => {
      if (url.includes('classify-mail-thread')) throw new Error('boom');
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ data: recipeARow, meta: { request_id: 'r', timestamp: 't' } }),
        text: async () => '',
      };
    }) as unknown as typeof globalThis.fetch);
    const result = await resolveBulkPack(baseManifest, errorFetch);
    expect(result.ready).toBe(false);
    const errored = result.recipes.find((r) => r.slug === 'classify-mail-thread');
    expect(errored?.failure).toBe('fetch_error');
    expect(errored?.error_message).toContain('boom');
  });
});

// ────────────────────────────────────────────────────────────────
// Cost estimator (post-runs_on rip — flat per-recipe shape)
// ────────────────────────────────────────────────────────────────

describe('D-122 Phase 4 — estimatePackCost', () => {
  const alertRecipe = reactiveRecipe('time-alert-before-event');
  const producerRecipe = reactiveRecipe('refresh-calendar-event-rollup');

  it('sums per-recipe daily fires + tokens', () => {
    const result = estimatePackCost({
      resolved: [resolvedFor(alertRecipe), resolvedFor(producerRecipe)],
      per_recipe: {
        'time-alert-before-event': { slug: 'time-alert-before-event', daily_fires: 9, per_fire_tokens: 800 },
        'refresh-calendar-event-rollup': { slug: 'refresh-calendar-event-rollup', daily_fires: 3, per_fire_tokens: 1200 },
      },
      free_pool_tokens_per_day: 1_000_000,
    });
    expect(result.total_daily_fires).toBe(12);
    expect(result.total_daily_tokens).toBe(9 * 800 + 3 * 1200);
    expect(result.per_recipe).toHaveLength(2);
    expect(result.per_recipe[0]?.daily_tokens).toBe(7200);
  });

  it('skips recipes with resolution failures', () => {
    const failed: ResolvedPackRecipe = {
      slug: 'never-resolved',
      pinned_version: 1,
      recipe: null,
      failure: 'not_found',
    };
    const result = estimatePackCost({
      resolved: [resolvedFor(alertRecipe), failed],
      per_recipe: {
        'time-alert-before-event': { slug: 'time-alert-before-event', daily_fires: 9, per_fire_tokens: 800 },
      },
      free_pool_tokens_per_day: 1_000_000,
    });
    expect(result.total_daily_fires).toBe(9);
    expect(result.per_recipe).toHaveLength(1);
  });

  it('skips recipes whose slug is missing from per_recipe hints', () => {
    const result = estimatePackCost({
      resolved: [resolvedFor(alertRecipe), resolvedFor(producerRecipe)],
      per_recipe: {
        'time-alert-before-event': { slug: 'time-alert-before-event', daily_fires: 9, per_fire_tokens: 800 },
      },
      free_pool_tokens_per_day: 1_000_000,
    });
    expect(result.per_recipe).toHaveLength(1);
    expect(result.total_daily_tokens).toBe(7200);
  });

  it('reports free-pool consumption percentage', () => {
    const result = estimatePackCost({
      resolved: [resolvedFor(alertRecipe)],
      per_recipe: {
        'time-alert-before-event': { slug: 'time-alert-before-event', daily_fires: 100, per_fire_tokens: 1000 },
      },
      free_pool_tokens_per_day: 1_000_000,
    });
    // 100 × 1000 = 100_000 tokens / 1_000_000 = 10%
    expect(result.free_pool_consumption_pct).toBeCloseTo(10, 5);
  });

  it('returns null free-pool consumption pct when free pool is zero', () => {
    const result = estimatePackCost({
      resolved: [resolvedFor(alertRecipe)],
      per_recipe: {
        'time-alert-before-event': { slug: 'time-alert-before-event', daily_fires: 1, per_fire_tokens: 800 },
      },
      free_pool_tokens_per_day: 0,
    });
    expect(result.free_pool_consumption_pct).toBeNull();
  });

  it('computes BYOK $/day when byok_dollars_per_mtoken is provided', () => {
    const result = estimatePackCost({
      resolved: [resolvedFor(alertRecipe)],
      per_recipe: {
        'time-alert-before-event': { slug: 'time-alert-before-event', daily_fires: 1000, per_fire_tokens: 1000 },
      },
      free_pool_tokens_per_day: 1_000_000,
      byok_dollars_per_mtoken: 5,
    });
    // 1000 × 1000 = 1M tokens/day; 1M × $5/Mtoken = $5.
    expect(result.byok_dollars_per_day).toBeCloseTo(5, 5);
  });

  it('returns null BYOK $/day when not provided', () => {
    const result = estimatePackCost({
      resolved: [resolvedFor(alertRecipe)],
      per_recipe: {
        'time-alert-before-event': { slug: 'time-alert-before-event', daily_fires: 1, per_fire_tokens: 800 },
      },
      free_pool_tokens_per_day: 1_000_000,
    });
    expect(result.byok_dollars_per_day).toBeNull();
  });
});
