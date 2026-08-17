/** D-207 slice 1c — the GENERAL gated reception recipe runner.
 *
 *  This is the whole point of D-207. It replaces the shape D-200 shipped — the ONLY raw
 *  `executeRecipe` in the server, which bypassed the Gateway, the contract, the actor and
 *  the run row, and was "safe" solely because its recipe profile was crippled to the point
 *  of being unable to dispatch a single ingredient (empty vault, an ingredient executor
 *  that always threw, ≤16 pure-scalar steps that had to end in a literal Stripe line item).
 *
 *  That safety and that narrowness were the same property, which is exactly why the door
 *  could never generalize. Here, safety comes from the GATE:
 *
 *    - ACCESS  — the door contract's `contract_grant` rows (minted at bind from the
 *                recipe's derived closure). An op outside it is a HARD DENY.
 *    - APPROVAL — an anonymous actor is pinned to the contracted `read` ceiling (slice 1a),
 *                so every write SURFACES. It holds at the D-157 gate and lands in the D-173
 *                Inbox rather than firing silently for a stranger.
 *    - TOOLS   — the `ContractSnapshot.allowed_tools` axis (`op-admission-gate` is
 *                permissive for a wildcard door; the snapshot is its real gate).
 *
 *  So the recipe profile can be WIDE. Any statically-analyzable recipe may be paired — a
 *  lead-capture, a support triage, a booking — with no payment code anywhere in the path.
 *
 *  Modelled on `webhook-recipe-runner.ts`, which is the same shape done right for a
 *  different channel: a durable trigger registry plus `handleExecute` with a real
 *  `execution_source`, including `awaiting_approval` handling.
 *
 *  ## `held` is not a failure
 *
 *  `awaiting_approval` means the run is durably PAUSED at the gate — it is queued, not
 *  failed. The visitor gets the ordinary success page and that is HONEST: their submission
 *  is durable and the owner will review it. Conflating this with a failure would either lie
 *  to the visitor or spam them with an error for the system working as designed.
 *
 *  ## No door ⇒ do not run
 *
 *  A pair with no minted contract would dispatch contract-free… except it cannot: an
 *  anonymous source with no `contract_id` is floored to `PUBLIC_CONTRACT_ID`, which grants
 *  nothing, so every op would hard-deny and the run would fail step 1. Detect it up front
 *  and say so, rather than manufacturing a failed run whose cause is invisible.
 *
 *  Spec: D-207 §5.3. */

import {
  buildReceptionOrderContext,
  contractPermitsDoorType,
  isContractActive,
  type ContractSnapshot,
  type ExecutionSource,
  type RecipeDefinition,
  type ReceptionOrderContext,
  type ReceptionOrderContextRefusal,
} from '@recued/contracts';

import { handleExecute, type ExecuteHandlerDeps } from './execute-handler.js';
import {
  deriveResolvedRecipeCapability,
  type OpResolver,
} from './derive-recipe-capability.js';
import { doorCapabilityChanged } from './mint-door-contract.js';
import { resolveReceptionDoorContractId } from './reception-door-bind.js';
import {
  buildReceptionContractSnapshot,
  grantedOperationsFor,
} from './reception-contract-snapshot.js';
import type { ContractDefinitionStore } from './storage/contract-definition-store.js';
import type { ReceptionIntakeRecipePairStore } from './storage/reception-intake-recipe-pair-store.js';
import type { SellerStore } from './storage/seller-store.js';
import type { SellerOrderStore } from './storage/seller-order-store.js';
import type { ExecuteResponse } from './types.js';
import type { DoorRecipeResolver } from './recipe-capability-wiring.js';
import {
  analyzeReceptionRecipeCost,
  receptionDoorPolicyAdmits,
  type ReceptionRecipeCostRefusal,
} from './reception-recipe-cost-policy.js';

