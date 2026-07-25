/** D-211 Slice 5 — compare global owner-operation rulings with an incoming
 * pack before an update is accepted. The stored `op_hash` is the reviewed
 * operation identity; a mismatch or removal becomes a compact merge-card row.
 * No contract/actor enters this projection because the ruling is global. */

import {
  OWNER_OPERATION_SCOPE,
  isCatalogForm,
  isOperationApproval,
  isRiskTier,
  normalizeBulkPackInstallPlan,
  type BulkPackManifest,
  type IngredientManifest,
  type OperationSpec,
  type OwnerOperationUpdateReviewItem,
  type PackContentRef,
} from '@recued/contracts';
import { decomposeComposition } from '@recued/ingredient-authoring';

import { listInstalledPacks, packIngredientIds } from './pack-inventory.js';
import { operationSpecHash } from './operation-spec-hash.js';
import type { ContractStore } from './storage/contract-store.js';

const ingredientRefId = (
  content: Extract<PackContentRef, { type: 'ingredient' }>,
): string | undefined => {
  const id = content.ingredient_id ?? content.slug;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
};

const operationFromManifest = (
  manifest: IngredientManifest,
  operationId: string,
): OperationSpec | undefined => {
  if (isCatalogForm(manifest)) {
    return Object.values(manifest.operations ?? {}).find(
      (operation) => operation.operation_id === operationId,
    );
  }
  return manifest.slug === operationId
    ? { operation_id: manifest.slug, risk_tier: manifest.risk_tier }
    : undefined;
};

interface IncomingOperationInventory {
  /** Every ingredient the incoming pack still names, including by-ref entries
   * whose operation body is not carried by the pack itself. */
  membership: Set<string>;
  /** Exact by-value composition manifests whose operation hashes can be
   * compared before install. */
  exact: Map<string, IngredientManifest>;
}

const incomingOperationInventory = (
  manifest: BulkPackManifest,
): IncomingOperationInventory => {
  const membership = new Set<string>();
  const exact = new Map<string, IngredientManifest>();
  for (const content of normalizeBulkPackInstallPlan(manifest).contents) {
    if (content.type === 'ingredient') {
      const id = ingredientRefId(content);
      if (id !== undefined) membership.add(id);
      continue;
    }
    if (content.type !== 'composition') continue;
    const id = content.composition.slug;
    membership.add(id);
    const decompose = decomposeComposition[content.composition.schema_version];
    if (decompose === undefined) continue;
    // Parsed marketplace/bundled packs use a supported, validated composition.
    // If a malformed preview still reaches here, installation's authoring gate
    // rejects it; keeping it as membership avoids falsely calling every ruling
    // "removed" before that rejection.
    try {
      const artifacts = decompose(content.composition);
      const operationManifest = artifacts.catalog ?? artifacts.ingredient;
      if (operationManifest !== undefined) exact.set(id, operationManifest);
    } catch {
      // See the fail-closed install-gate note above.
    }
  }
  return { membership, exact };
};

/** Return only changed/removed global owner rulings affected by `manifest`.
 * Callers gate this to a real version update; the helper itself stays pure over
 * the store + incoming artifact so it can be tested independently. */
export const reviewOwnerOperationsForPackUpdate = (
  store: ContractStore,
  manifest: BulkPackManifest,
): OwnerOperationUpdateReviewItem[] => {
  const incoming = incomingOperationInventory(manifest);
  const priorIds = new Set(packIngredientIds(store, manifest.slug));
  const candidates = new Set([...priorIds, ...incoming.exact.keys()]);

  // Dropping one pack's shared by-ref ingredient does not remove that
  // ingredient while another installed pack still claims it.
  const claimedByOtherPacks = new Set<string>();
  for (const installed of listInstalledPacks(store)) {
    if (installed.pack_slug === manifest.slug) continue;
    for (const id of packIngredientIds(store, installed.pack_slug)) {
      claimedByOtherPacks.add(id);
    }
  }

  const review: OwnerOperationUpdateReviewItem[] = [];
  for (const row of store.scan(OWNER_OPERATION_SCOPE)) {
    if (row.segments.length !== 2) continue;
    const [ingredientId, operationId] = row.segments;
    if (!candidates.has(ingredientId)) continue;
    const value = row.value as Record<string, unknown>;
    const risk = isRiskTier(value.risk) ? value.risk : undefined;
    const approval = isOperationApproval(value.approval)
      ? value.approval
      : undefined;
    if (risk === undefined && approval === undefined) continue;
    const owner_policy = {
      ...(risk !== undefined ? { risk } : {}),
      ...(approval !== undefined ? { approval } : {}),
    };

    const exactManifest = incoming.exact.get(ingredientId);
    if (exactManifest !== undefined) {
      const operation = operationFromManifest(exactManifest, operationId);
      if (operation === undefined) {
        review.push({
          ingredient_id: ingredientId,
          operation_id: operationId,
          change: 'removed',
          owner_policy,
        });
        continue;
      }
      if (
        typeof value.op_hash !== 'string'
        || operationSpecHash(operation) !== value.op_hash
      ) {
        review.push({
          ingredient_id: ingredientId,
          operation_id: operationId,
          change: 'changed',
          owner_policy,
          incoming: {
            risk: operation.risk_tier,
            ...(operation.approval !== undefined
              ? { approval: operation.approval }
              : {}),
          },
        });
      }
      continue;
    }

    if (
      priorIds.has(ingredientId)
      && !incoming.membership.has(ingredientId)
      && !claimedByOtherPacks.has(ingredientId)
    ) {
      review.push({
        ingredient_id: ingredientId,
        operation_id: operationId,
        change: 'removed',
        owner_policy,
      });
    }
  }

  return review.sort((a, b) =>
    a.ingredient_id.localeCompare(b.ingredient_id)
    || a.operation_id.localeCompare(b.operation_id)
    || a.change.localeCompare(b.change));
};
