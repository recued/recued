/** D-166 Slice 4a: value_shape -> canonical policy-field projection. */

import { describe, expect, it } from 'vitest';

import {
  ContractMergeError,
  D165_CONTRACT_SCHEMA,
  FIELD_LATTICES,
  POLICY_PROJECTIONS,
  applyMergeRule,
  composeRows,
  isPolicyValueShape,
  projectToPolicyFields,
  validatePolicyProjections,
  wouldLoosen,
  type ContractSchemaRegistry,
  type MergeRule,
  type PolicyProjectionIssueCode,
} from '@recued/contracts';

type MutableCompositeKeySchema = {
  segments: string[];
  required: string[];
  optional_tail?: string[];
  value_shape: string;
  applies_to: string[];
  merge_precedence: number;
  merge_rule: string;
  writeable_by: string;
};

type MutableValueShape = {
  fields: string[];
  types: Record<string, string>;
  required: string[];
};

type MutableRegistry = {
  composite_keys: Record<string, MutableCompositeKeySchema>;
  value_shapes: Record<string, MutableValueShape>;
};

const mutableD165Registry = (): MutableRegistry => ({
  composite_keys: Object.fromEntries(
    Object.entries(D165_CONTRACT_SCHEMA.composite_keys).map(([name, schema]) => [
      name,
      {
        segments: [...schema.segments],
        required: [...schema.required],
        ...(schema.optional_tail === undefined ? {} : { optional_tail: [...schema.optional_tail] }),
        value_shape: schema.value_shape,
        applies_to: [...schema.applies_to],
        merge_precedence: schema.merge_precedence,
        merge_rule: schema.merge_rule,
        writeable_by: schema.writeable_by,
      },
    ]),
  ) as Record<string, MutableCompositeKeySchema>,
  value_shapes: Object.fromEntries(
    Object.entries(D165_CONTRACT_SCHEMA.value_shapes).map(([name, shape]) => [
      name,
      {
        fields: [...shape.fields],
        types: { ...shape.types },
        required: [...shape.required],
      },
    ]),
  ) as Record<string, MutableValueShape>,
});

const asRegistry = (registry: MutableRegistry): ContractSchemaRegistry =>
  registry as unknown as ContractSchemaRegistry;

const projectionIssueCodesFor = (
  mutate: (registry: MutableRegistry) => void,
): PolicyProjectionIssueCode[] => {
  const registry = mutableD165Registry();
  mutate(registry);
  return validatePolicyProjections(asRegistry(registry)).map(issue => issue.code);
};

const row = (
  merge_precedence: number,
  merge_rule: MergeRule,
  value: Readonly<Record<string, unknown>>,
) => ({
  merge_precedence,
  merge_rule,
  value,
});

describe('D-166 policy projection map', () => {
  it('pins the policy value_shape projection key set and deny-flag declaration', () => {
    // D-187 — the `policy_matrix_cell` projection was retired with the matrix.
    expect(Object.keys(POLICY_PROJECTIONS)).toEqual([
      'grant_policy',
      'override_policy',
      'merge_card_resolution',
    ]);
    expect(POLICY_PROJECTIONS.override_policy?.deny_flag).toEqual(['denied']);
    expect(POLICY_PROJECTIONS.override_policy?.rename.denied).toBe('allowed');
  });
});

describe('D-166 projectToPolicyFields grant_policy', () => {
  it('projects the Slice-4a grant shape as already-canonical policy fields', () => {
    const value = {
      allowed: true,
      approval: 'ask',
      risk_tier: 'read',
      denied_operation_ids: ['x'],
      approval_required_operation_ids: ['y'],
      max_risk_without_approval: 'write',
    };

    expect(projectToPolicyFields('grant_policy', value)).toEqual(value);
  });

  it('drops nullish optional fields and fields outside the projection whitelist', () => {
    const cases = [
      {
        name: 'nullish optional fields',
        value: {
          allowed: true,
          approval: null,
          risk_tier: undefined,
        },
        expected: {
          allowed: true,
        },
      },
      {
        name: 'non-projected extra field',
        value: {
          allowed: true,
          bogus: 1,
        },
        expected: {
          allowed: true,
        },
      },
    ] as const satisfies ReadonlyArray<{
      name: string;
      value: Readonly<Record<string, unknown>>;
      expected: Readonly<Record<string, unknown>>;
    }>;

    for (const { value, expected } of cases) {
      expect(projectToPolicyFields('grant_policy', value)).toEqual(expected);
    }
  });
});

