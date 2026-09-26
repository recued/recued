/** What a pack update does to EVERY operation of the pack — the diff the owner
 *  reads before pressing Update.
 *
 *  An owner can set each operation's risk and approval (`OWNER_OPERATION_SCOPE`),
 *  and an update can remove, change or add operations. D-211 Slice 5's review
 *  (`owner-operation-update-review.ts`) shows only the operations the owner set a
 *  rule for, and only as changed or removed; an added operation — a new thing the
 *  pack can do — was shown nowhere. This compares the INSTALLED catalogs with the
 *  INCOMING ones, operation by operation.
 *
 *  ⛔ THERE IS NO RENAME. An operation id has no durable identity across pack
 *  versions, so nothing can tie `abc` to `bcd` — a route that stayed put is a
 *  guess, not an identity. `abc` is REMOVED (the owner's rule for it goes dark:
 *  kept, doing nothing, in case the operation comes back) and `bcd` is ADDED on
 *  the pack's defaults. Pairing them would move a rule onto an operation nobody
 *  reviewed.
 *
 *  Pure over the store and the two manifest maps; the callers decide which
 *  catalogs are "installed" and "incoming" for their kind of pack. */

import {
  OWNER_OPERATION_SCOPE,
  type BulkPackManifest,
  type CompositionIngredient,
  isCatalogForm,
  isOperationApproval,
  isRiskTier,
  normalizeBulkPackInstallPlan,
  operationSpecHash,
  type IngredientManifest,
  type InstallAccessTier,
  type OperationRiskTier,
  type OperationSpec,
  type PackOperationUpdateDiff,
  type PackOperationUpdateDiffItem,
} from '@recued/contracts';
import { isRecordsComposition } from '@recued/ingredient-authoring';

import type { LocalManifestStore } from './ingredient-authoring/local-manifest-store.js';
import { incomingOperationInventory } from './owner-operation-update-review.js';
import { listInstalledPacks, packIngredientIds } from './pack-inventory.js';
import type { ContractStore } from './storage/contract-store.js';

/** Every operation a manifest declares, by operation id. A simple-form
 *  ingredient is its own single operation, keyed by its slug. */
const operationsOf = (manifest: IngredientManifest | undefined): Map<string, OperationSpec> => {
  const out = new Map<string, OperationSpec>();
  if (manifest === undefined) return out;
  if (isCatalogForm(manifest)) {
    for (const operation of Object.values(manifest.operations ?? {})) {
      out.set(operation.operation_id, operation);
    }
    return out;
  }
  out.set(manifest.slug, { operation_id: manifest.slug, risk_tier: manifest.risk_tier } as OperationSpec);
  return out;
};

const facts = (operation: OperationSpec): { risk: OperationSpec['risk_tier']; approval?: NonNullable<OperationSpec['approval']> } => ({
  risk: operation.risk_tier,
  ...(operation.approval !== undefined ? { approval: operation.approval } : {}),
});

const ownerPolicyOf = (
  store: ContractStore,
  ingredientId: string,
  operationId: string,
): PackOperationUpdateDiffItem['owner_policy'] => {
  const row = store.get(OWNER_OPERATION_SCOPE, [ingredientId, operationId]);
  if (row === null) return undefined;
  const value = row.value as Record<string, unknown>;
  const risk = isRiskTier(value.risk) ? value.risk : undefined;
  const approval = isOperationApproval(value.approval) ? value.approval : undefined;
  if (risk === undefined && approval === undefined) return undefined;
  return {
    ...(risk !== undefined ? { risk } : {}),
    ...(approval !== undefined ? { approval } : {}),
  };
};

export const diffPackOperationsForUpdate = (input: {
  store: ContractStore;
  /** The catalogs the owner has now, keyed by ingredient id. */
  installed: ReadonlyMap<string, IngredientManifest>;
  /** The catalogs the update would install, keyed by the SAME ingredient ids. */
  incoming: ReadonlyMap<string, IngredientManifest>;
}): PackOperationUpdateDiff => {
  const items: PackOperationUpdateDiffItem[] = [];
  let unchanged = 0;
  const ingredientIds = [...new Set([...input.installed.keys(), ...input.incoming.keys()])].sort();
  for (const ingredientId of ingredientIds) {
    const before = operationsOf(input.installed.get(ingredientId));
    const after = operationsOf(input.incoming.get(ingredientId));
    const operationIds = [...new Set([...before.keys(), ...after.keys()])].sort();
    for (const operationId of operationIds) {
      const was = before.get(operationId);
      const now = after.get(operationId);
      if (was !== undefined && now !== undefined && operationSpecHash(was) === operationSpecHash(now)) {
        unchanged += 1;
        continue;
      }
      const owner = ownerPolicyOf(input.store, ingredientId, operationId);
      items.push({
        ingredient_id: ingredientId,
        operation_id: operationId,
        change: was === undefined ? 'added' : now === undefined ? 'removed' : 'changed',
        ...(was !== undefined ? { installed: facts(was) } : {}),
        ...(now !== undefined ? { incoming: facts(now) } : {}),
        ...(owner !== undefined ? { owner_policy: owner } : {}),
      });
    }
  }
  return { items, unchanged };
};

