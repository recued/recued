/** D-207 slice 1b step 5 — the BIND path and the DISPATCH resolver.
 *
 *  Two functions, and they are the whole seam:
 *
 *    bind:     derive → refuse-or-diff → (owner confirms) → mint → link to the pair
 *    dispatch: reception_id → pair → contract_id
 *
 *  ## The bind is where every "no" happens
 *
 *  An ungranted op is a HARD DENY at fire, not a hold — so a bind that admits a recipe it
 *  cannot honestly describe produces a public form that looks live and kills every
 *  submission, with the visitor eating the failure. Every refusal therefore belongs HERE,
 *  where the owner is present and can act:
 *
 *    - a recipe that is not statically analyzable (`run-ingredient` — a dispatch target
 *      chosen at runtime) has no honest capability list, so it can never back a door;
 *    - a recipe whose connection is unresolvable has no knowable credential;
 *    - a capability WIDENING is shown as a diff and re-consented.
 *
 *  ## Widening asks. Narrowing does not.
 *
 *  {@link doorCapabilityChanged} returns `added` / `removed`. A bind that only
 *  REMOVES ops is a narrowing and needs no consent — it is already safe. A bind that ADDS
 *  one must be confirmed, and the ADDED LIST IS THE PROMPT ("adds: send email"). A prompt
 *  that fires on every cosmetic edit trains the owner to click through without reading, so
 *  the diff is taken against the stored CAPABILITY, never against `pair_revision` (a
 *  content hash that moves when you reword an email subject).
 *
 *  ## Every intermediate state is fail-closed
 *
 *  The mint and the pair-link are two writes. A crash between them leaves the pair with
 *  `contract_id: NULL` — and a NULL contract_id floors the dispatch to
 *  `PUBLIC_CONTRACT_ID`, which grants nothing, so the door DENIES until the owner
 *  re-binds. There is no window in which a half-bound door is open.
 *
 *  Spec: D-207 §5.1a / §5.1b / §5.2. */

import {
  getKernelDomain,
  getKernelOp,
  kernelVerbRiskTier,
  parseOpId,
  recipeOutputSections,
  STANDING_CLOSURE_RISK_TIERS,
  type RecipeDefinition,
} from '@recued/contracts';

import {
  deriveResolvedRecipeCapability,
  type RecipeCapability,
  type RecipeCapabilityRefusal,
  type OpResolver,
} from './derive-recipe-capability.js';
import { RECEPTION_SELLER_OFFER_CONFIG_KEY } from './reception-recipe-runner.js';
import {
  mintDoorContract,
  doorCapabilityChanged,
  retireDoorContract,
  type MintDoorDeps,
} from './mint-door-contract.js';
import type { ReceptionIntakeRecipePairStore } from './storage/reception-intake-recipe-pair-store.js';
import type { DoorRecipeResolver } from './recipe-capability-wiring.js';
import {
  analyzeReceptionRecipeCost,
  receptionDoorExecutionPolicy,
  type ReceptionRecipeCostRefusal,
} from './reception-recipe-cost-policy.js';

/** D-207 slice 3c — a door that owes the visitor a SYNCHRONOUS RESPONSE cannot write.
 *
 *  ## Why this is a hard refusal and not a warning
 *
 *  An anonymous actor is pinned to the contracted `read` trust ceiling (slice 1a), so ANY
 *  write-tier op in a paired recipe resolves to `ask` and HOLDS the run at the D-157 gate.
 *  A held run returns NO OUTPUT — not partial output, none. So on a door that was going to
 *  hand the visitor something back, a single write means:
 *
 *    submission accepted → run holds → no `output.render` → the visitor gets a bare
 *    thank-you page → they were never given the thing they came for.
 *
 *  On a SELLING door that thing is a way to pay, and this is precisely the lie D-207 exists
 *  to kill — the one D-200 shipped, in its third coat. Holding is not a sometimes-failure
 *  here: it is what happens on EVERY submission, so the form is broken 100% of the time.
 *
 *  ## What still holds, and why this costs the author nothing real
 *
 *  A PLAIN intake door — no offer, no rendered response — is untouched. There a write is
 *  exactly right: it holds, the owner approves it in the D-173 Inbox, and "thank you, we
 *  got your submission" stays TRUE because nothing was owed in return. That is slice 1's
 *  lead-capture acceptance and it keeps working.
 *
 *  And a selling door does not need to write: the RUNNER opens the order server-side, just
 *  as it already writes the durable submission row. Lead capture does not need to write
 *  either — the submission row IS the capture. Writes on the anonymous channel are the
 *  SERVER's job, never the recipe's. That is ruling (C), generalized from payment to
 *  everything.
 *
 *  ## Fail-closed on an op we cannot classify
 *
 *  An op whose risk cannot be resolved is REFUSED, not admitted. We cannot prove it will
 *  not hold, and a fence that waves through what it does not understand is not a fence. */
