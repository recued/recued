import { describe, it, expect } from 'vitest';
import type { RecipeDefinition } from '@recued/contracts';
import {
  MARKETPLACE_URL,
  MARKETPLACE_APEX_URL,
  fetchRecipeBySlug,
  fetchRecipeByUrl,
  checkUpstream,
  listRecipes,
  listTemplates,
  fetchSuggestions,
  resolveRecipeInput,
} from '../client.js';

// ────────────────────────────────────────────────────────────────
// Fetch helpers
// ────────────────────────────────────────────────────────────────

type MockResponse = {
  ok?: boolean;
  status?: number;
  statusText?: string;
  body?: unknown;
  throws?: boolean;
};

const mkFetch = (responses: MockResponse[]) => {
  let i = 0;
  const calls: string[] = [];
  const fetchFn = async (url: string | URL): Promise<Response> => {
    calls.push(String(url));
    const r = responses[i++] ?? { ok: true, body: null };
    if (r.throws) throw new Error('simulated network failure');
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      statusText: r.statusText ?? '',
      json: async () => r.body ?? {},
    } as Response;
  };
  return { fetchFn: fetchFn as unknown as typeof globalThis.fetch, calls };
};

const minimalRecipe = (recipeId = 'test-recipe'): RecipeDefinition => ({
  recipe_id: recipeId,
  version: 1,
  ttl: 60,
  metadata: { name: 'T', description: '', author: 'test', supported_platforms: [] },
  variables: {},
  prefetch_steps: [],
  steps: [{ id: 's', transform: 'template', template: 'ok' }],
  output: { sidebar: [] },
});

// ────────────────────────────────────────────────────────────────
// fetchRecipeBySlug
// ────────────────────────────────────────────────────────────────

