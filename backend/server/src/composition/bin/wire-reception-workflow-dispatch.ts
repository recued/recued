/** D-173 P3 § A.7 — reception review-then-approve dispatch seam composer.
 *
 *  Builds the `FireReceptionWorkflow` seam the reception drain processors use
 *  to dispatch a pending submission into the compiled `review-then-approve`
 *  workflow (the SINGLE path for REVIEW-mode endpoints — the default, D3). The
 *  seam fires the kind's compiled recipe through the PUBLIC `handleExecute`
 *  with `context.event.payload = <projection payload>`; the recipe's
 *  `approval_required` materialize op is then HELD at the D-157 gate
 *  (`awaiting_approval`) and the Reception Inbox surfaces it for approve/reject.
 *
 *  This is the production wiring of the EXACT chain the D-173 capstone proves
 *  (`handleExecute` → catalog gate `ask` → checkpoint + `awaiting_approval`
 *  anchor → inbox). The drain — which used to AUTO-MATERIALIZE every pending
 *  row — now hands review-mode rows to this seam instead, so there is ONE
 *  materialize path (the user's explicit approve, through the projection) and
 *  no double-materialization. Auto-accept endpoints never reach this seam (they
 *  materialize straight through the local projection — A.7).
 *
 *  Recipe resolution. Each reception kind installs a core-pack whose
 *  `review-then-approve` workflow-family row compiles (D-170 N.18) to a
 *  pure-workflow recipe registered in the recipe store under the pack slug. The
 *  seam resolves that recipe by scanning `recipeStore.listForPack(<slug>)` for
 *  the recipe whose first `event_triggers` entry is a
 *  `composition.reception_*` event — the compiled review-then-approve recipe.
 *  Resolution is re-attempted per dispatch when unresolved (a pack installed
 *  after boot resolves on the next pending-row sweep without a restart), and
 *  cached once found (the recipe id is install-stable). When no such recipe is
 *  installed the seam returns `{ dispatched: false }` and the processor leaves
 *  the row PENDING (it dispatches once the pack installs — never materialized
 *  as a fallback, which would bypass review, I-1).
 *
 *  Provenance. The fired run carries a `reactive` / `system` `ExecutionSource`
 *  whose `source_recipe` is the compiled recipe id (a `reception-*` token the
 *  inbox's origin filter recognises — `defaultIsReceptionOriginAnchor`) and
 *  whose `event_kind` is the recipe's trigger event, so the held op appears in
 *  the inbox (and only there — the filter never leaks arbitrary gated ops).
 *
 *  Spec: docs/d-173-spec.md § A.7 / D3 / N.1 / I-1; docs/d-170-spec.md § N.18;
 *  docs/d-157-spec.md § A.2 / Flow 2. */

import type { ExecutionSource } from '@recued/contracts';
import type { ExecuteHandlerDeps } from '../../execute-handler.js';
import type { ExecuteRequest } from '../../types.js';
import type { RecipeStore } from '../../recipe-store.js';
import type {
  FireReceptionWorkflow,
  ReceptionWorkflowDispatch,
} from '../../ports/reception/reception-drain.js';

/** The reception kind → core-pack slug the compiled `review-then-approve`
 *  recipe is registered under. Intake / approval (P3) + scheduling (P4) +
 *  drop (P5) all dispatch through this one seam. */
const PACK_SLUG_FOR_KIND: Readonly<Record<ReceptionWorkflowDispatch['kind'], string>> = {
  intake_form: 'reception-intake',
  approval_link: 'reception-approval',
  scheduling_link: 'reception-scheduling',
  drop_link: 'reception-drop',
};

/** A `composition.reception_*` trigger event marks the compiled
 *  review-then-approve recipe (the decomposer mints `composition.<entity>`
 *  with `<entity>` a `reception_*` table). */
const RECEPTION_TRIGGER_EVENT_RE = /^composition\.reception_/;

/** The resolved compiled recipe for one reception kind. */
interface ResolvedReceptionRecipe {
  readonly recipe_id: string;
  /** The recipe's trigger event (`composition.reception_form_submission`,
   *  etc.) — stamped as the fired run's `event_kind` for provenance. */
  readonly event_kind: string;
}

