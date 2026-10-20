/** Version-bound mutations share the ordinary host capture and final guards.
 * Accepted plans retain their evidence: a completed write must not invalidate
 * unrelated later members merely because inventory is visited again. */
import { RpcError, isRecordsExecutionBinding, isResourceReview, parsePreapprovalJson } from '@recued/contracts';
import { describeCatalogDispatch } from '@recued/engine';
import type { ServerExecutorConfig } from './server-executor.js';
import type { PreapprovalCall, PreapprovalRuntimeIdentity } from './preapproval-dispatch-description.js';
import type { PreapprovalDomainContext } from './preapproval-mail.js';
import { preapprovalPathKey } from './preapproval-invocations.js';

export const createPreapprovalResources = (executor: Pick<ServerExecutorConfig, 'resourceReview'>) =>
  (call: PreapprovalCall, context: PreapprovalDomainContext): PreapprovalRuntimeIdentity | null => {
    const key = typeof call.input.operation === 'string' ? call.input.operation : '';
    const binding = call.catalog ? call.manifest.surfaces?.records?.executes?.[key] : undefined;
    const records = isRecordsExecutionBinding(binding)
      && ['update', 'delete', 'upsert', 'batch'].includes(binding.action)
      && describeCatalogDispatch(call.manifest, key, call.input.args as Record<string, unknown>, call.connection_name)?.binding === binding;
    const calendar = !call.catalog && ['calendar-update', 'calendar-delete'].includes(call.slug);
    if (!records && !calendar) return null;
    const saved = context.plan?.members.find(member =>
      preapprovalPathKey(member.invocation_path) === preapprovalPathKey(call.path))?.resource_review;
    // An older partial plan may list this call as ordinary uncovered work.
    // Adding support must not silently cover it or block its existing hold.
    // A selected member without evidence still fails live member matching.
    if (context.plan && saved === undefined) return null;
    if (!executor.resourceReview || (context.plan && !isResourceReview(saved))) {
      throw new RpcError('preapproval_stale', 'The resource review integration or saved evidence is unavailable. Request a new review.', 409);
    }
    let review = saved;
    if (context.stage === 'prepare' || context.stage === 'decide') {
      try { review = executor.resourceReview.capture(call.slug, call.input, saved); }
      catch (error) {
        if (saved) throw new RpcError('preapproval_stale', 'A reviewed resource or proposed change is no longer current. Request a new review.', 409);
        throw error;
      }
    }
    if (!isResourceReview(review)) throw new RpcError('preapproval_unresolved', 'This mutation has no supported resource version to review.', 409);
    return {
      family: 'kernel',
      binding: parsePreapprovalJson({ dispatcher_version: 1, resources: review.resources.map(resource => ({
        kind: resource.kind, key: resource.key, binding: resource.binding,
      })) }),
      resource_review: structuredClone(review),
      connection_id: null, account_id: null, resources: [], dependencies: [],
      children: [], child_inventory: { complete: true }, nested_recipe: null,
      label: call.manifest.name,
      detail: 'Apply only the exact changes and resource versions shown below. A conflict requires a new review.',
    };
  };
