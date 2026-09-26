/** D-294 — what an update carries over: the choices an install made, read
 *  back so the update dialog STARTS at them rather than at a fresh install's
 *  defaults. (The Access tier is `currentPackAccess`, D-293.)
 *
 *  ── Who may use it: who a pack is shared with NOW, read back from its install
 *  fan-out rows, so an update's "Who may use it" choice STARTS there.
 *
 *  ⛔ AN UPDATE REPLACES THE PACK'S SHARE, AND THE DIALOG STARTED AT "ONLY YOU".
 *  The fan-out (`applyInstallAudienceGrantIds`) clears every row it stamped with
 *  this pack and writes the dialog's audience afresh, so pressing Update on a
 *  pack shared with customers or other agreements withdrew it from all of them.
 *
 *  The owner's choice itself is stored nowhere — only its expansion into rows
 *  (`contract_grant`, stamped `source_pack`), one per (agreement, operation). So
 *  this reads the rows back and answers with the selection that, re-applied NOW,
 *  reaches exactly the same live agreements:
 *   - "All customers" / "Everyone else you have an agreement with" only when
 *     EVERY live agreement of that kind has the pack — never because the owner
 *     once ticked it. A customer added since the install never got the pack
 *     ("anyone added later starts with nothing until you share again"), and
 *     re-ticking the box would hand it over without anyone deciding to;
 *   - a customer package (tier) only when every live customer in it has it;
 *   - every other agreement that has it, one by one (`contract_ids`).
 *  "You" is unticked only when the pack pinned owner revokes (the fan-out's
 *  customer-only form).
 *
 *  Rows the owner set one operation at a time (unstamped) are not a pack-level
 *  share and are not read here; the fan-out leaves them alone
 *  (`setForSourcePack`), so they survive the update as they are. */

import { OWNER_CONTRACT_ID, type InstallAccessTier, type InstallAudienceSelection } from '@recued/contracts';

import { gateGrantGoverningContractId } from './grant-governing-contract.js';
import {
  customerTierByContractForInstallAudience,
  type SellerInstallAudienceStore,
} from './ingredient-authoring/install-composition.js';
import { createConnectionCatalogBindingStore } from './storage/connection-catalog-binding-store.js';
import { createContractDefinitionStore } from './storage/contract-definition-store.js';
import type { ContractStore } from './storage/contract-store.js';
import type { LocalManifestStore } from './ingredient-authoring/local-manifest-store.js';
import { getInstalledPack } from './pack-inventory.js';
import { currentPackAccess, installedCompositionCatalogs } from './pack-operation-update-diff.js';

export const currentPackAudience = (input: {
  contractStore: ContractStore;
  sellerStore?: SellerInstallAudienceStore;
  /** The id the fan-out stamps: the pack slug, or a Records pack's catalog id. */
  sourcePack: string;
  now: () => number;
}): InstallAudienceSelection => {
  let owner = true;
  const shared = new Set<string>();
  for (const row of input.contractStore.scan('contract_grant', [])) {
    if (row.segments.length !== 2) continue;
    const value = row.value as { granted?: unknown; source_pack?: unknown } | null;
    if (value?.source_pack !== input.sourcePack) continue;
    const contractId = row.segments[0]!;
    if (contractId === OWNER_CONTRACT_ID) {
      if (value.granted === false) owner = false;
      continue;
    }
    if (value.granted === true) shared.add(contractId);
  }
  if (shared.size === 0) return { owner, all_customers: false, all_other_contracts: false };

  const definitions = createContractDefinitionStore(input.contractStore);
  const live = definitions.list().filter((def) =>
    gateGrantGoverningContractId(def.contract_id, definitions, input.now) !== undefined);
  const customers = live.filter((def) => def.grant_kind === 'customer_instance').map((def) => def.contract_id);
  const others = live.filter((def) => def.grant_kind !== 'customer_instance').map((def) => def.contract_id);
  const covered = new Set<string>();

  const allCustomers = customers.length > 0 && customers.every((id) => shared.has(id));
  if (allCustomers) for (const id of customers) covered.add(id);
  const tierIds: string[] = [];
  if (!allCustomers) {
    const tierOf = customerTierByContractForInstallAudience(input.sellerStore?.listCustomers() ?? []);
    const members = new Map<string, string[]>();
    for (const id of customers) {
      const tier = tierOf.get(id);
      if (tier !== undefined) members.set(tier, [...(members.get(tier) ?? []), id]);
    }
    for (const [tier, ids] of [...members].sort(([a], [b]) => a.localeCompare(b))) {
      if (!ids.every((id) => shared.has(id))) continue;
      tierIds.push(tier);
      for (const id of ids) covered.add(id);
    }
  }
  const allOthers = others.length > 0 && others.every((id) => shared.has(id));
  if (allOthers) for (const id of others) covered.add(id);

  const liveIds = new Set(live.map((def) => def.contract_id));
  const oneByOne = [...shared].filter((id) => liveIds.has(id) && !covered.has(id)).sort();
  return {
    owner,
    all_customers: allCustomers,
    all_other_contracts: allOthers,
    ...(tierIds.length > 0 ? { customer_tier_ids: tierIds } : {}),
    ...(oneByOne.length > 0 ? { contract_ids: oneByOne } : {}),
  };
};

