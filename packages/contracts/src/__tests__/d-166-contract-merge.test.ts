/** D-166 Slice 3: pure contract-policy merge engine. */

import { describe, expect, it } from 'vitest';

import {
  ContractMergeError,
  FIELD_LATTICES,
  applyMergeRule,
  composeRows,
  wouldLoosen,
  type ContractMergeRow,
  type FieldLattice,
  type MergeConflict,
  type MergeRule,
} from '@recued/contracts';

const row = (
  merge_precedence: number,
  merge_rule: MergeRule,
  value: Record<string, unknown>,
): ContractMergeRow => ({
  merge_precedence,
  merge_rule,
  value,
});

const byField = (conflicts: readonly MergeConflict[]): MergeConflict[] =>
  [...conflicts].sort((a, b) => a.field.localeCompare(b.field));

const reorder = (
  rows: readonly ContractMergeRow[],
  order: readonly number[],
): ContractMergeRow[] => order.map((i) => rows[i] as ContractMergeRow);

describe('D-166 contract merge field lattices', () => {
  it('spot-checks domains, order, floors, and stricter directions', () => {
    const expected = {
      approval: {
        domain: 'enum',
        order: ['never', 'ask', 'always'],
        stricter_direction: 'high',
      },
      max_risk_without_approval: {
        domain: 'enum',
        order: ['none', 'read', 'write', 'admin'],
        stricter_direction: 'low',
      },
      risk_tier: {
        domain: 'enum',
        order: ['read', 'write', 'admin', 'destructive'],
        stricter_direction: 'high',
      },
      denied_operation_ids: {
        domain: 'set',
        stricter_direction: 'high',
      },
      allowed_operation_ids: {
        domain: 'set',
        stricter_direction: 'low',
      },
      timeout_ms: {
        domain: 'integer',
        min: 1,
        stricter_direction: 'low',
      },
      cache_ttl_ms: {
        domain: 'integer',
        min: 0,
        stricter_direction: 'low',
      },
      allowed: {
        domain: 'bool',
        stricter_direction: 'low',
      },
    } satisfies Record<string, FieldLattice>;

    for (const [field, lattice] of Object.entries(expected)) {
      expect(FIELD_LATTICES[field]).toEqual(lattice);
    }
  });
});

describe('D-166 applyMergeRule', () => {
  it('union unions set lattices and takes the incoming primitive value', () => {
    expect(
      applyMergeRule(
        {
          denied_operation_ids: ['delete', 'archive'],
          approval: 'always',
          note: 'prior',
        },
        {
          denied_operation_ids: ['read', 'delete'],
          approval: 'never',
          note: 'incoming',
        },
        'union',
      ),
    ).toEqual({
      denied_operation_ids: ['archive', 'delete', 'read'],
      approval: 'never',
      note: 'incoming',
    });
  });

  it('override returns only the incoming row and canonicalizes lattice fields', () => {
    expect(
      applyMergeRule(
        {
          approval: 'always',
          denied_operation_ids: ['prior'],
          note: 'discarded',
        },
        {
          denied_operation_ids: ['b', 'a', 'b'],
          note: 'kept',
        },
        'override',
      ),
    ).toEqual({
      denied_operation_ids: ['a', 'b'],
      note: 'kept',
    });
  });

  it('stricter_wins chooses the stricter lattice element per field direction', () => {
    expect(
      applyMergeRule(
        {
          approval: 'ask',
          max_risk_without_approval: 'none',
          allowed_operation_ids: ['calendar', 'email'],
          timeout_ms: 1_000,
          allowed: false,
        },
        {
          approval: 'always',
          max_risk_without_approval: 'admin',
          allowed_operation_ids: ['email', 'slack'],
          timeout_ms: 5_000,
          allowed: true,
        },
        'stricter_wins',
      ),
    ).toEqual({
      approval: 'always',
      max_risk_without_approval: 'none',
      allowed_operation_ids: ['email'],
      timeout_ms: 1_000,
      allowed: false,
    });
  });

  it('tightening_only composes with the same stricter-wins algebra', () => {
    expect(
      applyMergeRule(
        {
          approval: 'ask',
          timeout_ms: 5_000,
          allowed_operation_ids: ['calendar', 'email'],
        },
        {
          approval: 'never',
          timeout_ms: 1_000,
          allowed_operation_ids: ['email', 'slack'],
        },
        'tightening_only',
      ),
    ).toEqual({
      approval: 'ask',
      timeout_ms: 1_000,
      allowed_operation_ids: ['email'],
    });
  });

  it('union_with_stricter_wins unions sets and uses stricter scalar values', () => {
    expect(
      applyMergeRule(
        {
          approval: 'ask',
          max_risk_without_approval: 'none',
          allowed_operation_ids: ['calendar', 'email'],
          denied_operation_ids: ['delete'],
          timeout_ms: 5_000,
        },
        {
          approval: 'always',
          max_risk_without_approval: 'admin',
          allowed_operation_ids: ['email', 'slack'],
          denied_operation_ids: ['archive', 'delete'],
          timeout_ms: 1_000,
        },
        'union_with_stricter_wins',
      ),
    ).toEqual({
      approval: 'always',
      max_risk_without_approval: 'none',
      allowed_operation_ids: ['calendar', 'email', 'slack'],
      denied_operation_ids: ['archive', 'delete'],
      timeout_ms: 1_000,
    });
  });
});

