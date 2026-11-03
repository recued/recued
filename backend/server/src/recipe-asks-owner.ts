/** D-337 slice L — whether a recipe run in a conversation would ask the owner partway through,
 *  read off its steps before it runs.
 *
 *  Slice K holds back a further call of a turn while one of it waits for the owner's approval,
 *  where the call would ask them. A write the chat proposes and a pack action are known to ask
 *  before anything runs; a recipe asks only when it reaches the step that does, after the steps
 *  before it have run. So a recipe called while a call of its turn waits is read here first, and
 *  one that may ask is not run (`not_asked_yet`): the model runs it once the conversation carries
 *  on. A recipe that cannot ask (reads, and writes the owner's own runs make without asking) runs
 *  as before.
 *
 *  Each step is put to the decision the run's own gate makes for it (`admitByOpRisk`, at the
 *  source's ceiling: the owner's `admin` holds only an always-ask action, and the review lifts
 *  make a send, a browser action or a commitment proposal ask), and a pack operation to its
 *  catalog's own setting (destructive, or set to ask every time). The owner's own standing ruling
 *  for an action (`ownerRuling`, read as the run reads it: a simple ingredient by its slug twice,
 *  a catalog operation by its catalog and operation) replaces the catalog's, as it does at run time.
 *
 *  ⛔ A STEP IT CANNOT READ COUNTS AS ASKING: a templated op, an op no installed pack serves, an
 *  operation its catalog does not declare. Erring that way holds a call back until the owner
 *  answers; erring the other way would put a second approval to them, which is what slice K is
 *  for. A pure step (transform, guard) never asks.
 *
 *  A vendor-neutral write (`core.crm.*`) runs on the operation of whichever CRM the run binds:
 *  it asks when any CRM the owner has would ask for it (`neutralWriteTargets`, slice O), and
 *  counts as asking when none resolves. Its read never asks.
 *
 *  ⚠ NOT SEEN: a connection's own escalation of an action (its profile's per-action risk or
 *  approval), set on the connection the run picks (none is set today: every profile is built with
 *  only its allowed operations), and, with no `ownerRuling` (a host that does not hold the
 *  contract store), the owner's rulings: a recipe held only by one of those still asks when it
 *  reaches the step, as before slice L. */
import {
  admitByOpRisk,
  getKernelOp,
  kernelOpForBackingSlug,
  kernelOpRiskTier,
  parseOpId,
  resolveTrustCeiling,
  type ExecutionSource,
  type IngredientManifest,
  type OperationSpec,
  type OwnerOverridePolicy,
  type RecipeDefinition,
  type RiskTier,
} from '@recued/contracts';
import type { PackOpResolution } from '@recued/recipes';

