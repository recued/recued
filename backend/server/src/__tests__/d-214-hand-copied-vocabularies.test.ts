/** D-214 — the hand-copied lists that can drift from their source of truth.
 *
 * A sweep of every `new Set([...literals])` across the D-214 modules found
 * SEVEN hand-written set literals. Three of them (`positiveKinds`,
 * `negativeKinds`, `strongKinds`) are the admission partition, and the former
 * fourth evidence list (`materialNegativeFamilies`) now derives from their
 * strong-negative intersection; all four behaviors are pinned in
 * `d-214-evidence-kind-partition.test.ts`. This file covers the other
 * source-of-truth seams found in that sweep: internal tool names now derive
 * from their exported constants, and the denial vocabulary has been collapsed
 * to one shared source.
 *
 * ⚠ Not covered here, deliberately — `INTENT_GROUNDING_GLUE` (77 stopwords) is
 * a free-form linguistic list with no source of truth to diverge from; a test
 * would only re-type it. */

import { describe, expect, it } from 'vitest';
import type { RequestDissection } from '@recued/contracts';

import { D214_INTERNAL_TOOL_NAMES } from '../execution-case-compiler.js';
import {
  OUTCOME_REPORT_TOOL_NAME,
  REQUEST_DISSECTION_TOOL_NAME,
} from '../chat-execution-case-tools.js';
import { parseRequestDissection } from '../storage/execution-span-dissection-store.js';
import {
  EXECUTION_CASE_GATEWAY_DENIAL_REASONS,
  isExecutionCaseGatewayDenialReason,
} from '../execution-case-vocabulary.js';

describe("D-214 §8.2 — D-214's own tools must not count as governed work", () => {
  // `parseToolActivity` drops any activity whose tool is in this set
  // (`execution-case-compiler.ts:152`). That exclusion is load-bearing for the
  // admission gate: `substantive_call_count` feeds the "≥2 for a positive, ≥1
  // for a negative" bar, so if D-214's OWN bookkeeping calls counted as
  // governed work, a span could clear the bar on the strength of having
  // reported itself. The set now derives from the two exported constants.
  it('excludes exactly the D-214 chat tools, by their exported names', () => {
    expect([...D214_INTERNAL_TOOL_NAMES].sort()).toEqual(
      [OUTCOME_REPORT_TOOL_NAME, REQUEST_DISSECTION_TOOL_NAME].sort(),
    );
  });

  it('the exclusion is keyed on the constants, not on stale literals', () => {
    // Reading the constants rather than 'outcome.report' / 'request.dissection'
    // is the point: renaming a tool without updating the exclusion set would
    // pass a literal-for-literal test and fail this one.
    expect(D214_INTERNAL_TOOL_NAMES.has(OUTCOME_REPORT_TOOL_NAME)).toBe(true);
    expect(D214_INTERNAL_TOOL_NAMES.has(REQUEST_DISSECTION_TOOL_NAME)).toBe(true);
  });

  it('does not over-exclude — an ordinary governed tool still counts', () => {
    // The mirror of the above: an exclusion set that grew to swallow real tools
    // would silently starve the admission gate instead of inflating it.
    for (const tool of ['mail.send', 'contact.search', 'recipe.run']) {
      expect(D214_INTERNAL_TOOL_NAMES.has(tool)).toBe(false);
    }
  });
});

describe('D-214 §5 — the request.dissection field allowlist', () => {
  // `parseRequestDissection` rejects an object carrying ANY key outside a
  // hand-written allowlist. The allowlist is a copy of `RequestDissection`'s
  // shape, and the failure is silent in the dangerous direction: adding a field
  // to the interface without adding it to the allowlist makes every dissection
  // carrying that field parse to `null`, which drops the request shape, which
  // fails admission condition 4 ("the root request yields a matchable request
  // shape"). Nothing errors; cases just stop forming.
  const valid: RequestDissection = {
    schema_version: 1,
    intent: 'send quarterly report',
    objects: ['report'],
    entities: [{ role: 'recipient', kind: 'person' }],
    constraints: ['send'],
    outcome_sought: 'customer receives report',
  };

  // ⛔ `Record<keyof RequestDissection, true>` — TypeScript requires an entry
  // per interface field, so widening `RequestDissection` without revisiting the
  // allowlist fails `npm run typecheck:tests`.
  const FIELDS: Record<keyof RequestDissection, true> = {
    schema_version: true,
    intent: true,
    objects: true,
    entities: true,
    constraints: true,
    outcome_sought: true,
  };

  it('accepts a dissection carrying exactly the interface fields', () => {
    expect(parseRequestDissection(valid)).not.toBeNull();
  });

  it('every field of RequestDissection is admitted by the allowlist', () => {
    // Drives each key individually: a field missing from the allowlist makes
    // the whole object parse to null, so the failure names the field.
    for (const field of Object.keys(FIELDS) as Array<keyof RequestDissection>) {
      const probe = { ...valid };
      expect(
        parseRequestDissection(probe),
        `field '${field}' is in RequestDissection but rejected by the allowlist`,
      ).not.toBeNull();
      // and the parse must actually carry it through
      expect(Object.keys(parseRequestDissection(probe) ?? {})).toContain(field);
    }
  });

  it('rejects an unknown field rather than ignoring it', () => {
    expect(parseRequestDissection({ ...valid, smuggled: 'x' })).toBeNull();
  });

  it('rejects a wrong schema_version', () => {
    expect(parseRequestDissection({ ...valid, schema_version: 2 })).toBeNull();
  });

  it('rejects a non-object', () => {
    for (const bad of [null, [], 'x', 7]) {
      expect(parseRequestDissection(bad)).toBeNull();
    }
  });
});

describe('D-214 — one denial vocabulary drives learning and measurement', () => {
  // MEASURED pre-fix: deleting `destructive_denied` from either the compiler's
  // `||` chain or the experiment's Set survived the D-214 suite. The compiler,
  // experiment, and span-finalization fingerprint now all call the one helper
  // backed by this exported tuple.
  const expected = [
    'classification_blocked',
    'contract_denied',
    'policy_denied',
    'destructive_denied',
    'channel_denied',
  ];

  it('pins the authoritative closed vocabulary', () => {
    expect(EXECUTION_CASE_GATEWAY_DENIAL_REASONS).toEqual(expected);
  });

  it('classifies every member and rejects ordinary execution failures', () => {
    for (const reason of EXECUTION_CASE_GATEWAY_DENIAL_REASONS) {
      expect(isExecutionCaseGatewayDenialReason(reason)).toBe(true);
    }
    for (const reason of [
      undefined,
      'execution_error',
      'invalid_args',
      'awaiting_approval',
      'plan_cancelled',
    ]) {
      expect(isExecutionCaseGatewayDenialReason(reason)).toBe(false);
    }
  });
});