export type ReceptionDoorWriteRefusal = {
  readonly reason: 'write_on_responding_door';
  readonly step_id: string;
  readonly op: string;
  /** `undefined` ⇒ the op's risk could not be resolved at all. Refused all the same. */
  readonly risk: string | undefined;
  /** WHY this door owes a response — the half of the rule the owner needs to see, because
   *  it names the thing they would have to give up to make the write legal. */
  readonly responds: 'renders' | 'sells';
};

/** Every way a recipe can be refused a door. Static analyzability comes from the
 *  derivation; this policy refusal is the BIND's own, which is why it lives here and not
 *  inside a function whose job is to describe what a recipe DOES. */
export type ReceptionDoorRefusal =
  | RecipeCapabilityRefusal
  | ReceptionDoorWriteRefusal
  | ReceptionRecipeCostRefusal;

/** D-240 slice 3b — the ONLY two things a door bind needs from a pair store.
 *
 *  🔑 NARROWED FROM `ReceptionIntakeRecipePairStore` RATHER THAN COPIED, so a
 *  second kind of door reuses the whole bind: capability derivation, the §5.1a
 *  eligibility rule, the §3c refusal that a door which OWES the visitor a
 *  synchronous response cannot write, the cost policy, the widening-consent
 *  diff, and the retire-before-mint ordering. All of that is generic over
 *  `(recipeId, recipe)`; only the contract LINK was ever pair-specific.
 *
 *  ⛔ The alternative — a bespoke bind for the lookup door — would have had to
 *  re-derive every one of those rules, and the one it would most plausibly have
 *  dropped is the §3c write refusal, which is precisely the rule a read-only
 *  viewback door most needs. */
export interface ReceptionDoorContractLink {
  findByEndpoint(endpoint_id: string): { readonly contract_id: string | null } | null;
  setContractId(input: { endpoint_id: string; contract_id: string | null }): unknown;
}

export interface ReceptionDoorBindDeps extends MintDoorDeps {
  readonly pairStore: ReceptionDoorContractLink;
  /** The installed dish's resolved `config_overlay` for this recipe — where the connection
   *  values actually live (a Recipe is a pure paper record; D-179). */
  readonly resolveConfig: (recipeId: string) => Record<string, unknown> | undefined;
  /** Exact authored-op lowering used by `handleExecute`. Production always supplies it;
   *  optional only for narrow legacy harnesses containing already-concrete recipes. */
  readonly resolveDoorRecipe?: DoorRecipeResolver;
  readonly resolveOp?: OpResolver;
  /** op id → its risk tier, across BOTH the kernel registry and the installed pack
   *  catalogs. Absent ⇒ only ops we can classify from the kernel pass, and everything else
   *  is refused on a responding door. Fail-closed by construction. */
  readonly resolveOpRisk?: (opId: string) => string | undefined;
  /** Cost classification uses the same installed manifests/op inventory the run lowers
   *  through. Unknown dispatch kinds refuse rather than being assumed non-AI. */
  readonly resolveIngredientKind?: (ingredientSlug: string) => string | undefined;
  readonly resolveOpKinds?: () => ReadonlyMap<string, string>;
}

