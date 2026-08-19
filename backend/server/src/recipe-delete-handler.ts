/** D-247 D14.1 — `recipe.delete`, the owner's gesture for removing an unwanted
 *  recipe, and the pack-ownership refusal that makes it safe.
 *
 *  ## Why a pack-owned recipe is refused
 *
 *  A pack has to function as a WHOLE UNIT. D-122 ships one Layer-2 visible alert
 *  plus N Layer-1 silent producers; deleting a producer breaks the alert with no
 *  signal. And the mechanical argument agrees and is stronger: `packs.install`
 *  over an already-installed pack re-resolves and re-saves EVERY ref in the
 *  manifest, so a per-recipe delete would be silently UNDONE by the next pack
 *  update. A control that does not durably do what the owner asked is worse than
 *  an absent one. `packs.uninstall` is the honest gesture and already exists.
 *
 *  ⇒ One rule, both sides: a pack-owned row is the pack's to change. A save may
 *  not strip its ownership (D6, guarded in `recipe-store.ts`); a delete may not
 *  remove it (here).
 *
 *  ## ⛔⛔ THE QUALIFIER IS THE WHOLE RULING: "AND THAT PACK IS INSTALLED"
 *
 *  This refusal fails CLOSED, and a wrong refusal leaves a recipe PERMANENTLY
 *  UNDELETABLE — there is no second path, because you cannot uninstall a pack
 *  that is not installed. The inventory is known to drift (`pack-inventory.ts`
 *  records an `installed_pack` row still listing content that has moved on). So a
 *  `pack_slug` naming a pack with no `contract.installed_pack.<slug>` row is an
 *  ORPHAN, and deleting it is the only remedy the owner has.
 *
 *  ⚠ Test the ESCAPE, not only the refusal: a guard keyed on `pack_slug` alone
 *  passes every test anyone would naturally write and strands the one case that
 *  matters.
 *
 *  ## Four outcomes, never a boolean
 *
 *  `RecipeStore.delete` returns `result.changes > 0`, which for a BUNDLED recipe
 *  is a silent `false` while the recipe keeps resolving from the bundle.
 *  "Returned false" reading as "fine, nothing to delete" is how this ships
 *  broken, so `bundled` and `pack_owned` are distinct reasons the caller can act
 *  on differently. */

import type { HandlerSlice, ServerRpcRegistry } from '@recued/contracts';

import type { ContractStore } from './storage/contract-store.js';
import { getInstalledPack } from './pack-inventory.js';
import type { RecipeStore } from './recipe-store.js';
import type { WebhookConsumerStore } from './storage/webhook-consumer-store.js';
import type { WsClient } from './ws-server.js';

export type RecipeDeleteMethods = 'recipe.delete';

export interface RecipeDeleteHandlerDeps {
  store: RecipeStore;
  /** The `contract.*` store holding `installed_pack` rows. ⚠ ABSENT ⇒ every
   *  pack-owned recipe is refused, which is the fail-CLOSED direction and is
   *  correct for a partial harness: refusing a delete costs the owner a retry,
   *  while admitting one on a pack whose installed-ness could not be checked
   *  breaks a pack silently. */
  contractStore?: ContractStore;
  /** D14.1 — a delete is the uninstall teardown for ONE recipe. Without this the
   *  webhook consumer stays bound to a recipe that no longer exists — the same
   *  orphan class D-247 is about. */
  webhookConsumerStore?: WebhookConsumerStore;
}

export type RecipeDeleteResult =
  | { deleted: true }
  | { deleted: false; reason: 'not_found' }
  | { deleted: false; reason: 'bundled' }
  | { deleted: false; reason: 'pack_owned'; pack_slug: string };

export const deleteRecipe = (
  deps: RecipeDeleteHandlerDeps,
  recipe_id: string,
): RecipeDeleteResult => {
  // Resolve BOTH views before deciding: `getStored` is the SQLite row (null for a
  // bundled recipe), `get` is the resolved definition (non-null for bundled). The
  // pair is what separates "not here at all" from "here but not deletable".
  const stored = typeof deps.store.getStored === 'function'
    ? deps.store.getStored(recipe_id)
    : null;
  const resolved = deps.store.get(recipe_id);
  if (stored === null) {
    // No row. Either the recipe does not exist, or it is BUNDLED — and those are
    // different answers. A bare `delete` would return false for both.
    return resolved === null
      ? { deleted: false, reason: 'not_found' }
      : { deleted: false, reason: 'bundled' };
  }
  // ⛔⛔ A STORED ROW SHADOWING A BUNDLED RECIPE IS NOT DELETABLE EITHER, AND
  // REPORTING SUCCESS FOR IT IS THE WORSE FAILURE. Dropping the row leaves
  // `store.get` resolving the BUNDLED copy, so the recipe stays reachable while
  // the caller was told it was deleted — and no further call can remove it,
  // because the next attempt sees no row and answers `bundled` anyway. Same
  // principle as the pack refusal below: a control that does not durably do what
  // the owner asked is worse than an absent one. Codex review finding 6.
  if (typeof deps.store.getBundled === 'function' && deps.store.getBundled(recipe_id) !== null) {
    return { deleted: false, reason: 'bundled' };
  }

  const packSlug = stored.pack_slug;
  if (packSlug != null && packSlug.length > 0) {
    // ⛔ THE ESCAPE. Refuse ONLY while the owning pack is actually installed;
    // otherwise this row is an orphan and refusing strands it forever.
    const installed = deps.contractStore === undefined
      ? true // fail-closed when we cannot check — see the dep's doc
      : getInstalledPack(deps.contractStore, packSlug) !== null;
    if (installed) return { deleted: false, reason: 'pack_owned', pack_slug: packSlug };
  }

  // The teardown BEFORE the row drop, so a throw leaves the recipe present rather
  // than leaving a live recipe with its webhook authority already revoked.
  if (deps.webhookConsumerStore) {
    deps.webhookConsumerStore.replaceConsumer({
      consumer_kind: 'local_recipe',
      consumer_id: recipe_id,
      requirements: [],
      selections: [],
      recipes: [],
      enabled: false,
    });
  }

  // `delete` fires the store's mutation hook, which is where D8's seed branches to
  // PURGE the recipe's grant row (D14) — so the grant cannot outlive its subject.
  const removed = deps.store.delete(recipe_id);
  return removed ? { deleted: true } : { deleted: false, reason: 'not_found' };
};

export const makeRecipeDeleteHandlers = (
  deps: RecipeDeleteHandlerDeps | undefined,
): HandlerSlice<ServerRpcRegistry, RecipeDeleteMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['recipe.delete'],
    handlers: {
      'recipe.delete': async (req) => deleteRecipe(deps, req.recipe_id),
    },
  };
};
