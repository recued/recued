/** D-166 foundation: D-165 contract namespace schema seed + validator ratchets. */

import { describe, expect, it } from 'vitest';

import {
  D165_CONTRACT_SCHEMA,
  DISPATCH_ROLES,
  MERGE_RULES,
  WRITEABLE_BY,
  isDispatchRole,
  isMergeRule,
  isWriteableBy,
  validateContractWrite,
  validateContractSchemaRegistry,
  type ContractSchemaIssueCode,
  type ContractSchemaRegistry,
  type ContractWriteIssueCode,
  type DispatchRole,
  type MergeRule,
  type WriteableBy,
} from '@recued/contracts';

const EXPECTED_DISPATCH_ROLES = [
  'ingredient_inventory',
  'pack_inventory',
  // D-170 gap #2 — connection → local-catalog binding inventory role.
  'connection_binding',
  'owner_operation_defaults',
  'grant_resolution',
  'approval_composition',
  'risk_override',
  'timeout_override',
  'cache_ttl_override',
  'contract_lifecycle',
  // D-177 N.13 (P6b) — staged-trust suggestion inventory role (isolated from
  // contract_lifecycle so suggestion rows never enter a contract dispatch).
  'delegation_suggestion',
  // D-177 N.11 rule 5 (slice C) — scoped-grant proposal inventory role
  // (separate from delegation_suggestion by design, 5.i.2).
  'scoped_grant_suggestion',
  // D-202 — quality-delegation suggestion (Task 5) + signal (Slice 1) inventory
  // roles, isolated from the authorization learner (quality is a distinct axis).
  'quality_delegation_suggestion',
  'quality_delegation_signal',
  // D-182 §7.2 — per-contract cli reachability inventory role.
  'cli_reachability',
  // Grant-foundation slice 3 (D-187 amendment) — the unified (contract_id × entry_key)
  // grant set inventory role (read directly by the grant resolver, never merged). D-187
  // AMENDMENT folded the retired `enrichment_visibility` role into this one.
  'contract_grant',
] as const satisfies readonly DispatchRole[];

const EXPECTED_MERGE_RULES = [
  'union',
  'override',
  'stricter_wins',
  'tightening_only',
  'union_with_stricter_wins',
] as const satisfies readonly MergeRule[];

const EXPECTED_WRITEABLE_BY = [
  'install_planner',
  'user',
  'install_planner+user',
  'kernel',
  'user+kernel',
] as const satisfies readonly WriteableBy[];

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

const minimalValidRegistry = (): MutableRegistry => ({
  composite_keys: {
    sample: {
      segments: ['scope', 'item'],
      required: ['scope'],
      optional_tail: ['item'],
      value_shape: 'sample_value',
      applies_to: ['grant_resolution'],
      merge_precedence: 1,
      merge_rule: 'override',
      writeable_by: 'user',
    },
  },
  value_shapes: {
    sample_value: {
      fields: ['enabled', 'note'],
      types: {
        enabled: 'bool',
        note: 'string?',
      },
      required: ['enabled'],
    },
  },
});

const issueCodesFor = (
  mutate: (registry: MutableRegistry) => void,
): ContractSchemaIssueCode[] => {
  const registry = minimalValidRegistry();
  mutate(registry);
  return validateContractSchemaRegistry(
    registry as unknown as ContractSchemaRegistry,
  ).map(issue => issue.code);
};

const expectGuardMembership = (
  values: readonly string[],
  guard: (value: unknown) => boolean,
): void => {
  for (const value of values) expect(guard(value)).toBe(true);
  expect(guard('not_a_member')).toBe(false);
  for (const value of [42, null, undefined, {}, ['union']]) {
    expect(guard(value)).toBe(false);
  }
  for (const key of ['__proto__', 'constructor', 'toString']) {
    expect(guard(key)).toBe(false);
  }
};

const contractWriteIssueCodesFor = (
  scope: string,
  segments: readonly unknown[],
  value: unknown,
): ContractWriteIssueCode[] =>
  validateContractWrite(D165_CONTRACT_SCHEMA, scope, segments, value).map(issue => issue.code);

const installedIngredientValue = () => ({
  ingredient_id: 'hubspot/deal-reader',
  version: '1.2.3',
  installed_at: 1_700_000_000_000,
  catalog_kind: 'official',
});

