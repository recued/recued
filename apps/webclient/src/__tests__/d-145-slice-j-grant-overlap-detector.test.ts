/** D-145 PA10 follow-on Slice J - cross-pack body-grant overlap detector.
 *
 *  Pure coverage for computePackGrantOverlaps. The detector considers
 *  installed packs as live grant owners, then projects overlaps for every
 *  input pack while subtracting the subject pack from its own owner set.
 */

import { describe, expect, it } from 'vitest';

import { computePackGrantOverlaps } from '../settings/packs-grant-overlap.js';
import type { BulkPackManifest, PackListEntry } from '@recued/contracts';

// ------------------------------------------------------------------
// Builders
// ------------------------------------------------------------------

const CONTACT_BODY_GRANT = 'data.contact.engagements.body_content';
const TIMELINE_BODY_GRANT = 'data.contact.timeline.body_content';
const NOTES_BODY_GRANT = 'data.contact.notes.body_content';
const ZETA_BODY_GRANT = 'data.zeta.body_content';

const asBodyGrants = (
  grants: ReadonlyArray<string>,
): BulkPackManifest['mcp_body_visibility_grants'] =>
  grants as unknown as BulkPackManifest['mcp_body_visibility_grants'];

const baseManifest = (
  overrides: Partial<BulkPackManifest> = {},
): BulkPackManifest => ({
  manifest_version: 1,
  slug: 'test-pack',
  publisher: 'recued-core',
  name: 'Test Pack',
  description: 'A pack for testing.',
  version: 1,
  recipes: [{ slug: 'recipe-a', version: 1 }],
  requires: ['install_bulk_pack'],
  tags: ['test'],
  ...overrides,
});

const bodyGrantManifest = (
  slug: string,
  grants: ReadonlyArray<string> | undefined,
): BulkPackManifest => {
  const manifest = baseManifest({
    slug,
    name: slug,
    recipes: [{ slug: `${slug}-recipe`, version: 1 }],
  });
  if (grants === undefined) return manifest;
  return {
    ...manifest,
    mcp_body_visibility_grants: asBodyGrants(grants),
  };
};

const packEntry = (
  slug: string,
  grants: ReadonlyArray<string> | undefined,
  installed: boolean,
  overrides: Partial<PackListEntry> = {},
): PackListEntry => {
  const manifest = overrides.manifest ?? bodyGrantManifest(slug, grants);
  return {
    slug: manifest.slug,
    publisher: manifest.publisher,
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    pre_install: manifest.pre_install === true,
    installed,
    requires: [...manifest.requires],
    recipe_count: manifest.recipes.length,
    body_visibility_grant_count:
      manifest.mcp_body_visibility_grants?.length ?? 0,
    manifest,
    ...overrides,
  };
};

const installedPack = (
  slug: string,
  grants: ReadonlyArray<string> | undefined,
  overrides: Partial<PackListEntry> = {},
): PackListEntry => packEntry(slug, grants, true, overrides);

const uninstalledPack = (
  slug: string,
  grants: ReadonlyArray<string> | undefined,
  overrides: Partial<PackListEntry> = {},
): PackListEntry => packEntry(slug, grants, false, overrides);

// ------------------------------------------------------------------
// Detector cases
// ------------------------------------------------------------------

