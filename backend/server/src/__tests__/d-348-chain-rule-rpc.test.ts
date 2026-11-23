/** D-348 slice 2 — the owner's rpc over the chains their approvals teach, and the notice that tells
 *  them once a suggestion opens. The audit rows record the decision and its counts, never the words
 *  or whom the calls reach. */

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { chainCallSignatureHash, RpcError, type ChainCallSignature, type ExecutionSource } from '@recued/contracts';
import {
  createAuditLogStore, createInMemoryCollection, type ActivityEntry, type AuditEntry,
} from '@recued/storage';

import {
  CHAIN_REQUEST_STATE_KEY, chainRuleSuggestedNotice, noteChainHeldRun, openChainRequest, recordChainAnswer, recordChainOutcome,
} from '../chain-evidence.js';
import { createChainRuleRpcHandlers } from '../chain-rule-rpc.js';
import { makeContractHandlers } from '../contract-handler.js';
import { createContractStore } from '../storage/contract-store.js';
import { createChainEvidenceStore } from '../storage/chain-evidence-store.js';
import { createChainRuleStore } from '../storage/chain-rule-store.js';

const DAY = 86_400_000;
const START = 20_000 * DAY;
const SEND: ChainCallSignature = { op: 'step:send@h|mail-send||', pins: { to: ['ann@example.com'] } };
const owner = (turn_id: string): ExecutionSource =>
  ({ channel: 'chat', actor: 'user_self', chat_session_id: 'chat-a', user_id: 'owner', turn_id }) as ExecutionSource;

const fixture = () => {
  const db = new Database(':memory:');
  const chainEvidence = createChainEvidenceStore(db);
  const chainRules = createChainRuleStore(db, chainEvidence, { newId: () => 'rule-1' });
  const notify = vi.fn(async () => undefined);
  const deps = { chainEvidence, chainRules, preflightNotifier: { notify } };
  /** A turn of the owner's chat on day `n` asking for the send, held, approved, run: through the
   *  hooks the orchestrator and the resumer call. */
  const occasion = async (n: number, outcome: 'ran' | 'refused' = 'ran') => {
    const at = START + n * DAY;
    const turn_id = `t${String(n)}`;
    const state = new Map<string, unknown>([[CHAIN_REQUEST_STATE_KEY,
      openChainRequest(chainEvidence, { session_id: 'chat-a', turn_id, source: owner(turn_id), words: 'Tell Ann the new time', at })]]);
    const run_id = `run-${String(n)}`;
    noteChainHeldRun(chainEvidence, state, run_id, at);
    await vi.waitFor(() => expect(chainEvidence.requestOfTurn(turn_id)).toBe(turn_id));
    const checkpoint = {
      checkpoint_id: `cp-${String(n)}`, run_id, recipe_id: 'send', recipe_source_hash: 'h', gated_step_id: 'send',
      step_state: { send: { input: { to: ['ann@example.com'] } } }, created_at: at,
      approved_target: { ingredient_slug: 'mail-send' },
      preflight_context: { tool_slug: 'mail-send', risk_tier: 'write', authorization_provenance: { pre_lift_approval: 'ask' } },
    } as never;
    if (outcome === 'refused') {
      await recordChainAnswer({ ...deps, now: () => at }, checkpoint, 'refused');
      return;
    }
    await recordChainAnswer({ ...deps, now: () => at }, checkpoint, 'approved');
    recordChainOutcome({ ...deps, now: () => at }, { execution_source: owner(turn_id), run_id, tool_name: 'send',
      result: { success: true }, ts: at });
  };
  const auditLog = createAuditLogStore(createInMemoryCollection<AuditEntry>(), createInMemoryCollection<ActivityEntry>());
  let clock = START;
  const rpc = createChainRuleRpcHandlers({ store: chainRules, auditLog, now: () => clock });
  const activities = async () => (await auditLog.listActivities()).filter((row) => row.action.startsWith('chain_rule'));
  return { notify, occasion, rpc, activities, rules: chainRules, setClock: (n: number) => { clock = START + n * DAY; } };
};

