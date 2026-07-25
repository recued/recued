/** D-186 — the messenger "Active passes" seam factory (`composeSessionGrantPasses`).
 *
 *  Pins the seam over a REAL contract store (the part the composer-level mocks
 *  in `d-186-messenger-passes-live-control.test.ts` can't reach): `list`
 *  projects active session grants, `revoke` early-expires + fans the
 *  `contract.contract_definition_changed` broadcast (parity with the
 *  `session_grant.revoke` rpc), fail-closes on absent / non-session rows, and
 *  the broadcast is best-effort (a bus throw never escapes the revoke).
 *
 *  Store harness mirrors `d-186-slice-c-session-grant-control.test.ts`. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { D165_CONTRACT_SCHEMA, type ContractScope } from '@recued/contracts';

import { createContractStore, type ContractStore } from '../storage/contract-store.js';
import {
  createContractDefinitionStore,
  type ContractDefinitionStore,
  type MintContractInput,
  type MintSessionGrantInput,
} from '../storage/contract-definition-store.js';
import { composeSessionGrantPasses } from '../composition/bin/wire-session-grant-passes.js';

const NOW = 1_700_000_000_000;

let db: Database.Database;
let store: ContractStore;
let defStore: ContractDefinitionStore;
let idSeq: number;

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

const mintInput = (overrides: Partial<MintContractInput> = {}): MintContractInput => ({
  minted_by: 'user:1',
  display_name: 'Standing approval',
  scope: { channels: ['chat'], actors: ['user_self'] },
  ...overrides,
});

const seam = (): {
  passes: ReturnType<typeof composeSessionGrantPasses>;
  broadcast: ReturnType<typeof vi.fn>;
} => {
  const broadcast = vi.fn();
  const passes = composeSessionGrantPasses({ contractStore: store, broadcast, now: () => NOW });
  return { passes, broadcast };
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

describe('D-186 — composeSessionGrantPasses', () => {
  it('lists active session grants as views', () => {
    const grant = defStore.mintSessionGrant(mintSessionInput());
    const { passes } = seam();

    const views = passes.list();

    expect(views).toHaveLength(1);
    expect(views[0]!.contract_id).toBe(grant.contract_id);
    expect(views[0]!.lifecycle_state).toBe('active');
    expect(views[0]!.permits.operation_ids).toEqual(['mail.send']);
  });

  it('revokes a grant, returns the revoked view, and fans the contract-changed broadcast', () => {
    const grant = defStore.mintSessionGrant(mintSessionInput());
    const { passes, broadcast } = seam();

    const view = passes.revoke(grant.contract_id);

    expect(view).not.toBeNull();
    expect(view!.lifecycle_state).toBe('revoked');
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith({
      kind: 'contract.contract_definition_changed',
      op: 'revoke',
      contract_id: grant.contract_id,
    });
    // Persisted — a re-list drops it (active-only).
    expect(passes.list()).toHaveLength(0);
  });

  it('returns null and does NOT broadcast for an absent id', () => {
    const { passes, broadcast } = seam();

    expect(passes.revoke('ct_missing')).toBeNull();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('fail-closed: refuses a standing contract (not a session grant), no broadcast', () => {
    const standing = defStore.mint(mintInput());
    const { passes, broadcast } = seam();

    expect(passes.revoke(standing.contract_id)).toBeNull();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('revokes without a broadcast seam wired (no throw)', () => {
    const grant = defStore.mintSessionGrant(mintSessionInput());
    const passes = composeSessionGrantPasses({ contractStore: store, now: () => NOW });

    const view = passes.revoke(grant.contract_id);

    expect(view).not.toBeNull();
    expect(view!.lifecycle_state).toBe('revoked');
  });

  it('swallows a throwing broadcast — the revoke still succeeds', () => {
    const grant = defStore.mintSessionGrant(mintSessionInput());
    const broadcast = vi.fn(() => {
      throw new Error('bus down');
    });
    const passes = composeSessionGrantPasses({ contractStore: store, broadcast, now: () => NOW });

    const view = passes.revoke(grant.contract_id);

    expect(view).not.toBeNull();
    expect(broadcast).toHaveBeenCalledTimes(1);
  });
});