const installedPackValue = () => ({
  pack_slug: 'sales-pack',
  version: '2.0.0',
  installed_at: 1_700_000_000_001,
  ingredient_ids: ['hubspot/deal-reader'],
});

const grantValue = () => ({
  allowed: true,
  approval: 'ask',
  risk_tier: 'read',
  denied_operation_ids: ['hubspot/deal-reader.delete_deal'],
  approval_required_operation_ids: ['hubspot/deal-reader.write_deal'],
  max_risk_without_approval: 'write',
});

const policyResolutionValue = () => ({
  pack_slug: 'sales-pack',
  group_id: 'deals',
  resolved_approval: 'ask',
  resolved_operations: ['hubspot/deal-reader.read_deals'],
  resolved_at: 1_700_000_000_002,
  resolved_by: 'user:1',
});

const overrideValue = () => ({
  denied: true,
  approval: 'always',
  max_risk_without_approval: 'write',
  timeout_ms: 5_000,
  cache_ttl_ms: 60_000,
});

const descriptorRegistry: ContractSchemaRegistry = {
  composite_keys: {
    descriptor: {
      segments: ['id'],
      required: ['id'],
      value_shape: 'descriptor_value',
      applies_to: ['grant_resolution'],
      merge_precedence: 1,
      merge_rule: 'override',
      writeable_by: 'user',
    },
  },
  value_shapes: {
    descriptor_value: {
      fields: [
        'text',
        'tags',
        'count',
        'enabled',
        'seen_at',
        'mode',
        'nullable_text',
        'nullable_tags',
      ],
      types: {
        text: 'string',
        tags: 'string[]',
        count: 'number',
        enabled: 'bool',
        seen_at: 'datetime',
        mode: 'enum:read|write|admin',
        nullable_text: 'string?',
        nullable_tags: 'string[]?',
      },
      required: ['text', 'tags', 'count', 'enabled', 'seen_at', 'mode'],
    },
  },
};

const descriptorValue = () => ({
  text: 'alpha',
  tags: ['one', 'two'],
  count: 2,
  enabled: false,
  seen_at: 1_700_000_000_003,
  mode: 'read',
  nullable_text: null,
  nullable_tags: null,
});

const descriptorIssueCodesFor = (value: Record<string, unknown>): ContractWriteIssueCode[] =>
  validateContractWrite(descriptorRegistry, 'descriptor', ['row-1'], value).map(issue => issue.code);