export interface RecipeAskLookups {
  /** The catalog each installed pack's operations run on (`buildPackOpResolution`). */
  readonly packOps: () => PackOpResolution;
  readonly getManifest: (slug: string) => IngredientManifest | null | undefined;
  /** The owner's standing ruling for an action (`readOwnerOperationOverride`). */
  readonly ownerRuling?: (ingredient_id: string, operation_id: string) => OwnerOverridePolicy | undefined;
  /** D-337 slice O — the vendor operations a vendor-neutral CRM write can run on, one per catalog
   *  of the owner's CRM connections (`vendorNeutralWriteTargets`). `undefined`: not known. */
  readonly neutralWriteTargets?: (crmAlias: string, verb: string) =>
    ReadonlyArray<{ readonly catalog_slug: string; readonly operation: string }> | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** The run's own gate, for a simple ingredient of this tier, as `source`, with the owner's ruling. */
const gateAsks = (slug: string, risk_tier: RiskTier, source: ExecutionSource, lookups: RecipeAskLookups): boolean => {
  const owner_override = lookups.ownerRuling?.(slug, slug);
  return admitByOpRisk({
    slug, risk_tier, ceiling: resolveTrustCeiling(source), source,
    ...(owner_override !== undefined ? { owner_override } : {}),
  }).verdict !== 'admit';
};

/** A catalog operation's setting, the owner's ruling over the catalog's: destructive, or set to
 *  ask every time. At the owner's ceiling an `ask` is admitted, so only those hold. */
const specAsks = (
  catalog_slug: string,
  operation: string,
  spec: OperationSpec | undefined,
  lookups: RecipeAskLookups,
): boolean => {
  if (spec === undefined) return true;
  const owner = lookups.ownerRuling?.(catalog_slug, spec.operation_id ?? operation);
  return (owner?.risk ?? spec.risk_tier) === 'destructive' || (owner?.approval ?? spec.approval) === 'always';
};

const catalogSpec = (
  manifest: IngredientManifest | undefined,
  operation: string,
): OperationSpec | undefined => {
  const ops = manifest?.operations as Record<string, OperationSpec> | undefined;
  return ops !== undefined && Object.prototype.hasOwnProperty.call(ops, operation) ? ops[operation] : undefined;
};

const kernelOpAsks = (opId: string, source: ExecutionSource, lookups: RecipeAskLookups): boolean => {
  const entry = getKernelOp(opId);
  if (entry !== undefined && typeof entry.backing_slug === 'string' && entry.backing_slug.length > 0) {
    return gateAsks(entry.backing_slug, entry.risk, source, lookups);
  }
  // A vendor-neutral op (`core.crm.*`) runs on the operation of whichever CRM the run binds. A
  // read cannot ask the owner. A write asks when any CRM the owner has would ask for it, each
  // operation read as the run reads it, the owner's ruling included; one that resolves to no
  // operation (no CRM, or an alias none of them serves) counts as asking.
  if (kernelOpRiskTier(opId) === 'read') return false;
  const parsed = parseOpId(opId);
  const [alias, verb, ...rest] = parsed !== null && parsed.tier === 'kernel' && parsed.domain === 'crm'
    ? parsed.op.split('.') : [];
  const targets = alias !== undefined && verb !== undefined && rest.length === 0
    ? lookups.neutralWriteTargets?.(alias, verb) : undefined;
  if (targets === undefined || targets.length === 0) return true;
  return targets.some((target) => specAsks(target.catalog_slug, target.operation,
    catalogSpec(lookups.getManifest(target.catalog_slug) ?? undefined, target.operation), lookups));
};

const stepAsks = (step: unknown, source: ExecutionSource, lookups: RecipeAskLookups): boolean => {
  if (!isRecord(step)) return true;
  if (typeof step.transform === 'string' || typeof step.guard === 'string') return false;
  if (typeof step.op === 'string') {
    if (step.op.includes('{{')) return true;
    const parsed = parseOpId(step.op);
    if (parsed === null) return true;
    if (parsed.tier === 'kernel') return kernelOpAsks(step.op, source, lookups);
    const binding = lookups.packOps().get(parsed.pack_ref);
    if (binding === undefined || !binding.operations.has(parsed.operation)) return true;
    return specAsks(binding.catalog_slug, parsed.operation,
      catalogSpec(lookups.getManifest(binding.catalog_slug) ?? undefined, parsed.operation), lookups);
  }
  if (typeof step.ingredient === 'string') {
    const backing = kernelOpForBackingSlug(step.ingredient);
    if (backing !== undefined) return kernelOpAsks(backing, source, lookups);
    const manifest = lookups.getManifest(step.ingredient) ?? undefined;
    if (manifest === undefined) return true;
    const operation = isRecord(step.input) ? step.input.operation : undefined;
    if (manifest.operations !== undefined && Object.keys(manifest.operations).length > 0) {
      return typeof operation !== 'string' || operation.includes('{{')
        || specAsks(manifest.slug ?? step.ingredient, operation, catalogSpec(manifest, operation), lookups);
    }
    return manifest.risk_tier === undefined || gateAsks(step.ingredient, manifest.risk_tier, source, lookups);
  }
  return true;
};

/** May this recipe, run as `source`, ask the owner partway through? */
export const recipeMayAsk = (
  recipe: RecipeDefinition,
  source: ExecutionSource,
  lookups: RecipeAskLookups,
): boolean => {
  const steps: unknown[] = [
    ...((recipe.prefetch_steps ?? []) as unknown[]),
    ...((recipe.steps ?? []) as unknown[]),
    ...((recipe.trigger_steps ?? []) as unknown[]),
  ];
  return steps.some((step) => stepAsks(step, source, lookups));
};
