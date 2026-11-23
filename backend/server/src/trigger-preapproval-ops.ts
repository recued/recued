/** D-341 slice B1 — the op each of a recipe's own steps calls, as a trigger's pre-approval names
 *  it, and the op a gate's call is.
 *
 *  🔑 ONE IDENTITY, D-211's: an owner ruling names an op the way the gate resolves it. A catalog
 *  op by the qualified `operation_id` its manifest declares (a Records or MCP pack's own op is
 *  `<publisher>.<pack>.<op>`; an API composition's is its author's), and a single-op ingredient
 *  by its slug (a kernel op lowers to one, `core.dom.click` to `dom-click`).
 *
 *  ⛔ WHY NOT THE STEP'S `op`: an installed recipe is stored LOWERED (`lowerTwoTierOpSteps` at
 *  install), so its steps carry `ingredient` + `input.operation`, never the `op` they were authored
 *  with. Reading `op` matched nothing on a real install (live, 2026-11-08) while every test that
 *  registered a recipe by hand passed. Each step is lowered here as a run lowers it, then named
 *  through its manifest.
 *
 *  A step whose target or operation is templated names none: event content must never choose
 *  which op a pre-approval covers.
 *
 *  🔑 B7 (ruling 14, the owner: "The neutral write") — a vendor-neutral write (`core.crm.deal.update`)
 *  is named by its neutral name, which the recipe's version fixes. The run picks its CRM, and with it
 *  the op it calls (`recued-core/hubspot-catalog.deal.update`, Salesforce's `opportunity.update`),
 *  only when it runs, on the step id the resolver gives that call (`<step>__raw`): any CRM's op that
 *  serves the neutral one is that write, a CRM connected after the grant, or one a record id in the
 *  event points to, included. The owner's own ruling on each vendor's op still holds at the gate,
 *  which asks before it consults a pre-approval. A vendor-neutral read never asks, so names none. */

import {
  approvalFloorForRisk,
  isCatalogForm,
  isOperationApproval,
  getVendorEntityByVendorEntity,
  grantSwitchText,
  isRiskTier,
  kernelOpForBackingSlug,
  kernelOpRiskTier,
  opAlwaysReviewed,
  parseOpId,
  stripCorePrefix,
  triggerPreapprovalHasDoor,
  type IngredientManifest,
  type OwnerOverridePolicy,
  type RecipeDefinition,
  type TriggeredRun,
  type TriggerPreapprovalAdmission,
  type TriggerPreapprovalChoiceWrite,
  type TriggerPreapprovalOffer,
} from '@recued/contracts';
import { lowerOpStepRecipe, type PackOpResolution } from '@recued/recipes';

import { liveCatalogVendors } from './connection-convention-families.js';
import type { LocalManifestStore } from './ingredient-authoring/local-manifest-store.js';

export interface TriggerPreapprovalOpDeps {
  readonly manifestOf: (slug: string) => IngredientManifest | null | undefined;
  /** B7 — the vendor-neutral write a CRM's catalog op serves (`core.crm.deal.update` for HubSpot's
   *  `deal.update` and Salesforce's `opportunity.update`), by the live vendor registry. Absent ⇒ no
   *  vendor-neutral write is ever matched. */
  readonly neutralWriteOf?: NeutralWriteOf;
  /** The installed packs' catalogs, for a step still written as a pack's `op`. */
  readonly packs?: PackOpResolution;
  /** The owner's own ruling on an op (D-211), as the gates read it: by the ingredient and the op. */
  readonly ownerOverrideOf?: (ingredient_id: string, operation_id: string) => OwnerOverridePolicy | undefined;
}

const fixed = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && !value.includes('{{');

/** B7 — the vendor-neutral write a gate's catalog call serves, or undefined. */
export type NeutralWriteOf = (call: { readonly slug: string; readonly operation_id?: string }) => string | undefined;

/** The suffix the vendor-neutral resolver gives the step that calls its CRM's op
 *  (`connection-agnostic.ts`: `<step>__raw`, reserved: no authored step has it). */
const RAW_SUFFIX = '__raw';

/** B7 — a vendor-neutral CRM write: `core.crm.<record>.<verb>`, a write (a delete is destructive and
 *  always asks; a search or a read never does). */
export const isNeutralWrite = (op: unknown): op is string => {
  if (typeof op !== 'string') return false;
  const parsed = parseOpId(op);
  return parsed !== null && parsed.tier === 'kernel' && parsed.domain === 'crm' && kernelOpRiskTier(op) === 'write';
};

