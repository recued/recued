/** D-211 — global owner replacements for pack operation defaults.
 *
 * This control belongs to a PACK, not a contract. Each row shows the
 * pack-authored `{risk, approval}` and lets the owner replace either value for
 * that operation globally. Contract access remains a separate per-contract
 * boolean matrix rendered by `pack-access-controls.ts`.
 */

import {
  OPERATION_APPROVALS,
  RISK_TIERS,
  isApprovalBelowRiskFloor,
  type BulkPackManifest,
  type OperationApproval,
  type OperationRiskTier,
  type OwnerOperationIngredientView,
  type OwnerOperationPolicyInput,
  type OwnerOperationView,
  type PackListEntry,
} from '@recued/contracts';

import { humanizeRpcError } from '../shell/rpc-error-copy.js';

export const OWNER_OPERATION_ATTR = 'data-recued-owner-operation-defaults';
export const OWNER_OPERATION_ROW_ATTR = 'data-recued-owner-operation-row';
export const OWNER_OPERATION_RISK_ATTR = 'data-recued-owner-operation-risk';
export const OWNER_OPERATION_APPROVAL_ATTR = 'data-recued-owner-operation-approval';
export const OWNER_OPERATION_ERROR_ATTR = 'data-recued-owner-operation-error';
/** The pack declares ingredients but none are in the server's operation
 *  inventory — distinct from a pack that genuinely declares no operations. */
export const OWNER_OPERATION_UNMATCHED_ATTR = 'data-recued-owner-operation-unmatched';
export const OWNER_OPERATION_STALE_ATTR = 'data-recued-owner-operation-stale';
export const OWNER_OPERATION_CONFIRM_ATTR = 'data-recued-owner-operation-confirm';
export const OWNER_OPERATION_CONFIRM_CANCEL_ATTR =
  'data-recued-owner-operation-confirm-cancel';

export type OwnerOperationListCaller = (
  args?: { ingredient_id?: string },
) => Promise<{ overrides: OwnerOperationView[] }>;

export type OwnerOperationInventoryCaller =
  () => Promise<{ ingredients: ReadonlyArray<OwnerOperationIngredientView> }>;

export type OwnerOperationUpsertCaller = (args: {
  ingredient_id: string;
  operation_id: string;
  policy: OwnerOperationPolicyInput;
}) => Promise<OwnerOperationView>;

export type OwnerOperationDeleteCaller = (args: {
  ingredient_id: string;
  operation_id: string;
}) => Promise<{ deleted: boolean }>;

export interface OwnerOperationControllerOptions {
  document: Document;
  runOperations?: OwnerOperationInventoryCaller;
  runListOverrides?: OwnerOperationListCaller;
  runUpsertOverride?: OwnerOperationUpsertCaller;
  runDeleteOverride?: OwnerOperationDeleteCaller;
  onChange: () => void;
}

export interface OwnerOperationController {
  readonly enabled: boolean;
  refresh(): Promise<void>;
  renderForPack(pack: PackListEntry): HTMLElement | null;
  whenLoaded(): Promise<void>;
  dispose(): void;
}

interface PendingConfirmation {
  ingredient_id: string;
  operation_id: string;
  policy: OwnerOperationPolicyInput;
}

const riskLabel = (risk: OperationRiskTier): string =>
  risk.charAt(0).toUpperCase() + risk.slice(1);

const approvalLabel = (approval: OperationApproval): string =>
  approval.charAt(0).toUpperCase() + approval.slice(1);

const keyOf = (ingredientId: string, operationId: string): string =>
  `${ingredientId}\u0000${operationId}`;

/** Ingredient ids whose operation defaults belong to this pack. Compositions
 * install a generated catalog ingredient; ingredient refs install a
 * simple/catalog manifest directly. */