describe('D-165 contract schema seed', () => {
  it('exports the closed vocabularies in their canonical order', () => {
    expect(DISPATCH_ROLES).toEqual(EXPECTED_DISPATCH_ROLES);
    expect(MERGE_RULES).toEqual(EXPECTED_MERGE_RULES);
    expect(WRITEABLE_BY).toEqual(EXPECTED_WRITEABLE_BY);
  });

  it('is self-consistent according to the pure registry validator', () => {
    expect(validateContractSchemaRegistry(D165_CONTRACT_SCHEMA)).toEqual([]);
  });

  it('contains the D-165 composite keys + value shapes plus D-166 P2 policy_matrix', () => {
    expect(Object.keys(D165_CONTRACT_SCHEMA.composite_keys)).toEqual([
      'installed_ingredient',
      'installed_pack',
      'connection_catalog_binding',
      // D-182 §7.2 — per-(principal × cli-ingredient × operation) reachability.
      'cli_reachability',
      'grant',
      'policy_resolution',
      'override',
      'owner_operation',
      'contract_definition',
      // D-177 N.13 (P6b) — staged-trust suggestion rows, keyed by the
      // canonical N.13 key hash (the learner's UNIQUE-key upsert target).
      'delegation_rule_suggestion',
      // D-202 — quality-delegation suggestion rows (Task 5), keyed by the
      // canonical (recipe, op) key hash, + the Slice 1 quality VERDICT signals
      // the reject-driven learner reads (keyed by signal_id).
      'quality_delegation_suggestion',
      'quality_delegation_signal',
      // D-177 N.11 rule 5 (slice C) — scoped-grant proposal rows.
      'scoped_grant_suggestion',
      // Grant-foundation slice 3 (D-187 amendment) — the unified per-(contract_id,
      // entry_key) grant set (op / collection / topic in one namespace). D-187 AMENDMENT
      // folded the retired `enrichment` (per-topic visibility) scope into this one.
      'contract_grant',
    ]);
    expect(Object.keys(D165_CONTRACT_SCHEMA.value_shapes)).toEqual([
      'installed_ingredient_info',
      'installed_pack_info',
      'catalog_binding_info',
      // D-182 §7.2 — per-contract cli reachability state (allowlist bit).
      'cli_reachability_state',
      // Grant-foundation slice 3 (D-187 amendment) — one unified grant entry value.
      'grant_entry',
      'grant_policy',
      'merge_card_resolution',
      'override_policy',
      'owner_operation_policy',
      'contract_scope',
      'door_execution_policy',
      // D-177 N.3 — session-grant nested shapes (bound recipe identity +
      // batch member), referenced by the extended contract_definition shape.
      'bound_recipe_ref',
      'session_batch_member',
      'contract_definition',
      // D-177 N.13 (P6b) — the suggestion row + its nested snapshot
      // (the would-be rule, verbatim) and evidence shapes.
      'delegation_rule_snapshot',
      'delegation_rule_evidence',
      'delegation_rule_suggestion',
      // D-202 — the quality-delegation suggestion row + its nested snapshot
      // (the would-be grant, verbatim) and evidence shapes (Task 5), plus the
      // Slice 1 quality VERDICT signal row the reject-driven learner reads.
      'quality_delegation_snapshot',
      'quality_delegation_evidence',
      'quality_delegation_suggestion',
      'quality_delegation_signal',
      // D-177 N.11 rule 5 (slice C) — the scoped proposal row + its nested
      // snapshot (the would-be scoped grant, verbatim).
      'scoped_grant_snapshot',
      'scoped_grant_suggestion',
    ]);

    for (const compositeKey of Object.values(D165_CONTRACT_SCHEMA.composite_keys)) {
      expect(D165_CONTRACT_SCHEMA.value_shapes).toHaveProperty(compositeKey.value_shape);
    }
  });

  it('pins the grant key as a full four-segment grant, not a connection-wide match-all', () => {
    const grant = D165_CONTRACT_SCHEMA.composite_keys.grant;

    expect(grant.segments).toEqual([
      'installed_pack_id',
      'ingredient_id',
      'connection_name',
      'group_id_or_operation_id',
    ]);
    expect(grant.required).toEqual([
      'installed_pack_id',
      'ingredient_id',
      'connection_name',
      'group_id_or_operation_id',
    ]);
    expect(grant.optional_tail).toBeUndefined();
    expect(grant.merge_precedence).toBe(10);
    expect(grant.merge_rule).toBe('union_with_stricter_wins');
  });

  it('pins the user override key as an operation-suffix tightening override', () => {
    const override = D165_CONTRACT_SCHEMA.composite_keys.override;

    expect(override.segments).toEqual(['actor', 'ingredient_id', 'operation_id']);
    expect(override.required).toEqual(['actor', 'ingredient_id']);
    expect(override.optional_tail).toEqual(['operation_id']);
    expect(override.merge_rule).toBe('tightening_only');
    expect(override.merge_precedence).toBe(30);
    expect(override.applies_to).toEqual([
      'grant_resolution',
      'approval_composition',
      'risk_override',
      'timeout_override',
      'cache_ttl_override',
    ]);
  });

  it('pins D-211 owner defaults as an exact actorless operation key', () => {
    const owner = D165_CONTRACT_SCHEMA.composite_keys.owner_operation;
    expect(owner.segments).toEqual(['ingredient_id', 'operation_id']);
    expect(owner.required).toEqual(['ingredient_id', 'operation_id']);
    expect(owner.optional_tail).toBeUndefined();
    expect(owner.applies_to).toEqual(['owner_operation_defaults']);
    expect(owner.merge_rule).toBe('override');
  });

  it('pins merge precedence by composite key', () => {
    expect(
      Object.fromEntries(
        Object.entries(D165_CONTRACT_SCHEMA.composite_keys).map(([name, schema]) => [
          name,
          schema.merge_precedence,
        ]),
      ),
    ).toEqual({
      installed_ingredient: 0,
      installed_pack: 0,
      connection_catalog_binding: 0,
      // D-182 §7.2 — per-contract cli reachability, no composition (override).
      cli_reachability: 0,
      grant: 10,
      policy_resolution: 20,
      override: 30,
      owner_operation: 0,
      contract_definition: 0,
      // D-177 N.13 (P6b) — one row per key hash, no composition.
      delegation_rule_suggestion: 0,
      // D-202 — one suggestion per (recipe, op) key hash (Task 5); one signal per
      // signal_id (Slice 1). No composition (override).
      quality_delegation_suggestion: 0,
      quality_delegation_signal: 0,
      // D-177 N.11 rule 5 (slice C) — same posture.
      scoped_grant_suggestion: 0,
      // Grant-foundation slice 3 (D-187 amendment) — one row per (contract_id,
      // entry_key), no composition (override). D-187 AMENDMENT folded the retired
      // `enrichment` (per-topic visibility) scope into this one.
      contract_grant: 0,
    });
  });

  it('keeps every composite key within the declared vocabularies', () => {
    for (const compositeKey of Object.values(D165_CONTRACT_SCHEMA.composite_keys)) {
      for (const role of compositeKey.applies_to) {
        expect(DISPATCH_ROLES).toContain(role);
        expect(isDispatchRole(role)).toBe(true);
      }
      expect(MERGE_RULES).toContain(compositeKey.merge_rule);
      expect(isMergeRule(compositeKey.merge_rule)).toBe(true);
      expect(WRITEABLE_BY).toContain(compositeKey.writeable_by);
      expect(isWriteableBy(compositeKey.writeable_by)).toBe(true);
    }
  });

  it('keeps every value shape required field declared and every field typed', () => {
    for (const valueShape of Object.values(D165_CONTRACT_SCHEMA.value_shapes)) {
      for (const required of valueShape.required) {
        expect(valueShape.fields).toContain(required);
      }
      for (const field of valueShape.fields) {
        expect(valueShape.types).toHaveProperty(field);
      }
    }
  });
});

