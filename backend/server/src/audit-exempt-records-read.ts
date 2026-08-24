/** Is a dispatching step provably a READ? The only classifier safe to answer yes.
 *
 *  Backs `AuditExemptionInput.stepIsProvablyReadOnly`. Absent, every dispatching
 *  step audits; this narrows that to Records reads and NOTHING else.
 *
 *  ⛔⛔ WHY IT KEYS ON A RECORDS OP'S **MANIFEST** RISK TIER, and why both words
 *  carry weight.
 *
 *  **RECORDS** — `RISK_FLOOR` (`ingredient-authoring/records.ts`) refuses
 *  `RISK_RANK[risk] < RISK_RANK[floor]`, and no writing action has a `read` floor
 *  (`create`/`update`/`upsert`/`import`/`batch` → `write`, `delete` →
 *  `destructive`). So a Records op declared `read` can ONLY bind `get` /
 *  `get_many` / `search` / `count` / `aggregate`. The declaration is not trusted —
 *  it is *equivalent* to the structural action, enforced by the validator, for
 *  every publisher including a stranger's. ⛔ Outside Records nothing checks the
 *  declaration: 820 shipped ops sit below their method's floor, so a non-Records
 *  catalog is refused here no matter what tier it claims.
 *
 *  **MANIFEST** — the tier stamped at install, never the effective per-dispatch
 *  one. `owner_override.risk` REPLACES the tier, and re-tiering a write to `read`
 *  is the documented way an owner stops an unattended op asking
 *  (internal design notes § 4c). Reading the effective tier would make that
 *  usability fix delete its own audit row — the two must stay independent, which
 *  is the whole reason the exemption is not keyed on risk in general.
 */
import type { IngredientManifest, RecipeDefinition } from '@recued/contracts';

/** The op ids a lowered op-step carries, keyed by step id.
 *
 *  ⚠ Keyed by ID, not by index: `StepLog` interleaves prefetch and sequential
 *  steps and keeps skipped ones, so positional alignment with `recipe.steps` is
 *  not a property anyone guaranteed. An id the map does not know audits. */
const opStepIndex = (recipe: RecipeDefinition): Map<string, {
  slug: string; operation: string;
}> => {
  const out = new Map<string, { slug: string; operation: string }>();
  const walk = (steps: unknown): void => {
    if (!Array.isArray(steps)) return;
    for (const raw of steps) {
      if (raw === null || typeof raw !== 'object') continue;
      const step = raw as {
        id?: unknown; ingredient?: unknown; input?: { operation?: unknown };
      };
      // `lowerOpStepRecipe` emits `{id, ingredient: catalog_slug,
      // input: {operation, args}}`. A hand-authored ingredient step carries no
      // `input.operation` and is therefore never indexed — so it audits.
      if (typeof step.id !== 'string' || typeof step.ingredient !== 'string') continue;
      const operation = step.input?.operation;
      if (typeof operation !== 'string' || operation.length === 0) continue;
      out.set(step.id, { slug: step.ingredient, operation });
    }
  };
  const r = recipe as unknown as { steps?: unknown; prefetch_steps?: unknown };
  // ⛔ BOTH arrays. A prefetch op dispatches exactly like a sequential one —
  // `capture-job-reply` reaches `core.mail.get` that way — and indexing only
  // `steps` would leave a prefetch unresolvable, which is safe, or worse, a
  // future reader "fixing" it by index, which is not.
  walk(r.steps);
  walk(r.prefetch_steps);
  return out;
};

/** Build the classifier for one run. Every unknown answers `false` (audit). */
export const createRecordsReadStepClassifier = (args: {
  recipe: RecipeDefinition | null | undefined;
  getManifest: (slug: string) => IngredientManifest | undefined;
}): ((step: { id?: string }) => boolean) => {
  if (args.recipe === null || args.recipe === undefined) return () => false;
  const index = opStepIndex(args.recipe);
  return (step) => {
    if (typeof step.id !== 'string') return false;
    const bound = index.get(step.id);
    if (bound === undefined) return false;
    const manifest = args.getManifest(bound.slug);
    if (manifest === undefined) return false;
    // ⛔ NOT a records catalog ⇒ refuse, whatever it claims. This is the line that
    // keeps a stranger's mis-declared `read` from buying an exemption.
    if (manifest.surfaces?.records === undefined) return false;
    const op = manifest.operations?.[bound.operation];
    if (op === undefined) return false;
    return op.risk_tier === 'read';
  };
};
