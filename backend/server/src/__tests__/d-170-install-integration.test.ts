/** D-170 — install-integration core (N.14 / N.15 / N.16).
 *
 *  Exercises the direct-manifest install path end to end: the provisioner +
 *  `ingredient.install` / `ingredient.uninstall` rpc over a real in-memory db
 *  (contract store + local manifest store share it) + a real (empty) manifest
 *  registry + a controllable recipe-store stub.
 *
 *  Asserts the acceptance properties: a 1×1 composition installs as a standalone
 *  ingredient; a wide composition (wrapped in an app_pack) decomposes to a
 *  catalog + entity schemas linked under the pack; the catalog resolves through
 *  the live registry (N.16); uninstall is refcount-aware; the pin-guard blocks a
 *  removal a recipe still depends on (N.14); validation failures write nothing;
 *  and the rpc surface is reserved out of the MCP catalog. */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  D165_CONTRACT_SCHEMA,
  GENERATED_PACK_PUBLISHER,
  MCP_RESERVED_RPC_PREFIXES,
  type BulkPackManifest,
  type CompositionIngredient,
  type RecipeDefinition,
} from '@recued/contracts';

import { createContractStore, type ContractStore } from '../storage/contract-store.js';
import { createManifestRegistry, type ManifestRegistry } from '../manifest-loader.js';
import {
  createLocalManifestStore,
  type LocalManifestStore,
} from '../ingredient-authoring/local-manifest-store.js';
import { recordPackInventory } from '../pack-inventory.js';
import { provisionAuthoredArtifact } from '../ingredient-authoring/install-composition.js';
import {
  makeIngredientAuthoringHandlers,
  type IngredientAuthoringRpcDeps,
} from '../ingredient-authoring/install-rpc.js';
import type { WsClient } from '../ws-server.js';

const NOW = 1_700_000_000_000;

// ── fixtures ────────────────────────────────────────────────────

const readBinding = (path: string) => ({ kind: 'rest' as const, method: 'GET' as const, path_template: path });
const writeBinding = (path: string) => ({ kind: 'rest' as const, method: 'POST' as const, path_template: path });

/** A 1×1 composition → decomposes to a single standalone ingredient. */
const oneByOne = (slug = 'ticket-read'): CompositionIngredient => ({
  schema_version: 1,
  slug,
  catalog_kind: 'private_byo',
  ingredients: [
    {
      slug,
      kind: 'http',
      http: { base: 'https://api.support.example', connection: 'support' },
    },
  ],
  operations: [
    {
      op: 'ticket.read',
      ingredient: slug,
      risk: 'read',
      approval: 'never',
      bind: readBinding('/v1/tickets/{ticket_id}'),
      description: 'Read one support ticket.',
    },
  ],
});

/** A wide composition (2 ops + entity fields) → decomposes to a catalog + 1
 *  entity schema + operation groups. */
const wideComposition = (slug = 'acme'): CompositionIngredient => ({
  schema_version: 1,
  slug,
  catalog_kind: 'private_byo',
  ingredients: [
    {
      slug,
      kind: 'http',
      http: { base: 'https://api.acme.example', connection: 'acme' },
      entities: {
        Deal: {
          fields: [
            { field_path: 'id', type: 'string', maps_to: 'id', source_operation: 'deal.read' },
            { field_path: 'properties.name', type: 'string', maps_to: 'name', source_operation: 'deal.read' },
          ],
        },
      },
    },
  ],
  operations: [
    {
      op: 'deal.read',
      ingredient: slug,
      risk: 'read',
      approval: 'never',
      bind: readBinding('/v3/deals/{deal_id}'),
      description: 'Read one deal.',
    },
    {
      op: 'deal.create',
      ingredient: slug,
      risk: 'write',
      approval: 'ask',
      bind: writeBinding('/v3/deals'),
      description: 'Create a deal.',
    },
  ],
});

const workflowCompositionWithInvalidCompiledRecipe = (slug = 'acme'): CompositionIngredient => ({
  ...wideComposition(slug),
  recipe_templates: [
    {
      template: 'review-then-approve',
      trigger: {
        entity: 'deal',
        field: 'status',
        value: 'pending',
      },
      operation: 'deal.create',
      sync_target: {
        source_id: '{{vault.calendar}}',
        write_back_op: 'deal.read',
      },
    },
  ],
});

