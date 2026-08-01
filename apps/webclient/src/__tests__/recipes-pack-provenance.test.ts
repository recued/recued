/** Pack provenance for the Recipes list→detail.
 *
 *  The case that motivated the module is the LAST one: a pack-owned recipe
 *  that declares no `depends_on` because it only calls its OWN pack's ops —
 *  the shape every D-221 Records pack member is in, and the shape the route's
 *  `depends_on`-only read reported as belonging to no pack at all.
 */
import { describe, expect, it } from 'vitest';
import type { RecipeDefinition } from '@recued/contracts';

import {
  packSlugLabel,
  parseRecipeBundle,
  recipeIsStandalone,
  recipePackRefs,
} from '../recipes/recipe-pack-provenance.js';

const recipe = (partial: Partial<RecipeDefinition>): RecipeDefinition =>
  ({
    recipe_id: 'r',
    version: 1,
    ttl: 0,
    metadata: { name: 'R' },
    variables: {},
    prefetch_steps: [],
    steps: [],
    output: { sidebar: [] },
    ...partial,
  }) as RecipeDefinition;

const bundled = (recipe_bundle: unknown, rest: Partial<RecipeDefinition> = {}) =>
  recipe({
    metadata: { name: 'R', recipe_bundle } as RecipeDefinition['metadata'],
    ...rest,
  });

describe('parseRecipeBundle', () => {
  it('parses <publisher>/<pack> into the depends_on key space', () => {
    expect(parseRecipeBundle(bundled('recued-core/job-status-board'))).toEqual({
      pack_ref: 'recued-core.job-status-board',
      publisher: 'recued-core',
      pack: 'job-status-board',
      relation: 'bundle',
    });
  });

  it('drops a missing, non-string, empty, or malformed bundle key', () => {
    expect(parseRecipeBundle(recipe({}))).toBeNull();
    expect(parseRecipeBundle(bundled(42))).toBeNull();
    expect(parseRecipeBundle(bundled('   '))).toBeNull();
    // no separator / too many separators / illegal slug
    expect(parseRecipeBundle(bundled('job-status-board'))).toBeNull();
    expect(parseRecipeBundle(bundled('a/b/c'))).toBeNull();
    expect(parseRecipeBundle(bundled('recued core/job board'))).toBeNull();
  });

  it('never reports a `/`-separated key through the depends_on path', () => {
    // A bundle key uses `/`; a depends_on entry uses `.`. Feeding the bundle
    // form to the dep field must NOT resolve — otherwise one recipe would key
    // two different chips for one pack.
    expect(
      recipePackRefs(recipe({ depends_on: ['recued-core/job-status-board'] })),
    ).toEqual([]);
  });
});

describe('recipePackRefs', () => {
  it('returns [] for a genuinely standalone recipe', () => {
    expect(recipePackRefs(recipe({}))).toEqual([]);
    expect(recipeIsStandalone(recipe({}))).toBe(true);
  });

  it('reads depends_on packs, sorted by slug, with the version floor', () => {
    expect(
      recipePackRefs(
        recipe({ depends_on: ['recued-core.wave', 'recued-core.hubspot@2'] }),
      ),
    ).toEqual([
      {
        pack_ref: 'recued-core.hubspot',
        publisher: 'recued-core',
        pack: 'hubspot',
        relation: 'depends_on',
        min_version: 2,
      },
      {
        pack_ref: 'recued-core.wave',
        publisher: 'recued-core',
        pack: 'wave',
        relation: 'depends_on',
      },
    ]);
  });

  it('keeps the stricter floor when one pack is pinned twice', () => {
    const refs = recipePackRefs(
      recipe({ depends_on: ['recued-core.hubspot@1', 'recued-core.hubspot@3'] }),
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]?.min_version).toBe(3);
  });

  it('ignores malformed and non-string depends_on entries', () => {
    expect(
      recipePackRefs(
        recipe({ depends_on: [7, null, 'nodot', 'a.b.c', 'recued-core.hubspot'] } as
          unknown as Partial<RecipeDefinition>),
      ).map((r) => r.pack_ref),
    ).toEqual(['recued-core.hubspot']);
  });

  it('puts the owning bundle first and keeps deps after it', () => {
    expect(
      recipePackRefs(
        bundled('recued-core/job-status-board', {
          depends_on: ['recued-core.email-outbox-pack'],
        }),
      ).map((r) => [r.pack_ref, r.relation]),
    ).toEqual([
      ['recued-core.job-status-board', 'bundle'],
      ['recued-core.email-outbox-pack', 'depends_on'],
    ]);
  });

  it('reports a pack named by BOTH fields once, as the owning bundle', () => {
    const refs = recipePackRefs(
      bundled('recued-core/job-status-board', {
        depends_on: ['recued-core.job-status-board@2'],
      }),
    );
    expect(refs).toEqual([
      {
        pack_ref: 'recued-core.job-status-board',
        publisher: 'recued-core',
        pack: 'job-status-board',
        relation: 'bundle',
      },
    ]);
  });

  it('attaches a pack-owned recipe that declares no depends_on', () => {
    // The Records-pack shape: `list-job-board` calls only
    // `recued-core.job-status-board.job.*`, so `depends_on` is legitimately
    // absent (`uncoveredOpDependencies` is advisory). It is NOT standalone.
    const listJobBoard = bundled('recued-core/job-status-board');
    expect(recipePackRefs(listJobBoard)).toEqual([
      {
        pack_ref: 'recued-core.job-status-board',
        publisher: 'recued-core',
        pack: 'job-status-board',
        relation: 'bundle',
      },
    ]);
    expect(recipeIsStandalone(listJobBoard)).toBe(false);
  });
});

describe('packSlugLabel', () => {
  it('title-cases the slug and drops the redundant -pack suffix', () => {
    expect(packSlugLabel('job-status-board')).toBe('Job status board');
    expect(packSlugLabel('email-outbox-pack')).toBe('Email outbox');
    expect(packSlugLabel('hubspot')).toBe('Hubspot');
    expect(packSlugLabel('seller_quote_request')).toBe('Seller quote request');
  });
});
