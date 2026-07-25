/** D-166 contract_id lifecycle RPCs. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  D165_CONTRACT_SCHEMA,
  RpcError,
  isReservedLocalRpc,
  opGrantEntry,
  type ContractDefinitionView,
  type ContractListRequest,
  type ContractListResponse,
  type ExecutionSource,
  type IngredientManifest,
} from '@recued/contracts';

import {
  makeContractHandlers,
  type ContractBroadcastEvent,
} from '../contract-handler.js';
import { createOpAdmissionGate } from '../op-admission-gate.js';
import {
  createContractDefinitionStore,
} from '../storage/contract-definition-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import {
  createContractStore,
  type ContractStore,
} from '../storage/contract-store.js';
import type { WsClient } from '../ws-server.js';

const NOW = 1_714_867_200_000;

type ContractHandlers = NonNullable<ReturnType<typeof makeContractHandlers>>['handlers'];

let now = NOW;
const openDbs: Database.Database[] = [];

const CLIENT = { display_name: 'Bob MacBook' } as WsClient;

beforeEach(() => {
  now = NOW;
});

afterEach(() => {
  for (const db of openDbs.splice(0).reverse()) db.close();
});

const getManifest = (_slug: string): IngredientManifest | null => null;
const listManifests = (): IngredientManifest[] => [];

const makeStore = (): ContractStore => {
  const db = new Database(':memory:');
  openDbs.push(db);
  const store = createContractStore(db, { now: () => now });
  store.seedSchema(D165_CONTRACT_SCHEMA);
  return store;
};

const makeHandlersForStore = (store: ContractStore): ContractHandlers => {
  let seq = 0;
  const slice = makeContractHandlers({
    store,
    getManifest,
    listManifests,
    now: () => now,
    newContractId: () => `ct_test_${String(++seq).padStart(3, '0')}`,
  });
  if (!slice) throw new Error('contract handler slice was not created');
  return slice.handlers;
};

const makeHarness = (): { store: ContractStore; handlers: ContractHandlers } => {
  const store = makeStore();
  return { store, handlers: makeHandlersForStore(store) };
};

/** D-171 — a harness whose handler slice is wired with a `broadcast` seam that
 *  captures every emitted `contract.contract_definition_changed` event. `onEmit`
 *  lets a test force the emit to throw (to prove the rpc swallows it). */
const makeBroadcastHarness = (
  onEmit?: (event: ContractBroadcastEvent) => void,
): { handlers: ContractHandlers; events: ContractBroadcastEvent[] } => {
  const store = makeStore();
  const events: ContractBroadcastEvent[] = [];
  let seq = 0;
  const slice = makeContractHandlers({
    store,
    getManifest,
    listManifests,
    now: () => now,
    newContractId: () => `ct_test_${String(++seq).padStart(3, '0')}`,
    broadcast: (event) => {
      events.push(event);
      onEmit?.(event);
    },
  });
  if (!slice) throw new Error('contract handler slice was not created');
  return { handlers: slice.handlers, events };
};

const mintContract = (
  handlers: ContractHandlers,
  args: unknown,
  client: WsClient = CLIENT,
): Promise<ContractDefinitionView> =>
  handlers['collection.contract.mintContract'](
    args as Parameters<ContractHandlers['collection.contract.mintContract']>[0],
    client,
  );

const revokeContract = (
  handlers: ContractHandlers,
  args: unknown,
): Promise<ContractDefinitionView> =>
  handlers['collection.contract.revokeContract'](
    args as Parameters<ContractHandlers['collection.contract.revokeContract']>[0],
    CLIENT,
  );

const listContracts = (
  handlers: ContractHandlers,
  args?: ContractListRequest,
): Promise<ContractListResponse> =>
  handlers['collection.contract.listContracts'](
    args as Parameters<ContractHandlers['collection.contract.listContracts']>[0],
    CLIENT,
  );