/** B7 — a vendor-neutral write in the owner's words: "Update a deal in your CRM". */
export const describeNeutralWrite = (op: string): string => {
  const [record, verb] = (parseOpId(op) as { op: string } | null)?.op.split('.') ?? [];
  const noun = record === 'account' ? 'an account' : `a ${record ?? 'record'}`;
  return verb === 'create' ? `Add ${noun} to your CRM` : verb === 'update' ? `Change ${noun} in your CRM` : op;
};

/** The op a concrete step calls: its ingredient's, by the manifest. */
const opOfConcreteStep = (step: Record<string, unknown>, deps: TriggerPreapprovalOpDeps): string | undefined => {
  if (!fixed(step.ingredient)) return undefined;
  const manifest = deps.manifestOf(step.ingredient) ?? null;
  if (!isCatalogForm(manifest)) return step.ingredient;
  const input = step.input as { operation?: unknown } | undefined;
  if (!fixed(input?.operation)) return undefined;
  const spec = (manifest!.operations as Record<string, { operation_id?: unknown } | undefined>)[input.operation];
  return fixed(spec?.operation_id) ? spec.operation_id : undefined;
};

/** One step, lowered as a run lowers it (alone, so another step's unresolvable op names none
 *  here and leaves this one's alone). */
const lowered = (
  recipe: RecipeDefinition,
  where: 'steps' | 'prefetch_steps' | 'trigger_steps',
  step: unknown,
  packs: PackOpResolution,
): Record<string, unknown> | undefined => {
  try {
    const one = lowerOpStepRecipe({ ...recipe, steps: [], prefetch_steps: [], trigger_steps: [], [where]: [step] } as RecipeDefinition, packs);
    return (one[where] as unknown[] | undefined)?.[0] as Record<string, unknown> | undefined;
  } catch {
    return undefined;
  }
};

/** Each step as a run lowers it, by step id; a step that does not lower is absent. */
const concreteSteps = (recipe: RecipeDefinition, deps: TriggerPreapprovalOpDeps): Map<string, Record<string, unknown>> => {
  const steps = new Map<string, Record<string, unknown>>();
  const packs = deps.packs ?? new Map();
  for (const where of ['trigger_steps', 'prefetch_steps', 'steps'] as const) {
    for (const step of (recipe[where] ?? []) as unknown[]) {
      const id = (step as { id?: unknown }).id;
      if (typeof id !== 'string') continue;
      const concrete = lowered(recipe, where, step, packs);
      if (concrete !== undefined) steps.set(id, concrete);
    }
  }
  return steps;
};

/** The op each step calls, by step id. A step that calls none (a transform, a guard) or whose op
 *  is not fixed by the recipe is absent. */
export const recipeStepOps = (recipe: RecipeDefinition, deps: TriggerPreapprovalOpDeps): Map<string, string> => {
  const ops = new Map<string, string>();
  for (const [id, step] of concreteSteps(recipe, deps)) {
    const op = opOfConcreteStep(step, deps);
    if (op !== undefined) ops.set(id, op);
  }
  // B7 — a vendor-neutral write by its neutral name, as the version fixes it.
  for (const [id, op] of neutralWriteSteps(recipe)) if (!ops.has(id)) ops.set(id, op);
  return ops;
};

/** B7 — each step that makes a vendor-neutral write, by step id, as authored (a recipe whose pack
 *  ships no vendor of its own keeps it so when installed). */
const neutralWriteSteps = (recipe: RecipeDefinition): Map<string, string> => {
  const steps = new Map<string, string>();
  for (const where of ['trigger_steps', 'prefetch_steps', 'steps'] as const) {
    for (const step of (recipe[where] ?? []) as unknown[]) {
      const { id, op } = (step ?? {}) as { id?: unknown; op?: unknown };
      if (typeof id === 'string' && isNeutralWrite(op)) steps.set(id, op);
    }
  }
  return steps;
};

/** The first sentence of a description, without its full stop, or undefined. */
const firstSentence = (text: unknown): string | undefined => {
  if (typeof text !== 'string') return undefined;
  const sentence = text.trim().split(/(?<=[.!?])\s/u)[0]?.replace(/[.!?]$/u, '').trim();
  return sentence !== undefined && sentence !== '' ? sentence : undefined;
};

