/** D-166 contract_definition substrate: lifecycle, scope, and nested value_shape validation. */

import { describe, expect, it } from 'vitest';

import {
  D165_CONTRACT_SCHEMA,
  DISPATCH_ROLES,
  DOOR_TYPES,
  contractLifecycleState,
  contractScopeMatches,
  isContractActive,
  isInventoryRole,
  validateContractSchemaRegistry,
  validateContractWrite,
  type ContractDefinition,
  type ContractSchemaRegistry,
  type ContractScopeContext,
  type ContractWriteIssue,
} from '@recued/contracts';

const NOW_MS = 1_800_000_000_000;

const contractDefinition = (
  overrides: Partial<ContractDefinition> = {},
): ContractDefinition => ({
  contract_id: 'c-1',
  minted_at: NOW_MS - 1_000,
  minted_by: 'user:1',
  display_name: 'Sales handoff',
  scope: {},
  ...overrides,
});

const scopeContext = (
  overrides: Partial<ContractScopeContext> = {},
): ContractScopeContext => ({
  channel: 'chat',
  actor: 'contracted_user',
  ingredient_id: 'hubspot/deals',
  operation_id: 'hubspot/deals.read',
  connection_name: 'primary',
  ...overrides,
});

const fullContractScope = () => ({
  channels: ['chat'],
  actors: ['contracted_user'],
  ingredient_ids: ['hubspot/deals'],
  operation_ids: ['hubspot/deals.read'],
  connection_names: ['primary'],
});

const contractDefinitionValue = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  contract_id: 'c-1',
  minted_at: NOW_MS - 1_000,
  minted_by: 'user:1',
  display_name: 'Sales handoff',
  scope: fullContractScope(),
  approved_actions_template: { operations: ['hubspot/deals.read'] },
  expiry_at: NOW_MS + 60_000,
  max_uses: 5,
  uses_remaining: 4,
  revoked_at: null,
  revocation_reason: null,
  ...overrides,
});

const contractDefinitionWriteIssues = (value: unknown): ContractWriteIssue[] =>
  validateContractWrite(D165_CONTRACT_SCHEMA, 'contract_definition', ['c-1'], value);

const registryWithNestedFieldType = (
  fieldType: string,
  siblingShape?: ContractSchemaRegistry['value_shapes'][string],
): ContractSchemaRegistry => ({
  composite_keys: {
    sample: {
      segments: ['id'],
      required: ['id'],
      value_shape: 'outer',
      applies_to: ['grant_resolution'],
      merge_precedence: 0,
      merge_rule: 'override',
      writeable_by: 'user',
    },
  },
  value_shapes: {
    outer: {
      fields: ['child'],
      types: {
        child: fieldType,
      },
      required: ['child'],
    },
    ...(siblingShape
      ? {
        sibling: siblingShape,
      }
      : {}),
  },
});

describe('D-166 contract_definition lifecycle helpers', () => {
  it('resolves lifecycle state with revoked > expired > exhausted > active precedence', () => {
    const cases: ReadonlyArray<{
      name: string;
      def: ContractDefinition;
      expected: ReturnType<typeof contractLifecycleState>;
    }> = [
      {
        name: 'unbounded active',
        def: contractDefinition(),
        expected: 'active',
      },
      {
        name: 'revoked beats expired and exhausted',
        def: contractDefinition({
          revoked_at: NOW_MS - 3_000,
          expiry_at: NOW_MS - 2_000,
          uses_remaining: 0,
        }),
        expected: 'revoked',
      },
      {
        name: 'expired beats exhausted when not revoked',
        def: contractDefinition({
          expiry_at: NOW_MS - 1,
          uses_remaining: 0,
        }),
        expected: 'expired',
      },
      {
        name: 'zero uses remaining is exhausted',
        def: contractDefinition({
          uses_remaining: 0,
        }),
        expected: 'exhausted',
      },
      {
        name: 'negative uses remaining is exhausted',
        def: contractDefinition({
          uses_remaining: -1,
        }),
        expected: 'exhausted',
      },
      {
        name: 'positive uses and future expiry are active',
        def: contractDefinition({
          expiry_at: NOW_MS + 1,
          uses_remaining: 1,
        }),
        expected: 'active',
      },
      {
        name: 'expiry equal to now is still active',
        def: contractDefinition({
          expiry_at: NOW_MS,
        }),
        expected: 'active',
      },
    ];

    for (const testCase of cases) {
      expect(contractLifecycleState(testCase.def, NOW_MS), testCase.name)
        .toBe(testCase.expected);
    }
  });

  it('reports active only for the active lifecycle state', () => {
    expect(isContractActive(contractDefinition(), NOW_MS)).toBe(true);

    for (const inertDef of [
      contractDefinition({ revoked_at: NOW_MS - 1 }),
      contractDefinition({ expiry_at: NOW_MS - 1 }),
      contractDefinition({ uses_remaining: 0 }),
    ]) {
      expect(isContractActive(inertDef, NOW_MS)).toBe(false);
    }
  });
});