const appPack = (composition: CompositionIngredient, packSlug = 'acme-crm'): BulkPackManifest => ({
  manifest_version: 2,
  slug: packSlug,
  publisher: 'recued-core',
  name: 'Acme CRM',
  description: 'Acme operations + entity schemas.',
  version: 1,
  recipes: [],
  requires: ['install_bulk_pack'],
  tags: [],
  pack_kind: 'app_pack',
  contents: [{ type: 'composition', composition }],
});

/** Minimal recipe referencing an ingredient slug in a chosen phase — only the
 *  fields the pin-guard reads (`steps`/`prefetch_steps`/`trigger_steps`). */
const recipeUsingIn = (
  recipeId: string,
  ingredientSlug: string,
  phase: 'steps' | 'prefetch_steps' | 'trigger_steps' = 'steps',
): RecipeDefinition =>
  ({
    recipe_id: recipeId,
    name: recipeId,
    version: 1,
    prefetch_steps: [],
    steps: [],
    [phase]: [{ id: 'use', ingredient: ingredientSlug, input: { operation: 'deal.read' } }],
  }) as unknown as RecipeDefinition;

const recipeUsing = (recipeId: string, ingredientSlug: string): RecipeDefinition =>
  recipeUsingIn(recipeId, ingredientSlug, 'steps');

// ── env ─────────────────────────────────────────────────────────

interface Env {
  db: Database.Database;
  contractStore: ContractStore;
  localManifestStore: LocalManifestStore;
  registry: ManifestRegistry;
  deps: IngredientAuthoringRpcDeps;
  install: (
    manifest: unknown,
    install_scope?: import('@recued/contracts').InstallGrantSelection,
  ) => Promise<import('@recued/contracts').IngredientInstallResult>;
  uninstall: (
    args: import('@recued/contracts').IngredientUninstallArgs,
  ) => Promise<import('@recued/contracts').IngredientUninstallResult>;
}

let env: Env;

const makeEnv = (recipes: Record<string, RecipeDefinition> = {}): Env => {
  const db = new Database(':memory:');
  const contractStore = createContractStore(db, { now: () => NOW });
  contractStore.seedSchema(D165_CONTRACT_SCHEMA);
  const localManifestStore = createLocalManifestStore(db);
  // Empty registry (nonexistent community dir → no bundled manifests).
  const registry = createManifestRegistry('/nonexistent-d170-test-dir');
  const recipeStore = {
    ids: () => Object.keys(recipes),
    get: (id: string) => recipes[id] ?? null,
  };
  const deps: IngredientAuthoringRpcDeps = {
    localManifestStore,
    contractStore,
    registry,
    recipeStore,
    now: () => NOW,
  };
  const handlers = makeIngredientAuthoringHandlers(deps)!;
  const client = {} as WsClient;
  return {
    db,
    contractStore,
    localManifestStore,
    registry,
    deps,
    install: (manifest, install_scope) =>
      handlers.handlers['ingredient.install'](
        { manifest, ...(install_scope ? { install_scope } : {}) },
        client,
      ),
    uninstall: (args) => handlers.handlers['ingredient.uninstall'](args, client),
  };
};

beforeEach(() => {
  env = makeEnv();
});
afterEach(() => {
  env.db.close();
});

// ════════════════════════════════════════════════════════════════

