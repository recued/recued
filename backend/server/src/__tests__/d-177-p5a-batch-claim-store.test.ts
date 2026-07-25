/** D-177 P5a — ContractDefinitionStore batch member claims (N.10/N.4).
 *
 *  The store-level half of the batch-claim substrate: hash-verified
 *  `claimBatchMember` (codex HIGH fold — a drifted resume never spends a
 *  member) and the `consumeSessionGrant` batch arm (claim-one-by-hash;
 *  the claim IS the consumption). Relocated from the gateway test file —
 *  `packages/` MUST NOT import `backend/` (public-boundary rule), even
 *  in tests. */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { D165_CONTRACT_SCHEMA } from '@recued/contracts';
import type { ContractDefinition, ContractScope } from '@recued/contracts';

import { createContractStore } from '../storage/contract-store.js';
import {
  createContractDefinitionStore,
  type ContractDefinitionStore,
  type MintSessionGrantInput,
} from '../storage/contract-definition-store.js';

const NOW = 1_700_100_000_000;
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

const definitionHarness = (): {
  db: Database.Database;
  defStore: ContractDefinitionStore;
  read: (contract_id: string) => ContractDefinition;
} => {
  const db = new Database(':memory:');
  const contractStore = createContractStore(db, { now: () => NOW });
  contractStore.seedSchema(D165_CONTRACT_SCHEMA);
  let idSeq = 0;
  const defStore = createContractDefinitionStore(contractStore, {
    now: () => NOW,
    newId: () => {
      idSeq += 1;
      return `ct_${idSeq}`;
    },
  });
  return {
    db,
    defStore,
    read: (contract_id: string): ContractDefinition => {
      const row = defStore.get(contract_id);
      expect(row).not.toBeNull();
      return row!;
    },
  };
};

const batchGrantInput = (
  overrides: Partial<MintSessionGrantInput> = {},
): MintSessionGrantInput => ({
  minted_by: 'user:1',
  display_name: 'Batch approval',
  scope: fullScope(),
  channel_session_id: 's',
  grant_mode: 'batch',
  bound_recipe: {
    recipe_id: 'recipe-1',
    recipe_hash: 'recipe-hash-1',
  },
  arg_shape_hash: 'arg-shape-hash',
  risk_tier: 'write',
  batch_members: [
    { member_id: 'm1', canonical_payload_hash: 'payload-1' },
    { member_id: 'm2', canonical_payload_hash: 'payload-2' },
  ],
  approved_action_ref: 'batch-1',
  expiry_at: NOW + 60_000,
  max_uses: 2,
  ...overrides,
});

// ── N.14.6 — the door binding on the CLAIM, the other spend path ──
//
// `consumeSessionGrant` re-verifies `bound_contract_id` "so a resolver bug can
// never burn a door grant's use on another door's dispatch". The claim burns a
// member AND decrements the same budget, so it needs the same rule — without it
// the invariant held on one spend path and said nothing on the other.
//
// ⚠ This is defense in depth, not a live exploit: upstream,
// `approval-resume-authority` already denies a resume whose bearer rebound
// (`bearer_binding_changed`). That fence lives in the mcp / llm_gateway resume
// authority; this one is the store's own, so the invariant does not depend on a
// distant caller getting it right.
describe('ContractDefinitionStore N.14.6 — the door binding on a batch claim', () => {
  const DOOR = 'ct_door_batch';
  const doorBatchInput = (): MintSessionGrantInput => batchGrantInput({
    scope: { ...fullScope(), channels: ['reception'], actors: ['anonymous'] },
    bound_contract_id: DOOR,
  });

  it('claims when the dispatch supplies the row\'s own door id', () => {
    const h = definitionHarness();
    try {
      const grant = h.defStore.mintSessionGrant(doorBatchInput());
      expect(h.defStore.claimBatchMember(grant.contract_id, 'm1', {
        arg_shape_hash: 'arg-shape-hash',
        canonical_payload_hash: 'payload-1',
      source_contract_id: DOOR,
      })).toBe(true);
      expect(h.read(grant.contract_id).uses_remaining).toBe(1);
    } finally {
      h.db.close();
    }
  });

  it('THE FENCE — never burns a member for another door, or for no door at all', () => {
    const h = definitionHarness();
    try {
      const grant = h.defStore.mintSessionGrant(doorBatchInput());
      // Another door's dispatch.
      expect(h.defStore.claimBatchMember(grant.contract_id, 'm1', {
        arg_shape_hash: 'arg-shape-hash',
        canonical_payload_hash: 'payload-1',
        source_contract_id: 'ct_door_other',
      })).toBe(false);
      // A dispatch supplying no door id at all (the owner, or a caller that
      // forgot to thread it) — fail closed, exactly as consume does.
      expect(h.defStore.claimBatchMember(grant.contract_id, 'm1', {
        arg_shape_hash: 'arg-shape-hash',
        canonical_payload_hash: 'payload-1',
      })).toBe(false);
      // No use spent, no member burned by either refusal.
      expect(h.read(grant.contract_id).uses_remaining).toBe(2);
      expect(h.read(grant.contract_id).batch_members?.[0]).not.toHaveProperty(
        'consumed_at',
      );
    } finally {
      h.db.close();
    }
  });

  it('REGRESSION PIN — an UNBOUND batch row still claims without a door id', () => {
    // The owner's own batches are unbound and must keep working; the clause is
    // keyed on the ROW carrying a binding, never on the call carrying an id.
    const h = definitionHarness();
    try {
      const grant = h.defStore.mintSessionGrant(batchGrantInput());
      expect(h.defStore.claimBatchMember(grant.contract_id, 'm1', {
        arg_shape_hash: 'arg-shape-hash',
        canonical_payload_hash: 'payload-1',
      })).toBe(true);
      expect(h.read(grant.contract_id).uses_remaining).toBe(1);
    } finally {
      h.db.close();
    }
  });
});