/** D-207 §4.4 — "an order exists iff there is an offer."
 *
 *  The owner points a recipe at an offer by editing ONE recipe variable, after creating
 *  the offer in Seller → Offers. A pair whose recipe names no offer is a plain intake
 *  form — lead capture, support triage, a booking — and mints no order. That is the whole
 *  rule, and it is why a non-selling door is completely untouched by any of this.
 *
 *  ⛔ Recued deliberately does NOT verify that the form's LABELS agree with the offer row.
 *  It cannot be a money bug: the form's price is text the owner typed, while the amount is
 *  the offer's and is enforced at the hosted checkout and again by the underpay fence at
 *  `confirm-payment`. Proving the two agree would require the form itself to be RENDERED
 *  from the offer — a real architecture, and not this slice. A mislabelled form shows the
 *  visitor a price the checkout then corrects. It can never charge one. */
export const RECEPTION_SELLER_OFFER_CONFIG_KEY = 'seller_offer_id' as const;

export type ReceptionRunOutcome =
  /** The recipe ran to completion. `output.render` carries its `OutputSection` blocks —
   *  the substrate Slice 2's `render` response mode consumes. */
  | { readonly kind: 'completed'; readonly output: ExecuteResponse['output'] }
  /** Durably PAUSED. Queued, not failed, and the visitor's success page is honest either way
   *  — their submission is durable and something will resume it.
   *
   *  ⚠ TWO HOLDS REACH HERE AND ONLY ONE HAS AN OWNER AFFORDANCE. `awaiting_approval` lands
   *  in the D-173 Inbox and the owner approves it. `awaiting_peer` (D-234 § 234.4) is waiting
   *  on ANOTHER SERVER'S owner, so the Inbox deliberately excludes it
   *  (`reception-inbox-handler.ts`: *"a run held for a peer's answer offers them nothing to
   *  act on"*) — correct, and it means such a submission sits `pending` in
   *  `#reception/records` with no inbox row beside it. The distinction is not collapsed here
   *  because this outcome answers the VISITOR's question, and the visitor's answer is the
   *  same; a surface that needs to tell them apart reads the run anchor's `commit_status`. */
  | { readonly kind: 'held' }
  /** The run failed. The visitor was promised something and is not getting it — the handler
   *  must TELL them (slice 1c: no silent success page). */
  | { readonly kind: 'failed'; readonly errors: unknown[] }
  /** No pair, or a pair with no minted door contract. Not an error: an unpaired endpoint is
   *  an ordinary intake form and its ordinary success page is correct. */
  | { readonly kind: 'no_door' };

export interface ReceptionRecipeRunnerDeps {
  readonly executeDeps: ExecuteHandlerDeps;
  readonly pairStore: ReceptionIntakeRecipePairStore;
  readonly definitionStore: ContractDefinitionStore;
  /** The installed dish's resolved `config_overlay` for this recipe (D-179: a Recipe is a
   *  pure paper record; its VALUES live on the dish).
   *
   *  ⛔ THIS MUST BE THE SAME FUNCTION `reception-door-bind` DERIVES THE CAPABILITY FROM.
   *  The bind resolves `{{config.*}}` — which is where a step's CONNECTION lives — to decide
   *  which ops the door may reach, mints the grant rows from that closure, and shows the
   *  owner the list they are consenting to. If the run then resolved a DIFFERENT config, the
   *  consent list would describe a run that cannot happen. One derivation, two consumers. */
  readonly resolveConfig: (recipeId: string) => Record<string, unknown> | undefined;
  /** Current stored recipe snapshot. Runtime re-checks the same cost profile bind accepted,
   *  closing legacy contracts and any recipe drift before an order or external call exists. */
  readonly resolveRecipe: (recipeId: string) => RecipeDefinition | null;
  readonly resolveDoorRecipe?: DoorRecipeResolver;
  readonly resolveOp?: OpResolver;
  readonly resolveIngredientKind?: (ingredientSlug: string) => string | undefined;
  readonly resolveOpKinds?: () => ReadonlyMap<string, string>;
  /** Present only on a server with a seller substrate. A pair whose recipe names an offer
   *  on a server WITHOUT one is a refusal, not a silent plain-intake fallback: the owner
   *  built a form to sell something and the visitor would be thanked for nothing. */
  readonly seller?: {
    readonly offers: Pick<SellerStore, 'getOffer'>;
    readonly orders: Pick<SellerOrderStore, 'openOrder'>;
  };
  readonly now: () => number;
  /** Fail-fast execution ceilings. A public submission is already durable before
   *  it reaches this runner, so saturation must not grow an in-memory queue. */
  readonly maxConcurrentRunsGlobal?: number;
  readonly maxConcurrentRunsPerEndpoint?: number;
}