describe('contract schema registry validator', () => {
  const cases: ReadonlyArray<{
    name: string;
    code: ContractSchemaIssueCode;
    mutate: (registry: MutableRegistry) => void;
  }> = [
    {
      name: 'missing value shape',
      code: 'value_shape_missing',
      mutate: registry => {
        registry.composite_keys.sample.value_shape = 'missing_value';
      },
    },
    {
      name: 'required segment not declared in segments',
      code: 'required_not_a_segment',
      mutate: registry => {
        registry.composite_keys.sample.required = ['scope', 'missing'];
      },
    },
    {
      name: 'optional tail segment not declared in segments',
      code: 'optional_tail_not_a_segment',
      mutate: registry => {
        registry.composite_keys.sample.optional_tail = ['missing'];
      },
    },
    {
      name: 'optional tail overlaps required segments',
      code: 'optional_tail_overlaps_required',
      mutate: registry => {
        registry.composite_keys.sample.segments = ['item', 'scope'];
        registry.composite_keys.sample.required = ['scope'];
        registry.composite_keys.sample.optional_tail = ['scope'];
      },
    },
    {
      name: 'optional tail is not a contiguous suffix',
      code: 'optional_tail_not_suffix',
      mutate: registry => {
        registry.composite_keys.sample.segments = ['scope', 'middle', 'leaf'];
        registry.composite_keys.sample.required = ['scope'];
        registry.composite_keys.sample.optional_tail = ['middle'];
      },
    },
    {
      name: 'empty applies_to roles',
      code: 'applies_to_empty',
      mutate: registry => {
        registry.composite_keys.sample.applies_to = [];
      },
    },
    {
      name: 'unknown applies_to role',
      code: 'applies_to_unknown_role',
      mutate: registry => {
        registry.composite_keys.sample.applies_to = ['not_a_role'];
      },
    },
    {
      name: 'invalid merge rule',
      code: 'merge_rule_invalid',
      mutate: registry => {
        registry.composite_keys.sample.merge_rule = 'last_write_wins';
      },
    },
    {
      name: 'invalid writeable_by value',
      code: 'writeable_by_invalid',
      mutate: registry => {
        registry.composite_keys.sample.writeable_by = 'planner';
      },
    },
    {
      name: 'negative merge precedence',
      code: 'merge_precedence_invalid',
      mutate: registry => {
        registry.composite_keys.sample.merge_precedence = -1;
      },
    },
    {
      name: 'non-integer merge precedence',
      code: 'merge_precedence_invalid',
      mutate: registry => {
        registry.composite_keys.sample.merge_precedence = 1.5;
      },
    },
    {
      name: 'required value-shape field not declared in fields',
      code: 'value_shape_required_not_a_field',
      mutate: registry => {
        registry.value_shapes.sample_value.required = ['enabled', 'missing'];
      },
    },
    {
      name: 'value-shape field without a type descriptor',
      code: 'value_shape_field_untyped',
      mutate: registry => {
        delete registry.value_shapes.sample_value.types.note;
      },
    },
  ];

  for (const testCase of cases) {
    it(`reports ${testCase.code} for ${testCase.name}`, () => {
      expect(issueCodesFor(testCase.mutate)).toContain(testCase.code);
    });
  }
});

