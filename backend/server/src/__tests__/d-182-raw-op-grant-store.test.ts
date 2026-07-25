/** D-182 §8 — `mintRawOpGrant` store primitive + `consumeSessionGrant`
 *  raw-op branch + resolver round-trip for the recipe-less raw-op door grant. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CONTRACT_DEFINITION_SCOPE,
  D165_CONTRACT_SCHEMA,
  matchesSessionGrant,
  validateContractWrite,
  type ContractDefinition,
  type ContractScope,
  type SessionGrantMatchContext,
} from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';

import {
  createSessionGrantResolver,
  type SessionGrantRawOpMintContext,
} from '../session-grant-resolver.js';
import { createContractStore, type ContractStore } from '../storage/contract-store.js';
import {
  RawOpGrantMintError,
  createContractDefinitionStore,
  type ContractDefinitionStore,
  type MintRawOpGrantInput,
} from '../storage/contract-definition-store.js';

const NOW = 1_700_000_000_000;

let db: Database.Database;
let store: ContractStore;
let defStore: ContractDefinitionStore;
let idSeq: number;

const makeSeqId = (): string => {
  idSeq += 1;
  return `ct_${idSeq}`;
};

const rawOpScope = (overrides: Partial<ContractScope> = {}): ContractScope => ({
  channels: ['mcp'],
  actors: ['contracted_user'],
  ingredient_ids: ['task-pack-catalog'],
  operation_ids: ['task.create'],
  connection_names: ['myconn'],
  ...overrides,
});

/** N.14.6 — every fixture here is a DOOR ("Door raw op", its own label), so it
 *  carries the door's binding + the delegated `mcp_token_id` that classifies it.
 *  An unbound row on a door ctx models the pre-fix defect: the raw-op mint scopes
 *  `actors: ['contracted_user']`, so nothing required a binding, and the row then
 *  outlived a rebind of the very token that minted it. */
const RAW_OP_DOOR_TOKEN = 'http_door_raw_op';
const RAW_OP_DOOR_CONTRACT = 'ct_door_raw_op';

const rawOpInput = (
  overrides: Partial<MintRawOpGrantInput> = {},
): MintRawOpGrantInput => ({
  minted_by: 'owner',
  display_name: 'Door raw op — task.create',
  scope: rawOpScope(),
  channel_session_id: 's',
  risk_tier: 'write',
  arg_shape_hash: 'arg-shape-hash',
  canonical_payload_hash: 'payload-hash',
  approved_action_ref: 'checkpoint-1',
  expiry_at: NOW + 60_000,
  max_uses: 3,
  bound_contract_id: RAW_OP_DOOR_CONTRACT,
  ...overrides,
});

const recipeLessCtx = (
  overrides: Partial<SessionGrantMatchContext> = {},
): SessionGrantMatchContext => ({
  channel: 'mcp',
  actor: 'contracted_user',
  channel_session_id: 's',
  mcp_token_id: RAW_OP_DOOR_TOKEN,
  source_contract_id: RAW_OP_DOOR_CONTRACT,
  ingredient_slug: 'task-pack-catalog',
  operation_id: 'task.create',
  connection_name: 'myconn',
  risk_tier: 'write',
  arg_shape_hash: 'arg-shape-hash',
  canonical_payload_hash: 'payload-hash',
  ...overrides,
});

const rawOpMintCtx = (
  overrides: Partial<SessionGrantRawOpMintContext> = {},
): SessionGrantRawOpMintContext => ({
  channel: 'mcp',
  actor: 'contracted_user',
  channel_session_id: 's',
  source_contract_id: RAW_OP_DOOR_CONTRACT,
  ingredient_slug: 'task-pack-catalog',
  operation_id: 'task.create',
  connection_name: 'myconn',
  risk_tier: 'write',
  arg_shape_hash: 'arg-shape-hash',
  canonical_payload_hash: 'payload-hash',
  approved_action_ref: 'run-raw-1',
  ttl_ms: 60_000,
  max_uses: 3,
  ...overrides,
});

const auditLogStub = (): AuditLogStore & { logActivity: ReturnType<typeof vi.fn> } =>
  ({ logActivity: vi.fn().mockResolvedValue(undefined) }) as unknown as AuditLogStore & {
    logActivity: ReturnType<typeof vi.fn>;
  };

