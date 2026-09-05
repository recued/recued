/** D-166 door corpus — a contracted caller recalls its OWN history and nothing
 *  else.
 *
 *  ⛔⛔ THE FAILURE THIS IS FENCED AGAINST is not "a door cannot recall". It is
 *  a door recalling somebody ELSE'S rows — the owner's, or another customer's.
 *  When a seller sells `llm_gateway` access, every customer drives chat under
 *  its own bound door, and the whole point of the corpus is that those
 *  histories never meet. So every test that matters here is about what does NOT
 *  come back. */
import { beforeEach, describe, expect, it } from 'vitest';
import { OWNER_CONTRACT_ID } from '@recued/contracts';
import {
  resolveContractRecallCorpusScope,
  resolveOwnerRecallCorpusScope,
} from '../chat-recall-scope.js';
import { assertRecallCorpusSelector } from '../storage/chat-store.js';

/** A contract-definition store that says every door is live, so the tests
 *  exercise the SCOPE rules rather than liveness. The dead-door case gets its
 *  own store below. */
const liveDefinitions = {
  // `gateGrantGoverningContractId` requires an ACTIVE, STANDING definition —
  // `grant_kind: 'standing'` (or absent) plus no revocation/expiry.
  get: (contract_id: string) => ({
    contract_id,
    minted_at: 0,
    grant_kind: 'standing' as const,
  }),
} as never;

/** A real `ExecutionSource`: the chat channel requires `chat_session_id` and
 *  `user_id`, and a contracted caller is `actor: 'contracted_user'` with a
 *  REQUIRED `contract_id`. Building these by hand is deliberate — a loose
 *  fixture would pass `isExecutionSource` for the wrong reasons. */
const chatSource = (over: Record<string, unknown> = {}) => ({
  channel: 'chat',
  actor: 'user_self',
  chat_session_id: 'sess-1',
  user_id: 'owner',
  ...over,
});
const doorSource = (contract_id: string) => chatSource({
  actor: 'contracted_user',
  contract_id,
});

describe('resolveContractRecallCorpusScope', () => {
  it('gives a bound door its own corpus, keyed on that door', () => {
    const scope = resolveContractRecallCorpusScope(
      doorSource('door-alice'),
      liveDefinitions,
      () => 1_000,
    );
    expect(scope).not.toBeNull();
    expect(scope!.recall_contract_id).toBe('door-alice');
    expect(scope!.row_eligibility).toBe('chat:not_owner_authenticated');
  });

  it('⛔ TWO CUSTOMERS OF ONE SELLER GET DIFFERENT CORPORA', () => {
    const a = resolveContractRecallCorpusScope(
      doorSource('door-alice'), liveDefinitions, () => 1_000);
    const b = resolveContractRecallCorpusScope(
      doorSource('door-bob'), liveDefinitions, () => 1_000);
    expect(a!.recall_contract_id).not.toBe(b!.recall_contract_id);
  });

  it('⛔ NEVER returns the owner corpus, however the source is shaped', () => {
    // The escalation fence: `resolveGrantGoverningContractId` rules that an
    // explicit contract_id is ALWAYS a bound door — "never the owner sentinel,
    // even if it literally equals OWNER_CONTRACT_ID". A door that presents the
    // owner's own id must not thereby reach the owner's history.
    for (const source of [
      chatSource(),                      // the real owner
      doorSource(OWNER_CONTRACT_ID),     // a door claiming the owner's own id
    ]) {
      // ⚠ `OWNER_CONTRACT_ID`, not a hand-written string. An earlier version of
      // this test used the literal 'owner', which is not the sentinel
      // (`'user_self'` is) — so it asserted a fence that was never engaged and
      // failed for the right reason on the wrong input.
      expect(resolveContractRecallCorpusScope(
        source, liveDefinitions, () => 1_000)).toBeNull();
    }
  });

  it('⛔ the CHANNEL fence is independent — messenger never gets a corpus', () => {
    // Stated in the owner scope's own header: the grant resolver maps
    // (messenger, user_self) to the owner sentinel even though messenger
    // authenticates a conversation, not its sender. Both scopes must test the
    // channel themselves.
    //
    // ⛔⛔ THE CONTRACTED MESSENGER SOURCE IS THE ONLY ONE THAT PROVES IT, and
    // the first version of this test did not have one. An UNcontracted
    // messenger source resolves to the owner sentinel, so the sentinel fence
    // rejects it and the channel check never runs — deleting the channel check
    // left all 8 tests green. A messenger source WITH a contract resolves to a
    // real door id, so only the channel test can stop it.
    expect(resolveContractRecallCorpusScope(
      {
        channel: 'messenger', actor: 'contracted_user',
        vendor: 'slack', from: 'U1', contract_id: 'door-alice',
      },
      liveDefinitions, () => 1_000)).toBeNull();
    expect(resolveContractRecallCorpusScope(
      { channel: 'messenger', actor: 'user_self', vendor: 'slack', from: 'U1' },
      liveDefinitions, () => 1_000)).toBeNull();
    expect(resolveOwnerRecallCorpusScope(
      { channel: 'messenger', actor: 'user_self', vendor: 'slack', from: 'U1' },
      liveDefinitions, () => 1_000)).toBeNull();
  });

  it('⛔ a REVOKED door resolves to nothing — its rows are inherited by none', () => {
    const deadDefinitions = { get: () => null } as never;
    expect(resolveContractRecallCorpusScope(
      doorSource('door-alice'), deadDefinitions, () => 1_000)).toBeNull();
  });

  it('the two resolvers are mutually exclusive on every source', () => {
    for (const source of [
      chatSource(),
      doorSource('door-alice'),
      { channel: 'messenger', actor: 'user_self', vendor: 'slack', from: 'U1' },
      { channel: 'chat', actor: 'anonymous' },
      undefined,
      { nonsense: true },
    ]) {
      const owner = resolveOwnerRecallCorpusScope(
        source as never, liveDefinitions, () => 1_000);
      const door = resolveContractRecallCorpusScope(
        source as never, liveDefinitions, () => 1_000);
      expect(owner !== null && door !== null).toBe(false);
    }
  });
});

describe('assertRecallCorpusSelector — the fail-open shape', () => {
  it('⛔⛔ REJECTS the door bucket with no contract id', () => {
    // This pair would match every LEGACY row — those written before the column
    // existed, which carry NULL and belong to no recoverable door. It is the
    // one combination that silently widens a tenant corpus to the whole
    // pre-migration history.
    expect(() => assertRecallCorpusSelector({
      row_eligibility: 'chat:not_owner_authenticated',
      recall_contract_id: null,
      tool_session_id: null,
    })).toThrow(/contract id/i);
    expect(() => assertRecallCorpusSelector({
      row_eligibility: 'chat:not_owner_authenticated',
      recall_contract_id: '',
      tool_session_id: null,
    })).toThrow(/contract id/i);
  });

  it('accepts the two legitimate pairs', () => {
    expect(() => assertRecallCorpusSelector({
      row_eligibility: 'chat:owner_authenticated', recall_contract_id: null,
      tool_session_id: null,
    })).not.toThrow();
    expect(() => assertRecallCorpusSelector({
      row_eligibility: 'chat:not_owner_authenticated',
      recall_contract_id: 'door-alice',
      tool_session_id: null,
    })).not.toThrow();
  });
});