describe('D-170 install integration — 1×1 standalone', () => {
  it('installs a 1×1 composition as a standalone ingredient resolvable through the registry', async () => {
    const result = await env.install(oneByOne());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.installed).toEqual({ kind: 'ingredient', ingredient_id: 'ticket-read', version: 1 });
    expect(result.ingredient_ids).toEqual(['ticket-read']);

    // N.16 — gateway resolves the body through the live registry.
    const resolved = env.registry.get('ticket-read');
    expect(resolved).not.toBeNull();
    expect(resolved?.slug).toBe('ticket-read');
    expect(resolved?.input).toMatchObject({ connection_kind: 'api', method: 'GET' });

    // Body persisted; no pack; standalone inventory row present.
    expect(env.localManifestStore.getManifest('ticket-read')?.slug).toBe('ticket-read');
    const inv = env.contractStore.get('installed_ingredient', ['ticket-read']);
    expect(inv?.value).toMatchObject({ ingredient_id: 'ticket-read', catalog_kind: 'private_byo' });
    expect(env.contractStore.get('installed_pack', ['ticket-read'])).toBeNull();
  });

  it('uninstalls a standalone ingredient by id, deregistering it', async () => {
    await env.install(oneByOne());
    const result = await env.uninstall({ ingredient_id: 'ticket-read' });

    expect(result).toEqual({ ok: true, removed_ingredient_ids: ['ticket-read'], removed_pack: false });
    expect(env.registry.get('ticket-read')).toBeNull();
    expect(env.localManifestStore.getManifest('ticket-read')).toBeNull();
    expect(env.contractStore.get('installed_ingredient', ['ticket-read'])).toBeNull();
  });

  it('rejects a bare WIDE composition (must be wrapped in an app_pack)', async () => {
    const result = await env.install(wideComposition());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('validation_failed');
    expect(result.message).toMatch(/app_pack/);
    // Nothing written.
    expect(env.registry.get('acme')).toBeNull();
    expect(env.localManifestStore.getManifest('acme')).toBeNull();
  });
});

describe('D-170 install integration — wide composition in an app_pack', () => {
  it('decomposes a wide composition to a catalog + entity schemas linked under the pack', async () => {
    const result = await env.install(appPack(wideComposition()));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.installed).toEqual({
      kind: 'pack',
      pack_slug: 'acme-crm',
      pack_version: 1,
      catalog_id: 'acme',
      entity_schema_count: 1,
    });

    // Catalog resolves through the registry with its operations (N.16).
    const catalog = env.registry.get('acme');
    expect(catalog?.operations).toMatchObject({
      'deal.read': {
        operation_id: 'recued-core/acme.deal.read',
        risk_tier: 'read',
        approval: 'never',
      },
      'deal.create': { risk_tier: 'write', approval: 'ask' },
    });

    // Entity schemas persisted alongside the catalog body.
    expect(env.localManifestStore.getEntitySchemas('acme')).toHaveLength(1);
    expect(env.localManifestStore.getEntitySchemas('acme')[0]).toMatchObject({ entity_id: 'deal' });

    // Inventory: pack lists the catalog; the catalog row is private_byo.
    expect(env.contractStore.get('installed_pack', ['acme-crm'])?.value).toMatchObject({
      pack_slug: 'acme-crm',
      ingredient_ids: ['acme'],
    });
    expect(env.contractStore.get('installed_ingredient', ['acme'])?.value).toMatchObject({
      ingredient_id: 'acme',
      catalog_kind: 'private_byo',
      source_pack_slug: 'acme-crm',
    });
  });

  it('stamps a third-party body and grant ids with verified pack provenance', async () => {
    const manifest = {
      ...appPack(wideComposition()),
      publisher: 'community-author',
    };

    const result = await env.install(manifest);

    expect(result.ok).toBe(true);
    const catalog = env.registry.get('acme');
    expect(catalog?.author).toBe('community-author');
    expect(catalog?.operations?.['deal.read']?.operation_id)
      .toBe('community-author.acme-crm.deal.read');
    expect(catalog?.operations?.['deal.create']?.operation_id)
      .toBe('community-author.acme-crm.deal.create');
    expect(Object.values(catalog?.operations ?? {}).map((spec) => spec.operation_id))
      .not.toContain('recued-core/acme.deal.read');
  });

  it('uninstalls the pack, removing catalog body + inventory + deregistering', async () => {
    await env.install(appPack(wideComposition()));
    const result = await env.uninstall({ pack_slug: 'acme-crm' });

    expect(result).toEqual({ ok: true, removed_ingredient_ids: ['acme'], removed_pack: true });
    expect(env.registry.get('acme')).toBeNull();
    expect(env.localManifestStore.getManifest('acme')).toBeNull();
    expect(env.contractStore.get('installed_pack', ['acme-crm'])).toBeNull();
    expect(env.contractStore.get('installed_ingredient', ['acme'])).toBeNull();
  });

  it('keeps a catalog shared by another installed pack (refcount-aware uninstall)', async () => {
    // Two packs both declare catalog slug `acme` (re-install path allowed).
    expect((await env.install(appPack(wideComposition('acme'), 'acme-crm-a'))).ok).toBe(true);
    expect((await env.install(appPack(wideComposition('acme'), 'acme-crm-b'))).ok).toBe(true);

    // Uninstall A → `acme` survives (B still lists it).
    const a = await env.uninstall({ pack_slug: 'acme-crm-a' });
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.removed_ingredient_ids).toEqual([]);
    expect(env.registry.get('acme')).not.toBeNull();
    expect(env.localManifestStore.getManifest('acme')).not.toBeNull();

    // Uninstall B → `acme` finally dropped.
    const b = await env.uninstall({ pack_slug: 'acme-crm-b' });
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.removed_ingredient_ids).toEqual(['acme']);
    expect(env.registry.get('acme')).toBeNull();
  });

  it('refuses a second pack that would rewrite a shared slug under another grant identity', async () => {
    const first = {
      ...appPack(wideComposition('acme'), 'alice-crm'),
      publisher: 'alice-publisher',
    };
    const second = {
      ...appPack(wideComposition('acme'), 'bob-crm'),
      publisher: 'bob-publisher',
    };
    expect((await env.install(first)).ok).toBe(true);

    const refused = await env.install(second);

    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.code).toBe('slug_conflict');
      expect(refused.message).toMatch(/another installed pack with a different body/);
    }
    expect(env.registry.get('acme')?.author).toBe('alice-publisher');
    expect(env.registry.get('acme')?.operations?.['deal.read']?.operation_id)
      .toBe('alice-publisher.alice-crm.deal.read');
    expect(env.contractStore.get('installed_pack', ['bob-crm'])).toBeNull();
  });

  it('refuses to uninstall a pack-owned child directly by ingredient_id', async () => {
    await env.install(appPack(wideComposition()));
    const result = await env.uninstall({ ingredient_id: 'acme' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('bad_request');
    expect(result.message).toMatch(/uninstall the pack/);
    // Untouched.
    expect(env.registry.get('acme')).not.toBeNull();
  });
});

