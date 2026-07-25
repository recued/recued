/** Entity-targeting guard (reactive-automation design § 8) — the server
 *  half of targeted-without-target warn+block.
 *
 *  A TARGETED recipe (it reads one specific record the caller must
 *  supply — `deriveRecipeTargeting`, the rule set the webclient run modal
 *  shares) dispatched without its target doesn't fail loud: the missing
 *  ref resolves undefined and the run executes on nothing. Post-D-148,
 *  manual runs arrive from THREE callers (webclient rpc / chat tools /
 *  MCP), so the run-modal check alone cannot carry the rule — this guard
 *  blocks at the one chokepoint (`handleExecute`, before the R2 dispatch
 *  resolve) regardless of caller.
 *
 *  Scope: caller-initiated runs only. Machine dispatches are exempt by a
 *  CLOSED list of their `trigger_source` values — their data arrives from
 *  the trigger itself (`context.event` payloads, schedule-pinned config),
 *  and those context fields are engine-injected, which the derivation
 *  already ignores. Unknown / absent sources are guarded (fail-closed for
 *  any new interactive surface). The three internal dispatchers that
 *  stamp `'manual'` stay safe by construction: saga compensation recipes
 *  carry literal selectors (`args: { id: <captured> }`, zero context
 *  refs), pick re-runs re-dispatch a request that already passed this
 *  guard (asks are never raised for context-carrying requests), and the
 *  merge outbox's 'manual' is an approval payload, not an ExecuteRequest.
 */
import {
  assessRunTargets,
  buildTargetRequiredMessage,
  deriveRecipeTargeting,
  RpcError,
  type RecipeDefinition,
} from '@recued/contracts';

/** Trigger sources whose dispatches are machine-driven — the trigger
 *  supplies the data, no caller exists to answer a "supply the target"
 *  error. Mirrors the producers: scheduler (`schedule` / `backfill`),
 *  auto-run ticks (`auto_run` / `reactive`), event-trigger dispatch
 *  (`event_trigger`), webhook accelerators (`webhook`), plus the legacy
 *  `scheduled` spelling. */
const MACHINE_TRIGGER_SOURCES: ReadonlySet<string> = new Set([
  'auto_run',
  'backfill',
  'event_trigger',
  'reactive',
  'schedule',
  'scheduled',
  'webhook',
]);

/** Throw `recipe_target_required` (400) when a caller-initiated run of a
 *  targeted recipe carries none of its targets. No-op for machine
 *  dispatches and for satisfied / non-targeted runs. */
export const assertRunTargets = (
  recipe: RecipeDefinition,
  request: {
    trigger_source?: string;
    config?: Record<string, unknown>;
    context?: Record<string, unknown>;
  },
): void => {
  if (request.trigger_source !== undefined && MACHINE_TRIGGER_SOURCES.has(request.trigger_source)) {
    return;
  }
  const targeting = deriveRecipeTargeting(recipe);
  if (!targeting.targeted) return;
  const assessment = assessRunTargets(targeting, request.config, request.context);
  if (assessment.ok) return;
  throw new RpcError(
    'recipe_target_required',
    buildTargetRequiredMessage(recipe.recipe_id, assessment.missing),
    400,
    undefined,
    { missing: assessment.missing },
  );
};
