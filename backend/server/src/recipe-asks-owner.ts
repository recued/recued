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
 *  Each step is put to the decision the run's own gate makes for it (`admitByOpRisk` for a
 *  simple ingredient, the catalog resolver for a pack operation, both at the source's ceiling:
 *  in the owner's chat every `ask` asks and an author's `never` runs, D-177 §N.15.7; from the app
 *  only an always-ask action holds; a commitment proposal always asks). The owner's own standing ruling
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
 *  reaches the step, as before slice L.
 *
 *  🔑 D-402 slice F1 (§7.4, "One classifier decides") — the same reading, step by step and with the
 *  reason (`classifyRecipeAsks`): each step never asks, asks and can be approved ahead (`ahead`: a
 *  pre-approval may stand in for its ask, as both gates let one, D-341 B1), or asks every time it
 *  runs (`still`): destructive, a review an op always gets, set to ask every time, a browser batch
 *  that puts one of the owner's files into a page, refused here, or not readable before the run.
 *  It also reads what the question before a run says beside that: the steps that ask an AI, the
 *  kinds of secret a browser batch types, the steps that save a downloaded file, and the steps of a
 *  recipe one of its operations runs (D-232), as that recipe's own (`via`). `recipeMayAsk` is its
 *  yes or no. */
import {
  admitByOpRisk,
  browserActReadsOnly,
  getKernelOp,
  honorsAuthoredNever,
  resolveCatalogOperationPolicy,
  kernelOpForBackingSlug,
  kernelOpRiskTier,
  parseBrowserActSteps,
  parseOpId,
  resolveTrustCeiling,
  stripCorePrefix,
  type AuthorizationProvenance,
  type BrowserActSecret,
  type ExecutionSource,
  type IngredientManifest,
  type OperationSpec,
  type OwnerOverridePolicy,
  type RecipeDefinition,
  type RiskTier,
} from '@recued/contracts';
import { describeCatalogAuthority } from '@recued/engine';
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
  /** D-402 slice F1 — an installed recipe by its id, for one an operation of the recipe runs
   *  (D-232). Absent: such an operation is read as an operation alone. */
  readonly recipeOf?: (recipe_id: string) => RecipeDefinition | null | undefined;
  /** D-339 slice 12a — would the run's gate let this caller make this read, held at its op's own
   *  `always`, without asking (`HeldReadHooks`, the owner's chats' "Allow" for a Body's numbers)? The
   *  same answer the gate's host gives. Absent: every such read asks. */
  readonly heldReadAllowed?: (source: ExecutionSource, slug: string, operation_id: string) => boolean;
}

/** D-402 slice F1 — what a step does about asking the owner, run as the caller. */
export type RecipeAskVerdict =
  /** It never asks: a pure step, a read, a write this caller's own runs make without asking. */
  | 'never'
  /** It asks, and a pre-approval may stand in for its ask (§7.2). */
  | 'ahead'
  /** It asks every time it runs, whatever was approved ahead. */
  | 'still';

/** Why a step asks every time. */
export type RecipeStillAsks = 'destructive' | 'reviewed' | 'always' | 'upload' | 'refused' | 'unread';

/** Each reason in the owner's words: D-341's for a trigger's page (`recipeStepWrites`), and the rest. */
export const RECIPE_STILL_ASKS_SAID: Readonly<Record<RecipeStillAsks, string>> = {
  destructive: 'It deletes or can\'t be undone.',
  reviewed: 'Each one needs your review.',
  always: 'It\'s set to ask every time.',
  upload: 'It puts one of your files into a page.',
  refused: 'It can\'t run from here.',
  unread: 'What it does is only known when it runs.',
};

export interface RecipeStepAsk {
  readonly step_id: string;
  /** The recipe whose step it is: the one classified, or one an operation of it runs. */
  readonly recipe_id: string;
  /** The steps that ran the recipe it is in, outermost first: empty for the recipe's own. */
  readonly via: readonly string[];
  readonly verdict: RecipeAskVerdict;
  /** Why it asks every time, when it does. */
  readonly reason?: RecipeStillAsks;
  /** What the gate calls: the ingredient's slug, and a catalog operation's id as the gate names it
   *  (D-211). Absent for a step that calls nothing, or one not readable before the run. */
  readonly slug?: string;
  readonly operation_id?: string;
  /** It asks an AI: what later steps write may be its decision (D-341 ruling 8). */
  readonly ai?: true;
  /** A browser batch's secrets, by kind: each asked for as a value at its step when Recued holds none. */
  readonly secrets?: readonly BrowserActSecret[];
  /** It saves a file the run downloads to the owner's files. */
  readonly saves_files?: true;
  /** D-402 slice F3b — for a step that asks: the risk the gate held it at, and the approval before any
   *  review lift, as a grant that could stand in for its ask is matched (`matchesSessionGrant`). */
  readonly risk_tier?: string;
  readonly pre_lift_approval?: string;
}