const setDoorTypes = (
  handlers: ContractHandlers,
  args: unknown,
): Promise<ContractDefinitionView> =>
  handlers['collection.contract.setDoorTypes'](
    args as Parameters<ContractHandlers['collection.contract.setDoorTypes']>[0],
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

describe('D-166 contract_id lifecycle RPCs', () => {
  it('mints a contract view, stamps provenance, persists it, and falls back minted_by', async () => {
    const { store, handlers } = makeHarness();
    const scope = {
      channels: ['mcp'],
      actors: ['contracted_user'],
      ingredient_ids: ['gmail/inbox'],
    };

    const minted = await mintContract(handlers, {
      display_name: 'Inbox triage agent',
      scope,
    });

    expect(minted).toEqual(expect.objectContaining({
      contract_id: 'ct_test_001',
      minted_at: NOW,
      minted_by: 'Bob MacBook',
      display_name: 'Inbox triage agent',
      scope,
      lifecycle_state: 'active',
    }));
    expect('uses_remaining' in minted).toBe(false);

    const freshHandlers = makeHandlersForStore(store);
    await expect(listContracts(freshHandlers)).resolves.toEqual({
      contracts: [minted],
    });

    const fallback = await mintContract(
      handlers,
      { display_name: 'Whitespace provenance', scope: {} },
      { display_name: '   ' } as WsClient,
    );
    expect(fallback).toEqual(expect.objectContaining({
      contract_id: 'ct_test_002',
      minted_by: 'operator',
      lifecycle_state: 'active',
    }));
  });

  it('rejects invalid mint payloads with bad_request', async () => {
    const { handlers } = makeHarness();

    const invalidPayloads: unknown[] = [
      { scope: {} },
      { display_name: '   ', scope: {} },
      { display_name: 'Bad scope', scope: null },
      { display_name: 'Bad max uses zero', scope: {}, max_uses: 0 },
      { display_name: 'Bad max uses negative', scope: {}, max_uses: -1 },
      { display_name: 'Bad max uses fractional', scope: {}, max_uses: 1.5 },
      { display_name: 'Bad expiry', scope: {}, expiry_at: 'soon' },
      // D-187 §6 (step 7) — door_types must be an array of known door types.
      { display_name: 'Bad door-type member', scope: {}, door_types: ['chat'] },
      { display_name: 'Bad door-type shape', scope: {}, door_types: 'mcp' },
      { display_name: 'Instance mint escape', scope: {}, grant_kind: 'customer_instance' },
      { display_name: 'Session mint escape', scope: {}, grant_kind: 'session' },
      { display_name: 'Delegation mint escape', scope: {}, grant_kind: 'delegation' },
      { display_name: 'Explicit standing escape', scope: {}, grant_kind: 'standing' },
    ];

    for (const payload of invalidPayloads) {
      await expectRpcCode(mintContract(handlers, payload), 'bad_request');
    }
  });

  it('mints with door_types (D-187 step 7) and surfaces them on the view + store', async () => {
    const { store, handlers } = makeHarness();

    const minted = await mintContract(handlers, {
      display_name: 'MCP + LLM gateway door',
      scope: {},
      door_types: ['mcp', 'llm_gateway'],
    });

    expect(minted).toEqual(expect.objectContaining({
      door_types: ['mcp', 'llm_gateway'],
      lifecycle_state: 'active',
    }));

    // Persisted — a fresh handler set over the same store reads it back.
    const freshHandlers = makeHandlersForStore(store);
    const { contracts } = await listContracts(freshHandlers);
    expect(contracts.find((c) => c.contract_id === minted.contract_id)?.door_types)
      .toEqual(['mcp', 'llm_gateway']);

    // Omitted door_types stays absent (sparse wildcard).
    const wildcard = await mintContract(handlers, { display_name: 'Wildcard', scope: {} });
    expect('door_types' in wildcard).toBe(false);
  });

  it('mints customer templates through normal authoring and lists the discriminator', async () => {
    const { store, handlers } = makeHarness();

    const minted = await mintContract(handlers, {
      display_name: 'Pro customer template',
      grant_kind: 'customer_template',
      scope: { operation_ids: ['core.mail.send'] },
      door_types: ['mcp'],
    });

    expect(minted).toEqual(expect.objectContaining({
      contract_id: 'ct_test_001',
      display_name: 'Pro customer template',
      grant_kind: 'customer_template',
      door_types: ['mcp'],
      lifecycle_state: 'active',
    }));
    await expect(listContracts(makeHandlersForStore(store))).resolves.toEqual({
      contracts: [minted],
    });
  });

  it('seeds uses_remaining when max_uses is present', async () => {
    const { handlers } = makeHarness();

    const minted = await mintContract(handlers, {
      display_name: 'Bounded contract',
      scope: {},
      max_uses: 3,
    });

    expect(minted).toEqual(expect.objectContaining({
      max_uses: 3,
      uses_remaining: 3,
      lifecycle_state: 'active',
    }));
  });

  it('maps malformed scope axes from the store value_shape gate to bad_request', async () => {
    const { handlers } = makeHarness();

    await expectRpcCode(
      mintContract(handlers, {
        display_name: 'Bad actor axis',
        scope: { actors: [123] },
      }),
      'bad_request',
    );
    await expectRpcCode(
      mintContract(handlers, {
        display_name: 'Bad channel axis',
        scope: { channels: 'x' },
      }),
      'bad_request',
    );
  });

  it('revokes with provenance, default reason, idempotence, and not_found errors', async () => {
    const { handlers } = makeHarness();
    const first = await mintContract(handlers, {
      display_name: 'Revocable contract',
      scope: {},
    });

    now = NOW + 5_000;
    const revoked = await revokeContract(handlers, {
      contract_id: first.contract_id,
      reason: 'user signed out',
    });
    expect(revoked).toEqual(expect.objectContaining({
      contract_id: first.contract_id,
      revoked_at: NOW + 5_000,
      revocation_reason: 'user signed out',
      lifecycle_state: 'revoked',
    }));

    now = NOW + 9_000;
    const secondRevoke = await revokeContract(handlers, {
      contract_id: first.contract_id,
      reason: 'different reason',
    });
    expect(secondRevoke).toEqual(expect.objectContaining({
      revoked_at: NOW + 5_000,
      revocation_reason: 'user signed out',
      lifecycle_state: 'revoked',
    }));

    const defaultReasonContract = await mintContract(handlers, {
      display_name: 'Default reason contract',
      scope: {},
    });
    now = NOW + 12_000;
    await expect(revokeContract(handlers, {
      contract_id: defaultReasonContract.contract_id,
    })).resolves.toEqual(expect.objectContaining({
      revoked_at: NOW + 12_000,
      revocation_reason: 'Revoked from Settings',
      lifecycle_state: 'revoked',
    }));

    await expectRpcCode(
      revokeContract(handlers, { contract_id: 'ct_missing' }),
      'not_found',
    );
  });

  it('lists newest-first and resolves active, expired, and exhausted rows', async () => {
    const { store, handlers } = makeHarness();

    now = NOW;
    const active = await mintContract(handlers, {
      display_name: 'Active contract',
      scope: { channels: ['mcp'] },
    });

    now = NOW + 100;
    const expired = await mintContract(handlers, {
      display_name: 'Expired contract',
      scope: { actors: ['contracted_user'] },
      expiry_at: NOW + 150,
    });

    now = NOW + 200;
    const exhausted = await mintContract(handlers, {
      display_name: 'Exhausted contract',
      scope: { ingredient_ids: ['github/issues'] },
      max_uses: 1,
    });
    expect(exhausted).toEqual(expect.objectContaining({
      lifecycle_state: 'active',
      uses_remaining: 1,
    }));

    const definitionStore = createContractDefinitionStore(store, {
      now: () => now,
    });
    expect(definitionStore.recordUse(exhausted.contract_id)).toEqual(
      expect.objectContaining({ uses_remaining: 0 }),
    );

    now = NOW + 300;
    const { contracts } = await listContracts(handlers);

    expect(contracts.map((c) => c.contract_id)).toEqual([
      exhausted.contract_id,
      expired.contract_id,
      active.contract_id,
    ]);
    expect(contracts.map((c) => c.lifecycle_state)).toEqual([
      'exhausted',
      'expired',
      'active',
    ]);
  });

  it('pages authored standing contracts with an opaque keyset cursor', async () => {
    const { handlers } = makeHarness();

    now = NOW;
    const olderAgent = await mintContract(handlers, {
      display_name: 'Older agent',
      scope: {},
      door_types: ['mcp'],
    });
    now += 100;
    const receptionContract = await mintContract(handlers, {
      display_name: 'Derived reception substrate',
      scope: { channels: ['reception'], actors: ['anonymous'] },
      door_types: ['reception'],
    });
    now += 100;
    const template = await mintContract(handlers, {
      display_name: 'Seller template',
      grant_kind: 'customer_template',
      scope: {},
    });
    now += 100;
    const newerAgent = await mintContract(handlers, {
      display_name: 'Newer agent',
      scope: {},
      door_types: ['mcp_chat'],
    });

    const first = await listContracts(handlers, {
      grant_kind: 'standing',
      exclude_derived_doors: true,
      limit: 1,
    });
    expect(first.contracts.map((row) => row.contract_id)).toEqual([
      newerAgent.contract_id,
    ]);
    expect(first.total).toBe(2);
    expect(first.next_cursor).toEqual(expect.any(String));

    const second = await listContracts(handlers, {
      grant_kind: 'standing',
      exclude_derived_doors: true,
      limit: 1,
      cursor: first.next_cursor!,
    });
    expect(second.contracts.map((row) => row.contract_id)).toEqual([
      olderAgent.contract_id,
    ]);
    expect(second.total).toBe(2);
    expect(second.next_cursor).toBeNull();

    const builtIn = await listContracts(handlers, {
      grant_kind: 'standing',
      derived_doors_only: true,
      limit: 25,
    });
    expect(builtIn.contracts.map((row) => row.contract_id)).toEqual([
      receptionContract.contract_id,
    ]);
    expect(builtIn.total).toBe(1);
    expect(builtIn.next_cursor).toBeNull();

    await expect(listContracts(handlers, { contract_id: template.contract_id }))
      .resolves.toEqual({ contracts: [template] });
  });

  it('rejects malformed list paging arguments', async () => {
    const { handlers } = makeHarness();
    for (const args of [
      { limit: 0 },
      { limit: 1.5 },
      { cursor: 'not-a-cursor' },
      { exclude_derived_doors: 'yes' },
      { derived_doors_only: 'yes' },
      { exclude_derived_doors: true, derived_doors_only: true },
      { contract_id: '   ' },
    ]) {
      await expectRpcCode(listContracts(handlers, args as ContractListRequest), 'bad_request');
    }
  });

  it('returns an empty contracts list from an empty store', async () => {
    const { handlers } = makeHarness();

    await expect(listContracts(handlers)).resolves.toEqual({ contracts: [] });
  });

  it('keeps lifecycle methods under the reserved local RPC prefix', () => {
    expect(isReservedLocalRpc('collection.contract.mintContract')).toBe(true);
    // D-187 §6 step 7 — the in-place door-type edit MUST be operator-only too
    // (an MCP agent reconfiguring its own door = self-widening).
    expect(isReservedLocalRpc('collection.contract.setDoorTypes')).toBe(true);
  });
});

describe('D-187 step 7 follow-on — collection.contract.setDoorTypes rpc', () => {
  it('sets door types in place, keeping the same contract_id (binding survives)', async () => {
    const { handlers } = makeHarness();
    const minted = await mintContract(handlers, { display_name: 'Door', scope: {} });

    const updated = await setDoorTypes(handlers, {
      contract_id: minted.contract_id,
      door_types: ['llm_gateway'],
    });

    expect(updated.contract_id).toBe(minted.contract_id);
    expect(updated.door_types).toEqual(['llm_gateway']);
    expect(updated.lifecycle_state).toBe('active');
  });

  it('edits door types on a customer template without changing its kind', async () => {
    const { handlers } = makeHarness();
    const minted = await mintContract(handlers, {
      display_name: 'Customer template',
      grant_kind: 'customer_template',
      scope: {},
      door_types: ['mcp'],
    });

    await expect(setDoorTypes(handlers, {
      contract_id: minted.contract_id,
      door_types: ['mcp_chat'],
    })).resolves.toEqual(expect.objectContaining({
      contract_id: minted.contract_id,
      grant_kind: 'customer_template',
      door_types: ['mcp_chat'],
    }));
  });

  it('clears the restriction with an empty array (sparse wildcard)', async () => {
    const { handlers } = makeHarness();
    const minted = await mintContract(handlers, {
      display_name: 'Door',
      scope: {},
      door_types: ['mcp'],
    });

    const cleared = await setDoorTypes(handlers, {
      contract_id: minted.contract_id,
      door_types: [],
    });
    expect('door_types' in cleared).toBe(false);
  });

  it('rejects the reserved owner contract id with bad_request', async () => {
    const { handlers } = makeHarness();
    await expectRpcCode(
      setDoorTypes(handlers, { contract_id: 'user_self', door_types: ['mcp'] }),
      'bad_request',
    );
  });

  it('rejects a missing / invalid door_types payload with bad_request', async () => {
    const { handlers } = makeHarness();
    const minted = await mintContract(handlers, { display_name: 'Door', scope: {} });
    const bad: unknown[] = [
      { contract_id: minted.contract_id }, // door_types absent (required)
      { contract_id: minted.contract_id, door_types: 'mcp' }, // not an array
      { contract_id: minted.contract_id, door_types: ['chat'] }, // unknown member
      { door_types: ['mcp'] }, // contract_id missing
    ];
    for (const payload of bad) {
      await expectRpcCode(setDoorTypes(handlers, payload), 'bad_request');
    }
  });

  it('returns not_found for an unknown contract_id', async () => {
    const { handlers } = makeHarness();
    await expectRpcCode(
      setDoorTypes(handlers, { contract_id: 'ct_nope', door_types: ['mcp'] }),
      'not_found',
    );
  });

  it('emits op:"update" on the broadcast bus after a successful edit', async () => {
    const { handlers, events } = makeBroadcastHarness();
    const minted = await mintContract(handlers, { display_name: 'Door', scope: { channels: ['mcp'] } });

    await setDoorTypes(handlers, { contract_id: minted.contract_id, door_types: ['mcp'] });

    // [0] is the mint; the door-type edit is the second frame, op "update".
    expect(events[events.length - 1]).toEqual({
      kind: 'contract.contract_definition_changed',
      op: 'update',
      contract_id: minted.contract_id,
    });
  });

  it('does NOT emit when the edit targets a missing contract (the rpc throws first)', async () => {
    const { handlers, events } = makeBroadcastHarness();
    await expectRpcCode(
      setDoorTypes(handlers, { contract_id: 'ct_nope', door_types: ['mcp'] }),
      'not_found',
    );
    expect(events).toEqual([]);
  });
});

describe('D-171 — contract.contract_definition_changed broadcast', () => {
  const SCOPE = { channels: ['mcp'] };

  it('emits op:"mint" with the new contract_id after a successful mint', async () => {
    const { handlers, events } = makeBroadcastHarness();

    const minted = await mintContract(handlers, {
      display_name: 'Inbox triage agent',
      scope: SCOPE,
      max_uses: 10,
    });

    expect(events).toEqual([
      {
        kind: 'contract.contract_definition_changed',
        op: 'mint',
        contract_id: minted.contract_id,
      },
    ]);
  });

  it('emits op:"revoke" with the contract_id after a successful revoke', async () => {
    const { handlers, events } = makeBroadcastHarness();
    const minted = await mintContract(handlers, {
      display_name: 'Inbox triage agent',
      scope: SCOPE,
    });

    await revokeContract(handlers, { contract_id: minted.contract_id });

    // [0] is the mint; the revoke is the second frame.
    expect(events).toEqual([
      { kind: 'contract.contract_definition_changed', op: 'mint', contract_id: minted.contract_id },
      { kind: 'contract.contract_definition_changed', op: 'revoke', contract_id: minted.contract_id },
    ]);
  });

  it('does NOT emit when a revoke targets a missing contract (the rpc throws first)', async () => {
    const { handlers, events } = makeBroadcastHarness();

    await expectRpcCode(
      revokeContract(handlers, { contract_id: 'ct_nope' }),
      'not_found',
    );
    expect(events).toEqual([]);
  });

  it('mints and revokes successfully when no broadcast seam is wired', async () => {
    // The default harness wires no `broadcast` dep — the lifecycle writes still
    // succeed (only the live fan-out is absent). Guards the optional-dep path.
    const { handlers } = makeHarness();
    const minted = await mintContract(handlers, {
      display_name: 'No-bus agent',
      scope: SCOPE,
    });
    await expect(
      revokeContract(handlers, { contract_id: minted.contract_id }),
    ).resolves.toEqual(expect.objectContaining({ lifecycle_state: 'revoked' }));
  });

  it('swallows a broadcast emit that throws — the rpc still resolves', async () => {
    const { handlers } = makeBroadcastHarness(() => {
      throw new Error('bus down');
    });

    // The emit failure is observability-only; the mint rpc must not reject.
    await expect(
      mintContract(handlers, { display_name: 'Resilient agent', scope: SCOPE }),
    ).resolves.toEqual(expect.objectContaining({ contract_id: 'ct_test_001' }));
  });
});

describe('D-187 §6 home-#2 — the door op-grant fold (scope.operation_ids → contract_grant rows)', () => {
  const PACK_OP = 'recued-core/hubspot.deal.read';
  const KERNEL_OP = 'core.mail.send';

  it('mints a SCOPED door → an explicit granted:true contract_grant op row per scope op (kernel + pack)', async () => {
    const { store, handlers } = makeHarness();
    const minted = await mintContract(handlers, {
      display_name: 'Scoped door',
      scope: { channels: ['mcp'], actors: ['contracted_user'], operation_ids: [PACK_OP, KERNEL_OP] },
    });

    const grants = createContractGrantEntryStore(store);
    expect(grants.get(minted.contract_id, opGrantEntry(PACK_OP))).toBe(true);
    expect(grants.get(minted.contract_id, opGrantEntry(KERNEL_OP))).toBe(true);
    // Exactly those two rows — the fold is sparse (only the door's scoped ops, not all
    // registered ops the owner reconcile materializes).
    expect(grants.listForContract(minted.contract_id).map((r) => r.entry_key).sort()).toEqual(
      [PACK_OP, KERNEL_OP].sort(),
    );
  });

  it('mints a WILDCARD door (absent / empty operation_ids) → writes NO grant rows', async () => {
    const { store, handlers } = makeHarness();
    const grants = createContractGrantEntryStore(store);

    const wild = await mintContract(handlers, {
      display_name: 'Wildcard',
      scope: { channels: ['mcp'] },
    });
    expect(grants.listForContract(wild.contract_id)).toEqual([]);

    const empty = await mintContract(handlers, {
      display_name: 'Empty list',
      scope: { channels: ['mcp'], operation_ids: [] },
    });
    expect(grants.listForContract(empty.contract_id)).toEqual([]);
  });

  it('a reserved-prefix op id in scope.operation_ids → bad_request, and the whole mint ROLLS BACK (atomic)', async () => {
    const { store, handlers } = makeHarness();

    // `data.*` / `enrichment.*` can never be an op grant-entry key — `opGrantEntry` fails
    // loud inside the fold, the atomic txn rolls the mint back, and the rpc maps it to
    // bad_request (a client payload error, not a server fault).
    await expectRpcCode(
      mintContract(handlers, {
        display_name: 'Bad op id',
        scope: { channels: ['mcp'], operation_ids: ['data.mail'] },
      }),
      'bad_request',
    );

    // Nothing persisted — neither the contract_definition nor a leaked grant row.
    expect(createContractDefinitionStore(store, { now: () => now }).list()).toEqual([]);
    expect(createContractGrantEntryStore(store).listForEntry('data.mail')).toEqual([]);
  });

  it('END-TO-END: a minted scoped door is gate-admitted its scope op, denied an out-of-scope kernel op', async () => {
    const { store, handlers } = makeHarness();
    const minted = await mintContract(handlers, {
      display_name: 'E2E door',
      scope: { channels: ['mcp'], actors: ['contracted_user'], operation_ids: [PACK_OP] },
    });

    // A gate over the SAME store the handler wrote — the fold's rows + the def together.
    const gate = createOpAdmissionGate({
      grantEntryStore: createContractGrantEntryStore(store),
      definitionStore: createContractDefinitionStore(store, { now: () => now }),
      now: () => now,
    });
    const src: ExecutionSource = {
      channel: 'mcp',
      actor: 'contracted_user',
      agent_id: 'a',
      tool_call_id: 't',
      mcp_token_id: 'tok',
      contract_id: minted.contract_id,
    };
    expect(gate.isOpGranted(src, PACK_OP)).toBe(true); // the folded grant
    expect(gate.isOpGranted(src, KERNEL_OP)).toBe(false); // out-of-scope kernel ⇒ fail-closed
  });
});