describe('D-166 projectToPolicyFields override_policy deny flag', () => {
  it('maps denied:true to the strict allowed:false pole', () => {
    expect(projectToPolicyFields('override_policy', { denied: true })).toEqual({
      allowed: false,
    });
  });

  it('drops denied:false instead of emitting allowed:true', () => {
    const projected = projectToPolicyFields('override_policy', { denied: false });

    expect(projected).toEqual({});
    expect('allowed' in projected).toBe(false);
    expect(wouldLoosen({ allowed: true }, projected)).toEqual([]);
  });

  it('drops absent denied instead of emitting any allowed constraint', () => {
    const projected = projectToPolicyFields('override_policy', { approval: 'ask' });

    expect(projected).toEqual({ approval: 'ask' });
    expect('allowed' in projected).toBe(false);
  });

  it('keeps canonical override fields and removes non-canonical keys', () => {
    expect(
      projectToPolicyFields('override_policy', {
        denied: true,
        approval: 'always',
        max_risk_without_approval: 'write',
        timeout_ms: 5_000,
        cache_ttl_ms: 60_000,
        bogus: 1,
      }),
    ).toEqual({
      allowed: false,
      approval: 'always',
      max_risk_without_approval: 'write',
      timeout_ms: 5_000,
      cache_ttl_ms: 60_000,
    });
  });

  it('throws on non-boolean denied values', () => {
    const cases = [
      {
        name: 'string true',
        value: 'true',
      },
      {
        name: 'number one',
        value: 1,
      },
    ] as const satisfies ReadonlyArray<{
      name: string;
      value: unknown;
    }>;

    for (const { value } of cases) {
      expect(() => projectToPolicyFields('override_policy', { denied: value })).toThrow(ContractMergeError);
    }
  });
});

describe('D-166 projectToPolicyFields merge_card_resolution', () => {
  it('renames resolved fields and drops key plus provenance metadata', () => {
    expect(
      projectToPolicyFields('merge_card_resolution', {
        resolved_approval: 'ask',
        resolved_operations: ['op1', 'op2'],
        pack_slug: 'p',
        group_id: 'g',
        resolved_at: 123,
        resolved_by: 'user:1',
      }),
    ).toEqual({
      approval: 'ask',
      allowed_operation_ids: ['op1', 'op2'],
    });
  });
});

describe('D-166 projectToPolicyFields error and purity behavior', () => {
  it('throws for inventory and unknown value shapes', () => {
    const cases = [
      'installed_ingredient_info',
      'installed_pack_info',
      'unknown_shape',
    ] as const;

    for (const valueShape of cases) {
      expect(() => projectToPolicyFields(valueShape, {})).toThrow(ContractMergeError);
    }
  });

  it('does not mutate its input value', () => {
    const value = Object.freeze({
      resolved_approval: 'ask',
      resolved_operations: Object.freeze(['op2', 'op1']),
      pack_slug: 'p',
      group_id: 'g',
      resolved_at: 123,
      resolved_by: 'user:1',
    });
    const snapshot = {
      resolved_approval: 'ask',
      resolved_operations: ['op2', 'op1'],
      pack_slug: 'p',
      group_id: 'g',
      resolved_at: 123,
      resolved_by: 'user:1',
    };

    expect(projectToPolicyFields('merge_card_resolution', value)).toEqual({
      approval: 'ask',
      allowed_operation_ids: ['op2', 'op1'],
    });
    expect(value).toEqual(snapshot);
  });
});

describe('D-166 projected rows feeding the merge engine', () => {
  it('composes each policy value_shape under its live D-165 merge rule', () => {
    const cases = [
      {
        name: 'grant_policy',
        scope: 'grant',
        valueShape: 'grant_policy',
        value: {
          allowed: true,
          approval: 'ask',
          risk_tier: 'read',
          denied_operation_ids: ['op-deny'],
          approval_required_operation_ids: ['op-review'],
          max_risk_without_approval: 'write',
        },
        expected: {
          allowed: true,
          approval: 'ask',
          risk_tier: 'read',
          denied_operation_ids: ['op-deny'],
          approval_required_operation_ids: ['op-review'],
          max_risk_without_approval: 'write',
        },
        expectedMergeRule: 'union_with_stricter_wins',
      },
      {
        name: 'override_policy',
        scope: 'override',
        valueShape: 'override_policy',
        value: {
          denied: true,
          approval: 'always',
          max_risk_without_approval: 'read',
          timeout_ms: 5_000,
          cache_ttl_ms: 60_000,
        },
        expected: {
          allowed: false,
          approval: 'always',
          max_risk_without_approval: 'read',
          timeout_ms: 5_000,
          cache_ttl_ms: 60_000,
        },
        expectedMergeRule: 'tightening_only',
      },
      {
        name: 'merge_card_resolution',
        scope: 'policy_resolution',
        valueShape: 'merge_card_resolution',
        value: {
          resolved_approval: 'ask',
          resolved_operations: ['op1', 'op2'],
          pack_slug: 'pack',
          group_id: 'group',
          resolved_at: 123,
          resolved_by: 'user:1',
        },
        expected: {
          approval: 'ask',
          allowed_operation_ids: ['op1', 'op2'],
        },
        expectedMergeRule: 'union',
      },
    ] as const satisfies ReadonlyArray<{
      name: string;
      scope: 'grant' | 'override' | 'policy_resolution';
      valueShape: string;
      value: Readonly<Record<string, unknown>>;
      expected: Readonly<Record<string, unknown>>;
      expectedMergeRule: MergeRule;
    }>;

    for (const { scope, valueShape, value, expected, expectedMergeRule } of cases) {
      const compositeKey = D165_CONTRACT_SCHEMA.composite_keys[scope];
      expect(compositeKey.value_shape).toBe(valueShape);
      expect(compositeKey.merge_rule).toBe(expectedMergeRule);
      const projected = projectToPolicyFields(valueShape, value);

      expect(projected).toEqual(expected);
      expect(() =>
        composeRows([
          row(compositeKey.merge_precedence, compositeKey.merge_rule, projected),
        ]),
      ).not.toThrow();
      expect(
        composeRows([
          row(compositeKey.merge_precedence, compositeKey.merge_rule, projected),
        ]),
      ).toEqual({
        policy: expected,
        conflicts: [],
      });
      expect(() => wouldLoosen({}, projected)).not.toThrow();
    }
  });

  it('rejects raw un-projected override value_shape fields under strict rules', () => {
    expect(() => applyMergeRule({}, { denied: true }, 'tightening_only')).toThrow(ContractMergeError);
  });
});

