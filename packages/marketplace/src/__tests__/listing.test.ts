import { describe, it, expect } from 'vitest';
import { buildListing, computeUpdateStatus, isLocallyForked } from '../listing.js';
import { hashRecipe } from '@recued/recipes';
import type { RecipeDefinition } from '@recued/contracts';
import type { InstalledRecipe } from '../types.js';

const sampleRecipe: RecipeDefinition = {
  recipe_id: 'detect-deal-risk-hubspot',
  version: 3,
  ttl: 300,
  metadata: {
    name: 'Deal Risk Detector',
    description: 'Three risk indicators on a HubSpot deal.',
    author: 'recued-core',
    supported_platforms: ['hubspot'],
    variant_group: 'detect-deal-risk',
    tags: ['deal', 'risk', 'hubspot'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [
    { id: 's1', transform: 'template', template: 'hi' },
  ],
  output: { sidebar: [{ type: 'summary', source: 'step.s1' }] },
} as unknown as RecipeDefinition;

// ────────────────────────────────────────────────────────────────
// buildListing
// ────────────────────────────────────────────────────────────────

describe('buildListing', () => {
  it('copies metadata fields into the listing', () => {
    const listing = buildListing(sampleRecipe, 'recued-core', 1_000_000);
    expect(listing.recipe_id).toBe('detect-deal-risk-hubspot');
    expect(listing.publisher_id).toBe('recued-core');
    expect(listing.version).toBe(3);
    expect(listing.name).toBe('Deal Risk Detector');
    expect(listing.description).toBe('Three risk indicators on a HubSpot deal.');
    expect(listing.platforms).toEqual(['hubspot']);
    expect(listing.tags).toEqual(['deal', 'risk', 'hubspot']);
    expect(listing.author).toBe('recued-core');
    expect(listing.variant_group).toBe('detect-deal-risk');
  });

  it('computes recipe_hash matching hashRecipe', () => {
    const listing = buildListing(sampleRecipe, 'recued-core');
    expect(listing.recipe_hash).toBe(hashRecipe(sampleRecipe));
  });

  it('embeds the full recipe body', () => {
    const listing = buildListing(sampleRecipe, 'recued-core');
    expect(listing.recipe).toBe(sampleRecipe);
  });

  it('initializes rating, download_count, signature to defaults', () => {
    const listing = buildListing(sampleRecipe, 'recued-core');
    expect(listing.rating).toEqual({ average: 0, count: 0 });
    expect(listing.download_count).toBe(0);
    expect(listing.signature).toBe(null);
  });

  it('timestamps use the now parameter', () => {
    const now = 1_234_567_890;
    const listing = buildListing(sampleRecipe, 'recued-core', now);
    expect(listing.published_at).toBe(now);
    expect(listing.updated_at).toBe(now);
  });

  it('missing variant_group → null', () => {
    const r = {
      ...sampleRecipe,
      metadata: { ...sampleRecipe.metadata, variant_group: undefined },
    } as unknown as RecipeDefinition;
    const listing = buildListing(r, 'recued-core');
    expect(listing.variant_group).toBe(null);
  });

  it('fork_of metadata maps author → publisher_id', () => {
    const r = {
      ...sampleRecipe,
      metadata: {
        ...sampleRecipe.metadata,
        fork_of: {
          recipe_id: 'original-recipe',
          author: 'upstream-author',
          version: 1,
        },
      },
    } as unknown as RecipeDefinition;
    const listing = buildListing(r, 'my-fork');
    expect(listing.fork_of).toEqual({
      recipe_id: 'original-recipe',
      publisher_id: 'upstream-author',
      version: 1,
    });
  });

  it('missing tags → empty array', () => {
    const r = {
      ...sampleRecipe,
      metadata: { ...sampleRecipe.metadata, tags: undefined },
    } as unknown as RecipeDefinition;
    const listing = buildListing(r, 'recued-core');
    expect(listing.tags).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// computeUpdateStatus
// ────────────────────────────────────────────────────────────────

const mkInstalled = (overrides: Partial<InstalledRecipe> = {}): InstalledRecipe => ({
  recipe_id: sampleRecipe.recipe_id,
  publisher_id: 'recued-core',
  installed_version: sampleRecipe.version,
  installed_hash: hashRecipe(sampleRecipe),
  installed_at: 1_000_000,
  auto_run: false,
  recipe: sampleRecipe,
  last_checked_at: null,
  upstream_version: null,
  upstream_hash: null,
  ...overrides,
});

describe('computeUpdateStatus', () => {
  it('null upstream → upstream_unknown', () => {
    const status = computeUpdateStatus(mkInstalled(), null);
    expect(status.state).toBe('upstream_unknown');
  });

  it('same version + same hash → current', () => {
    const installed = mkInstalled();
    const status = computeUpdateStatus(installed, {
      version: installed.installed_version,
      hash: installed.installed_hash,
    });
    expect(status.state).toBe('current');
  });

  it('upstream newer version → update_available', () => {
    const installed = mkInstalled();
    const status = computeUpdateStatus(installed, {
      version: installed.installed_version + 1,
      hash: 'newhash12',
    });
    expect(status.state).toBe('update_available');
    if (status.state === 'update_available') {
      expect(status.from.version).toBe(installed.installed_version);
      expect(status.to.version).toBe(installed.installed_version + 1);
    }
  });

  it('local recipe edited since install → locally_forked', () => {
    // Simulate the user editing the local recipe: change the recipe
    // without updating installed_hash.
    const editedRecipe = {
      ...sampleRecipe,
      metadata: { ...sampleRecipe.metadata, name: 'Edited Locally' },
    } as unknown as RecipeDefinition;
    const installed = mkInstalled({ recipe: editedRecipe });
    const status = computeUpdateStatus(installed, {
      version: installed.installed_version,
      hash: installed.installed_hash, // upstream hash is the original
    });
    expect(status.state).toBe('locally_forked');
  });

  it('locally forked takes precedence over update_available', () => {
    // If the user locally forked AND upstream has a newer version, we
    // report locally_forked — the user must reconcile their fork first.
    const editedRecipe = {
      ...sampleRecipe,
      metadata: { ...sampleRecipe.metadata, name: 'Edited Locally' },
    } as unknown as RecipeDefinition;
    const installed = mkInstalled({ recipe: editedRecipe });
    const status = computeUpdateStatus(installed, {
      version: installed.installed_version + 1,
      hash: 'newhash',
    });
    expect(status.state).toBe('locally_forked');
  });
});

describe('isLocallyForked', () => {
  it('returns false for an unmodified install', () => {
    expect(isLocallyForked(mkInstalled())).toBe(false);
  });

  it('returns true when the local recipe hash diverges from installed_hash', () => {
    const editedRecipe = {
      ...sampleRecipe,
      metadata: { ...sampleRecipe.metadata, name: 'Edited' },
    } as unknown as RecipeDefinition;
    expect(isLocallyForked(mkInstalled({ recipe: editedRecipe }))).toBe(true);
  });
});