describe('D-166 contract_scope matcher', () => {
  it('treats absent and empty axes as wildcards', () => {
    expect(contractScopeMatches({}, scopeContext({
      channel: 'webhook',
      actor: 'system',
      ingredient_id: 'mail/send',
      operation_id: 'mail/send.deliver',
      connection_name: 'production',
    }))).toBe(true);

    expect(contractScopeMatches({
      channels: [],
      actors: [],
      ingredient_ids: [],
      operation_ids: [],
      connection_names: [],
    }, scopeContext())).toBe(true);
  });

  it('requires every non-empty axis to contain the context value', () => {
    expect(contractScopeMatches(fullContractScope(), scopeContext())).toBe(true);

    expect(contractScopeMatches({
      ...fullContractScope(),
      operation_ids: ['hubspot/deals.delete'],
    }, scopeContext())).toBe(false);
  });

  it('fails closed when a restricted per-call axis is absent from context', () => {
    expect(contractScopeMatches({
      ingredient_ids: ['hubspot/deals'],
    }, scopeContext({ ingredient_id: undefined }))).toBe(false);

    expect(contractScopeMatches({
      operation_ids: ['hubspot/deals.read'],
    }, scopeContext({ operation_id: undefined }))).toBe(false);

    expect(contractScopeMatches({
      connection_names: ['primary'],
    }, scopeContext({ connection_name: undefined }))).toBe(false);
  });

  it('always evaluates channel and actor axes', () => {
    expect(contractScopeMatches({
      channels: ['user'],
    }, scopeContext({ channel: 'chat' }))).toBe(false);

    expect(contractScopeMatches({
      actors: ['user_self'],
    }, scopeContext({ actor: 'contracted_user' }))).toBe(false);

    expect(contractScopeMatches({
      channels: ['chat'],
      actors: ['contracted_user'],
    }, scopeContext())).toBe(true);
  });
});

