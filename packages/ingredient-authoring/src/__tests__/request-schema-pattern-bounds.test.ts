/** A `pattern` with no `maxLength` is an unbounded regex at the gateway, and the
 *  warning that says so must reach the AUTHOR and never the installer.
 *
 *  ⛔ WHY THE OPT-IN IS THE LOAD-BEARING PART, AND IS ASSERTED BOTH WAYS.
 *  `validatePack` is the same function on the authoring path and on both install
 *  paths (`pack-install-handler.ts:866`, `install-composition.ts:2022`). A rule
 *  added here without the flag would put a finding in front of somebody
 *  installing a pack they did not write and cannot fix. So the default is
 *  asserted silent, not just the opt-in asserted loud — one of those directions
 *  is the user-facing promise and it is the one a careless edit would break.
 *
 *  🔑 CLOSED SCHEMAS WERE ALREADY BOUND, which is why the rule is small.
 *  `closedRequestSchemaDefinitionIssues` refuses a string with neither
 *  `maxLength` nor `enum`, so this covers only the OPEN complement: 33 warnings
 *  across 9 packs at the time of writing, every one of them NESTED
 *  (`properties.body.…items.properties.…`) — the region the install-time probe
 *  cannot walk at all. */
import { describe, expect, it } from 'vitest';

import { validateComposition } from '../validators.js';

const CODE = 'request_schema_pattern_without_max_length';

const composition = (requestSchema: unknown): Record<string, unknown> => ({
  schema_version: 1,
  slug: 'probe/bounds',
  name: 'Bounds probe',
  operations: [{ op: 'run', request_schema: requestSchema }],
});

const codesFor = (schema: unknown, on: boolean): string[] =>
  validateComposition(composition(schema), on ? { warnUnboundedPatterns: true } : {})
    .issues.filter((i) => i.code === CODE)
    .map((i) => i.path);

describe('request_schema pattern bounds', () => {
  const unbounded = {
    type: 'object',
    properties: { q: { type: 'string', pattern: '^[a-z]+$' } },
  };

  it('⛔ stays SILENT by default — the installer must never meet it', () => {
    expect(codesFor(unbounded, false)).toStrictEqual([]);
  });

  it('warns when the option is passed', () => {
    expect(codesFor(unbounded, true)).toStrictEqual([
      'operations[0].request_schema.properties.q',
    ]);
  });

  it('is a WARNING, never an error — it must not fail a pack', () => {
    const result = validateComposition(composition(unbounded), { warnUnboundedPatterns: true });
    const hit = result.issues.find((i) => i.code === CODE);
    expect(hit?.severity).toBe('warn');
    expect(result.issues.filter((i) => i.severity === 'error' && i.code === CODE)).toStrictEqual([]);
  });

  it('a declared maxLength satisfies it', () => {
    expect(codesFor({
      type: 'object',
      properties: { q: { type: 'string', pattern: '^[a-z]+$', maxLength: 64 } },
    }, true)).toStrictEqual([]);
  });

  it('an enum satisfies it — a closed value set bounds the input without a length', () => {
    expect(codesFor({
      type: 'object',
      properties: { q: { type: 'string', pattern: '^[a-z]+$', enum: ['a', 'b'] } },
    }, true)).toStrictEqual([]);
  });

  it('reaches NESTED properties, items and union branches', () => {
    // Every real hit in the corpus is nested; a top-level-only walk would have
    // reported a clean zero over the whole of `community/packs`.
    const nested = {
      type: 'object',
      properties: {
        body: {
          type: 'object',
          properties: {
            rows: {
              type: 'array',
              items: { type: 'object', properties: { id: { type: 'string', pattern: '^x+$' } } },
            },
            when: { anyOf: [{ type: 'string', pattern: '^\\d+$' }] },
          },
        },
      },
    };
    expect(codesFor(nested, true).sort()).toStrictEqual([
      'operations[0].request_schema.properties.body.properties.rows.items.properties.id',
      'operations[0].request_schema.properties.body.properties.when.anyOf[0]',
    ]);
  });

  it('⛔ never walks response_schema — those patterns are never executed', () => {
    // Warning on them would be 3,478 occurrences of advice nobody can act on,
    // which is how a warning becomes noise and then becomes ignored.
    const withResponse = {
      schema_version: 1,
      slug: 'probe/bounds',
      name: 'Bounds probe',
      operations: [{
        op: 'run',
        response_schema: {
          type: 'object',
          properties: { id: { type: 'string', pattern: '^[a-f0-9]{24}$' } },
        },
      }],
    };
    const issues = validateComposition(withResponse, { warnUnboundedPatterns: true }).issues;
    expect(issues.filter((i) => i.code === CODE)).toStrictEqual([]);
  });
});
