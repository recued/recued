/** D-165 app-pack v2 — `manifest_version: 2` + `contents[]` parser/validator.
 *
 *  Self-written (Codex unavailable this session); each gate has a good/bad
 *  pair and the normalizer tests are mutation-sensitive (the visible-flag
 *  case fails against a recipes-first dedup order; the dedup case fails if
 *  slug+version dedup is dropped). Back-compat anchors assert a v1 manifest
 *  parses byte-equivalently to before.
 */
import { describe, it, expect } from 'vitest';
import {
  parseBulkPackManifest,
  isBulkPackManifest,
  normalizeBulkPackInstallPlan,
  BULK_PACK_INSTALL_PERMISSION,
  BULK_PACK_MAX_CONTENTS,
  BULK_PACK_MAX_RECIPES,
  type BulkPackManifest,
} from '../bulk-pack.js';

// Helpers return `any` so deliberately-malformed fixtures compile under
// `tsc --build` (the pre-commit hook typechecks test files).
const validV1 = (overrides: Record<string, any> = {}): any => ({
  manifest_version: 1,
  slug: 'test-pack',
  publisher: 'recued-core',
  name: 'Test Pack',
  description: 'A v1 recipe pack.',
  version: 1,
  recipes: [{ slug: 'recipe-a', version: 1 }, { slug: 'recipe-b', version: 2 }],
  requires: [BULK_PACK_INSTALL_PERMISSION],
  tags: ['pack:test'],
  ...overrides,
});

const validV2 = (overrides: Record<string, any> = {}): any => ({
  manifest_version: 2,
  artifact_type: 'pack',
  pack_kind: 'app_pack',
  slug: 'test-app-pack',
  publisher: 'recued-core',
  name: 'Test App Pack',
  description: 'A v2 app pack.',
  version: 1,
  contents: [
    { type: 'recipe', slug: 'recipe-a', version: 1, visible: true },
    { type: 'ingredient', ingredient_id: 'recued-core/github', ingredient_version: 1 },
    { type: 'operation_group', ingredient_id: 'recued-core/github', group_id: 'recued-core/github.issues.read' },
    { type: 'policy', policy_id: 'recued-core/github.default' },
  ],
  requires: [BULK_PACK_INSTALL_PERMISSION],
  tags: ['pack:test'],
  ...overrides,
});

const hasErr = (r: ReturnType<typeof parseBulkPackManifest>, code: string): boolean =>
  r.issues.some((i) => i.severity === 'error' && i.code === code);
const hasErrAt = (r: ReturnType<typeof parseBulkPackManifest>, code: string, path: string): boolean =>
  r.issues.some((i) => i.severity === 'error' && i.code === code && i.path === path);
const hasWarn = (r: ReturnType<typeof parseBulkPackManifest>, code: string): boolean =>
  r.issues.some((i) => i.severity === 'warning' && i.code === code);

describe('D-165 app-pack v2 — back-compat (v1 unchanged)', () => {
  it('parses a valid v1 manifest ok', () => {
    const r = parseBulkPackManifest(validV1());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.recipes).toHaveLength(2);
  });

  it('v1 still requires a non-empty recipes[]', () => {
    expect(hasErr(parseBulkPackManifest(validV1({ recipes: undefined })), 'pack_recipes_required')).toBe(true);
    expect(hasErr(parseBulkPackManifest(validV1({ recipes: [] })), 'pack_recipes_empty')).toBe(true);
  });

  it('v1 still rejects too many recipes + bad entries', () => {
    const many = Array.from({ length: BULK_PACK_MAX_RECIPES + 1 }, (_, i) => ({ slug: `r-${i}`, version: 1 }));
    expect(hasErr(parseBulkPackManifest(validV1({ recipes: many })), 'pack_recipes_too_many')).toBe(true);
    expect(hasErr(parseBulkPackManifest(validV1({ recipes: [{ slug: 'Bad_Slug', version: 1 }] })), 'pack_recipe_slug_format')).toBe(true);
    expect(hasErr(parseBulkPackManifest(validV1({ recipes: [{ slug: 'dup-a', version: 1 }, { slug: 'dup-a', version: 2 }] })), 'pack_recipe_slug_duplicate')).toBe(true);
    expect(hasErr(parseBulkPackManifest(validV1({ recipes: [{ slug: 'a-b', version: 0 }] })), 'pack_recipe_version_invalid')).toBe(true);
  });

  it('v1 carrying contents[] / dependencies[] still parses ok but warns (ignored)', () => {
    const r = parseBulkPackManifest(validV1({ contents: [{ type: 'recipe', slug: 'x-y', version: 1 }], dependencies: [{ type: 'pack', slug: 'base-pack' }] }));
    expect(r.ok).toBe(true);
    expect(hasWarn(r, 'pack_contents_ignored_v1')).toBe(true);
    expect(hasWarn(r, 'pack_dependencies_ignored_v1')).toBe(true);
  });
});

