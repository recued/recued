import { describe, expect, it } from 'vitest';

import {
  extractBulkPackRecipeRefs,
  resolveRecipeBundleInstallPack,
  type RecipeBundleCatalogPack,
  type RecipeBundleCatalogRecipe,
} from '../index.js';

const bundle = 'recued-core/task-closure';

const recipe = (
  recipe_id: string,
  over: Partial<RecipeBundleCatalogRecipe> = {},
): RecipeBundleCatalogRecipe => ({
  recipe_id,
  publisher_id: 'recued-core',
  version: 1,
  recipe_bundle: bundle,
  ...over,
});

const pack = (
  slug: string,
  refs: RecipeBundleCatalogPack['recipe_refs'],
  over: Partial<RecipeBundleCatalogPack> = {},
): RecipeBundleCatalogPack => ({
  slug,
  publisher_id: 'recued-core',
  recipe_refs: refs,
  ...over,
});

const members = [recipe('create-task'), recipe('watch-task'), recipe('review-task')];
const refs = members.map((row) => ({ slug: row.recipe_id, version: row.version }));

describe('extractBulkPackRecipeRefs', () => {
  it('normalizes v1 recipes and v2 recipe contents without duplicate declarations', () => {
    expect(extractBulkPackRecipeRefs({
      recipes: [{ slug: 'create-task', version: 1 }],
      contents: [
        { type: 'recipe', slug: 'create-task', version: 1, visible: true },
        { type: 'ingredient', slug: 'task-api', version: 1 },
        { type: 'recipe', slug: 'watch-task', version: 2, visible: false },
      ],
    })).toEqual([
      { slug: 'create-task', version: 1 },
      { slug: 'watch-task', version: 2 },
    ]);
  });

  it('fails closed on malformed or conflicting direct recipe refs', () => {
    expect(extractBulkPackRecipeRefs({ contents: [{ type: 'recipe', slug: 'x' }] }))
      .toBeNull();
    expect(extractBulkPackRecipeRefs({
      recipes: [{ slug: 'x', version: 1 }],
      contents: [{ type: 'recipe', slug: 'x', version: 2 }],
    })).toBeNull();
    expect(extractBulkPackRecipeRefs({ contents: ['unknown-content'] })).toBeNull();
    expect(extractBulkPackRecipeRefs({
      recipes: Array.from({ length: 51 }, (_, index) => ({
        slug: `recipe-${index}`,
        version: 1,
      })),
    })).toBeNull();
  });
});

describe('resolveRecipeBundleInstallPack', () => {
  it('resolves the directly named same-publisher pack and allows extra recipes', () => {
    const carrier = pack('task-closure', [
      ...refs,
      { slug: 'unrelated', version: 1 },
    ]);
    const resolution = resolveRecipeBundleInstallPack(members[0]!, members, [
      pack('too-small', refs.slice(0, 2)),
      pack('other-slug', refs),
      pack('task-closure', refs.map((ref) =>
        ref.slug === 'watch-task' ? { ...ref, version: 2 } : ref)),
      carrier,
    ]);

    // Duplicate rows at the direct identity are ambiguous even when one has
    // valid membership; a corrupt catalog must not choose between them.
    expect(resolution).toEqual({
      status: 'ambiguous',
      bundle_key: bundle,
      member_count: 3,
      candidate_pack_ids: ['recued-core/task-closure', 'recued-core/task-closure'],
    });

    expect(resolveRecipeBundleInstallPack(members[0]!, members, [carrier]))
      .toEqual({
        status: 'resolved',
        bundle_key: bundle,
        members: [...refs].sort((a, b) => a.slug.localeCompare(b.slug)),
        pack: carrier,
      });
  });

  it('fails closed when the direct pack identity is duplicated', () => {
    expect(resolveRecipeBundleInstallPack(members[0]!, members, [
      pack('task-closure', refs),
      pack('task-closure', refs),
    ])).toEqual({
      status: 'ambiguous',
      bundle_key: bundle,
      member_count: 3,
      candidate_pack_ids: ['recued-core/task-closure', 'recued-core/task-closure'],
    });
  });

  it('fails closed on a cross-publisher slug collision in the slug-addressed installer', () => {
    expect(resolveRecipeBundleInstallPack(members[0]!, members, [
      pack('task-closure', refs),
      pack('task-closure', refs, { publisher_id: 'other-publisher' }),
    ])).toEqual({
      status: 'ambiguous',
      bundle_key: bundle,
      member_count: 3,
      candidate_pack_ids: [
        'other-publisher/task-closure',
        'recued-core/task-closure',
      ],
    });
  });

  it('allows one declared recipe when its named pack contains it', () => {
    const only = recipe('only');
    const carrier = pack('task-closure', [
      { slug: 'only', version: 1 },
      { slug: 'pack-sibling-without-bundle-metadata', version: 1 },
    ]);
    expect(resolveRecipeBundleInstallPack(only, [only], [carrier])).toEqual({
      status: 'resolved',
      bundle_key: bundle,
      members: [{ slug: 'only', version: 1 }],
      pack: carrier,
    });
  });

  it('fails closed on invalid bundle rows or missing/version-drifted membership', () => {

    const invalid = recipe('create-task', { recipe_bundle: 'other-publisher/task-closure' });
    expect(resolveRecipeBundleInstallPack(invalid, [invalid, recipe('watch-task')], []))
      .toEqual({ status: 'none' });

    expect(resolveRecipeBundleInstallPack(members[0]!, [...members, recipe('watch-task')], [
      pack('task-closure', refs),
    ])).toEqual({ status: 'none' });

    expect(resolveRecipeBundleInstallPack(members[0]!, members, [
      pack('task-closure', refs.filter((ref) => ref.slug !== 'watch-task')),
    ])).toEqual({ status: 'none' });

    expect(resolveRecipeBundleInstallPack(members[0]!, members, [
      pack('task-closure', refs.map((ref) =>
        ref.slug === 'watch-task' ? { ...ref, version: 2 } : ref)),
    ])).toEqual({ status: 'none' });

    expect(resolveRecipeBundleInstallPack(members[0]!, members, [
      pack('other-pack', refs),
    ])).toEqual({ status: 'none' });
  });
});
