/** D-164 P4g-1 — bundle entry validator.
 *
 *  Pure function that gates each `RegisteredTemplate` at bundle-pool
 *  registration time. Returns a discriminated `BundleValidation`
 *  result rather than throwing — the pool factory aggregates ALL
 *  failures across its entries so registration reports every problem
 *  at once (a missing-hash drift on one entry shouldn't hide a
 *  malformed-body bug on another).
 *
 *  Validation rules (each maps to a distinct `reason` for diagnostics):
 *    - `kind_not_render_template` — bundle distributes deterministic
 *      render templates only; structural plans take a different lifecycle
 *      (they replay through the executor) and don't belong here.
 *    - `action_class_invalid` / `short_circuit_eligible_invalid` —
 *      runtime guards on the literal-typed RenderTemplate fields. The
 *      TypeScript types pin them to `'read'` / `true`; the runtime
 *      checks catch hand-authored fixtures that drift past the type
 *      system (e.g., `as RenderTemplate` casts).
 *    - `body_malformed` — the body must parse cleanly under
 *      `renderRenderTemplate`'s placeholder grammar. The check piggy-
 *      backs on the existing render path: a `TemplateRenderError` with
 *      `reason: 'malformed_placeholder'` from a dry-run against an
 *      empty snapshot tells us the body is unparseable; any other
 *      render failure (missing path / non-string) is EXPECTED — the
 *      bundle doesn't validate snapshot shape at registration.
 *    - `forbidden_path` — any placeholder containing a segment from
 *      `FORBIDDEN_SEGMENTS` (`__proto__` / `constructor` / `prototype`).
 *      The runtime resolver also blocks these, but rejecting at
 *      registration gives a stronger boot-time guarantee + a clearer
 *      diagnostic than "render mysteriously always fails."
 *    - `hash_mismatch` — `computeBundleEntryHash(entry)` must equal
 *      `entry.template.template_hash`. Catches typos in hand-authored
 *      fixtures + tampered fetches. The reported `detail` includes
 *      `expected` (declared) + `computed` so failures are debuggable.
 *
 *  Why these rules:
 *    - **kind / action_class / short_circuit_eligible** are the
 *      discrimination + capability boundary (P4f).
 *    - **body grammar + forbidden_path** is the rendering boundary
 *      (P4f) with belt-and-suspenders at registration (P4g-1).
 *    - **hash** is the distribution boundary (P4g).
 *  Together they cover every constraint the bundle pool can enforce
 *  with no warehouse / no network — exactly P4g-1's scope.
 *
 *  Detail strings are run through `JSON.stringify` whenever they
 *  interpolate caller-supplied content. The pool factory aggregates
 *  details into a multi-line error message; un-escaped newlines /
 *  control characters in caller content could otherwise forge extra
 *  log lines.
 *
 *  Not validated here (deferred):
 *    - `slot_grammar` ↔ body-placeholder coverage. The placeholders
 *      in `body` may reference paths the snapshot provides (per-
 *      probe), not the slots themselves; tying grammar to body would
 *      assume a snapshot shape this slice doesn't fix.
 *    - Locale string format (BCP-47 normalization). Locale equality
 *      in the library is a string-compare; non-normalized locales
 *      simply won't match queries.
 *
 *  See: docs/d-164-prompt-cache-consolidation-pending-design.md
 *  § 1 templates/bundle / § 3 the deterministic gate. */

import {
  FORBIDDEN_SEGMENTS,
  TemplateRenderError,
  extractPlaceholderPaths,
  renderRenderTemplate,
} from '../render-body.js';
import { isRenderTemplate, type RenderTemplate, type Template } from '../../types.js';

import { computeBundleEntryHash } from './hash.js';

/** Pre-validation entry shape. Same fields as
 *  `RegisteredTemplate` from `../library.ts` but referenced locally so
 *  this module doesn't depend on `library.ts` (the dependency would be
 *  cyclic once the pool factory in `./index.ts` consumes both). */
export interface BundleEntryInput {
  readonly template: Template;
  readonly locale: string;
}

/** Validator outcome — discriminated union. `kind === 'ok'` always
 *  comes with the entry typed as carrying a `RenderTemplate`; failure
 *  variants carry a machine-readable `reason` + a free-form `detail`
 *  the pool factory can include in its aggregate error message. */
export type BundleValidation =
  | { readonly kind: 'ok'; readonly entry: { readonly template: RenderTemplate; readonly locale: string } }
  | { readonly kind: 'invalid'; readonly reason: BundleInvalidReason; readonly detail: string };

export type BundleInvalidReason =
  | 'kind_not_render_template'
  | 'action_class_invalid'
  | 'short_circuit_eligible_invalid'
  | 'body_malformed'
  | 'forbidden_path'
  | 'hash_mismatch';

const EMPTY_SNAPSHOT = { data: {} } as const;

/** Validate a single bundle entry. Pure; safe to call repeatedly. */
export const validateBundleEntry = (entry: BundleEntryInput): BundleValidation => {
  const { template, locale } = entry;

  if (!isRenderTemplate(template)) {
    return {
      kind: 'invalid',
      reason: 'kind_not_render_template',
      detail: `expected kind 'render_template', got ${JSON.stringify(template.kind)}`,
    };
  }

  // Defensive runtime guards — the RenderTemplate type pins these to
  // literal values but `as` casts can drift past the type system. The
  // `as` widening on each compare is required because TS narrows to
  // `never` otherwise (the literal type makes the check look unreachable).
  const actionClassRaw = (template as { readonly action_class: unknown }).action_class;
  if (actionClassRaw !== 'read') {
    return {
      kind: 'invalid',
      reason: 'action_class_invalid',
      detail: `expected action_class 'read', got ${JSON.stringify(actionClassRaw)}`,
    };
  }
  const shortCircuitRaw =
    (template as { readonly short_circuit_eligible: unknown }).short_circuit_eligible;
  if (shortCircuitRaw !== true) {
    return {
      kind: 'invalid',
      reason: 'short_circuit_eligible_invalid',
      detail: `expected short_circuit_eligible true, got ${JSON.stringify(shortCircuitRaw)}`,
    };
  }

  // Dry-run the renderer against an empty snapshot. A malformed-placeholder
  // throw is the validator's signal; other failures (missing path /
  // non-string) are expected and don't reflect a bad body.
  try {
    renderRenderTemplate(template, EMPTY_SNAPSHOT);
  } catch (err) {
    if (err instanceof TemplateRenderError && err.reason === 'malformed_placeholder') {
      return {
        kind: 'invalid',
        reason: 'body_malformed',
        detail: `malformed placeholder ${JSON.stringify(err.path)}`,
      };
    }
    // Re-throw anything unexpected — never silently swallow non-render bugs.
    if (!(err instanceof TemplateRenderError)) throw err;
    // Other render errors (missing_path / non_string_value) mean the body
    // is well-formed but snapshot-dependent; that's fine at registration.
  }

  // Reject placeholders that would always fail at runtime because they
  // reference a forbidden segment (prototype-chain guard).
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

  return { kind: 'ok', entry: { template, locale } };
};

/** Scan body placeholders for any segment in `FORBIDDEN_SEGMENTS`.
 *  Returns the first offending path + segment, or null. Pure. */
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
