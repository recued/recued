/** D-187 §6 (grant-foundation slice 3b, step 7) — the level-1 DOOR-TYPE axis.
 *
 *  Covers the contract-layer vocabulary + predicate (`DOOR_TYPES` / `isDoorType` /
 *  `contractPermitsDoorType`), the `contract_definition.door_types` value_shape
 *  enforcement, the mint-store thread, and the overlay `permitsDoorType` gate. The
 *  HTTP MCP transport gate that consumes `permitsDoorType` (reject a connection
 *  whose door type the contract isn't enabled for) is exercised end-to-end in
 *  `d-171-external-door-transport.test.ts`. */

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  CONTRACT_DEFINITION_SCOPE,
  D165_CONTRACT_SCHEMA,
  DOOR_TYPES,
  contractPermitsDoorType,
  isDoorType,
  AUTHORABLE_DOOR_TYPES,
  validateContractWrite,
  type ContractDefinition,
  type DoorType,
} from '@recued/contracts';

import { createContractOverlayResolver } from '../policy-contract-overlay.js';
import {
  createContractDefinitionStore,
  type ContractDefinitionStore,
  type MintContractInput,
} from '../storage/contract-definition-store.js';
import {
  ContractWriteInvalidError,
  createContractStore,
  type ContractStore,
} from '../storage/contract-store.js';

const NOW = 1_700_000_000_000;

// ── pure helpers (no harness) ──────────────────────────────────────

const baseDef = (overrides: Partial<ContractDefinition> = {}): ContractDefinition => ({
  contract_id: 'ct_x',
  minted_at: NOW,
  minted_by: 'user:1',
  display_name: 'Door contract',
  scope: {},
  ...overrides,
});

describe('D-187/D-196 door-type vocabulary', () => {
  // D-207 — the vocabulary SPLIT. `DOOR_TYPES` is what a contract may BACK;
  // `AUTHORABLE_DOOR_TYPES` is what a HUMAN may hand-author. They diverged the moment
  // `reception` arrived: a reception door is MINTED by the server from a recipe's derived
  // capability when the owner binds a pair — it is never ticked into existence in a UI, and
  // a hand-minted one would be an inert row that LOOKS like a live public door.
  it('DOOR_TYPES is what a contract may BACK — including the server-minted derived doors', () => {
    // D-209 (b91b08ab5) added `webhook`, the SECOND derived door: like
    // `reception` it is minted by the server at enrolment, never hand-authored.
    expect(DOOR_TYPES).toEqual(['mcp', 'mcp_chat', 'llm_gateway', 'reception', 'webhook']);
  });

  it('AUTHORABLE_DOOR_TYPES is what a HUMAN may create — reception is NOT among them', () => {
    expect(AUTHORABLE_DOOR_TYPES).toEqual(['mcp', 'mcp_chat', 'llm_gateway']);
    expect(AUTHORABLE_DOOR_TYPES).not.toContain('reception');
    expect(AUTHORABLE_DOOR_TYPES).not.toContain('webhook');
    // Every authorable type must still be a real door type — the subset can never drift out.
    for (const t of AUTHORABLE_DOOR_TYPES) expect(DOOR_TYPES).toContain(t);
  });

  it('isDoorType accepts the known door types and rejects everything else', () => {
    expect(isDoorType('mcp')).toBe(true);
    expect(isDoorType('mcp_chat')).toBe(true);
    expect(isDoorType('llm_gateway')).toBe(true);
    expect(isDoorType('reception')).toBe(true);
    expect(isDoorType('webhook')).toBe(true);
    // `chat` is a POLICY channel, not a door type — the §6 distinction.
    expect(isDoorType('chat')).toBe(false);
    // ⚠ `webhook` moved from this negative list to the positives above when
    // D-209 added it. A real non-member replaces it so the "rejects everything
    // else" half of this test's NAME keeps being asserted rather than assumed.
    expect(isDoorType('sms')).toBe(false);
    expect(isDoorType('')).toBe(false);
    expect(isDoorType(undefined)).toBe(false);
    expect(isDoorType(null)).toBe(false);
    expect(isDoorType(1)).toBe(false);
    expect(isDoorType(['mcp'])).toBe(false);
  });
});