export type ReceptionDoorBindResult =
  /** The recipe cannot back a public door. Nothing was written. */
  | { readonly kind: 'refused'; readonly refusal: ReceptionDoorRefusal }
  /** The capability WIDENED. Nothing was written — show `added` and re-bind with
   *  `confirmed: true`. This is the consent moment. */
  | {
      readonly kind: 'needs_consent';
      /** Ops a standing closure could never admit (tier above `write`, or
       *  unclassifiable) — they still ask per dispatch. USUALLY EMPTY: a
       *  responding door cannot carry one at all, because
       *  `refuseWriteOnRespondingDoor` refuses the bind first. */
      readonly asks_anyway: readonly string[];
      readonly added: string[];
      readonly removed: string[];
      readonly capability: RecipeCapability;
    }
  /** The door is bound and live. */
  | {
      readonly kind: 'bound';
      readonly contract_id: string;
      readonly capability: RecipeCapability;
      /** True when nothing about the door's authority changed — the owner was not asked,
       *  and nothing needed re-minting. A version bump or a reworded subject lands here. */
      readonly unchanged: boolean;
    };

/** Does this door owe the visitor something back, and if so, why?
 *
 *  Both signals are DERIVED, never declared — the same move as `door_types` (server-derived
 *  at mint) and the capability closure itself. A declared flag could disagree with what the
 *  recipe actually does, and that disagreement IS the class of bug this arc keeps finding.
 *
 *    RENDERS — `recipeOutputSections` is the ENGINE's own rule for whether a run produces
 *              `output.render`. Reading it here means the bind cannot believe something the
 *              engine would contradict at fire.
 *    SELLS   — the recipe's config names an offer. §4.4: an order exists iff there is an
 *              offer, and an order means the visitor came to pay. */
const respondsWith = (
  recipe: RecipeDefinition,
  config: Record<string, unknown> | undefined,
): 'renders' | 'sells' | null => {
  const offer = config?.[RECEPTION_SELLER_OFFER_CONFIG_KEY];
  // Sells is checked FIRST: it is the graver of the two (money, not markup), and it is the
  // one that names what the owner would have to give up.
  if (typeof offer === 'string' && offer.length > 0) return 'sells';
  if (recipeOutputSections(recipe).length > 0) return 'renders';
  return null;
};

/** Canonical CRM/accounting ops are open verb-convention addresses, so they do not have a
 * closed `getKernelOp()` row. Their risk is nevertheless kernel-defined by the final verb.
 * Keep this deliberately limited to registered canonical-convention domains: treating any
 * syntactically valid `core.*` address as a canonical read would turn an unknown op into a
 * fail-open classification. */
const canonicalConventionRisk = (opId: string): string | undefined => {
  const parsed = parseOpId(opId);
  if (
    parsed === null
    || parsed.tier !== 'kernel'
    || getKernelDomain(parsed.domain)?.class !== 'canonical_convention'
  ) {
    return undefined;
  }
  const finalDot = parsed.op.lastIndexOf('.');
  if (finalDot < 0) return undefined;
  return kernelVerbRiskTier(parsed.op.slice(finalDot + 1)) ?? undefined;
};

/** One op's risk, resolved the one way. The fence AND the consent payload read
 *  it — two spellings is how the screen comes to promise something the gate
 *  does not do. `undefined` ⇒ unclassifiable, which every caller treats as
 *  "cannot be admitted". */
const resolveDoorOpRisk = (
  op: string,
  resolveOpRisk: ((opId: string) => string | undefined) | undefined,
): string | undefined =>
  resolveOpRisk?.(op) ?? getKernelOp(op)?.risk ?? canonicalConventionRisk(op);

/** The ops a standing closure could NEVER admit — `destructive`, `admin`, and
 *  anything unclassifiable. They stay in the closure (the owner is granting
 *  ACCESS to them) but keep asking per dispatch, so the consent screen must be
 *  able to say so — and, when the list is empty, to say NOTHING rather than
 *  warn about a delete this form does not have. */