describe('fetchRecipeBySlug', () => {
  it('GETs the apex /recipes/{slug}.json and returns the BARE row', async () => {
    const recipe = minimalRecipe();
    const payload = {
      recipe_id: 'deal-risk-hubspot', publisher_id: 'recued-core',
      version: 1, recipe,
    };
    const { fetchFn, calls } = mkFetch([{ body: payload }]);
    const r = await fetchRecipeBySlug('deal-risk-hubspot', fetchFn);
    // The apex omits recipe_hash → defaulted to '' (unused by the install resolver).
    expect(r).toEqual({ ...payload, recipe_hash: '' });
    expect(calls[0]).toBe(`${MARKETPLACE_APEX_URL}/recipes/deal-risk-hubspot.json`);
  });

  it('still accepts the legacy { data, meta } envelope (belt-and-suspenders)', async () => {
    const recipe = minimalRecipe();
    const payload = {
      recipe_id: 'deal-risk-hubspot', publisher_id: 'recued-core',
      version: 1, recipe_hash: 'h', recipe,
    };
    const { fetchFn } = mkFetch([{
      body: { data: payload, meta: { request_id: 'r', timestamp: 't' } },
    }]);
    const r = await fetchRecipeBySlug('deal-risk-hubspot', fetchFn);
    // The envelope carries a real hash — preserved, not clobbered by the default.
    expect(r).toEqual(payload);
  });

  it('url-encodes the slug into the apex .json path', async () => {
    const { fetchFn, calls } = mkFetch([{ body: null }]);
    await fetchRecipeBySlug('weird slug/name', fetchFn);
    expect(calls[0]).toBe(`${MARKETPLACE_APEX_URL}/recipes/weird%20slug%2Fname.json`);
  });

  it('returns null on 404', async () => {
    const { fetchFn } = mkFetch([{ ok: false, status: 404 }]);
    expect(await fetchRecipeBySlug('missing', fetchFn)).toBeNull();
  });

  it('throws on other non-ok responses', async () => {
    const { fetchFn } = mkFetch([{ ok: false, status: 503, statusText: 'Unavailable' }]);
    await expect(fetchRecipeBySlug('x', fetchFn)).rejects.toThrow('Marketplace fetch failed: 503 Unavailable');
  });

  it('returns null when the body carries no row (bare null or empty envelope)', async () => {
    const bare = mkFetch([{ body: null }]);
    expect(await fetchRecipeBySlug('x', bare.fetchFn)).toBeNull();
    const enveloped = mkFetch([{ body: { data: null, meta: { request_id: 'r', timestamp: 't' } } }]);
    expect(await fetchRecipeBySlug('x', enveloped.fetchFn)).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// fetchRecipeByUrl
// ────────────────────────────────────────────────────────────────

describe('fetchRecipeByUrl', () => {
  it('returns the parsed recipe when the URL resolves to a valid body', async () => {
    const recipe = minimalRecipe('from-url');
    const { fetchFn, calls } = mkFetch([{ body: recipe }]);
    const r = await fetchRecipeByUrl('https://example.com/recipe.json', fetchFn);
    expect(r.recipe_id).toBe('from-url');
    expect(calls[0]).toBe('https://example.com/recipe.json');
  });

  it('throws on non-ok response', async () => {
    const { fetchFn } = mkFetch([{ ok: false, status: 500, statusText: 'Oops' }]);
    await expect(fetchRecipeByUrl('https://x', fetchFn)).rejects.toThrow('Fetch failed: 500 Oops');
  });

  it('throws when body is missing recipe_id', async () => {
    const { fetchFn } = mkFetch([{ body: { steps: [] } }]);
    await expect(fetchRecipeByUrl('https://x', fetchFn)).rejects.toThrow('did not return a valid recipe');
  });

  it('throws when body is missing steps', async () => {
    const { fetchFn } = mkFetch([{ body: { recipe_id: 'r' } }]);
    await expect(fetchRecipeByUrl('https://x', fetchFn)).rejects.toThrow('did not return a valid recipe');
  });
});

// ────────────────────────────────────────────────────────────────
// checkUpstream
// ────────────────────────────────────────────────────────────────

describe('checkUpstream', () => {
  it('returns {version, hash} when the recipe exists', async () => {
    const { fetchFn, calls } = mkFetch([{
      body: {
        data: { version: 3, recipe_hash: 'abc123' },
        meta: { request_id: 'r', timestamp: 't' },
      },
    }]);
    const r = await checkUpstream('detect-deal-risk-hubspot', fetchFn);
    expect(r).toEqual({ version: 3, hash: 'abc123' });
    expect(calls[0]).toBe(`${MARKETPLACE_URL}/v1/marketplace/recipes/detect-deal-risk-hubspot`);
  });

  it('returns null on non-ok response', async () => {
    const { fetchFn } = mkFetch([{ ok: false, status: 404 }]);
    expect(await checkUpstream('x', fetchFn)).toBeNull();
  });

  it('returns null when envelope has no data', async () => {
    const { fetchFn } = mkFetch([{ body: { data: null, meta: { request_id: 'r', timestamp: 't' } } }]);
    expect(await checkUpstream('x', fetchFn)).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// listRecipes
// ────────────────────────────────────────────────────────────────

describe('listRecipes', () => {
  it('fetches /v1/marketplace/recipes with no query string when params are empty', async () => {
    const { fetchFn, calls } = mkFetch([{
      body: { data: [], meta: { request_id: 'r', timestamp: 't' } },
    }]);
    const r = await listRecipes({}, fetchFn);
    expect(r.rows).toEqual([]);
    expect(r.pagination).toBeUndefined();
    expect(calls[0]).toBe(`${MARKETPLACE_URL}/v1/marketplace/recipes`);
  });

  it('defaults params to {} when not passed', async () => {
    const { fetchFn, calls } = mkFetch([{
      body: { data: [], meta: { request_id: 'r', timestamp: 't' } },
    }]);
    await listRecipes(undefined, fetchFn);
    expect(calls[0]).toBe(`${MARKETPLACE_URL}/v1/marketplace/recipes`);
  });

  it('serialises array fields comma-separated and omits empty arrays', async () => {
    const { fetchFn, calls } = mkFetch([{
      body: { data: [], meta: { request_id: 'r', timestamp: 't' } },
    }]);
    await listRecipes({
      platforms: ['hubspot', 'salesforce'],
      recipeIds: [],
      tags: ['crm', 'sales'],
    }, fetchFn);
    expect(calls[0]).toContain('platforms=hubspot%2Csalesforce');
    expect(calls[0]).toContain('tags=crm%2Csales');
    expect(calls[0]).not.toContain('recipe_ids=');
  });

  it('serialises scalar and pagination fields', async () => {
    const { fetchFn, calls } = mkFetch([{
      body: { data: [], meta: { request_id: 'r', timestamp: 't' } },
    }]);
    await listRecipes({
      platform: 'hubspot',
      recipeIds: ['a', 'b'],
      perPage: 25,
      page: 2,
    }, fetchFn);
    expect(calls[0]).toContain('platform=hubspot');
    expect(calls[0]).toContain('recipe_ids=a%2Cb');
    expect(calls[0]).toContain('per_page=25');
    expect(calls[0]).toContain('page=2');
  });

  it('returns empty rows (and no pagination) on non-ok response', async () => {
    const { fetchFn } = mkFetch([{ ok: false, status: 500 }]);
    const r = await listRecipes({}, fetchFn);
    expect(r).toEqual({ rows: [] });
  });

  it('surfaces pagination from the meta envelope', async () => {
    const pagination = { page: 1, per_page: 20, total_items: 42, total_pages: 3, has_next: true };
    const { fetchFn } = mkFetch([{
      body: {
        data: [{
          recipe_id: 'a', name: 'A', description: '', tags: [],
          platforms: [], download_count: 10,
        }],
        meta: { request_id: 'r', timestamp: 't', pagination },
      },
    }]);
    const r = await listRecipes({ page: 1 }, fetchFn);
    expect(r.rows.length).toBe(1);
    expect(r.pagination).toEqual(pagination);
  });

  it('defaults rows to [] when envelope data is absent', async () => {
    const { fetchFn } = mkFetch([{ body: { meta: { request_id: 'r', timestamp: 't' } } }]);
    const r = await listRecipes({}, fetchFn);
    expect(r.rows).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// listTemplates
// ────────────────────────────────────────────────────────────────

describe('listTemplates', () => {
  it('fetches /v1/marketplace/templates with no query string when params are empty', async () => {
    const { fetchFn, calls } = mkFetch([{
      body: { data: [], meta: { request_id: 'r', timestamp: 't' } },
    }]);
    const r = await listTemplates({}, fetchFn);
    expect(r.rows).toEqual([]);
    expect(calls[0]).toBe(`${MARKETPLACE_URL}/v1/marketplace/templates`);
  });

  it('defaults params to {} when not passed', async () => {
    const { fetchFn, calls } = mkFetch([{
      body: { data: [], meta: { request_id: 'r', timestamp: 't' } },
    }]);
    await listTemplates(undefined, fetchFn);
    expect(calls[0]).toBe(`${MARKETPLACE_URL}/v1/marketplace/templates`);
  });

  it('forwards the vertical filter as ?vertical=', async () => {
    const { fetchFn, calls } = mkFetch([{
      body: { data: [], meta: { request_id: 'r', timestamp: 't' } },
    }]);
    await listTemplates({ vertical: 'mail' }, fetchFn);
    expect(calls[0]).toBe(`${MARKETPLACE_URL}/v1/marketplace/templates?vertical=mail`);
  });

  it('returns empty rows on non-ok response', async () => {
    const { fetchFn } = mkFetch([{ ok: false, status: 500 }]);
    const r = await listTemplates({}, fetchFn);
    expect(r.rows).toEqual([]);
  });

  it('returns the data array from the envelope', async () => {
    const { fetchFn } = mkFetch([{
      body: {
        data: [
          { recipe_id: 'a', name: 'A', description: '', tags: ['template:reactive:mail'], platforms: [], download_count: 0 },
          { recipe_id: 'b', name: 'B', description: '', tags: ['template:reactive:webhook'], platforms: [], download_count: 0 },
        ],
        meta: { request_id: 'r', timestamp: 't' },
      },
    }]);
    const r = await listTemplates({}, fetchFn);
    expect(r.rows.map((row) => row.recipe_id)).toEqual(['a', 'b']);
  });

  it('defaults rows to [] when envelope data is absent', async () => {
    const { fetchFn } = mkFetch([{ body: { meta: { request_id: 'r', timestamp: 't' } } }]);
    const r = await listTemplates({}, fetchFn);
    expect(r.rows).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// fetchSuggestions (thin wrapper)
// ────────────────────────────────────────────────────────────────

describe('fetchSuggestions', () => {
  it('passes platform + perPage to listRecipes', async () => {
    const rows = [{
      recipe_id: 'deal-risk', name: 'Risk', description: 'desc', tags: ['sales'],
      platforms: ['hubspot'], download_count: 10,
    }];
    const { fetchFn, calls } = mkFetch([{
      body: { data: rows, meta: { request_id: 'r', timestamp: 't' } },
    }]);
    const r = await fetchSuggestions('hubspot', 10, fetchFn);
    expect(r).toEqual(rows);
    expect(calls[0]).toContain('platform=hubspot');
    expect(calls[0]).toContain('per_page=10');
  });

  it('uses default limit of 20 when not specified', async () => {
    const { fetchFn, calls } = mkFetch([{
      body: { data: [], meta: { request_id: 'r', timestamp: 't' } },
    }]);
    await fetchSuggestions(undefined, undefined, fetchFn);
    expect(calls[0]).toContain('per_page=20');
    expect(calls[0]).not.toContain('platform=');
  });
});

// ────────────────────────────────────────────────────────────────
// resolveRecipeInput
// ────────────────────────────────────────────────────────────────

describe('resolveRecipeInput', () => {
  it('returns null for blank input', () => {
    expect(resolveRecipeInput('')).toBeNull();
    expect(resolveRecipeInput('   ')).toBeNull();
  });

  it('extracts slug from a bare marketplace URL', () => {
    expect(resolveRecipeInput('recued.com/marketplace/recipes/deal-risk-hubspot'))
      .toEqual({ slug: 'deal-risk-hubspot' });
  });

  it('extracts slug from a full https marketplace URL', () => {
    expect(resolveRecipeInput('https://recued.com/marketplace/recipes/deal-risk-hubspot'))
      .toEqual({ slug: 'deal-risk-hubspot' });
  });

  it('extracts slug from www. and app. subdomains', () => {
    expect(resolveRecipeInput('https://www.recued.com/marketplace/recipes/xy'))
      .toEqual({ slug: 'xy' });
    expect(resolveRecipeInput('https://app.recued.com/marketplace/recipes/ab'))
      .toEqual({ slug: 'ab' });
  });

  it('extracts slug from legacy /recipe/ (singular) path', () => {
    expect(resolveRecipeInput('https://recued.com/recipe/foo-bar'))
      .toEqual({ slug: 'foo-bar' });
  });

  it('⛔ a NON-product domain is not a marketplace URL — it passes through', () => {
    // Was "extracts slug from the staging domain". The regex accepted an
    // optional digit so an operator mirror's URL parsed too; source now names
    // only the product domain. A mirror URL is treated like any other URL —
    // passed through, not silently resolved to a slug.
    expect(resolveRecipeInput('https://mirror.example/marketplace/recipes/x'))
      .not.toEqual({ slug: 'x' });
  });

  it('passes through a full non-marketplace URL', () => {
    expect(resolveRecipeInput('https://example.com/my-recipe.json'))
      .toEqual({ url: 'https://example.com/my-recipe.json' });
  });

  it('recognises a bare slug', () => {
    expect(resolveRecipeInput('deal-risk-hubspot')).toEqual({ slug: 'deal-risk-hubspot' });
  });

  it('recognises a single word as slug', () => {
    expect(resolveRecipeInput('foo')).toEqual({ slug: 'foo' });
  });

  it('treats dotted input as a URL (with https:// if missing)', () => {
    expect(resolveRecipeInput('example.com/recipe.json'))
      .toEqual({ url: 'https://example.com/recipe.json' });
  });

  it('trims surrounding whitespace', () => {
    expect(resolveRecipeInput('  deal-risk-hubspot  ')).toEqual({ slug: 'deal-risk-hubspot' });
  });
});

// ────────────────────────────────────────────────────────────────
// Install-vs-browse marker on the apex install-manifest fetch.
// ────────────────────────────────────────────────────────────────

describe('install-manifest marker header', () => {
  /** Captures the init of every call so the HEADERS can be asserted — the
   *  shared `mockFetch` helper above discards them. */
  const capturing = (body: unknown) => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchFn = (async (url: string, init?: { headers?: Record<string, string> }) => {
      calls.push({ url, headers: { ...(init?.headers ?? {}) } });
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => body,
      };
    }) as unknown as typeof globalThis.fetch;
    return { calls, fetchFn };
  };

  const recipeBody = {
    recipe_id: 'deal-risk',
    publisher_id: 'recued-core',
    version: 1,
    recipe: { recipe_id: 'deal-risk', version: 1, metadata: {}, steps: [] },
  };

  const packBody = {
    manifest_version: 1,
    slug: 'sales-pack',
    publisher: 'recued-core',
    name: 'Sales Pack',
    description: 'A pack.',
    version: 1,
    recipes: [{ slug: 'deal-risk', version: 1 }],
    requires: ['install_bulk_pack'],
  };

  it('fetchRecipeBySlug OMITS the marker by default (browse / preview)', async () => {
    const { calls, fetchFn } = capturing(recipeBody);
    await fetchRecipeBySlug('deal-risk', fetchFn);
    expect(calls[0].headers).toHaveProperty('Accept', 'application/json');
    // Absence must be asserted structurally — toMatchObject cannot prove a key
    // is missing, and a marker that leaks onto browse traffic silently turns
    // the install count back into a view count.
    expect(Object.hasOwn(calls[0].headers, 'x-recued-install')).toBe(false);
  });

  it('fetchRecipeBySlug SETS the marker when install: true', async () => {
    const { calls, fetchFn } = capturing(recipeBody);
    await fetchRecipeBySlug('deal-risk', fetchFn, { install: true });
    expect(calls[0].headers['x-recued-install']).toBe('1');
    expect(calls[0].headers).toHaveProperty('Accept', 'application/json');
  });

  it('fetchBulkPackBySlug OMITS the marker by default', async () => {
    const { fetchBulkPackBySlug } = await import('../bulk-pack-resolver.js');
    const { calls, fetchFn } = capturing(packBody);
    await fetchBulkPackBySlug('sales-pack', fetchFn);
    expect(Object.hasOwn(calls[0].headers, 'x-recued-install')).toBe(false);
  });

  it('fetchBulkPackBySlug SETS the marker when install: true', async () => {
    const { fetchBulkPackBySlug } = await import('../bulk-pack-resolver.js');
    const { calls, fetchFn } = capturing(packBody);
    await fetchBulkPackBySlug('sales-pack', fetchFn, { install: true });
    expect(calls[0].headers['x-recued-install']).toBe('1');
  });

  it('fetchBulkPackByUrl NEVER marks — a side-loaded URL is not our apex', async () => {
    const { fetchBulkPackByUrl } = await import('../bulk-pack-resolver.js');
    const { calls, fetchFn } = capturing(packBody);
    await fetchBulkPackByUrl('https://example.com/some-pack.json', fetchFn);
    expect(Object.hasOwn(calls[0].headers, 'x-recued-install')).toBe(false);
  });

  it('the marker name matches the contract the SSR worker reads', async () => {
    // Sender and reader are separate deploys; a drifting literal would stop the
    // counting silently, so both sides must key off the shared constant.
    const { INSTALL_MANIFEST_MARKER_HEADER } = await import('@recued/contracts');
    const { calls, fetchFn } = capturing(recipeBody);
    await fetchRecipeBySlug('deal-risk', fetchFn, { install: true });
    expect(calls[0].headers[INSTALL_MANIFEST_MARKER_HEADER]).toBe('1');
  });
});