describe('contract schema vocabulary guards', () => {
  it('accepts only declared dispatch roles', () => {
    expectGuardMembership(DISPATCH_ROLES, isDispatchRole);
  });

  it('accepts only declared merge rules', () => {
    expectGuardMembership(MERGE_RULES, isMergeRule);
  });

  it('accepts only declared writeable_by values', () => {
    expectGuardMembership(WRITEABLE_BY, isWriteableBy);
  });
});

describe('validateContractWrite', () => {
  const validWrites: ReadonlyArray<{
    scope: string;
    segments: readonly string[];
    value: Record<string, unknown>;
  }> = [
    {
      scope: 'installed_ingredient',
      segments: ['hubspot/deal-reader'],
      value: installedIngredientValue(),
    },
    {
      scope: 'installed_pack',
      segments: ['sales-pack'],
      value: installedPackValue(),
    },
    {
      scope: 'grant',
      segments: ['sales-pack', 'hubspot/deal-reader', 'primary', 'deals'],
      value: grantValue(),
    },
    {
      scope: 'policy_resolution',
      segments: ['sales-pack', 'deals'],
      value: policyResolutionValue(),
    },
    {
      scope: 'override',
      segments: ['user:1', 'hubspot/deal-reader', 'hubspot/deal-reader.read_deals'],
      value: overrideValue(),
    },
  ];

  it('accepts a valid write for each D-165 scope', () => {
    for (const row of validWrites) {
      expect(validateContractWrite(D165_CONTRACT_SCHEMA, row.scope, row.segments, row.value))
        .toEqual([]);
    }
  });

  const issueCases: ReadonlyArray<{
    name: string;
    code: ContractWriteIssueCode;
    scope: string;
    segments: readonly unknown[];
    value: unknown;
  }> = [
    {
      name: 'unknown scope',
      code: 'unknown_scope',
      scope: 'missing_scope',
      segments: ['id'],
      value: installedIngredientValue(),
    },
    {
      name: 'missing required segment',
      code: 'missing_required_segment',
      scope: 'installed_ingredient',
      segments: [],
      value: installedIngredientValue(),
    },
    {
      name: 'too many segments',
      code: 'too_many_segments',
      scope: 'installed_ingredient',
      segments: ['hubspot/deal-reader', 'extra'],
      value: installedIngredientValue(),
    },
    {
      name: 'invalid segment',
      code: 'invalid_segment',
      scope: 'installed_ingredient',
      segments: [''],
      value: installedIngredientValue(),
    },
    {
      name: 'non-object value',
      code: 'value_not_object',
      scope: 'installed_ingredient',
      segments: ['hubspot/deal-reader'],
      value: null,
    },
    {
      name: 'missing required field',
      code: 'missing_required_field',
      scope: 'installed_ingredient',
      segments: ['hubspot/deal-reader'],
      value: {
        ingredient_id: 'hubspot/deal-reader',
        installed_at: 1_700_000_000_000,
      },
    },
    {
      name: 'unknown field',
      code: 'unknown_field',
      scope: 'installed_ingredient',
      segments: ['hubspot/deal-reader'],
      value: {
        ...installedIngredientValue(),
        extra: true,
      },
    },
    {
      name: 'type mismatch',
      code: 'type_mismatch',
      scope: 'installed_ingredient',
      segments: ['hubspot/deal-reader'],
      value: {
        ...installedIngredientValue(),
        installed_at: '2026-05-30T00:00:00.000Z',
      },
    },
  ];

  for (const testCase of issueCases) {
    it(`reports ${testCase.code} for ${testCase.name}`, () => {
      expect(contractWriteIssueCodesFor(testCase.scope, testCase.segments, testCase.value))
        .toEqual([testCase.code]);
    });
  }

  it('accepts override with and without the optional operation_id tail', () => {
    expect(
      validateContractWrite(
        D165_CONTRACT_SCHEMA,
        'override',
        ['user:1', 'hubspot/deal-reader'],
        { approval: 'ask' },
      ),
    ).toEqual([]);
    expect(
      validateContractWrite(
        D165_CONTRACT_SCHEMA,
        'override',
        ['user:1', 'hubspot/deal-reader', 'hubspot/deal-reader.read_deals'],
        { approval: 'ask' },
      ),
    ).toEqual([]);
  });

  it('rejects override writes with too few or too many segments', () => {
    expect(contractWriteIssueCodesFor('override', ['user:1'], { approval: 'ask' }))
      .toEqual(['missing_required_segment']);
    expect(
      contractWriteIssueCodesFor(
        'override',
        ['user:1', 'hubspot/deal-reader', 'hubspot/deal-reader.read_deals', 'extra'],
        { approval: 'ask' },
      ),
    ).toEqual(['too_many_segments']);
  });

  it('requires all four grant segments', () => {
    expect(
      contractWriteIssueCodesFor(
        'grant',
        ['sales-pack', 'hubspot/deal-reader', 'primary'],
        grantValue(),
      ),
    ).toEqual(['missing_required_segment']);
    expect(
      validateContractWrite(
        D165_CONTRACT_SCHEMA,
        'grant',
        ['sales-pack', 'hubspot/deal-reader', 'primary', 'deals'],
        grantValue(),
      ),
    ).toEqual([]);
  });

  it('rejects exotic row values for an empty-required override shape', () => {
    // REGRESSION 2 (non-plain object): empty-required shapes must not let
    // Date/Map/class instances stringify into corrupt persisted row values.
    class OverrideRow {
      denied = true;
    }

    for (const value of [new Date(0), new Map(), new OverrideRow()]) {
      expect(contractWriteIssueCodesFor('override', ['user:1', 'hubspot/deal-reader'], value))
        .toEqual(['value_not_object']);
    }
  });
});