describe('D-166 allowed_operation_ids lattice behavior', () => {
  it('is a stricter-low set lattice where stricter-family rules intersect', () => {
    expect(FIELD_LATTICES.allowed_operation_ids).toEqual({
      domain: 'set',
      stricter_direction: 'low',
    });
    expect(
      applyMergeRule(
        { allowed_operation_ids: ['a', 'b'] },
        { allowed_operation_ids: ['b', 'c'] },
        'stricter_wins',
      ),
    ).toEqual({
      allowed_operation_ids: ['b'],
    });
    expect(
      applyMergeRule(
        { allowed_operation_ids: ['a'] },
        { allowed_operation_ids: ['b'] },
        'stricter_wins',
      ),
    ).toEqual({
      allowed_operation_ids: [],
    });
  });
});

describe('D-166 isPolicyValueShape', () => {
  it('accepts policy shapes and rejects inventory plus unknown shapes', () => {
    const cases = [
      ['grant_policy', true],
      ['override_policy', true],
      ['merge_card_resolution', true],
      ['installed_ingredient_info', false],
      ['installed_pack_info', false],
      ['unknown_shape', false],
    ] as const satisfies ReadonlyArray<readonly [string, boolean]>;

    for (const [valueShape, expected] of cases) {
      expect(isPolicyValueShape(valueShape)).toBe(expected);
    }
  });
});

describe('D-166 validatePolicyProjections', () => {
  it('accepts the live D-165 schema seed', () => {
    expect(validatePolicyProjections(D165_CONTRACT_SCHEMA)).toEqual([]);
  });

  it('surfaces projection consistency issues reachable from registry input', () => {
    const cases = [
      {
        name: 'projection key missing from registry value_shapes',
        code: 'unknown_value_shape',
        mutate: registry => {
          delete registry.value_shapes.grant_policy;
        },
      },
      {
        name: 'projection source omitted from its value_shape fields',
        code: 'source_not_a_field',
        mutate: registry => {
          registry.value_shapes.grant_policy.fields = registry.value_shapes.grant_policy.fields.filter(
            field => field !== 'allowed',
          );
        },
      },
      {
        name: 'deny flag source typed as non-boolean',
        code: 'deny_flag_source_not_boolean',
        mutate: registry => {
          registry.value_shapes.override_policy.types.denied = 'string?';
        },
      },
      {
        name: 'policy value_shape lacks a projection',
        code: 'missing_policy_projection',
        mutate: registry => {
          registry.composite_keys.custom_policy = {
            segments: ['id'],
            required: ['id'],
            value_shape: 'custom_policy_value',
            applies_to: ['grant_resolution'],
            merge_precedence: 40,
            merge_rule: 'override',
            writeable_by: 'user',
          };
          registry.value_shapes.custom_policy_value = {
            fields: ['approval'],
            types: {
              approval: 'enum:never|ask|always?',
            },
            required: [],
          };
        },
      },
      {
        name: 'projected shape is declared only for inventory roles',
        code: 'projection_for_inventory_shape',
        mutate: registry => {
          registry.composite_keys.grant.applies_to = ['ingredient_inventory'];
          registry.composite_keys.policy_resolution.applies_to = ['pack_inventory'];
          registry.composite_keys.override.applies_to = ['ingredient_inventory'];
        },
      },
    ] as const satisfies ReadonlyArray<{
      name: string;
      code: PolicyProjectionIssueCode;
      mutate: (registry: MutableRegistry) => void;
    }>;

    for (const { code, mutate } of cases) {
      expect(projectionIssueCodesFor(mutate)).toContain(code);
    }

    // NOTE: target_not_a_lattice, deny_flag_not_in_rename, and
    // deny_flag_target_not_bool are properties of the shipped
    // POLICY_PROJECTIONS/FIELD_LATTICES pair. They cannot be triggered by
    // varying only the ContractSchemaRegistry input without mutating exported
    // module constants, so the live-schema [] assertion above is the ratchet.
  });
});