describe('D-348 slice 2 — the owner is told once', () => {
  it('when a suggestion opens, in their words, through the resumer\'s hooks', async () => {
    const f = fixture();
    await f.occasion(1);
    await f.occasion(2);
    expect(f.notify).not.toHaveBeenCalled();
    await f.occasion(3);
    await vi.waitFor(() => expect(f.notify).toHaveBeenCalledTimes(1));
    expect(f.notify).toHaveBeenCalledWith(chainRuleSuggestedNotice('Tell Ann the new time'));
    await f.occasion(4);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(f.notify).toHaveBeenCalledTimes(1);
  });

  it('a refusal through the resumer\'s hook withdraws an open suggestion', async () => {
    const f = fixture();
    for (const n of [1, 2, 3]) await f.occasion(n);
    f.setClock(3);
    expect((await f.rpc['collection.contract.listChainSuggestions']()).suggestions).toHaveLength(1);
    await f.occasion(4, 'refused');
    f.setClock(4);
    expect((await f.rpc['collection.contract.listChainSuggestions']()).suggestions).toEqual([]);
  });

  it('after a refusal withdrew it, the owner is told again when it qualifies again', async () => {
    const f = fixture();
    for (const n of [1, 2, 3]) await f.occasion(n);
    await vi.waitFor(() => expect(f.notify).toHaveBeenCalledTimes(1));
    await f.occasion(4, 'refused');
    for (const n of [5, 6]) await f.occasion(n);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(f.notify).toHaveBeenCalledTimes(1);
    await f.occasion(7);
    await vi.waitFor(() => expect(f.notify).toHaveBeenCalledTimes(2));
  });

  it('a refusal on the third occasion opens nothing', async () => {
    const f = fixture();
    await f.occasion(1);
    await f.occasion(2);
    await f.occasion(3, 'refused');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(f.notify).not.toHaveBeenCalled();
  });

  it('its words are cut short past 80 characters, and never needed', () => {
    expect(chainRuleSuggestedNotice('x'.repeat(100)).text).toContain(`"${'x'.repeat(79)}…"`);
    expect(chainRuleSuggestedNotice(undefined).text).toContain('When you ask the same thing,');
  });
});