export const packOperationIngredientSlugs = (
  manifest: BulkPackManifest,
): string[] => {
  const slugs = new Set<string>();
  for (const content of manifest.contents ?? []) {
    if (content.type === 'composition') {
      const slug = content.composition.slug.trim();
      if (slug !== '') slugs.add(slug);
      for (const ingredient of content.composition.ingredients ?? []) {
        const nested = typeof ingredient?.slug === 'string' ? ingredient.slug.trim() : '';
        if (nested !== '') slugs.add(nested);
      }
      // ⛔ A composition's own slug is NOT necessarily the id of the ingredient
      // it installs. It declares its ingredients explicitly, each with its own
      // slug, and THOSE are what land in the executor registry that
      // `collection.operation.listOperations` enumerates.
      //
      // 798 of the corpus's 825 composition packs happen to name the ingredient
      // after the composition, so the join worked and the feature looked fine.
      // The other 27 — `rental-book` (composition `rental-book`, ingredient
      // `rental-book-records`), every other `*-records` pack, `clamav-pack`
      // (`clamav` → `clamdscan`), `csvkit` (`csvkit` → `csvclean`) — matched
      // nothing and silently lost their whole Permissions tab.
      //
      // The composition slug is KEPT, not replaced: those 798 depend on it, and
      // a composition may register under either name.
      continue;
    }
    if (content.type === 'ingredient') {
      const slug = content.slug?.trim() ?? content.ingredient_id?.trim();
      if (slug !== undefined && slug !== '') slugs.add(slug);
    }
  }
  return [...slugs];
};

const errorCode = (err: unknown): string | undefined =>
  typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'string'
    ? (err as { code: string }).code
    : undefined;

const errorDetails = (err: unknown): Record<string, unknown> | undefined =>
  typeof err === 'object'
    && err !== null
    && typeof (err as { details?: unknown }).details === 'object'
    && (err as { details?: unknown }).details !== null
    ? (err as { details: Record<string, unknown> }).details
    : undefined;

const ownerOperationErrorMessage = (err: unknown): string => {
  const details = errorDetails(err);
  if (errorCode(err) === 'owner_operation_below_floor') {
    const risk = details?.effective_risk;
    const floor = details?.floor;
    return typeof floor === 'string'
      ? `Approval cannot be lower than the ${typeof risk === 'string' ? `${risk} ` : ''}`
        + `risk floor (${floor}).`
      : 'Approval cannot be lower than this operation\'s risk floor.';
  }
  if (errorCode(err) === 'owner_operation_risk_downgrade_confirm') {
    const before = details?.previous_risk ?? details?.declared_risk;
    const after = details?.new_risk;
    const floorBefore = details?.floor_before;
    const floorAfter = details?.floor_after;
    if (
      typeof before === 'string'
      && typeof after === 'string'
      && typeof floorBefore === 'string'
      && typeof floorAfter === 'string'
    ) {
      return `Confirm ${before} → ${after}: approval floor ${floorBefore} → ${floorAfter}; `
        + `session grants ${details?.session_grantable_after === true ? 'enabled' : 'disabled'}; `
        + `delegation learning ${details?.delegation_learnable_after === true ? 'enabled' : 'disabled'}.`;
    }
    return 'Confirm this lower risk classification and its approval consequences.';
  }
  return humanizeRpcError(err);
};

