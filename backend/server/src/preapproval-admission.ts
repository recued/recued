/** Synchronous inventory/claim admission using the dispatcher's policy
 * primitives. Descriptions carry no authority; every call resolves it afresh. */
import {
  cliPrincipalFromExecutionSource, readOwnerOperationOverride,
  resolveCatalogOperationPolicy, resolveCliReachabilityPolicy, resolveSimpleFormOperationPolicy,
  resolveTrustCeiling, type CatalogOperationResolution, type ExecutionSource, type RecordsExecutionBinding,
} from '@recued/contracts';
import { applyCatalogOverrideTightening, describeCatalogAuthority } from '@recued/engine';
import type { ExecuteHandlerDeps } from './execute-handler.js';
import type { PreapprovalNormalAdmission } from './preapproval-dispatch-description.js';
import type { PreapprovalPreparationDeps } from './preapproval-prepare.js';
import type { createPreapprovalOriginAuthority } from './preapproval-origin-authority.js';
import { createSingleOperationAdmission } from './single-operation-admission.js';
import { deriveGrantedRecipeCoverage } from './recipe-grant-coverage.js';
import { grantingRecipeEntry, recipeCoversOp } from './policy-gate.js';
import { recipeGrantKeyFor } from './recipe-grant-identity.js';
import { readCurrentConnectionOperationProfile } from './connection-operation-profile-boot.js';

export interface PreapprovalAdmissionDeps {
  authority: ReturnType<typeof createPreapprovalOriginAuthority>;
  execution: Pick<ExecuteHandlerDeps, 'executorConfig' | 'recipeStore' | 'opAdmissionGate' | 'contractOverlay' | 'contractScan' | 'cliReachabilityResolver'>;
  profiles: Parameters<typeof readCurrentConnectionOperationProfile>[0];
  /** Same synchronous Records namespace/group resolver used by the host's
   * engine context. Absence is a hard refusal for a Records operation. */
  recordsReachable?: (source: ExecutionSource, slug: string, op: string, binding: RecordsExecutionBinding) => boolean;
  root_recipe_id: string;
}

export const createPreapprovalAdmission = (deps: PreapprovalAdmissionDeps) => (
  call: Parameters<PreapprovalPreparationDeps['describe']>[0],
): PreapprovalNormalAdmission => {
  const { execution } = deps;
  const nested = call.recipe.invocation_path.filter(segment => segment.kind === 'recipe').length > 1;
  // handleExecute's localRecipeInvoker does not inherit a parent's recipe
  // grant. Resolve this saved child's own grant, or require its ordinary ops.
  const authorizationOrigin = nested ? deps.authority.bindTargetRecipe(call.origin, call.recipe.publisher_id, call.recipe.recipe_id) : call.origin;
  const { contract_snapshot } = deps.authority.resolve(authorizationOrigin);
  const source = call.origin.source;
  const recipeId = nested ? call.recipe.recipe_id : deps.root_recipe_id;
  const rootRecipe = execution.recipeStore.get(recipeId);
  const recipeGrant = authorizationOrigin.target_recipe_grant_key !== undefined
    ? authorizationOrigin.target_recipe_grant_key ?? undefined
    : grantingRecipeEntry(recipeId, contract_snapshot, () => {
    const key = rootRecipe ? recipeGrantKeyFor(execution.recipeStore, recipeId, rootRecipe) : undefined;
    return key && execution.opAdmissionGate?.isOwnerRecipeGranted(source, key) ? key : undefined;
  });
  const coverage = deriveGrantedRecipeCoverage(call.recipe.definition, call.recipe.effective_config,
    slug => execution.executorConfig.manifests.get(slug));
  const admitOne = createSingleOperationAdmission({ source, contract_snapshot,
    manifest: slug => execution.executorConfig.manifests.get(slug),
    contractScan: execution.contractScan, contractOverlay: execution.contractOverlay,
    opAdmissionGate: execution.opAdmissionGate, granted_recipe_steps: recipeGrant !== undefined,
    recipeCoversOp: op => recipeCoversOp(call.recipe.recipe_id, op, coverage),
  });
  const opKey = call.catalog && typeof call.input.operation === 'string' ? call.input.operation : undefined;
  const primary = admitOne(call.slug, call.input, opKey);
  const deny = (reason: string): PreapprovalNormalAdmission => ({ verdict: 'deny',
    risk: call.manifest.risk_tier, approval: null, reason });
  if (!primary) return deny('The operation definition is unavailable.');
  if (primary.verdict === 'deny') return deny(primary.detail);
  if (call.connection_name && execution.contractOverlay
    && !execution.contractOverlay.admitsConnection(source, call.connection_name)) {
    return deny('The original contract does not admit this connection.');
  }
  const ceiling = resolveTrustCeiling(source, contract_snapshot);
  let resolution: CatalogOperationResolution;
  if (!call.catalog) {
    resolution = resolveSimpleFormOperationPolicy({ slug: call.slug, risk_tier: call.manifest.risk_tier, ceiling,
      owner_override: readOwnerOperationOverride({ scan: execution.contractScan,
        ingredient_id: call.slug, operation_id: call.slug }) });
  } else {
    if (opKey === undefined) return deny('The catalog operation is unresolved.');
    const target = describeCatalogAuthority(call.manifest, opKey, call.connection_name);
    const profile = target.cli ? null : target.records ? { catalog_slug: call.slug,
      allowed_operations: target.records_binding && deps.recordsReachable?.(source, call.slug, opKey, target.records_binding) ? [opKey] : [] }
      : target.local_recipe ? { catalog_slug: call.slug,
        allowed_operations: target.local_recipe_id && execution.recipeStore.get(target.local_recipe_id) ? [opKey] : [] }
      : call.connection_name ? readCurrentConnectionOperationProfile(deps.profiles, call.connection_name) : null;
    const owner_override = readOwnerOperationOverride({ scan: execution.contractScan,
      ingredient_id: call.slug, operation_id: call.manifest.operations?.[opKey]?.operation_id ?? opKey });
    resolution = target.cli ? resolveCliReachabilityPolicy({ operations: call.manifest.operations ?? {}, operation_id: opKey,
      reachable: execution.cliReachabilityResolver?.(cliPrincipalFromExecutionSource(source), call.slug, opKey) ?? false,
      ceiling, owner_override, default_policy: call.manifest.default_policy })
      : resolveCatalogOperationPolicy({ operations: call.manifest.operations ?? {}, operation_id: opKey,
        profile, catalog_slug: call.slug, ceiling, owner_override, default_policy: call.manifest.default_policy });
    resolution = applyCatalogOverrideTightening({ actor: source.actor, contractScan: execution.contractScan }, resolution, call.slug);
  }
  return { verdict: resolution.verdict === 'deny' ? 'deny'
    : primary.verdict === 'ask' || resolution.verdict === 'ask' ? 'ask' : 'admit',
    risk: resolution.effective_risk_tier, approval: resolution.authorization_provenance.pre_lift_approval,
    reason: resolution.verdict === 'deny' ? resolution.deny_reason ?? 'The operation is not authorized.' : null };
};
