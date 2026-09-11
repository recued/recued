/** The real simple-operation admission primitive, shared by dispatch and
 * read-only future-execution preparation. Required child calls are probed
 * independently; this primitive never flattens their ask into a denial. */
import {
  RpcError, deriveDispatchScope, executionSourceHasContract, isCatalogForm,
  kernelOpForBackingSlug, readOwnerOperationOverride,
  type AdmissionDecision, type ContractSnapshot, type ExecutionSource, type IngredientManifest,
} from '@recued/contracts';
import { evaluatePreflightAdmission } from '@recued/gateway';
import type { ExecuteHandlerDeps } from './execute-handler.js';
import { remoteFileConnectionNamesIn } from './collections/file/remote-file-byte-resolver.js';

export interface SingleOperationAdmissionDeps {
  source: ExecutionSource;
  manifest(slug: string): IngredientManifest | null | undefined;
  contract_snapshot?: ContractSnapshot;
  contractScan?: ExecuteHandlerDeps['contractScan'];
  opAdmissionGate?: ExecuteHandlerDeps['opAdmissionGate'];
  contractOverlay?: ExecuteHandlerDeps['contractOverlay'];
  granted_recipe_steps: boolean;
  recipeCoversOp(opId: string | undefined): boolean;
  /** Dispatch-only audit projection. Preparation supplies no activity sink. */
  onRecipeCoverage?(opId: string | undefined): void;
}

export const createSingleOperationAdmission = (deps: SingleOperationAdmissionDeps) => (
  slug: string, input: Record<string, unknown>, operationId?: string,
): AdmissionDecision | null => {
  const manifest = deps.manifest(slug);
  if (!manifest) return null;
  const opId = operationId !== undefined
    ? manifest.operations?.[operationId]?.operation_id ?? operationId : kernelOpForBackingSlug(slug);
  const scope = deriveDispatchScope({ kind: manifest.kind, slug }, input);
  const override = !isCatalogForm(manifest)
    ? readOwnerOperationOverride({ scan: deps.contractScan, ingredient_id: slug, operation_id: slug }) : undefined;
  const decision = evaluatePreflightAdmission({
    source: deps.source, tool: { slug, kind: manifest.kind, risk_tier: manifest.risk_tier },
    ...(executionSourceHasContract(deps.source) && deps.contract_snapshot !== undefined
      ? { contract_snapshot: deps.contract_snapshot } : {}),
    ...(deps.granted_recipe_steps ? { granted_recipe_steps: true } : {}),
    ...(scope !== null ? { scope_path: scope } : {}),
    ...(override !== undefined ? { owner_override: override } : {}),
  });
  if (decision.verdict !== 'deny' && deps.opAdmissionGate?.isFrozenByPause(deps.source)) {
    return Object.freeze({ verdict: 'deny', code: 'server_paused',
      detail: 'server is paused — contracted and AI operations are halted until the owner resumes' });
  }
  const covered = deps.granted_recipe_steps && deps.recipeCoversOp(opId);
  const granted = deps.opAdmissionGate?.isOpGranted(deps.source, opId) ?? true;
  if (covered && !granted) deps.onRecipeCoverage?.(opId);
  if (decision.verdict !== 'deny' && !granted && !covered) {
    return Object.freeze({ verdict: 'deny', code: 'op_not_granted',
      detail: `operation '${String(opId)}' is not granted to this dispatch's governing contract (revoked)` });
  }
  if (decision.verdict !== 'deny' && deps.contractOverlay) {
    for (const connection of remoteFileConnectionNamesIn(input)) {
      if (!deps.contractOverlay.admitsConnection(deps.source, connection)) {
        return Object.freeze({ verdict: 'deny', code: 'connection_not_in_scope',
          detail: `this dispatch reads a file from connection '${connection}', which this dispatch's governing contract does not admit` });
      }
    }
  }
  if (opId === 'core.preapproval.request' && decision.verdict === 'ask') {
    throw new RpcError('preapproval_request_policy_conflict',
      'The request operation itself requires approval. Open the manual review surface or change that rule before requesting a future approval.', 409);
  }
  return decision;
};