describe('D-187 step 7 — contractPermitsDoorType (fail-safe matrix)', () => {
  it('absent door_types is a WILDCARD — permits any door type (behaviour-preserving)', () => {
    const def = baseDef();
    expect(contractPermitsDoorType(def, 'mcp')).toBe(true);
    expect(contractPermitsDoorType(def, 'mcp_chat')).toBe(true);
    expect(contractPermitsDoorType(def, 'llm_gateway')).toBe(true);
  });

  it('empty door_types is a WILDCARD — permits any door type', () => {
    const def = baseDef({ door_types: [] });
    expect(contractPermitsDoorType(def, 'mcp')).toBe(true);
    expect(contractPermitsDoorType(def, 'mcp_chat')).toBe(true);
    expect(contractPermitsDoorType(def, 'llm_gateway')).toBe(true);
  });

  it("['mcp'] permits the mcp door and ONLY the mcp door", () => {
    const def = baseDef({ door_types: ['mcp'] });
    expect(contractPermitsDoorType(def, 'mcp')).toBe(true);
    expect(contractPermitsDoorType(def, 'mcp_chat')).toBe(false);
    expect(contractPermitsDoorType(def, 'llm_gateway')).toBe(false);
  });

  it("['mcp_chat'] permits the mcp_chat door and ONLY the mcp_chat door", () => {
    const def = baseDef({ door_types: ['mcp_chat'] });
    expect(contractPermitsDoorType(def, 'mcp_chat')).toBe(true);
    expect(contractPermitsDoorType(def, 'mcp')).toBe(false);
    expect(contractPermitsDoorType(def, 'llm_gateway')).toBe(false);
  });

  it("['llm_gateway'] permits the llm_gateway door and ONLY that door", () => {
    const def = baseDef({ door_types: ['llm_gateway'] });
    expect(contractPermitsDoorType(def, 'llm_gateway')).toBe(true);
    expect(contractPermitsDoorType(def, 'mcp')).toBe(false);
    expect(contractPermitsDoorType(def, 'mcp_chat')).toBe(false);
  });

  it('a list naming every door type permits all of them', () => {
    const def = baseDef({ door_types: ['mcp', 'mcp_chat', 'llm_gateway'] });
    expect(contractPermitsDoorType(def, 'mcp')).toBe(true);
    expect(contractPermitsDoorType(def, 'mcp_chat')).toBe(true);
    expect(contractPermitsDoorType(def, 'llm_gateway')).toBe(true);
  });
});

describe('D-187 step 7 — contract_definition.door_types value_shape', () => {
  const writeIssueCodes = (value: unknown): string[] =>
    validateContractWrite(
      D165_CONTRACT_SCHEMA,
      CONTRACT_DEFINITION_SCOPE,
      ['ct_x'],
      value,
    ).map((issue) => issue.code);

  it('admits a row with a valid door_types array-of-enum', () => {
    expect(writeIssueCodes(baseDef({ door_types: ['mcp'] }))).toEqual([]);
    expect(writeIssueCodes(baseDef({ door_types: ['mcp', 'mcp_chat', 'llm_gateway'] }))).toEqual([]);
    expect(writeIssueCodes(baseDef({ door_types: [] }))).toEqual([]);
  });

  it('admits a row with door_types ABSENT (optional)', () => {
    expect(writeIssueCodes(baseDef())).toEqual([]);
  });

  it('rejects a door_types member outside the enum', () => {
    const issues = writeIssueCodes(baseDef({ door_types: ['chat'] as unknown as DoorType[] }));
    expect(issues.length).toBeGreaterThan(0);
  });

  it('rejects a non-array door_types', () => {
    const issues = writeIssueCodes(baseDef({ door_types: 'mcp' as unknown as DoorType[] }));
    expect(issues.length).toBeGreaterThan(0);
  });
});

// ── store + overlay (in-memory ContractStore) ──────────────────────