const opsThatAskAnyway = (
  capability: RecipeCapability,
  resolveOpRisk: ((opId: string) => string | undefined) | undefined,
): string[] =>
  [...capability.operation_ids].filter((op) => {
    const risk = resolveDoorOpRisk(op, resolveOpRisk);
    return risk === undefined || !STANDING_CLOSURE_RISK_TIERS.includes(risk);
  });

/** Refuse a responding door that can write. `null` ⇒ nothing to refuse.
 *
 *  ⛔⛔ `standingClosure` IS NOT A BYPASS — IT FALSIFIES THIS FENCE'S PREMISE.
 *  The refusal below says, in the owner's own error message, *"it would pause
 *  for your approval — and a paused run produces no response at all."* That is
 *  the entire argument. A standing closure is precisely the thing that stops
 *  the write pausing, so under it the visitor DOES get their response and the
 *  premise is simply untrue.
 *
 *  🔑 The two are ONE RULE READ FROM TWO ENDS: this fence refuses at BIND
 *  because `standingClosureAdmits` would hold at DISPATCH. Leaving them
 *  independent is how they contradict — and they DID: the dispatch gate was
 *  built first and this end was not revisited, so ticking the box made the door
 *  refuse to bind AT ALL. The feature was unreachable for the exact case it was
 *  designed for, and three green suites could not see it because none of them
 *  bound a responding recipe through the real risk resolver.
 *
 *  ⚠ They therefore share `STANDING_CLOSURE_RISK_TIERS` rather than each
 *  spelling out `read`/`write`. If this end admitted a tier the gate holds, the
 *  door would bind and then stay silent forever — bound, and answering nobody.
 *
 *  ⚠⚠ THE TWO ENDS READ DIFFERENT RISK VALUES, AND THAT IS NOT FIXABLE HERE.
 *  This fence classifies the op's MANIFEST `risk_tier`; the gate classifies
 *  `resolution.effective_risk_tier`, which a D-211 owner override may REPLACE
 *  and a source `risk_overrides` entry may escalate (`stricterRisk`) — values
 *  that do not exist at bind and can change after it. So the two can disagree.
 *
 *  🔑 DRIVEN OUT, BOTH DIRECTIONS FAIL SAFE — this is precision, not a hole:
 *    - manifest `write` → effective `destructive`: this fence admits under the
 *      opt-in, the GATE then holds. A hold, never a leak. The cost is the bad
 *      outcome this fence exists to prevent (a responding door showing a bare
 *      thank-you page), so it is a UX regression in a rare case, not authority.
 *    - manifest `destructive` → effective `write` (owner de-escalation): this
 *      fence refuses a bind the gate would have admitted. A false refusal.
 *  The GATE is the authority and it re-reads the effective tier every dispatch,
 *  which is why the imprecision cannot widen what actually runs. ⛔ The prior
 *  fence had the same mismatch (it read the manifest tier too), so this is a
 *  pre-existing approximation my relaxation inherits — NOT one it introduces.
 *  Recorded because "the fence says write and the gate says destructive" reads
 *  like a bypass until you check which way it fails. */
const refuseWriteOnRespondingDoor = (
  recipe: RecipeDefinition,
  config: Record<string, unknown> | undefined,
  capability: RecipeCapability,
  resolveOpRisk: ((opId: string) => string | undefined) | undefined,
  standingClosure: boolean,
): ReceptionDoorWriteRefusal | null => {
  const responds = respondsWith(recipe, config);
  if (responds === null) return null;

  // Sorted, so the op we name is stable across binds — an owner who fixes one write and
  // re-binds should be told about the NEXT one, not a different one at random.
  for (const op of capability.operation_ids) {
    const risk = resolveDoorOpRisk(op, resolveOpRisk);
    // ⛔ An opted-in door admits exactly the tiers its gate admits — no more. A
    // resolved `destructive` / `admin` still refuses here, because the gate
    // still ASKS for those, so the run would still pause and the visitor would
    // still get a bare thank-you. And `undefined` still refuses on BOTH paths:
    // the gate cannot admit what it cannot classify either, so an unclassifiable
    // op on an opted-in door would hold at fire. Fail-closed is not weakened by
    // the opt-in; it is the reason the opt-in can be safe at all.
    if (standingClosure && risk !== undefined && STANDING_CLOSURE_RISK_TIERS.includes(risk)) {
      continue;
    }
    // ⛔ `!== 'read'` — NOT `=== 'write'`. This catches `destructive` and `admin`, and it
    // catches an op whose risk we could not resolve AT ALL (`undefined`). An unresolvable
    // op is refused because we cannot prove it will not hold, and a fence that admits what
    // it cannot classify is decoration.
    if (risk !== 'read') {
      return {
        reason: 'write_on_responding_door',
        step_id: capability.operation_steps[op] ?? '<unknown>',
        op,
        risk,
        responds,
      };
    }
  }
  return null;
};

