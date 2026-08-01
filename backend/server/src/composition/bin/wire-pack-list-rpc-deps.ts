/** D-145 PA10 follow-on — `packs.list` rpc-deps composer.
 *
 *  Builds the `PackListRpcDeps` shape consumed by `packs.list`. Returns
 *  `{ packListDeps: undefined }` when the per-pair `RecipeStore` isn't
 *  composed yet (dbless harnesses + pre-D-103-Phase-A boots) — the
 *  caller drops the conditional spread + the rpc surfaces
 *  `not_configured`.
 *
 *  Mirrors `wire-pack-install-rpc-deps.ts`'s composer shape so the two
 *  `packs.*` rpcs land through the same wiring path in
 *  `composeRpcContext` → `createServerHandlerSet`. The `packDir`
 *  override flows through optionally for test harnesses that point the
 *  rpc at a scratch directory; production callers leave it undefined to
 *  fall back to the project-root bundled location. */

import type { PackListRpcDeps } from '../../pack-list-handler.js';
import type { RecipeStore } from '../../recipe-store.js';
import type { ContractStore } from '../../storage/contract-store.js';
import type { RecordsStore } from '../../records/store.js';

export interface ComposePackListRpcDepsInput {
  /** Per-pair recipe store. Absent → composer returns the
   *  undefined-bundle + caller drops the `packListDeps` spread. */
  recipeStore: RecipeStore | undefined;
  /** Gateway-read-only contract store — the `installed_pack` registry the
   *  `installed` join reads for EMPTY-`recipes[]` packs (Packs-route
   *  delta 1). Same handle threaded into `packs.install` / `packs.uninstall`
   *  so the list sees the rows install writes. Optional: dbless boots leave
   *  it undefined + empty-recipes packs degrade to `installed: false`. */
  contractStore?: ContractStore;
  recordsStore?: RecordsStore;
  /** Override the default community/packs directory. Tests pass a
   *  scratch dir; production callers leave undefined to use the
   *  bundled location. */
  packDir?: string;
}

export interface PackListRpcBundle {
  /** Threaded into `createServerHandlerSet({ packListDeps })`.
   *  Undefined when `recipeStore` is missing → caller drops the
   *  conditional spread. */
  packListDeps: PackListRpcDeps | undefined;
}

export const composePackListRpcDeps = (
  input: ComposePackListRpcDepsInput,
): PackListRpcBundle => {
  const { recipeStore, contractStore, recordsStore, packDir } = input;

  if (!recipeStore) {
    return { packListDeps: undefined };
  }

  const packListDeps: PackListRpcDeps = {
    recipeStore,
    ...(contractStore !== undefined ? { contractStore } : {}),
    ...(recordsStore !== undefined ? { recordsStore } : {}),
    ...(packDir !== undefined ? { packDir } : {}),
  };

  return { packListDeps };
};