/** How deep a recipe that runs another is read: deeper ones count as not readable. */
export const RECIPE_ASK_MAX_DEPTH = 8;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

type GateAnswer = {
  readonly verdict: RecipeAskVerdict; readonly reason?: RecipeStillAsks; readonly operation_id?: string;
  readonly risk_tier?: string; readonly pre_lift_approval?: string;
};

const NEVER: GateAnswer = { verdict: 'never' };
const UNREAD: GateAnswer = { verdict: 'still', reason: 'unread' };

/** An ask, as both gates decide whether a pre-approval may stand in for it (the commit gateway and
 *  the catalog gate, D-341 B1): never for a destructive op or a review an op always gets, and only
 *  for the hold the run's own ceiling makes, which the owner's policy leaves at `never` or `ask`. */
const asked = (risk: string, provenance: AuthorizationProvenance | undefined): GateAnswer => {
  const how = { risk_tier: risk, ...(provenance?.pre_lift_approval !== undefined ? { pre_lift_approval: provenance.pre_lift_approval } : {}) };
  if (risk === 'destructive') return { verdict: 'still', reason: 'destructive', ...how };
  if (provenance?.lift_reason !== undefined) return { verdict: 'still', reason: 'reviewed', ...how };
  return provenance?.pre_lift_approval === 'never' || provenance?.pre_lift_approval === 'ask'
    ? { verdict: 'ahead', ...how } : { verdict: 'still', reason: 'always', ...how };
};

/** The run's own gate, for a simple ingredient of this tier, as `source`, with the owner's ruling. */
const gateAnswer = (slug: string, risk_tier: RiskTier, source: ExecutionSource, lookups: RecipeAskLookups): GateAnswer => {
  const owner_override = lookups.ownerRuling?.(slug, slug);
  const decision = admitByOpRisk({
    slug, risk_tier, ceiling: resolveTrustCeiling(source), source,
    ...(owner_override !== undefined ? { owner_override } : {}),
  });
  return decision.verdict === 'admit' ? NEVER
    : decision.verdict === 'deny' ? { verdict: 'still', reason: 'refused' }
      : asked(decision.risk_tier, decision.authorization_provenance);
};

/** A catalog operation, put to the resolver the run's gate uses, at `source`'s ceiling, with the
 *  owner's ruling over the catalog's. D-177 §N.15.7: the owner's chat takes the `read` ceiling, so
 *  an `ask` operation asks there and one its author set to `never` runs; from the app an `ask`
 *  relaxes. This replaced a hand-written "destructive, or set to ask every time", which was right
 *  only at the owner's `admin` ceiling. Access is the run's own concern, so the operation is
 *  resolved as granted. */
const specAnswer = (
  catalog_slug: string,
  operation: string,
  spec: OperationSpec | undefined,
  source: ExecutionSource,
  lookups: RecipeAskLookups,
  manifest?: IngredientManifest,
): GateAnswer => {
  if (spec === undefined) return UNREAD;
  const owner_override = lookups.ownerRuling?.(catalog_slug, spec.operation_id ?? operation);
  const resolution = resolveCatalogOperationPolicy({
    operations: { [operation]: spec },
    operation_id: operation,
    profile: { catalog_slug, allowed_operations: [operation] },
    catalog_slug,
    ceiling: resolveTrustCeiling(source),
    ...(manifest?.default_policy !== undefined ? { default_policy: manifest.default_policy } : {}),
    ...(owner_override !== undefined ? { owner_override } : {}),
    ...(honorsAuthoredNever(source) ? { honor_authored_never: true } : {}),
  });
  // D-339 slice 12a — as the catalog gate does: a read its op holds at its own `always` asks nothing
  // when the caller may make it without asking (the owner's chats on "Allow" for a Body's numbers).
  const provenance = resolution.authorization_provenance;
  if (resolution.verdict === 'ask' && resolution.effective_risk_tier === 'read' && spec.risk_tier === 'read'
    && spec.approval === 'always' && provenance.lift_reason === undefined && provenance.pre_lift_approval === 'always'
    && lookups.heldReadAllowed?.(source, catalog_slug, resolution.operation_id) === true) {
    return { ...NEVER, operation_id: resolution.operation_id };
  }
  const answer = resolution.verdict === 'admit' ? NEVER
    : resolution.verdict === 'deny' ? { verdict: 'still' as const, reason: 'refused' as const }
      : asked(resolution.effective_risk_tier, provenance);
  return { ...answer, operation_id: resolution.operation_id };
};