export const RECEPTION_RECIPE_MAX_CONCURRENT_RUNS_GLOBAL = 16;
export const RECEPTION_RECIPE_MAX_CONCURRENT_RUNS_PER_ENDPOINT = 4;

const boundedConcurrency = (value: number | undefined, fallback: number): number =>
  value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.max(1, Math.min(100, Math.floor(value)));

export class ReceptionRecipeConcurrencyError extends Error {
  readonly code = 'reception_recipe_concurrency_limited';

  constructor(readonly scope: 'global' | 'endpoint') {
    super(`reception recipe runner: ${scope} concurrency limit reached`);
    this.name = 'ReceptionRecipeConcurrencyError';
  }
}

export interface ReceptionRunInput {
  readonly endpoint_id: string;
  readonly submission_id: string;
  /** The visitor's submitted fields, already validated and durably persisted. Reaches the
   *  recipe as `context.reception_submission`.
   *
   *  ⚠ Every value here is TAINTED (`origin_actor: 'anonymous'`, D-177 N.11). Taint
   *  propagates through every step kind including AI, so a write whose authority-bearing
   *  args derive from these can never ride a standing grant — it holds for the owner. That
   *  is the property that closes prompt-injection by construction, and it is enforced at
   *  the gate, not here. */
  readonly submission: Record<string, unknown>;
}

/** Derive the door's tool allowlist from its own stored scope — the SAME derivation the
 *  mint wrote its grant rows from, so the ACCESS and TOOL axes can never disagree. */
const allowedToolsFor = (
  definitionStore: ContractDefinitionStore,
): ((contractId: string) => readonly string[]) => (contractId) =>
  definitionStore.get(contractId)?.scope?.ingredient_ids ?? [];

type OpenOrderResult =
  /** `context === null` means this pair sells nothing — a plain intake form. */
  | { readonly ok: true; readonly context: ReceptionOrderContext | null }
  | { readonly ok: false; readonly error: string };

const REFUSAL_MESSAGE: Readonly<Record<ReceptionOrderContextRefusal, string>> = {
  offer_has_no_checkout_url:
    'the offer has no hosted-checkout link, so a public form has no way to take payment '
    + '— the owner must add one in Seller → Offers',
  correlated_url_unrenderable:
    'the offer\'s checkout link cannot be rendered as a link button once stamped with '
    + 'this order\'s correlation',
};

const runtimeCostRefusalMessage = (refusal: ReceptionRecipeCostRefusal): string => {
  switch (refusal.reason) {
    case 'cost_step_limit':
      return `public reception recipe has ${refusal.steps} steps (max ${refusal.max_steps})`;
    case 'cost_dynamic_fanout':
      return `public reception recipe step '${refusal.step_id}' uses unbounded foreach fan-out`;
    case 'cost_unknown_dispatch_kind':
      return `public reception recipe step '${refusal.step_id}' has unclassifiable dispatch '${refusal.target}'`;
  }
};

/** Open the order this submission is buying, if it is buying one.
 *
 *  ⛔ EVERY failure here is a REFUSAL, never a silent fallback to plain intake. The owner
 *  pointed this form at an offer; a visitor who filled it in is expecting to be able to
 *  pay. Falling through to the ordinary success page would tell them "thank you, we got
 *  your submission" and never ask them for money — the slice-1c lie, which this whole
 *  slice exists to keep dead. */
