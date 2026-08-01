import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ContextCaller,
  RecordsExecutionBinding,
  RecordsSchemaSnapshot,
} from '@recued/contracts';

import { createRecordsStore, type RecordsStore } from '../store.js';

const OWNER = { publisher: 'publisher.example', pack_slug: 'project-board' } as const;
const STORAGE_HASH = '7'.repeat(64);
const DECLARATION_HASH = '8'.repeat(64);
const INVITATION_ID = 'invitation-stable-1';

const schema: RecordsSchemaSnapshot = {
  decimal_scale: 4,
  entities: {
    participant: {
      kind: 'participant',
      fields: [
        { key: 'id', slot: 'pk', kind: 'id', required: true },
        { key: 'contract_id', slot: 's1', kind: 'string', required: true },
        { key: 'role', slot: 's2', kind: 'string', required: true },
        { key: 'state', slot: 's3', kind: 'string', required: true },
      ],
    },
  },
};

const binding = (
  action: RecordsExecutionBinding['action'],
  extra: Partial<RecordsExecutionBinding> = {},
): RecordsExecutionBinding => ({
  kind: 'core.records',
  action,
  entity: 'participant',
  owner: OWNER,
  pack_version: 1,
  storage_schema_hash: STORAGE_HASH,
  declaration_hash: DECLARATION_HASH,
  operation_digest: `participant:${action}`,
  ...extra,
});

const bindings = {
  create: binding('create'),
  search: binding('search', { filter_fields: ['contract_id', 'state'] }),
  update: binding('update'),
};

type Action = 'read' | 'update';
const ROLE_ACTIONS: Readonly<Record<string, ReadonlySet<Action>>> = {
  manager: new Set<Action>(['read', 'update']),
  viewer: new Set<Action>(['read']),
};

/** This is deliberately pack logic, not a Records ACL. It demonstrates the
 * §3.3 chain: actor default, live contract, stable invitation lookup, then
 * business role. `claimedContractId` is audit/business input only and never
 * participates in authority. */
const mayPerform = (
  store: RecordsStore,
  liveContracts: ReadonlySet<string>,
  caller: ContextCaller,
  action: Action,
  _claimedContractId?: string,
): boolean => {
  if (caller.actor === 'user_self') return true;
  const contractId = caller.contract_id;
  if (contractId === undefined || !liveContracts.has(contractId)) return false;
  const found = store.execute({
    binding: bindings.search,
    principal: `contract:${contractId}`,
    args: {
      filters: { contract_id: contractId, state: 'active' },
      limit: 2,
    },
  }) as { records: Array<{ id: string; role: string }> };
  if (found.records.length !== 1) return false;
  return ROLE_ACTIONS[found.records[0]!.role]?.has(action) === true;
};

describe('D-221 receiving-recipe permission and contract rotation drive', () => {
  const dbs: Database.Database[] = [];
  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
  });

  it('uses host caller authority, keeps the invitation stable on rebind, and requires both liveness and role', () => {
    const db = new Database(':memory:');
    dbs.push(db);
    const store = createRecordsStore(db, { now: () => 1_900_000_000_000 });
    store.installNamespace({
      owner: OWNER,
      version: 1,
      storage_schema_hash: STORAGE_HASH,
      declaration_hash: DECLARATION_HASH,
      artifact_digest: 'project-board-v1',
      schema,
      bindings,
    });
    store.execute({
      binding: bindings.create,
      principal: 'owner',
      args: {
        id: INVITATION_ID,
        values: { contract_id: 'contract-old', role: 'manager', state: 'active' },
      },
    });

    const oldCaller: ContextCaller = {
      channel: 'mcp', actor: 'contracted_user', contract_id: 'contract-old',
    };
    expect(mayPerform(
      store,
      new Set(['contract-old']),
      oldCaller,
      'update',
      'caller-forged-owner-contract',
    )).toBe(true);
    expect(mayPerform(
      store,
      new Set(),
      oldCaller,
      'update',
    )).toBe(false); // role row cannot resurrect a revoked contract
    expect(mayPerform(
      store,
      new Set(),
      { channel: 'reception', actor: 'anonymous' },
      'update',
    )).toBe(false); // contract absence is not owner identity
    expect(mayPerform(
      store,
      new Set(),
      { channel: 'user', actor: 'user_self' },
      'update',
    )).toBe(true);

    const rebound = store.execute({
      binding: bindings.update,
      principal: 'owner',
      args: {
        id: INVITATION_ID,
        expected_version: 1,
        expected_revision: 0,
        set: { contract_id: 'contract-new' },
        unset: [],
      },
    }) as { record: { id: string; _record: { revision: number } } };
    expect(rebound.record.id).toBe(INVITATION_ID);
    expect(mayPerform(
      store,
      new Set(['contract-new']),
      { channel: 'mcp', actor: 'contracted_user', contract_id: 'contract-new' },
      'update',
    )).toBe(true);
    expect(mayPerform(store, new Set(['contract-new']), oldCaller, 'update')).toBe(false);

    store.execute({
      binding: bindings.update,
      principal: 'owner',
      args: {
        id: INVITATION_ID,
        expected_version: 1,
        expected_revision: rebound.record._record.revision,
        set: { role: 'viewer' },
        unset: [],
      },
    });
    expect(mayPerform(
      store,
      new Set(['contract-new']),
      { channel: 'mcp', actor: 'contracted_user', contract_id: 'contract-new' },
      'update',
    )).toBe(false); // a live contract does not grant a role-withheld action
  });
});