export const createOwnerOperationController = (
  opts: OwnerOperationControllerOptions,
): OwnerOperationController => {
  const enabled =
    opts.runOperations !== undefined
    && opts.runListOverrides !== undefined;
  const editable =
    enabled
    && opts.runUpsertOverride !== undefined
    && opts.runDeleteOverride !== undefined;
  let disposed = false;
  let loading = false;
  let error: string | null = null;
  let ingredients: ReadonlyArray<OwnerOperationIngredientView> = [];
  let overrides = new Map<string, OwnerOperationView>();
  let pendingLoad: Promise<void> = Promise.resolve();
  let generation = 0;
  const pending = new Set<string>();
  const rowErrors = new Map<string, string>();
  const confirmations = new Map<string, PendingConfirmation>();

  const refresh = (): Promise<void> => {
    if (!enabled || disposed) return Promise.resolve();
    const current = ++generation;
    loading = true;
    error = null;
    pendingLoad = Promise.all([
      (opts.runOperations as OwnerOperationInventoryCaller)(),
      (opts.runListOverrides as OwnerOperationListCaller)(),
    ]).then(([catalog, listed]) => {
      if (disposed || current !== generation) return;
      ingredients = catalog.ingredients;
      overrides = new Map(
        listed.overrides.map((row) => [keyOf(row.ingredient_id, row.operation_id), row]),
      );
    }).catch((err: unknown) => {
      if (!disposed && current === generation) error = humanizeRpcError(err);
    }).finally(() => {
      if (!disposed && current === generation) {
        loading = false;
        opts.onChange();
      }
    });
    return pendingLoad;
  };

  const persist = async (
    request: PendingConfirmation,
    confirmRiskDowngrade = false,
  ): Promise<void> => {
    if (!editable || disposed) return;
    const key = keyOf(request.ingredient_id, request.operation_id);
    pending.add(key);
    rowErrors.delete(key);
    confirmations.delete(key);
    opts.onChange();
    try {
      const policy = {
        ...request.policy,
        ...(confirmRiskDowngrade ? { confirm_risk_downgrade: true } : {}),
      };
      if (policy.risk === undefined && policy.approval === undefined) {
        await (opts.runDeleteOverride as OwnerOperationDeleteCaller)({
          ingredient_id: request.ingredient_id,
          operation_id: request.operation_id,
        });
        overrides.delete(key);
      } else {
        const written = await (opts.runUpsertOverride as OwnerOperationUpsertCaller)({
          ingredient_id: request.ingredient_id,
          operation_id: request.operation_id,
          policy,
        });
        overrides.set(key, written);
      }
    } catch (err) {
      if (errorCode(err) === 'owner_operation_risk_downgrade_confirm') {
        confirmations.set(key, request);
      }
      rowErrors.set(key, ownerOperationErrorMessage(err));
    } finally {
      pending.delete(key);
      if (!disposed) opts.onChange();
    }
  };

  const renderForPack = (pack: PackListEntry): HTMLElement | null => {
    if (!enabled) return null;
    // Owner-operation overrides only exist for an INSTALLED pack's operations,
    // and `manifest` is present exactly then.
    if (pack.manifest === undefined) return null;
    const membership = new Set(packOperationIngredientSlugs(pack.manifest));
    // ⛔ Prefer the server's OWNERSHIP fact over the slug guess. `pack_slug` comes
    // off `installed_pack.ingredient_ids`, so it is right even when the installed
    // ingredient carries a name no author wrote — which is every Records pack,
    // whose catalog registers as `records-<hash>`. The slug set stays as the
    // fallback for an ingredient with no inventory row (a bundled manifest no
    // pack installed) and for a server too old to send the field.
    const scoped = ingredients.filter((ingredient) => (
      ingredient.pack_slug !== undefined
        ? ingredient.pack_slug === pack.slug
        : membership.has(ingredient.ingredient_id)
    ));
    // ⚠ `[].every(…)` is TRUE, so an empty `scoped` used to read as "this pack's
    // ingredients declare no operations" — the same answer as a pack that really
    // has none. That vacuous truth is what let the slug-join bug above hide: a
    // pack whose ingredients matched NOTHING reported "nothing to customize" and
    // looked deliberate. Keep the two apart, so the next join that breaks says so
    // instead of quietly removing a whole tab.
    const matchedNothing = membership.size > 0 && scoped.length === 0;
    if (!loading && error === null && !matchedNothing
      && scoped.every((ingredient) => ingredient.operations.length === 0)) {
      return null;
    }

    const root = opts.document.createElement('div');
    root.setAttribute(OWNER_OPERATION_ATTR, '');
    root.className = 'owner-operation-defaults';
    const note = opts.document.createElement('p');
    note.className = 'owner-operation-note';
    note.textContent =
      'Pack values are the default for every contract. Owner values replace them globally; contract access stays separate.';
    root.appendChild(note);

    if (loading) {
      const line = opts.document.createElement('p');
      line.textContent = 'Loading operation defaults…';
      root.appendChild(line);
      return root;
    }
    if (error !== null) {
      const line = opts.document.createElement('p');
      line.setAttribute(OWNER_OPERATION_ERROR_ATTR, '');
      line.className = 'owner-operation-error';
      line.textContent = error;
      root.appendChild(line);
      return root;
    }

    if (matchedNothing) {
      // The pack declares ingredients, but none of them are in the server's
      // operation inventory. For an uninstalled pack that is simply the truth;
      // for an installed one it is a real fault worth seeing rather than an
      // empty tab that reads as "this pack asks for nothing".
      const line = opts.document.createElement('p');
      line.setAttribute(OWNER_OPERATION_UNMATCHED_ATTR, '');
      line.className = 'owner-operation-note';
      line.textContent = pack.installed
        ? 'This pack’s operations are not in the server’s inventory yet. Reinstall the pack, or restart the server, to load them.'
        : 'Install this pack to set owner defaults for its operations.';
      root.appendChild(line);
      return root;
    }

    for (const ingredient of scoped) {
      if (ingredient.operations.length === 0) continue;
      const group = opts.document.createElement('div');
      group.className = 'owner-operation-group';
      const heading = opts.document.createElement('h4');
      heading.textContent = ingredient.name;
      group.appendChild(heading);

      for (const operation of ingredient.operations) {
        const key = keyOf(ingredient.ingredient_id, operation.operation_id);
        const owner = overrides.get(key);
        const effectiveRisk = owner?.risk ?? operation.risk_tier;
        const packApproval = operation.approval;
        const row = opts.document.createElement('div');
        row.setAttribute(OWNER_OPERATION_ROW_ATTR, '');
        row.setAttribute('data-ingredient-id', ingredient.ingredient_id);
        row.setAttribute('data-operation-id', operation.operation_id);
        row.className = 'owner-operation-row';

        const identity = opts.document.createElement('div');
        identity.className = 'owner-operation-identity';
        const name = opts.document.createElement('span');
        name.textContent = operation.operation_key;
        identity.appendChild(name);
        const id = opts.document.createElement('code');
        id.textContent = operation.operation_id;
        identity.appendChild(id);
        row.appendChild(identity);

        const risk = opts.document.createElement('select');
        risk.setAttribute(OWNER_OPERATION_RISK_ATTR, '');
        risk.setAttribute('aria-label', `Owner risk for ${operation.operation_id}`);
        const packRiskOption = opts.document.createElement('option');
        packRiskOption.setAttribute('value', '');
        packRiskOption.textContent = `Pack · ${riskLabel(operation.risk_tier)}`;
        risk.appendChild(packRiskOption);
        for (const tier of RISK_TIERS) {
          const option = opts.document.createElement('option');
          option.setAttribute('value', tier);
          option.textContent = `Owner · ${riskLabel(tier)}`;
          risk.appendChild(option);
        }
        risk.value = owner?.risk ?? '';
        if (!editable || pending.has(key)) risk.setAttribute('disabled', '');
        else risk.addEventListener('change', () => {
          void persist({
            ingredient_id: ingredient.ingredient_id,
            operation_id: operation.operation_id,
            policy: {
              ...(risk.value !== '' ? { risk: risk.value as OperationRiskTier } : {}),
              ...(owner?.approval !== undefined ? { approval: owner.approval } : {}),
            },
          });
        });
        row.appendChild(risk);

        const approval = opts.document.createElement('select');
        approval.setAttribute(OWNER_OPERATION_APPROVAL_ATTR, '');
        approval.setAttribute('aria-label', `Owner approval for ${operation.operation_id}`);
        const packApprovalOption = opts.document.createElement('option');
        packApprovalOption.setAttribute('value', '');
        packApprovalOption.textContent = packApproval === undefined
          ? 'Pack · Automatic'
          : `Pack · ${approvalLabel(packApproval)}`;
        approval.appendChild(packApprovalOption);
        for (const posture of OPERATION_APPROVALS) {
          const option = opts.document.createElement('option');
          option.setAttribute('value', posture);
          option.textContent = `Owner · ${approvalLabel(posture)}`;
          if (isApprovalBelowRiskFloor(posture, effectiveRisk)) {
            option.setAttribute('disabled', '');
          }
          approval.appendChild(option);
        }
        approval.value = owner?.approval ?? '';
        if (!editable || pending.has(key)) approval.setAttribute('disabled', '');
        else approval.addEventListener('change', () => {
          void persist({
            ingredient_id: ingredient.ingredient_id,
            operation_id: operation.operation_id,
            policy: {
              ...(owner?.risk !== undefined ? { risk: owner.risk } : {}),
              ...(approval.value !== ''
                ? { approval: approval.value as OperationApproval }
                : {}),
            },
          });
        });
        row.appendChild(approval);

        if (owner?.stale === true) {
          const stale = opts.document.createElement('span');
          stale.setAttribute(OWNER_OPERATION_STALE_ATTR, '');
          stale.className = 'owner-operation-warning';
          stale.textContent = 'Pack operation changed since this owner value was reviewed.';
          row.appendChild(stale);
        }
        const rowError = rowErrors.get(key);
        if (rowError !== undefined) {
          const line = opts.document.createElement('span');
          line.setAttribute(OWNER_OPERATION_ERROR_ATTR, '');
          line.className = 'owner-operation-error';
          line.textContent = rowError;
          row.appendChild(line);
        }
        const confirmation = confirmations.get(key);
        if (confirmation !== undefined) {
          const actions = opts.document.createElement('span');
          actions.className = 'owner-operation-confirm';
          const confirm = opts.document.createElement('button');
          confirm.setAttribute('type', 'button');
          confirm.setAttribute(OWNER_OPERATION_CONFIRM_ATTR, '');
          confirm.textContent = 'Confirm lower risk';
          confirm.addEventListener('click', () => void persist(confirmation, true));
          actions.appendChild(confirm);
          const cancel = opts.document.createElement('button');
          cancel.setAttribute('type', 'button');
          cancel.setAttribute(OWNER_OPERATION_CONFIRM_CANCEL_ATTR, '');
          cancel.textContent = 'Cancel';
          cancel.addEventListener('click', () => {
            confirmations.delete(key);
            rowErrors.delete(key);
            opts.onChange();
          });
          actions.appendChild(cancel);
          row.appendChild(actions);
        }
        group.appendChild(row);
      }
      root.appendChild(group);
    }
    return root;
  };

  return {
    enabled,
    refresh,
    renderForPack,
    whenLoaded: () => pendingLoad,
    dispose: () => {
      disposed = true;
      generation += 1;
    },
  };
};

