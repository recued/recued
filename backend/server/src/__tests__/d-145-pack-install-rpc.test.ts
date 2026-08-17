/** D-145 PA10 follow-on — `packs.install` rpc handler + composer.
 *
 *  Exercises the rpc surface over the engine's
 *  `installBulkPackOnServer` path:
 *    - Composer returns the undefined-bundle when `recipeStore` is
 *      absent → handler `makePackInstallHandlers(undefined)` returns
 *      `undefined` so the rpc surfaces `not_configured`.
 *    - Happy path: manifest with two bundled recipes + two SI rules
 *      → installed rows + SI rows land in their stores.
 *    - `BULK_PACK_INSTALL_PERMISSION` is auto-added so callers only
 *      pass the user-visible `manifest.requires[]` entries.
 *    - Manifest validator failures surface as `bad_request` on the rpc
 *      error channel (`RpcError`) — distinct from engine `failure.code`
 *      outcomes which return on the result body.
 *    - Engine `ok: false` outcomes (`unresolved` for missing bundled
 *      slug, `permission_denied` for missing user grant, etc.) return
 *      on the result body, not the error channel.
 *    - Standing Instruction store absent → engine silently skips
 *      manifest SI rules (declaration-only mode); pack-shipped recipes
 *      still land.
 *    - Recipe resolution scope is bundled-only (matches foundation
 *      pre-install) — an already-installed-but-not-bundled slug
 *      resolves as `failure: 'not_found'`. */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BULK_INSTALL_PACK_VERSION,
  BULK_PACK_INSTALL_PERMISSION,
  CONTRACT_DEFINITION_SCOPE,
  D165_CONTRACT_SCHEMA,
  OWNER_CONTRACT_ID,
  RpcError,
  type BulkPackManifest,
  type PackWebhookRequirement,
  type PackContentRef,
  type RecipeDefinition,
} from '@recued/contracts';

import { composePackInstallRpcDeps } from '../composition/bin/wire-pack-install-rpc-deps.js';
import {
  handlePacksInstall,
  makePackInstallHandlers,
} from '../pack-install-handler.js';
import { createRecipeStore, type RecipeStore } from '../recipe-store.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import { createContractStore } from '../storage/contract-store.js';
import {
  createChatInboundTokenStore,
  ensureChatInboundTokenSchema,
} from '../storage/chat-inbound-token-store.js';
import type {
  ReplaceWebhookConsumerInput,
  WebhookConsumerStore,
} from '../storage/webhook-consumer-store.js';

// ────────────────────────────────────────────────────────────────
// Scaffolding
// ────────────────────────────────────────────────────────────────

let dir: string;
let db: Database.Database;
let recipeStore: RecipeStore;

const PACK_SLUG = 'd-145-pack-install-rpc-fixture';

const recipeDef = (recipe_id: string): RecipeDefinition => ({
  recipe_id,
  version: 1,
  ttl: 60,
  metadata: {
    name: recipe_id,
    description: 'd-145 pack-install rpc test fixture',
    author: 'recued-core',
    supported_platforms: [],
    tags: [],
  },
  steps: [],
  output: { sidebar: [] },
} as unknown as RecipeDefinition);

const writeBundledRecipe = (recipe_id: string): void => {
  writeFileSync(join(dir, `${recipe_id}.json`), JSON.stringify(recipeDef(recipe_id)));
};

const baseManifest = (overrides: Partial<BulkPackManifest> = {}): BulkPackManifest => ({
  manifest_version: BULK_INSTALL_PACK_VERSION,
  slug: PACK_SLUG,
  publisher: 'recued-core',
  name: 'D-145 pack-install rpc test pack',
  description: 'fixture',
  version: 1,
  recipes: [{ slug: 'alpha-recipe', version: 1 }],
  requires: [BULK_PACK_INSTALL_PERMISSION],
  tags: [],
  ...overrides,
});

