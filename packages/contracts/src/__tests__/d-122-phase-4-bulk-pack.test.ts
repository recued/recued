/** D-122 Phase 4 — bulk-pack manifest contracts.
 *
 *  Validates:
 *    - Constant values (`BULK_INSTALL_PACK_VERSION`, `BULK_PACK_MAX_RECIPES`,
 *      `BULK_PACK_INSTALL_PERMISSION`)
 *    - `isBulkPackManifest` shape predicate
 *    - `parseBulkPackManifest` happy path + error codes (every code at
 *      least once + boundary cases)
 */

import { describe, expect, it } from 'vitest';
import {
  BULK_INSTALL_PACK_VERSION,
  BULK_PACK_INSTALL_PERMISSION,
  BULK_PACK_MAX_RECIPES,
  PACK_SERVICE_KINDS,
  isBulkPackManifest,
  parseBulkPackManifest,
  type BulkPackManifest,
} from '../index.js';

const validPack = (overrides: Partial<BulkPackManifest> = {}): unknown => ({
  manifest_version: BULK_INSTALL_PACK_VERSION,
  slug: 'personal-crm-foundation',
  publisher: 'recued-core',
  name: 'Personal CRM Foundation',
  description: 'Ten foundational extraction recipes.',
  version: 1,
  recipes: [
    { slug: 'extract-contact-from-mail', version: 1 },
    { slug: 'enrich-contact-from-thread', version: 1 },
  ],
  requires: [BULK_PACK_INSTALL_PERMISSION],
  tags: ['pack:personal-crm', 'graph-builder', 'l1'],
  ...overrides,
});

describe('D-122 Phase 4 — bulk-pack constants', () => {
  it('manifest version is 1', () => {
    expect(BULK_INSTALL_PACK_VERSION).toBe(1);
  });

  it('install permission slug is install_bulk_pack', () => {
    expect(BULK_PACK_INSTALL_PERMISSION).toBe('install_bulk_pack');
  });

  it('max recipes per pack is 50', () => {
    expect(BULK_PACK_MAX_RECIPES).toBe(50);
  });
});

describe('D-122 Phase 4 — isBulkPackManifest', () => {
  it('accepts a valid pack', () => {
    expect(isBulkPackManifest(validPack())).toBe(true);
  });

  it('rejects null / undefined / non-objects', () => {
    expect(isBulkPackManifest(null)).toBe(false);
    expect(isBulkPackManifest(undefined)).toBe(false);
    expect(isBulkPackManifest('not-a-pack')).toBe(false);
    expect(isBulkPackManifest(42)).toBe(false);
    expect(isBulkPackManifest([])).toBe(false);
  });

  it('rejects an unsupported manifest_version (v2 is now accepted)', () => {
    expect(isBulkPackManifest(validPack({ manifest_version: 3 as unknown as 1 }))).toBe(false);
    // D-165 app-pack v2 — manifest_version 2 is now a supported version.
    expect(isBulkPackManifest(validPack({ manifest_version: 2 }))).toBe(true);
  });

  it('rejects packs without a slug or recipes array', () => {
    const noSlug = validPack();
    delete (noSlug as Record<string, unknown>).slug;
    expect(isBulkPackManifest(noSlug)).toBe(false);

    const noRecipes = validPack();
    delete (noRecipes as Record<string, unknown>).recipes;
    expect(isBulkPackManifest(noRecipes)).toBe(false);
  });
});

describe('D-122 Phase 4 — parseBulkPackManifest happy path', () => {
  it('returns ok:true with the manifest passed through', () => {
    const result = parseBulkPackManifest(validPack());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.slug).toBe('personal-crm-foundation');
      expect(result.manifest.recipes).toHaveLength(2);
      expect(result.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
    }
  });

  it('emits no warnings on a fully-populated pack with tags', () => {
    const result = parseBulkPackManifest(validPack());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.issues).toEqual([]);
    }
  });

  it('emits a tags warning when tags is omitted but otherwise passes', () => {
    const noTags = validPack();
    delete (noTags as Record<string, unknown>).tags;
    const result = parseBulkPackManifest(noTags);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const codes = result.issues.map((i) => i.code);
      expect(codes).toContain('pack_tags_missing');
      expect(result.issues.find((i) => i.code === 'pack_tags_missing')?.severity).toBe('warning');
    }
  });
});

describe('D-122 Phase 4 — parseBulkPackManifest top-level errors', () => {
  it('rejects non-objects with pack_not_object', () => {
    const result = parseBulkPackManifest('not-an-object');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => i.code)).toContain('pack_not_object');
    }
  });

  it('rejects arrays with pack_not_object', () => {
    const result = parseBulkPackManifest([]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => i.code)).toContain('pack_not_object');
    }
  });

  it('rejects missing manifest_version with pack_version_required', () => {
    const noVer = validPack();
    delete (noVer as Record<string, unknown>).manifest_version;
    const result = parseBulkPackManifest(noVer);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => i.code)).toContain('pack_version_required');
    }
  });

  it('rejects unknown manifest_version with pack_version_unsupported', () => {
    const result = parseBulkPackManifest(validPack({ manifest_version: 99 as 1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => i.code)).toContain('pack_version_unsupported');
    }
  });
});