describe('D-166 composeRows determinism', () => {
  it('is order-independent for conflict-free stricter_wins rows', () => {
    const rows = [
      row(10, 'stricter_wins', {
        approval: 'ask',
        allowed_operation_ids: ['email', 'calendar'],
      }),
      row(10, 'stricter_wins', {
        approval: 'always',
        allowed_operation_ids: ['email', 'slack'],
      }),
      row(10, 'stricter_wins', {
        approval: 'never',
        allowed_operation_ids: ['email', 'calendar', 'slack'],
      }),
    ];
    const expected = {
      policy: {
        approval: 'always',
        allowed_operation_ids: ['email'],
      },
      conflicts: [],
    };

    expect(composeRows(reorder(rows, [0, 1, 2]))).toEqual(expected);
    expect(composeRows(reorder(rows, [2, 1, 0]))).toEqual(expected);
    expect(composeRows(reorder(rows, [1, 0, 2]))).toEqual(expected);
  });

  it('is order-independent for conflict-free union rows and canonicalizes sets', () => {
    const rows = [
      row(10, 'union', {
        denied_operation_ids: ['b', 'a'],
        marker: 'same',
      }),
      row(10, 'union', {
        denied_operation_ids: ['c', 'b'],
        marker: 'same',
      }),
      row(10, 'union', {
        denied_operation_ids: ['a', 'd'],
        marker: 'same',
      }),
    ];
    const expected = {
      policy: {
        denied_operation_ids: ['a', 'b', 'c', 'd'],
        marker: 'same',
      },
      conflicts: [],
    };

    expect(composeRows(reorder(rows, [0, 1, 2]))).toEqual(expected);
    expect(composeRows(reorder(rows, [2, 1, 0]))).toEqual(expected);
    expect(composeRows(reorder(rows, [1, 0, 2]))).toEqual(expected);
  });

  it('is order-independent for conflict-free union_with_stricter_wins rows', () => {
    const rows = [
      row(10, 'union_with_stricter_wins', {
        approval: 'ask',
        denied_operation_ids: ['delete'],
        timeout_ms: 5_000,
      }),
      row(10, 'union_with_stricter_wins', {
        approval: 'always',
        denied_operation_ids: ['archive', 'delete'],
        timeout_ms: 1_000,
      }),
      row(10, 'union_with_stricter_wins', {
        approval: 'never',
        denied_operation_ids: ['read'],
        timeout_ms: 2_000,
      }),
    ];
    const expected = {
      policy: {
        approval: 'always',
        denied_operation_ids: ['archive', 'delete', 'read'],
        timeout_ms: 1_000,
      },
      conflicts: [],
    };

    expect(composeRows(reorder(rows, [0, 1, 2]))).toEqual(expected);
    expect(composeRows(reorder(rows, [2, 1, 0]))).toEqual(expected);
    expect(composeRows(reorder(rows, [1, 0, 2]))).toEqual(expected);
  });
});

describe('D-166 composeRows conflict surfacing', () => {
  it('surfaces override presence disagreements and accepts identical overrides', () => {
    // REGRESSION 1: override ties include field presence and absence.
    expect(
      byField(
        composeRows([
          row(5, 'override', { a: 1 }),
          row(5, 'override', { b: 2 }),
        ]).conflicts,
      ),
    ).toEqual([
      {
        kind: 'value',
        merge_precedence: 5,
        field: 'a',
        rules: ['override'],
        values: [1],
      },
      {
        kind: 'value',
        merge_precedence: 5,
        field: 'b',
        rules: ['override'],
        values: [2],
      },
    ]);

    expect(
      composeRows([
        row(5, 'override', { a: 1, b: 2 }),
        row(5, 'override', { a: 1, b: 2 }),
      ]).conflicts,
    ).toEqual([]);
  });

  it('surfaces one mixed_rule conflict for mixed rules at the same precedence', () => {
    // REGRESSION 2: mixed-rule buckets conflict before field-level comparison.
    const { conflicts } = composeRows([
      row(7, 'override', { approval: 'ask' }),
      row(7, 'union', { approval: 'ask' }),
    ]);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      kind: 'mixed_rule',
      merge_precedence: 7,
      field: '*',
      values: [],
    });
    expect(new Set(conflicts[0]?.rules)).toEqual(new Set(['override', 'union']));
  });

  it('conflicts on same-precedence union primitive disagreement but not set fields', () => {
    expect(
      composeRows([
        row(3, 'union', { approval: 'ask' }),
        row(3, 'union', { approval: 'always' }),
      ]).conflicts,
    ).toEqual([
      {
        kind: 'value',
        merge_precedence: 3,
        field: 'approval',
        rules: ['union'],
        values: ['ask', 'always'],
      },
    ]);

    expect(
      composeRows([
        row(3, 'union', { denied_operation_ids: ['b', 'a'] }),
        row(3, 'union', { denied_operation_ids: ['c', 'b'] }),
      ]),
    ).toEqual({
      policy: {
        denied_operation_ids: ['a', 'b', 'c'],
      },
      conflicts: [],
    });
  });

  it('does not conflict for single-rule stricter-family buckets', () => {
    const strictRules = [
      'stricter_wins',
      'tightening_only',
      'union_with_stricter_wins',
    ] as const satisfies readonly MergeRule[];

    for (const rule of strictRules) {
      expect(
        composeRows([
          row(9, rule, { approval: 'ask', timeout_ms: 5_000 }),
          row(9, rule, { approval: 'always', timeout_ms: 1_000 }),
        ]).conflicts,
      ).toEqual([]);
    }
  });
});