/** Does this manifest carry a RECORDS composition? Its operations live in the
 *  stamped `records-<hash>` catalog, not under the composition's authored slug,
 *  so the composition-pack readers below must not look at it: keyed by the
 *  authored slug they find nothing installed and would call every operation
 *  "added". The records readers take the stamped catalog instead. */
export const carriesRecords = (manifest: BulkPackManifest): boolean =>
  normalizeBulkPackInstallPlan(manifest).contents.some((content) =>
    content.type === 'composition' && isRecordsComposition(content.composition));

/** The diff for a pack whose operations come from its own by-value
 *  compositions: the installed catalogs (the local manifest store, under the
 *  ingredient ids the inventory row lists) against the incoming ones (the
 *  manifest's compositions, decomposed exactly as install will). A catalog the
 *  update drops counts as removed only while no OTHER installed pack still
 *  lists it — otherwise its operations stay available and "removed" would lie.
 *  By-ref ingredients are the registry's, not the pack's, so they do not move
 *  with a pack update and are left out. `undefined` for a Records pack
 *  ({@link diffRecordsPackForUpdate} reads its stamped catalog). */
export const diffCompositionPackForUpdate = (
  store: ContractStore,
  localManifestStore: Pick<LocalManifestStore, 'getManifest'>,
  manifest: BulkPackManifest,
): PackOperationUpdateDiff | undefined => {
  if (carriesRecords(manifest)) return undefined;
  const incoming = incomingOperationInventory(manifest).exact;
  const claimedByOthers = new Set<string>();
  for (const pack of listInstalledPacks(store)) {
    if (pack.pack_slug === manifest.slug) continue;
    for (const id of packIngredientIds(store, pack.pack_slug)) claimedByOthers.add(id);
  }
  const installed = new Map<string, IngredientManifest>();
  for (const [id, body] of installedCompositionCatalogs(store, localManifestStore, manifest.slug)) {
    if (!incoming.has(id) && claimedByOthers.has(id)) continue;
    installed.set(id, body);
  }
  return diffPackOperationsForUpdate({ store, installed, incoming });
};

/** The catalogs a composition pack has installed NOW: the local manifest store,
 *  under the ingredient ids its inventory row lists. */
export const installedCompositionCatalogs = (
  store: ContractStore,
  localManifestStore: Pick<LocalManifestStore, 'getManifest'>,
  packSlug: string,
): Map<string, IngredientManifest> => {
  const out = new Map<string, IngredientManifest>();
  for (const id of packIngredientIds(store, packSlug)) {
    const body = localManifestStore.getManifest(id);
    if (body !== null) out.set(id, body);
  }
  return out;
};

/** The diff for a RECORDS pack: its one stamped catalog, keyed by the derived
 *  `records-<hash>` id its owner rules and grants use (the composition's
 *  authored slug is not that id — the reason D-211's review never saw a
 *  records pack's operations). `undefined` when the installed catalog cannot
 *  be read: no diff is better than a diff against nothing, which would call
 *  every operation "added". */
export const diffRecordsPackForUpdate = (
  store: ContractStore,
  localManifestStore: Pick<LocalManifestStore, 'getManifest'>,
  targetCatalog: IngredientManifest,
): PackOperationUpdateDiff | undefined => {
  const installed = localManifestStore.getManifest(targetCatalog.slug);
  if (installed === null) return undefined;
  return diffPackOperationsForUpdate({
    store,
    installed: new Map([[targetCatalog.slug, installed]]),
    incoming: new Map([[targetCatalog.slug, targetCatalog]]),
  });
};

/** The risk tiers each Access tier grants — the install's own
 *  `ACCESS_TIER_PERMITS` (`install-composition.ts`) and the Records install's
 *  rank (`groupIdsForInstall`), which this must mirror. */
const TIER_RISKS: Record<InstallAccessTier, ReadonlySet<OperationRiskTier>> = {
  read: new Set<OperationRiskTier>(['read']),
  write: new Set<OperationRiskTier>(['read', 'write']),
  all: new Set<OperationRiskTier>(['read', 'write', 'admin', 'destructive']),
};

/** A group's key in {@link currentPackAccess}: ingredient id + group id. */
export const packGroupKey = (ingredientId: string, groupId: string): string =>
  `${ingredientId}\u0000${groupId}`;