/** The account a composition pack is bound to NOW — where an update's Connect
 *  choice STARTS.
 *
 *  ⛔ THE UPDATE DIALOG PROPOSED THE FIRST MATCHING ACCOUNT BY NAME, not the one
 *  the pack uses, and an update re-binds (`writeConnectionBinding` drops the
 *  pack's binding and binds the dialog's pick): an owner with two accounts of
 *  one vendor was silently moved to the other, and one whose pick another pack
 *  already held was left UNBOUND.
 *
 *  `undefined` when the pack binds no connection, or more than one: the dialog
 *  picks ONE connection, and guessing which binding it means would be exactly
 *  the silent move this exists to stop. */
export const currentPackConnection = (
  contractStore: ContractStore,
  packSlug: string,
): string | undefined => {
  const bound = new Set(
    createConnectionCatalogBindingStore(contractStore).list()
      .filter((binding) => binding.installed_pack_id === packSlug)
      .map((binding) => binding.connection_name),
  );
  return bound.size === 1 ? [...bound][0] : undefined;
};

/** D-294 — where a generated MCP pack's RE-review starts: the Access it holds now and who may
 *  use it now, read back the way `packs.list` reads any other pack's. `null` when the pack is
 *  not installed yet, so a first review starts at the install defaults.
 *
 *  ⛔ The re-review opened at those defaults every time (Read, only you) and committed them
 *  as an explicit choice, which D-294's carry-over never overrides: re-reviewing a pack the
 *  owner had shared, at Read + write, withdrew the share and narrowed the Access (2026-09-24
 *  audit). A generated pack authors no default grants (every group starts off), so every
 *  group it holds is the owner's choice. */
export const currentGeneratedPackChoices = (input: {
  contractStore: ContractStore;
  localManifestStore: Pick<LocalManifestStore, 'getManifest'>;
  sellerStore?: SellerInstallAudienceStore;
  packSlug: string;
  now: () => number;
}): { access?: InstallAccessTier; audience: InstallAudienceSelection } | null => {
  if (getInstalledPack(input.contractStore, input.packSlug) === null) return null;
  const access = currentPackAccess({
    store: input.contractStore,
    installedPackId: input.packSlug,
    catalogs: installedCompositionCatalogs(input.contractStore, input.localManifestStore, input.packSlug),
    defaults: new Set(),
  });
  const audience = currentPackAudience({
    contractStore: input.contractStore,
    ...(input.sellerStore !== undefined ? { sellerStore: input.sellerStore } : {}),
    sourcePack: input.packSlug,
    now: input.now,
  });
  return { ...(access !== undefined ? { access } : {}), audience };
};
