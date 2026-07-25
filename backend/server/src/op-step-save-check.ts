/** D-182 — inline op-step save validation (the precise narrowing of the legacy
 *  "reject every op-step" save gate).
 *
 *  The recipe validator (`parseRecipe`) already validates op-step SHAPE
 *  comprehensively: the op-id form, BARE-canonical CRM/acct verbs, `args` shape,
 *  and the connection-slot variable existence + AMBIGUITY (>1 connection var)
 *  against the recipe's declared `type:'connection'` variables
 *  (`packages/recipes/src/validate/structural.ts`, `validateCanonicalOpStep`).
 *  What it CANNOT check — it has no kernel-op registry and no installed-pack
 *  inventory — is the set this helper adds, so both inline save seams
 *  (`recipe.save` + the MCP `recued_saveRecipe` tool) stay mirrored. Each is a
 *  DEFINITELY-unrunnable op-step (no install/connection state makes it run), so
 *  it errors at the save boundary with a clear message instead of failing deep
 *  at dispatch:
 *    1. an UNREGISTERED closed-kind kernel op (`core.ai.bogus`) — no handler;
 *    2. an UNKNOWN kernel domain (`core.nope.x`) — no such `core.<domain>.*`;
 *    3. a MIS-CONVENTIONED canonical op (`core.crm.bogus.read` / a non-canonical
 *       verb `core.acct.invoice.create`) — `lowerCanonicalConventionOpStep` /
 *       the resolver fail closed on it;
 *    4. a SLOTLESS canonical op-step — a bare-canonical or canonical-convention
 *       op in `steps` with ZERO `type:'connection'` variables, which
 *       `opStepConnectionSlots` rejects at dispatch ("declares no type:
 *       'connection' variable").
 *  And ONE non-blocking advisory (5): an uncovered Tier-P `depends_on`.
 *
 *  Why this REPLACES the old blanket reject: the D-182 Slice 5 dispatch path
 *  (`resolveCanonicalRecipeForDispatch`) lowers + runs inline, never-installed
 *  op-step recipes — a kernel op self-contained (its static handler backs it), a
 *  Tier-P op against the WHOLE installed-pack universe (`depends_on` is the
 *  authoring-time declared-dependency-cover invariant, NOT a runtime gate), a
 *  CRM/canonical op once its connection slot is bound at run. So an op-step
 *  recipe is a first-class standalone artifact; persisting one is no longer
 *  storing "an unrunnable recipe" — only the genuinely-unrunnable shapes above
 *  are rejected. CONDITIONALLY-runnable shapes (a Tier-P op whose pack may be
 *  installed; a canonical op with a connection variable) are allowed. */

import type { RecipeDefinition, RecipeStep } from '@recued/contracts';
import {
  ACCT_ALIAS_VALUES,
  CANONICAL_CRM_VERBS,
  CRM_ALIAS_VALUES,
  getKernelDomain,
  isCanonicalOpStep,
  isNativeKernelOp,
  isPrefetchOpStep,
  isRegisteredKernelOp,
  parseOpId,
  uncoveredOpDependencies,
} from '@recued/contracts';
import { connectionVariableNames } from '@recued/recipes';

/** The canonical-convention vocab the dispatch lowering validates against
 *  (`lowerCanonicalConventionOpStep` family check + the resolver's verb check).
 *  Mirrored from the same contract values so the save boundary names a
 *  mis-conventioned op up front instead of letting it fail deep at dispatch. */
const CONVENTION_ALIASES: Readonly<Record<string, ReadonlySet<string>>> = {
  crm: new Set<string>(CRM_ALIAS_VALUES),
  acct: new Set<string>(ACCT_ALIAS_VALUES),
};
/** Accounting canonical ops are READ-ONLY (a money write rides the explicit
 *  ingredient binding so it keeps its approval gate) — mirrors the structural
 *  validator's local `CANONICAL_ACCT_VERBS`. */
const CONVENTION_VERBS: Readonly<Record<string, ReadonlySet<string>>> = {
  crm: new Set<string>(CANONICAL_CRM_VERBS),
  acct: new Set<string>(['search', 'read']),
};

export interface OpStepSaveCheck {
  /** Blocking — a genuinely unrunnable op-step (cases 1–4 above). The save seam
   *  rejects on any error. */
  errors: string[];
  /** Non-blocking — hygiene advisories (a Tier-P op not covered by
   *  `depends_on`). Surfaced to the author; the recipe still saves + runs (the
   *  pack resolves at dispatch iff installed). */
  warnings: string[];
}

/** Validate the op-steps of an inline-authored recipe at the save boundary.
 *  Pure — never throws; the caller decides how `errors` / `warnings` surface
 *  (the save seam rejects on `errors`, the editor renders both). */