beforeEach(() => {
  db = new Database(':memory:');
  idSeq = 0;
  store = createContractStore(db, { now: () => NOW });
  store.seedSchema(D165_CONTRACT_SCHEMA);
  defStore = createContractDefinitionStore(store, { now: () => NOW, newId: makeSeqId });
});

afterEach(() => {
  db.close();
});

describe('mintRawOpGrant', () => {
  it('persists a recipe-less bounded raw_op grant that the schema accepts', () => {
    const def = defStore.mintRawOpGrant(rawOpInput());

    expect(def).toEqual(
      expect.objectContaining({
        contract_id: 'ct_1',
        minted_at: NOW,
        minted_by: 'owner',
        grant_kind: 'session',
        grant_mode: 'raw_op',
        channel_session_id: 's',
        risk_tier: 'write',
        arg_shape_hash: 'arg-shape-hash',
        canonical_payload_hash: 'payload-hash',
        approved_action_ref: 'checkpoint-1',
        expiry_at: NOW + 60_000,
        max_uses: 3,
        uses_remaining: 3,
      }),
    );
    // Recipe-less by construction — no bound_recipe lands.
    expect(def).not.toHaveProperty('bound_recipe');

    // The persisted row passes the value_shape (the 'raw_op' literal is in the
    // schema enum) — store.put already validated, this is the explicit proof.
    const issues = validateContractWrite(
      D165_CONTRACT_SCHEMA,
      CONTRACT_DEFINITION_SCOPE,
      [def.contract_id],
      def as unknown as Record<string, unknown>,
    );
    expect(issues).toEqual([]);
  });

  it('mints a connection-less op grant when the scope omits the connection axis', () => {
    // The caller omits the connection_names KEY for an ai/entity op (the
    // conditional-spread convention — an explicit `undefined` value fails the
    // value_shape, as every other mint relies on).
    const def = defStore.mintRawOpGrant(
      rawOpInput({
        scope: {
          channels: ['mcp'],
          actors: ['contracted_user'],
          ingredient_ids: ['task-pack-catalog'],
          operation_ids: ['task.create'],
        },
      }),
    );
    expect(def.scope.connection_names).toBeUndefined();
    const ctx: SessionGrantMatchContext = {
      channel: 'mcp',
      actor: 'contracted_user',
      channel_session_id: 's',
      mcp_token_id: RAW_OP_DOOR_TOKEN,
      source_contract_id: RAW_OP_DOOR_CONTRACT,
      ingredient_slug: 'task-pack-catalog',
      operation_id: 'task.create',
      risk_tier: 'write',
      arg_shape_hash: 'arg-shape-hash',
      canonical_payload_hash: 'payload-hash',
    };
    expect(matchesSessionGrant(def, ctx, NOW)).toBe(true);
  });

  it('threads an entity_scope only when supplied', () => {
    expect(defStore.mintRawOpGrant(rawOpInput()).entity_scope).toBeUndefined();
    expect(
      defStore.mintRawOpGrant(rawOpInput({ entity_scope: 'task-1' })).entity_scope,
    ).toBe('task-1');
  });

  it('fails loud on every unmatchable / unbounded input', () => {
    const cases: ReadonlyArray<{ name: string; input: MintRawOpGrantInput }> = [
      {
        name: 'empty channel_session_id',
        input: rawOpInput({ channel_session_id: '' }),
      },
      {
        name: 'unbound ingredient axis',
        input: rawOpInput({ scope: rawOpScope({ ingredient_ids: [] }) }),
      },
      {
        name: 'unbound operation axis',
        input: rawOpInput({ scope: rawOpScope({ operation_ids: [] }) }),
      },
      {
        name: 'multi-ingredient axis (over-broad)',
        input: rawOpInput({ scope: rawOpScope({ ingredient_ids: ['a', 'b'] }) }),
      },
      {
        name: 'multi-operation axis (over-broad)',
        input: rawOpInput({
          scope: rawOpScope({ operation_ids: ['task.create', 'task.delete'] }),
        }),
      },
      {
        name: 'multi-connection axis (over-broad)',
        input: rawOpInput({
          scope: rawOpScope({ connection_names: ['a', 'b'] }),
        }),
      },
      {
        name: 'non-grantable risk_tier read',
        input: rawOpInput({ risk_tier: 'read' }),
      },
      {
        name: 'non-grantable risk_tier destructive',
        input: rawOpInput({ risk_tier: 'destructive' }),
      },
      {
        name: 'empty arg_shape_hash',
        input: rawOpInput({ arg_shape_hash: '' }),
      },
      {
        name: 'empty canonical_payload_hash',
        input: rawOpInput({ canonical_payload_hash: '' }),
      },
      {
        name: 'empty approved_action_ref',
        input: rawOpInput({ approved_action_ref: '' }),
      },
      {
        name: 'expiry_at in the past',
        input: rawOpInput({ expiry_at: NOW - 1 }),
      },
      {
        name: 'expiry_at equal to mint time',
        input: rawOpInput({ expiry_at: NOW }),
      },
      {
        name: 'max_uses zero',
        input: rawOpInput({ max_uses: 0 }),
      },
      {
        name: 'max_uses non-integer',
        input: rawOpInput({ max_uses: 1.5 }),
      },
    ];
    for (const testCase of cases) {
      expect(
        () => defStore.mintRawOpGrant(testCase.input),
        testCase.name,
      ).toThrow(RawOpGrantMintError);
    }
  });
});