export const OWNER_OPERATION_STYLES = `
[${OWNER_OPERATION_ATTR}] {
  display: grid;
  gap: 12px;
}
[${OWNER_OPERATION_ATTR}] .owner-operation-note {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
}
[${OWNER_OPERATION_ATTR}] .owner-operation-group {
  display: grid;
  gap: 6px;
}
[${OWNER_OPERATION_ATTR}] .owner-operation-group h4 {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
}
[${OWNER_OPERATION_ROW_ATTR}] {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) minmax(145px, 180px) minmax(145px, 180px);
  gap: 8px;
  align-items: center;
  padding: 7px 0;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 65%, transparent);
}
[${OWNER_OPERATION_ROW_ATTR}] .owner-operation-identity {
  display: grid;
  gap: 2px;
  min-width: 0;
}
[${OWNER_OPERATION_ROW_ATTR}] .owner-operation-identity code {
  color: var(--muted);
  font-size: 10px;
  overflow-wrap: anywhere;
}
[${OWNER_OPERATION_ROW_ATTR}] select {
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface);
  color: var(--fg);
  padding: 6px 8px;
}
[${OWNER_OPERATION_ROW_ATTR}] .owner-operation-error,
[${OWNER_OPERATION_ROW_ATTR}] .owner-operation-warning,
[${OWNER_OPERATION_ROW_ATTR}] .owner-operation-confirm {
  grid-column: 1 / -1;
  font-size: 11px;
}
[${OWNER_OPERATION_ATTR}] .owner-operation-error { color: var(--danger, #b3261e); }
[${OWNER_OPERATION_ATTR}] .owner-operation-warning { color: var(--warn, #8a5a00); }
[${OWNER_OPERATION_ATTR}] .owner-operation-confirm {
  display: flex;
  gap: 8px;
}
@media (max-width: 720px) {
  [${OWNER_OPERATION_ROW_ATTR}] { grid-template-columns: 1fr; }
}
`;