describe('D-166 contract_definition schema substrate', () => {
  it('pins the nested contract_scope value shape', () => {
    expect(D165_CONTRACT_SCHEMA.value_shapes.contract_scope).toEqual({
      fields: ['channels', 'actors', 'ingredient_ids', 'operation_ids', 'connection_names'],
      types: {
        channels: 'string[]',
        actors: 'string[]',
        ingredient_ids: 'string[]',
        operation_ids: 'string[]',
        connection_names: 'string[]',
      },
      required: [],
    });
  });

  it('pins the derived door execution policy shape', () => {
    // ⚠ WIDENED for `standing_closure` (D-207 follow-on — the owner's per-door
    // opt-in that lets a confirmed capability closure stand as the approval for
    // the ops it names). Recorded as a deliberate change rather than a silent
    // one: this ratchet exists so growing a STORED AUTHORITY shape is a visible
    // decision.
    //
    // ⛔ `required` is UNCHANGED, and that is what keeps every door minted
    // before the field existed valid — and reading as OFF, since absence is the
    // fail-closed default at the gate.
    expect(D165_CONTRACT_SCHEMA.value_shapes.door_execution_policy).toEqual({
      fields: ['max_steps', 'allow_ai', 'standing_closure'],
      types: { max_steps: 'number', allow_ai: 'bool', standing_closure: 'bool' },
      required: ['max_steps', 'allow_ai'],
    });
  });

  it('⛔ a door minted WITHOUT the opt-in still validates, and reads as off', () => {
    // The back-compat half the `required` list above is protecting.
    const shape = D165_CONTRACT_SCHEMA.value_shapes.door_execution_policy;
    expect(shape.required).not.toContain('standing_closure');
    expect(shape.fields).toContain('standing_closure');
  });

  it('pins the contract_definition value shape and contract_lifecycle composite key', () => {
    expect(D165_CONTRACT_SCHEMA.value_shapes.contract_definition).toEqual({
      fields: [
        'contract_id',
        'minted_at',
        'minted_by',
        'display_name',
        'scope',
        'door_execution_policy',
        // D-187 §6 (step 7) — the level-1 door-type axis.
        'door_types',
        // D-209 #1 — the derived door's authored stage-trust ceiling.
        'max_risk_without_approval',
        'approved_actions_template',
        'expiry_at',
        'max_uses',
        'uses_remaining',
        'use_period',
        'use_period_start',
        'revoked_at',
        'revocation_reason',
        // D-177 N.3 — session-grant extension (all optional at the shape
        // level; conditional requirements live in mintSessionGrant + the
        // N.4 matcher's fail-closed clauses).
        'grant_kind',
        'grant_mode',
        'channel_session_id',
        'bound_recipe',
        // D-177 N.14 — the door binding (asymmetric matcher clauses own the
        // conditional requirements).
        'bound_contract_id',
        'arg_shape_hash',
        'canonical_payload_hash',
        // D-177 P3 (codex HIGH fold) — the approved tier, pinned on session
        // rows; the matcher requires equality.
        'risk_tier',
        'batch_members',
        'pinned_projection_hash',
        'open_projection',
        'entity_scope',
        'approved_action_ref',
        // D-177 N.11 rule 5 (slice A) — 'scoped' rows' closed source enum.
        'scoped_source',
      ],
      types: {
        contract_id: 'string',
        minted_at: 'datetime',
        minted_by: 'string',
        display_name: 'string',
        scope: 'contract_scope',
        door_execution_policy: 'door_execution_policy?',
        // D-187 §6 + D-196 — the level-1 door-type axis (optional array-of-enum).
        // D-207 — `reception` joins it. See the derivation ratchet below: this literal is
        // the EXPECTATION, and the schema DERIVES its own from `DOOR_TYPES`.
        door_types: 'enum:mcp|mcp_chat|llm_gateway|reception|webhook[]?',
        // D-209 #1 — same vocabulary as override_policy's ceiling.
        max_risk_without_approval: 'enum:read|write|admin|none?',
        approved_actions_template: 'json?',
        expiry_at: 'datetime?',
        max_uses: 'number?',
        uses_remaining: 'number?',
        // Model — `max_uses` refills per `use_period`; `use_period_start` anchors
        // the window the counter belongs to. ⛔ BOTH OPTIONAL AND NEITHER IN
        // `required`, which is what keeps every contract minted before the
        // vocabulary valid — and reading as `'total'`, the one budget it has
        // always had.
        use_period: 'enum:total|day|month?',
        use_period_start: 'datetime?',
        revoked_at: 'datetime?',
        revocation_reason: 'string?',
        // D-177 N.13 (P6a) — 'delegation' joins the gate-grant vocabulary.
        grant_kind: 'enum:standing|session|delegation|customer_template|customer_instance|quality_delegation?',
        // D-177 N.11 rule 5 (slice A) — 'scoped' joins the mode vocabulary;
        // D-182 §8 — 'raw_op' (recipe-less raw-op door grant).
        grant_mode: 'enum:exact|batch|open|scoped|raw_op?',
        channel_session_id: 'string?',
        bound_recipe: 'bound_recipe_ref?',
        bound_contract_id: 'string?',
        arg_shape_hash: 'string?',
        canonical_payload_hash: 'string?',
        risk_tier: 'enum:read|write|admin|destructive?',
        batch_members: 'session_batch_member[]?',
        pinned_projection_hash: 'string?',
        open_projection: 'json?',
        entity_scope: 'string?',
        approved_action_ref: 'string?',
        scoped_source: 'enum:forwarded_item_sender?',
      },
      required: ['contract_id', 'minted_at', 'minted_by', 'display_name', 'scope'],
    });

    // D-177 N.3 — the nested session value shapes referenced above.
    expect(D165_CONTRACT_SCHEMA.value_shapes.bound_recipe_ref).toEqual({
      fields: ['recipe_id', 'recipe_hash'],
      types: { recipe_id: 'string', recipe_hash: 'string' },
      required: ['recipe_id', 'recipe_hash'],
    });
    expect(D165_CONTRACT_SCHEMA.value_shapes.session_batch_member).toEqual({
      fields: ['member_id', 'canonical_payload_hash', 'consumed_at'],
      types: {
        member_id: 'string',
        canonical_payload_hash: 'string',
        consumed_at: 'datetime?',
      },
      required: ['member_id', 'canonical_payload_hash'],
    });

    expect(D165_CONTRACT_SCHEMA.composite_keys.contract_definition).toEqual({
      segments: ['contract_id'],
      required: ['contract_id'],
      value_shape: 'contract_definition',
      applies_to: ['contract_lifecycle'],
      merge_rule: 'override',
      merge_precedence: 0,
      writeable_by: 'user+kernel',
    });
  });

  it('keeps contract_lifecycle in the inventory role vocabulary and the seed self-consistent', () => {
    expect(DISPATCH_ROLES).toContain('contract_lifecycle');
    expect(isInventoryRole('contract_lifecycle')).toBe(true);
    expect(validateContractSchemaRegistry(D165_CONTRACT_SCHEMA)).toEqual([]);
  });

  // ── D-207 — the ratchet that the pin above could NOT provide ────────────────────────
  //
  // The value-shape pin is a snapshot: it asserts the schema equals a literal someone typed
  // next to it. That makes it blind to the exact drift that broke D-207 — `DOOR_TYPES` grew
  // a `'reception'` member, the hand-written `enum:mcp|mcp_chat|llm_gateway[]?` did not, and
  // the pin stayed GREEN because it was checking the schema against ITSELF. Meanwhile
  // `ContractStore.put` validates every minted row against that value_shape, so every
  // reception door was rejected with `ContractWriteInvalidError` on a real server — while
  // every door test passed, because they all faked the definition store.
  //
  // So pin the INVARIANT, not the string: the schema's door-type vocabulary IS `DOOR_TYPES`.
  // Add a fifth door type and forget the schema, or "simplify" the derivation back to a
  // literal, and this goes red.
  it('the door_types value_shape IS the DOOR_TYPES vocabulary — they cannot drift apart', () => {
    const shape = D165_CONTRACT_SCHEMA.value_shapes.contract_definition.types.door_types;
    expect(shape).toBe(`enum:${DOOR_TYPES.join('|')}[]?`);

    // And prove it is not vacuous: every member is actually present in the shape string,
    // and a non-member is not. (A literal that happened to match today would still pass the
    // line above; these two lines say what the shape MEANS.)
    for (const t of DOOR_TYPES) expect(shape).toContain(t);
    // D-209 #1 made `webhook` a member; `housekeeping` is the canonical
    // never-a-door channel (system actor — D-171 decision 8).
    expect(shape).not.toContain('housekeeping');
  });
});