const catalogSpec = (
  manifest: IngredientManifest | undefined,
  operation: string,
): OperationSpec | undefined => {
  const ops = manifest?.operations as Record<string, OperationSpec> | undefined;
  return ops !== undefined && Object.prototype.hasOwnProperty.call(ops, operation) ? ops[operation] : undefined;
};

/** What a step's answer says of how its gate held it, for a grant to be matched against. */
const gateHow = (answer: GateAnswer): Pick<RecipeStepAsk, 'risk_tier' | 'pre_lift_approval'> => ({
  ...(answer.risk_tier !== undefined ? { risk_tier: answer.risk_tier } : {}),
  ...(answer.pre_lift_approval !== undefined ? { pre_lift_approval: answer.pre_lift_approval } : {}),
});

/** The verdict of several answers, the most asking: `still` (with the first reason) over `ahead`
 *  over `never`. */
const strictest = (answers: readonly GateAnswer[]): GateAnswer =>
  answers.find((answer) => answer.verdict === 'still') ?? answers.find((answer) => answer.verdict === 'ahead') ?? NEVER;

const kernelOpAnswer = (opId: string, source: ExecutionSource, lookups: RecipeAskLookups): GateAnswer & { readonly slug?: string } => {
  const entry = getKernelOp(opId);
  if (entry !== undefined && typeof entry.backing_slug === 'string' && entry.backing_slug.length > 0) {
    return { ...gateAnswer(entry.backing_slug, entry.risk, source, lookups), slug: entry.backing_slug };
  }
  // A vendor-neutral op (`core.crm.*`) runs on the operation of whichever CRM the run binds. A
  // read cannot ask the owner. A write asks when any CRM the owner has would ask for it, each
  // operation read as the run reads it, the owner's ruling included; one that resolves to no
  // operation (no CRM, or an alias none of them serves) counts as asking.
  if (kernelOpRiskTier(opId) === 'read') return NEVER;
  const parsed = parseOpId(opId);
  const [alias, verb, ...rest] = parsed !== null && parsed.tier === 'kernel' && parsed.domain === 'crm'
    ? parsed.op.split('.') : [];
  const targets = alias !== undefined && verb !== undefined && rest.length === 0
    ? lookups.neutralWriteTargets?.(alias, verb) : undefined;
  if (targets === undefined || targets.length === 0) return UNREAD;
  return strictest(targets.map((target) => {
    const manifest = lookups.getManifest(target.catalog_slug) ?? undefined;
    return specAnswer(target.catalog_slug, target.operation, catalogSpec(manifest, target.operation), source, lookups, manifest);
  }));
};

/** The ops whose step saves a file the run downloads to the owner's files: reads (§7.2), listed under
 *  "Also" in the question. */
const SAVES_FILES: ReadonlySet<string> = new Set(['dom-download', 'http-download']);

/** A step that asks an AI: a kernel `core.ai.*` op (its `core-ai-<fn>` slug), an `ai-*` alias, an
 *  ingredient of kind `ai` (or the retired `chat`), as D-341 counts them (`recipeAiSteps`). */
const asksAi = (slug: string | undefined, lookups: RecipeAskLookups): boolean => {
  if (slug === undefined) return false;
  if (stripCorePrefix(slug).startsWith('ai-')) return true;
  const kind = lookups.getManifest(slug)?.kind;
  return kind === 'ai' || kind === 'chat';
};

/** D-402 slice F1 — a browser batch (`core.dom.act`), read as the gates read it: one that only reads
 *  never asks (the gate lets it through, `browserBatchReadsOnly`), on pages open or ones it opens, since
 *  opening a page is a read (2026-11-23); one that changes a page asks, as the gate decides; one that puts
 *  a file into a page asks every time. With the kinds of secret it types and whether it saves a downloaded
 *  file. */