describe('D-145 Slice J - computePackGrantOverlaps', () => {
  it('D1 empty packs list returns empty Map', () => {
    const result = computePackGrantOverlaps([]);
    expect(result.size).toBe(0);
  });

  it('D2 single pack with no grants returns an empty overlap entry', () => {
    const result = computePackGrantOverlaps([
      installedPack('pack-a', undefined),
    ]);
    expect(result.size).toBe(1);
    expect(result.get('pack-a')).toEqual({
      grants: [],
      otherPackSlugs: [],
    });
  });

  it('D3 two installed packs with disjoint grants both return empty entries', () => {
    const result = computePackGrantOverlaps([
      installedPack('pack-a', [CONTACT_BODY_GRANT]),
      installedPack('pack-b', [TIMELINE_BODY_GRANT]),
    ]);
    expect(result.get('pack-a')).toEqual({
      grants: [],
      otherPackSlugs: [],
    });
    expect(result.get('pack-b')).toEqual({
      grants: [],
      otherPackSlugs: [],
    });
  });

  it('D4 two installed packs sharing one grant key report each other', () => {
    const result = computePackGrantOverlaps([
      installedPack('pack-a', [CONTACT_BODY_GRANT]),
      installedPack('pack-b', [CONTACT_BODY_GRANT]),
    ]);
    expect(result.get('pack-a')).toEqual({
      grants: [
        {
          grantKey: CONTACT_BODY_GRANT,
          otherPackSlugs: ['pack-b'],
        },
      ],
      otherPackSlugs: ['pack-b'],
    });
    expect(result.get('pack-b')).toEqual({
      grants: [
        {
          grantKey: CONTACT_BODY_GRANT,
          otherPackSlugs: ['pack-a'],
        },
      ],
      otherPackSlugs: ['pack-a'],
    });
  });

  it('D5 three installed packs sharing one key sort the other two slugs', () => {
    const result = computePackGrantOverlaps([
      installedPack('pack-c', [CONTACT_BODY_GRANT]),
      installedPack('pack-a', [CONTACT_BODY_GRANT]),
      installedPack('pack-b', [CONTACT_BODY_GRANT]),
    ]);
    expect(result.get('pack-a')).toEqual({
      grants: [
        {
          grantKey: CONTACT_BODY_GRANT,
          otherPackSlugs: ['pack-b', 'pack-c'],
        },
      ],
      otherPackSlugs: ['pack-b', 'pack-c'],
    });
    expect(result.get('pack-b')).toEqual({
      grants: [
        {
          grantKey: CONTACT_BODY_GRANT,
          otherPackSlugs: ['pack-a', 'pack-c'],
        },
      ],
      otherPackSlugs: ['pack-a', 'pack-c'],
    });
    expect(result.get('pack-c')).toEqual({
      grants: [
        {
          grantKey: CONTACT_BODY_GRANT,
          otherPackSlugs: ['pack-a', 'pack-b'],
        },
      ],
      otherPackSlugs: ['pack-a', 'pack-b'],
    });
  });

  it('D6 uninstalled pack overlaps an installed pack declaring the same grant', () => {
    const result = computePackGrantOverlaps([
      uninstalledPack('subject-pack', [CONTACT_BODY_GRANT]),
      installedPack('installed-owner', [CONTACT_BODY_GRANT]),
    ]);
    expect(result.get('subject-pack')).toEqual({
      grants: [
        {
          grantKey: CONTACT_BODY_GRANT,
          otherPackSlugs: ['installed-owner'],
        },
      ],
      otherPackSlugs: ['installed-owner'],
    });
  });

  it('D7 installed subject that is the sole declarer produces no overlap', () => {
    const result = computePackGrantOverlaps([
      installedPack('subject-pack', [CONTACT_BODY_GRANT]),
      uninstalledPack('non-owner', [TIMELINE_BODY_GRANT]),
    ]);
    expect(result.get('subject-pack')).toEqual({
      grants: [],
      otherPackSlugs: [],
    });
  });

  it('D8 two uninstalled packs declaring the same key but no installed owner stay empty', () => {
    const result = computePackGrantOverlaps([
      uninstalledPack('pack-a', [CONTACT_BODY_GRANT]),
      uninstalledPack('pack-b', [CONTACT_BODY_GRANT]),
    ]);
    expect(result.get('pack-a')).toEqual({
      grants: [],
      otherPackSlugs: [],
    });
    expect(result.get('pack-b')).toEqual({
      grants: [],
      otherPackSlugs: [],
    });
  });

  it('D9 manifest array order is preserved in grants output', () => {
    const ordered = [
      ZETA_BODY_GRANT,
      CONTACT_BODY_GRANT,
      TIMELINE_BODY_GRANT,
    ];
    const result = computePackGrantOverlaps([
      uninstalledPack('subject-pack', ordered),
      installedPack('installed-owner', ordered),
    ]);
    expect(
      result.get('subject-pack')!.grants.map((entry) => entry.grantKey),
    ).toEqual(ordered);
  });

  it('D10 Map keys are present for every input pack', () => {
    const packs = [
      installedPack('installed-with-grant', [CONTACT_BODY_GRANT]),
      installedPack('installed-empty', []),
      uninstalledPack('uninstalled-with-grant', [TIMELINE_BODY_GRANT]),
      uninstalledPack('uninstalled-missing', undefined),
    ];
    const result = computePackGrantOverlaps(packs);
    expect([...result.keys()]).toEqual([
      'installed-with-grant',
      'installed-empty',
      'uninstalled-with-grant',
      'uninstalled-missing',
    ]);
  });

  it('D11 otherPackSlugs union field is alphabetically sorted', () => {
    const result = computePackGrantOverlaps([
      uninstalledPack('subject-pack', [
        CONTACT_BODY_GRANT,
        TIMELINE_BODY_GRANT,
        NOTES_BODY_GRANT,
      ]),
      installedPack('pack-c', [CONTACT_BODY_GRANT]),
      installedPack('pack-a', [TIMELINE_BODY_GRANT]),
      installedPack('pack-b', [CONTACT_BODY_GRANT, NOTES_BODY_GRANT]),
    ]);
    expect(result.get('subject-pack')!.otherPackSlugs).toEqual([
      'pack-a',
      'pack-b',
      'pack-c',
    ]);
  });

  it('D12 intra-pack duplicate grant keys emit one overlap entry', () => {
    const result = computePackGrantOverlaps([
      uninstalledPack('subject-pack', [
        CONTACT_BODY_GRANT,
        CONTACT_BODY_GRANT,
      ]),
      installedPack('installed-owner', [CONTACT_BODY_GRANT]),
    ]);
    expect(result.get('subject-pack')).toEqual({
      grants: [
        {
          grantKey: CONTACT_BODY_GRANT,
          otherPackSlugs: ['installed-owner'],
        },
      ],
      otherPackSlugs: ['installed-owner'],
    });
  });
});
