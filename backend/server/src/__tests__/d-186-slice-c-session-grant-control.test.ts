/** D-186 Slice C — session-grant live-control ("Active passes") tests.
 *
 *  Covers the one net-new store primitive (`revokeSessionGrant` — the
 *  session-scoped, active-only early-revoke) and the two rpc handlers
 *  (`collection.contract.session_grant.{list,revoke}`): the active-only +
 *  session-only filtering, the compact render-shape projection (no bearer
 *  secrets leak), the soonest-expiring sort, the `not_found` mapping, and the
 *  `contract.contract_definition_changed` revoke broadcast. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONTRACT_DEFINITION_SCOPE,
  D165_CONTRACT_SCHEMA,
  RpcError,
  contractLifecycleState,
  type ContractDefinition,
  type ContractScope,
  type IngredientManifest,
  type SessionGrantListResponse,
  type SessionGrantView,
} from '@recued/contracts';

import {
  ContractBroadcastEvent,
  makeContractHandlers,
} from '../contract-handler.js';
import { createContractStore, type ContractStore } from '../storage/contract-store.js';
import {
  createContractDefinitionStore,
  type ContractDefinitionStore,
  type MintContractInput,
  type MintSessionGrantInput,
} from '../storage/contract-definition-store.js';
import type { WsClient } from '../ws-server.js';

const NOW = 1_700_000_000_000;

let db: Database.Database;
let store: ContractStore;
let defStore: ContractDefinitionStore;
let idSeq: number;
let storeNow: number;
let defNow: number;

const makeSeqId = (): string => {
  idSeq += 1;
  return `ct_${idSeq}`;
};

const fullScope = (overrides: Partial<ContractScope> = {}): ContractScope => ({
  channels: ['chat'],
  actors: ['user_self'],
  ingredient_ids: ['mail.send'],
  operation_ids: ['mail.send'],
  connection_names: ['gmail-primary'],
  ...overrides,
});

const mintInput = (overrides: Partial<MintContractInput> = {}): MintContractInput => ({
  minted_by: 'user:1',
  display_name: 'Standing approval',
  scope: { channels: ['chat'], actors: ['user_self'] },
  ...overrides,
});

const mintSessionInput = (
  overrides: Partial<MintSessionGrantInput> = {},
): MintSessionGrantInput => ({
  minted_by: 'user:1',
  display_name: 'Allow this session',
  scope: fullScope(),
  channel_session_id: 's',
  bound_recipe: { recipe_id: 'recipe-1', recipe_hash: 'recipe-hash-1' },
  arg_shape_hash: 'arg-shape-hash',
  risk_tier: 'write',
  canonical_payload_hash: 'payload-hash',
  entity_scope: 'deal-1',
  approved_action_ref: 'checkpoint-1',
  expiry_at: NOW + 60_000,
  max_uses: 3,
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

const sessionRow = (overrides: Partial<ContractDefinition> = {}): ContractDefinition => ({
  contract_id: 'ct_direct',
  minted_at: NOW,
  minted_by: 'user:1',
  display_name: 'Direct session grant',
  scope: fullScope(),
  grant_kind: 'session',
  grant_mode: 'exact',
  channel_session_id: 's',
  bound_recipe: { recipe_id: 'recipe-1', recipe_hash: 'recipe-hash-1' },
  arg_shape_hash: 'arg-shape-hash',
  risk_tier: 'write',
  canonical_payload_hash: 'payload-hash',
  entity_scope: 'deal-1',
  expiry_at: NOW + 60_000,
  max_uses: 3,
  uses_remaining: 3,
  ...overrides,
});

beforeEach(() => {
  db = new Database(':memory:');
  storeNow = NOW;
  defNow = NOW;
  idSeq = 0;
  store = createContractStore(db, { now: () => storeNow });
  store.seedSchema(D165_CONTRACT_SCHEMA);
  defStore = createContractDefinitionStore(store, { now: () => defNow, newId: makeSeqId });
});

afterEach(() => {
  db.close();
});

// ════════════════════════════════════════════════════════════════
// Store primitive — revokeSessionGrant
// ════════════════════════════════════════════════════════════════

describe('createContractDefinitionStore - revokeSessionGrant', () => {
  it('expires an active session grant early (stamps revoked_at + reason → lifecycle revoked)', () => {
    const grant = defStore.mintSessionGrant(mintSessionInput());
    expect(contractLifecycleState(grant, NOW)).toBe('active');

    defNow = NOW + 1_000;
    const revoked = defStore.revokeSessionGrant(grant.contract_id);

    expect(revoked).not.toBeNull();
    expect(revoked!.revoked_at).toBe(NOW + 1_000);
    expect(revoked!.revocation_reason).toBe('Revoked from live-control');
    expect(contractLifecycleState(revoked!, NOW + 1_000)).toBe('revoked');
    // Persisted, not just returned.
    expect(rawDefinition(grant.contract_id)).toEqual(revoked);
  });

  it('returns null for an absent id (nothing written)', () => {
    expect(defStore.revokeSessionGrant('ct_missing')).toBeNull();
    expect(store.scan(CONTRACT_DEFINITION_SCOPE)).toHaveLength(0);
  });

  it('fail-closed: refuses a standing contract (grant_kind absent) and leaves it untouched', () => {
    const standing = defStore.mint(mintInput({ max_uses: 2 }));

    expect(defStore.revokeSessionGrant(standing.contract_id)).toBeNull();
    // Untouched — not revoked.
    expect(rawDefinition(standing.contract_id).revoked_at).toBeUndefined();
  });

  it('fail-closed: refuses a delegation rule and leaves it untouched', () => {
    putDefinition(sessionRow({ contract_id: 'ct_deleg', grant_kind: 'delegation' }));

    expect(defStore.revokeSessionGrant('ct_deleg')).toBeNull();
    expect(rawDefinition('ct_deleg').revoked_at).toBeUndefined();
  });

  it('is idempotent: a re-revoke keeps the FIRST revoked_at + reason intact', () => {
    const grant = defStore.mintSessionGrant(mintSessionInput());
    defNow = NOW + 1_000;
    defStore.revokeSessionGrant(grant.contract_id);

    defNow = NOW + 5_000;
    const second = defStore.revokeSessionGrant(grant.contract_id);

    expect(second).not.toBeNull();
    expect(second!.revoked_at).toBe(NOW + 1_000); // not moved to NOW + 5_000
    expect(second!.revocation_reason).toBe('Revoked from live-control');
  });

  it('active-only: refuses an already-EXPIRED session grant (no provenance rewrite)', () => {
    putDefinition(sessionRow({ contract_id: 'ct_expired', expiry_at: NOW - 1 }));
    expect(contractLifecycleState(rawDefinition('ct_expired'), NOW)).toBe('expired');

    expect(defStore.revokeSessionGrant('ct_expired')).toBeNull();
    // Still expired, NOT rewritten to revoked.
    const after = rawDefinition('ct_expired');
    expect(after.revoked_at).toBeUndefined();
    expect(contractLifecycleState(after, NOW)).toBe('expired');
  });

  it('active-only: refuses an already-EXHAUSTED session grant (no provenance rewrite)', () => {
    putDefinition(sessionRow({ contract_id: 'ct_exhausted', uses_remaining: 0 }));
    expect(contractLifecycleState(rawDefinition('ct_exhausted'), NOW)).toBe('exhausted');

    expect(defStore.revokeSessionGrant('ct_exhausted')).toBeNull();
    const after = rawDefinition('ct_exhausted');
    expect(after.revoked_at).toBeUndefined();
    expect(contractLifecycleState(after, NOW)).toBe('exhausted');
  });
});

// ════════════════════════════════════════════════════════════════
// RPC handlers — session_grant.list / session_grant.revoke
// ════════════════════════════════════════════════════════════════

type ContractHandlers = NonNullable<ReturnType<typeof makeContractHandlers>>['handlers'];

const CLIENT = { display_name: 'Bob MacBook' } as WsClient;
const getManifest = (_slug: string): IngredientManifest | null => null;
const listManifests = (): IngredientManifest[] => [];

const makeHandlers = (
  events?: ContractBroadcastEvent[],
): ContractHandlers => {
  // Reuse the SAME store the test's defStore wrote, so the handlers list/revoke
  // exactly the rows the test minted.
  const slice = makeContractHandlers({
    store,
    getManifest,
    listManifests,
    now: () => defNow,
    newContractId: makeSeqId,
    ...(events ? { broadcast: (event) => events.push(event) } : {}),
  });
  if (!slice) throw new Error('contract handler slice was not created');
  return slice.handlers;
};

const listGrants = (
  handlers: ContractHandlers,
  args?: { channel_session_id?: string },
): Promise<SessionGrantListResponse> =>
  handlers['collection.contract.session_grant.list'](
    args as Parameters<ContractHandlers['collection.contract.session_grant.list']>[0],
    CLIENT,
  );

const revokeGrant = (
  handlers: ContractHandlers,
  contract_id: string,
): Promise<SessionGrantView> =>
  handlers['collection.contract.session_grant.revoke'](
    { contract_id } as Parameters<
      ContractHandlers['collection.contract.session_grant.revoke']
    >[0],
    CLIENT,
  );

const expectRpcCode = async (promise: Promise<unknown>, code: string): Promise<void> => {
  try {
    await promise;
    throw new Error('expected rejection');
  } catch (err) {
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).code).toBe(code);
  }
};

describe('D-186 session_grant.list', () => {
  it('projects an active session grant to the compact render shape with no bearer secrets', async () => {
    const grant = defStore.mintSessionGrant(mintSessionInput());
    const handlers = makeHandlers();

    const { grants } = await listGrants(handlers, {});
    expect(grants).toHaveLength(1);
    const view = grants[0]!;

    expect(view).toEqual({
      contract_id: grant.contract_id,
      display_name: 'Allow this session',
      grant_mode: 'exact',
      permits: {
        ingredient_ids: ['mail.send'],
        operation_ids: ['mail.send'],
        connection_names: ['gmail-primary'],
      },
      risk_tier: 'write',
      channel_session_id: 's',
      expiry_at: NOW + 60_000,
      remaining_ttl_ms: 60_000,
      uses_remaining: 3,
      max_uses: 3,
      lifecycle_state: 'active',
    });
    // No identity / payload / projection hashes (a grant is never a bearer secret).
    expect(view).not.toHaveProperty('canonical_payload_hash');
    expect(view).not.toHaveProperty('arg_shape_hash');
    expect(view).not.toHaveProperty('bound_recipe');
    expect(view).not.toHaveProperty('approved_action_ref');
    expect(view).not.toHaveProperty('open_projection');
  });

  it('returns member_count for a batch grant', async () => {
    putDefinition(sessionRow({
      contract_id: 'ct_batch',
      grant_mode: 'batch',
      canonical_payload_hash: undefined,
      batch_members: [
        { member_id: 'm-1', canonical_payload_hash: 'h1' },
        { member_id: 'm-2', canonical_payload_hash: 'h2' },
      ],
    }));
    const handlers = makeHandlers();

    const { grants } = await listGrants(handlers, {});
    const view = grants.find((g) => g.contract_id === 'ct_batch')!;
    expect(view.grant_mode).toBe('batch');
    expect(view.member_count).toBe(2);
  });

  it('filters out revoked / expired / exhausted rows (only active passes)', async () => {
    putDefinition(sessionRow({ contract_id: 'ct_active' }));
    putDefinition(sessionRow({ contract_id: 'ct_revoked', revoked_at: NOW - 10 }));
    putDefinition(sessionRow({ contract_id: 'ct_expired', expiry_at: NOW - 1 }));
    putDefinition(sessionRow({ contract_id: 'ct_exhausted', uses_remaining: 0 }));
    const handlers = makeHandlers();

    const { grants } = await listGrants(handlers, {});
    expect(grants.map((g) => g.contract_id)).toEqual(['ct_active']);
  });

  it('excludes standing contracts and delegation rules', async () => {
    defStore.mint(mintInput()); // standing
    putDefinition(sessionRow({ contract_id: 'ct_deleg', grant_kind: 'delegation' }));
    putDefinition(sessionRow({ contract_id: 'ct_session' }));
    const handlers = makeHandlers();

    const { grants } = await listGrants(handlers, {});
    expect(grants.map((g) => g.contract_id)).toEqual(['ct_session']);
  });

  it('orders soonest-expiring first', async () => {
    putDefinition(sessionRow({ contract_id: 'ct_late', expiry_at: NOW + 90_000 }));
    putDefinition(sessionRow({ contract_id: 'ct_soon', expiry_at: NOW + 10_000 }));
    putDefinition(sessionRow({ contract_id: 'ct_mid', expiry_at: NOW + 50_000 }));
    const handlers = makeHandlers();

    const { grants } = await listGrants(handlers, {});
    expect(grants.map((g) => g.contract_id)).toEqual(['ct_soon', 'ct_mid', 'ct_late']);
  });

  it('narrows to one channel session when channel_session_id is supplied', async () => {
    putDefinition(sessionRow({ contract_id: 'ct_s1', channel_session_id: 's1' }));
    putDefinition(sessionRow({ contract_id: 'ct_s2', channel_session_id: 's2' }));
    const handlers = makeHandlers();

    const scoped = await listGrants(handlers, { channel_session_id: 's1' });
    expect(scoped.grants.map((g) => g.contract_id)).toEqual(['ct_s1']);

    // Omitting the id returns every session owner-wide.
    const global = await listGrants(handlers, {});
    expect(global.grants.map((g) => g.contract_id).sort()).toEqual(['ct_s1', 'ct_s2']);
  });
});

describe('D-186 session_grant.revoke', () => {
  it('revokes an active grant, returns the revoked view, and broadcasts contract_definition_changed', async () => {
    const grant = defStore.mintSessionGrant(mintSessionInput());
    const events: ContractBroadcastEvent[] = [];
    const handlers = makeHandlers(events);

    const view = await revokeGrant(handlers, grant.contract_id);

    expect(view.contract_id).toBe(grant.contract_id);
    expect(view.lifecycle_state).toBe('revoked');
    expect(rawDefinition(grant.contract_id).revoked_at).toBe(NOW);
    expect(events).toEqual([
      { kind: 'contract.contract_definition_changed', op: 'revoke', contract_id: grant.contract_id },
    ]);
    // The grant drops off the active list after revoke.
    const { grants } = await listGrants(handlers, {});
    expect(grants).toHaveLength(0);
  });

  it('rejects not_found for an absent grant (no broadcast)', async () => {
    const events: ContractBroadcastEvent[] = [];
    const handlers = makeHandlers(events);

    await expectRpcCode(revokeGrant(handlers, 'ct_missing'), 'not_found');
    expect(events).toHaveLength(0);
  });

  it('rejects not_found for a standing contract (session guard)', async () => {
    const standing = defStore.mint(mintInput());
    const handlers = makeHandlers();

    await expectRpcCode(revokeGrant(handlers, standing.contract_id), 'not_found');
    expect(rawDefinition(standing.contract_id).revoked_at).toBeUndefined();
  });

  it('rejects not_found for an already-expired session grant (active-only)', async () => {
    putDefinition(sessionRow({ contract_id: 'ct_expired', expiry_at: NOW - 1 }));
    const handlers = makeHandlers();

    await expectRpcCode(revokeGrant(handlers, 'ct_expired'), 'not_found');
    expect(rawDefinition('ct_expired').revoked_at).toBeUndefined();
  });
});