/** Bind (or re-bind) a recipe to a public intake endpoint. */
/** D-299 — what binding a recipe's door WOULD do, with nothing written: the door's
 *  capability and execution policy, the door it would reuse, and the authority diff
 *  against it. `bindReceptionDoor` is exactly this plus the write, so a pack update's
 *  warning, which reads the plan before anything is installed, decides as the bind the
 *  update then runs does. */
export type ReceptionDoorPlan =
  | { readonly kind: 'refused'; readonly refusal: ReceptionDoorRefusal }
  | {
      readonly kind: 'planned';
      readonly capability: RecipeCapability;
      readonly executionPolicy: ReturnType<typeof receptionDoorExecutionPolicy>;
      readonly existingContractId: string | null;
      readonly diff: ReturnType<typeof doorCapabilityChanged>;
    };

export const planReceptionDoor = (
  input: {
    readonly endpointId: string;
    readonly recipeId: string;
    readonly recipe: RecipeDefinition;
    readonly standingClosure?: boolean;
  },
  deps: ReceptionDoorBindDeps,
): ReceptionDoorPlan => {
  const config = deps.resolveConfig(input.recipeId);
  const dispatchRecipe = deps.resolveDoorRecipe?.(input.recipe, config ?? {})
    ?? { ok: true as const, recipe: input.recipe };
  if (!dispatchRecipe.ok) {
    return {
      kind: 'refused',
      refusal: {
        reason: 'dispatch_unresolvable',
        step_id: '<recipe>',
        detail: dispatchRecipe.reason,
      },
    };
  }
  const resolveOp = dispatchRecipe.resolveOp ?? deps.resolveOp;
  const derived = deriveResolvedRecipeCapability(input.recipe, dispatchRecipe.recipe, {
    ...(config === undefined ? {} : { config }),
    ...(resolveOp === undefined ? {} : { resolveOp }),
  });
  // §5.1a — the door's ONE eligibility rule. Refused at BIND, never at fire.
  if (!derived.ok) return { kind: 'refused', refusal: derived.refusal };

  // D-207 slice 3c — a door that OWES the visitor a synchronous response cannot write.
  const responding = refuseWriteOnRespondingDoor(
    dispatchRecipe.recipe,
    config,
    derived.capability,
    deps.resolveOpRisk,
    input.standingClosure === true,
  );
  if (responding !== null) return { kind: 'refused', refusal: responding };

  const cost = analyzeReceptionRecipeCost(dispatchRecipe.recipe, {
    ...(deps.resolveIngredientKind === undefined
      ? {}
      : { resolveIngredientKind: deps.resolveIngredientKind }),
    ...(deps.resolveOpKinds === undefined ? {} : { resolveOpKinds: deps.resolveOpKinds }),
  });
  if (!cost.ok) return { kind: 'refused', refusal: cost.refusal };
  const executionPolicy = receptionDoorExecutionPolicy(cost.profile);

  const pair = deps.pairStore.findByEndpoint(input.endpointId);
  const existingContractId = pair?.contract_id ?? null;
  const stored = existingContractId === null
    ? null
    : deps.definitionStore.get(existingContractId);

  const diff = doorCapabilityChanged(stored, derived.capability, executionPolicy);
  return {
    kind: 'planned',
    capability: derived.capability,
    executionPolicy,
    existingContractId,
    diff,
  };
};

