/** D-177 P6c staged-trust accept-mint store and RPC tests. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONTRACT_DEFINITION_SCOPE,
  D165_CONTRACT_SCHEMA,
  DELEGATION_RULE_MAX_USES,
  DELEGATION_RULE_SUGGESTION_SCOPE,
  DELEGATION_RULE_TTL_MS,
  RpcError,
  delegationRuleMintPlanFromSnapshot,
  delegationRuleSuggestionKeyHash,
  type ContractDefinition,
  type ContractDefinitionView,
  type ContractScope,
  type DelegationRuleSuggestionEvidence,
  type DelegationRuleSuggestionRow,
  type DelegationRuleSuggestionSnapshot,
  type IngredientManifest,
  type OpenProjection,
} from '@recued/contracts';
import type { ActivityEntry, AuditLogStore } from '@recued/storage';

import {
  makeContractHandlers,
  type ContractBroadcastEvent,
} from '../contract-handler.js';
import {
  DelegationRuleMintError,
  createContractDefinitionStore,
  type ContractDefinitionStore,
  type MintDelegationRuleInput,
  type MintSessionGrantInput,
} from '../storage/contract-definition-store.js';
import {
  createContractStore,
  type ContractStore,
} from '../storage/contract-store.js';
import {
  createDelegationSuggestionStore,
  type DelegationSuggestionStore,
} from '../storage/delegation-suggestion-store.js';
import type { WsClient } from '../ws-server.js';

const NOW = 1_800_300_000_000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

type ContractHandlers = NonNullable<ReturnType<typeof makeContractHandlers>>['handlers'];

let db: Database.Database;
let store: ContractStore;
let defStore: ContractDefinitionStore;
let suggestionStore: DelegationSuggestionStore;
let idSeq: number;
let now: number;

const CLIENT = { display_name: 'Bob MacBook' } as WsClient;

const getManifest = (_slug: string): IngredientManifest | null => null;
const listManifests = (): IngredientManifest[] => [];

const makeSeqId = (): string => {
  idSeq += 1;
  return `ct_${String(idSeq).padStart(3, '0')}`;
};

const fullScope = (
  overrides: Partial<ContractScope> = {},
): ContractScope => ({
  channels: ['chat'],
  actors: ['user_self'],
  ingredient_ids: ['mail.send'],
  operation_ids: ['mail.send'],
  connection_names: ['gmail-primary'],
  ...overrides,
});

const openProjection = (): OpenProjection => ({
  version: 1,
  args: [
    {
      path: 'to',
      skeleton: '{{config.to}}',
      roots: [
        {
          ref: 'config.to',
          origin: 'config',
          pinned: 'approved@example.test',
        },
      ],
      derived_pinned: 'approved@example.test',
    },
  ],
});

const baseSnapshot = (
  overrides: Partial<DelegationRuleSuggestionSnapshot> = {},
): DelegationRuleSuggestionSnapshot => ({
  channel: 'chat',
  actor: 'user_self',
  ingredient_id: 'mail.send',
  operation_id: 'mail.send',
  connection_name: 'gmail-primary',
  recipe_id: 'recipe-1',
  recipe_hash: 'recipe-hash-1',
  arg_shape_hash: 'arg-shape-hash',
  risk_tier: 'write',
  entity_scope: 'deal-1',
  grant_mode: 'exact',
  canonical_payload_hash: 'payload-hash',
  ...overrides,
});

const baseEvidence = (
  overrides: Partial<DelegationRuleSuggestionEvidence> = {},
): DelegationRuleSuggestionEvidence => ({
  row_count: 3,
  distinct_session_count: 3,
  consumed_uses: 3,
  sample_contract_ids: ['ct_003', 'ct_002', 'ct_001'],
  first_minted_at: NOW - 3_000,
  last_minted_at: NOW - 1_000,
  ...overrides,
});

const suggestionRow = (
  overrides: Partial<DelegationRuleSuggestionRow> = {},
): DelegationRuleSuggestionRow => {
  const snapshot = overrides.snapshot ?? baseSnapshot();
  const key_hash = overrides.key_hash ?? delegationRuleSuggestionKeyHash(snapshot);
  return {
    key_hash,
    state: 'open',
    snapshot,
    evidence: baseEvidence(),
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
};

const mintDelegationInput = (
  overrides: Partial<MintDelegationRuleInput> = {},
): MintDelegationRuleInput => ({
  minted_by: 'owner',
  display_name: 'Delegation rule',
  scope: fullScope(),
  grant_mode: 'exact',
  bound_recipe: {
    recipe_id: 'recipe-1',
    recipe_hash: 'recipe-hash-1',
  },
  arg_shape_hash: 'arg-shape-hash',
  risk_tier: 'write',
  canonical_payload_hash: 'payload-hash',
  entity_scope: 'deal-1',
  approved_action_ref: 'suggestion-key',
  expiry_at: NOW + DELEGATION_RULE_TTL_MS,
  max_uses: DELEGATION_RULE_MAX_USES,
  ...overrides,
});

const mintSessionInput = (
  overrides: Partial<MintSessionGrantInput> = {},
): MintSessionGrantInput => ({
  minted_by: 'user:1',
  display_name: 'Session grant',
  scope: fullScope(),
  channel_session_id: 's-1',
  grant_mode: 'exact',
  bound_recipe: {
    recipe_id: 'recipe-1',
    recipe_hash: 'recipe-hash-1',
  },
  arg_shape_hash: 'arg-shape-hash',
  risk_tier: 'write',
  canonical_payload_hash: 'payload-hash',
  entity_scope: 'deal-1',
  approved_action_ref: 'checkpoint-1',
  expiry_at: NOW + 60_000,
  max_uses: 3,
  ...overrides,
});

const putSuggestion = (row: DelegationRuleSuggestionRow): void => {
  store.put(DELEGATION_RULE_SUGGESTION_SCOPE, [row.key_hash], row);
};

const putDefinition = (def: ContractDefinition): void => {
  store.put(CONTRACT_DEFINITION_SCOPE, [def.contract_id], def);
};

const rawDefinition = (contract_id: string): ContractDefinition => {
  const row = store.get(CONTRACT_DEFINITION_SCOPE, [contract_id]);
  expect(row).not.toBeNull();
  return row!.value as ContractDefinition;
};

const overwriteUnchecked = (
  scope: string,
  seg_key: string,
  value: unknown,
): void => {
  db.prepare(
    'UPDATE contract_store SET value_inline = ?, written_at = ? WHERE scope = ? AND seg_key = ?',
  ).run(JSON.stringify(value), now, scope, seg_key);
};

const overwriteSuggestionUnchecked = (
  row: unknown,
  key_hash: string,
): void => {
  overwriteUnchecked(DELEGATION_RULE_SUGGESTION_SCOPE, key_hash, row);
};

const overwriteDefinitionUnchecked = (
  row: unknown,
  contract_id: string,
): void => {
  overwriteUnchecked(CONTRACT_DEFINITION_SCOPE, contract_id, row);
};

const seedSuggestion = (
  overrides: Partial<DelegationRuleSuggestionRow> = {},
): DelegationRuleSuggestionRow => {
  const row = suggestionRow(overrides);
  putSuggestion(row);
  return row;
};

const mintRuleFromSnapshot = (
  snapshot: DelegationRuleSuggestionSnapshot,
  key_hash = delegationRuleSuggestionKeyHash(snapshot),
  overrides: Partial<MintDelegationRuleInput> = {},
): ContractDefinition => {
  const plan = delegationRuleMintPlanFromSnapshot(snapshot);
  expect(plan).not.toBeUndefined();
  if (plan === undefined) throw new Error('expected snapshot to mint');
  return defStore.mintDelegationRule({
    minted_by: 'owner',
    display_name: `Delegation rule - ${snapshot.operation_id ?? snapshot.ingredient_id}`,
    scope: plan.scope,
    grant_mode: plan.grant_mode,
    bound_recipe: { recipe_id: plan.recipe_id, recipe_hash: plan.recipe_hash },
    arg_shape_hash: plan.arg_shape_hash,
    risk_tier: plan.risk_tier,
    ...(plan.canonical_payload_hash !== undefined
      ? { canonical_payload_hash: plan.canonical_payload_hash }
      : {}),
    ...(plan.pinned_projection_hash !== undefined
      ? { pinned_projection_hash: plan.pinned_projection_hash }
      : {}),
    ...(plan.open_projection !== undefined
      ? { open_projection: plan.open_projection }
      : {}),
    ...(plan.entity_scope !== undefined ? { entity_scope: plan.entity_scope } : {}),
    approved_action_ref: key_hash,
    expiry_at: now + DELEGATION_RULE_TTL_MS,
    max_uses: DELEGATION_RULE_MAX_USES,
    ...overrides,
  });
};

const makeHandlerHarness = (): {
  handlers: ContractHandlers;
  events: ContractBroadcastEvent[];
  auditRows: ActivityEntry[];
} => {
  const events: ContractBroadcastEvent[] = [];
  const auditRows: ActivityEntry[] = [];
  const auditLog = {
    async logActivity(entry: ActivityEntry) {
      auditRows.push(entry);
    },
  } as unknown as AuditLogStore;
  const slice = makeContractHandlers({
    store,
    getManifest,
    listManifests,
    now: () => now,
    newContractId: makeSeqId,
    broadcast: (event) => {
      events.push(event);
    },
    auditLog,
  });
  if (!slice) throw new Error('contract handler slice was not created');
  return { handlers: slice.handlers, events, auditRows };
};

const acceptSuggestion = (
  handlers: ContractHandlers,
  args: unknown,
): Promise<{ rule: ContractDefinitionView; suggestion: DelegationRuleSuggestionRow }> =>
  handlers['collection.contract.acceptDelegationSuggestion'](
    args as Parameters<
      ContractHandlers['collection.contract.acceptDelegationSuggestion']
    >[0],
    CLIENT,
  );

const dismissSuggestion = (
  handlers: ContractHandlers,
  args: unknown,
): Promise<{ suggestion: DelegationRuleSuggestionRow }> =>
  handlers['collection.contract.dismissDelegationSuggestion'](
    args as Parameters<
      ContractHandlers['collection.contract.dismissDelegationSuggestion']
    >[0],
    CLIENT,
  );

const listDelegationSuggestions = (
  handlers: ContractHandlers,
): Promise<{ suggestions: DelegationRuleSuggestionRow[] }> =>
  handlers['collection.contract.listDelegationSuggestions'](
    undefined as Parameters<
      ContractHandlers['collection.contract.listDelegationSuggestions']
    >[0],
    CLIENT,
  );

const listContracts = (
  handlers: ContractHandlers,
  args?: unknown,
): Promise<{ contracts: ContractDefinitionView[] }> =>
  handlers['collection.contract.listContracts'](
    args as Parameters<ContractHandlers['collection.contract.listContracts']>[0],
    CLIENT,
  );

const captureRejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
    return undefined;
  } catch (err) {
    return err;
  }
};

const expectRpcCode = async (
  promise: Promise<unknown>,
  code: string,
): Promise<RpcError> => {
  const caught = await captureRejection(promise);
  expect(caught).toBeInstanceOf(RpcError);
  expect((caught as RpcError).code).toBe(code);
  return caught as RpcError;
};

beforeEach(() => {
  db = new Database(':memory:');
  now = NOW;
  idSeq = 0;
  store = createContractStore(db, { now: () => now });
  store.seedSchema(D165_CONTRACT_SCHEMA);
  defStore = createContractDefinitionStore(store, { now: () => now, newId: makeSeqId });
  suggestionStore = createDelegationSuggestionStore(store, { now: () => now });
});

afterEach(() => {
  db.close();
});

describe('D-177 P6c mintDelegationRule', () => {
  it('mints exact and open delegation rules with explicit bounded grant fields', () => {
    const exact = defStore.mintDelegationRule(mintDelegationInput());

    expect(exact).toEqual(expect.objectContaining({
      contract_id: 'ct_001',
      minted_at: NOW,
      grant_kind: 'delegation',
      grant_mode: 'exact',
      canonical_payload_hash: 'payload-hash',
      approved_action_ref: 'suggestion-key',
      max_uses: DELEGATION_RULE_MAX_USES,
      uses_remaining: DELEGATION_RULE_MAX_USES,
    }));
    expect(exact).not.toHaveProperty('channel_session_id');

    const projection = openProjection();
    const open = defStore.mintDelegationRule(mintDelegationInput({
      grant_mode: 'open',
      canonical_payload_hash: undefined,
      pinned_projection_hash: 'projection-hash',
      open_projection: projection,
      approved_action_ref: 'suggestion-key-open',
    }));

    expect(open).toEqual(expect.objectContaining({
      contract_id: 'ct_002',
      grant_kind: 'delegation',
      grant_mode: 'open',
      pinned_projection_hash: 'projection-hash',
      open_projection: projection,
      uses_remaining: DELEGATION_RULE_MAX_USES,
    }));
    expect(open).not.toHaveProperty('canonical_payload_hash');
    expect(open).not.toHaveProperty('channel_session_id');
  });

  it('throws DelegationRuleMintError for unmintable delegation-rule inputs', () => {
    const malformedOpenProjection = { version: 1, args: [] };
    const cases: ReadonlyArray<{ name: string; input: MintDelegationRuleInput }> = [
      { name: 'admin tier', input: mintDelegationInput({ risk_tier: 'admin' }) },
      {
        name: 'empty ingredient axis',
        input: mintDelegationInput({ scope: fullScope({ ingredient_ids: [] }) }),
      },
      {
        // STAGED-TRUST OWNER-ONLY (storage chokepoint): a contracted_user-scoped rule
        // would match every door — refuse at the mint primitive, last line of defense.
        name: 'contracted_user (door) actor',
        input: mintDelegationInput({ scope: fullScope({ actors: ['contracted_user'] }) }),
      },
      {
        name: 'empty approved_action_ref',
        input: mintDelegationInput({ approved_action_ref: '' }),
      },
      { name: 'expiry in past', input: mintDelegationInput({ expiry_at: NOW - 1 }) },
      {
        name: 'expiry over TTL ceiling',
        input: mintDelegationInput({ expiry_at: NOW + DELEGATION_RULE_TTL_MS + 1 }),
      },
      { name: 'max_uses zero', input: mintDelegationInput({ max_uses: 0 }) },
      { name: 'max_uses negative', input: mintDelegationInput({ max_uses: -1 }) },
      { name: 'max_uses fractional', input: mintDelegationInput({ max_uses: 1.5 }) },
      {
        name: 'max_uses over ceiling',
        input: mintDelegationInput({ max_uses: DELEGATION_RULE_MAX_USES + 1 }),
      },
      {
        name: 'batch mode',
        input: mintDelegationInput({
          grant_mode: 'batch' as unknown as MintDelegationRuleInput['grant_mode'],
        }),
      },
      {
        name: 'unknown mode',
        input: mintDelegationInput({
          grant_mode: 'future' as unknown as MintDelegationRuleInput['grant_mode'],
        }),
      },
      {
        name: 'exact without payload hash',
        input: mintDelegationInput({ canonical_payload_hash: undefined }),
      },
      {
        name: 'open without projection hash',
        input: mintDelegationInput({
          grant_mode: 'open',
          canonical_payload_hash: undefined,
          open_projection: openProjection(),
        }),
      },
      {
        name: 'open with malformed projection',
        input: mintDelegationInput({
          grant_mode: 'open',
          canonical_payload_hash: undefined,
          pinned_projection_hash: 'projection-hash',
          open_projection: malformedOpenProjection,
        }),
      },
    ];

    for (const testCase of cases) {
      expect(
        () => defStore.mintDelegationRule(testCase.input),
        testCase.name,
      ).toThrow(DelegationRuleMintError);
    }
  });
});

describe('D-177 P6c delegation suggestion setState', () => {
  it('transitions only open rows and refuses cross-resolution or unknown states', () => {
    const accept = seedSuggestion({ key_hash: 'accept-key' });
    now = NOW + 10;
    expect(suggestionStore.setState(accept.key_hash, 'accepted')).toEqual({
      outcome: 'changed',
      row: expect.objectContaining({ state: 'accepted', updated_at: NOW + 10 }),
    });

    now = NOW + 20;
    expect(suggestionStore.setState(accept.key_hash, 'accepted')).toEqual({
      outcome: 'unchanged',
      row: expect.objectContaining({ state: 'accepted', updated_at: NOW + 10 }),
    });

    const dismiss = seedSuggestion({ key_hash: 'dismiss-key' });
    now = NOW + 30;
    expect(suggestionStore.setState(dismiss.key_hash, 'dismissed')).toEqual({
      outcome: 'changed',
      row: expect.objectContaining({ state: 'dismissed', updated_at: NOW + 30 }),
    });

    expect(suggestionStore.setState(dismiss.key_hash, 'accepted')).toEqual({
      outcome: 'refused',
      row: expect.objectContaining({ state: 'dismissed' }),
    });
    expect(suggestionStore.setState(accept.key_hash, 'dismissed')).toEqual({
      outcome: 'refused',
      row: expect.objectContaining({ state: 'accepted' }),
    });
    expect(suggestionStore.setState('missing-key', 'accepted')).toEqual({
      outcome: 'absent',
      row: null,
    });

    const weird = seedSuggestion({ key_hash: 'weird-key' });
    overwriteSuggestionUnchecked({ ...weird, state: 'weird' }, weird.key_hash);
    expect(suggestionStore.setState(weird.key_hash, 'accepted')).toEqual({
      outcome: 'refused',
      row: expect.objectContaining({ state: 'weird' }),
    });
  });
});

describe('D-177 P6c acceptDelegationSuggestion RPC', () => {
  it('mints from an open suggestion, flips it accepted, broadcasts, and audits', async () => {
    const snapshot = baseSnapshot();
    const key_hash = delegationRuleSuggestionKeyHash(snapshot);
    seedSuggestion({ key_hash, snapshot });
    const { handlers, events, auditRows } = makeHandlerHarness();

    const result = await acceptSuggestion(handlers, { key_hash });

    expect(result.rule).toEqual(expect.objectContaining({
      lifecycle_state: 'active',
      grant_kind: 'delegation',
      grant_mode: 'exact',
      approved_action_ref: key_hash,
      expiry_at: NOW + DELEGATION_RULE_TTL_MS,
      max_uses: DELEGATION_RULE_MAX_USES,
      uses_remaining: DELEGATION_RULE_MAX_USES,
    }));
    expect(result.rule).not.toHaveProperty('channel_session_id');
    expect(result.suggestion).toEqual(expect.objectContaining({
      key_hash,
      state: 'accepted',
    }));
    expect(suggestionStore.get(key_hash)).toEqual(expect.objectContaining({
      state: 'accepted',
    }));
    expect(events).toEqual([
      {
        kind: 'contract.contract_definition_changed',
        op: 'mint',
        contract_id: result.rule.contract_id,
      },
      {
        kind: 'contract.delegation_rule_suggestion_resolved',
        key_hash,
        resolution: 'accepted',
      },
    ]);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toEqual(expect.objectContaining({
      timestamp: NOW,
      action: 'delegation_rule_minted',
      target: result.rule.contract_id,
    }));
    const detail = JSON.parse(auditRows[0]!.detail ?? '{}') as Record<string, unknown>;
    expect(detail).toEqual(expect.objectContaining({
      actor: 'user_self',
      suggestion_key_hash: key_hash,
    }));
  });

  it('honors tightened ttl and max-use bounds', async () => {
    const snapshot = baseSnapshot();
    const key_hash = delegationRuleSuggestionKeyHash(snapshot);
    seedSuggestion({ key_hash, snapshot });
    const { handlers } = makeHandlerHarness();

    const result = await acceptSuggestion(handlers, {
      key_hash,
      ttl_ms: ONE_DAY_MS,
      max_uses: 5,
    });

    expect(result.rule).toEqual(expect.objectContaining({
      expiry_at: NOW + ONE_DAY_MS,
      max_uses: 5,
      uses_remaining: 5,
    }));
  });

  it('rejects widened or invalid tightened bounds without minting or resolving', async () => {
    const snapshot = baseSnapshot();
    const key_hash = delegationRuleSuggestionKeyHash(snapshot);
    seedSuggestion({ key_hash, snapshot });
    const { handlers, events } = makeHandlerHarness();
    const invalidArgs: unknown[] = [
      { key_hash, ttl_ms: DELEGATION_RULE_TTL_MS + 1 },
      { key_hash, max_uses: DELEGATION_RULE_MAX_USES + 1 },
      { key_hash, max_uses: 0 },
      { key_hash, max_uses: -1 },
      { key_hash, max_uses: 1.5 },
    ];

    for (const args of invalidArgs) {
      await expectRpcCode(acceptSuggestion(handlers, args), 'bad_request');
      expect(defStore.listDelegationRules()).toEqual([]);
      expect(suggestionStore.get(key_hash)).toEqual(expect.objectContaining({
        state: 'open',
      }));
    }
    expect(events).toEqual([]);
  });

  it('is idempotent after a successful accept', async () => {
    const snapshot = baseSnapshot();
    const key_hash = delegationRuleSuggestionKeyHash(snapshot);
    seedSuggestion({ key_hash, snapshot });
    const { handlers, events, auditRows } = makeHandlerHarness();

    const first = await acceptSuggestion(handlers, { key_hash });
    const second = await acceptSuggestion(handlers, { key_hash });

    expect(second.rule.contract_id).toBe(first.rule.contract_id);
    expect(defStore.listDelegationRules().map((rule) => rule.contract_id)).toEqual([
      first.rule.contract_id,
    ]);
    expect(events).toEqual([
      {
        kind: 'contract.contract_definition_changed',
        op: 'mint',
        contract_id: first.rule.contract_id,
      },
      {
        kind: 'contract.delegation_rule_suggestion_resolved',
        key_hash,
        resolution: 'accepted',
      },
    ]);
    expect(auditRows).toHaveLength(1);
  });

  it('recovers a minted rule whose suggestion was still open', async () => {
    const snapshot = baseSnapshot();
    const key_hash = delegationRuleSuggestionKeyHash(snapshot);
    seedSuggestion({ key_hash, snapshot });
    const rule = mintRuleFromSnapshot(snapshot, key_hash);
    const { handlers, events } = makeHandlerHarness();

    const result = await acceptSuggestion(handlers, { key_hash });

    expect(result.rule.contract_id).toBe(rule.contract_id);
    expect(result.suggestion).toEqual(expect.objectContaining({ state: 'accepted' }));
    expect(suggestionStore.get(key_hash)).toEqual(expect.objectContaining({
      state: 'accepted',
    }));
    expect(events).toEqual([
      {
        kind: 'contract.delegation_rule_suggestion_resolved',
        key_hash,
        resolution: 'accepted',
      },
    ]);
  });

  it('rejects a suggestion whose stored key hash does not match its snapshot', async () => {
    const snapshot = baseSnapshot();
    const key_hash = 'wrong-key-hash';
    seedSuggestion({ key_hash, snapshot });
    const { handlers, events } = makeHandlerHarness();

    await expectRpcCode(acceptSuggestion(handlers, { key_hash }), 'bad_request');

    expect(defStore.listDelegationRules()).toEqual([]);
    expect(suggestionStore.get(key_hash)).toEqual(expect.objectContaining({
      state: 'open',
    }));
    expect(events).toEqual([]);
  });

  it('rejects dismissed, absent, and tier-escalated suggestions', async () => {
    const dismissedSnapshot = baseSnapshot();
    const dismissedKey = delegationRuleSuggestionKeyHash(dismissedSnapshot);
    seedSuggestion({ key_hash: dismissedKey, snapshot: dismissedSnapshot, state: 'dismissed' });
    const adminSnapshot = baseSnapshot({ risk_tier: 'admin' });
    const adminKey = delegationRuleSuggestionKeyHash(adminSnapshot);
    seedSuggestion({ key_hash: adminKey, snapshot: adminSnapshot });
    const { handlers } = makeHandlerHarness();

    await expectRpcCode(acceptSuggestion(handlers, { key_hash: dismissedKey }), 'bad_request');
    await expectRpcCode(acceptSuggestion(handlers, { key_hash: 'absent-key' }), 'not_found');
    await expectRpcCode(acceptSuggestion(handlers, { key_hash: adminKey }), 'bad_request');

    expect(defStore.listDelegationRules()).toEqual([]);
    expect(suggestionStore.get(adminKey)).toEqual(expect.objectContaining({
      state: 'open',
    }));
  });
});

describe('D-177 P6c dismissDelegationSuggestion RPC', () => {
  it('dismisses open suggestions idempotently with one resolved broadcast', async () => {
    const snapshot = baseSnapshot();
    const key_hash = delegationRuleSuggestionKeyHash(snapshot);
    seedSuggestion({ key_hash, snapshot });
    const { handlers, events } = makeHandlerHarness();

    const first = await dismissSuggestion(handlers, { key_hash });
    const second = await dismissSuggestion(handlers, { key_hash });

    expect(first.suggestion).toEqual(expect.objectContaining({ state: 'dismissed' }));
    expect(second.suggestion).toEqual(expect.objectContaining({ state: 'dismissed' }));
    expect(events).toEqual([
      {
        kind: 'contract.delegation_rule_suggestion_resolved',
        key_hash,
        resolution: 'dismissed',
      },
    ]);
  });

  it('rejects accepted or absent suggestions', async () => {
    const snapshot = baseSnapshot();
    const key_hash = delegationRuleSuggestionKeyHash(snapshot);
    seedSuggestion({ key_hash, snapshot, state: 'accepted' });
    const { handlers } = makeHandlerHarness();

    await expectRpcCode(dismissSuggestion(handlers, { key_hash }), 'bad_request');
    await expectRpcCode(dismissSuggestion(handlers, { key_hash: 'absent-key' }), 'not_found');
  });

  it('heals an open suggestion with an already-minted anchored rule', async () => {
    const snapshot = baseSnapshot();
    const key_hash = delegationRuleSuggestionKeyHash(snapshot);
    seedSuggestion({ key_hash, snapshot });
    const rule = mintRuleFromSnapshot(snapshot, key_hash);
    const { handlers, events } = makeHandlerHarness();

    const err = await expectRpcCode(dismissSuggestion(handlers, { key_hash }), 'bad_request');

    expect(err.message).toContain(rule.contract_id);
    expect(suggestionStore.get(key_hash)).toEqual(expect.objectContaining({
      state: 'accepted',
    }));
    expect(events).toEqual([
      {
        kind: 'contract.delegation_rule_suggestion_resolved',
        key_hash,
        resolution: 'accepted',
      },
    ]);
  });
});

describe('D-177 P6c delegation suggestion and contract listings', () => {
  it('lists delegation suggestions in every state', async () => {
    const rows = [
      seedSuggestion({
        key_hash: 'open-key',
        state: 'open',
        updated_at: NOW + 30,
      }),
      seedSuggestion({
        key_hash: 'accepted-key',
        state: 'accepted',
        updated_at: NOW + 20,
      }),
      seedSuggestion({
        key_hash: 'dismissed-key',
        state: 'dismissed',
        updated_at: NOW + 10,
      }),
    ];
    const { handlers } = makeHandlerHarness();

    const result = await listDelegationSuggestions(handlers);

    expect(result.suggestions).toEqual(rows);
    expect(result.suggestions.map((row) => row.state)).toEqual([
      'open',
      'accepted',
      'dismissed',
    ]);
  });

  it('discriminates listContracts by grant_kind and leaves future kinds unfiled', async () => {
    const { handlers } = makeHandlerHarness();
    const standing = defStore.mint({
      minted_by: 'owner',
      display_name: 'Standing contract',
      scope: fullScope({ ingredient_ids: ['standing.tool'] }),
    });
    const session = defStore.mintSessionGrant(mintSessionInput());
    const delegation = defStore.mintDelegationRule(mintDelegationInput({
      approved_action_ref: 'suggestion-key-delegation',
    }));

    await expect(listContracts(handlers)).resolves.toEqual({
      contracts: expect.arrayContaining([
        expect.objectContaining({ contract_id: standing.contract_id }),
        expect.objectContaining({ contract_id: session.contract_id }),
        expect.objectContaining({ contract_id: delegation.contract_id }),
      ]),
    });
    expect((await listContracts(handlers)).contracts).toHaveLength(3);
    expect((await listContracts(handlers, { grant_kind: 'standing' })).contracts)
      .toHaveLength(1);
    expect((await listContracts(handlers, { grant_kind: 'session' })).contracts)
      .toHaveLength(1);
    expect((await listContracts(handlers, { grant_kind: 'delegation' })).contracts)
      .toHaveLength(1);
    await expectRpcCode(
      listContracts(handlers, { grant_kind: 'bogus' }),
      'bad_request',
    );

    const future = defStore.mint({
      minted_by: 'owner',
      display_name: 'Future kind contract',
      scope: fullScope({ ingredient_ids: ['future.tool'] }),
    });
    const customerTemplate = defStore.mint({
      minted_by: 'owner',
      display_name: 'Customer template',
      scope: fullScope({ ingredient_ids: ['customer.template'] }),
    });
    const customerInstance = defStore.mint({
      minted_by: 'owner',
      display_name: 'Customer instance',
      scope: fullScope({ ingredient_ids: ['customer.instance'] }),
    });
    overwriteDefinitionUnchecked(
      {
        ...rawDefinition(future.contract_id),
        grant_kind: 'future_kind',
      } as unknown as ContractDefinition,
      future.contract_id,
    );
    overwriteDefinitionUnchecked(
      {
        ...rawDefinition(customerTemplate.contract_id),
        grant_kind: 'customer_template',
      },
      customerTemplate.contract_id,
    );
    overwriteDefinitionUnchecked(
      {
        ...rawDefinition(customerInstance.contract_id),
        grant_kind: 'customer_instance',
      },
      customerInstance.contract_id,
    );

    expect((await listContracts(handlers)).contracts.map((row) => row.contract_id))
      .toContain(future.contract_id);
    expect((await listContracts(handlers, { grant_kind: 'customer_template' })).contracts)
      .toEqual([expect.objectContaining({ contract_id: customerTemplate.contract_id })]);
    expect((await listContracts(handlers, { grant_kind: 'customer_instance' })).contracts)
      .toEqual([expect.objectContaining({ contract_id: customerInstance.contract_id })]);
    for (const grant_kind of ['standing', 'session', 'delegation'] as const) {
      expect((await listContracts(handlers, { grant_kind })).contracts.map(
        (row) => row.contract_id,
      )).not.toContain(future.contract_id);
      expect((await listContracts(handlers, { grant_kind })).contracts.map(
        (row) => row.contract_id,
      )).not.toContain(customerTemplate.contract_id);
      expect((await listContracts(handlers, { grant_kind })).contracts.map(
        (row) => row.contract_id,
      )).not.toContain(customerInstance.contract_id);
    }
  });
});