describe('D-348 slice 2 — the owner\'s rpc', () => {
  const learned = async () => {
    const f = fixture();
    for (const n of [1, 2, 3]) await f.occasion(n);
    f.setClock(3);
    return f;
  };

  it('lists, accepts, lists the rule, ends it; each decision audited by its counts', async () => {
    const f = await learned();
    const { suggestions } = await f.rpc['collection.contract.listChainSuggestions']();
    expect(suggestions).toHaveLength(1);
    const key_hash = suggestions[0]!.key_hash;
    const { rule } = await f.rpc['collection.contract.acceptChainSuggestion']({ key_hash, max_uses: 10 });
    expect(rule).toMatchObject({ rule_id: 'rule-1', max_uses: 10, members: [{ signature_hash: chainCallSignatureHash(SEND) }] });
    expect((await f.rpc['collection.contract.listChainRules']()).rules.map((row) => row.rule_id)).toEqual(['rule-1']);
    expect((await f.rpc['collection.contract.revokeChainRule']({ rule_id: 'rule-1' })).rule.revoked_at).toBeDefined();
    await vi.waitFor(async () => expect((await f.activities()).map((row) => row.action))
      .toEqual(expect.arrayContaining(['chain_rule_minted', 'chain_rule_revoked'])));
    const minted = (await f.activities()).find((row) => row.action === 'chain_rule_minted')!;
    expect(JSON.parse(minted.detail!)).toEqual({ key_hash, calls: 1, deletes: 0, expires_at: expect.any(Number), max_uses: 10 });
    expect(minted.detail).not.toContain('ann@example.com');
    expect(minted.detail).not.toContain('Tell Ann');
  });

  it('names each call as its approvals do, everywhere it lists one; a namer that throws names nothing', async () => {
    const f = await learned();
    const named = createChainRuleRpcHandlers({
      store: f.rules, now: () => START + 3 * DAY,
      nameCall: (signature) => (signature.op.includes('mail-send') ? 'Send mail' : undefined),
    });
    const [listed] = (await named['collection.contract.listChainSuggestions']()).suggestions;
    expect(listed!.members).toEqual([expect.objectContaining({ title: 'Send mail' })]);
    const { rule, suggestion } = await named['collection.contract.acceptChainSuggestion']({ key_hash: listed!.key_hash });
    expect(rule.members[0]!.title).toBe('Send mail');
    expect(suggestion.members[0]!.title).toBe('Send mail');
    expect((await named['collection.contract.listChainRules']()).rules[0]!.members[0]!.title).toBe('Send mail');
    const throwing = createChainRuleRpcHandlers({ store: f.rules, now: () => START + 3 * DAY, nameCall: () => { throw new Error('no'); } });
    expect((await throwing['collection.contract.listChainRules']()).rules[0]!.members[0]!.title).toBeUndefined();
  });

  it('labels the values each call names, everywhere it lists one; a lookup that fails or finds none labels nothing', async () => {
    const f = await learned();
    const labels = { to: { 'ann@example.com': 'Ann Lee <ann@example.com>' } };
    const labelled = createChainRuleRpcHandlers({ store: f.rules, now: () => START + 3 * DAY,
      labelCall: async (signature) => (signature.op.includes('mail-send') ? labels : undefined) });
    const [listed] = (await labelled['collection.contract.listChainSuggestions']()).suggestions;
    expect(listed!.members).toEqual([expect.objectContaining({ pin_labels: labels })]);
    const { rule, suggestion } = await labelled['collection.contract.acceptChainSuggestion']({ key_hash: listed!.key_hash });
    expect(rule.members[0]!.pin_labels).toEqual(labels);
    expect(suggestion.members[0]!.pin_labels).toEqual(labels);
    expect((await labelled['collection.contract.listChainRules']()).rules[0]!.members[0]!.pin_labels).toEqual(labels);
    for (const labelCall of [async () => { throw new Error('locked'); }, async () => ({})]) {
      const none = createChainRuleRpcHandlers({ store: f.rules, now: () => START + 3 * DAY, labelCall });
      expect((await none['collection.contract.listChainRules']()).rules[0]!.members[0]).not.toHaveProperty('pin_labels');
    }
  });

  it('the contract handlers pass both on, as Contracts reads them', async () => {
    const f = await learned();
    const db = new Database(':memory:');
    const labels = { to: { 'ann@example.com': 'Ann Lee <ann@example.com>' } };
    const slice = makeContractHandlers({ store: createContractStore(db, { now: () => START }), chainRules: f.rules,
      getManifest: () => null, listManifests: () => [],
      now: () => START + 3 * DAY, nameChainCall: () => 'Send mail', labelChainCall: async () => labels })!;
    const { suggestions } = await slice.handlers['collection.contract.listChainSuggestions'](undefined as never, undefined as never);
    expect(suggestions[0]!.members[0]).toMatchObject({ title: 'Send mail', pin_labels: labels });
    db.close();
  });

  it('dismisses all, or only the deletes; rejects any other part', async () => {
    const f = await learned();
    const key_hash = (await f.rpc['collection.contract.listChainSuggestions']()).suggestions[0]!.key_hash;
    await expect(f.rpc['collection.contract.dismissChainSuggestion']({ key_hash, part: 'some' })).rejects.toBeInstanceOf(RpcError);
    expect(await f.rpc['collection.contract.dismissChainSuggestion']({ key_hash })).toEqual({ key_hash, part: 'all' });
    expect((await f.rpc['collection.contract.listChainSuggestions']()).suggestions).toEqual([]);
    await vi.waitFor(async () => expect((await f.activities()).map((row) => [row.action, JSON.parse(row.detail!)]))
      .toEqual([['chain_rule_dismissed', { part: 'all' }]]));
  });

  it('takes the deletes only when asked, and passes the bounds through', async () => {
    const accept = vi.fn(async () => ({ rule: { rule_id: 'r', key_hash: 'k', members: [], deletes: [], expires_at: 1, max_uses: 5 },
      suggestion: { key_hash: 'k', members: [], deletes: [] } }));
    const rpc = createChainRuleRpcHandlers({ store: { accept } as never, now: () => 7 });
    await rpc['collection.contract.acceptChainSuggestion']({ key_hash: 'k' });
    await rpc['collection.contract.acceptChainSuggestion']({ key_hash: 'k', deletes: false });
    await rpc['collection.contract.acceptChainSuggestion']({ key_hash: 'k', deletes: true, ttl_ms: 60_000, max_uses: 5 });
    expect(accept.mock.calls).toEqual([
      ['k', {}, 7], ['k', {}, 7], ['k', { deletes: true, ttl_ms: 60_000, max_uses: 5 }, 7],
    ]);
  });

  it('refuses a bad request, and says not found and bad request as their codes', async () => {
    const f = await learned();
    await expect(f.rpc['collection.contract.acceptChainSuggestion']({ key_hash: 'k', deletes: 'yes' })).rejects.toThrow(/deletes/);
    await expect(f.rpc['collection.contract.acceptChainSuggestion']({ key_hash: '' })).rejects.toThrow(/key_hash is required/);
    await expect(f.rpc['collection.contract.acceptChainSuggestion']({ key_hash: 'nope' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(f.rpc['collection.contract.revokeChainRule']({ rule_id: 'nope' })).rejects.toMatchObject({ code: 'not_found' });
    const unwired = createChainRuleRpcHandlers({});
    await expect(unwired['collection.contract.listChainRules']()).rejects.toMatchObject({ code: 'not_configured' });
  });
});