/** The Access tier a pack holds NOW, read back from the operation groups its
 *  install granted — so an update can START there.
 *
 *  ⛔ THE UPDATE DIALOG STARTED AT "READ ONLY" WHATEVER THE OWNER HAD CHOSEN, and
 *  an update REPLACES the pack's group grants: pressing Update on a pack the
 *  owner had given "Read + write" quietly took its writes away (driven live: the
 *  importer then failed `operation_not_granted`).
 *
 *  The owner's choice is not stored anywhere, only its result, so this reads
 *  the result. A tier is the answer when installing at it would grant what is
 *  granted now:
 *   - EVERY group within the tier is granted (installing at a tier grants all
 *     of them — one missing group means the owner chose lower), and
 *   - some group the tier ADDS is granted that no install grants on its own.
 *     A pack's authored `default_grants` are granted whatever the owner picks,
 *     so they prove nothing: without this, a pack whose only write group is an
 *     authored default reads as "Read + write" after a Read install, and the
 *     update would grant every NEW write group the owner never chose.
 *  Where two tiers would grant the same, the LOWER one is the answer: new
 *  groups start off (`upgrade_behavior: 'new_operations_off'`), never on.
 *
 *  ⚠ Not "ask-gated": 399 of the 455 bundled compositions with a write tier
 *  gate EVERY write operation on `ask`, and almost none list an authored
 *  default — the list, not the approval, is what tells a default apart.
 *
 *  `undefined` when nothing can be told: no grouped operations, or not even
 *  the read groups granted (an install that never showed the dialog). */
export const currentPackAccess = (input: {
  store: ContractStore;
  /** The pack's grant key: its slug, or a Records pack's derived catalog id. */
  installedPackId: string;
  /** The installed catalogs, by ingredient id. */
  catalogs: ReadonlyMap<string, IngredientManifest>;
  /** Groups an install grants whatever the owner picks ({@link packGroupKey}). */
  defaults: ReadonlySet<string>;
}): InstallAccessTier | undefined => {
  const granted = new Set<string>();
  for (const row of input.store.scan('grant', [input.installedPackId])) {
    if (row.segments.length !== 4) continue;
    if ((row.value as { allowed?: unknown }).allowed !== true) continue;
    granted.add(packGroupKey(row.segments[1]!, row.segments[3]!));
  }
  const groups: Array<{ key: string; floor: OperationRiskTier }> = [];
  for (const [ingredientId, catalog] of input.catalogs) {
    for (const [groupId, group] of Object.entries(catalog.operation_groups ?? {})) {
      if (group.risk_floor !== undefined) groups.push({ key: packGroupKey(ingredientId, groupId), floor: group.risk_floor });
    }
  }
  if (groups.length === 0) return undefined;
  const holds = (tier: InstallAccessTier): boolean =>
    groups.filter((group) => TIER_RISKS[tier].has(group.floor)).every((group) => granted.has(group.key));
  const chosen = (tier: InstallAccessTier, below: InstallAccessTier): boolean =>
    groups.some((group) => TIER_RISKS[tier].has(group.floor) && !TIER_RISKS[below].has(group.floor)
      && !input.defaults.has(group.key));
  if (holds('all') && chosen('all', 'write')) return 'all';
  if (holds('write') && chosen('write', 'read')) return 'write';
  if (holds('read')) return 'read';
  return undefined;
};

/** {@link currentPackAccess} for a pack whose operations come from its own
 *  compositions: the installed catalogs under its inventory's ids; the
 *  authored `default_grants` of the manifest's compositions. `undefined` for a
 *  Records pack ({@link recordsPackCurrentAccess}). */
export const compositionPackCurrentAccess = (
  store: ContractStore,
  localManifestStore: Pick<LocalManifestStore, 'getManifest'>,
  manifest: BulkPackManifest,
): InstallAccessTier | undefined => {
  if (carriesRecords(manifest)) return undefined;
  const defaults = new Set<string>();
  for (const content of normalizeBulkPackInstallPlan(manifest).contents) {
    if (content.type !== 'composition') continue;
    for (const groupId of content.composition.default_grants ?? []) {
      defaults.add(packGroupKey(content.composition.slug, groupId));
    }
  }
  return currentPackAccess({
    store,
    installedPackId: manifest.slug,
    catalogs: installedCompositionCatalogs(store, localManifestStore, manifest.slug),
    defaults,
  });
};

/** {@link currentPackAccess} for a Records pack: its grants and its one catalog
 *  are keyed by the derived catalog id, never the pack's slug. `undefined` when
 *  the installed catalog cannot be read. */
export const recordsPackCurrentAccess = (
  store: ContractStore,
  localManifestStore: Pick<LocalManifestStore, 'getManifest'>,
  target: { catalog: IngredientManifest; composition: CompositionIngredient },
): InstallAccessTier | undefined => {
  const catalogId = target.catalog.slug;
  const installed = localManifestStore.getManifest(catalogId);
  if (installed === null) return undefined;
  return currentPackAccess({
    store,
    installedPackId: catalogId,
    catalogs: new Map([[catalogId, installed]]),
    defaults: new Set((target.composition.default_grants ?? []).map((groupId) => packGroupKey(catalogId, groupId))),
  });
};
