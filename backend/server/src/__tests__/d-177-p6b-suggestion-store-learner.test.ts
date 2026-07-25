/** D-177 P6b delegation-rule suggestion store and learner tests. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONTRACT_DEFINITION_SCOPE,
  D165_CONTRACT_SCHEMA,
  DELEGATION_RULE_SUGGESTION_SCAN_TASK_ID,
  DELEGATION_RULE_SUGGESTION_SCOPE,
  delegationRuleSuggestionKeyHash,
  deriveDelegationRuleSuggestionKey,
  type ContractDefinition,
  type ContractScope,
  type DelegationRuleSuggestionEvidence,
  type DelegationRuleSuggestionRow,
  type DelegationRuleSuggestionSnapshot,
  type HousekeepingCursor,
  type OpenProjection,
  type ServerEvent,
} from '@recued/contracts';

import { buildDelegationRuleSuggestionScanTask } from '../housekeeping/tasks/delegation-rule-suggestion-scan.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';
import type { EventBus, ServerEventInput } from '../events/bus.js';
import {
  createContractDefinitionStore,
  type ContractDefinitionStore,
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

const NOW = 1_800_100_000_000;

let db: Database.Database;
let store: ContractStore;
let defStore: ContractDefinitionStore;
let suggestionStore: DelegationSuggestionStore;
let idSeq: number;
let storeNow: number;
let defNow: number;
let suggestionNow: number;
let ctxNow: number;

type SuggestedEvent = Extract<
  ServerEventInput,
  { kind: 'contract.delegation_rule_suggested' }
>;

const makeSeqId = (): string => {
  idSeq += 1;
  return `ct_${idSeq}`;
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
  sample_contract_ids: ['ct_3', 'ct_2', 'ct_1'],
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

const mintSessionInput = (
  overrides: Partial<MintSessionGrantInput> = {},
): MintSessionGrantInput => ({
  minted_by: 'user:1',
  display_name: 'Allow repeated action',
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

const delegationRule = (
  overrides: Partial<ContractDefinition> = {},
): ContractDefinition => ({
  contract_id: 'ct_delegation',
  minted_at: NOW - 10_000,
  minted_by: 'owner',
  display_name: 'Delegation rule',
  scope: fullScope(),
  grant_kind: 'delegation',
  grant_mode: 'exact',
  bound_recipe: {
    recipe_id: 'recipe-1',
    recipe_hash: 'recipe-hash-1',
  },
  arg_shape_hash: 'arg-shape-hash',
  risk_tier: 'write',
  canonical_payload_hash: 'payload-hash',
  entity_scope: 'deal-1',
  expiry_at: NOW + 60_000,
  max_uses: 100,
  uses_remaining: 100,
  approved_action_ref: 'suggestion-1',
  ...overrides,
});

const rawDefinition = (contract_id: string): ContractDefinition => {
  const row = store.get(CONTRACT_DEFINITION_SCOPE, [contract_id]);
  expect(row).not.toBeNull();
  return row!.value as ContractDefinition;
};

const putDefinition = (def: ContractDefinition): void => {
  store.put(CONTRACT_DEFINITION_SCOPE, [def.contract_id], def);
};

const putSuggestion = (row: DelegationRuleSuggestionRow): void => {
  store.put(DELEGATION_RULE_SUGGESTION_SCOPE, [row.key_hash], row);
};

const overwriteSuggestionUnchecked = (row: unknown, key_hash: string): void => {
  db.prepare(
    'UPDATE contract_store SET value_inline = ?, written_at = ? WHERE scope = ? AND seg_key = ?',
  ).run(JSON.stringify(row), storeNow, DELEGATION_RULE_SUGGESTION_SCOPE, key_hash);
};

const makeEventRecorder = (): {
  events: SuggestedEvent[];
  eventBus: EventBus;
} => {
  const events: SuggestedEvent[] = [];
  const eventBus = {
    emit(event: ServerEventInput): ServerEvent {
      if (event.kind === 'contract.delegation_rule_suggested') {
        events.push(event);
      }
      return { ...event, cursor: events.length } as ServerEvent;
    },
  } as EventBus;
  return { events, eventBus };
};

const taskCtx = (now: () => number = () => ctxNow): HousekeepingContext =>
  ({
    db,
    now,
    emitAuditRow: () => undefined,
  } as unknown as HousekeepingContext);

const runTask = async (
  eventBus: EventBus,
  cursor: HousekeepingCursor = { kind: 'time', last_seen_at: 0 },
  budget_ms = 1_000,
  now: () => number = () => ctxNow,
) =>
  buildDelegationRuleSuggestionScanTask({
    definitionStore: defStore,
    suggestionStore,
    eventBus,
  }).step(taskCtx(now), cursor, budget_ms);

const mintSessionGrantAt = (
  channel_session_id: string,
  minted_at: number,
  overrides: Partial<MintSessionGrantInput> = {},
): ContractDefinition => {
  defNow = minted_at;
  storeNow = minted_at;
  return defStore.mintSessionGrant(mintSessionInput({
    channel_session_id,
    approved_action_ref: `checkpoint-${channel_session_id}`,
    ...overrides,
  }));
};

const consumeGrant = (
  contract_id: string,
  call?: { canonical_payload_hash?: string; pinned_projection_hash?: string },
): void => {
  defNow = NOW;
  storeNow = NOW;
  expect(defStore.consumeSessionGrant(contract_id, call)).toBe(true);
};

const mintConsumedGrants = (
  sessions: readonly string[] = ['s-1', 's-2', 's-3'],
  overrides: Partial<MintSessionGrantInput> = {},
): ContractDefinition[] =>
  sessions.map((session, idx) => {
    const grant = mintSessionGrantAt(session, NOW - (sessions.length - idx) * 1_000, overrides);
    consumeGrant(grant.contract_id, overrides.grant_mode === 'open'
      ? { pinned_projection_hash: overrides.pinned_projection_hash }
      : undefined);
    return rawDefinition(grant.contract_id);
  });

const keyHashFromGrant = (grant: ContractDefinition): string => {
  const key = deriveDelegationRuleSuggestionKey(grant);
  expect(key).not.toBeUndefined();
  if (key === undefined) throw new Error('expected derivable grant');
  return delegationRuleSuggestionKeyHash(key);
};

beforeEach(() => {
  db = new Database(':memory:');
  storeNow = NOW;
  defNow = NOW;
  suggestionNow = NOW;
  ctxNow = NOW;
  idSeq = 0;
  store = createContractStore(db, { now: () => storeNow });
  store.seedSchema(D165_CONTRACT_SCHEMA);
  defStore = createContractDefinitionStore(store, { now: () => defNow, newId: makeSeqId });
  suggestionStore = createDelegationSuggestionStore(store, { now: () => suggestionNow });
});

afterEach(() => {
  db.close();
});

describe('createDelegationSuggestionStore', () => {
  it('upserts open rows idempotently and preserves terminal states', () => {
    const snapshot = baseSnapshot();
    const key_hash = delegationRuleSuggestionKeyHash(snapshot);
    const evidence = baseEvidence();

    suggestionNow = NOW + 10;
    expect(suggestionStore.upsertOpen({ key_hash, snapshot, evidence })).toBe('created');
    expect(suggestionStore.get(key_hash)).toEqual({
      key_hash,
      state: 'open',
      snapshot,
      evidence,
      created_at: NOW + 10,
      updated_at: NOW + 10,
    });

    suggestionNow = NOW + 20;
    expect(suggestionStore.upsertOpen({ key_hash, snapshot, evidence })).toBe('unchanged');
    expect(suggestionStore.get(key_hash)).toEqual(expect.objectContaining({
      created_at: NOW + 10,
      updated_at: NOW + 10,
    }));

    const changedEvidence = baseEvidence({
      row_count: 4,
      distinct_session_count: 4,
      consumed_uses: 4,
      sample_contract_ids: ['ct_4', 'ct_3', 'ct_2', 'ct_1'],
      last_minted_at: NOW,
    });
    suggestionNow = NOW + 30;
    expect(suggestionStore.upsertOpen({ key_hash, snapshot, evidence: changedEvidence }))
      .toBe('updated');
    expect(suggestionStore.get(key_hash)).toEqual({
      key_hash,
      state: 'open',
      snapshot,
      evidence: changedEvidence,
      created_at: NOW + 10,
      updated_at: NOW + 30,
    });

    for (const state of ['dismissed', 'accepted'] as const) {
      const terminal = suggestionRow({
        key_hash: `key-${state}`,
        state,
        updated_at: NOW + 40,
      });
      putSuggestion(terminal);
      suggestionNow = NOW + 50;

      expect(suggestionStore.upsertOpen({
        key_hash: terminal.key_hash,
        snapshot: baseSnapshot({ ingredient_id: `${state}.send` }),
        evidence: changedEvidence,
      }), state).toBe('suppressed');
      expect(suggestionStore.get(terminal.key_hash), state).toEqual(terminal);
    }
  });

  it('suppresses unknown existing states fail closed', () => {
    const row = suggestionRow({ key_hash: 'key-unknown-state' });
    putSuggestion(row);
    const unknown = { ...row, state: 'paused' };
    overwriteSuggestionUnchecked(unknown, row.key_hash);

    expect(suggestionStore.upsertOpen({
      key_hash: row.key_hash,
      snapshot: baseSnapshot({ ingredient_id: 'changed.send' }),
      evidence: baseEvidence({ row_count: 4 }),
    })).toBe('suppressed');
    expect(suggestionStore.get(row.key_hash)).toEqual(unknown);
  });

  it('lists by updated_at descending with key_hash ascending tiebreak and round-trips get', () => {
    const rows = [
      suggestionRow({ key_hash: 'b', updated_at: NOW + 20 }),
      suggestionRow({ key_hash: 'a', updated_at: NOW + 20 }),
      suggestionRow({ key_hash: 'c', updated_at: NOW + 10 }),
    ];
    for (const row of rows) putSuggestion(row);

    expect(suggestionStore.list().map((row) => row.key_hash)).toEqual(['a', 'b', 'c']);
    expect(suggestionStore.get('b')).toEqual(rows[0]);
    expect(suggestionStore.get('missing')).toBeNull();
  });
});

describe('delegation-rule suggestion learner task', () => {
  it('creates one suggestion and one event for three consumed sessions on one key', async () => {
    const grants = mintConsumedGrants();
    const key_hash = keyHashFromGrant(grants[0]!);
    const { events, eventBus } = makeEventRecorder();

    const result = await runTask(eventBus);

    expect(result).toEqual({
      status: 'complete',
      cursor: { kind: 'time', last_seen_at: NOW - 1_000 },
    });
    expect(suggestionStore.get(key_hash)).toEqual(expect.objectContaining({
      key_hash,
      state: 'open',
      evidence: expect.objectContaining({
        row_count: 3,
        distinct_session_count: 3,
      }),
    }));
    expect(events).toEqual([{
      kind: 'contract.delegation_rule_suggested',
      key_hash,
      ingredient_id: 'mail.send',
      operation_id: 'mail.send',
    }]);

    const firstRow = suggestionStore.get(key_hash);
    const rerun = await runTask(eventBus, result.cursor);

    expect(rerun.status).toBe('complete');
    expect(events).toHaveLength(1);
    expect(suggestionStore.get(key_hash)).toEqual(firstRow);
  });

  it('does not suggest for three grants across only two sessions', async () => {
    mintConsumedGrants(['s-1', 's-1', 's-2']);
    const { events, eventBus } = makeEventRecorder();

    await runTask(eventBus);

    expect(suggestionStore.list()).toEqual([]);
    expect(events).toEqual([]);
  });

  it('recomputes all rows so consumption-only threshold crossing creates a row', async () => {
    const grants = [
      mintSessionGrantAt('s-1', NOW - 3_000),
      mintSessionGrantAt('s-2', NOW - 2_000),
      mintSessionGrantAt('s-3', NOW - 1_000),
    ];
    const key_hash = keyHashFromGrant(grants[0]!);
    const { events, eventBus } = makeEventRecorder();

    const first = await runTask(eventBus);

    expect(suggestionStore.get(key_hash)).toBeNull();
    expect(events).toEqual([]);

    for (const grant of grants) consumeGrant(grant.contract_id);
    const second = await runTask(eventBus, first.cursor);

    expect(second).toEqual({
      status: 'complete',
      cursor: { kind: 'time', last_seen_at: NOW - 1_000 },
    });
    expect(suggestionStore.get(key_hash)).toEqual(expect.objectContaining({
      state: 'open',
      evidence: expect.objectContaining({ row_count: 3, distinct_session_count: 3 }),
    }));
    expect(events).toHaveLength(1);
  });

  it('suppresses a key poisoned by a revoked session grant', async () => {
    const grants = mintConsumedGrants();
    const revoked = mintSessionGrantAt('s-4', NOW - 500);
    defNow = NOW;
    expect(defStore.revoke(revoked.contract_id, 'owner disabled')).toEqual(expect.objectContaining({
      revoked_at: NOW,
    }));
    const key_hash = keyHashFromGrant(grants[0]!);
    const { events, eventBus } = makeEventRecorder();

    await runTask(eventBus);

    expect(suggestionStore.get(key_hash)).toBeNull();
    expect(events).toEqual([]);
  });

  it.each([
    ['live delegation rule', delegationRule({ contract_id: 'ct_rule_live' }), false],
    [
      'revoked delegation rule',
      delegationRule({
        contract_id: 'ct_rule_revoked',
        revoked_at: NOW - 100,
        revocation_reason: 'owner disabled',
      }),
      false,
    ],
    ['expired non-revoked delegation rule', delegationRule({
      contract_id: 'ct_rule_expired',
      expiry_at: NOW - 1,
    }), true],
  ])('applies delegation-rule suppression: %s', async (_name, rule, shouldSuggest) => {
    const grants = mintConsumedGrants();
    const key_hash = keyHashFromGrant(grants[0]!);
    putDefinition(rule);
    const { events, eventBus } = makeEventRecorder();

    await runTask(eventBus);

    if (shouldSuggest) {
      expect(suggestionStore.get(key_hash)).toEqual(expect.objectContaining({ state: 'open' }));
      expect(events).toHaveLength(1);
    } else {
      expect(suggestionStore.get(key_hash)).toBeNull();
      expect(events).toEqual([]);
    }
  });

  it('keeps dismissed suggestions permanent through a qualifying recompute', async () => {
    const grants = mintConsumedGrants();
    const key_hash = keyHashFromGrant(grants[0]!);
    const dismissed = suggestionRow({ key_hash, state: 'dismissed', updated_at: NOW - 1 });
    putSuggestion(dismissed);
    const { events, eventBus } = makeEventRecorder();

    await runTask(eventBus);

    expect(suggestionStore.get(key_hash)).toEqual(dismissed);
    expect(events).toEqual([]);
  });

  it('yields on exhausted budget and resumes without duplicate created-row events', async () => {
    const grants = mintConsumedGrants();
    const key_hash = keyHashFromGrant(grants[0]!);
    const { events, eventBus } = makeEventRecorder();
    let advancingNow = NOW;

    const yielded = await runTask(
      eventBus,
      { kind: 'time', last_seen_at: 0 },
      0,
      () => {
        advancingNow += 1;
        return advancingNow;
      },
    );

    expect(yielded).toEqual({
      status: 'yield',
      reason: 'budget_exhausted',
      cursor: {
        kind: 'topic',
        topic: DELEGATION_RULE_SUGGESTION_SCAN_TASK_ID,
        max_target_id_seen: '',
      },
    });
    expect(suggestionStore.get(key_hash)).toBeNull();
    expect(events).toEqual([]);

    const complete = await runTask(eventBus, yielded.cursor);

    expect(complete.status).toBe('complete');
    expect(suggestionStore.get(key_hash)).toEqual(expect.objectContaining({ state: 'open' }));
    expect(events).toHaveLength(1);

    await runTask(eventBus, complete.cursor);

    expect(events).toHaveLength(1);
  });

  it('keeps underivable batch-mode session grants inert', async () => {
    const grants = ['s-1', 's-2', 's-3'].map((session, idx) =>
      mintSessionGrantAt(session, NOW - (3 - idx) * 1_000, {
        grant_mode: 'batch',
        canonical_payload_hash: undefined,
        batch_members: [
          { member_id: `m-${idx + 1}`, canonical_payload_hash: 'payload-hash' },
        ],
      }));
    for (const grant of grants) {
      consumeGrant(grant.contract_id, { canonical_payload_hash: 'payload-hash' });
    }
    const { events, eventBus } = makeEventRecorder();

    await runTask(eventBus);

    expect(suggestionStore.list()).toEqual([]);
    expect(events).toEqual([]);
  });

  it('STAGED-TRUST OWNER-ONLY: ignores contracted_user (door) session grants entirely', async () => {
    // Three consumed door (contracted_user) grants on one key across three sessions —
    // qualifies by count/sessions, but the learner must NOT suggest: a delegation rule
    // scoped to contracted_user would match EVERY door (scope-bound matching), the
    // privilege-creep the owner-only gate prevents. Owner grants (user_self) are the
    // only learnable signal.
    mintConsumedGrants(['s-1', 's-2', 's-3'], {
      scope: fullScope({ actors: ['contracted_user'] }),
    });
    const { events, eventBus } = makeEventRecorder();

    await runTask(eventBus);

    expect(suggestionStore.list()).toEqual([]);
    expect(events).toEqual([]);
  });

  it('also learns open-mode repetitions with a well-formed projection snapshot', async () => {
    const projection = openProjection();
    const grants = mintConsumedGrants(['s-1', 's-2', 's-3'], {
      grant_mode: 'open',
      canonical_payload_hash: undefined,
      pinned_projection_hash: 'projection-hash',
      open_projection: projection,
    });
    const key_hash = keyHashFromGrant(grants[0]!);
    const { events, eventBus } = makeEventRecorder();

    await runTask(eventBus);

    expect(suggestionStore.get(key_hash)).toEqual(expect.objectContaining({
      snapshot: expect.objectContaining({
        grant_mode: 'open',
        pinned_projection_hash: 'projection-hash',
        open_projection: projection,
      }),
    }));
    expect(events).toHaveLength(1);
  });
});