describe('D-170 install integration — pin guard (N.14)', () => {
  it('blocks uninstall when an installed recipe references a child being removed', async () => {
    env = makeEnv({ 'deal-report': recipeUsing('deal-report', 'acme') });
    await env.install(appPack(wideComposition()));

    const blocked = await env.uninstall({ pack_slug: 'acme-crm' });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.code).toBe('pinned');
    expect(blocked.blocked_by).toEqual(['deal-report']);
    // Nothing removed.
    expect(env.registry.get('acme')).not.toBeNull();
    expect(env.contractStore.get('installed_pack', ['acme-crm'])).not.toBeNull();
  });

  it('proceeds with force despite a dependent recipe', async () => {
    env = makeEnv({ 'deal-report': recipeUsing('deal-report', 'acme') });
    await env.install(appPack(wideComposition()));

    const forced = await env.uninstall({ pack_slug: 'acme-crm', force: true });
    expect(forced.ok).toBe(true);
    if (forced.ok) expect(forced.removed_ingredient_ids).toEqual(['acme']);
    expect(env.registry.get('acme')).toBeNull();
  });

  it('blocks a standalone uninstall a recipe depends on', async () => {
    env = makeEnv({ 'tk': recipeUsing('tk', 'ticket-read') });
    await env.install(oneByOne());
    const blocked = await env.uninstall({ ingredient_id: 'ticket-read' });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.code).toBe('pinned');
      expect(blocked.blocked_by).toEqual(['tk']);
    }
  });

  it('scans every step phase — prefetch_steps and trigger_steps also block', async () => {
    for (const phase of ['prefetch_steps', 'trigger_steps'] as const) {
      env = makeEnv({ r: recipeUsingIn('r', 'acme', phase) });
      await env.install(appPack(wideComposition()));
      const blocked = await env.uninstall({ pack_slug: 'acme-crm' });
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) expect(blocked.code).toBe('pinned');
      env.db.close();
    }
    // Re-point the suite env so afterEach's close() is valid.
    env = makeEnv();
  });

  it('does not block on an unrelated recipe', async () => {
    env = makeEnv({ other: recipeUsing('other', 'some-other-ingredient') });
    await env.install(appPack(wideComposition()));
    const result = await env.uninstall({ pack_slug: 'acme-crm' });
    expect(result.ok).toBe(true);
  });
});

