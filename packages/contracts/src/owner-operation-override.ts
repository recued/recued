/** D-211 — the owner's global operation-default replacements.
 *
 * Pack authors declare `{ risk_tier, approval? }` on each operation. The owner
 * may replace either value for that operation globally; the resulting pair is
 * then fed into the existing admission pipeline (contract access, trust
 * ceilings, actor-scoped tightening overrides, grants, and approvals). These
 * rows therefore have no actor or contract-id segment: approval is an owner
 * ruling about the operation, not a property of one contract.
 */

import type { ContractRowLike, ScanFn } from './contract-dispatch.js';
import { canonicalJSONStringify } from '@recued/crypto/canonical-json';
import { sha256Hex } from '@recued/crypto/hash';
import {
  isCatalogForm,
  isOperationApproval,
  type OperationApproval,
  type OperationRiskTier,
  type OperationSpec,
  type OwnerOverridePolicy,
} from './ingredient-catalog.js';
import { isRiskTier, type IngredientManifest } from './ingredient.js';

/** Actorless/global row key: `(ingredient_id, operation_id)`. */
export const OWNER_OPERATION_SCOPE = 'owner_operation';

/** Canonical identity of the complete authored operation reviewed by an owner.
 * Shared by row stamps, pack-update review, and durable ask actions so none of
 * those seams can silently apply a decision to a newer operation body. */
export const operationSpecHash = (operation: OperationSpec): string =>
  sha256Hex(canonicalJSONStringify(operation));

/** Closed wire check for a canonical SHA-256 operation stamp. */
export const isOperationSpecHash = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

/** Wire policy for one global owner replacement. The confirm flag acknowledges
 * a downward risk reclassification and is never persisted. */
export interface OwnerOperationPolicyInput {
  risk?: OperationRiskTier;
  approval?: OperationApproval;
  confirm_risk_downgrade?: boolean;
}

/** Stored owner ruling projected for RPC and pack-detail UI. */
export interface OwnerOperationView {
  ingredient_id: string;
  operation_id: string;
  policy: Omit<OwnerOperationPolicyInput, 'confirm_risk_downgrade'>;
  risk?: OperationRiskTier;
  approval?: OperationApproval;
  /** Hash of the author operation spec at the time of the ruling. */
  op_hash?: string;
  /** True when the currently loaded operation no longer matches `op_hash`. */
  stale?: boolean;
  written_at: number;
}

/** One global owner ruling whose stamped operation no longer matches an
 * incoming pack update. The install review shows only these rows: unchanged
 * rulings stay quiet, while a removed operation has no incoming defaults. */
export interface OwnerOperationUpdateReviewItem {
  ingredient_id: string;
  operation_id: string;
  change: 'changed' | 'removed';
  owner_policy: Omit<OwnerOperationPolicyInput, 'confirm_risk_downgrade'>;
  /** Incoming pack defaults, present only while the operation still exists. */
  incoming?: {
    risk: OperationRiskTier;
    approval?: OperationApproval;
  };
}

/** One operation that differs between the installed pack and its update —
 *  EVERY operation, customized or not (`OwnerOperationUpdateReviewItem` covers
 *  only the ones the owner set a rule for).
 *
 *  ⛔ THERE IS NO RENAME. An operation id carries no durable identity across
 *  pack versions, so nothing can tie `abc` to `bcd`: that is `abc` REMOVED —
 *  the owner's rule for it goes dark, kept but doing nothing, in case the
 *  operation ever comes back — and `bcd` ADDED on the pack's defaults. */
export interface PackOperationUpdateDiffItem {
  ingredient_id: string;
  operation_id: string;
  change: 'added' | 'removed' | 'changed';
  /** The installed definition's risk and approval — absent for `added`. */
  installed?: { risk: OperationRiskTier; approval?: OperationApproval };
  /** The incoming definition's risk and approval — absent for `removed`. */
  incoming?: { risk: OperationRiskTier; approval?: OperationApproval };
  /** The owner's own rule for this operation, when they set one. */
  owner_policy?: Omit<OwnerOperationPolicyInput, 'confirm_risk_downgrade'>;
}

/** What a pack update does to the pack's operations. `changed` is any change
 *  to the operation's definition (`operationSpecHash`) — the same test that
 *  marks an owner's rule stale — so risk and approval are carried on both
 *  sides to say what, if anything, moved there. */
