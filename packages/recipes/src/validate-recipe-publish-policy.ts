/** §5 recipe-publish policy — the marketplace publish gate.
 *
 *  A published recipe may reach a "richer" ingredient kind
 *  (`http`/`dom`/`mcp`/connection-egress/`ai-prompt`) ONLY through a pack-bound
 *  canonical OP-STEP — the kind lives on the pack's catalog, resolved at install,
 *  so the recipe stays kind-agnostic and its blast radius is the pack's declared,
 *  gated ops. The only DIRECT ingredient steps a published recipe may carry are the
 *  binding-free kernel "core" capabilities (`core-*`), which the system provides and
 *  a normal pack structurally can't (AI-pool routing, notification dispatch). This
 *  makes a published recipe deterministically bounded — §6's "recipes: open, no
 *  safety queue; packs: curated" holds because a recipe cannot introduce a new
 *  execution point.
 *
 *  The check is STRUCTURAL (no manifest resolution): each step is one of the four
 *  `RecipeStep` shapes (+ prefetch / trigger steps), and an ingredient step is
 *  allowed iff its slug is a reserved-namespace core capability
 *  (`isCoreCapabilitySlug` — `core-` prefix AND a known bare capability, which slice
 *  1 makes unspoofable). Anything else is rejected with an actionable violation.
 *
 *  The same principle extends to the recipe's `event_triggers`: a DOM watch
 *  subscription (the dom sugar `on: 'element.changed'` or a raw `data.dom.*`
 *  pattern) reads an author-chosen origin's DOM with NO publisher-signed
 *  `domain_allowlist` — the §5 "recipe stays kind-agnostic, blast radius is the
 *  pack's declared scope" invariant fails. So a self-serve published recipe may
 *  not carry a dom watch; the shareable form ships in a pack (the curated tier).
 *  Local / unpublished recipes keep the sugar as their escape hatch. Other
 *  watch subscriptions (connection-api / mcp / messenger / reception) bind to an
 *  ENROLLED, user-granted connection/endpoint, so they carry no arbitrary-origin
 *  reach and are unaffected.
 *
 *  Enforced in the marketplace publish handler (`backend/api/src/marketplace-worker.ts`
 *  `publishRecipe`). Bundled first-party recipes ship with the server, not through
 *  this gate, so they are unaffected.
 */
import { isCoreCapabilitySlug, isDomWatchTriggerEntry } from '@recued/contracts';
import type {
  RecipeDefinition,
  RecipeEventTrigger,
  RecipeStep,
  PrefetchStep,
} from '@recued/contracts';

/** One disallowed direct ingredient step in a recipe under the publish policy. */
export interface PublishPolicyViolation {
  /** the offending step's id (or `'<unknown>'` when absent). */
  step_id: string;
  /** the bare ingredient slug that was rejected (or `'<none>'` for an unrecognized step). */
  slug: string;
  /** an author-facing message naming the fix. */
  reason: string;
}

