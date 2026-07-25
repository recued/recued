/** Discover deps box — recipeRequiredPacks (depends_on → pack refs). */

import { describe, expect, it } from 'vitest';
import type { RecipeDefinition } from '@recued/contracts';

import {
  missingDeps,
  recipeRequiredPacks,
  resolveRecipeDeps,
  type DepPackInfo,
} from '../recipes/required-packs.js';

const recipe = (depends_on?: string[]): RecipeDefinition =>
  ({ recipe_id: 'r', steps: [], ...(depends_on !== undefined ? { depends_on } : {}) }) as unknown as RecipeDefinition;

describe('recipeRequiredPacks', () => {
  it('returns [] for a kernel-only recipe (no depends_on)', () => {
    expect(recipeRequiredPacks(recipe())).toEqual([]);
    expect(recipeRequiredPacks(recipe([]))).toEqual([]);
  });

  it('maps <publisher>.<pack> to an installable pack slug', () => {
    const [dep] = recipeRequiredPacks(recipe(['recued-core.hubspot']));
    expect(dep).toMatchObject({ pack_ref: 'recued-core.hubspot', publisher: 'recued-core', pack: 'hubspot' });
    expect(dep.min_version).toBeUndefined();
  });

  it('carries a pinned @version as min_version', () => {
    const [dep] = recipeRequiredPacks(recipe(['recued-core.salesforce@3']));
    expect(dep).toMatchObject({ pack: 'salesforce', min_version: 3 });
  });

  it('dedupes by pack_ref, keeping the highest pinned floor', () => {
    const deps = recipeRequiredPacks(recipe(['recued-core.hubspot', 'recued-core.hubspot@2', 'recued-core.hubspot@1']));
    expect(deps).toHaveLength(1);
    expect(deps[0].min_version).toBe(2);
  });

  it('drops malformed entries (not exactly <publisher>.<pack>)', () => {
    // one-part, three-part, bad slug chars, empty → all dropped.
    const deps = recipeRequiredPacks(recipe(['hubspot', 'a.b.c', 'BAD..x', '', 'recued-core.acuity']));
    expect(deps.map((d) => d.pack)).toEqual(['acuity']);
  });

  it('sorts by pack slug for stable rendering', () => {
    const deps = recipeRequiredPacks(recipe(['recued-core.salesforce', 'recued-core.acuity', 'acme.hubspot']));
    expect(deps.map((d) => d.pack)).toEqual(['acuity', 'hubspot', 'salesforce']);
  });
});

const roster: DepPackInfo[] = [
  { slug: 'hubspot', publisher: 'recued-core', name: 'HubSpot', installed: true, requires: ['read_connection_hubspot'], service_kind: 'entity_platform' },
  { slug: 'salesforce', publisher: 'recued-core', name: 'Salesforce', installed: false, requires: ['install_bulk_pack', 'read_connection_salesforce'], service_kind: 'entity_platform' },
];

describe('resolveRecipeDeps / missingDeps', () => {
  it('joins required packs against the roster (installed + name + requires + type)', () => {
    const resolved = resolveRecipeDeps(recipeRequiredPacks(recipe(['recued-core.hubspot', 'recued-core.salesforce'])), roster);
    expect(resolved).toHaveLength(2);
    const hs = resolved.find((d) => d.pack === 'hubspot')!;
    expect(hs).toMatchObject({ name: 'HubSpot', installed: true, known: true, service_kind: 'entity_platform' });
    expect(hs.requires).toEqual(['read_connection_hubspot']);
  });

  it('marks a pack not in the roster as unknown + not-installed (marketplace-only edge)', () => {
    const resolved = resolveRecipeDeps(recipeRequiredPacks(recipe(['acme.thirdparty'])), roster);
    expect(resolved[0]).toMatchObject({ pack: 'thirdparty', name: 'thirdparty', known: false, installed: false });
    expect(resolved[0].requires).toEqual([]);
  });

  it('missingDeps returns only the not-installed ones', () => {
    const resolved = resolveRecipeDeps(recipeRequiredPacks(recipe(['recued-core.hubspot', 'recued-core.salesforce'])), roster);
    expect(missingDeps(resolved).map((d) => d.pack)).toEqual(['salesforce']);
  });

  it('preserves the pinned min_version through resolution', () => {
    const resolved = resolveRecipeDeps(recipeRequiredPacks(recipe(['recued-core.salesforce@4'])), roster);
    expect(resolved[0].min_version).toBe(4);
  });

  it('carries a known pack manifest through (drives the co-install grant picker); unknown packs have none', () => {
    const manifest = { manifest_version: 2, slug: 'hubspot', publisher: 'recued-core', name: 'HubSpot', description: '', version: 1, recipes: [], requires: [], tags: [] } as unknown as DepPackInfo['manifest'];
    const withManifest: DepPackInfo[] = [{ ...roster[0], manifest }];
    const [hs] = resolveRecipeDeps(recipeRequiredPacks(recipe(['recued-core.hubspot'])), withManifest);
    expect(hs.manifest).toBe(manifest);
    // An unknown (not-in-roster) dep carries no manifest → no picker.
    const [unknown] = resolveRecipeDeps(recipeRequiredPacks(recipe(['acme.thirdparty'])), withManifest);
    expect(unknown.manifest).toBeUndefined();
  });
});