describe('D-187 step 7 — mint store threads door_types', () => {
  let db: Database.Database;
  let store: ContractStore;
  let defStore: ContractDefinitionStore;
  let idSeq: number;

  const mintInput = (overrides: Partial<MintContractInput> = {}): MintContractInput => ({
    minted_by: 'user:1',
    display_name: 'Door contract',
    scope: {},
    ...overrides,
  });

  beforeEach(() => {
    db = new Database(':memory:');
    idSeq = 0;
    store = createContractStore(db, { now: () => NOW });
    defStore = createContractDefinitionStore(store, {
      now: () => NOW,
      newId: () => `ct_${(idSeq += 1)}`,
    });
  });

  it('persists door_types when supplied and reads it back verbatim', () => {
    const def = defStore.mint(mintInput({ door_types: ['mcp'] }));
    expect(def.door_types).toEqual(['mcp']);
    expect(defStore.get(def.contract_id)?.door_types).toEqual(['mcp']);
  });

  it('omits the door_types key entirely when not supplied (sparse wildcard)', () => {
    const def = defStore.mint(mintInput());
    expect(def).not.toHaveProperty('door_types');
    const stored = store.get(CONTRACT_DEFINITION_SCOPE, [def.contract_id])
      ?.value as ContractDefinition;
    expect(stored).not.toHaveProperty('door_types');
  });

  it('rejects a mint whose door_types violates the enum value_shape', () => {
    expect(() =>
      defStore.mint(mintInput({ door_types: ['bogus'] as unknown as DoorType[] })),
    ).toThrow(ContractWriteInvalidError);
  });
});

describe('D-187 step 7 — overlay.permitsDoorType', () => {
  let db: Database.Database;
  let store: ContractStore;
  let defStore: ContractDefinitionStore;
  let resolver: ReturnType<typeof createContractOverlayResolver>;
  let idSeq: number;

  const mintInput = (overrides: Partial<MintContractInput> = {}): MintContractInput => ({
    minted_by: 'user:1',
    display_name: 'Door contract',
    scope: {},
    ...overrides,
  });

  beforeEach(() => {
    db = new Database(':memory:');
    idSeq = 0;
    store = createContractStore(db, { now: () => NOW });
    defStore = createContractDefinitionStore(store, {
      now: () => NOW,
      newId: () => `ct_${(idSeq += 1)}`,
    });
    resolver = createContractOverlayResolver({
      definitionStore: defStore,
      now: () => NOW,
    });
  });

  it('a contract restricted to mcp_chat does NOT permit the mcp door', () => {
    const def = defStore.mint(mintInput({ door_types: ['mcp_chat'] }));
    expect(resolver.permitsDoorType!(def.contract_id, 'mcp')).toBe(false);
    expect(resolver.permitsDoorType!(def.contract_id, 'mcp_chat')).toBe(true);
    expect(resolver.permitsDoorType!(def.contract_id, 'llm_gateway')).toBe(false);
  });

  it('a contract with no door_types is a wildcard — permits every door', () => {
    const def = defStore.mint(mintInput());
    expect(resolver.permitsDoorType!(def.contract_id, 'mcp')).toBe(true);
    expect(resolver.permitsDoorType!(def.contract_id, 'mcp_chat')).toBe(true);
    expect(resolver.permitsDoorType!(def.contract_id, 'llm_gateway')).toBe(true);
  });

  it('an id naming NO contract resolves true (defers to the liveness probe)', () => {
    expect(resolver.permitsDoorType!('ct_nonexistent', 'mcp')).toBe(true);
  });

  it('is liveness-INDEPENDENT — a revoked contract still reports its door_types', () => {
    const def = defStore.mint(mintInput({ door_types: ['mcp_chat'] }));
    defStore.revoke(def.contract_id, 'test');
    // permitsDoorType is a configuration gate, not a kill-switch: the transport
    // ANDs isContractLive separately, so the door-type answer stays stable across
    // revoke (a dead contract is denied by the liveness gate, not double-jeopardied
    // here). Still excludes mcp; still permits its own door type.
    expect(resolver.permitsDoorType!(def.contract_id, 'mcp')).toBe(false);
    expect(resolver.permitsDoorType!(def.contract_id, 'mcp_chat')).toBe(true);
  });
});