/** What an op does, in the owner's words. Recued's own op is named as its switch is on the
 *  Contracts page (`grantSwitchText`, "Save a value"): its manifest's description is written for
 *  the AI that calls it ("Persist a value under a shared.* (cache tier, LRU+TTL) or data.shared.* …
 *  key"), and a recipe's trigger page and pre-approvals showed it so. Any other op by the first
 *  sentence of what its operation (or its single-op ingredient) says it does, else by its own
 *  name. */
const opLabel = (op: string, said: unknown): string => {
  const kernel = kernelOpForBackingSlug(op);
  return (kernel !== undefined ? grantSwitchText(kernel)?.title : undefined) ?? firstSentence(said) ?? op;
};

/** D-177 N.15 (§N.15.6 ruling 3) — what a gate's held call does, in the owner's words (`opLabel`),
 *  read off the manifest of the ingredient it dispatched: a catalog op's own description (the gate
 *  records it by its key or its declared id), else the single-op ingredient's. Undefined when only
 *  the op's id would name it, so "Allow in this chat" is offered only in words the owner reads. */
export const heldCallOpLabel = (
  call: { readonly slug: string; readonly operation_id?: string },
  manifestOf: (slug: string) => IngredientManifest | null | undefined,
): string | undefined => {
  const op = triggerPreapprovalCallOp(call);
  const manifest = manifestOf(call.slug) ?? null;
  const said = !isCatalogForm(manifest) ? manifest?.description
    : call.operation_id === undefined ? undefined
    : Object.entries(manifest!.operations as Record<string, { operation_id?: unknown; description?: unknown } | undefined>)
      .find(([key, spec]) => key === call.operation_id || spec?.operation_id === call.operation_id)?.[1]?.description;
  const label = opLabel(op, said);
  return label === op ? undefined : label;
};

/** The owner's words for each op a recipe's steps call (`opLabel`). */
export const recipeStepOpLabels = (recipe: RecipeDefinition, deps: TriggerPreapprovalOpDeps): Map<string, string> => {
  const labels = new Map<string, string>();
  for (const op of neutralWriteSteps(recipe).values()) labels.set(op, describeNeutralWrite(op));
  for (const step of concreteSteps(recipe, deps).values()) {
    const op = opOfConcreteStep(step, deps);
    if (op === undefined || labels.has(op)) continue;
    const manifest = deps.manifestOf(step.ingredient as string) ?? null;
    const operation = (step.input as { operation?: unknown } | undefined)?.operation;
    const said = isCatalogForm(manifest) && typeof operation === 'string'
      ? (manifest!.operations as Record<string, { description?: unknown } | undefined>)[operation]?.description
      : manifest?.description;
    labels.set(op, opLabel(op, said));
  }
  return labels;
};

/** D-341 slice B2b — the writes a recipe's steps make, as the trigger's page offers them: each op
 *  once, in step order, in the owner's words, and whether a pre-approval may name it. Reads are left
 *  out: they never ask. A destructive op, one the gate always reviews (`opAlwaysReviewed`: a
 *  proposal, a quote, a workflow), and one whose approval is `always`, are listed but not offered:
 *  the gates would ask anyway. Risk and approval are read as the gates read them: the
 *  owner's own ruling on the op (D-211) in place of the pack's, else the risk's floor. ⚠ Not a
 *  connection's own escalation of an op (a source profile): that one is per run. */
