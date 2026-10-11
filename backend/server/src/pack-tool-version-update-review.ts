/** D-321 — the programs whose handling outside their tested range a pack
 *  update changes, for the update's review beside D-211's
 *  `owner_operation_review`.
 *
 *  An owner's choice for a program is made for the `version` block its pack
 *  declares then. An update that declares another makes it stale, and
 *  `effectiveToolVersionOutside` then keeps a Refuse and lets a Warn lapse to
 *  the pack's default. So an update could turn the owner's Warn into a Refuse
 *  they did not choose, and they learned it only afterwards, from the pack
 *  page's Programs block. Each program the owner chose for is read against the
 *  range installed now and against the update's, and listed when the two
 *  answers differ; a choice the update leaves in force stays quiet.
 *
 *  ⚠ Never fails the review it sits in: a program that cannot be read is left
 *  out, and a pack whose catalogs cannot be read gets no list. */

import {
  OWNER_TOOL_VERSION_SCOPE,
  cliToolFromConnectorRuntime,
  cliToolPolicyOfRuntime,
  effectiveToolVersionOutside,
  readOwnerToolVersionRow,
  type BulkPackManifest,
  type IngredientManifest,
  type ToolVersionUpdateReviewItem,
} from '@recued/contracts';

import type { LocalManifestStore } from './ingredient-authoring/local-manifest-store.js';
import { incomingOperationInventory } from './owner-operation-update-review.js';
import { carriesRecords, installedCompositionCatalogs } from './pack-operation-update-diff.js';
import type { ContractStore } from './storage/contract-store.js';

const versionOf = (manifest: IngredientManifest | undefined) =>
  cliToolPolicyOfRuntime(manifest?.surfaces?.connector?.runtime).tool_version?.version;

/** The programs among `incoming`'s catalogs whose handling outside the tested
 *  range differs from what `installed`'s ranges give them now, given the
 *  owner's stored choices. */
export const reviewToolVersionsForPackUpdate = (
  store: Pick<ContractStore, 'get'>,
  installed: ReadonlyMap<string, IngredientManifest>,
  incoming: ReadonlyMap<string, IngredientManifest>,
): ToolVersionUpdateReviewItem[] => {
  const review: ToolVersionUpdateReviewItem[] = [];
  for (const [id, next] of incoming) {
    try {
      const tool = cliToolFromConnectorRuntime(next.surfaces?.connector?.runtime);
      const after = versionOf(next);
      // A program checked for the first time, or no longer checked, is the
      // pack's own change: no owner choice is in play.
      const now = versionOf(installed.get(id));
      if (tool === undefined || after === undefined || now === undefined) continue;
      const owner = readOwnerToolVersionRow(store.get(OWNER_TOOL_VERSION_SCOPE, [id])?.value);
      if (owner === undefined) continue;
      const outside_now = effectiveToolVersionOutside(now, owner).outside;
      const outside_after = effectiveToolVersionOutside(after, owner).outside;
      if (outside_now === outside_after) continue;
      review.push({ ingredient_id: id, tool, outside_now, outside_after, tested: { ...after.tested } });
    } catch {
      // Left out; the rest of the review still shows.
    }
  }
  return review;
};

/** The review for `manifest` as an update of the pack installed now. A Records
 *  pack carries no programs. */
export const toolVersionReviewForPackUpdate = (
  store: ContractStore,
  localManifestStore: Pick<LocalManifestStore, 'getManifest'>,
  manifest: BulkPackManifest,
): ToolVersionUpdateReviewItem[] => {
  if (carriesRecords(manifest)) return [];
  try {
    return reviewToolVersionsForPackUpdate(
      store,
      installedCompositionCatalogs(store, localManifestStore, manifest.slug),
      incomingOperationInventory(manifest).exact,
    );
  } catch {
    return [];
  }
};
