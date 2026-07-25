/** D-164 P4h-4 — audit-grow entry validator.
 *
 *  Pure function that gates each `AuditGrowEntryInput` at promotion-
 *  time registration. Sibling to `../bundle/validate.ts`; the rule set
 *  diverges from the bundle's because:
 *
 *    - Bundle entries are recued.com-distributed `render_template`s
 *      only — `validateBundleEntry` rejects any other kind.
 *    - Audit-grow entries are user-promoted from their own action
 *      history — both `'render_template'` and `'structural_plan'`
 *      kinds are valid. The validator enforces the per-kind rules:
 *        - `'render_template'` → deterministic-only (no `ai-*`),
 *          body parses, hash matches, no forbidden paths.
 *        - `'structural_plan'` → thinner: literal-field guards
 *          (`action_class`, `short_circuit_eligible`), no body /
 *          hash check (structural plans don't carry a body — they
 *          cache the routing decision, not a rendered output —
 *          and their hash-binding contract is deferred to a later
 *          slice).
 *
 *  Cross-check with `./replayability/structural.ts`. The P4h-2 module
 *  header promised "the registration-time validator is the gate that
 *  actually enforces `render_template ⇒ deterministic-only`. A user
 *  who picks `render_template` for a sequence the classifier flagged
 *  as `structural_plan` still hits the validator's `ai-*` reject
 *  path." This validator is that gate. The cross-check is asymmetric:
 *
 *    - `template.kind === 'render_template'` → run
 *      `classifyReplayability({step_kinds})`; reject if the
 *      classifier returns `'structural_plan'`. This is the
 *      "ai-*-bearing sequence can't be promoted as render_template"
 *      rule.
 *    - `template.kind === 'structural_plan'` → no cross-check. Users
 *      can deliberately downgrade a deterministic sequence to
 *      `'structural_plan'` (the Kitchen UI surfaces this option per
 *      design O-6: "default to whichever the structural check
 *      identifies; require explicit user confirm for
 *      `render_template`"). Downgrade is conservative, not an error.
 *
 *  Result type. `AuditGrowValidation` mirrors `BundleValidation` —
 *  discriminated `'ok'` vs `'invalid'` so the pool factory aggregates
 *  every failure without throwing per-entry. Detail strings JSON-
 *  stringify caller-supplied content so multi-line interpolation
 *  can't forge extra log lines.
 *
 *  Reasons (each maps to a distinct failure mode):
 *    - `kind_invalid` — template.kind is neither `'render_template'`
 *      nor `'structural_plan'`. Catches `as` cast drift.
 *    - `step_kinds_empty` — `step_kinds` is empty. Mirrors
 *      `classifyReplayability`'s `RangeError` posture but as a
 *      structured failure instead of a throw, so the pool factory
 *      aggregates instead of aborting.
 *    - `step_kinds_mismatch_render_template` — user picked
 *      `'render_template'` but the structural check says the step
 *      sequence has non-deterministic kinds (e.g., `ai-*`). The
 *      `detail` includes the disqualifying step kinds so the
 *      Kitchen UI can render "these AI steps disqualified your
 *      template" inline.
 *    - `action_class_invalid` / `short_circuit_eligible_invalid` —
 *      runtime guards on literal-typed fields. The TypeScript types
 *      pin them per kind; the runtime checks catch `as` cast drift.
 *    - `body_malformed` — render_template body fails the
 *      `renderRenderTemplate` dry-run with `'malformed_placeholder'`.
 *      Mirrors bundle's check exactly.
 *    - `forbidden_path` — placeholder contains a forbidden segment
 *      (`__proto__` / `constructor` / `prototype`). Mirrors bundle.
 *    - `hash_mismatch` — render_template's declared `template_hash`
 *      doesn't equal `computeBundleEntryHash(entry)`. Same hash
 *      function as the bundle uses for content-addressing
 *      consistency across both sources.
 *
 *  See: D-164
 *  § 1 templates/audit-grow / § 3 Invariant 2 / O-6. */

import {
  FORBIDDEN_SEGMENTS,
  TemplateRenderError,
  extractPlaceholderPaths,
  renderRenderTemplate,
} from '../render-body.js';
import {
  isRenderTemplate,
  isStructuralPlan,
  type RenderTemplate,
  type StructuralPlan,
  type Template,
} from '../../types.js';

// `computeBundleEntryHash` is shared content-addressing infrastructure
// across pools — identical (body, locale, slot_grammar) inputs MUST
// hash identically regardless of source so the same template body can
// flow through the bundle path (recued.com-distributed) and the
// audit-grow path (user-promoted) and be recognized as the same row.
// We import from the bundle's public barrel rather than reaching into
// `bundle/hash.ts` directly. If bundle hashing ever specializes
// (e.g., adds a signed-manifest binding), the shared hash function
// hoists to `templates/hash.ts` in its own slice — this slice ships
// the read-side coupling, not the refactor.
import { computeBundleEntryHash } from '../bundle/index.js';
import { classifyReplayability } from './replayability/structural.js';

/** Input shape — a candidate audit-grow entry pre-registration.
 *
 *  - `template` — either `RenderTemplate` or `StructuralPlan`. The
 *    validator inspects `template.kind` to decide which rule set to
 *    apply.
 *  - `locale` — registration locale (the library matches against
 *    extraction locale at gate time).
 *  - `step_kinds` — the recorded step-kind sequence from the
 *    audit-grow candidate's promoted execution. Used for the
 *    structural cross-check on `render_template` candidates. */
