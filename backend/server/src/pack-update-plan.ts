/** Shared immutable plan identity and the synchronous content-only writer.
 * Resolution and qualification happen before the realm transaction. */
import { RpcError, mailTemplateStarters, type BulkPackManifest } from '@recued/contracts';
import type { BulkPackInstallRecipe } from '@recued/marketplace';
import type { PackInstallRpcDeps } from './pack-install-handler.js';
import type { ContractStore } from './storage/contract-store.js';
import { recipeReleaseDigest as digest } from './storage/recipe-release-authority.js';
import { assertRecipeAuthoringGates } from './recipe-save-handler.js';
import { seedPackRecipeGrants } from './recipe-grant-seed.js';
import { assertPackUpdatePermit } from './storage/pack-update-authority.js';
import { afterLocalCommit } from './local-transaction.js';
import { hasNonEmptyWebhookDeclarations } from './webhook-declaration-gate.js';
import { capturePackDependencies } from './pack-dependencies.js';

export interface PreparedPackUpdateMember {
  source: 'bundled' | 'marketplace'; manifest: BulkPackManifest; recipes: BulkPackInstallRecipe[];
}
export interface PreparedPackUpdate extends PreparedPackUpdateMember {
  /** Unique changed dependencies, in write order; the root is last. */
  dependencies?: PreparedPackUpdateMember[];
  requirements?: Array<{ pack_slug: string; inventory_digest: string }>;
}
export const packUpdateMembers = (target: PreparedPackUpdate): PreparedPackUpdateMember[] => [...target.dependencies ?? [],target];
export const packUpdateRecipes = (target: PreparedPackUpdate): BulkPackInstallRecipe[] => packUpdateMembers(target).flatMap(pack => pack.recipes);
export const packUpdateIdentity = (target: PreparedPackUpdate): string => digest({
  packs: packUpdateMembers(target).map(pack => ({ source: pack.source,manifest: pack.manifest,
    recipes: pack.recipes.map(entry => ({ slug: entry.slug,pinned_version: entry.pinned_version,
      publisher: entry.recipe?.publisher_id ?? null,version: entry.recipe?.version ?? null,recipe: entry.recipe?.recipe ?? null,
      resolved_at_run: entry.op_steps_resolved_at_run === true })) })),
  requirements: target.requirements ?? [],
});
const unsupported = (message: string): never => { throw new RpcError('pack_update_unsupported',message,409); };
/** A group changes existing content only. New membership or capability setup
 * continues through each pack's ordinary install/consent workflow. */
