/** D-305 — an install asks for what the packs it brings in need.
 *
 *  The install refuses a pack whose dependency needs a permission the owner did
 *  not grant (`preflightTransitivePermissions`). The dialog offered only the
 *  pack's own `requires`. So an install whose dependency needed more could never
 *  succeed from the dialog: found driving a live server, Personal CRM was refused
 *  "granted permissions are missing transitive pack requirements:
 *  notification_send", and nothing on screen could grant it.
 *
 *  `packs.install_preview` now names those permissions, computed by the install's
 *  own walk, so granting what the dialog offers installs. Real recipe store and
 *  bundled pack manifests throughout. */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BULK_INSTALL_PACK_VERSION,
  BULK_PACK_INSTALL_PERMISSION,
  type BulkPackManifest,
  type RecipeDefinition,
} from '@recued/contracts';

import { dependencyRequirementsFor, handlePacksInstall, makePackInstallHandlers } from '../pack-install-handler.js';
import { createRecipeStore, type RecipeStore } from '../recipe-store.js';

let dir: string;
let db: Database.Database;
let recipeStore: RecipeStore;

const recipe = (recipe_id: string): RecipeDefinition => ({
  recipe_id,
  version: 1,
  ttl: 60,
  metadata: { name: recipe_id, description: 'D-305 fixture', author: 'recued-core', supported_platforms: [], tags: [] },
  steps: [],
  output: { sidebar: [] },
} as unknown as RecipeDefinition);

const pack = (overrides: Partial<BulkPackManifest>): BulkPackManifest => ({
  manifest_version: BULK_INSTALL_PACK_VERSION,
  slug: 'crm',
  publisher: 'recued-core',
  name: 'Personal CRM',
  description: 'fixture',
  version: 1,
  recipes: [{ slug: 'nudge', version: 1 }],
  requires: [BULK_PACK_INSTALL_PERMISSION],
  tags: [],
  ...overrides,
});

/** A bundled dependency pack, the way `resolveBundledPackManifest` finds it. */
const bundle = (manifest: BulkPackManifest): void => {
  writeFileSync(join(dir, `${manifest.slug}.json`), JSON.stringify(manifest));
};

const FOUNDATION = pack({
  slug: 'crm-foundation',
  name: 'Personal CRM Foundation',
  recipes: [{ slug: 'contact-graph', version: 1 }],
  requires: [BULK_PACK_INSTALL_PERMISSION, 'notification_send'],
});
const ROOT = pack({ dependencies: [{ type: 'pack', slug: 'crm-foundation', min_version: 1 }] });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-305-'));
  db = new Database(':memory:');
  for (const id of ['nudge', 'contact-graph', 'digest']) writeFileSync(join(dir, `${id}.json`), JSON.stringify(recipe(id)));
  recipeStore = createRecipeStore(dir, db);
  bundle(FOUNDATION);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const preview = async (manifest: BulkPackManifest) => {
  const slice = makePackInstallHandlers({ recipeStore, packDir: dir })!;
  return await slice.handlers['packs.install_preview']!({ manifest } as never, {} as never) as {
    dependency_requires?: Array<{ permission: string; needed_by: string[] }>;
  };
};

describe('D-305 — the install preview names what the packs it brings in need', () => {
  it('⛔ names the dependency\'s permission, and the pack that needs it', async () => {
    expect((await preview(ROOT)).dependency_requires).toEqual([
      { permission: 'notification_send', needed_by: ['Personal CRM Foundation'] },
    ]);
  });

  it('⛔ granting what the dialog offers installs; granting only the pack\'s own is refused', async () => {
    // What the dialog granted before D-305: the pack's own `requires`, nothing else.
    const before = await handlePacksInstall(
      { recipeStore, packDir: dir },
      { manifest: ROOT, granted_permissions: [...ROOT.requires] },
    );
    expect(before.result).toMatchObject({ ok: false, failure: { code: 'permission_denied' } });
    expect(before.result.failure?.message).toMatch(/missing transitive pack requirements: notification_send/);
    // Nothing landed: the refusal comes before the first dependency installs.
    expect(recipeStore.listForPack('crm')).toEqual([]);
    expect(recipeStore.listForPack('crm-foundation')).toEqual([]);

    // What it grants now: those, plus what the preview named.
    const offered = (await preview(ROOT)).dependency_requires!.map((d) => d.permission);
    const { result } = await handlePacksInstall(
      { recipeStore, packDir: dir },
      { manifest: ROOT, granted_permissions: [...ROOT.requires, ...offered] },
    );
    expect(result.ok).toBe(true);
    expect(recipeStore.listForPack('crm')).toEqual(['nudge']);
    expect(recipeStore.listForPack('crm-foundation')).toEqual(['contact-graph']);
  });

  it('asks nothing extra when the pack already asks for it, or has no dependencies', async () => {
    expect((await preview(pack({
      requires: [BULK_PACK_INSTALL_PERMISSION, 'notification_send'],
      dependencies: [{ type: 'pack', slug: 'crm-foundation', min_version: 1 }],
    }))).dependency_requires).toEqual([]);
    expect((await preview(pack({}))).dependency_requires).toEqual([]);
  });

  it('a permission two packs need names both, through a dependency\'s own dependency', () => {
    bundle(pack({
      slug: 'digest-pack', name: 'Digest', recipes: [{ slug: 'digest', version: 1 }],
      requires: [BULK_PACK_INSTALL_PERMISSION, 'notification_send', 'read_memory'],
    }));
    bundle(pack({
      slug: 'crm-foundation', name: 'Personal CRM Foundation', recipes: [{ slug: 'contact-graph', version: 1 }],
      requires: [BULK_PACK_INSTALL_PERMISSION, 'notification_send'],
      dependencies: [{ type: 'pack', slug: 'digest-pack', min_version: 1 }],
    }));
    expect(dependencyRequirementsFor({ packDir: dir }, ROOT)).toEqual([
      { permission: 'notification_send', needed_by: ['Personal CRM Foundation', 'Digest'] },
      { permission: 'read_memory', needed_by: ['Digest'] },
    ]);
  });

  it('a dependency that cannot be found is left for the install to report', () => {
    expect(dependencyRequirementsFor({ packDir: dir }, pack({
      dependencies: [{ type: 'pack', slug: 'no-such-pack', min_version: 1 }],
    }))).toBeUndefined();
  });
});