export interface PackOperationUpdateDiff {
  items: PackOperationUpdateDiffItem[];
  /** Operations present in both versions with an identical definition. */
  unchanged: number;
}

/** One operation projected for the pack-detail owner-default editor. Unlike
 * the legacy catalog inventory, this includes the slug-keyed operation of a
 * simple-form ingredient too. */
export interface OwnerOperationSpecView {
  operation_id: string;
  operation_key: string;
  risk_tier: OperationRiskTier;
  /** Explicit pack operation approval. Absent keeps the resolver's existing
   * provider/risk fallback. */
  approval?: OperationApproval;
}

/** One loaded ingredient and every operation whose pack defaults the owner can
 * replace. */
export interface OwnerOperationIngredientView {
  ingredient_id: string;
  name: string;
  operations: OwnerOperationSpecView[];
  /** The AUTHORED slug of the pack that installed this ingredient, when the
   *  server could resolve one from its inventory.
   *
   *  ⛔ Without this the Permissions tab had to GUESS pack membership from the
   *  manifest's composition slugs, and a Records pack registers its catalog under
   *  a content-addressed `records-<hash>` id that matches no name any author
   *  wrote — so the guess missed and the tab rendered empty. Ownership is a fact
   *  the inventory already holds; it should never have been inferred client-side. */
  pack_slug?: string;
}

/** Project every loaded manifest into the D-211 operation inventory.
 * Catalog-form ingredients expose each declared operation; simple-form
 * ingredients expose their one exact slug-keyed operation. */
export const ownerOperationIngredientViews = (
  manifests: readonly IngredientManifest[],
): OwnerOperationIngredientView[] =>
  manifests
    .map((manifest): OwnerOperationIngredientView => {
      if (!isCatalogForm(manifest)) {
        return {
          ingredient_id: manifest.slug,
          name: manifest.name,
          operations: [{
            operation_id: manifest.slug,
            operation_key: manifest.slug,
            risk_tier: manifest.risk_tier,
          }],
        };
      }
      return {
        ingredient_id: manifest.slug,
        name: manifest.name,
        operations: Object.entries(manifest.operations ?? {})
          .map(([operation_key, operation]) => ({
            operation_id: operation.operation_id,
            operation_key,
            risk_tier: operation.risk_tier,
            ...(operation.approval !== undefined
              ? { approval: operation.approval }
              : {}),
          }))
          .sort((a, b) => a.operation_id.localeCompare(b.operation_id)),
      };
    })
    .sort((a, b) => a.ingredient_id.localeCompare(b.ingredient_id));

const NEVER_FROM_WIRE_FIELDS: ReadonlySet<string> = new Set([
  'confirm_risk_downgrade',
  'op_hash',
]);

/** Strip acknowledgements/server stamps and nullish values while preserving
 * unknown keys so schema validation rejects wire typos loudly. */
export const ownerOperationRowValue = (
  input: Readonly<Record<string, unknown>>,
): Record<string, unknown> => {
  const value: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(input)) {
    if (NEVER_FROM_WIRE_FIELDS.has(key)) continue;
    if (field !== undefined && field !== null) value[key] = field;
  }
  return value;
};

export const isEmptyOwnerOperationPolicy = (
  input: Readonly<Record<string, unknown>>,
): boolean => Object.keys(ownerOperationRowValue(input)).length === 0;

/** Read the global owner replacement for an exact operation. Invalid
 * hand-stored vocabulary is ignored so malformed local state cannot weaken an
 * admission decision. */
export const readOwnerOperationOverride = (args: {
  scan?: ScanFn;
  ingredient_id: string;
  operation_id: string;
}): OwnerOverridePolicy | undefined => {
  if (args.scan === undefined) return undefined;
  const row = args.scan(
    OWNER_OPERATION_SCOPE,
    [args.ingredient_id, args.operation_id],
  ).find((candidate: ContractRowLike) => candidate.segments.length === 2);
  if (row === undefined) return undefined;
  const risk = isRiskTier(row.value.risk) ? row.value.risk : undefined;
  const approval = isOperationApproval(row.value.approval)
    ? row.value.approval
    : undefined;
  if (risk === undefined && approval === undefined) return undefined;
  return {
    ...(risk !== undefined ? { risk } : {}),
    ...(approval !== undefined ? { approval } : {}),
  };
};
