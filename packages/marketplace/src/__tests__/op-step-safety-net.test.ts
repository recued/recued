/** Connection-agnostic op dispatch (slice 3) — marketplace install safety net.
 *
 *  The recipe validator ACCEPTS canonical op-steps (so they can be authored +
 *  published), but the engine has no op→ingredient dispatch: a connection-agnostic
 *  recipe must be R1-rewritten to concrete bindings BEFORE the install transaction
 *  persists it (the `packs.install` handler resolves bundled op-step recipes
 *  against the pack's composition). `installBulkPack` is the pure engine the
 *  backend funnels through — it rejects (`validator_rejected`) any recipe that
 *  still carries an op-step, so no path can silently persist an unrunnable recipe.
 */
import { describe, expect, it } from 'vitest';
import {
  BULK_INSTALL_PACK_VERSION,
  BULK_PACK_INSTALL_PERMISSION,
  type RecipeDefinition,
} from '@recued/contracts';
import {
  installBulkPack,
  type BulkPackInstallInput,
  type BulkPackInstallRecipe,
  type BulkPackRegistry,
  type InstalledRecipeRow,
} from '../install.js';

const ALL_PERMS = new Set([BULK_PACK_INSTALL_PERMISSION]);

/** A validator-passing recipe; `steps` overridable so we can plant an op-step.
 *  Tier-K `core.*` op-steps need no dependency declaration — their runnability is
 *  kernel-derived (R1), so a depless op-step recipe clears the validator and reaches
 *  the op-step SAFETY NET this suite exercises. */
const recipeDef = (recipe_id: string, steps: unknown[]): RecipeDefinition => {
  return {
    recipe_id,
    version: 1,
    ttl: 60,
    metadata: {
      name: recipe_id,
      description: 'slice-3 marketplace safety-net fixture',
      author: 'recued-core',
      supported_platforms: [],
      tags: [],
    },
    steps,
    output: { sidebar: [] },
  } as unknown as RecipeDefinition;
};

const row = (recipe_id: string, steps: unknown[]): BulkPackInstallRecipe => ({
  slug: recipe_id,
  pinned_version: 1,
  recipe: {
    recipe_id,
    publisher_id: 'recued-core',
    version: 1,
    recipe_hash: `${recipe_id}-h`,
    recipe: recipeDef(recipe_id, steps),
  },
});

const buildInput = (recipes: BulkPackInstallRecipe[]): BulkPackInstallInput => ({
  manifest_version: BULK_INSTALL_PACK_VERSION,
  pack_slug: 'crm-pack',
  publisher: 'recued-core',
  requires: [BULK_PACK_INSTALL_PERMISSION],
  recipes,
  ready: true,
});

const inMemoryRegistry = (): BulkPackRegistry & {
  rows: Map<string, InstalledRecipeRow>;
  uninstalled: string[];
} => {
  const rows = new Map<string, InstalledRecipeRow>();
  const uninstalled: string[] = [];
  const key = (slug: string, pub: string): string => `${slug}::${pub}`;
  return {
    rows,
    uninstalled,
    async getInstalled(slug, pub) {
      return rows.get(key(slug, pub)) ?? null;
    },
    async markInstalled(record) {
      rows.set(key(record.recipe_id, record.publisher_id), record);
    },
    async markUninstalled(slug, pub) {
      uninstalled.push(slug);
      rows.delete(key(slug, pub));
    },
  };
};

const OP_STEP = { id: 'deals', op: 'deal.search', args: { limit: 200 } };

describe('installBulkPack — op-step safety net (slice 3 / A3)', () => {
  it('rejects a recipe still carrying an unresolved op-step (validator_rejected)', async () => {
    const reg = inMemoryRegistry();
    const result = await installBulkPack(buildInput([row('canonical', [OP_STEP])]), {
      granted_permissions: ALL_PERMS,
      registry: reg,
      hashRecipe: () => 'h',
    });
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe('validator_rejected');
    expect(result.failure?.message).toMatch(/unresolved canonical op-step/);
    // Nothing persisted.
    expect(reg.rows.size).toBe(0);
  });

  it('rolls back a prior good recipe when a later recipe is an unresolved op-step', async () => {
    const reg = inMemoryRegistry();
    const result = await installBulkPack(
      buildInput([
        row('good', []), // concrete (no op-step) — installs first
        row('canonical', [OP_STEP]), // op-step — triggers the safety net + rollback
      ]),
      { granted_permissions: ALL_PERMS, registry: reg, hashRecipe: () => 'h' },
    );
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe('validator_rejected');
    expect(result.failure?.failed_at?.slug).toBe('canonical');
    // The good recipe installed first, then rolled back — net zero persisted.
    expect(reg.uninstalled).toContain('good');
    expect(reg.rows.size).toBe(0);
  });

  it('a concrete (resolved) recipe set installs cleanly — the net does not over-fire', async () => {
    const reg = inMemoryRegistry();
    const result = await installBulkPack(buildInput([row('concrete', [])]), {
      granted_permissions: ALL_PERMS,
      registry: reg,
      hashRecipe: () => 'h',
    });
    expect(result.ok).toBe(true);
    expect(reg.rows.size).toBe(1);
  });
});