export interface AuditGrowEntryInput {
  readonly template: Template;
  readonly locale: string;
  readonly step_kinds: ReadonlyArray<string>;
}

/** Discriminated result. `'ok'` carries the entry typed by kind so
 *  the pool factory can stash render templates + structural plans
 *  in the same accepted list while preserving per-kind narrowing. */
export type AuditGrowValidation =
  | {
      readonly kind: 'ok';
      readonly entry: AuditGrowEntryAccepted;
    }
  | {
      readonly kind: 'invalid';
      readonly reason: AuditGrowInvalidReason;
      readonly detail: string;
    };

export interface AuditGrowEntryAccepted {
  readonly template: RenderTemplate | StructuralPlan;
  readonly locale: string;
}

export type AuditGrowInvalidReason =
  | 'kind_invalid'
  | 'step_kinds_empty'
  | 'step_kinds_mismatch_render_template'
  | 'action_class_invalid'
  | 'short_circuit_eligible_invalid'
  | 'body_malformed'
  | 'forbidden_path'
  | 'hash_mismatch';

const EMPTY_SNAPSHOT = { data: {} } as const;

/** Validate a single audit-grow entry. Pure; safe to call repeatedly. */
export const validateAuditGrowEntry = (
  entry: AuditGrowEntryInput,
): AuditGrowValidation => {
  const { template, locale, step_kinds } = entry;

  if (step_kinds.length === 0) {
    return {
      kind: 'invalid',
      reason: 'step_kinds_empty',
      detail: 'step_kinds must be non-empty (recorded execution had no steps)',
    };
  }

  const isRender = isRenderTemplate(template);
  const isPlan = isStructuralPlan(template);
  if (!isRender && !isPlan) {
    return {
      kind: 'invalid',
      reason: 'kind_invalid',
      detail: `expected kind 'render_template' or 'structural_plan', got ${JSON.stringify(
        (template as { readonly kind: unknown }).kind,
      )}`,
    };
  }

  if (isRender) {
    const structural = classifyReplayability({ step_kinds });
    if (structural.kind !== 'render_template') {
      return {
        kind: 'invalid',
        reason: 'step_kinds_mismatch_render_template',
        detail: `render_template requires deterministic step kinds; disqualifying: ${JSON.stringify(
          structural.disqualifying_step_kinds,
        )}`,
      };
    }
  }

  // Literal-field guards. Both kinds carry `action_class: 'read'` per
  // P4f types.ts; the runtime check catches `as` cast drift. The
  // expected `short_circuit_eligible` differs per kind (`true` for
  // render_template, `false` for structural_plan), so the compare
  // pivots on kind.
  const actionClassRaw = (template as { readonly action_class: unknown })
    .action_class;
  if (actionClassRaw !== 'read') {
    return {
      kind: 'invalid',
      reason: 'action_class_invalid',
      detail: `expected action_class 'read', got ${JSON.stringify(actionClassRaw)}`,
    };
  }

  const expectedShortCircuit = isRender;
  const shortCircuitRaw = (template as { readonly short_circuit_eligible: unknown })
    .short_circuit_eligible;
  if (shortCircuitRaw !== expectedShortCircuit) {
    return {
      kind: 'invalid',
      reason: 'short_circuit_eligible_invalid',
      detail: `expected short_circuit_eligible ${expectedShortCircuit} for kind ${JSON.stringify(
        template.kind,
      )}, got ${JSON.stringify(shortCircuitRaw)}`,
    };
  }

  // Render-template-only checks: body grammar + forbidden paths +
  // hash binding. Structural plans don't carry a body and don't pin
  // their hash via this slice's content-addressing.
  if (isRender) {
    try {
      renderRenderTemplate(template, EMPTY_SNAPSHOT);
    } catch (err) {
      if (
        err instanceof TemplateRenderError
        && err.reason === 'malformed_placeholder'
      ) {
        return {
          kind: 'invalid',
          reason: 'body_malformed',
          detail: `malformed placeholder ${JSON.stringify(err.path)}`,
        };
      }
      if (!(err instanceof TemplateRenderError)) throw err;
      // missing_path / non_string_value are expected snapshot-shape
      // failures at registration; they don't disqualify the body.
    }

    const forbiddenPath = findForbiddenPath(template.body);
    if (forbiddenPath !== null) {
      return {
        kind: 'invalid',
        reason: 'forbidden_path',
        detail: `placeholder ${JSON.stringify(forbiddenPath.path)} contains forbidden segment ${JSON.stringify(forbiddenPath.segment)}`,
      };
    }

    const computed = computeBundleEntryHash({
      body: template.body,
      locale,
      slot_grammar: template.slot_grammar,
    });
    if (computed !== template.template_hash) {
      return {
        kind: 'invalid',
        reason: 'hash_mismatch',
        detail: `expected ${JSON.stringify(template.template_hash)}, computed ${JSON.stringify(computed)}`,
      };
    }
  }

  return { kind: 'ok', entry: { template, locale } };
};

/** Scan body placeholders for any segment in `FORBIDDEN_SEGMENTS`.
 *  Returns the first offending path + segment, or null. Mirrors the
 *  helper in `../bundle/validate.ts` (kept local to avoid the
 *  cross-pool dependency for a one-screen private). */
const findForbiddenPath = (
  body: string,
): { readonly path: string; readonly segment: string } | null => {
  for (const path of extractPlaceholderPaths(body)) {
    for (const segment of path.split('.')) {
      if (FORBIDDEN_SEGMENTS.has(segment)) {
        return { path, segment };
      }
    }
  }
  return null;
};