export const assertPackUpdateGroup = (target: PreparedPackUpdate, deps: Pick<PackInstallRpcDeps,'recipeStore' | 'contractStore' | 'getReceptionPairs' | 'webhookConsumerStore'>): void => {
  if (!target.dependencies?.length || !deps.contractStore) unsupported('Choose a staged update with required dependency upgrades.');
  const receptionPairs = deps.getReceptionPairs?.();
  for (const pack of packUpdateMembers(target)) {
    const current = deps.contractStore!.get('installed_pack',[pack.manifest.slug]);
    if (!current || !current.value || typeof current.value !== 'object' || Array.isArray(current.value)) unsupported('Install every dependency separately before staging this group.');
    const info = current!.value as Record<string,unknown>;
    if (info.publisher !== pack.manifest.publisher || !Array.isArray(info.ingredient_ids) || info.ingredient_ids.length) unsupported('Grouped updates require installed recipe-only packs from the same publishers.');
    if (pack.manifest.requires.some(permission => permission !== 'install_bulk_pack') || (pack.manifest.mcp_body_visibility_grants?.length ?? 0)) {
      unsupported('A pack needs an additional permission review. Update it separately before staging this group.');
    }
    if (deps.webhookConsumerStore?.listBindings({ consumer_kind: 'pack_install',consumer_id: pack.manifest.slug }).length) {
      unsupported('A pack has installed webhook bindings. Update it separately through its webhook review.');
    }
    const ids = deps.recipeStore.listForPack(pack.manifest.slug).sort(), incoming = pack.recipes.map(entry => entry.slug).sort();
    if (ids.length !== incoming.length || ids.some((id,index) => id !== incoming[index])) unsupported('Grouped updates keep each pack’s recipe membership. Handle added or removed recipes in a separate update first.');
    for (const entry of pack.recipes) {
      const prior = deps.recipeStore.getStored(entry.slug);
      if (!prior || !entry.recipe || prior.pack_slug !== pack.manifest.slug || prior.publisher_id !== entry.recipe.publisher_id) unsupported('A recipe’s publisher or pack ownership changed. Review it separately.');
      const before = deps.recipeStore.get(entry.slug)!;
      if (hasNonEmptyWebhookDeclarations(before) || hasNonEmptyWebhookDeclarations(entry.recipe!.recipe)) {
        unsupported('A recipe needs webhook setup or cleanup. Update its pack separately through its webhook review.');
      }
      if (mailTemplateStarters(before.variables).length || mailTemplateStarters(entry.recipe!.recipe.variables).length) {
        unsupported('A recipe owns mail templates. Update its pack separately to review and synchronize them.');
      }
      if (receptionPairs?.pairs.listByRecipeId(entry.slug).length) {
        unsupported('A recipe backs a Reception pair. Update its pack separately to review and carry its bindings.');
      }
      assertRecipeAuthoringGates({},entry.recipe!.recipe,'packs.update.apply');
    }
  }
};
export const assertPackUpdateRequirements = (target: PreparedPackUpdate, contracts: ContractStore): void => {
  for (const requirement of target.requirements ?? []) if (digest(contracts.get('installed_pack',[requirement.pack_slug])) !== requirement.inventory_digest) {
    throw new RpcError('pack_update_conflict','A dependency changed. Restage and test the complete update again.',409);
  }
};
/** Called only under the store's exact in-process permit and outer transaction. */
export const writePackUpdateGroup = (target: PreparedPackUpdate, deps: PackInstallRpcDeps, permit: object, now: number): void => {
  assertPackUpdatePermit(deps.recipeStore.realmDatabase,permit);
  assertPackUpdateGroup(target,deps);
  if (deps.grantEntryStore && deps.grantEntryStore.realmDatabase !== deps.recipeStore.realmDatabase) {
    throw new RpcError('pack_update_unsupported','Grouped updates require the built-in stores on the same realm.',409);
  }
  for (const pack of packUpdateMembers(target)) {
    if (deps.grantEntryStore) seedPackRecipeGrants({ store: deps.recipeStore,grants: deps.grantEntryStore,now: () => now,
      ...(deps.getManifest ? { getManifest: deps.getManifest } : {}) },pack.recipes.map(entry => entry.recipe!), 'read');
    for (const entry of pack.recipes) deps.recipeStore.save(entry.recipe!.recipe,entry.recipe!.publisher_id,'pair-sync',now,pack.manifest.slug,permit);
    // Preserve the installed pack's access, connection and inventory metadata.
    const prior = deps.contractStore!.get('installed_pack',[pack.manifest.slug])!;
    deps.contractStore!.put('installed_pack',[pack.manifest.slug],{ ...prior.value as Record<string,unknown>,version: String(pack.manifest.version),installed_at: now,
      dependency_snapshot: capturePackDependencies(deps.contractStore!,pack.manifest.dependencies ?? []) });
    if (deps.broadcast) afterLocalCommit(deps.recipeStore.realmDatabase!,() => deps.broadcast!.emit({ kind: 'pack_installed',
      pack_slug: pack.manifest.slug,pack_name: pack.manifest.name,pack_version: pack.manifest.version,installed_recipe_count: pack.recipes.length }));
  }
  if (deps.recipeRunnabilityBroadcast) afterLocalCommit(deps.recipeStore.realmDatabase!,() => deps.recipeRunnabilityBroadcast!.recomputeAndEmit());
};