export interface PublishPolicyResult {
  ok: boolean;
  violations: PublishPolicyViolation[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const stepId = (step: Record<string, unknown>): string =>
  typeof step.id === 'string' && step.id.length > 0 ? step.id : '<unknown>';

/** Classify ONE step. Returns a violation, or null when the step is allowed.
 *  Allowed: a canonical op-step (pack-bound richer kind), a transform, a guard, or
 *  a direct ingredient step whose slug is a core capability. Everything else —
 *  including a direct richer-kind / 3rd-party ingredient, a `{{ref}}`-valued
 *  ingredient (unverifiable), or an unrecognized shape — is rejected (fail closed).
 *
 *  A well-formed step carries EXACTLY ONE discriminant (`transform` | `guard` |
 *  `op` | `ingredient`); `parseRecipe` enforces that on the live worker path. This
 *  gate re-checks it itself (it is public API — a future caller may invoke it on
 *  raw JSON without `parseRecipe`): a step that carries an `ingredient` ALONGSIDE a
 *  `transform`/`guard`/`op` key is ambiguous and rejected, so a richer ingredient
 *  can never be masked by a co-present allowed-shape key. */
const checkStep = (raw: unknown): PublishPolicyViolation | null => {
  if (!isRecord(raw)) {
    return { step_id: '<unknown>', slug: '<none>', reason: 'recipe step is not an object' };
  }
  const hasTransform = 'transform' in raw;
  const hasGuard = 'guard' in raw;
  const hasOp = typeof raw.op === 'string' && raw.op.length > 0;
  const hasIngredient = typeof raw.ingredient === 'string';
  const discriminants = Number(hasTransform) + Number(hasGuard) + Number(hasOp) + Number(hasIngredient);

  // Fail closed on an ambiguous (multi-discriminant) or shapeless step — a
  // well-formed step has exactly one. This stops a richer `ingredient` from being
  // masked by a co-present `transform`/`guard`/`op` key.
  if (discriminants !== 1) {
    return {
      step_id: stepId(raw),
      slug: hasIngredient ? (raw.ingredient as string) : '<none>',
      reason: discriminants === 0
        ? `step '${stepId(raw)}' is not a transform, guard, canonical op-step, or core-capability ingredient step`
        : `step '${stepId(raw)}' is ambiguous — it carries more than one of transform / guard / op / ingredient`,
    };
  }

  // transform / guard — pure local; canonical op-step — the pack-bound richer path.
  if (hasTransform || hasGuard || hasOp) return null;
  // The lone discriminant is `ingredient` — allowed ONLY for a reserved core capability.
  if (isCoreCapabilitySlug(raw.ingredient as string)) return null;
  return {
    step_id: stepId(raw),
    slug: raw.ingredient as string,
    reason:
      `step '${stepId(raw)}' calls ingredient '${raw.ingredient as string}' directly. Published recipes may only ` +
      `call core capabilities (core-ai-*, core-notification-send, core-mail-post, core-slack-post) or ` +
      `pack-bound canonical operations. Declare '${raw.ingredient as string}' in a pack and reference it as a ` +
      `canonical op-step, or replace it with a core capability.`,
  };
};

/** Classify ONE `event_triggers` entry. Returns a violation for a DOM watch
 *  subscription (sugar or raw `data.dom.*`) — barred from published recipes —
 *  or null. Other watch subscriptions pass (they bind to enrolled
 *  connections / endpoints, no arbitrary-origin reach). */
const checkTrigger = (raw: unknown, index: number): PublishPolicyViolation | null => {
  if (!isRecord(raw)) return null; // shape errors are the recipe validator's job
  if (!isDomWatchTriggerEntry(raw as Pick<RecipeEventTrigger, 'on' | 'event'>)) return null;
  return {
    step_id: `event_triggers[${index}]`,
    slug: '<dom-watch>',
    reason:
      `event_triggers[${index}] subscribes to a DOM watch (an author-chosen origin's DOM, with no ` +
      `publisher-signed domain_allowlist). Published recipes may not carry a dom watch — ship it in a ` +
      `pack (the curated tier carries the signed domain grant), or keep this recipe local / unpublished.`,
  };
};

/** Validate a recipe against the §5 publish policy. Pure + structural — no manifest
 *  resolution. Checks every step across `prefetch_steps`, `steps`, and
 *  `trigger_steps`, plus every `event_triggers` subscription. */
export const validateRecipePublishPolicy = (
  recipe: Pick<
    RecipeDefinition,
    'steps' | 'prefetch_steps' | 'trigger_steps' | 'event_triggers'
  >,
): PublishPolicyResult => {
  const violations: PublishPolicyViolation[] = [];
  const visit = (steps: ReadonlyArray<RecipeStep | PrefetchStep> | undefined): void => {
    for (const step of steps ?? []) {
      const v = checkStep(step);
      if (v) violations.push(v);
    }
  };
  if (isRecord(recipe)) {
    visit(recipe.prefetch_steps as ReadonlyArray<PrefetchStep> | undefined);
    visit(recipe.steps as ReadonlyArray<RecipeStep> | undefined);
    visit(recipe.trigger_steps as ReadonlyArray<RecipeStep> | undefined);
    const triggers = (recipe as { event_triggers?: unknown }).event_triggers;
    if (Array.isArray(triggers)) {
      triggers.forEach((t, i) => {
        const v = checkTrigger(t, i);
        if (v) violations.push(v);
      });
    }
  }
  return { ok: violations.length === 0, violations };
};