describe('validateContractWrite type descriptors', () => {
  it('accepts string, string[], number, bool, datetime, enum, and nullable ? values', () => {
    expect(
      validateContractWrite(descriptorRegistry, 'descriptor', ['row-1'], descriptorValue()),
    ).toEqual([]);
  });

  const mismatchCases: ReadonlyArray<{
    name: string;
    mutate: (value: Record<string, unknown>) => void;
  }> = [
    {
      name: 'string rejects non-string',
      mutate: value => {
        value.text = 42;
      },
    },
    {
      name: 'string[] rejects non-string elements',
      mutate: value => {
        value.tags = ['ok', 42];
      },
    },
    {
      name: 'number rejects non-finite numbers',
      mutate: value => {
        value.count = Number.POSITIVE_INFINITY;
      },
    },
    {
      name: 'bool rejects non-boolean values',
      mutate: value => {
        value.enabled = 'false';
      },
    },
    {
      name: 'datetime rejects ISO strings',
      mutate: value => {
        value.seen_at = '2026-05-30T00:00:00.000Z';
      },
    },
    {
      name: 'enum rejects values outside the closed set',
      mutate: value => {
        value.mode = 'delete';
      },
    },
    {
      name: 'required descriptors reject null',
      mutate: value => {
        value.text = null;
      },
    },
  ];

  for (const testCase of mismatchCases) {
    it(`reports type_mismatch when ${testCase.name}`, () => {
      const value = descriptorValue();
      testCase.mutate(value);
      expect(descriptorIssueCodesFor(value)).toEqual(['type_mismatch']);
    });
  }

  it('accepts null only for optional ? descriptors', () => {
    expect(descriptorIssueCodesFor({
      ...descriptorValue(),
      nullable_text: null,
      nullable_tags: null,
    })).toEqual([]);
    expect(descriptorIssueCodesFor({
      ...descriptorValue(),
      text: null,
    })).toEqual(['type_mismatch']);
  });

  it('rejects sparse string arrays before JSON can serialize holes to null', () => {
    // REGRESSION 1 (sparse array): Array.prototype.every skips holes, but a
    // string[] hole persists as null through JSON.stringify and must fail.
    const sparse = [] as string[];
    sparse[2] = 'x';

    expect(descriptorIssueCodesFor({
      ...descriptorValue(),
      tags: sparse,
    })).toEqual(['type_mismatch']);
  });
});
