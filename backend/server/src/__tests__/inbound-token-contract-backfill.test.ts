/** The boot backfill that contracts every unbound MCP token.
 *
 *  ⛔⛔ THE TWO TESTS THAT MATTER ARE THE RESURRECTION ONES. A backfill that
 *  merely mints a carrier per token looks correct and is a security defect: the
 *  moment the contract becomes the lifecycle authority, an expired token whose
 *  carrier had no `expiry_at`, and a revoked token whose carrier was never
 *  revoked, both come back to life. The second is a live bearer someone
 *  deliberately killed.
 *
 *  So this suite drives the lifecycle TRANSFER, not the row count.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { D165_CONTRACT_SCHEMA, isContractActive } from '@recued/contracts';

import {
  createChatInboundTokenStore,
  ensureChatInboundTokenSchema,
  type ChatInboundTokenStore,
} from '../storage/chat-inbound-token-store.js';
import { createContractStore } from '../storage/contract-store.js';
import {
  createContractDefinitionStore,
  type ContractDefinitionStore,
} from '../storage/contract-definition-store.js';
import { backfillInboundTokenContracts } from '../storage/inbound-token-contract-backfill.js';

const NOW = 1_700_000_000_000;

describe('inbound-token contract backfill', () => {
  let db: Database.Database;
  let tokens: ChatInboundTokenStore;
  let definitions: ContractDefinitionStore;

  /** ⛔ RAW SQL, and that is the point: this fixture builds a PRE-MIGRATION row.
   *  The token type no longer has `expires_at` — that is the field this backfill
   *  exists to move — so the typed store cannot express the state under test.
   *  Writing the row as the old code wrote it is the only faithful input. */
  let seq = 0;
  const issueUnbound = (input: {
    label: string;
    expires_at?: number;
    revoked_at?: number;
  }): string => {
    seq += 1;
    const token_id = `tok_${seq}`;
    db.prepare(`
      INSERT INTO chat_inbound_tokens
        (token_id, bearer_hash, label, peer_handle, created_at, expires_at,
         revoked_at, grants_json, concurrency_tier, chat_mode_json, contract_id,
         updated_at)
        VALUES (@token_id, @bearer_hash, @label, NULL, @created_at, @expires_at,
                @revoked_at, @grants_json, 3, @chat_mode_json, NULL, @updated_at)
    `).run({
      token_id,
      bearer_hash: `hash_${seq}`,
      label: input.label,
      created_at: NOW,
      expires_at: input.expires_at ?? 0,
      revoked_at: input.revoked_at ?? null,
      grants_json: JSON.stringify({ 'recued-core/thing': true }),
      chat_mode_json: JSON.stringify({ offered: false }),
      updated_at: NOW,
    });
    return token_id;
  };

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    // ⚠ Separate from the constructor — the boot composer calls it too, one
    // line before it kicks the backfill, which is why the sweep can assume the
    // table exists in production.
    ensureChatInboundTokenSchema(db);
    tokens = createChatInboundTokenStore(db);
    const contractStore = createContractStore(db, { now: () => NOW });
    contractStore.seedSchema(D165_CONTRACT_SCHEMA);
    definitions = createContractDefinitionStore(contractStore);
  });

  afterEach(() => db.close());

  it('gives an unbound token a contract, and binds it', () => {
    const tokenId = issueUnbound({ label: 'Counter 1' });
    expect(tokens.getTokenById(tokenId)?.contract_id).toBeUndefined();

    const result = backfillInboundTokenContracts(db, definitions);

    expect(result).toMatchObject({ unbound: 1, bound: 1, failed: 0 });
    const bound = tokens.getTokenById(tokenId)!;
    expect(bound.contract_id).toBeDefined();
    expect(definitions.get(bound.contract_id!)?.display_name)
      .toBe('MCP door — Counter 1');
  });

  /** ⛔⛔ RESURRECTION #1 — an expiry that did not travel. */
  it('⛔⛔ carries the token\'s expiry onto the contract, so an expired token stays expired', () => {
    const expired = NOW - 60_000;
    const tokenId = issueUnbound({ label: 'Old', expires_at: expired });
    backfillInboundTokenContracts(db, definitions);

    const def = definitions.get(tokens.getTokenById(tokenId)!.contract_id!)!;
    expect(def.expiry_at).toBe(expired);
    // …and the contract really is dead at `now`, which is the property that
    // matters once the contract becomes the authority.
    expect(isContractActive(def, NOW)).toBe(false);
  });

  /** ⚠ …and the other direction: `expires_at: 0` is the "never expires"
   *  SENTINEL. Copying it literally would set `expiry_at: 0` — an epoch in 1970
   *  — and kill every token the sweep touched. */
  it('⚠ maps the never-expires sentinel to an ABSENT expiry, not to zero', () => {
    const tokenId = issueUnbound({ label: 'Forever' });
    backfillInboundTokenContracts(db, definitions);

    const def = definitions.get(tokens.getTokenById(tokenId)!.contract_id!)!;
    expect(def.expiry_at).toBeUndefined();
    expect(isContractActive(def, NOW)).toBe(true);
  });

  /** ⛔⛔ RESURRECTION #2, and the graver one — a revoked bearer coming back. */
  it('⛔⛔ revokes the carrier of an already-revoked token, so a dead token stays dead', () => {
    // Revoked BEFORE the sweep — the pre-migration state that must not come
    // back to life once the contract becomes the authority.
    const tokenId = issueUnbound({ label: 'Killed', revoked_at: NOW - 1_000 });

    const result = backfillInboundTokenContracts(db, definitions);
    expect(result.revoked).toBe(1);

    const def = definitions.get(tokens.getTokenById(tokenId)!.contract_id!)!;
    expect(def.revoked_at).not.toBeNull();
    expect(isContractActive(def, NOW)).toBe(false);
  });

  /** ⚠ `max_uses` is NOT invented. The token never had a use cap, so neither
   *  does its carrier — minting one would silently start refusing calls that
   *  used to work. Contracted is not bounded, and the backfill must not
   *  quietly make it so. */
  it('⚠ invents no use cap — the token never had one', () => {
    const tokenId = issueUnbound({ label: 'Uncapped' });
    backfillInboundTokenContracts(db, definitions);

    const def = definitions.get(tokens.getTokenById(tokenId)!.contract_id!)!;
    expect(def.max_uses).toBeUndefined();
  });

  /** ⛔⛔ CODEX FOUND THIS, AND IT IS THE ORDER THAT MATTERS. Bind-then-revoke
   *  looks equivalent to revoke-then-bind and is not: if the revoke throws
   *  after the bind, the row is already bound, so the next boot SKIPS it
   *  (`contract_id IS NULL` no longer matches) and it stays bound to a LIVE
   *  carrier forever — a revoked bearer resurrected by the sweep written to
   *  preserve its death. My comment claimed "the next boot retries it", which
   *  was true for a mint failure and false for this one. */
  it('⛔⛔ a revoke failure leaves the row UNBOUND, so the retry is real', () => {
    issueUnbound({ label: 'Killed', revoked_at: NOW - 1_000 });
    const flaky: ContractDefinitionStore = {
      ...definitions,
      revoke: () => { throw new Error('revoke failed'); },
    };

    const result = backfillInboundTokenContracts(db, flaky);

    expect(result).toMatchObject({ unbound: 1, bound: 0, failed: 1 });
    // ⛔ Still NULL — a live carrier bound to a dead token is exactly what the
    // old ordering produced, and it was unreachable by any later boot.
    const rows = db.prepare(
      'SELECT contract_id FROM chat_inbound_tokens',
    ).all() as { contract_id: string | null }[];
    expect(rows[0]?.contract_id).toBeNull();
  });

  it('is idempotent — a second boot binds nothing and mints nothing', () => {
    issueUnbound({ label: 'A' });
    const first = backfillInboundTokenContracts(db, definitions);
    const before = definitions.list().length;

    const second = backfillInboundTokenContracts(db, definitions);

    expect(first.bound).toBe(1);
    expect(second).toMatchObject({ unbound: 0, bound: 0 });
    expect(definitions.list().length).toBe(before);
  });

  it('leaves an ALREADY-bound token alone', () => {
    const issued = tokens.issueToken({
      value: {
        label: 'Bound', grants: {}, concurrency_tier: 3,
        chat_mode: { offered: false }, contract_id: 'ct_existing',
      },
      now: NOW,
      bearer_plaintext: 'recued_ggg',
    });
    const result = backfillInboundTokenContracts(db, definitions);

    expect(result).toMatchObject({ unbound: 0, bound: 0 });
    expect(tokens.getTokenById(issued.record.token_id)?.contract_id).toBe('ct_existing');
  });

  /** ⚠ Best-effort per row: the sweep must not abandon the rest, and must not
   *  block startup. A failed row stays unbound so the next boot retries it —
   *  silently skipping it forever would leave exactly the untracked token this
   *  sweep exists to find. */
  it('⚠ a failing mint leaves that row unbound and continues', () => {
    issueUnbound({ label: 'Fine' });
    issueUnbound({ label: 'Boom' });
    let calls = 0;
    const flaky: ContractDefinitionStore = {
      ...definitions,
      mint: (input) => {
        calls += 1;
        if (calls === 1) throw new Error('mint failed');
        return definitions.mint(input);
      },
    };

    const result = backfillInboundTokenContracts(db, flaky);

    expect(result).toMatchObject({ unbound: 2, bound: 1, failed: 1 });
    // The survivor is bound; the failure is still NULL and will be retried.
    const rows = db.prepare(
      'SELECT contract_id FROM chat_inbound_tokens',
    ).all() as { contract_id: string | null }[];
    expect(rows.filter((r) => r.contract_id === null)).toHaveLength(1);
  });

  it('no token table ⇒ a clean no-op rather than a boot failure', () => {
    const bare = new Database(':memory:');
    expect(() => backfillInboundTokenContracts(bare, definitions)).not.toThrow();
    expect(backfillInboundTokenContracts(bare, definitions))
      .toMatchObject({ unbound: 0, bound: 0 });
    bare.close();
  });
});