export const checkInlineOpSteps = (recipe: RecipeDefinition): OpStepSaveCheck => {
  const errors: string[] = [];
  const warnings: string[] = [];
  // Every op id named by an op-step, across `steps` + `prefetch_steps` +
  // `trigger_steps` (the lowering walks all three) — for the depends_on cover.
  const allOps: string[] = [];
  // Whether a SEQUENTIAL op-step needs a connection slot at dispatch (a bare
  // canonical or canonical-convention op — `opStepConnectionSlots` requires a
  // type:'connection' variable for any of these). Closed-kind kernel + Tier-P
  // ops lower to concrete steps BEFORE that check, so they are NOT slot-needing.
  let hasSlotNeedingSeqOp = false;

  /** Per-op id validation. `isSequential` marks an op in `steps` (the only list
   *  `opStepConnectionSlots` reads for the slot requirement). */
  const classify = (op: string, isSequential: boolean): void => {
    allOps.push(op);
    const parsed = parseOpId(op);
    if (parsed === null) {
      // bare canonical `<entity>.<verb>` (CRM / acct / tool) — binds a slot at
      // dispatch. Its verb validity (for a crm_alias entity) is already checked
      // by parseRecipe; here we only note the slot requirement.
      if (isSequential) hasSlotNeedingSeqOp = true;
      return;
    }
    if (parsed.tier === 'kernel') {
      const domain = getKernelDomain(parsed.domain);
      if (domain === undefined) {
        errors.push(
          `step op "${op}" names an unknown kernel domain "${parsed.domain}" — no core.${parsed.domain}.* domain exists`,
        );
        return;
      }
      if (domain.class === 'closed_kind') {
        // A closed-kind kernel op is backed by a static handler — an
        // unregistered id can never lower at dispatch, so it is unrunnable.
        // Connection-less by construction, so never slot-needing.
        // D-187 slice 3 — a NATIVE verb-op (`core.data.enrichment.read` etc.) is
        // a registered kernel op BUT has no backing ingredient + no lowering
        // target: it is a grant handle for an MCP-native read tool, never a
        // recipe step. Reject it here (it would otherwise pass save then fail at
        // dispatch with no backing slug).
        if (isNativeKernelOp(op)) {
          errors.push(
            `step op "${op}" is a native MCP read tool (no backing ingredient) and cannot run as a recipe step`,
          );
        } else if (!isRegisteredKernelOp(op)) {
          errors.push(
            `step op "${op}" is not a registered kernel operation — no core.${parsed.domain}.* handler backs it`,
          );
        }
        return;
      }
      // canonical_convention (`core.crm.*` / `core.acct.*`) — resolves to a bare
      // CanonicalOpStep at dispatch, so it binds a connection slot like a bare
      // canonical op AND its `<alias>.<verb>` must be valid (dispatch fails
      // closed otherwise). The structural validator skips both for the two-tier
      // form (it has no registry), so name them here.
      if (isSequential) hasSlotNeedingSeqOp = true;
      const aliases = CONVENTION_ALIASES[parsed.domain];
      const verbs = CONVENTION_VERBS[parsed.domain];
      if (aliases === undefined || verbs === undefined) return; // unknown convention — dispatch's throw is the backstop
      const dot = parsed.op.indexOf('.');
      const family = dot === -1 ? parsed.op : parsed.op.slice(0, dot);
      const verb = dot === -1 ? '' : parsed.op.slice(dot + 1);
      if (!aliases.has(family)) {
        errors.push(
          `step op "${op}" is mis-conventioned — "${family}" is not a core.${parsed.domain}.* alias`,
        );
      } else if (!verbs.has(verb)) {
        errors.push(
          `step op "${op}" names "${verb || '(none)'}", not a canonical ${parsed.domain} verb (${[...verbs].join(', ')})`,
        );
      }
      return;
    }
    // tier === 'pack' (Tier-P) — conditionally runnable (resolves iff the pack is
    // installed). Connection binds via the lowered catalog step, not
    // `opStepConnectionSlots`, so it is NOT slot-needing. Coverage handled below.
  };

  for (const s of recipe.steps ?? []) {
    if (isCanonicalOpStep(s as RecipeStep)) classify((s as { op: string }).op, true);
  }
  for (const s of recipe.prefetch_steps ?? []) {
    if (isPrefetchOpStep(s)) classify((s as { op: string }).op, false);
  }
  for (const s of recipe.trigger_steps ?? []) {
    if (isCanonicalOpStep(s as RecipeStep)) classify((s as { op: string }).op, false);
  }

  // A bare-canonical / canonical-convention op in `steps` needs SOME
  // type:'connection' variable to bind at dispatch; with none declared,
  // `opStepConnectionSlots` fails closed. (>1 variables + an unnamed slot is the
  // ambiguity case parseRecipe already errors on.)
  if (hasSlotNeedingSeqOp && connectionVariableNames(recipe).length === 0) {
    errors.push(
      "recipe has a canonical op-step but declares no type:'connection' variable — add a variable with type: \"connection\" so the op binds a connection at dispatch",
    );
  }

  // depends_on coverage (Tier-P) — advisory only: `depends_on` is the
  // authoring-time declared-dependency-cover invariant, NOT a runtime gate (at
  // dispatch a Tier-P op resolves iff its pack is installed). Surface uncovered
  // refs so the author can record them; never block the save.
  for (const ref of uncoveredOpDependencies(allOps, recipe.depends_on ?? [])) {
    warnings.push(
      `op-step references Tier-P pack "${ref}" not declared in depends_on — add it so the dependency is recorded (the recipe still runs when the pack is installed)`,
    );
  }

  return { errors, warnings };
};