describe('D-170 install integration — cross-mode + reinstall (codex fold)', () => {
  it('refuses a pack catalog over a standalone slug (and vice versa)', async () => {
    // standalone `acme` first, then a pack whose catalog is also `acme`.
    await env.install(oneByOne('acme'));
    const pack = await env.install(appPack(wideComposition('acme')));
    expect(pack.ok).toBe(false);
    if (!pack.ok) expect(pack.code).toBe('slug_conflict');
    // The standalone survives + still resolves.
    expect(env.registry.get('acme')?.input).toBeDefined();
    expect(env.contractStore.get('installed_pack', ['acme-crm'])).toBeNull();

    // Reverse: pack catalog first, then a standalone of the same slug.
    env.db.close();
    env = makeEnv();
    await env.install(appPack(wideComposition('acme')));
    const standalone = await env.install(oneByOne('acme'));
    expect(standalone.ok).toBe(false);
    if (!standalone.ok) expect(standalone.code).toBe('slug_conflict');
    // The pack catalog survives (still has operations).
    expect(env.registry.get('acme')?.operations).toBeDefined();
  });

  it('refuses to reuse a pack_slug already held by a non-authored (marketplace) pack', async () => {
    // Simulate a marketplace packs.install: an installed_pack row whose catalog
    // id has NO local manifest body. A pre-registered foreign manifest stands in
    // for the marketplace ingredient the registry would resolve.
    env.registry.register({
      slug: 'marketplace-cat',
      name: 'Marketplace',
      author: 'recued-core',
      kind: 'connection',
      version: 1,
      category: 'data',
      risk_tier: 'read',
      input: {},
      output: {},
    } as never);
    recordPackInventory(env.contractStore, {
      pack_slug: 'acme-crm',
      pack_version: 1,
      contents: [{ type: 'ingredient', ingredient_id: 'marketplace-cat', ingredient_version: 1 }],
      installed_at: NOW,
    });

    const result = await env.install(appPack(wideComposition('acme'), 'acme-crm'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('slug_conflict');
    // The marketplace pack's inventory + registry entry are untouched.
    expect(env.contractStore.get('installed_pack', ['acme-crm'])?.value).toMatchObject({
      ingredient_ids: ['marketplace-cat'],
    });
    expect(env.registry.get('marketplace-cat')?.name).toBe('Marketplace');
    expect(env.contractStore.get('installed_ingredient', ['marketplace-cat'])).not.toBeNull();
  });

  it('cleans the old catalog body + registry when a pack reinstall renames it', async () => {
    await env.install(appPack(wideComposition('acme'), 'acme-crm'));
    expect(env.registry.get('acme')).not.toBeNull();

    // Reinstall the SAME pack with a renamed catalog slug.
    const reinstall = await env.install(appPack(wideComposition('acme2'), 'acme-crm'));
    expect(reinstall.ok).toBe(true);

    // Old catalog fully gone — not resolvable, no body, no inventory.
    expect(env.registry.get('acme')).toBeNull();
    expect(env.localManifestStore.getManifest('acme')).toBeNull();
    expect(env.contractStore.get('installed_ingredient', ['acme'])).toBeNull();

    // New catalog present + the pack now lists only it.
    expect(env.registry.get('acme2')?.operations).toBeDefined();
    expect(env.contractStore.get('installed_pack', ['acme-crm'])?.value).toMatchObject({
      ingredient_ids: ['acme2'],
    });

    // And uninstall removes the renamed catalog cleanly.
    const removed = await env.uninstall({ pack_slug: 'acme-crm' });
    expect(removed.ok).toBe(true);
    if (removed.ok) expect(removed.removed_ingredient_ids).toEqual(['acme2']);
    expect(env.registry.get('acme2')).toBeNull();
  });
});

describe('D-170 install integration — validation + conflict guards', () => {
  it('validation failure writes nothing', async () => {
    const bad = oneByOne();
    (bad.operations[0] as { risk: string }).risk = 'nonsense'; // forcing-function: invalid risk tier
    const result = await env.install(bad);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('validation_failed');
    expect(result.issues.length).toBeGreaterThan(0);
    expect(env.registry.get('ticket-read')).toBeNull();
    expect(env.localManifestStore.getManifest('ticket-read')).toBeNull();
  });

  it('rejects a composition whose compiled workflow recipe fails recipe validation', async () => {
    const result = await env.install(appPack(workflowCompositionWithInvalidCompiledRecipe()));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('validation_failed');
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'vault_ref_in_recipe',
        path: 'contents[0].composition.recipes[0]',
      }),
    );
    expect(env.registry.get('acme')).toBeNull();
    expect(env.localManifestStore.getManifest('acme')).toBeNull();
    expect(env.contractStore.get('installed_pack', ['acme-crm'])).toBeNull();
  });

  it('unknown schema_version is a validation issue, not a throw', async () => {
    const bad = { ...oneByOne(), schema_version: 99 };
    const result = await env.install(bad);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('validation_failed');
    expect(result.issues.some((i) => i.code === 'unknown_schema_version')).toBe(true);
  });

  it('blocks a slug that already names a non-locally-authored ingredient (R12)', async () => {
    // Pre-register a foreign manifest under the slug the composition decomposes to.
    env.registry.register({
      slug: 'ticket-read',
      name: 'Foreign',
      author: 'someone-else',
      kind: 'connection',
      version: 1,
      category: 'data',
      risk_tier: 'read',
      input: {},
      output: {},
    } as never);
    const result = await env.install(oneByOne());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('slug_conflict');
    // The foreign manifest is untouched (still resolves), no local body written.
    expect(env.registry.get('ticket-read')?.name).toBe('Foreign');
    expect(env.localManifestStore.getManifest('ticket-read')).toBeNull();
  });

  it('allows a re-install of an already-local slug (edit / version bump)', async () => {
    await env.install(oneByOne());
    const again = await env.install(oneByOne());
    expect(again.ok).toBe(true);
  });

  it('reports a missing-manifest install as bad_request via the rpc error channel', async () => {
    const handlers = makeIngredientAuthoringHandlers(env.deps)!;
    await expect(handlers.handlers['ingredient.install']({} as never, {} as WsClient)).rejects.toThrow(
      /manifest is required/,
    );
  });

  it('requires exactly one of pack_slug / ingredient_id on uninstall', async () => {
    const neither = await env.uninstall({});
    expect(neither.ok).toBe(false);
    if (!neither.ok) expect(neither.code).toBe('bad_request');
    const both = await env.uninstall({ pack_slug: 'x', ingredient_id: 'y' });
    expect(both.ok).toBe(false);
    if (!both.ok) expect(both.code).toBe('bad_request');
  });

  it('uninstall of an absent pack / ingredient is not_found', async () => {
    const pack = await env.uninstall({ pack_slug: 'nope' });
    expect(pack.ok).toBe(false);
    if (!pack.ok) expect(pack.code).toBe('not_found');
    const ing = await env.uninstall({ ingredient_id: 'nope' });
    expect(ing.ok).toBe(false);
    if (!ing.ok) expect(ing.code).toBe('not_found');
  });
});