describe('D-166 registry validator nested value_shape references', () => {
  it('reports value_shape_type_unknown for undeclared nested value_shape descriptors', () => {
    const issues = validateContractSchemaRegistry(
      registryWithNestedFieldType('nonexistent_shape'),
    );

    expect(issues).toEqual([
      expect.objectContaining({
        code: 'value_shape_type_unknown',
        entry: 'value_shapes.outer',
      }),
    ]);
  });

  it('accepts nested descriptors that reference a declared sibling value_shape', () => {
    const issues = validateContractSchemaRegistry(
      registryWithNestedFieldType('sibling', {
        fields: ['name'],
        types: {
          name: 'string',
        },
        required: ['name'],
      }),
    );

    expect(issues).toEqual([]);
    expect(issues.some(issue => issue.code === 'value_shape_type_unknown')).toBe(false);
  });
});

describe('D-166 validateContractWrite for nested contract_scope', () => {
  it('accepts a fully populated contract_definition with nested string-array scope axes', () => {
    expect(contractDefinitionWriteIssues(contractDefinitionValue())).toEqual([]);
  });

  it('reports type_mismatch on scope when a nested axis contains a non-string element', () => {
    expect(contractDefinitionWriteIssues(contractDefinitionValue({
      scope: {
        ...fullContractScope(),
        channels: [123],
      },
    }))).toContainEqual(expect.objectContaining({
      code: 'type_mismatch',
      entry: 'contract_definition.scope',
    }));
  });

  it('reports type_mismatch on scope when the nested scope has an unknown field', () => {
    expect(contractDefinitionWriteIssues(contractDefinitionValue({
      scope: {
        ...fullContractScope(),
        bogus: [],
      },
    }))).toContainEqual(expect.objectContaining({
      code: 'type_mismatch',
      entry: 'contract_definition.scope',
    }));
  });

  it('reports type_mismatch on scope when the nested scope is not an object', () => {
    expect(contractDefinitionWriteIssues(contractDefinitionValue({
      scope: 'not-a-scope',
    }))).toContainEqual(expect.objectContaining({
      code: 'type_mismatch',
      entry: 'contract_definition.scope',
    }));
  });

  it('requires the top-level scope field', () => {
    const value = contractDefinitionValue();
    delete value.scope;

    expect(contractDefinitionWriteIssues(value)).toContainEqual(expect.objectContaining({
      code: 'missing_required_field',
      entry: 'contract_definition.scope',
    }));
  });

  it('accepts an empty scope object because contract_scope has no required axes', () => {
    expect(contractDefinitionWriteIssues(contractDefinitionValue({
      scope: {},
    }))).toEqual([]);
  });

  it('accepts a complete derived door execution policy', () => {
    expect(contractDefinitionWriteIssues(contractDefinitionValue({
      door_execution_policy: { max_steps: 64, allow_ai: false },
    }))).toEqual([]);
  });

  it('rejects an incomplete or mistyped door execution policy', () => {
    expect(contractDefinitionWriteIssues(contractDefinitionValue({
      door_execution_policy: { max_steps: 64 },
    }))).toContainEqual(expect.objectContaining({
      code: 'type_mismatch',
      entry: 'contract_definition.door_execution_policy',
    }));
    expect(contractDefinitionWriteIssues(contractDefinitionValue({
      door_execution_policy: { max_steps: 64, allow_ai: 'yes' },
    }))).toContainEqual(expect.objectContaining({
      code: 'type_mismatch',
      entry: 'contract_definition.door_execution_policy',
    }));
  });
});

describe('D-166 validateContractWrite cycle guard', () => {
  it('fails closed on a self-referential value_shape without hanging', () => {
    const cyclicRegistry: ContractSchemaRegistry = {
      composite_keys: {
        cyclic_scope: {
          segments: ['id'],
          required: ['id'],
          value_shape: 'cyclic',
          applies_to: ['grant_resolution'],
          merge_precedence: 0,
          merge_rule: 'override',
          writeable_by: 'user',
        },
      },
      value_shapes: {
        cyclic: {
          fields: ['self'],
          types: {
            self: 'cyclic',
          },
          required: ['self'],
        },
      },
    };

    expect(validateContractSchemaRegistry(cyclicRegistry)).toEqual([]);
    expect(
      validateContractWrite(cyclicRegistry, 'cyclic_scope', ['row-1'], { self: {} }),
    ).toContainEqual(expect.objectContaining({
      code: 'type_mismatch',
      entry: 'cyclic_scope.self',
    }));
  });
});