const browserBatch = (call: Record<string, unknown> | undefined, gate: GateAnswer): Pick<RecipeStepAsk, 'verdict' | 'reason' | 'secrets' | 'saves_files' | 'ai'> => {
  const parsed = call === undefined ? undefined : parseBrowserActSteps(call.steps, { page: call.page });
  if (parsed === undefined || !parsed.ok) return gate.verdict === 'never' ? NEVER : UNREAD;
  const secrets = [...new Set(parsed.steps.flatMap((step) => (step.do === 'type' && step.secret !== undefined ? [step.secret] : [])))];
  const extra = {
    ...(secrets.length > 0 ? { secrets } : {}),
    ...(parsed.steps.some((step) => step.do === 'download') ? { saves_files: true as const } : {}),
    // D-402 slice E1 (§6.7) — a question asked of a page is answered by a model at each run.
    ...(parsed.steps.some((step) => step.do === 'ask') ? { ai: true as const } : {}),
  };
  if (gate.verdict === 'never') return { verdict: 'never', ...extra };
  // Only reads, on whichever pages it names, open or opened: opening a page is a read (2026-11-23).
  if (browserActReadsOnly(parsed.steps)) return { verdict: 'never', ...extra };
  if (gate.verdict === 'ahead' && parsed.steps.some((step) => step.do === 'upload')) return { verdict: 'still', reason: 'upload', ...extra };
  return { verdict: gate.verdict, ...(gate.reason !== undefined ? { reason: gate.reason } : {}), ...extra };
};

interface Reading {
  readonly source: ExecutionSource;
  readonly lookups: RecipeAskLookups;
  /** The recipes on the path to this one, itself included: one run again is not read again. */
  readonly held: ReadonlySet<string>;
}

const stepIdOf = (step: unknown, index: number): string =>
  isRecord(step) && typeof step.id === 'string' && step.id !== '' ? step.id : `#${String(index + 1)}`;

/** The recipe a catalog operation runs (D-232), when it runs one and it is installed. */
const localRecipeOf = (manifest: IngredientManifest | undefined, operation: string, lookups: RecipeAskLookups): RecipeDefinition | undefined => {
  if (manifest === undefined || lookups.recipeOf === undefined) return undefined;
  const authority = describeCatalogAuthority(manifest, operation, '');
  if (!authority.local_recipe || authority.local_recipe_id === null || authority.local_recipe_id === '') return undefined;
  return lookups.recipeOf(authority.local_recipe_id) ?? undefined;
};

