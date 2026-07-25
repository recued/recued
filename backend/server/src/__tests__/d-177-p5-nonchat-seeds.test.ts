/** D-177 P5 / D-187: non-chat session-grant seed coverage.
 *
 *  D-187 slice 6 retired the policy-matrix substrate — the put-path floor guard,
 *  the BASELINE seed rows, and `seedPolicyMatrixBaseline` are gone. The offer now
 *  resolves from the in-code SESSION_GRANT_DEFAULT_SEEDS directly; the mint→match
 *  round trip (over the contract-definition store) is unchanged. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  STDIO_MCP_TOKEN_ID,
  D165_CONTRACT_SCHEMA,
  MCP_SESSION_GRANT_DEFAULTS,
  MESSENGER_SESSION_GRANT_DEFAULTS,
  resolveSessionGrantOffer,
  type Actor,
  type Channel,
  type SessionGrantDefaults,
  type SessionGrantMatchContext,
  type SessionGrantMintContext,
} from '@recued/contracts';

import { createSessionGrantResolver } from '../session-grant-resolver.js';
import {
  createContractDefinitionStore,
  type ContractDefinitionStore,
} from '../storage/contract-definition-store.js';
import {
  createContractStore,
  type ContractStore,
} from '../storage/contract-store.js';

const NOW = 1_700_000_000_000;

interface SeededCellCase {
  readonly name: string;
  readonly channel: Channel;
  readonly actor: Actor;
  readonly seedDefaults: SessionGrantDefaults;
}

const SEEDED_CELLS: ReadonlyArray<SeededCellCase> = [
  {
    name: 'messenger:user_self',
    channel: 'messenger',
    actor: 'user_self',
    seedDefaults: MESSENGER_SESSION_GRANT_DEFAULTS,
  },
  {
    name: 'mcp:contracted_user',
    channel: 'mcp',
    actor: 'contracted_user',
    seedDefaults: MCP_SESSION_GRANT_DEFAULTS,
  },
];

let db: Database.Database;
let store: ContractStore;
let definitionStore: ContractDefinitionStore;
let nowMs: number;
let idSeq: number;

const makeSeqId = (): string => {
  idSeq += 1;
  return `ct_${idSeq}`;
};

beforeEach(() => {
  db = new Database(':memory:');
  nowMs = NOW;
  idSeq = 0;
  store = createContractStore(db, { now: () => nowMs });
  store.seedSchema(D165_CONTRACT_SCHEMA);
  definitionStore = createContractDefinitionStore(store, {
    now: () => nowMs,
    newId: makeSeqId,
  });
});

afterEach(() => {
  db.close();
});

const mintContext = (
  overrides: Partial<SessionGrantMintContext> = {},
): SessionGrantMintContext => ({
  channel: 'messenger',
  actor: 'user_self',
  channel_session_id: 'session-messenger',
  ingredient_slug: 'mail.send',
  operation_id: 'mail.send',
  connection_name: 'gmail-primary',
  recipe_id: 'recipe-1',
  recipe_hash: 'recipe-hash-1',
  risk_tier: 'write',
  pre_lift_approval: 'ask',
  arg_shape_hash: 'arg-shape-hash',
  canonical_payload_hash: 'payload-hash',
  ttl_ms: 60_000,
  max_uses: 2,
  approved_action_ref: 'run-1',
  ...overrides,
});

describe('resolveSessionGrantOffer over the in-code non-chat seeds', () => {
  // D-187 slice 6 — the policy-matrix override row was retired; the offer now
  // resolves from the in-code SESSION_GRANT_DEFAULT_SEEDS directly (a store row
  // no longer tunes it — the runtime-tightened / runtime-removed cases the
  // matrix once supported are gone with the substrate).
  it.each(SEEDED_CELLS)(
    'offers seeded read, write, and admin bounds for $name',
    ({ channel, actor, seedDefaults }) => {
      for (const risk_tier of ['read', 'write', 'admin'] as const) {
        expect(
          resolveSessionGrantOffer({
            channel,
            actor,
            risk_tier,
            pre_lift_approval: 'ask',
          }),
        ).toEqual({
          ttl_ms: seedDefaults.ttl_ms,
          max_uses: seedDefaults.max_uses,
          risk_tier,
        });
      }
    },
  );
});

describe('createSessionGrantResolver non-chat mint to match round trip', () => {
  it.each([
    {
      name: 'messenger:user_self',
      ctx: mintContext(),
    },
    {
      // N.14.6 — the `(mcp, contracted_user)` cell serves BOTH the owner's own
      // local client and every delegated door, and only `mcp_token_id` tells them
      // apart. Both round-trips are pinned: the owner mints UNBOUND and rides it,
      // the door mints BOUND to its contract. A fixture that named neither was
      // modelling a door riding an unbound row — the defect N.14.6 closes.
      name: 'mcp:contracted_user (the owner\'s own stdio client)',
      ctx: mintContext({
        channel: 'mcp',
        actor: 'contracted_user',
        channel_session_id: `mcp:${STDIO_MCP_TOKEN_ID}`,
        mcp_token_id: STDIO_MCP_TOKEN_ID,
        ingredient_slug: 'crm.update',
        operation_id: 'crm.update',
        connection_name: 'salesforce-primary',
        approved_action_ref: 'run-mcp',
      }),
    },
    {
      name: 'mcp:contracted_user (a delegated door)',
      ctx: mintContext({
        channel: 'mcp',
        actor: 'contracted_user',
        channel_session_id: 'mcp:http_door_token',
        mcp_token_id: 'http_door_token',
        source_contract_id: 'ct_door_mcp',
        ingredient_slug: 'crm.update',
        operation_id: 'crm.update',
        connection_name: 'salesforce-primary',
        approved_action_ref: 'run-mcp-door',
      }),
    },
  ])('mints and matches only the same channel session for $name', ({ ctx }) => {
    const resolver = createSessionGrantResolver({
      definitionStore,
      now: () => nowMs,
    });

    resolver.mint(ctx);

    const grants = definitionStore.listSessionGrants(ctx.channel_session_id);
    expect(grants).toHaveLength(1);
    const contractId = grants[0].contract_id;

    expect(resolver.match(ctx)).toBe(contractId);
    expect(
      resolver.match({ ...ctx, channel: 'chat' } as SessionGrantMatchContext),
    ).toBeNull();
    expect(
      resolver.match({
        ...ctx,
        channel_session_id: 'different-session',
      } as SessionGrantMatchContext),
    ).toBeNull();
  });
});