describe('D-122 Phase 4 — parseBulkPackManifest slug + identity', () => {
  it('rejects an empty slug with pack_slug_required', () => {
    const result = parseBulkPackManifest(validPack({ slug: '' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => i.code)).toContain('pack_slug_required');
    }
  });

  it('rejects a slug with capital letters with pack_slug_format', () => {
    const result = parseBulkPackManifest(validPack({ slug: 'Personal-CRM' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => i.code)).toContain('pack_slug_format');
    }
  });

  it('rejects a slug starting with a hyphen with pack_slug_format', () => {
    const result = parseBulkPackManifest(validPack({ slug: '-bad-slug' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => i.code)).toContain('pack_slug_format');
    }
  });

  it('rejects missing publisher with pack_publisher_required', () => {
    const result = parseBulkPackManifest(validPack({ publisher: '' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => i.code)).toContain('pack_publisher_required');
    }
  });

  it('rejects missing name with pack_name_required', () => {
    const result = parseBulkPackManifest(validPack({ name: '' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => i.code)).toContain('pack_name_required');
    }
  });

  it('rejects non-integer or zero version with pack_version_field_invalid', () => {
    const a = parseBulkPackManifest(validPack({ version: 0 }));
    const b = parseBulkPackManifest(validPack({ version: 1.5 }));
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    if (!a.ok) expect(a.issues.map((i) => i.code)).toContain('pack_version_field_invalid');
    if (!b.ok) expect(b.issues.map((i) => i.code)).toContain('pack_version_field_invalid');
  });
});

describe('D-122 Phase 4 — parseBulkPackManifest recipes[]', () => {
  it('rejects a non-array recipes with pack_recipes_required', () => {
    const result = parseBulkPackManifest(validPack({ recipes: 'not-an-array' as unknown as never }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => i.code)).toContain('pack_recipes_required');
    }
  });

  it('rejects empty recipes with pack_recipes_empty', () => {
    const result = parseBulkPackManifest(validPack({ recipes: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => i.code)).toContain('pack_recipes_empty');
    }
  });

  it('rejects too many recipes with pack_recipes_too_many', () => {
    const recipes = Array.from(
      { length: BULK_PACK_MAX_RECIPES + 1 },
      (_, i) => ({ slug: `recipe-${i}`, version: 1 }),
    );
    const result = parseBulkPackManifest(validPack({ recipes }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => i.code)).toContain('pack_recipes_too_many');
    }
  });

  it('accepts recipes at exactly BULK_PACK_MAX_RECIPES (boundary)', () => {
    const recipes = Array.from(
      { length: BULK_PACK_MAX_RECIPES },
      (_, i) => ({ slug: `recipe-${i}`, version: 1 }),
    );
    const result = parseBulkPackManifest(validPack({ recipes }));
    expect(result.ok).toBe(true);
  });

  it('rejects a duplicate recipe slug with pack_recipe_slug_duplicate', () => {
    const result = parseBulkPackManifest(validPack({
      recipes: [
        { slug: 'extract-contact-from-mail', version: 1 },
        { slug: 'extract-contact-from-mail', version: 2 },
      ],
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => i.code)).toContain('pack_recipe_slug_duplicate');
    }
  });

  it('rejects a recipe entry that is not an object', () => {
    const result = parseBulkPackManifest(validPack({
      recipes: ['not-an-object' as unknown as never],
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => i.code)).toContain('pack_recipe_entry_shape');
    }
  });

  it('rejects a recipe with bad slug format with pack_recipe_slug_format', () => {
    const result = parseBulkPackManifest(validPack({
      recipes: [{ slug: 'BAD_Slug', version: 1 }],
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => i.code)).toContain('pack_recipe_slug_format');
    }
  });

  it('rejects a recipe with non-integer version with pack_recipe_version_invalid', () => {
    const result = parseBulkPackManifest(validPack({
      recipes: [{ slug: 'extract-contact-from-mail', version: 1.5 }],
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => i.code)).toContain('pack_recipe_version_invalid');
    }
  });
});

describe('D-122 Phase 4 — parseBulkPackManifest requires[]', () => {
  it('rejects non-array requires with pack_requires_required', () => {
    const result = parseBulkPackManifest(validPack({
      requires: 'install_bulk_pack' as unknown as never,
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => i.code)).toContain('pack_requires_required');
    }
  });

  it('rejects requires without install_bulk_pack with pack_requires_install_permission', () => {
    const result = parseBulkPackManifest(validPack({ requires: ['read_memory'] }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => i.code)).toContain('pack_requires_install_permission');
    }
  });

  it('accepts requires that include install_bulk_pack alongside extras', () => {
    const result = parseBulkPackManifest(validPack({
      requires: [BULK_PACK_INSTALL_PERMISSION, 'read_memory'],
    }));
    expect(result.ok).toBe(true);
  });

  it('rejects requires with non-string entries with pack_requires_shape', () => {
    const result = parseBulkPackManifest(validPack({
      requires: [BULK_PACK_INSTALL_PERMISSION, 42 as unknown as string],
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => i.code)).toContain('pack_requires_shape');
    }
  });
});

describe('D-122 Phase 4 — parseBulkPackManifest tags[]', () => {
  it('rejects non-array tags with pack_tags_shape', () => {
    const result = parseBulkPackManifest(validPack({
      tags: 'not-an-array' as unknown as never,
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => i.code)).toContain('pack_tags_shape');
    }
  });

  it('rejects tags with non-string entries with pack_tags_shape', () => {
    const result = parseBulkPackManifest(validPack({
      tags: ['ok', 42 as unknown as string],
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => i.code)).toContain('pack_tags_shape');
    }
  });
});

describe('D-122 Phase 4 — parseBulkPackManifest service_kind', () => {
  it('accepts every v3 pack service kind', () => {
    for (const serviceKind of PACK_SERVICE_KINDS) {
      const result = parseBulkPackManifest(validPack({ service_kind: serviceKind }));
      expect(result.ok, serviceKind).toBe(true);
    }
  });

  it('rejects an unknown service_kind with a dedicated issue code', () => {
    const result = parseBulkPackManifest(validPack({ service_kind: 'daemon' as never }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => i.code)).toContain('pack_service_kind_unknown');
    }
  });
});