describe('D-187 step 7 follow-on — setDoorTypes store mutator', () => {
  let db: Database.Database;
  let store: ContractStore;
  let defStore: ContractDefinitionStore;
  let idSeq: number;

  const mintInput = (overrides: Partial<MintContractInput> = {}): MintContractInput => ({
    minted_by: 'user:1',
    display_name: 'Door contract',
    scope: {},
    ...overrides,
  });

  beforeEach(() => {
    db = new Database(':memory:');
    idSeq = 0;
    store = createContractStore(db, { now: () => NOW });
    defStore = createContractDefinitionStore(store, {
      now: () => NOW,
      newId: () => `ct_${(idSeq += 1)}`,
    });
  });

  it('sets door_types on a contract that had none (in place — same contract_id)', () => {
    const def = defStore.mint(mintInput());
    const updated = defStore.setDoorTypes(def.contract_id, ['mcp']);
    expect(updated?.contract_id).toBe(def.contract_id); // binding survives
    expect(updated?.door_types).toEqual(['mcp']);
    expect(defStore.get(def.contract_id)?.door_types).toEqual(['mcp']);
  });

  it('REPLACES an existing door_types list', () => {
    const def = defStore.mint(mintInput({ door_types: ['mcp'] }));
    const updated = defStore.setDoorTypes(def.contract_id, ['mcp_chat']);
    expect(updated?.door_types).toEqual(['mcp_chat']);
  });

  it('an EMPTY array CLEARS the restriction — drops the key (sparse wildcard)', () => {
    const def = defStore.mint(mintInput({ door_types: ['mcp'] }));
    const updated = defStore.setDoorTypes(def.contract_id, []);
    expect(updated).not.toHaveProperty('door_types');
    const stored = store.get(CONTRACT_DEFINITION_SCOPE, [def.contract_id])
      ?.value as ContractDefinition;
    expect(stored).not.toHaveProperty('door_types');
  });

  it('preserves every other field + the lifecycle (config edit is not a kill-switch)', () => {
    const def = defStore.mint(mintInput({ display_name: 'Keep me', max_uses: 5 }));
    const updated = defStore.setDoorTypes(def.contract_id, ['mcp']);
    expect(updated?.display_name).toBe('Keep me');
    expect(updated?.max_uses).toBe(5);
    expect(updated?.uses_remaining).toBe(5);
    expect(updated?.revoked_at).toBeUndefined();
  });

  it('returns null for a missing contract_id', () => {
    expect(defStore.setDoorTypes('ct_nonexistent', ['mcp'])).toBeNull();
  });

  it('REFUSES a gate-consumed session grant on the human-authored door mutator', () => {
    const grant = defStore.mintSessionGrant({
      minted_by: 'owner',
      display_name: 'Session grant',
      scope: { ingredient_ids: ['mail-send'] },
      channel_session_id: 'cs_1',
      bound_recipe: { recipe_id: 'r1', recipe_hash: 'h1' },
      arg_shape_hash: 'ash',
      risk_tier: 'write',
      canonical_payload_hash: 'cph',
      expiry_at: NOW + 60_000,
      max_uses: 3,
    });
    expect(defStore.setDoorTypes(grant.contract_id, ['mcp'])).toBeNull();
    // The grant row is untouched — no door_types stamped onto it.
    expect(defStore.get(grant.contract_id)).not.toHaveProperty('door_types');
  });

  it('D-196: edits customer templates but refuses server-owned customer instances', () => {
    const template = defStore.mint(mintInput({
      display_name: 'customer_template',
      grant_kind: 'customer_template',
    }));
    expect(defStore.setDoorTypes(template.contract_id, ['mcp'])).toEqual(
      expect.objectContaining({
        contract_id: template.contract_id,
        grant_kind: 'customer_template',
        door_types: ['mcp'],
      }),
    );

    const instance = defStore.mint(mintInput({ display_name: 'customer_instance' }));
    store.put(CONTRACT_DEFINITION_SCOPE, [instance.contract_id], {
      ...instance,
      grant_kind: 'customer_instance',
    });
    expect(defStore.setDoorTypes(instance.contract_id, ['mcp'])).toBeNull();
    expect(defStore.get(instance.contract_id)).not.toHaveProperty('door_types');
  });

  it('rejects an out-of-enum door type at the value_shape gate (write-path guard)', () => {
    const def = defStore.mint(mintInput());
    expect(() =>
      defStore.setDoorTypes(def.contract_id, ['bogus'] as unknown as DoorType[]),
    ).toThrow(ContractWriteInvalidError);
  });
});
