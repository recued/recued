/** D-255 (post-retraction) — a canonical op invocation, as the TRANSIENT RECIPE the
 *  existing dispatch path already knows how to run.
 *
 *  ⛔⛔ THIS EXISTS BECAUSE A CANONICAL OP IS RECIPE-SHAPED, NOT OP-SHAPED, and that
 *  is the fact every other design for exposing it ran into. `connection-agnostic.ts`
 *  expands ONE canonical op-step into TWO steps — the raw vendor dispatch plus a
 *  `project` step that keeps the op-step id so `{{step.<id>}}` reads canonical
 *  fields. A door that "resolved the canonical op and dispatched it" would extract
 *  the raw half and silently drop the projection, handing the caller vendor-shaped
 *  records from a surface whose entire promise is that they are not.
 *
 *  🔑 SO THE UNIT OF EXPOSURE IS A RECIPE, AND EVERY GATE COMES FOR FREE. The R2
 *  probe (`r2-dispatch-resolve-then-execute-probe.test.ts`) already sealed this
 *  path at the server level: a canonical recipe resolved AT DISPATCH runs inline
 *  through the real `handleExecute` → gate → audit, is never persisted, and stamps
 *  a `connection_gateway` audit row keyed on `(connection, op)`. Nothing here adds
 *  an axis, a grant row, or a revocation concept — D-255's first cut proposed all
 *  three and was retracted because canonical resolution runs UPSTREAM of the gate
 *  (`execute-handler.ts:1797` vs `:3042`), so the resolved vendor op is what every
 *  gate already sees.
 *
 *  ⚠ WHAT THIS DELIBERATELY DOES NOT DO: decide who may call it. The recipe it
 *  builds is inert until something dispatches it, and that dispatch is gated
 *  exactly as any other — by the connection's operation profile and the op axis,
 *  on the RESOLVED vendor op. Building a recipe is not an authorization. */

import {
  ACCT_ALIAS_VALUES,
  CANONICAL_CRM_VERBS,
  CRM_ALIAS_VALUES,
  type RecipeDefinition,
  type RecipeStep,
} from '@recued/contracts';

/** The connection variable the built recipe declares. A single fixed name is
 *  correct here and not a shortcut: the recipe has exactly one op-step, so there is
 *  exactly one slot, and `opStepConnectionSlots` binds it either from the explicit
 *  `{{config.<var>}}` ref or from the recipe's single connection variable — both
 *  paths agree on this name. */
export const CANONICAL_OP_CONNECTION_VAR = 'connection';

/** The step id the single canonical op-step carries. Stable, because it is what a
 *  caller reads its result back from: the resolver's projection step KEEPS the
 *  op-step id, so `{{step.result}}` is the canonical record. */
export const CANONICAL_OP_STEP_ID = 'result';

const ALIASES: ReadonlySet<string> = new Set<string>([
  ...CRM_ALIAS_VALUES,
  ...ACCT_ALIAS_VALUES,
]);
const VERBS: ReadonlySet<string> = new Set<string>(CANONICAL_CRM_VERBS);

export interface CanonicalOpInvocation {
  /** `crm_alias` or `acct_alias` — `deal` / `contact` / `account` / `invoice` / … */
  alias: string;
  /** one of `CANONICAL_CRM_VERBS`. */
  verb: string;
  /** the canonical args — a canonical field→value body for `create`/`update`, a
   *  canonical `id` selector for `read`/`update`/`delete`, filters for `search`.
   *  Passed through verbatim; the resolver owns their translation and rejects a
   *  shape it cannot write. */
  args?: Record<string, unknown>;
}

export type CanonicalOpRecipeResult =
  | { ok: true; recipe: RecipeDefinition }
  | { ok: false; reason: string };

/** Build the transient one-step recipe for a canonical op invocation.
 *
 *  ⛔ FAILS CLOSED ON AN UNKNOWN ALIAS OR VERB rather than emitting a recipe the
 *  resolver will reject later. The later rejection would be safe too — every
 *  unresolvable path in R2 returns `{ok:false}` and changes nothing — but it
 *  reports as "this recipe did not resolve", which sends a reader to the connection
 *  and the catalog instead of to the two characters that were actually wrong. */
export const buildCanonicalOpRecipe = (
  invocation: CanonicalOpInvocation,
): CanonicalOpRecipeResult => {
  const { alias, verb } = invocation;
  if (!ALIASES.has(alias)) {
    return {
      ok: false,
      reason:
        `unknown canonical alias '${alias}' — expected one of `
        + `${[...ALIASES].sort().join(', ')}`,
    };
  }
  if (!VERBS.has(verb)) {
    return {
      ok: false,
      reason:
        `unknown canonical verb '${verb}' — expected one of `
        + `${[...VERBS].join(', ')}`,
    };
  }

  const step = {
    id: CANONICAL_OP_STEP_ID,
    op: `${alias}.${verb}`,
    ...(invocation.args !== undefined ? { args: invocation.args } : {}),
    connection: `{{config.${CANONICAL_OP_CONNECTION_VAR}}}`,
  } as unknown as RecipeStep;

  return {
    ok: true,
    recipe: {
      recipe_id: `canonical-${alias}-${verb}`,
      version: 1,
      ttl: 0,
      metadata: {
        name: `${alias}.${verb}`,
        description:
          `Canonical ${alias} ${verb} — resolved to the bound connection's vendor `
          + 'operation at dispatch.',
        author: 'recued',
        supported_platforms: [],
        tags: ['canonical'],
      },
      // ⛔ The slot derivation reads `type: 'connection'` off this map — a bare
      // string default would make it an ordinary config variable and the op-step
      // would bind no slot (`connectionVariableNames` checks the object form).
      //
      // ⚠ `label` is REQUIRED on the object form and its absence is an authoring
      // ERROR, not a cosmetic gap — caught here by running the real validator
      // rather than asserting the literal's shape. An object-form variable with a
      // `type` and no `label` reads as complete and fails
      // `variable_hint_invalid`.
      variables: {
        [CANONICAL_OP_CONNECTION_VAR]: {
          type: 'connection',
          label: `${alias} connection`,
        },
      } as unknown as RecipeDefinition['variables'],
      prefetch_steps: [],
      steps: [step],
      output: { sidebar: [] },
    } as unknown as RecipeDefinition,
  };
};