/** One step, and the steps of a recipe it runs after it. */
const classifyStep = (
  step: unknown,
  index: number,
  recipe_id: string,
  via: readonly string[],
  reading: Reading,
): RecipeStepAsk[] => {
  const { source, lookups } = reading;
  const step_id = stepIdOf(step, index);
  const at = { step_id, recipe_id, via };
  if (!isRecord(step)) return [{ ...at, ...UNREAD }];
  if (typeof step.transform === 'string' || typeof step.guard === 'string') return [{ ...at, verdict: 'never' }];
  /** A catalog operation's step, then the steps of the recipe it runs. */
  const catalogStep = (catalog_slug: string, operation: string, manifest: IngredientManifest | undefined): RecipeStepAsk[] => {
    const answer = specAnswer(catalog_slug, operation, catalogSpec(manifest, operation), source, lookups, manifest);
    const own: RecipeStepAsk = { ...at, verdict: answer.verdict, ...(answer.reason !== undefined ? { reason: answer.reason } : {}), ...gateHow(answer),
      slug: catalog_slug, ...(answer.operation_id !== undefined ? { operation_id: answer.operation_id } : {}),
      ...(asksAi(catalog_slug, lookups) ? { ai: true as const } : {}) };
    const inner = localRecipeOf(manifest, operation, lookups);
    if (inner === undefined) return [own];
    // Run again on its own path, or deeper than is read: not readable before the run.
    if (reading.held.has(inner.recipe_id) || via.length + 1 >= RECIPE_ASK_MAX_DEPTH) {
      return [own, { step_id: '*', recipe_id: inner.recipe_id, via: [...via, step_id], ...UNREAD }];
    }
    return [own, ...classifySteps(inner, [...via, step_id], { ...reading, held: new Set([...reading.held, inner.recipe_id]) })];
  };
  if (typeof step.op === 'string') {
    if (step.op.includes('{{')) return [{ ...at, ...UNREAD }];
    const parsed = parseOpId(step.op);
    if (parsed === null) return [{ ...at, ...UNREAD }];
    if (parsed.tier === 'kernel') {
      const answer = kernelOpAnswer(step.op, source, lookups);
      const slug = answer.slug ?? getKernelOp(step.op)?.backing_slug;
      const base: RecipeStepAsk = { ...at, verdict: answer.verdict, ...(answer.reason !== undefined ? { reason: answer.reason } : {}), ...gateHow(answer),
        ...(slug !== undefined ? { slug } : {}), ...(asksAi(slug, lookups) ? { ai: true as const } : {}),
        ...(slug !== undefined && SAVES_FILES.has(stripCorePrefix(slug)) ? { saves_files: true as const } : {}) };
      return [slug !== undefined && stripCorePrefix(slug) === 'dom-act'
        ? { ...base, ...browserBatch(isRecord(step.args) ? step.args : undefined, answer) } : base];
    }
    const binding = lookups.packOps().get(parsed.pack_ref);
    if (binding === undefined || !binding.operations.has(parsed.operation)) return [{ ...at, ...UNREAD }];
    return catalogStep(binding.catalog_slug, parsed.operation, lookups.getManifest(binding.catalog_slug) ?? undefined);
  }
  if (typeof step.ingredient === 'string') {
    const input = isRecord(step.input) ? step.input : undefined;
    const backing = kernelOpForBackingSlug(step.ingredient);
    if (backing !== undefined) {
      const answer = kernelOpAnswer(backing, source, lookups);
      const base: RecipeStepAsk = { ...at, verdict: answer.verdict, ...(answer.reason !== undefined ? { reason: answer.reason } : {}), ...gateHow(answer),
        slug: step.ingredient, ...(asksAi(step.ingredient, lookups) ? { ai: true as const } : {}),
        ...(SAVES_FILES.has(stripCorePrefix(step.ingredient)) ? { saves_files: true as const } : {}) };
      return [stripCorePrefix(step.ingredient) === 'dom-act' ? { ...base, ...browserBatch(input, answer) } : base];
    }
    if (step.ingredient.includes('{{')) return [{ ...at, ...UNREAD }];
    const manifest = lookups.getManifest(step.ingredient) ?? undefined;
    if (manifest === undefined) return [{ ...at, ...UNREAD }];
    const operation = input?.operation;
    if (manifest.operations !== undefined && Object.keys(manifest.operations).length > 0) {
      if (typeof operation !== 'string' || operation.includes('{{')) return [{ ...at, ...UNREAD, slug: manifest.slug ?? step.ingredient }];
      return catalogStep(manifest.slug ?? step.ingredient, operation, manifest);
    }
    if (manifest.risk_tier === undefined) return [{ ...at, ...UNREAD, slug: step.ingredient }];
    const answer = gateAnswer(step.ingredient, manifest.risk_tier, source, lookups);
    return [{ ...at, verdict: answer.verdict, ...(answer.reason !== undefined ? { reason: answer.reason } : {}), ...gateHow(answer),
      slug: step.ingredient, ...(asksAi(step.ingredient, lookups) ? { ai: true as const } : {}) }];
  }
  return [{ ...at, ...UNREAD }];
};

/** A recipe's steps, in the order a run takes them: prefetch, its steps, then a trigger's. */
const classifySteps = (recipe: RecipeDefinition, via: readonly string[], reading: Reading): RecipeStepAsk[] => {
  const steps: unknown[] = [
    ...((recipe.prefetch_steps ?? []) as unknown[]),
    ...((recipe.steps ?? []) as unknown[]),
    ...((recipe.trigger_steps ?? []) as unknown[]),
  ];
  return steps.flatMap((step, index) => classifyStep(step, index, recipe.recipe_id, via, reading));
};

/** D-402 slice F1 — what each step of this recipe, and of a recipe it runs, does about asking the
 *  owner when `source` runs it, in run order (§7.4's one classifier). */
export const classifyRecipeAsks = (
  recipe: RecipeDefinition,
  source: ExecutionSource,
  lookups: RecipeAskLookups,
): RecipeStepAsk[] => classifySteps(recipe, [], { source, lookups, held: new Set([recipe.recipe_id]) });

/** May this recipe, run as `source`, ask the owner partway through? */
export const recipeMayAsk = (
  recipe: RecipeDefinition,
  source: ExecutionSource,
  lookups: RecipeAskLookups,
): boolean => classifyRecipeAsks(recipe, source, lookups).some((step) => step.verdict !== 'never');
