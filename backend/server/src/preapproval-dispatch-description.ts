/** D-261's common call description, shared by preparation and live matching.
 * Runtime binding resolvers provide identity and child inventory only. The
 * normal admission result remains separate and can never be supplied by an
 * ingredient, a recipe, or an RPC caller. */
import {
  closedRequestSchemaViolation, kernelOpForBackingSlug, parsePreapprovalJson,
  routePlatformRecordOperationArgs, routeQualifiedWorkEntityOperationArgs,
  type PreapprovalBindingFamily, type PreapprovalJson,
} from '@recued/contracts';
import { describeCatalogDispatch } from '@recued/engine';
import { resolveDispatchSlot } from '@recued/ingredients';
import { preapprovalHash } from './preapproval-invocations.js';
import type { PreapprovalPreparationDeps, PreapprovalCallDescription, PreapprovalResolvedCall } from './preapproval-prepare.js';

export interface PreapprovalRuntimeIdentity {
  family: PreapprovalBindingFamily;
  /** Secret-free identity of the actual connection/account, executable,
   * browser document, or selected model/request built by that dispatcher. */
  binding: PreapprovalJson;
  connection_id: string | null;
  account_id: string | null;
  resources: PreapprovalResolvedCall['material']['resources'];
  /** A dispatcher such as AI may normalize a frozen request further using
   * its own pure request builder. That exact request becomes review material. */
  normalized_input?: Record<string, PreapprovalJson>;
  dispatch_snapshot?: PreapprovalJson;
  children: PreapprovalResolvedCall['children'];
  parallel_children?: true;
  child_inventory: PreapprovalResolvedCall['child_inventory'];
  nested_recipe: PreapprovalResolvedCall['nested_recipe'];
  dependencies: PreapprovalResolvedCall['dependencies'];
  label: string;
  detail: string;
}
export interface PreapprovalNormalAdmission {
  verdict: 'admit' | 'ask' | 'deny';
  risk: PreapprovalResolvedCall['material']['risk'];
  /** Before recipe grants, session grants and other ask-satisfying lifts. */
  approval: PreapprovalResolvedCall['material']['pre_lift_approval'];
  reason: string | null;
}
export type PreapprovalCall = Parameters<PreapprovalPreparationDeps['describe']>[0];
type Call = PreapprovalCall;
const unresolved = (reason: string, opId: string | null = null): PreapprovalCallDescription =>
  ({ kind: 'unresolved', reason, op_id: opId, subtree: true });

/** The same closed schema and qualified-id routing as the catalog gateway,
 * before both normal admission and binding identity resolution. */
export const normalizePreapprovalCall = (call: Call): Call => {
  if (!call.catalog) return call;
  const key = call.input.operation;
  if (typeof key !== 'string' || !Object.hasOwn(call.manifest.operations ?? {}, key)) throw new Error('The catalog operation is not statically declared.');
  const operation = call.manifest.operations![key]!;
  const raw = call.input.args ?? {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('The catalog arguments are not a concrete object.');
  let args = routeQualifiedWorkEntityOperationArgs({ manifest: call.manifest, operation: key,
    connection_name: call.connection_name, args: raw }).args;
  args = routePlatformRecordOperationArgs({ id_arg: operation.record_id_arg, operation: key,
    connection_name: call.connection_name, args }).args;
  const violation = closedRequestSchemaViolation(operation.request_schema, args);
  if (violation !== null) throw new Error(`The operation input is invalid: ${violation}`);
  return { ...call, input: { ...call.input, args: parsePreapprovalJson(args) } };
};

export const describePreapprovalInvocation = (
  call: Call, runtime: PreapprovalRuntimeIdentity, admission: PreapprovalNormalAdmission,
): PreapprovalCallDescription => {
  const { manifest } = call;
  let opId = kernelOpForBackingSlug(call.slug) ?? call.slug;
  let args: Record<string, unknown> = call.input;
  let binding: unknown = { dispatch_slot: resolveDispatchSlot(manifest) };
  if (call.catalog) {
    const key = call.input.operation;
    if (typeof key !== 'string' || !Object.hasOwn(manifest.operations ?? {}, key)) {
      return unresolved('The catalog operation is not statically declared.');
    }
    const operation = manifest.operations![key]!;
    opId = operation.operation_id;
    try {
      args = normalizePreapprovalCall(call).input.args as Record<string, PreapprovalJson>;
      const described = describeCatalogDispatch(manifest, key, args, call.connection_name);
      if (!described) return unresolved('The catalog has no supported dispatch binding.', opId);
      if (described.family !== runtime.family) return unresolved('The resolved runtime no longer matches the catalog binding.', opId);
      binding = { family: described.family, binding: described.binding, dispatch_input: described.input };
    } catch (error) {
      return unresolved(error instanceof Error ? error.message : 'The operation target cannot be resolved.', opId);
    }
  }
  const input = runtime.normalized_input ?? parsePreapprovalJson(args) as Record<string, PreapprovalJson>;
  const reason = admission.verdict === 'deny' ? admission.reason ?? 'The original contract does not authorize this operation.' : null;
  return { kind: 'resolved', call: {
    material: {
      op_id: opId, ingredient_slug: call.slug, family: runtime.family, identity_version: 1,
      definition_hash: preapprovalHash(parsePreapprovalJson(manifest)),
      binding_hash: preapprovalHash({ dispatcher: binding, runtime: runtime.binding }),
      ...(runtime.dispatch_snapshot !== undefined ? { dispatch_snapshot: runtime.dispatch_snapshot } : {}),
      input, output: call.output, resources: runtime.resources,
      connection_id: runtime.connection_id, account_id: runtime.account_id,
      risk: admission.risk, pre_lift_approval: admission.approval,
    },
    review: { label: runtime.label, detail: runtime.detail, ineligible_reason: reason },
    children: runtime.children, child_inventory: runtime.child_inventory,
    ...(runtime.parallel_children ? { parallel_children: true } : {}),
    nested_recipe: runtime.nested_recipe, dependencies: runtime.dependencies,
  } };
};
