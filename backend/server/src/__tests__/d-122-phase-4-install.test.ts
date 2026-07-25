/** D-122 Phase 4 — server-side bulk-pack install handler.
 *
 *  Exercises `installBulkPackOnServer` against in-memory SQLite + the
 *  real `RecipeStore`. Verifies:
 *    - Engine + recipe-store wiring lands the recipe rows.
 *    - Rollback cleans up partial state on validator rejection.
 *
 *  Pre-rip versions also tested backfill_state seeding for `runs_on`
 *  recipes — that path retired with the runs_on rip.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BULK_INSTALL_PACK_VERSION,
  BULK_PACK_INSTALL_PERMISSION,
  ENGAGEMENT_BODY_CONTENT_REGISTRY_KEY,
  type RecipeDefinition,
} from '@recued/contracts';
import type { BulkPackInstallInput, BulkPackInstallRecipe } from '@recued/marketplace';

import { createRecipeStore, type RecipeStore } from '../recipe-store.js';
import { installBulkPackOnServer } from '../install-bulk-pack-handler.js';
import {
  createMcpBodyVisibilityStore,
  type McpBodyVisibilityStore,
} from '../storage/mcp-body-visibility-store.js';

// ────────────────────────────────────────────────────────────────
// Scaffolding
// ────────────────────────────────────────────────────────────────

let dir: string;
let db: Database.Database;
let recipeStore: RecipeStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'recued-d122-p4-'));
  db = new Database(':memory:');
  recipeStore = createRecipeStore(dir, db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const recipeDef = (recipe_id: string, badShape = false): RecipeDefinition => {
  if (badShape) return { steps: [] } as unknown as RecipeDefinition;
  return {
    recipe_id,
    version: 1,
    ttl: 60,
    metadata: {
      name: recipe_id,
      description: 'd-122 phase 4 server test fixture',
      author: 'recued-core',
      supported_platforms: [],
      tags: [],
    },
    steps: [],
    output: { sidebar: [] },
  } as unknown as RecipeDefinition;
};

const resolvedRow = (
  recipe_id: string,
  version = 1,
  badShape = false,
): BulkPackInstallRecipe => ({
  slug: recipe_id,
  pinned_version: version,
  recipe: {
    recipe_id,
    publisher_id: 'recued-core',
    version,
    recipe_hash: `${recipe_id}-h`,
    recipe: recipeDef(recipe_id, badShape),
  },
});

const buildInput = (recipes: BulkPackInstallRecipe[]): BulkPackInstallInput => ({
  manifest_version: BULK_INSTALL_PACK_VERSION,
  pack_slug: 'personal-crm-foundation',
  publisher: 'recued-core',
  requires: [BULK_PACK_INSTALL_PERMISSION],
  recipes,
  ready: true,
});

const ALL_PERMS = new Set([BULK_PACK_INSTALL_PERMISSION]);

// ────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────

describe('D-122 Phase 4 — installBulkPackOnServer', () => {
  it('installs every recipe + persists to RecipeStore', async () => {
    const result = await installBulkPackOnServer(
      buildInput([resolvedRow('extract-contact-from-mail'), resolvedRow('classify-mail-thread')]),
      ALL_PERMS,
      { recipeStore },
    );
    expect(result.ok).toBe(true);
    expect(recipeStore.listStored()).toHaveLength(2);
    const slugs = recipeStore.listStored().map((r) => r.recipe_id).sort();
    expect(slugs).toEqual(['classify-mail-thread', 'extract-contact-from-mail']);
  });

  it('rolls back persistence when a recipe fails validation', async () => {
    const result = await installBulkPackOnServer(
      buildInput([
        resolvedRow('good-recipe'),
        resolvedRow('bad-recipe', 1, /* badShape */ true),
      ]),
      ALL_PERMS,
      { recipeStore },
    );
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe('validator_rejected');
    expect(recipeStore.listStored()).toHaveLength(0);
  });

  it('rejects on permission denial without touching the store', async () => {
    const result = await installBulkPackOnServer(
      buildInput([resolvedRow('extract-contact-from-mail')]),
      new Set(), // no permissions
      { recipeStore },
    );
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe('permission_denied');
    expect(recipeStore.listStored()).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────
// D-139 P6.B — body-content visibility grant install integration
// ────────────────────────────────────────────────────────────────
// Exercises `installBulkPackOnServer` with `mcpBodyVisibilityStore`
// wired: pack-declared grants persist on success, are absent after a
// failed install, and are skipped when no store is wired.

describe('D-139 P6.B — installBulkPackOnServer body-visibility wiring', () => {
  const KEY = ENGAGEMENT_BODY_CONTENT_REGISTRY_KEY;
  let bodyStore: McpBodyVisibilityStore;
  beforeEach(() => {
    bodyStore = createMcpBodyVisibilityStore(db);
  });

  const inputWithGrants = (
    recipes: BulkPackInstallRecipe[],
    grants: string[],
  ): BulkPackInstallInput => ({
    ...buildInput(recipes),
    pack_slug: 'crm-commitment-tracker',
    mcp_body_visibility_grants: grants,
  });

  it('persists pack-declared body grants on a successful install', async () => {
    const result = await installBulkPackOnServer(
      inputWithGrants([resolvedRow('commitment-producer')], [KEY]),
      ALL_PERMS,
      { recipeStore, mcpBodyVisibilityStore: bodyStore },
    );
    expect(result.ok).toBe(true);
    expect(bodyStore.isGranted(KEY)).toBe(true);
  });

  it('does NOT persist body grants when the install fails validation', async () => {
    const result = await installBulkPackOnServer(
      inputWithGrants(
        [resolvedRow('good'), resolvedRow('bad', 1, /* badShape */ true)],
        [KEY],
      ),
      ALL_PERMS,
      { recipeStore, mcpBodyVisibilityStore: bodyStore },
    );
    expect(result.ok).toBe(false);
    // The grant persists only AFTER every recipe lands; a validation
    // failure aborts before that, so the key is never granted.
    expect(bodyStore.isGranted(KEY)).toBe(false);
  });

  it('skips body grants silently when no store is wired (install still ok)', async () => {
    const result = await installBulkPackOnServer(
      inputWithGrants([resolvedRow('x')], [KEY]),
      ALL_PERMS,
      { recipeStore },
    );
    expect(result.ok).toBe(true);
    expect(bodyStore.isGranted(KEY)).toBe(false); // fresh store, never written
  });
});