describe('D-170 install integration — boot preload + channel isolation', () => {
  it('boot preload re-registers persisted bodies into a fresh registry (N.16)', async () => {
    await env.install(appPack(wideComposition()));
    // Simulate a reboot: a fresh registry over the SAME local store.
    const fresh = createManifestRegistry('/nonexistent-d170-test-dir');
    for (const manifest of env.localManifestStore.listManifests()) fresh.register(manifest);
    expect(fresh.get('acme')?.operations).toBeDefined();
  });

  it('reserves the ingredient.* rpc surface out of the MCP catalog', () => {
    expect(MCP_RESERVED_RPC_PREFIXES).toContain('ingredient.');
    expect('ingredient.install'.startsWith('ingredient.')).toBe(true);
    expect('ingredient.uninstall'.startsWith('ingredient.')).toBe(true);
  });

  it('provisioner is callable directly and is pure on failure', () => {
    // Direct provisioner call (the install_planner both paths share). The
    // provisioner requires a concrete `now`; the rpc deps type carries it
    // optional, so supply one here.
    const provDeps = { ...env.deps, now: () => NOW };
    const ok = provisionAuthoredArtifact(provDeps, oneByOne());
    expect(ok.ok).toBe(true);
    const bad = provisionAuthoredArtifact(provDeps, { not: 'a manifest' });
    expect(bad.ok).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════
// D-165 P3 install planner — a composition's selected grants are WRITTEN as
// pack-owned contract.grant rows (real installed_pack_id = the install pack slug),
// superseding the D-170 #7 disclosure-only stopgap. `ingredient.install` also
// surfaces an honest effectiveness note (a private/local catalog has no operation
// profile yet — gap #2). Uninstall drops exactly this pack's grant rows.
//
// D-182 §7.1 — the read-tier grant is NO LONGER silently auto-written: it is
// written only when the install grant dialog selects ≥Read (`install_scope:
// { access: 'read' }`). The pack-owned write/drop/replace MECHANIC below is
// unchanged; the TRIGGER is now the dialog selection. (The silent-grant removal +
// the headless fail-closed / authored-honoring rules are tested in
// `d-182-install-grant-scope.test.ts`.)
// ════════════════════════════════════════════════════════════════

/** A wide composition whose ops are ALL write-tier (deal.create + deal.update).
 *  D-182: groups are DERIVED — a non-read family has no read-tier group, so the
 *  composition decomposes to ZERO `default_grants` (the read-tier groups only).
 *  Two ops keep it on the catalog path (not the 1×1 standalone path). */
const writeOnlyComposition = (slug = 'acme'): CompositionIngredient => ({
  schema_version: 1,
  slug,
  catalog_kind: 'private_byo',
  ingredients: [
    {
      slug,
      kind: 'http',
      http: { base: 'https://api.acme.example', connection: 'acme' },
      entities: {
        Deal: {
          fields: [{ field_path: 'id', type: 'string', maps_to: 'id', source_operation: 'deal.create' }],
        },
      },
    },
  ],
  operations: [
    {
      op: 'deal.create',
      ingredient: slug,
      risk: 'write',
      approval: 'ask',
      bind: writeBinding('/v3/deals'),
      description: 'Create a deal.',
    },
    {
      op: 'deal.update',
      ingredient: slug,
      risk: 'write',
      approval: 'ask',
      bind: writeBinding('/v3/deals/{deal_id}'),
      description: 'Update a deal.',
    },
  ],
});

describe('D-165 P3 ingredient.install — pack-owned grant provisioning', () => {
  it('writes a pack-owned contract.grant row keyed on the install pack slug', async () => {
    // D-182 §7.1 — the owner picked Read in the install dialog; the read-tier
    // group is granted (no longer silently auto-written).
    const result = await env.install(appPack(wideComposition()), { access: 'read' });
    expect(result.ok).toBe(true);

    // The catalog + inventory landed…
    expect(env.registry.get('acme')?.operations).toBeDefined();
    expect(env.contractStore.get('installed_pack', ['acme-crm'])?.value).toMatchObject({
      ingredient_ids: ['acme'],
    });
    // …AND the selected read-tier grant is a REAL pack-owned row keyed
    // (installed_pack_id=acme-crm, ingredient_id=acme, connection=acme, group).
    const rows = env.contractStore.scan('grant', []);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.segments).toEqual(['acme-crm', 'acme', 'acme', 'acme.deal.read']);
    expect(rows[0]?.value).toEqual({ allowed: true });
  });

  it('surfaces an honest effectiveness note naming the group + connection', async () => {
    const result = await env.install(appPack(wideComposition()), { access: 'read' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const warning = result.warnings.find(
      (w) => w.code === 'authoring_install_grants_pending_profile',
    );
    expect(warning).toBeDefined();
    expect(warning?.severity).toBe('warn');
    expect(warning?.message).toContain('acme.deal.read');
    expect(warning?.message).toContain("connection 'acme'");
  });

  it('emits no grant note + writes no grant rows when no read group is derived', async () => {
    const result = await env.install(appPack(writeOnlyComposition()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.warnings.find((w) => w.code === 'authoring_install_grants_pending_profile'),
    ).toBeUndefined();
    expect(
      result.warnings.find((w) => w.code === 'authoring_install_grants_no_connection'),
    ).toBeUndefined();
    expect(env.contractStore.scan('grant', [])).toHaveLength(0);
  });

  it('uninstall drops this pack’s grant rows', async () => {
    await env.install(appPack(wideComposition()), { access: 'read' });
    expect(env.contractStore.scan('grant', [])).toHaveLength(1);

    const result = await env.uninstall({ pack_slug: 'acme-crm' });
    expect(result.ok).toBe(true);
    expect(env.contractStore.scan('grant', [])).toHaveLength(0);
  });

  it('reinstall REPLACES this pack’s grants — a dropped grant does not linger', async () => {
    await env.install(appPack(wideComposition()), { access: 'read' });
    expect(env.contractStore.scan('grant', [])).toHaveLength(1);

    // Reinstall the SAME pack (slug 'acme-crm', catalog 'acme') with NO read group
    // → even at Read tier there is no read-tier group to grant. The write is a clean
    // replace, so the prior pack-owned grant must be gone, not left dangling under
    // the same installed_pack_id.
    const result = await env.install(appPack(writeOnlyComposition()), { access: 'read' });
    expect(result.ok).toBe(true);
    expect(env.contractStore.scan('grant', [])).toHaveLength(0);
  });

  // ── D-170 gap #2 — the connection → local-catalog binding ──

  it('writes the connection→catalog binding at install (even with NO grant_defaults)', async () => {
    // A read-only local composition declares no grants, but still binds its connection
    // — the binding is what makes the local catalog resolvable + dispatchable.
    await env.install(appPack(wideComposition()));
    const rows = env.contractStore.scan('connection_catalog_binding', []);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.segments).toEqual(['acme']); // connection name (auth.connection)
    expect(rows[0]?.value).toEqual({ catalog_slug: 'acme', installed_pack_id: 'acme-crm' });
  });

  it('uninstall drops the connection→catalog binding', async () => {
    await env.install(appPack(wideComposition()));
    expect(env.contractStore.scan('connection_catalog_binding', [])).toHaveLength(1);

    const result = await env.uninstall({ pack_slug: 'acme-crm' });
    expect(result.ok).toBe(true);
    expect(env.contractStore.scan('connection_catalog_binding', [])).toHaveLength(0);
  });

  it('does NOT clobber a binding another pack owns (one catalog per connection)', async () => {
    // Pack A binds connection 'acme' → catalog 'cat-a'.
    const a = await env.install(appPack(wideComposition('cat-a'), 'pack-a'));
    expect(a.ok).toBe(true);
    // Pack B's composition binds the SAME connection 'acme' (different catalog).
    const b = await env.install(appPack(wideComposition('cat-b'), 'pack-b'));
    expect(b.ok).toBe(true); // B still installs (catalog provisioned)…

    // …but the binding for 'acme' stays A's — B did not hijack it (fail-closed).
    const rows = env.contractStore.scan('connection_catalog_binding', []);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.segments).toEqual(['acme']);
    expect(rows[0]?.value).toEqual({ catalog_slug: 'cat-a', installed_pack_id: 'pack-a' });
  });

  it('✅✅ but an AUTHORED pack DOES take the slot from the MACHINE-MINTED mirror', async () => {
    // ⛔⛔ THE STATE THIS FIXES MADE EVERY PEER EXCHANGE UNDISPATCHABLE. D-225
    // auto-mint installs a GENERATED pack the moment an mcp connection is
    // enrolled, and it claims the connection's single catalog slot. Every
    // authored composition bound to that connection afterwards then hit the
    // no-clobber guard above, stayed non-dispatchable, and answered
    // `catalog_mismatch` on every op — for a pack the owner had explicitly
    // installed and pointed at that connection. A live two-server drive found it
    // in the server log: *"connection 'peer-bob' is already bound to catalog
    // 'mcp-8697…' by pack 'mcp-8697…'; not rebinding for pack 'peer-exchange-out'"*.
    //
    // 🔑 The guard protects ANOTHER PACK's declaration. A generated pack is not
    // one — it is this connection's own mirror, re-minted from the peer's
    // `tools/list` on the idle probe and re-derivable at any time. Provenance
    // decides, not install order.
    const gen = await env.install({
      ...appPack(wideComposition('mcp-deadbeef'), 'mcp-deadbeef'),
      // The exact reserved handle a generated pack is stamped with.
      publisher: GENERATED_PACK_PUBLISHER,
    } as unknown as Parameters<typeof env.install>[0]);
    expect(gen.ok).toBe(true);
    const authored = await env.install(appPack(wideComposition('cat-authored'), 'pack-authored'));
    expect(authored.ok).toBe(true);

    // ⚠ Assert the WINNER by name, not merely that one row exists — "there is a
    // binding" was true before the fix too, and it was the wrong one.
    const rows = env.contractStore.scan('connection_catalog_binding', []);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toEqual({
      catalog_slug: 'cat-authored',
      installed_pack_id: 'pack-authored',
    });
  });
});