export interface ComposeReceptionWorkflowDispatchDeps {
  /** The PUBLIC execute handler's deps — the seam fires the compiled recipe
   *  through `handleExecute(executeDeps, …)`, building the real engine + the
   *  reception-materialize dispatcher + the D-157 gate, exactly as every other
   *  dispatch path does. */
  readonly executeDeps: ExecuteHandlerDeps;
  /** The recipe store the compiled review-then-approve recipes are registered
   *  in (by `provisionPackCompositionForBulkInstall` at pack install). */
  readonly recipeStore: Pick<RecipeStore, 'get' | 'listForPack'>;
  /** The execute handler — injected so this composer stays decoupled from the
   *  module-level `handleExecute` import (and unit-testable with a stub). */
  readonly handleExecute: (
    deps: ExecuteHandlerDeps,
    request: ExecuteRequest,
    internal?: { run_id?: string },
  ) => Promise<unknown>;
  /** Deterministic clock seam (tests pin it; production wires `Date.now`).
   *  Used only to mint a unique synthetic run id per dispatch. */
  readonly now?: () => number;
}

/** Build the `FireReceptionWorkflow` seam. The drain processors call it per
 *  review-mode pending row; it fires the kind's compiled recipe (held at the
 *  gate → inbox) or reports `{ dispatched: false }` when no recipe is wired. */
export const composeReceptionWorkflowDispatch = (
  deps: ComposeReceptionWorkflowDispatchDeps,
): FireReceptionWorkflow => {
  const now = deps.now ?? (() => Date.now());
  // Per-kind resolution cache. Re-resolved on a miss so a pack installed after
  // boot lights up on the next sweep; the recipe id is install-stable, so a
  // hit is cached for the process lifetime.
  const cache = new Map<ReceptionWorkflowDispatch['kind'], ResolvedReceptionRecipe>();

  const resolveRecipe = (
    kind: ReceptionWorkflowDispatch['kind'],
  ): ResolvedReceptionRecipe | null => {
    const cached = cache.get(kind);
    if (cached !== undefined) return cached;
    const slug = PACK_SLUG_FOR_KIND[kind];
    // Scan the pack's compiled recipes for the review-then-approve one (its
    // trigger is a `composition.reception_*` event). `listForPack` yields the
    // recipe ids; `get` resolves each definition.
    for (const recipeId of deps.recipeStore.listForPack(slug)) {
      const recipe = deps.recipeStore.get(recipeId);
      if (recipe === null) continue;
      const triggers = (recipe as { event_triggers?: ReadonlyArray<{ event?: string }> })
        .event_triggers;
      const triggerEvent = triggers?.[0]?.event;
      if (typeof triggerEvent === 'string' && RECEPTION_TRIGGER_EVENT_RE.test(triggerEvent)) {
        const resolved: ResolvedReceptionRecipe = {
          recipe_id: recipe.recipe_id,
          event_kind: triggerEvent,
        };
        cache.set(kind, resolved);
        return resolved;
      }
    }
    return null;
  };

  return async (dispatch: ReceptionWorkflowDispatch): Promise<{ dispatched: boolean }> => {
    const resolved = resolveRecipe(dispatch.kind);
    if (resolved === null) {
      // No compiled review-then-approve recipe for this kind (pack not
      // installed). The caller leaves the row pending — never materialize.
      return { dispatched: false };
    }

    // The reception-incoming provenance the inbox origin filter recognises
    // (`reactive` / `system`; `source_recipe` is a `reception-*` token). The
    // compiled recipe forwards `context.event.payload` as the materialize op's
    // `args`.
    const executionSource: ExecutionSource = {
      channel: 'reactive',
      actor: 'system',
      event_kind: resolved.event_kind,
      source_recipe: resolved.recipe_id,
    };

    // A unique synthetic run id per dispatch — the host's run-anchor identity
    // for this fresh fire. Includes the source ref + a monotone-ish stamp so
    // re-dispatches (a rare crash-window double-fire) don't collide anchors.
    const runId = `reception-${dispatch.kind}-${dispatch.source_ref}-${now()}`;

    try {
      await deps.handleExecute(
        deps.executeDeps,
        {
          recipe_id: resolved.recipe_id,
          trigger_source: 'reactive',
          execution_source: executionSource,
          context: { event: { payload: dispatch.payload } },
        },
        { run_id: runId },
      );
      // The op held at the gate (or completed, in the unlikely event a profile
      // override auto-accepted it engine-side — still a single materialize).
      // Either way the row is handed off: report dispatched so the processor
      // marks it processed.
      return { dispatched: true };
    } catch (e) {
      // `handleExecute` carries runtime errors inside its response (it does NOT
      // throw for a held/failed run); a throw here is a request-shape problem
      // (e.g. recipe vanished between resolve + fire). Leave the row pending to
      // retry rather than lose it.
      console.warn(
        `[d-173.p3] reception ${dispatch.kind} workflow dispatch for '${dispatch.source_ref}' failed`,
        e,
      );
      return { dispatched: false };
    }
  };
};
