/** ⛔⛔ A `pattern` IS THE ONLY UNBOUNDED COMPUTATION A "CLOSED" SCHEMA ADMITS,
 *  AND DEFINITION TIME ONLY ASKED WHETHER IT COMPILES.
 *
 *  It is compiled and run PER DISPATCH inside the D-165 gateway
 *  (`catalog-gateway.ts:2565`) and the D-261 preapproval lane
 *  (`preapproval-dispatch-description.ts:60`), against CALLER-supplied values,
 *  *"before an approval pause/session-grant match can confer authority"*. Node's
 *  loop is single-threaded and a synchronous regex is not interruptible — so
 *  `setTimeout` around the call cannot help, because the timer callback cannot
 *  run until the match returns. Measured through the real validator at an
 *  ordinary `maxLength: 100`: `^(a+)+$` against `'a'×32 + '!'` blocks the whole
 *  server for 43 SECONDS.
 *
 *  🔑 THIS ASSERTS THE WIRING, NOT THE FUNCTION. The probe has its own unit
 *  tests in contracts; what matters here is that it runs at the point
 *  third-party content ENTERS. `validateIngredient` is that point —
 *  `records/install-coordinator.ts:330` and
 *  `ingredient-authoring/install-composition.ts:2103` both call it, and
 *  `installed-manifest-boot-check.ts` calls it *"the one definition"*.
 *
 *  ⚠ THE FIXTURE MUST BE PROVEN TO REACH THE CHECK. A catalog-form manifest that
 *  is subtly invalid makes every `.some(...)` below read false for a reason that
 *  has nothing to do with the rule under test — the vacuous red the D-271
 *  fixture header warns about. So the first test plants a malformed pattern and
 *  asserts the PRE-EXISTING definition check fires: if that message appears, the
 *  schema is being read, and the sibling probe is reached too.
 *
 *  ⚠ SCOPE: this gate is empirical, not a proof. See
 *  internal design notes — the static alternative
 *  ("reject nested quantifiers") is worse, because `^(a|a)*$` is star height ONE
 *  and took 19 seconds in the same measurement. */

import { describe, expect, it } from 'vitest';
import { validateIngredient } from '@recued/ingredients';

/** A minimally valid CATALOG-FORM ingredient carrying one operation whose
 *  closed request schema holds `pattern`. Shape mirrors the D-271 fixture,
 *  which documents the two entry conditions `isCatalogForm` requires. */
const manifestWithPattern = (pattern: unknown): Record<string, unknown> => ({
  slug: 'redos-gate-fixture',
  name: 'ReDoS gate fixture',
  description: 'Catalog fixture carrying a closed request schema pattern.',
  author: 'recued-core',
  kind: 'connection',
  version: 1,
  category: 'data',
  risk_tier: 'read',
  input: {
    operation: null,
    args: null,
    connection_kind: 'api',
    connection: '{{config.connection}}',
  },
  output: { result: 'result' },
  operations: {
    x: {
      operation_id: 'recued-core/redos-gate.x',
      description: 'Fixture operation carrying the schema under test.',
      risk_tier: 'read',
      request_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['q'],
        properties: { q: { type: 'string', maxLength: 100, pattern } },
      },
    },
  },
});

const messagesFor = (pattern: unknown): string[] =>
  validateIngredient(manifestWithPattern(pattern)).issues
    .filter((issue) => issue.code === 'CATALOG_REQUEST_SCHEMA_INVALID')
    .map((issue) => issue.message);

const backtrackingMessages = (pattern: unknown): string[] =>
  messagesFor(pattern).filter((m) => m.includes('backtracks catastrophically'));

describe('the install gate refuses a catastrophically backtracking pattern', () => {
  it('PROOF OF REACH: the fixture reaches the schema checks at all', () => {
    // ⛔ Without this, every assertion below could be passing because the
    //   manifest never routed to `validateCatalogForm` — a vacuous green that
    //   looks exactly like a working gate. A non-string `pattern` must trip the
    //   PRE-EXISTING definition check, which sits one line above the new one.
    const messages = messagesFor(123);
    expect(
      messages.some((m) => m.includes('pattern must be a string')),
      `the fixture did not reach the schema checks; issues seen: ${JSON.stringify(messages)}`,
    ).toBe(true);
  });

  it('refuses the nested-quantifier shape', () => {
    const found = backtrackingMessages('^(a+)+$');
    expect(found.length, `issues: ${JSON.stringify(messagesFor('^(a+)+$'))}`).toBe(1);
    expect(found[0]).toContain('cannot be interrupted');
  });

  it('refuses AMBIGUOUS ALTERNATION — star height ONE, and still fatal', () => {
    // 🔑 The case the tempting static rule would miss, which is why the gate is
    //   a measurement rather than a syntax check.
    expect(backtrackingMessages('^(a|a)*$').length).toBe(1);
  });

  it('refuses the textbook pair', () => {
    expect(backtrackingMessages('^(x+x+)+y$').length).toBe(1);
  });

  it('CONTROL: an ordinary anchored pattern passes', () => {
    // ⛔ A gate that refused everything would satisfy every assertion above.
    //   These are real shapes from `community/`, where 297 distinct patterns
    //   ship and none is superlinear.
    for (const benign of [
      '^[a-z]+$',
      '^-?(?:0|[1-9][0-9]*)$',
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
      '^AC[0-9a-fA-F]{32}$',
    ]) {
      expect(backtrackingMessages(benign), benign).toEqual([]);
    }
  });

  it('a schema with no pattern at all is untouched', () => {
    expect(backtrackingMessages(undefined)).toEqual([]);
  });
});