export const recipeStepWrites = (recipe: RecipeDefinition, deps: TriggerPreapprovalOpDeps): TriggerPreapprovalChoiceWrite[] => {
  const writes: TriggerPreapprovalChoiceWrite[] = [];
  const seen = new Set<string>();
  for (const step of concreteSteps(recipe, deps).values()) {
    const op = opOfConcreteStep(step, deps);
    if (op === undefined || seen.has(op)) continue;
    seen.add(op);
    const manifest = deps.manifestOf(step.ingredient as string) ?? null;
    const operation = (step.input as { operation?: unknown } | undefined)?.operation;
    const spec = isCatalogForm(manifest) && typeof operation === 'string'
      ? (manifest!.operations as Record<string, { risk_tier?: unknown; approval?: unknown; description?: unknown } | undefined>)[operation]
      : undefined;
    const ruling = deps.ownerOverrideOf?.(step.ingredient as string, op);
    const authored = isRiskTier(spec?.risk_tier) ? spec!.risk_tier : isRiskTier(manifest?.risk_tier) ? manifest!.risk_tier : undefined;
    const risk = ruling?.risk ?? authored;
    if (risk === undefined || risk === 'read') continue;
    const approval = ruling?.approval ?? (isOperationApproval(spec?.approval) ? spec!.approval : undefined)
      ?? approvalFloorForRisk(risk);
    const label = opLabel(op, spec !== undefined ? spec.description : manifest?.description);
    writes.push(risk === 'destructive'
      ? { op, label, offerable: false, reason: 'It deletes or can\'t be undone.' }
      : opAlwaysReviewed(op)
        ? { op, label, offerable: false, reason: 'Each one needs your review.' }
        : approval === 'always'
          ? { op, label, offerable: false, reason: 'It\'s set to ask every time.' }
          : { op, label, offerable: true });
  }
  // B7 — a vendor-neutral write: a write, which each CRM's own op still answers for at the gate (a
  // CRM's op set to ask every time asks every time).
  for (const op of neutralWriteSteps(recipe).values()) {
    if (seen.has(op)) continue;
    seen.add(op);
    writes.push({ op, label: describeNeutralWrite(op), offerable: true });
  }
  return writes;
};

/** The steps that ask an AI: an ingredient of kind `ai` (or the retired `chat`), a kernel
 *  `core.ai.*` op, a legacy `ai-*` alias. Ruling 8 (2026-11-08): a pre-approval may cover writes
 *  whose values an AI decides; these are what the page, the ask and the view say about it ("Its AI
 *  decides what it writes"). A step that does not lower (an op from a pack not installed) or whose
 *  target is templated is counted as one, so the owner is told rather than not. ⚠ An agent CLI
 *  pack's op is not recognised as AI here. */
export const recipeAiSteps = (recipe: RecipeDefinition, deps: TriggerPreapprovalOpDeps): string[] => {
  const concrete = concreteSteps(recipe, deps);
  const ai: string[] = [];
  for (const where of ['trigger_steps', 'prefetch_steps', 'steps'] as const) {
    for (const step of (recipe[where] ?? []) as unknown[]) {
      const id = (step as { id?: unknown }).id;
      if (typeof id !== 'string') continue;
      const raw = step as { op?: unknown; ingredient?: unknown };
      const lowered = concrete.get(id);
      if (lowered === undefined) {
        if (typeof raw.op === 'string' || typeof raw.ingredient === 'string') ai.push(id);
        continue;
      }
      const slug = lowered.ingredient;
      if (typeof slug !== 'string') continue;
      // A target the run decides could be an AI's: counted as one.
      if (slug.includes('{{')) { ai.push(id); continue; }
      const kind = (deps.manifestOf(slug) ?? null)?.kind;
      // A kernel `core.ai.*` op lowers to its `core-ai-<fn>` slug, which strips to `ai-<fn>`.
      if (kind === 'ai' || kind === 'chat' || stripCorePrefix(slug).startsWith('ai-')) ai.push(id);
    }
  }
  return ai;
};

/** The op a gate's call is: the catalog gate's own resolution for a catalog op, else the slug. */
export const triggerPreapprovalCallOp = (call: { readonly slug: string; readonly operation_id?: string }): string =>
  call.operation_id ?? call.slug;

/** The op a held call may be pre-approved as: its step's own, and only when the call is that op.
 *  ⛔ A step that dispatches something else under its id (a dispatcher, a target the run decides)
 *  is not what was pre-approved. */
export const preapprovableOp = (
  stepOps: ReadonlyMap<string, string>,
  call: TriggerPreapprovalAdmission,
  /** B7 — what a CRM's catalog op serves, for a vendor-neutral write's call. */
  neutralWriteOf?: NeutralWriteOf,
): string | undefined => {
  if (call.step_id === undefined) return undefined;
  const op = stepOps.get(call.step_id);
  if (op !== undefined) return op === triggerPreapprovalCallOp(call) ? op : undefined;
  // B7 — a vendor-neutral write's call, on the id the resolver gives it: its CRM's op, which must
  // serve that very write.
  if (neutralWriteOf === undefined || !call.step_id.endsWith(RAW_SUFFIX)) return undefined;
  const neutral = stepOps.get(call.step_id.slice(0, -RAW_SUFFIX.length));
  return neutral !== undefined && isNeutralWrite(neutral) && neutralWriteOf(call) === neutral ? neutral : undefined;
};