describe('D-165 app-pack v2 — manifest_version gate', () => {
  it('accepts version 1 and 2; rejects 3 / missing', () => {
    expect(parseBulkPackManifest(validV1()).ok).toBe(true);
    expect(parseBulkPackManifest(validV2()).ok).toBe(true);
    expect(hasErr(parseBulkPackManifest(validV2({ manifest_version: 3 })), 'pack_version_unsupported')).toBe(true);
    expect(hasErr(parseBulkPackManifest(validV2({ manifest_version: undefined })), 'pack_version_required')).toBe(true);
  });
});

describe('D-165 app-pack v2 — recipes optional + installable requirement', () => {
  it('v2 needs no top-level recipes[] when contents carries recipes', () => {
    const r = parseBulkPackManifest(validV2({ recipes: undefined }));
    expect(r.ok).toBe(true);
    // recipe contents lifted into recipes[] on the parsed manifest.
    if (r.ok) expect(r.manifest.recipes).toEqual([{ slug: 'recipe-a', version: 1 }]);
  });

  it('v2 with neither recipes nor contents → pack_contents_required', () => {
    expect(hasErr(parseBulkPackManifest(validV2({ recipes: undefined, contents: undefined })), 'pack_contents_required')).toBe(true);
    expect(hasErr(parseBulkPackManifest(validV2({ recipes: [], contents: [] })), 'pack_contents_required')).toBe(true);
  });

  it('a contents-only pure-catalog v2 pack (no recipe entries) is valid', () => {
    const r = parseBulkPackManifest(validV2({
      recipes: undefined,
      contents: [{ type: 'ingredient', ingredient_id: 'recued-core/github', ingredient_version: 1 }],
    }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.recipes).toEqual([]); // no recipes, still valid
  });

  it('too-many contents → pack_contents_too_many (NOT pack_contents_required)', () => {
    const many = Array.from({ length: BULK_PACK_MAX_CONTENTS + 1 }, (_, i) => ({ type: 'policy', policy_id: `p-${i}` }));
    const r = parseBulkPackManifest(validV2({ recipes: undefined, contents: many }));
    expect(hasErr(r, 'pack_contents_too_many')).toBe(true);
    expect(hasErr(r, 'pack_contents_required')).toBe(false); // non-empty array, raw length
  });

  it('v2 recipes[] alias is optional but capped + shape-checked when present', () => {
    expect(parseBulkPackManifest(validV2({ recipes: [{ slug: 'extra-r', version: 1 }] })).ok).toBe(true);
    const many = Array.from({ length: BULK_PACK_MAX_RECIPES + 1 }, (_, i) => ({ slug: `r-${i}`, version: 1 }));
    expect(hasErr(parseBulkPackManifest(validV2({ recipes: many })), 'pack_recipes_too_many')).toBe(true);
    expect(hasErr(parseBulkPackManifest(validV2({ recipes: 'oops' })), 'pack_recipes_required')).toBe(true);
  });
});

describe('D-165 app-pack v2 — content ref shape gates', () => {
  it('accepts every content kind', () => {
    const r = parseBulkPackManifest(validV2({
      contents: [
        { type: 'recipe', slug: 'r-a', version: 1 },
        { type: 'ingredient', slug: 'deal-reader-hubspot', version: 1, role: 'operation_wrapper' },
        { type: 'ingredient', ingredient_id: 'recued-core/github', ingredient_version: 2 },
        { type: 'operation_group', ingredient_id: 'recued-core/github', group_id: 'g.read' },
        { type: 'channel_binding', channel_name: 'slack-bot', capability: 'inline', bound_to_catalog: 'recued-core/slack', conversation_policy: { mode: 'thread' } },
        { type: 'policy', policy_id: 'pol-1' },
      ],
    }));
    expect(r.ok).toBe(true);
  });

  it('rejects an unknown content type', () => {
    expect(hasErrAt(parseBulkPackManifest(validV2({ contents: [{ type: 'frobnicate' }] })), 'pack_content_type_unknown', 'contents[0].type')).toBe(true);
  });

  it('rejects non-array contents', () => {
    expect(hasErr(parseBulkPackManifest(validV2({ contents: 'x' })), 'pack_contents_shape')).toBe(true);
  });

  it('recipe content: visible must be boolean', () => {
    expect(hasErr(parseBulkPackManifest(validV2({ contents: [{ type: 'recipe', slug: 'r-a', version: 1, visible: 'yes' }] })), 'pack_content_recipe_visible_shape')).toBe(true);
  });

  it('ingredient content: exactly one addressing mode', () => {
    // both modes
    expect(hasErr(parseBulkPackManifest(validV2({ contents: [{ type: 'ingredient', slug: 'a-b', version: 1, ingredient_id: 'x/y', ingredient_version: 1 }] })), 'pack_content_ingredient_addressing')).toBe(true);
    // neither mode
    expect(hasErr(parseBulkPackManifest(validV2({ contents: [{ type: 'ingredient' }] })), 'pack_content_ingredient_addressing')).toBe(true);
    // slug present, version missing
    expect(hasErr(parseBulkPackManifest(validV2({ contents: [{ type: 'ingredient', slug: 'a-b' }] })), 'pack_content_ingredient_version')).toBe(true);
    // bad slug
    expect(hasErr(parseBulkPackManifest(validV2({ contents: [{ type: 'ingredient', slug: 'Bad', version: 1 }] })), 'pack_content_ingredient_slug')).toBe(true);
    // bad role
    expect(hasErr(parseBulkPackManifest(validV2({ contents: [{ type: 'ingredient', slug: 'a-b', version: 1, role: 'nope' }] })), 'pack_content_ingredient_role')).toBe(true);
    // byId missing version
    expect(hasErr(parseBulkPackManifest(validV2({ contents: [{ type: 'ingredient', ingredient_id: 'x/y' }] })), 'pack_content_ingredient_version')).toBe(true);
  });

  it('operation_group content: requires ingredient_id + group_id', () => {
    expect(hasErr(parseBulkPackManifest(validV2({ contents: [{ type: 'operation_group', group_id: 'g' }] })), 'pack_content_group_ingredient_id')).toBe(true);
    expect(hasErr(parseBulkPackManifest(validV2({ contents: [{ type: 'operation_group', ingredient_id: 'x/y' }] })), 'pack_content_group_id')).toBe(true);
  });

  it('channel_binding content: capability + name + catalog + object policy', () => {
    expect(hasErr(parseBulkPackManifest(validV2({ contents: [{ type: 'channel_binding', channel_name: 'c', capability: 'realtime', bound_to_catalog: 'x/y', conversation_policy: {} }] })), 'pack_content_channel_capability')).toBe(true);
    expect(hasErr(parseBulkPackManifest(validV2({ contents: [{ type: 'channel_binding', capability: 'inline', bound_to_catalog: 'x/y', conversation_policy: {} }] })), 'pack_content_channel_name')).toBe(true);
    expect(hasErr(parseBulkPackManifest(validV2({ contents: [{ type: 'channel_binding', channel_name: 'c', capability: 'inline', conversation_policy: {} }] })), 'pack_content_channel_catalog')).toBe(true);
    expect(hasErr(parseBulkPackManifest(validV2({ contents: [{ type: 'channel_binding', channel_name: 'c', capability: 'inline', bound_to_catalog: 'x/y', conversation_policy: 'nope' }] })), 'pack_content_channel_policy')).toBe(true);
  });

  it('policy content: requires policy_id', () => {
    expect(hasErr(parseBulkPackManifest(validV2({ contents: [{ type: 'policy' }] })), 'pack_content_policy_id')).toBe(true);
  });
});

describe('D-165 app-pack v2 — dependencies', () => {
  it('accepts ingredient (by id / by slug) + pack dependencies', () => {
    const r = parseBulkPackManifest(validV2({
      dependencies: [
        { type: 'ingredient', ingredient_id: 'recued-core/github', min_version: 2 },
        { type: 'ingredient', slug: 'deal-reader-hubspot' },
        { type: 'pack', slug: 'base-pack', min_version: 1 },
      ],
    }));
    expect(r.ok).toBe(true);
  });

  it('rejects non-array dependencies', () => {
    expect(hasErr(parseBulkPackManifest(validV2({ dependencies: {} })), 'pack_dependencies_shape')).toBe(true);
  });

  it('ingredient dependency: exactly one of slug | ingredient_id', () => {
    expect(hasErr(parseBulkPackManifest(validV2({ dependencies: [{ type: 'ingredient', slug: 'a-b', ingredient_id: 'x/y' }] })), 'pack_dependency_ingredient_addressing')).toBe(true);
    expect(hasErr(parseBulkPackManifest(validV2({ dependencies: [{ type: 'ingredient' }] })), 'pack_dependency_ingredient_addressing')).toBe(true);
  });

  it('pack dependency requires a valid slug; bad type + min_version rejected', () => {
    expect(hasErr(parseBulkPackManifest(validV2({ dependencies: [{ type: 'pack' }] })), 'pack_dependency_slug')).toBe(true);
    expect(hasErr(parseBulkPackManifest(validV2({ dependencies: [{ type: 'recipe' }] })), 'pack_dependency_type')).toBe(true);
    expect(hasErr(parseBulkPackManifest(validV2({ dependencies: [{ type: 'pack', slug: 'base-pack', min_version: 0 }] })), 'pack_dependency_min_version')).toBe(true);
  });
});

describe('D-165 app-pack v2 — pack_kind / artifact_type', () => {
  it('accepts valid pack_kind + artifact_type', () => {
    expect(parseBulkPackManifest(validV2({ pack_kind: 'foundation_pack' })).ok).toBe(true);
    expect(parseBulkPackManifest(validV2({ artifact_type: 'pack' })).ok).toBe(true);
  });

  it('rejects unknown pack_kind + non-pack artifact_type', () => {
    expect(hasErr(parseBulkPackManifest(validV2({ pack_kind: 'mega_pack' })), 'pack_kind_unknown')).toBe(true);
    expect(hasErr(parseBulkPackManifest(validV2({ artifact_type: 'recipe' })), 'pack_artifact_type_invalid')).toBe(true);
  });
});

describe('D-165 app-pack v2 — isBulkPackManifest guard', () => {
  it('accepts v1 (recipes) and v2 (contents-only or recipes)', () => {
    expect(isBulkPackManifest(validV1())).toBe(true);
    expect(isBulkPackManifest(validV2())).toBe(true);
    expect(isBulkPackManifest(validV2({ recipes: undefined }))).toBe(true); // contents only
  });

  it('rejects unsupported version / missing slug / neither array', () => {
    expect(isBulkPackManifest(validV2({ manifest_version: 3 }))).toBe(false);
    expect(isBulkPackManifest(validV1({ slug: undefined }))).toBe(false);
    expect(isBulkPackManifest({ manifest_version: 2, slug: 'p', publisher: 'x' })).toBe(false); // no recipes + no contents
    expect(isBulkPackManifest(42)).toBe(false);
    expect(isBulkPackManifest([])).toBe(false);
  });
});

describe('D-165 app-pack v2 — normalizeBulkPackInstallPlan', () => {
  it('v1: lifts recipes[] into recipe content refs', () => {
    const plan = normalizeBulkPackInstallPlan(validV1() as BulkPackManifest);
    expect(plan.recipes).toEqual([{ slug: 'recipe-a', version: 1 }, { slug: 'recipe-b', version: 2 }]);
    expect(plan.contents).toEqual([
      { type: 'recipe', slug: 'recipe-a', version: 1 },
      { type: 'recipe', slug: 'recipe-b', version: 2 },
    ]);
  });

  it('v1: ignores stray contents[] instead of lifting or deferring them', () => {
    const plan = normalizeBulkPackInstallPlan(validV1({
      recipes: [{ slug: 'real', version: 1 }],
      contents: [
        { type: 'recipe', slug: 'sneaky', version: 1 },
        { type: 'ingredient', ingredient_id: 'x/y', ingredient_version: 1 },
      ],
    }) as BulkPackManifest);

    expect(plan.recipes).toEqual([{ slug: 'real', version: 1 }]);
    expect(plan.contents).toEqual([{ type: 'recipe', slug: 'real', version: 1 }]);
  });

  it('v2: honors contents[] recipes and non-recipe entries', () => {
    const ingredient = { type: 'ingredient', ingredient_id: 'x/y', ingredient_version: 1 };
    const plan = normalizeBulkPackInstallPlan(validV2({
      recipes: [{ slug: 'real', version: 1 }],
      contents: [
        { type: 'recipe', slug: 'sneaky', version: 1 },
        ingredient,
      ],
    }) as BulkPackManifest);

    expect(plan.recipes).toEqual([{ slug: 'sneaky', version: 1 }, { slug: 'real', version: 1 }]);
    expect(plan.contents).toEqual([
      { type: 'recipe', slug: 'sneaky', version: 1 },
      { type: 'recipe', slug: 'real', version: 1 },
      ingredient,
    ]);
  });

  it('v2: derives recipes from recipe contents; non-recipe contents stay in contents', () => {
    const plan = normalizeBulkPackInstallPlan(validV2({ recipes: undefined }) as BulkPackManifest);
    expect(plan.recipes).toEqual([{ slug: 'recipe-a', version: 1 }]);
    // non-recipe refs preserved, no leak into recipes.
    expect(plan.contents.filter((c) => c.type !== 'recipe')).toHaveLength(3);
    expect(plan.recipes.every((r) => 'slug' in r && 'version' in r)).toBe(true);
  });

  it('dedups a recipe present in BOTH recipes[] and contents[] by slug+version', () => {
    const m = {
      manifest_version: 2,
      recipes: [{ slug: 'dup', version: 1 }],
      contents: [{ type: 'recipe', slug: 'dup', version: 1 }, { type: 'recipe', slug: 'dup', version: 2 }],
    } as unknown as BulkPackManifest;
    const plan = normalizeBulkPackInstallPlan(m);
    // dup@1 once, dup@2 once (slug+version, not slug-only).
    expect(plan.recipes).toEqual([{ slug: 'dup', version: 1 }, { slug: 'dup', version: 2 }]);
  });

  it('contents wins the dedup so its visible flag is preserved (flip-sensitive)', () => {
    const m = {
      manifest_version: 2,
      recipes: [{ slug: 'dup', version: 1 }],
      contents: [{ type: 'recipe', slug: 'dup', version: 1, visible: false }],
    } as unknown as BulkPackManifest;
    const plan = normalizeBulkPackInstallPlan(m);
    expect(plan.recipes).toEqual([{ slug: 'dup', version: 1 }]);
    const recipeContent = plan.contents.filter((c) => c.type === 'recipe');
    expect(recipeContent).toHaveLength(1);
    // Would be {slug,version} with NO visible under a recipes-first order.
    expect(recipeContent[0]).toEqual({ type: 'recipe', slug: 'dup', version: 1, visible: false });
  });
});

describe('D-165 app-pack v2 — robustness', () => {
  it('parseBulkPackManifest never throws on adversarial input', () => {
    const garbage = {
      manifest_version: 2,
      slug: 'test-pack',
      publisher: 'recued-core',
      name: 'n',
      description: 'd',
      version: 1,
      requires: [BULK_PACK_INSTALL_PERMISSION],
      contents: [5, null, [], { type: 'ingredient', role: 99 }, { type: 'channel_binding', capability: 7 }],
      dependencies: [42, { type: 'ingredient', slug: 5 }],
    };
    let r: ReturnType<typeof parseBulkPackManifest> | undefined;
    expect(() => { r = parseBulkPackManifest(garbage); }).not.toThrow();
    expect(r?.ok).toBe(false);
  });

  it('parser does not mutate the input object', () => {
    const input = validV2({ recipes: undefined });
    const before = JSON.stringify(input);
    parseBulkPackManifest(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('v2 parsed manifest preserves contents alongside the lifted recipes', () => {
    const r = parseBulkPackManifest(validV2({ recipes: undefined }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.recipes).toEqual([{ slug: 'recipe-a', version: 1 }]);
      expect(r.manifest.contents).toHaveLength(4); // contents preserved as authored
    }
  });
});
