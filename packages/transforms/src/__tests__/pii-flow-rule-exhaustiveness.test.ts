/** Auto-PII trace (design § 7) — rule-table exhaustiveness gate.
 *
 *  The PII-flow trace fails CLOSED on a transform without a rule (output
 *  becomes `untraced` taint), so a missing entry can never silently launder
 *  PII — but it would degrade every recipe using the new transform on an AI
 *  path to `pii_untraced`. This cross-package check (transforms owns the
 *  schema registry, contracts owns the flow rules — transforms already
 *  depends on contracts, never the reverse) turns that degradation into a
 *  red test at the moment the transform is added: add a transform → declare
 *  its PII-flow rule.
 */

import { describe, expect, it } from 'vitest';
import { PII_FLOW_RULES } from '@recued/contracts';
import { TRANSFORM_SCHEMAS } from '../schemas.js';

describe('PII-flow rule table exhaustiveness (§ 7)', () => {
  it('every transform schema has a PII-flow rule', () => {
    const missing = Object.keys(TRANSFORM_SCHEMAS).filter(
      (name) => PII_FLOW_RULES[name] === undefined,
    );
    expect(missing, 'transforms without a PII-flow rule — add one to PII_FLOW_RULES (contracts/recipe-pii-trace.ts)').toEqual([]);
  });

  it('every PII-flow rule names a real transform (no orphans)', () => {
    const orphans = Object.keys(PII_FLOW_RULES).filter(
      (name) => TRANSFORM_SCHEMAS[name] === undefined,
    );
    expect(orphans, 'PII_FLOW_RULES entries with no matching transform schema').toEqual([]);
  });

  it("simple rule classes name args that exist in the transform's schema", () => {
    const broken: string[] = [];
    for (const [name, rule] of Object.entries(PII_FLOW_RULES)) {
      const schema = TRANSFORM_SCHEMAS[name];
      if (!schema) continue;
      const args =
        rule.rule === 'pass_array' || rule.rule === 'string_preserve'
          ? [rule.arg]
          : rule.rule === 'collapse_render' || rule.rule === 'union_values'
            ? rule.args
            : [];
      for (const arg of args) {
        if (schema[arg] === undefined) broken.push(`${name}.${arg}`);
      }
    }
    expect(broken, 'rule args not present in the transform schema').toEqual([]);
  });
});