/** B7 — what a CRM's catalog op serves, read from its manifest (the operation whose `operation_id`
 *  the gate resolved) and the live vendor registry (its record's `crm_alias`): `core.crm.deal.update`
 *  for HubSpot's `deal.update` and Salesforce's `opportunity.update`. Undefined for an op of no
 *  CRM, a record with no alias, or a verb that is no write. */
export const createNeutralWriteOf = (deps: {
  readonly manifestOf: (slug: string) => IngredientManifest | null | undefined;
  readonly localManifestStore?: Pick<LocalManifestStore, 'listManifests' | 'getEntitySchemas'>;
}): NeutralWriteOf => (call) => {
  if (call.operation_id === undefined) return undefined;
  const manifest = deps.manifestOf(call.slug) ?? null;
  if (!isCatalogForm(manifest)) return undefined;
  const operation = Object.entries(manifest!.operations as Record<string, { operation_id?: unknown } | undefined>)
    .find(([, spec]) => spec?.operation_id === call.operation_id)?.[0];
  const [record, verb, ...rest] = operation?.split('.') ?? [];
  if (record === undefined || verb === undefined || rest.length > 0) return undefined;
  const { registry, vendorForCatalog } = liveCatalogVendors(deps.localManifestStore);
  const vendor = vendorForCatalog(call.slug);
  const alias = vendor === undefined ? undefined : getVendorEntityByVendorEntity(vendor, record, registry)?.crm_alias;
  const neutral = alias === undefined || alias === null ? undefined : `core.crm.${alias}.${verb}`;
  return isNeutralWrite(neutral) ? neutral : undefined;
};

/** D-341 slice B2 — what a held write's "Always allow for this webhook / schedule / trigger / form" would
 *  grant, or nothing. Offered only where a pre-approval could admit the write, as the gates check
 *  before they do: a trigger's run; one held call (no foreach cover); the hold the run's own
 *  ceiling makes (no review lift), which the owner's policy leaves waivable, below destructive; the
 *  op the held step calls, which the call is. A recipe that asks an AI is offered it too (ruling 8),
 *  marked so the ask says its AI decides what it writes. */
export const triggerPreapprovalOfferFor = (input: {
  readonly run: TriggeredRun | undefined;
  readonly recipe: RecipeDefinition;
  readonly recipe_sha256: string;
  readonly held: {
    readonly gated_step_id?: string;
    /** The held call's ingredient (or tool) slug, and a catalog op's id. */
    readonly slug?: string;
    readonly operation_id?: string;
    readonly risk_tier?: string;
    readonly provenance?: { readonly pre_lift_approval?: string; readonly lift_reason?: string };
    /** False for a held `foreach` step, whose one approval covers many calls. */
    readonly single: boolean;
  };
  readonly deps: TriggerPreapprovalOpDeps;
}): TriggerPreapprovalOffer | undefined => {
  const { run, held } = input;
  if (run === undefined || !held.single || held.slug === undefined || held.gated_step_id === undefined) return undefined;
  if (held.risk_tier === 'destructive' || held.provenance === undefined || held.provenance.lift_reason !== undefined) return undefined;
  if (held.provenance.pre_lift_approval !== 'never' && held.provenance.pre_lift_approval !== 'ask') return undefined;
  // A webhook's or a form's run pins its door: a door-less one could never be covered.
  if (triggerPreapprovalHasDoor(run.trigger.kind) && run.door_contract_id === undefined) return undefined;
  const op = preapprovableOp(recipeStepOps(input.recipe, input.deps), {
    slug: held.slug, ...(held.operation_id !== undefined ? { operation_id: held.operation_id } : {}),
    step_id: held.gated_step_id, risk_tier: 'write',
  }, input.deps.neutralWriteOf);
  if (op === undefined) return undefined;
  return {
    trigger: run.trigger,
    ...(run.door_contract_id !== undefined ? { door_contract_id: run.door_contract_id } : {}),
    recipe_id: input.recipe.recipe_id,
    recipe_sha256: input.recipe_sha256,
    op,
    // B6 — a recipe a scheduled prompt started: its AI started it and gave it its settings.
    ...(run.prompt_sha256 !== undefined || recipeAiSteps(input.recipe, input.deps).length > 0 ? { asks_ai: true as const } : {}),
    ...(run.prompt_sha256 !== undefined ? { prompt_sha256: run.prompt_sha256 } : {}),
  };
};