const openOrderForPair = (
  config: Record<string, unknown> | undefined,
  input: ReceptionRunInput,
  deps: ReceptionRecipeRunnerDeps,
): OpenOrderResult => {
  const offerId = config?.[RECEPTION_SELLER_OFFER_CONFIG_KEY];
  // No offer named ⇒ no order. §4.4, and the ONLY thing that distinguishes a selling form
  // from a plain one.
  if (offerId === undefined || offerId === null || offerId === '') {
    return { ok: true, context: null };
  }
  if (typeof offerId !== 'string') {
    return { ok: false, error: `${RECEPTION_SELLER_OFFER_CONFIG_KEY} must be a string` };
  }
  if (deps.seller === undefined) {
    return {
      ok: false,
      error: `this form sells offer '${offerId}', but this server has no seller substrate`,
    };
  }

  const offer = deps.seller.offers.getOffer(offerId);
  if (offer === null) {
    return { ok: false, error: `offer '${offerId}' does not exist` };
  }

  let opened;
  try {
    // Idempotent by construction: `order_key` is deterministic in (offer, origin), so a
    // re-drive of the SAME submission — a drain retry, a reconciliation sweep — converges
    // on the order that already exists rather than minting a second one for one purchase.
    // The visitor is already holding a link stamped with the first order's handle.
    //
    // ⛔ Note what is NOT passed: no amount, no currency, no product name. The store reads
    // those off the offer row. There is no parameter through which a visitor's value could
    // become a price — the fence is the absent field, not a validator that inspects one.
    opened = deps.seller.orders.openOrder({
      offer_id: offerId,
      origin_kind: 'reception_submission',
      origin_ref: input.submission_id,
      now: deps.now(),
    });
  } catch (err) {
    // An inactive/withdrawn offer, a malformed key — the store's own validation. The
    // visitor is told; the submission stays durable for the owner.
    return {
      ok: false,
      error: err instanceof Error ? err.message : `offer '${offerId}' cannot be sold`,
    };
  }

  const built = buildReceptionOrderContext({
    offer,
    order: opened.order,
    correlation: opened.correlation,
  });
  if (!built.ok) return { ok: false, error: REFUSAL_MESSAGE[built.refusal] };

  return { ok: true, context: built.context };
};

export type ReceptionRecipeRunner = {
  run(input: ReceptionRunInput): Promise<ReceptionRunOutcome>;
};