export const bindReceptionDoor = (
  input: {
    readonly endpointId: string;
    readonly recipeId: string;
    readonly recipe: RecipeDefinition;
    readonly mintedBy: string;
    /** The owner has seen the widening diff and accepted it. */
    readonly confirmed?: boolean;
    /** D-207 follow-on — the owner opts this door's CONFIRMED closure into
     *  standing approval, so the ops they just reviewed stop asking per
     *  dispatch. Absent ⇒ off, which is every door bound before this existed.
     *  ⚠ Carried on the BIND rather than set later, deliberately: the closure
     *  the owner is consenting to is the one on the screen in front of them,
     *  and a re-bind that widens it re-asks for the consent. */
    readonly standingClosure?: boolean;
  },
  deps: ReceptionDoorBindDeps,
): ReceptionDoorBindResult => {
  const plan = planReceptionDoor(input, deps);
  if (plan.kind === 'refused') return { kind: 'refused', refusal: plan.refusal };
  const { capability, executionPolicy, existingContractId, diff } = plan;

  // Nothing about the door's AUTHORITY moved. Silent — however much the recipe's bytes
  // changed. This is the case that keeps the consent surface trustworthy.
  if (!diff.changed && existingContractId !== null) {
    return {
      kind: 'bound',
      contract_id: existingContractId,
      capability,
      unchanged: true,
    };
  }

  // WIDENING asks; narrowing does not. `added.length > 0` is the only thing that can grant
  // the public new authority, so it is the only thing that needs a human.
  if (diff.added.length > 0 && input.confirmed !== true) {
    return {
      kind: 'needs_consent',
      added: diff.added,
      removed: diff.removed,
      capability,
      asks_anyway: opsThatAskAnyway(capability, deps.resolveOpRisk),
    };
  }

  // Replace, don't mutate: `mint()` generates the id and there is no upsert. Retire the
  // old door FIRST — a revoked definition stops governing immediately, so there is no
  // instant at which two live contracts both claim this endpoint.
  if (existingContractId !== null) {
    retireDoorContract(existingContractId, 'rebound', deps);
  }

  const { contract_id } = mintDoorContract(
    {
      door: 'reception',
      recipeId: input.recipeId,
      capability,
      mintedBy: input.mintedBy,
      doorExecutionPolicy: executionPolicy,
      ...(input.standingClosure === true ? { standingClosure: true } : {}),
    },
    deps,
  );

  deps.pairStore.setContractId({ endpoint_id: input.endpointId, contract_id });

  return { kind: 'bound', contract_id, capability, unchanged: false };
};

/** Retire a door: revoke its contract and unlink it from the pair.
 *
 *  Order matters. Revoke FIRST — the contract stops governing the moment it is revoked, so
 *  even if the unlink never lands, the door is already shut. The reverse order would leave
 *  a window in which the pair points at nothing while a live contract still exists. */
export const unbindReceptionDoor = (
  endpointId: string,
  deps: Pick<ReceptionDoorBindDeps, 'pairStore' | 'definitionStore' | 'now'>,
): void => {
  const pair = deps.pairStore.findByEndpoint(endpointId);
  const contractId = pair?.contract_id ?? null;
  if (contractId !== null) {
    retireDoorContract(contractId, 'unbound', deps);
  }
  deps.pairStore.setContractId({ endpoint_id: endpointId, contract_id: null });
};

/** The DISPATCH hop: `reception_id → pair → contract_id`.
 *
 *  `null` is safe. The source then carries no `contract_id`, and
 *  `resolveGrantGoverningContractId` floors an anonymous dispatch to `PUBLIC_CONTRACT_ID`
 *  (which grants nothing) rather than to "contract-free" (which would SKIP the gate). */
export const resolveReceptionDoorContractId = (
  endpointId: string,
  deps: Pick<ReceptionDoorBindDeps, 'pairStore'>,
): string | null => deps.pairStore.findByEndpoint(endpointId)?.contract_id ?? null;