const appContents: PackContentRef[] = [
  { type: 'ingredient', ingredient_id: 'recued-core/github', ingredient_version: 1 },
  { type: 'operation_group', ingredient_id: 'recued-core/github', group_id: 'recued-core/github.issues.read' },
  {
    type: 'channel_binding',
    channel_name: 'github-issues',
    capability: 'inline',
    bound_to_catalog: 'recued-core/github',
    conversation_policy: { mode: 'thread' },
  },
  { type: 'policy', policy_id: 'recued-core/github.default' },
];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'recued-d145-pack-install-rpc-'));
  db = new Database(':memory:');
  ensureChatInboundTokenSchema(db);
  // Seed bundled fixtures before creating the store — `createRecipeStore`
  // scans the directory at construction.
  writeBundledRecipe('alpha-recipe');
  writeBundledRecipe('beta-recipe');
  recipeStore = createRecipeStore(dir, db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────
// Composer
// ────────────────────────────────────────────────────────────────

describe('composePackInstallRpcDeps', () => {
  it('returns undefined-bundle when recipeStore is absent', () => {
    const bundle = composePackInstallRpcDeps({
      recipeStore: undefined,
    });
    expect(bundle.packInstallDeps).toBeUndefined();
  });

  it('returns deps with the recipe store wired when present', () => {
    const bundle = composePackInstallRpcDeps({
      recipeStore,
    });
    expect(bundle.packInstallDeps).toBeDefined();
    expect(bundle.packInstallDeps?.recipeStore).toBe(recipeStore);
  });

  it('threads the `now` test seam onto the deps', () => {
    const fixedClock = () => 1234567890;
    const bundle = composePackInstallRpcDeps({
      recipeStore,
      now: fixedClock,
    });
    expect(bundle.packInstallDeps?.now).toBe(fixedClock);
  });

  it('threads the recipeTrustStore onto the deps', () => {
    const recipeTrustStore = {
      set: async () => undefined,
    };
    const bundle = composePackInstallRpcDeps({
      recipeStore,
      recipeTrustStore,
    });

    expect(bundle.packInstallDeps?.recipeTrustStore).toBe(recipeTrustStore);
  });

  it('threads the sellerStore onto the deps for install audience fan-out', () => {
    const sellerStore = {
      listCustomers: () => [{ contract_id: 'ct_customer_1' }],
    };
    const bundle = composePackInstallRpcDeps({
      recipeStore,
      sellerStore,
    });

    expect(bundle.packInstallDeps?.sellerStore).toBe(sellerStore);
  });

  it('threads the inbound token store for customer grant-snapshot rollout', () => {
    const inboundTokenStore = createChatInboundTokenStore(db);
    const bundle = composePackInstallRpcDeps({
      recipeStore,
      inboundTokenStore,
    });

    expect(bundle.packInstallDeps?.inboundTokenStore).toBe(inboundTokenStore);
  });

  it('threads the `packDir` test seam onto the deps', () => {
    const bundle = composePackInstallRpcDeps({
      recipeStore,
      packDir: dir,
    });

    expect(bundle.packInstallDeps?.packDir).toBe(dir);
  });
});

// ────────────────────────────────────────────────────────────────
// Handler-set factory — undefined deps drop the slice
// ────────────────────────────────────────────────────────────────

describe('makePackInstallHandlers', () => {
  it('returns undefined when deps are absent (rpc surfaces not_configured)', () => {
    expect(makePackInstallHandlers(undefined)).toBeUndefined();
  });

  it('returns a slice with packs.install + the install-seam-5c by-slug methods when deps are wired', () => {
    const slice = makePackInstallHandlers({
      recipeStore,
    });
    expect(slice).toBeDefined();
    // Install seam 5c — the by-slug entries join the same forwarded slice;
    // Add-a-pack (a3efa387) added the `packs.resolveBySlug` manifest-preview method.
    expect(slice?.methods).toEqual([
      'packs.install',
      'packs.installBySlug',
      'packs.resolveBySlug',
      'recipe.installBySlug',
    ]);
    expect(typeof slice?.handlers['packs.install']).toBe('function');
    expect(typeof slice?.handlers['packs.installBySlug']).toBe('function');
    expect(typeof slice?.handlers['packs.resolveBySlug']).toBe('function');
    expect(typeof slice?.handlers['recipe.installBySlug']).toBe('function');
  });
});

// ────────────────────────────────────────────────────────────────
// Handler — happy path + permission auto-grant + SI persistence
// ────────────────────────────────────────────────────────────────

describe('handlePacksInstall — happy path', () => {
  it('installs every bundled recipe', async () => {
    const manifest = baseManifest({
      recipes: [
        { slug: 'alpha-recipe', version: 1 },
        { slug: 'beta-recipe', version: 1 },
      ],
    });

    const { result } = await handlePacksInstall(
      { recipeStore },
      { manifest, granted_permissions: [BULK_PACK_INSTALL_PERMISSION] },
    );

    expect(result.ok).toBe(true);
    expect(result.installed).toHaveLength(2);
    expect(result.installed.map((e) => e.slug).sort()).toEqual(['alpha-recipe', 'beta-recipe']);
    expect(recipeStore.listStored().map((r) => r.recipe_id).sort()).toEqual([
      'alpha-recipe',
      'beta-recipe',
    ]);
  });

  it('applies the audience checklist to a recipe-only pack', async () => {
    const now = 1_700_000_000_000;
    const contractStore = createContractStore(db, { now: () => now });
    contractStore.seedSchema(D165_CONTRACT_SCHEMA);
    const definitionStore = createContractDefinitionStore(contractStore, {
      now: () => now,
      newId: () => 'ct_recipe_customer',
    });
    const customerId = definitionStore.mint({
      minted_by: 'user:1',
      display_name: 'Recipe customer',
      scope: { channels: ['mcp'], actors: ['contracted_user'] },
    }).contract_id;
    const definition = definitionStore.get(customerId);
    if (definition === null) throw new Error('missing recipe customer fixture');
    contractStore.put(CONTRACT_DEFINITION_SCOPE, [customerId], {
      ...definition,
      grant_kind: 'customer_instance',
    });
    const grantEntryStore = createContractGrantEntryStore(contractStore);
    grantEntryStore.set(customerId, 'core.existing', true, now);
    const inboundTokenStore = createChatInboundTokenStore(db);
    const issued = inboundTokenStore.issueToken({
      value: {
        label: 'Recipe customer token',
        peer_handle: 'customer:recipe',
        grants: { 'core.existing': true },
        concurrency_tier: 3,
        chat_mode: null,
        contract_id: customerId,
      },
      now,
    });

    const { result } = await handlePacksInstall(
      {
        recipeStore,
        contractStore,
        inboundTokenStore,
        sellerStore: {
          listCustomers: () => [{
            contract_id: customerId,
            tier_id: 'tier-pro',
            inbound_token_id: issued.record.token_id,
            mcp_token_id: issued.record.token_id,
          }],
        },
        now: () => now,
      },
      {
        manifest: baseManifest(),
        granted_permissions: [BULK_PACK_INSTALL_PERMISSION],
        install_scope: {
          access: 'read',
          audience: {
            owner: false,
            all_customers: true,
            all_other_contracts: false,
          },
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(grantEntryStore.listForContract(customerId)).toEqual([
      {
        entry_key: 'core.existing',
        granted: true,
        set_at: now,
      },
      {
        entry_key: 'recued-core/alpha-recipe',
        granted: true,
        set_at: now,
        source_pack: PACK_SLUG,
      },
    ]);
    expect(inboundTokenStore.getTokenById(issued.record.token_id)?.grants).toEqual({
      'core.existing': true,
      'recued-core/alpha-recipe': true,
    });
    expect(grantEntryStore.listForContract(OWNER_CONTRACT_ID)).toEqual([
      {
        entry_key: 'recued-core/alpha-recipe',
        granted: false,
        set_at: now,
        source_pack: PACK_SLUG,
      },
    ]);

    const reinstalled = await handlePacksInstall(
      {
        recipeStore,
        contractStore,
        inboundTokenStore,
        sellerStore: {
          listCustomers: () => [{
            contract_id: customerId,
            tier_id: 'tier-pro',
            inbound_token_id: issued.record.token_id,
            mcp_token_id: issued.record.token_id,
          }],
        },
        now: () => now + 1,
      },
      {
        manifest: baseManifest(),
        granted_permissions: [BULK_PACK_INSTALL_PERMISSION],
        install_scope: {
          access: 'read',
          audience: {
            owner: true,
            all_customers: false,
            all_other_contracts: false,
          },
        },
      },
    );
    expect(reinstalled.result.ok).toBe(true);
    expect(grantEntryStore.listForContract(customerId)).toEqual([{
      entry_key: 'core.existing',
      granted: true,
      set_at: now,
    }]);
    expect(inboundTokenStore.getTokenById(issued.record.token_id)?.grants).toEqual({
      'core.existing': true,
    });
    expect(grantEntryStore.listForContract(OWNER_CONTRACT_ID)).toEqual([]);
  });

  it('auto-adds BULK_PACK_INSTALL_PERMISSION (caller omits it; install still succeeds)', async () => {
    const manifest = baseManifest({
      requires: [BULK_PACK_INSTALL_PERMISSION, 'read_memory'],
    });

    const { result } = await handlePacksInstall(
      { recipeStore },
      {
        manifest,
        // Caller passes only the user-visible permission, omits the
        // substrate-level `BULK_PACK_INSTALL_PERMISSION`.
        granted_permissions: ['read_memory'],
      },
    );

    expect(result.ok).toBe(true);
    expect(recipeStore.listStored()).toHaveLength(1);
  });

  it('installs bundled recipes from manifest_version 2 app-pack contents and returns deferred_contents', async () => {
    const manifest = baseManifest({
      manifest_version: 2,
      artifact_type: 'pack',
      pack_kind: 'app_pack',
      recipes: [],
      contents: [
        { type: 'recipe', slug: 'alpha-recipe', version: 1 },
        ...appContents,
      ],
    });

    const { result } = await handlePacksInstall(
      { recipeStore },
      { manifest, granted_permissions: [BULK_PACK_INSTALL_PERMISSION] },
    );

    expect(result.ok).toBe(true);
    expect(result.installed.map((e) => e.slug)).toEqual(['alpha-recipe']);
    expect(recipeStore.listStored().map((r) => r.recipe_id)).toEqual(['alpha-recipe']);
    expect(result.deferred_contents).toEqual(appContents);
  });

  it('installs bundled dependency packs first and keeps dependency recipe ownership', async () => {
    const dependency = baseManifest({
      slug: 'dependency-pack',
      recipes: [{ slug: 'beta-recipe', version: 1 }],
    });
    writeFileSync(join(dir, 'dependency-pack.json'), JSON.stringify(dependency));
    const manifest = baseManifest({
      slug: 'root-pack',
      recipes: [
        { slug: 'alpha-recipe', version: 1 },
        // The starter-style root lists the workflow recipe too, but the dependency
        // should keep ownership once it has installed it.
        { slug: 'beta-recipe', version: 1 },
      ],
      dependencies: [{ type: 'pack', slug: 'dependency-pack', min_version: 1 }],
    });

    const { result } = await handlePacksInstall(
      { recipeStore, packDir: dir },
      { manifest, granted_permissions: [BULK_PACK_INSTALL_PERMISSION] },
    );

    expect(result.ok).toBe(true);
    expect(result.installed.map((e) => e.slug).sort()).toEqual([
      'alpha-recipe',
      'beta-recipe',
    ]);
    expect(recipeStore.getStored('alpha-recipe')?.pack_slug).toBe('root-pack');
    expect(recipeStore.getStored('beta-recipe')?.pack_slug).toBe('dependency-pack');
    expect(recipeStore.listForPack('root-pack')).toEqual(['alpha-recipe']);
    expect(recipeStore.listForPack('dependency-pack')).toEqual(['beta-recipe']);
  });

  it('does not return deferred_contents for manifest_version 1 manifests', async () => {
    const manifest = baseManifest({
      contents: appContents,
    });

    const { result } = await handlePacksInstall(
      { recipeStore },
      { manifest, granted_permissions: [BULK_PACK_INSTALL_PERMISSION] },
    );

    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty('deferred_contents');
  });
});

// ────────────────────────────────────────────────────────────────
// Handler — bad_request on arg-shape + manifest-validator failures
// ────────────────────────────────────────────────────────────────

describe('handlePacksInstall — bad_request on input issues', () => {
  it('throws bad_request when args is null', async () => {
    await expect(
      handlePacksInstall(
        { recipeStore },
        null as unknown as Parameters<typeof handlePacksInstall>[1],
      ),
    ).rejects.toThrow(RpcError);
  });

  it('throws bad_request when granted_permissions is not an array', async () => {
    await expect(
      handlePacksInstall(
        { recipeStore },
        {
          manifest: baseManifest(),
          granted_permissions: 'not-an-array' as unknown as ReadonlyArray<string>,
        },
      ),
    ).rejects.toThrow(/granted_permissions must be an array of strings/);
  });

  it('throws bad_request when granted_permissions contains a non-string', async () => {
    await expect(
      handlePacksInstall(
        { recipeStore },
        {
          manifest: baseManifest(),
          granted_permissions: [42 as unknown as string],
        },
      ),
    ).rejects.toThrow(/granted_permissions must be an array of strings/);
  });

  it('throws bad_request when manifest fails the parser', async () => {
    await expect(
      handlePacksInstall(
        { recipeStore },
        {
          manifest: { not_a_manifest: true },
          granted_permissions: [BULK_PACK_INSTALL_PERMISSION],
        },
      ),
    ).rejects.toThrow(/invalid manifest/);
  });

  it('formats the parser error with the failing path when present', async () => {
    let captured: RpcError | undefined;
    try {
      await handlePacksInstall(
        { recipeStore },
        {
          manifest: baseManifest({ slug: 'INVALID_SLUG' }),
          granted_permissions: [BULK_PACK_INSTALL_PERMISSION],
        },
      );
    } catch (err) {
      captured = err as RpcError;
    }
    expect(captured).toBeInstanceOf(RpcError);
    expect(captured?.code).toBe('bad_request');
    expect(captured?.message).toMatch(/slug/);
  });
});

// ────────────────────────────────────────────────────────────────
// Handler — engine ok=false paths return on the result body
// ────────────────────────────────────────────────────────────────

describe('handlePacksInstall — engine ok=false outcomes', () => {
  it('returns unresolved when a manifest slug is not bundled', async () => {
    const manifest = baseManifest({
      recipes: [
        { slug: 'alpha-recipe', version: 1 },
        { slug: 'never-bundled', version: 1 },
      ],
    });

    const { result } = await handlePacksInstall(
      { recipeStore },
      { manifest, granted_permissions: [BULK_PACK_INSTALL_PERMISSION] },
    );

    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe('unresolved');
    // Nothing should have been installed.
    expect(recipeStore.listStored()).toHaveLength(0);
  });

  it('returns permission_denied when a manifest-required permission is missing', async () => {
    const manifest = baseManifest({
      requires: [BULK_PACK_INSTALL_PERMISSION, 'read_memory'],
    });

    const { result } = await handlePacksInstall(
      { recipeStore },
      // Caller omits `read_memory` → engine rejects.
      { manifest, granted_permissions: [] },
    );

    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe('permission_denied');
    expect(recipeStore.listStored()).toHaveLength(0);
  });

  it('returns unresolved before installing anything when a dependency pack is missing', async () => {
    const manifest = baseManifest({
      recipes: [{ slug: 'alpha-recipe', version: 1 }],
      dependencies: [{ type: 'pack', slug: 'missing-dependency-pack', min_version: 1 }],
    });

    const { result } = await handlePacksInstall(
      { recipeStore, packDir: dir },
      { manifest, granted_permissions: [BULK_PACK_INSTALL_PERMISSION] },
    );

    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe('unresolved');
    expect(result.failure?.message).toContain('missing-dependency-pack');
    expect(recipeStore.listStored()).toHaveLength(0);
  });

  it('returns permission_denied before installing dependencies when transitive permissions are missing', async () => {
    const dependency = baseManifest({
      manifest_version: 2,
      slug: 'dependency-pack',
      recipes: [{ slug: 'beta-recipe', version: 1 }],
      requires: [BULK_PACK_INSTALL_PERMISSION, 'read_memory'],
      contents: [{ type: 'recipe', slug: 'beta-recipe', version: 1 }],
    });
    writeFileSync(join(dir, 'dependency-pack.json'), JSON.stringify(dependency));
    const manifest = baseManifest({
      manifest_version: 2,
      recipes: [{ slug: 'alpha-recipe', version: 1 }],
      contents: [{ type: 'recipe', slug: 'alpha-recipe', version: 1 }],
      dependencies: [{ type: 'pack', slug: 'dependency-pack', min_version: 1 }],
    });

    const { result } = await handlePacksInstall(
      { recipeStore, packDir: dir },
      { manifest, granted_permissions: [BULK_PACK_INSTALL_PERMISSION] },
    );

    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe('permission_denied');
    expect(result.failure?.message).toContain('read_memory');
    expect(recipeStore.listStored()).toHaveLength(0);
  });

  it('D-201 scopes owner webhook choices to each successful dependency install', async () => {
    const webhookRequirement: PackWebhookRequirement = {
      binding: 'generic_delivery',
      profile_ids: ['generic.static-header-token.v1'],
      required_event_types: ['delivery'],
      registration_modes: ['manual'],
      environment_policy: 'test_only',
      decoded_payload_access: 'metadata_only',
      source_truth_policy: 'delivery_payload_allowed',
    };
    const dependency = baseManifest({
      manifest_version: 2,
      slug: 'dependency-pack',
      recipes: [{ slug: 'beta-recipe', version: 1 }],
      contents: [{ type: 'recipe', slug: 'beta-recipe', version: 1 }],
      webhook_requirements: [webhookRequirement],
    });
    writeFileSync(join(dir, 'dependency-pack.json'), JSON.stringify(dependency));
    const manifest = baseManifest({
      manifest_version: 2,
      slug: 'root-pack',
      recipes: [{ slug: 'alpha-recipe', version: 1 }],
      contents: [{ type: 'recipe', slug: 'alpha-recipe', version: 1 }],
      dependencies: [{ type: 'pack', slug: 'dependency-pack', min_version: 1 }],
      webhook_requirements: [webhookRequirement],
    });
    const applied: Array<{ consumer_id: string; ingress_ids: string[] }> = [];
    let finalized = 0;
    const webhookConsumerStore = {
      replaceConsumer(input: ReplaceWebhookConsumerInput) {
        applied.push({
          consumer_id: input.consumer_id,
          ingress_ids: input.selections.map((selection) => selection.ingress_id),
        });
        return {
          consumer_kind: input.consumer_kind,
          consumer_id: input.consumer_id,
          bindings: [],
          triggers: [],
        };
      },
      finalizeConsumerReplacement() {
        finalized += 1;
      },
    } as unknown as WebhookConsumerStore;

    const { result } = await handlePacksInstall(
      { recipeStore, packDir: dir, webhookConsumerStore },
      {
        manifest,
        granted_permissions: [BULK_PACK_INSTALL_PERMISSION],
        webhook_bindings: [
          {
            pack_slug: 'dependency-pack',
            binding: 'generic_delivery',
            ingress_id: 'whi_dependency',
          },
          {
            pack_slug: 'root-pack',
            binding: 'generic_delivery',
            ingress_id: 'whi_root',
          },
        ],
      },
    );

    expect(result.ok).toBe(true);
    expect(applied).toEqual([
      { consumer_id: 'dependency-pack', ingress_ids: ['whi_dependency'] },
      { consumer_id: 'root-pack', ingress_ids: ['whi_root'] },
    ]);
    expect(finalized).toBe(2);
  });

  it('D-201 rejects an ingress selection for a pack outside the dependency closure', async () => {
    const { result } = await handlePacksInstall(
      { recipeStore, packDir: dir },
      {
        manifest: baseManifest(),
        granted_permissions: [BULK_PACK_INSTALL_PERMISSION],
        webhook_bindings: [{
          pack_slug: 'not-installed-by-this-request',
          binding: 'billing_events',
          ingress_id: 'whi_untrusted_extra',
        }],
      },
    );

    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe('validator_rejected');
    expect(result.failure?.message).toContain('unknown pack');
    expect(recipeStore.listStored()).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────
// Handler — bundled-only resolution scope (security ratchet)
// ────────────────────────────────────────────────────────────────

describe('handlePacksInstall — resolution scope', () => {
  it('resolves through getBundled, NOT get (already-stored-only slug surfaces as unresolved)', async () => {
    // Seed a recipe into the SQLite-backed store but NOT the bundled
    // directory. `recipeStore.get()` would find it; `getBundled()`
    // would not. The handler uses `getBundled()` so the engine treats
    // this slug as not-found, preventing a user-imported manifest from
    // overwriting an already-installed recipe's publisher_id.
    const storedOnlyRecipe = recipeDef('stored-only-recipe');
    recipeStore.save(storedOnlyRecipe, 'recued-core', 'pair-sync', Date.now());
    expect(recipeStore.get('stored-only-recipe')).not.toBeNull();
    expect(recipeStore.getBundled('stored-only-recipe')).toBeNull();

    const manifest = baseManifest({
      recipes: [{ slug: 'stored-only-recipe', version: 1 }],
    });

    const { result } = await handlePacksInstall(
      { recipeStore },
      { manifest, granted_permissions: [BULK_PACK_INSTALL_PERMISSION] },
    );

    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe('unresolved');
  });
});

// ────────────────────────────────────────────────────────────────
// D-145 PA10 follow-on (pack-install-registry) — pack_slug stamping
// on the install path. Pairs with the uninstall-side assertions in
// `d-145-pa10-pack-uninstall-rpc.test.ts` so the round-trip is
// covered end-to-end.
// ────────────────────────────────────────────────────────────────

describe('handlePacksInstall — pack_slug provenance stamping', () => {
  it('stamps the manifest slug on every freshly-installed recipe row', async () => {
    const manifest = baseManifest({
      recipes: [
        { slug: 'alpha-recipe', version: 1 },
        { slug: 'beta-recipe', version: 1 },
      ],
    });
    const { result } = await handlePacksInstall(
      { recipeStore },
      { manifest, granted_permissions: [BULK_PACK_INSTALL_PERMISSION] },
    );
    expect(result.ok).toBe(true);
    expect(recipeStore.getStored('alpha-recipe')?.pack_slug).toBe(PACK_SLUG);
    expect(recipeStore.getStored('beta-recipe')?.pack_slug).toBe(PACK_SLUG);
    // `listForPack(slug)` should round-trip the same two ids
    // alphabetical — pairs with the uninstall flow.
    expect(recipeStore.listForPack(PACK_SLUG)).toEqual([
      'alpha-recipe',
      'beta-recipe',
    ]);
  });

  it('claims ownership when a pre-existing manual row is overwritten by a pack install', async () => {
    // User saves `alpha-recipe` manually (pack_slug = NULL) — same
    // pattern as the mcp-server.ts third-party recipe-upload path.
    // Then a pack ships the same slug + installs. The upsert path
    // replaces both the content AND the pack_slug column → ownership
    // transfers to the pack.
    recipeStore.save(recipeDef('alpha-recipe'), 'manual', 'pair-sync', 100);
    expect(recipeStore.getStored('alpha-recipe')?.pack_slug).toBeNull();

    const manifest = baseManifest({
      recipes: [{ slug: 'alpha-recipe', version: 1 }],
    });
    const { result } = await handlePacksInstall(
      { recipeStore },
      { manifest, granted_permissions: [BULK_PACK_INSTALL_PERMISSION] },
    );
    expect(result.ok).toBe(true);
    expect(recipeStore.getStored('alpha-recipe')?.pack_slug).toBe(PACK_SLUG);
  });

  it('transfers ownership when a second pack re-installs an already pack-owned recipe', async () => {
    // Pack A installs `alpha-recipe`. A second pack with a different
    // slug (but the same recipe slug in its manifest) installs over
    // it. Ownership flips to pack B because the wrapper stamps the
    // current install's slug on the upsert.
    const packA = baseManifest({
      slug: 'pack-installer-a',
      recipes: [{ slug: 'alpha-recipe', version: 1 }],
    });
    const packB = baseManifest({
      slug: 'pack-installer-b',
      recipes: [{ slug: 'alpha-recipe', version: 1 }],
    });

    const a = await handlePacksInstall(
      { recipeStore },
      { manifest: packA, granted_permissions: [BULK_PACK_INSTALL_PERMISSION] },
    );
    expect(a.result.ok).toBe(true);
    expect(recipeStore.getStored('alpha-recipe')?.pack_slug).toBe(
      'pack-installer-a',
    );

    const b = await handlePacksInstall(
      { recipeStore },
      { manifest: packB, granted_permissions: [BULK_PACK_INSTALL_PERMISSION] },
    );
    expect(b.result.ok).toBe(true);
    // Ownership transferred.
    expect(recipeStore.getStored('alpha-recipe')?.pack_slug).toBe(
      'pack-installer-b',
    );
    // listForPack lookup is symmetric — pack-a now owns nothing.
    expect(recipeStore.listForPack('pack-installer-a')).toEqual([]);
    expect(recipeStore.listForPack('pack-installer-b')).toEqual([
      'alpha-recipe',
    ]);
  });
});
