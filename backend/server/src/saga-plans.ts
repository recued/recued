/** R2 step 6 — the undo plans a torn saga's landed writes may derive.
 *
 *  ⛔ ONE COPY, BECAUSE THERE ARE NOW TWO RAISERS. This rule lived inline in
 *  `execute-handler`'s torn-saga hook while that hook was the only place a saga
 *  ask was built. The D-287-era boot sweep is a second raiser, and a second
 *  inline copy of "which landed writes may be undone" is a rule that drifts
 *  silently: the two sites would keep agreeing until one of them was edited,
 *  and the failure — a destructive undo offered for a write the other site
 *  would have refused — announces itself only by happening.
 *
 *  ⛔ IT LIVES HERE RATHER THAN IN THE GATEWAY LEAF because `deriveCompensation`
 *  is `@recued/recipes` and `@recued/gateway` declares NO dependencies; the leaf
 *  therefore takes plan derivation as an injected seam and this is what the
 *  server injects. It is not in `saga-server-wiring.ts` either: that module
 *  imports `handleExecute`, so `execute-handler` importing back from it would
 *  close a cycle.
 */
import { deriveCompensation } from '@recued/recipes';
import type { IngredientManifest } from '@recued/contracts';
import type { SagaCompensationPlanRef, TornSaga } from '@recued/gateway';

/** Derive the compensation plan for every landed write that may have one.
 *
 *  ⛔ AMBIGUITY DISCLOSES BUT NEVER COMPENSATES. A write that is not
 *  unambiguous, or whose operation/connection could not be fully attributed,
 *  is reported to the owner and offered NO undo — fail toward disclosure, away
 *  from acting. `deriveCompensation` is itself create→delete only and never
 *  infers an inverse, so a plan's absence here is the normal case, not a fault.
 */
export const deriveSagaPlans = (
  saga: TornSaga,
  getManifest: (slug: string) => IngredientManifest | undefined,
): Map<string, SagaCompensationPlanRef> => {
  const plans = new Map<string, SagaCompensationPlanRef>();
  for (const w of saga.landed_writes) {
    if (!w.unambiguous || w.operation_key === '' || w.connection_name === '') {
      continue;
    }
    const manifest = getManifest(w.catalog_slug);
    if (!manifest) continue;
    const plan = deriveCompensation(
      {
        commit_id: w.commit_id,
        operation_key: w.operation_key,
        operation_id: w.operation_id,
        catalog_slug: w.catalog_slug,
        connection_name: w.connection_name,
        output: w.output,
      },
      manifest,
    );
    if (plan !== null) plans.set(w.commit_id, plan);
  }
  return plans;
};