describe('consumeSessionGrant — raw_op', () => {
  it('decrements when the call payload hash matches and exhausts after max_uses', () => {
    const def = defStore.mintRawOpGrant(rawOpInput({ max_uses: 2 }));
    // N.14.6 — a door-bound row re-verifies its binding at the SPEND too, so the
    // call carries the door id exactly as the live consume closure supplies it.
    const call = {
      canonical_payload_hash: 'payload-hash',
      source_contract_id: RAW_OP_DOOR_CONTRACT,
    };

    expect(defStore.consumeSessionGrant(def.contract_id, call)).toBe(true);
    expect(defStore.get(def.contract_id)?.uses_remaining).toBe(1);
    expect(defStore.consumeSessionGrant(def.contract_id, call)).toBe(true);
    expect(defStore.get(def.contract_id)?.uses_remaining).toBe(0);
    // Exhausted — the next consume fails closed.
    expect(defStore.consumeSessionGrant(def.contract_id, call)).toBe(false);
  });

  it('re-verifies the payload hash at consume (defense in depth)', () => {
    const def = defStore.mintRawOpGrant(rawOpInput());
    expect(defStore.consumeSessionGrant(def.contract_id, {
      canonical_payload_hash: 'other',
      source_contract_id: RAW_OP_DOOR_CONTRACT,
    })).toBe(false);
    // No use was spent.
    expect(defStore.get(def.contract_id)?.uses_remaining).toBe(3);
  });

  it('refuses an absent call / missing hash', () => {
    const def = defStore.mintRawOpGrant(rawOpInput());
    expect(defStore.consumeSessionGrant(def.contract_id)).toBe(false);
    expect(defStore.consumeSessionGrant(def.contract_id, {})).toBe(false);
    expect(defStore.get(def.contract_id)?.uses_remaining).toBe(3);
  });
});

describe('resolver round-trip — raw_op', () => {
  it('matches a recipe-less dispatch and consumes one use', () => {
    const resolver = createSessionGrantResolver({ definitionStore: defStore, now: () => NOW });
    const def = defStore.mintRawOpGrant(rawOpInput());

    const ctx = recipeLessCtx();
    expect(ctx.recipe_id).toBeUndefined();
    expect(resolver.match(ctx)).toBe(def.contract_id);

    expect(resolver.consume(def.contract_id, {
      canonical_payload_hash: 'payload-hash',
      source_contract_id: RAW_OP_DOOR_CONTRACT,
    })).toBe(true);
    expect(defStore.get(def.contract_id)?.uses_remaining).toBe(2);
  });

  it('does not match a dispatch for a different op', () => {
    const resolver = createSessionGrantResolver({ definitionStore: defStore, now: () => NOW });
    defStore.mintRawOpGrant(rawOpInput());
    expect(resolver.match(recipeLessCtx({ operation_id: 'task.delete' }))).toBeNull();
  });
});

