/** D-299 — the Reception carry runs once the pack is whole: recipes committed AND its
 *  composition in the registry.
 *
 *  ⛔⛔ THE DEFECT (2026-09-24 audit). The carry ran inside `installBulkPackOnServer`, and
 *  the pack's composition was provisioned after it (`provisionPackCompositionForBulkInstall`).
 *  The door check reads each operation's risk and kind from the live registry, so an update
 *  that widened an operation was judged by its OLD risk: the pair was re-pinned behind a
 *  door that no longer covered it, looked alive, and failed at the next submission.
 *
 *  🔑 PINNED AS AN ORDER, BECAUSE THAT IS WHAT WAS WRONG. A spy stands in for the pair store
 *  and records, at the moment the carry asks it, whether the updated composition (v2 adds
 *  `deal.export`) is already in the registry. The carry's own rules are
 *  `reception-pair-carry.test.ts`'s business.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BULK_PACK_INSTALL_PERMISSION,
  D165_CONTRACT_SCHEMA,
  type BulkPackManifest,
} from '@recued/contracts';

import { createLocalManifestStore } from '../ingredient-authoring/local-manifest-store.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { handlePacksInstall, type PackInstallRpcDeps } from '../pack-install-handler.js';
import type { ReceptionPairCarryDeps } from '../reception-pair-carry.js';
import { createRecipeStore } from '../recipe-store.js';
import { createContractStore } from '../storage/contract-store.js';

const NOW = 1_760_000_000_000;
const PACK = 'acme-pack';
const RECIPE_ID = 'acme-note';

const composition = (version: number) => ({
  schema_version: 1 as const,
  slug: 'acme',
  catalog_kind: 'private_byo' as const,
  ingredients: [{ slug: 'acme', kind: 'http' as const, http: { base: 'https://api.acme.example', connection: 'acme' } }],
  operations: [
    { op: 'deal.read', ingredient: 'acme', risk: 'read' as const, approval: 'never' as const,
      bind: { kind: 'rest' as const, method: 'GET' as const, path_template: '/v1/deals' } },
    ...(version > 1
      ? [{ op: 'deal.export', ingredient: 'acme', risk: 'read' as const, approval: 'never' as const,
        bind: { kind: 'rest' as const, method: 'GET' as const, path_template: '/v1/deals/export' } }]
      : []),
  ],
});

const appPack = (version: number): BulkPackManifest => ({
  manifest_version: 2,
  slug: PACK,
  publisher: 'recued-core',
  name: 'Acme',
  description: 'Acme operations.',
  version,
  recipes: [{ slug: RECIPE_ID, version: 1 }],
  requires: [BULK_PACK_INSTALL_PERMISSION],
  tags: [],
  pack_kind: 'app_pack',
  contents: [
    { type: 'recipe', slug: RECIPE_ID, version: 1 },
    { type: 'composition', composition: composition(version) },
  ],
} as unknown as BulkPackManifest);

describe('the Reception carry waits for the composition', () => {
  let db: Database.Database;
  let dir: string;
  let deps: PackInstallRpcDeps;
  let registry: ReturnType<typeof createManifestRegistry>;
  /** At each pair lookup: does the registry already hold v2's operation? */
  let sawV2: boolean[];

  beforeEach(() => {
    sawV2 = [];
    db = new Database(':memory:');
    const contractStore = createContractStore(db, { now: () => NOW });
    contractStore.seedSchema(D165_CONTRACT_SCHEMA);
    dir = mkdtempSync(join(tmpdir(), 'reception-carry-order-'));
    writeFileSync(join(dir, `${RECIPE_ID}.json`), JSON.stringify({
      recipe_id: RECIPE_ID,
      version: 1,
      ttl: 60,
      metadata: {
        name: 'Acme note', description: 'A note.', author: 'recued-core', supported_platforms: [], tags: [],
      },
      variables: {},
      prefetch_steps: [],
      steps: [{ id: 'note', transform: 'default', value: 'x', fallback: '' }],
      output: { render: [] },
    }));
    registry = createManifestRegistry('/nonexistent-reception-carry-order-registry');
    deps = {
      recipeStore: createRecipeStore(dir, db),
      contractStore,
      localManifestStore: createLocalManifestStore(db),
      registry,
      now: () => NOW,
    };
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const carryDeps = (): ReceptionPairCarryDeps => ({
    endpoints: { findById: () => null },
    pairs: {
      listByRecipeId: () => {
        const catalog = registry.get('acme') ?? registry.get(PACK);
        sawV2.push(catalog?.operations?.['deal.export'] !== undefined);
        return [];
      },
      compareAndSet: () => { throw new Error('no pair here to re-pin'); },
    },
    now: () => NOW,
  });

  const install = async (version: number, withReception: boolean) => {
    const { result } = await handlePacksInstall(
      { ...deps, ...(withReception ? { getReceptionPairs: carryDeps } : {}) },
      { manifest: appPack(version), granted_permissions: [BULK_PACK_INSTALL_PERMISSION] },
    );
    expect(result.ok, JSON.stringify(result.failure ?? null)).toBe(true);
  };

  it('⛔⛔ an update carries its pairs with the updated composition already live', async () => {
    await install(1, false);
    expect(registry.get('acme')?.operations?.['deal.export']).toBeUndefined();
    await install(2, true);
    expect(sawV2, 'the carry never asked for the recipe\'s pairs').not.toEqual([]);
    expect(sawV2.every(Boolean), 'the carry ran before the composition was provisioned').toBe(true);
  });
});