describe('ContractDefinitionStore D-177 P5a batch member claims', () => {
  it('refuses claimBatchMember with the wrong arg_shape_hash', () => {
    const h = definitionHarness();
    try {
      const grant = h.defStore.mintSessionGrant(batchGrantInput());

      expect(h.defStore.claimBatchMember(grant.contract_id, 'm1', {
        arg_shape_hash: 'other-shape',
        canonical_payload_hash: 'payload-1',
      })).toBe(false);

      expect(h.read(grant.contract_id).uses_remaining).toBe(2);
      expect(h.read(grant.contract_id).batch_members?.[0]).not.toHaveProperty(
        'consumed_at',
      );
    } finally {
      h.db.close();
    }
  });

  it('refuses claimBatchMember with the wrong member payload hash', () => {
    const h = definitionHarness();
    try {
      const grant = h.defStore.mintSessionGrant(batchGrantInput());

      expect(h.defStore.claimBatchMember(grant.contract_id, 'm1', {
        arg_shape_hash: 'arg-shape-hash',
        canonical_payload_hash: 'other-payload',
      })).toBe(false);

      expect(h.read(grant.contract_id).uses_remaining).toBe(2);
      expect(h.read(grant.contract_id).batch_members?.[0]).not.toHaveProperty(
        'consumed_at',
      );
    } finally {
      h.db.close();
    }
  });

  it('refuses claimBatchMember when the member was already consumed', () => {
    const h = definitionHarness();
    try {
      const grant = h.defStore.mintSessionGrant(batchGrantInput());
      expect(h.defStore.claimBatchMember(grant.contract_id, 'm1', {
        arg_shape_hash: 'arg-shape-hash',
        canonical_payload_hash: 'payload-1',
      })).toBe(true);

      expect(h.defStore.claimBatchMember(grant.contract_id, 'm1', {
        arg_shape_hash: 'arg-shape-hash',
        canonical_payload_hash: 'payload-1',
      })).toBe(false);

      expect(h.read(grant.contract_id).uses_remaining).toBe(1);
    } finally {
      h.db.close();
    }
  });

  it('successfully claims one member, stamps consumed_at, and decrements uses_remaining', () => {
    const h = definitionHarness();
    try {
      const grant = h.defStore.mintSessionGrant(batchGrantInput());

      expect(h.defStore.claimBatchMember(grant.contract_id, 'm2', {
        arg_shape_hash: 'arg-shape-hash',
        canonical_payload_hash: 'payload-2',
      })).toBe(true);

      expect(h.read(grant.contract_id)).toMatchObject({
        uses_remaining: 1,
        batch_members: [
          { member_id: 'm1', canonical_payload_hash: 'payload-1' },
          {
            member_id: 'm2',
            canonical_payload_hash: 'payload-2',
            consumed_at: NOW,
          },
        ],
      });
    } finally {
      h.db.close();
    }
  });

  it('consumeSessionGrant on a batch row claims one duplicate-hash member per call', () => {
    const h = definitionHarness();
    try {
      const grant = h.defStore.mintSessionGrant(batchGrantInput({
        batch_members: [
          { member_id: 'm1', canonical_payload_hash: 'payload-dup' },
          { member_id: 'm2', canonical_payload_hash: 'payload-dup' },
        ],
      }));

      expect(h.defStore.consumeSessionGrant(grant.contract_id, {
        canonical_payload_hash: 'payload-dup',
      })).toBe(true);
      expect(
        h.read(grant.contract_id).batch_members?.filter((m) => m.consumed_at !== undefined),
      ).toHaveLength(1);
      expect(h.defStore.consumeSessionGrant(grant.contract_id, {
        canonical_payload_hash: 'payload-dup',
      })).toBe(true);
      expect(h.defStore.consumeSessionGrant(grant.contract_id, {
        canonical_payload_hash: 'payload-dup',
      })).toBe(false);

      expect(h.read(grant.contract_id)).toMatchObject({ uses_remaining: 0 });
      expect(
        h.read(grant.contract_id).batch_members?.filter((m) => m.consumed_at === NOW),
      ).toHaveLength(2);
    } finally {
      h.db.close();
    }
  });

  it('refuses consumeSessionGrant on a batch row when canonical_payload_hash is absent', () => {
    const h = definitionHarness();
    try {
      const grant = h.defStore.mintSessionGrant(batchGrantInput());

      expect(h.defStore.consumeSessionGrant(grant.contract_id)).toBe(false);

      expect(h.read(grant.contract_id).uses_remaining).toBe(2);
      expect(h.read(grant.contract_id).batch_members?.some((m) => m.consumed_at !== undefined))
        .toBe(false);
    } finally {
      h.db.close();
    }
  });

  it('refuses consumeSessionGrant on open-mode rows', () => {
    const h = definitionHarness();
    try {
      const grant = h.defStore.mintSessionGrant(batchGrantInput({
        grant_mode: 'open',
        batch_members: undefined,
        pinned_projection_hash: 'projection-hash',
        open_projection: { roots: [] },
        max_uses: 3,
      }));

      expect(h.defStore.consumeSessionGrant(grant.contract_id, {
        canonical_payload_hash: 'payload-1',
      })).toBe(false);

      expect(h.read(grant.contract_id)).toMatchObject({ uses_remaining: 3 });
    } finally {
      h.db.close();
    }
  });
});