describe('createSessionGrantResolver.mintRawOp', () => {
  it('mints a recipe-less raw_op row that matches its own dispatch, audits, and broadcasts', async () => {
    const log = auditLogStub();
    const broadcast = vi.fn();
    const resolver = createSessionGrantResolver({
      definitionStore: defStore,
      now: () => NOW,
      auditLog: log,
      broadcast,
    });

    const contractId = resolver.mintRawOp(rawOpMintCtx());
    await Promise.resolve();

    expect(contractId).toBe('ct_1');
    const rows = defStore.listSessionGrants('s');
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toEqual(
      expect.objectContaining({
        contract_id: 'ct_1',
        minted_by: 'owner',
        grant_kind: 'session',
        grant_mode: 'raw_op',
        channel_session_id: 's',
        risk_tier: 'write',
        arg_shape_hash: 'arg-shape-hash',
        canonical_payload_hash: 'payload-hash',
        approved_action_ref: 'run-raw-1',
        expiry_at: NOW + 60_000,
        max_uses: 3,
        uses_remaining: 3,
      }),
    );
    // Recipe-less by construction.
    expect(row).not.toHaveProperty('bound_recipe');
    expect(row.scope).toEqual({
      channels: ['mcp'],
      actors: ['contracted_user'],
      ingredient_ids: ['task-pack-catalog'],
      operation_ids: ['task.create'],
      connection_names: ['myconn'],
    });
    // The minted row matches the very dispatch that minted it.
    expect(matchesSessionGrant(row, recipeLessCtx(), NOW)).toBe(true);
    expect(log.logActivity).toHaveBeenCalledTimes(1);
    expect(log.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'session_grant_minted', target: 'ct_1' }),
    );
    expect(broadcast).toHaveBeenCalledWith({
      kind: 'contract.contract_definition_changed',
      op: 'mint',
      contract_id: 'ct_1',
    });
  });

  it('mints a connection-less op grant when connection_name is omitted', () => {
    const resolver = createSessionGrantResolver({ definitionStore: defStore, now: () => NOW });
    const ctx = rawOpMintCtx();
    delete (ctx as { connection_name?: string }).connection_name;
    resolver.mintRawOp(ctx);
    const row = defStore.listSessionGrants('s')[0]!;
    expect(row.scope.connection_names).toBeUndefined();
  });

  it('refuses a non-grantable tier without throwing, minting, auditing, or broadcasting', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = auditLogStub();
    const broadcast = vi.fn();
    const resolver = createSessionGrantResolver({
      definitionStore: defStore,
      now: () => NOW,
      auditLog: log,
      broadcast,
    });

    for (const risk_tier of ['read', 'destructive'] as const) {
      expect(resolver.mintRawOp(rawOpMintCtx({ risk_tier }))).toBeUndefined();
    }
    expect(defStore.listSessionGrants('s')).toEqual([]);
    expect(log.logActivity).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('never throws when the store mint refuses — degrades to undefined + a warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const resolver = createSessionGrantResolver({ definitionStore: defStore, now: () => NOW });
    // An empty arg_shape_hash makes the store's mintRawOpGrant throw
    // RawOpGrantMintError; the resolver swallows it (the human approval stands).
    expect(() => resolver.mintRawOp(rawOpMintCtx({ arg_shape_hash: '' }))).not.toThrow();
    expect(resolver.mintRawOp(rawOpMintCtx({ arg_shape_hash: '' }))).toBeUndefined();
    expect(defStore.listSessionGrants('s')).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('dedupes the same approval + envelope durably (including revoked rows)', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const resolver = createSessionGrantResolver({ definitionStore: defStore, now: () => NOW });

    const first = resolver.mintRawOp(rawOpMintCtx());
    expect(resolver.mintRawOp(rawOpMintCtx())).toBe(first); // dedup → same id
    expect(defStore.listSessionGrants('s')).toHaveLength(1);

    // A retry must not resurrect a revoked grant.
    defStore.revoke(first as string, 'owner disabled');
    expect(resolver.mintRawOp(rawOpMintCtx())).toBe(first);
    expect(defStore.listSessionGrants('s')).toHaveLength(1);

    // A distinct approval (new run) or a distinct payload mints a fresh row.
    resolver.mintRawOp(rawOpMintCtx({ approved_action_ref: 'run-raw-2' }));
    expect(defStore.listSessionGrants('s')).toHaveLength(2);
    resolver.mintRawOp(rawOpMintCtx({ canonical_payload_hash: 'payload-hash-2' }));
    expect(defStore.listSessionGrants('s')).toHaveLength(3);
    expect(infoSpy).toHaveBeenCalled();
  });
});