export const createReceptionRecipeRunner = (
  deps: ReceptionRecipeRunnerDeps,
): ReceptionRecipeRunner => {
  const maxGlobal = boundedConcurrency(
    deps.maxConcurrentRunsGlobal,
    RECEPTION_RECIPE_MAX_CONCURRENT_RUNS_GLOBAL,
  );
  const maxPerEndpoint = Math.min(
    maxGlobal,
    boundedConcurrency(
      deps.maxConcurrentRunsPerEndpoint,
      RECEPTION_RECIPE_MAX_CONCURRENT_RUNS_PER_ENDPOINT,
    ),
  );
  const inFlightBySubmission = new Map<string, Promise<ReceptionRunOutcome>>();
  const activeByEndpoint = new Map<string, number>();
  let activeGlobal = 0;

  const runOnce = async (input: ReceptionRunInput): Promise<ReceptionRunOutcome> => {
    const pair = deps.pairStore.findByEndpoint(input.endpoint_id);
    if (pair === null) return { kind: 'no_door' };

    const contract_id = resolveReceptionDoorContractId(input.endpoint_id, deps);
    if (contract_id === null) return { kind: 'no_door' };

    // The snapshot/gateway can floor a dead door's ingredient calls, but this runner also
    // owns server-side effects (notably Seller order creation) that happen before the
    // engine. Revocation and cross-door misbinding must therefore stop the WHOLE run here,
    // not merely empty the downstream tool allowlist.
    const storedDoor = deps.definitionStore.get(contract_id);
    if (
      storedDoor === null
      || !isContractActive(storedDoor, deps.now())
      || !contractPermitsDoorType(storedDoor, 'reception')
    ) {
      return {
        kind: 'failed',
        errors: ['public reception door is no longer active; ask the owner to re-bind this form'],
      };
    }

    // Request-rate limits bound HOW OFTEN this reaches us. This is the orthogonal per-run
    // cost fence: use the current recipe and the policy persisted at the owner's bind.
    // Missing/legacy policy, recipe drift, unknown kinds, foreach, and AI without opt-in all
    // fail before opening a Seller order or invoking the execution engine.
    const recipe = deps.resolveRecipe(pair.binding.recipe_id);
    if (recipe === null) {
      return {
        kind: 'failed',
        errors: [`public reception recipe '${pair.binding.recipe_id}' is unavailable`],
      };
    }
    const config = deps.resolveConfig(pair.binding.recipe_id);
    const dispatchRecipe = deps.resolveDoorRecipe?.(recipe, config ?? {})
      ?? { ok: true as const, recipe };
    if (!dispatchRecipe.ok) {
      return {
        kind: 'failed',
        errors: ['public reception recipe binding changed; ask the owner to re-bind this form'],
      };
    }
    const cost = analyzeReceptionRecipeCost(dispatchRecipe.recipe, {
      ...(deps.resolveIngredientKind === undefined
        ? {}
        : { resolveIngredientKind: deps.resolveIngredientKind }),
      ...(deps.resolveOpKinds === undefined ? {} : { resolveOpKinds: deps.resolveOpKinds }),
    });
    if (!cost.ok) {
      return { kind: 'failed', errors: [runtimeCostRefusalMessage(cost.refusal)] };
    }
    if (!receptionDoorPolicyAdmits(storedDoor?.door_execution_policy, cost.profile)) {
      return {
        kind: 'failed',
        errors: [
          cost.profile.uses_ai
            ? 'public reception recipe requires an owner AI-cost opt-in; re-bind this form'
            : 'public reception recipe has no valid per-run execution policy; re-bind this form',
        ],
      };
    }
    if (deps.resolveDoorRecipe !== undefined) {
      const resolveOp = dispatchRecipe.resolveOp ?? deps.resolveOp;
      const derived = deriveResolvedRecipeCapability(recipe, dispatchRecipe.recipe, {
        ...(config === undefined ? {} : { config }),
        ...(resolveOp === undefined ? {} : { resolveOp }),
      });
      if (!derived.ok || doorCapabilityChanged(storedDoor, derived.capability).changed) {
        return {
          kind: 'failed',
          errors: ['public reception recipe authority changed; ask the owner to re-bind this form'],
        };
      }
    }

    const activeForEndpoint = activeByEndpoint.get(input.endpoint_id) ?? 0;
    if (activeForEndpoint >= maxPerEndpoint) {
      throw new ReceptionRecipeConcurrencyError('endpoint');
    }
    if (activeGlobal >= maxGlobal) {
      throw new ReceptionRecipeConcurrencyError('global');
    }
    activeGlobal += 1;
    activeByEndpoint.set(input.endpoint_id, activeForEndpoint + 1);

    try {
      // The actor stays `anonymous` — the truth. It would have been smaller to reuse the
      // `(reception, contracted_user)` variant, which already carries a contract_id, but
      // `contracted_user` renders as an AGENT assertion while `anonymous` renders as
      // VISITOR-derived, and that actor propagates into every row the recipe writes.
      // Identity says WHO; contract_id says UNDER WHAT AUTHORITY.
      const execution_source: ExecutionSource = {
        channel: 'reception',
        actor: 'anonymous',
        reception_id: input.endpoint_id,
        contract_id,
      };

      // NOT optional: a contract-bearing source with no snapshot THROWS at
      // `evaluatePreflightAdmission`. A revoked door yields an EMPTY allowlist here, which
      // denies every dispatch — the live kill-switch over an already-public form.
      const contract_snapshot: ContractSnapshot = buildReceptionContractSnapshot(
        execution_source,
        {
          definitionStore: deps.definitionStore,
          allowedTools: allowedToolsFor(deps.definitionStore),
          grantedOperations: grantedOperationsFor(deps.definitionStore),
          now: deps.now,
        },
      );

      // ⛔ THE CONFIG MUST BE PASSED EXPLICITLY — `handleExecute` will NOT merge it for us.
      //
      // Its install-dish overlay only applies to a run with NO `run_id`
      // (`execute-handler.ts`: `else if (deps.dishStore && internal.run_id === undefined)`).
      // That gate reads `run_id` as "this is a REPLAY that brought its own config", which is
      // true of the callers it was written for — `pick-server-wiring` and `saga-server-wiring`
      // both pass a captured `config` alongside their `run_id`.
      //
      // We pass a `run_id` for an entirely different reason (idempotency; see below) and are a
      // FRESH fire, not a replay. So we fall through every branch, and without this line the
      // recipe would run with an EMPTY config: `{{config.*}}` — including the connection the
      // door was minted against, and the `seller_offer_id` the owner pointed at their offer —
      // would silently resolve to nothing. Not a refusal. Silence.
      // ── D-207 slice 3c — the order, opened SERVER-SIDE ──────────────────────────────
      //
      // Not by a recipe op, and this is FORCED rather than stylistic: every
      // `core.seller.order.*` write resolves to `ask`, an anonymous actor is pinned to the
      // `read` ceiling, so a recipe-dispatched `order.open` would HOLD — and a held run
      // returns no output, so the visitor would get a thank-you page carrying no way to
      // pay. The runner writes the order exactly as it already wrote the durable
      // submission row, and hands the recipe a READ-ONLY projection to render.
      const order = openOrderForPair(config, input, deps);
      if (!order.ok) return { kind: 'failed', errors: [order.error] };

      const result = await handleExecute(
        deps.executeDeps,
        {
          recipe_id: pair.binding.recipe_id,
          context: {
            reception_submission: input.submission,
            // Absent when the pair sells nothing — §4.4: an order exists iff there is an
            // offer. A plain intake recipe sees exactly what it saw before.
            ...(order.context === null ? {} : { reception_order: order.context }),
          },
          ...(config === undefined ? {} : { config }),
          trigger_source: 'reception',
          execution_source,
          contract_snapshot,
        },
        // The submission id is the idempotency anchor: a re-drive of the SAME submission
        // (a drain retry, a reconciliation sweep) collapses onto one run rather than
        // re-firing its side effects.
        { run_id: `reception:${input.submission_id}` },
      );

      if (!result.success) {
        // `awaiting_approval` is QUEUED, not failed — the run is durably paused at the gate.
        //
        // D-234 § 234.4 — AND SO IS `awaiting_peer`. This site asks "is the run HELD?", which
        // `commits.ts` names as the reading that takes BOTH: what it decides is whether the
        // visitor's submission is durable, and a peer hold is exactly as durable as an
        // approval one. Reading `awaiting_approval` alone sent the visitor a 503 for a run
        // that was alive and checkpointed — and because the run id is anchored on the
        // submission, a visitor who believed the error and submitted again minted a SECOND
        // run, so the peer was asked the same question twice.
        if (result.awaiting_approval === true || result.awaiting_peer === true) {
          return { kind: 'held' };
        }
        return { kind: 'failed', errors: result.errors };
      }
      return { kind: 'completed', output: result.output };
    } finally {
      activeGlobal -= 1;
      const remaining = (activeByEndpoint.get(input.endpoint_id) ?? 1) - 1;
      if (remaining <= 0) activeByEndpoint.delete(input.endpoint_id);
      else activeByEndpoint.set(input.endpoint_id, remaining);
    }
  };

  return {
    run(input) {
      // A durable submission is the idempotency identity all the way down to
      // `handleExecute`. Collapse an in-process retry before it consumes a second
      // slot or races the same run/order anchor.
      const key = `${input.endpoint_id}\u0000${input.submission_id}`;
      const existing = inFlightBySubmission.get(key);
      if (existing !== undefined) return existing;

      const started = runOnce(input);
      let tracked: Promise<ReceptionRunOutcome>;
      tracked = started.finally(() => {
        if (inFlightBySubmission.get(key) === tracked) {
          inFlightBySubmission.delete(key);
        }
      });
      inFlightBySubmission.set(key, tracked);
      return tracked;
    },
  };
};
