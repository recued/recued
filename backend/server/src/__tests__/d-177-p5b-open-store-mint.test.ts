/** D-177 P5b open session-grant store and resolver tests. */

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import {
  D165_CONTRACT_SCHEMA,
  type ContractDefinition,
  type ContractScope,
  type OpenProjection,
  type SessionGrantMintContext,
} from '@recued/contracts';

import { createSessionGrantResolver } from '../session-grant-resolver.js';
import { createContractStore } from '../storage/contract-store.js';
import {
  SessionGrantMintError,
  createContractDefinitionStore,
  type ContractDefinitionStore,
  type MintSessionGrantInput,
} from '../storage/contract-definition-store.js';

const NOW = 1_700_200_000_000;

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

const openGrantInput = (
  overrides: Partial<MintSessionGrantInput> = {},
): MintSessionGrantInput => ({
  minted_by: 'user:1',
  display_name: 'Open session grant',
  scope: fullScope(),
  channel_session_id: 's',
  grant_mode: 'open',
  bound_recipe: {
    recipe_id: 'recipe-1',
    recipe_hash: 'recipe-hash-1',
  },
  arg_shape_hash: 'arg-shape-hash',
  risk_tier: 'write',
  canonical_payload_hash: 'payload-hash',
  pinned_projection_hash: 'projection-hash',
  open_projection: openProjection(),
  approved_action_ref: 'checkpoint-1',
  expiry_at: NOW + 60_000,
  max_uses: 3,
  ...overrides,
});

const malformedOpenGrantInput = (
  mutate: (value: Record<string, unknown>) => void,
): MintSessionGrantInput => {
  const value = openGrantInput() as unknown as Record<string, unknown>;
  mutate(value);
  return value as unknown as MintSessionGrantInput;
};

const mintCtx = (
  overrides: Partial<SessionGrantMintContext> = {},
): SessionGrantMintContext => ({
  channel: 'chat',
  actor: 'user_self',
  channel_session_id: 's',
  ingredient_slug: 'mail.send',
  operation_id: 'mail.send',
  connection_name: 'gmail-primary',
  recipe_id: 'recipe-1',
  recipe_hash: 'recipe-hash-1',
  risk_tier: 'write',
  arg_shape_hash: 'arg-shape-hash',
  canonical_payload_hash: 'payload-hash',
  open_pinned_projection_hash: 'projection-hash',
  ttl_ms: 3_600_000,
  max_uses: 5,
  approved_action_ref: 'run-1',
  grant_mode: 'open',
  pinned_projection_hash: 'projection-hash',
  open_projection: openProjection(),
  ...overrides,
});

describe('ContractDefinitionStore D-177 P5b open consumption', () => {
  it('consumes only when the fire pinned_projection_hash matches the open row', () => {
    const h = definitionHarness();
    try {
      const grant = h.defStore.mintSessionGrant(openGrantInput());

      expect(h.defStore.consumeSessionGrant(grant.contract_id, {
        pinned_projection_hash: 'projection-hash',
      })).toBe(true);
      expect(h.read(grant.contract_id).uses_remaining).toBe(2);

      expect(h.defStore.consumeSessionGrant(grant.contract_id, {
        pinned_projection_hash: 'other-projection-hash',
      })).toBe(false);
      expect(h.read(grant.contract_id).uses_remaining).toBe(2);

      expect(h.defStore.consumeSessionGrant(grant.contract_id)).toBe(false);
      expect(h.read(grant.contract_id).uses_remaining).toBe(2);
    } finally {
      h.db.close();
    }
  });

  it('throws SessionGrantMintError for open mints missing projection fields', () => {
    const h = definitionHarness();
    try {
      expect(() =>
        h.defStore.mintSessionGrant(
          malformedOpenGrantInput((value) => {
            delete value.pinned_projection_hash;
          }),
        ),
      ).toThrow(SessionGrantMintError);

      expect(() =>
        h.defStore.mintSessionGrant(
          malformedOpenGrantInput((value) => {
            delete value.open_projection;
          }),
        ),
      ).toThrow(SessionGrantMintError);
    } finally {
      h.db.close();
    }
  });
});

describe('createSessionGrantResolver D-177 P5b open mint', () => {
  it('mints an open row and dedupes an identical approval plus projection hash', () => {
    const h = definitionHarness();
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const resolver = createSessionGrantResolver({
        definitionStore: h.defStore,
        now: () => NOW,
      });

      resolver.mint(mintCtx());

      const rows = h.defStore.listSessionGrants('s');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(expect.objectContaining({
        contract_id: 'ct_1',
        minted_at: NOW,
        minted_by: 'owner',
        grant_kind: 'session',
        grant_mode: 'open',
        channel_session_id: 's',
        bound_recipe: { recipe_id: 'recipe-1', recipe_hash: 'recipe-hash-1' },
        risk_tier: 'write',
        arg_shape_hash: 'arg-shape-hash',
        canonical_payload_hash: 'payload-hash',
        pinned_projection_hash: 'projection-hash',
        open_projection: openProjection(),
        expiry_at: NOW + 3_600_000,
        max_uses: 5,
        uses_remaining: 5,
        approved_action_ref: 'run-1',
      } satisfies Partial<ContractDefinition>));

      resolver.mint(mintCtx());

      expect(h.defStore.listSessionGrants('s')).toHaveLength(1);
      expect(infoSpy).toHaveBeenCalled();
    } finally {
      infoSpy.mockRestore();
      h.db.close();
    }
  });
});
