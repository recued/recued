/** D-207 slice 1c — MINT THE DOOR THROUGH THE REAL, SCHEMA-VALIDATED STORE.
 *
 *  ## Why this file has to exist
 *
 *  Every other door test in this decision — slice 1b's mint/bind tests and slice 1c's
 *  composition tests, mine included — FAKES `ContractDefinitionStore` with an in-memory Map.
 *  That was reasonable for testing bind logic, and it hid a bug that made the entire feature
 *  inert on a real server:
 *
 *    `DOOR_TYPES`  (TS const)   = ['mcp', 'mcp_chat', 'llm_gateway', 'reception']
 *    `door_types`  (value_shape) = 'enum:mcp|mcp_chat|llm_gateway[]?'      ← no 'reception'
 *
 *  Slice 1b widened the const and never widened the SCHEMA. `ContractDefinitionStore.mint()`
 *  writes through `ContractStore.put`, which validates every row against the
 *  `contract_definition` value_shape and THROWS `ContractWriteInvalidError` on a mismatch —
 *  so minting a reception door **threw on the first real bind**, and no fake store could
 *  ever have said so.
 *
 *  This is why the rule is *test the gate through the REAL gate, mock only the IO*. The
 *  schema IS the gate here. So this file mints against a real SQLite-backed `ContractStore`
 *  with the real seeded schema, and asserts the row that comes back out.
 *
 *  ## `door_types: ['reception']` is LOAD-BEARING, not a label
 *
 *  It is what makes `usesExplicitOnlyGrantDefaults` true, which is what makes a reception
 *  door DENY-BY-DEFAULT. If the schema had silently DROPPED the field instead of rejecting
 *  the write, the door would have come back as a WILDCARD — and a pure-transform recipe (an
 *  empty op closure) would have been admitted ANY op. Rejecting was the lucky failure mode;
 *  the assertions below pin the field's presence, not just the absence of a throw.
 *
 *  Spec: D-207 §5.1. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DOOR_TYPES, contractPermitsDoorType } from '@recued/contracts';

import { mintDoorContract } from '../mint-door-contract.js';
import {
  createContractStore,
  type ContractStore,
} from '../storage/contract-store.js';
import {
  createContractDefinitionStore,
  type ContractDefinitionStore,
} from '../storage/contract-definition-store.js';
import {
  createContractGrantEntryStore,
  type ContractGrantEntryStore,
} from '../storage/contract-grant-entry-store.js';

const NOW = 1_700_000_000_000;

let db: Database.Database;
let contractStore: ContractStore;
let definitionStore: ContractDefinitionStore;
let grantEntryStore: ContractGrantEntryStore;

beforeEach(() => {
  db = new Database(':memory:');
  // The REAL store, with the REAL seeded `contract_definition` value_shape. This is the
  // gate; faking it is what let the bug through.
  contractStore = createContractStore(db, { now: () => NOW });
  definitionStore = createContractDefinitionStore(contractStore);
  grantEntryStore = createContractGrantEntryStore(contractStore);
});

afterEach(() => {
  db.close();
});

const mint = () =>
  mintDoorContract(
    {
      door: 'reception',
      recipeId: 'lead-capture-to-crm',
      capability: {
        operation_ids: ['core.crm.contact.create'],
        ingredient_ids: ['crm-writer'],
        connection_names: [],
        operation_steps: { 'core.crm.contact.create': 's1' },
        pack_bound_connection_ops: [],
      },
      mintedBy: 'paired-owner-client',
    },
    { definitionStore, grantEntryStore, now: () => NOW },
  );

describe('D-207 slice 1c — the door mints through the REAL schema-validated store', () => {
  it('MINTS — the write is not rejected by the contract_definition value_shape', () => {
    // Before the schema fix this THREW `ContractWriteInvalidError`: `door_types` was
    // `enum:mcp|mcp_chat|llm_gateway[]?` and the mint writes `['reception']`. Every bind on
    // every real server died here, and every fake-store test stayed green.
    expect(() => mint()).not.toThrow();
  });

  it('the stored row actually CARRIES door_types: ["reception"] — not silently dropped', () => {
    const { contract_id } = mint();
    const stored = definitionStore.get(contract_id);

    expect(stored).not.toBeNull();
    // Pin the FIELD, not merely the absence of a throw. A schema that dropped the unknown
    // member instead of rejecting it would leave `door_types` absent — which reads as a
    // WILDCARD door, which is PERMISSIVE. That failure would have been silent and worse.
    expect(stored?.door_types).toEqual(['reception']);
  });

  it('and it is a RECEPTION door: it backs reception and NOTHING else', () => {
    const { contract_id } = mint();
    const stored = definitionStore.get(contract_id);
    if (!stored) throw new Error('door was not minted');

    expect(contractPermitsDoorType(stored, 'reception')).toBe(true);
    // A non-empty `door_types` is a RESTRICTION. If the field had been dropped, every one of
    // these would flip to `true` (wildcard) — the door would back the owner's MCP surfaces.
    for (const other of DOOR_TYPES.filter((t) => t !== 'reception')) {
      expect(contractPermitsDoorType(stored, other)).toBe(false);
    }
  });

  it('the grant rows land in the same store the Gateway reads them from', () => {
    const { contract_id } = mint();
    // The ACCESS axis. An op outside this list is a HARD DENY at fire, so the mint writing
    // it and the gate reading it must be the same substrate — not two Maps that agree.
    expect(grantEntryStore.get(contract_id, 'core.crm.contact.create')).toBe(true);
    expect(grantEntryStore.get(contract_id, 'core.mail.send')).toBeUndefined();
  });

  it('a reception door NEVER carries the trust ceiling — omission is the first fence', () => {
    const { contract_id } = mint();
    // The reader (`resolveTrustCeiling`) pins anonymous reception at `read`
    // regardless; this pins the OTHER fence — the mint not authoring one.
    expect(definitionStore.get(contract_id)?.max_risk_without_approval).toBeUndefined();
  });
});

const mintWebhook = () =>
  mintDoorContract(
    {
      door: 'webhook',
      recipeId: 'observe-provider-payment-event',
      capability: {
        operation_ids: ['core.seller.order.confirm-payment'],
        ingredient_ids: ['stripe-catalog'],
        connection_names: ['stripe-primary'],
        operation_steps: { 'core.seller.order.confirm-payment': 's1' },
        pack_bound_connection_ops: [],
      },
      mintedBy: 'enrollment-owner-client',
    },
    { definitionStore, grantEntryStore, now: () => NOW },
  );

describe('D-209 #1 — the WEBHOOK door mints through the REAL schema-validated store', () => {
  it('MINTS — door_types ["webhook"] + the authored ceiling pass the value_shape', () => {
    // The exact failure class the reception door hit: a const widened without the
    // schema. `webhook` joined DOOR_TYPES and `max_risk_without_approval` joined the
    // contract_definition value_shape in the same slice — this is the proof.
    expect(() => mintWebhook()).not.toThrow();
  });

  it('the stored row carries the door type AND the authored `admin` ceiling', () => {
    const { contract_id } = mintWebhook();
    const stored = definitionStore.get(contract_id);

    expect(stored).not.toBeNull();
    expect(stored?.door_types).toEqual(['webhook']);
    // D-209 §1.4 — the two-sided enrollment IS the standing approval; a schema
    // that silently DROPPED the field would leave the door at the LOW default
    // and every webhook write would hold — fail-closed but broken.
    expect(stored?.max_risk_without_approval).toBe('admin');
    expect(stored?.scope.channels).toEqual(['webhook']);
    expect(stored?.scope.actors).toEqual(['anonymous']);
  });

  it('it is a WEBHOOK door: it backs webhook and NOTHING else', () => {
    const { contract_id } = mintWebhook();
    const stored = definitionStore.get(contract_id);
    if (!stored) throw new Error('door was not minted');

    expect(contractPermitsDoorType(stored, 'webhook')).toBe(true);
    for (const other of DOOR_TYPES.filter((t) => t !== 'webhook')) {
      expect(contractPermitsDoorType(stored, other)).toBe(false);
    }
  });

  it('its grant rows land beside the reception door\'s, in the store the Gateway reads', () => {
    const { contract_id } = mintWebhook();
    expect(grantEntryStore.get(contract_id, 'core.seller.order.confirm-payment')).toBe(true);
    expect(grantEntryStore.get(contract_id, 'core.mail.send')).toBeUndefined();
  });
});