describe('D-166 merge-engine regression locks', () => {
  it('rejects integer-domain violations across applyMergeRule, composeRows, and wouldLoosen', () => {
    // REGRESSION 3: integer lattices reject below-floor and non-integer values.
    const invalidValues = [
      { timeout_ms: 0 },
      { cache_ttl_ms: -1 },
      { timeout_ms: 0.5 },
    ];

    for (const value of invalidValues) {
      expect(() => applyMergeRule({}, value, 'union')).toThrow(ContractMergeError);
      expect(() => composeRows([row(1, 'union', value)])).toThrow(ContractMergeError);
      expect(() => wouldLoosen({}, value)).toThrow(ContractMergeError);
    }
  });

  it('rejects non-lattice fields when strict-family rules merge with prior values', () => {
    // REGRESSION 4: strict-family rules may not rank opaque value-shape fields.
    const strictRules = [
      'stricter_wins',
      'tightening_only',
      'union_with_stricter_wins',
    ] as const satisfies readonly MergeRule[];

    for (const rule of strictRules) {
      expect(() => applyMergeRule({ granted: true }, { granted: false }, rule)).toThrow(ContractMergeError);
      expect(() => applyMergeRule({ max_risk_tier: 'read' }, { max_risk_tier: 'admin' }, rule)).toThrow(
        ContractMergeError,
      );
    }
  });

  it('validates a lone strict-family lattice value even when there is no prior row', () => {
    // REGRESSION 5: first strict-family values still pass through lattice validation.
    expect(() => composeRows([row(1, 'stricter_wins', { timeout_ms: 0.5 })])).toThrow(ContractMergeError);
    expect(() => composeRows([row(1, 'tightening_only', { timeout_ms: 0.5 })])).toThrow(ContractMergeError);
  });

  it('uses lattice-set canonical conflict keys but treats non-lattice arrays as opaque', () => {
    // REGRESSION 6: conflict keys match merge semantics for lattice sets only.
    expect(
      composeRows([
        row(1, 'override', { denied_operation_ids: ['a', 'b'] }),
        row(1, 'override', { denied_operation_ids: ['b', 'a'] }),
      ]),
    ).toEqual({
      policy: {
        denied_operation_ids: ['a', 'b'],
      },
      conflicts: [],
    });

    expect(
      composeRows([
        row(1, 'override', { foo: ['a', 'b'] }),
        row(1, 'override', { foo: ['b', 'a'] }),
      ]).conflicts,
    ).toEqual([
      {
        kind: 'value',
        merge_precedence: 1,
        field: 'foo',
        rules: ['override'],
        values: [
          ['a', 'b'],
          ['b', 'a'],
        ],
      },
    ]);
  });

  it('validates wouldLoosen values even when there is no prior aggregate field', () => {
    // REGRESSION 7: no-prior wouldLoosen still rejects malformed lattice values.
    expect(() => wouldLoosen({}, { timeout_ms: 0 })).toThrow(ContractMergeError);
  });

  it('validates override rows instead of returning malformed lattice policy', () => {
    // REGRESSION 8: override fails closed on invalid lattice values.
    expect(() => composeRows([row(1, 'override', { approval: 'bogus' })])).toThrow(ContractMergeError);
  });
});

describe('D-166 wouldLoosen', () => {
  it('returns no fields for tightening writes', () => {
    expect(
      wouldLoosen(
        {
          approval: 'never',
          timeout_ms: 5_000,
          denied_operation_ids: ['delete'],
        },
        {
          approval: 'always',
          timeout_ms: 1_000,
          denied_operation_ids: ['archive', 'delete'],
        },
      ),
    ).toEqual([]);
  });

  it('returns every field that would loosen the aggregate', () => {
    expect(
      wouldLoosen(
        {
          approval: 'always',
          max_risk_without_approval: 'none',
          timeout_ms: 1_000,
          allowed: false,
        },
        {
          approval: 'ask',
          max_risk_without_approval: 'admin',
          timeout_ms: 5_000,
          allowed: true,
        },
      ),
    ).toEqual(['approval', 'max_risk_without_approval', 'timeout_ms', 'allowed']);
  });

  it('rejects non-lattice fields in the incoming value', () => {
    expect(() => wouldLoosen({ approval: 'ask' }, { granted: true })).toThrow(ContractMergeError);
  });
});
