/** D-329 §3.4 — the write rules an AI's approvals teach: the key, the evidence rule, and the
 *  store over a real SQLite database.
 *
 *  The owner: *"work.create can be auto after 3 approval"*. Three approvals of one tool on
 *  one kind of thing, asked by one principal, on three occasions within 30 days and with no
 *  refusal among them, suggest a rule; only the owner mints it, at most 30 days and 100
 *  uses; dismissing or revoking ends the key for good. */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  WRITE_RULE_LOOKBACK_MS,
  WRITE_RULE_MAX_USES,
  WRITE_RULE_TTL_MS,
  describeWriteRule,
  writeRuleKeyHash,
  writeRuleKeyOf,
  writeRuleOccasionOf,
  type ExecutionSource,
  type WriteRuleKey,
} from '@recued/contracts';
import { createWriteRuleStore } from '../storage/write-rule-store.js';
import { RpcError, D165_CONTRACT_SCHEMA } from '@recued/contracts';
import { createAuditLogStore, createInMemoryCollection, type ActivityEntry, type AuditEntry } from '@recued/storage';
import { makeContractHandlers } from '../contract-handler.js';
import { createContractStore } from '../storage/contract-store.js';

const DAY = 86_400_000;
const T0 = 20_000 * DAY + 9 * 3_600_000;
const chat = (session = 's1'): ExecutionSource => ({ channel: 'chat', actor: 'user_self', chat_session_id: session, user_id: 'local' });
const telegram: ExecutionSource = { channel: 'messenger', actor: 'user_self', vendor: 'telegram', from: '42' };
const app = (contract_id = 'k-app'): ExecutionSource => ({
  channel: 'mcp', actor: 'contracted_user', agent_id: 'a', tool_call_id: 't', mcp_token_id: 'tok-1', contract_id,
});
const TASK = { kind: 'task', title: 'Call the dentist' };
const taskKey = (source: ExecutionSource = chat()): WriteRuleKey => writeRuleKeyOf(source, 'work.create', TASK)!;

describe('D-329 §3.4 — the rule key', () => {
  it('is the owner\'s chats as one, or one AI app by its contract', () => {
    expect(writeRuleKeyHash(taskKey(chat('s1')))).toBe(writeRuleKeyHash(taskKey(chat('s2'))));
    expect(writeRuleKeyHash(taskKey(telegram))).toBe(writeRuleKeyHash(taskKey(chat())));
    expect(writeRuleKeyHash(taskKey(app('k-1')))).not.toBe(writeRuleKeyHash(taskKey(chat())));
    expect(writeRuleKeyHash(taskKey(app('k-1')))).not.toBe(writeRuleKeyHash(taskKey(app('k-2'))));
  });

  it('names no key for a chat under a contract, an unknown tool, or a call that says too little', () => {
    expect(writeRuleKeyOf({ ...chat(), contract_id: 'k-self' } as ExecutionSource, 'work.create', TASK)).toBeUndefined();
    expect(writeRuleKeyOf({ channel: 'messenger', actor: 'contracted_user', vendor: 'telegram', from: '7', contract_id: 'k-house' },
      'work.create', TASK)).toBeUndefined();
    expect(writeRuleKeyOf(chat(), 'mail.send', { to: 'a@b.c' })).toBeUndefined();
    expect(writeRuleKeyOf(chat(), 'work.create', { title: 'no kind' })).toBeUndefined();
    expect(writeRuleKeyOf(chat(), 'work.create', { kind: 'asset', title: 'no type' })).toBeUndefined();
  });

  it('scopes by what the tool writes on', () => {
    expect(writeRuleKeyOf(chat(), 'work.create', { kind: 'asset', type: 'passport' })?.scope).toBe('asset:passport');
    expect(writeRuleKeyOf(chat(), 'work.update', { kind: 'task', id: 'x', done: true })?.scope).toBe('task');
    expect(writeRuleKeyOf(chat(), 'calendar.create', {})?.scope).toBe('local');
    expect(writeRuleKeyOf(chat(), 'calendar.update', { calendar_id: 'google-work' })?.scope).toBe('google-work');
    expect(writeRuleKeyOf(chat(), 'recipe.stop', { run_id: 'r' })?.scope).toBe('');
    // "Do the other writes too": a memory rule is the tool alone; a schedule rule is one recipe's.
    expect(writeRuleKeyOf(chat(), 'memory.write', { summary: 'x' })?.scope).toBe('');
    expect(writeRuleKeyOf(chat(), 'memory.forget', { memory_id: 'm1' })?.scope).toBe('');
    expect(writeRuleKeyOf(chat(), 'recipe.schedule', { recipe_id: 'acme/weekly-report', mode: 'recurring' })?.scope)
      .toBe('acme/weekly-report');
    expect(writeRuleKeyOf(chat(), 'recipe.schedule', { mode: 'one_shot' })).toBeUndefined();
    // A task rule is not a commitment rule.
    expect(writeRuleKeyHash(taskKey())).not.toBe(writeRuleKeyHash(writeRuleKeyOf(chat(), 'work.create', { kind: 'commitment' })!));
  });

  it('counts an occasion per conversation per day', () => {
    expect(writeRuleOccasionOf(chat('s1'), T0)).toBe(writeRuleOccasionOf(chat('s1'), T0 + 3_600_000));
    expect(writeRuleOccasionOf(chat('s1'), T0)).not.toBe(writeRuleOccasionOf(chat('s1'), T0 + DAY));
    expect(writeRuleOccasionOf(chat('s1'), T0)).not.toBe(writeRuleOccasionOf(chat('s2'), T0));
  });

  it('says in words what a rule lets happen', () => {
    expect(describeWriteRule(taskKey())).toEqual({ action: 'Add a task, note or more', on: 'task' });
    expect(describeWriteRule(writeRuleKeyOf(chat(), 'calendar.create', {})!)).toEqual({
      action: 'Add a calendar event', on: 'your Recued calendar',
    });
    expect(describeWriteRule(writeRuleKeyOf(chat(), 'recipe.schedule', { recipe_id: 'acme/weekly-report' })!)).toEqual({
      action: 'Schedule a recipe', on: 'the recipe acme/weekly-report',
    });
    expect(describeWriteRule(writeRuleKeyOf(chat(), 'memory.write', { summary: 'x' })!)).toEqual({ action: 'Save to your memory' });
  });
});

const setup = () => {
  const db = new Database(':memory:');
  let n = 0;
  const store = createWriteRuleStore(db, { newId: () => `rule-${(n += 1)}` });
  let run = 0;
  const answer = (at: number, outcome: 'approved' | 'refused' = 'approved', source: ExecutionSource = chat(), key = taskKey(source)) =>
    store.recordAnswer({ run_id: `run-${(run += 1)}`, key, outcome, occasion: writeRuleOccasionOf(source, at), at });
  return { db, store, answer, key_hash: writeRuleKeyHash(taskKey()) };
};

describe('D-329 §3.4 — learning a rule', () => {
  it('three yeses in one sitting are one occasion; on three days they suggest a rule, once', () => {
    const h = setup();
    expect(h.answer(T0).suggested).toBe(false);
    expect(h.answer(T0 + 60_000).suggested).toBe(false);
    expect(h.answer(T0 + 120_000).suggested).toBe(false);
    expect(h.store.listSuggestions(T0 + 120_000)).toEqual([]);
    expect(h.answer(T0 + DAY).suggested).toBe(false);
    expect(h.answer(T0 + 2 * DAY).suggested).toBe(true);
    expect(h.answer(T0 + 3 * DAY).suggested).toBe(false);
    const [suggestion] = h.store.listSuggestions(T0 + 3 * DAY);
    expect(suggestion).toMatchObject({ key_hash: h.key_hash, evidence: { approvals: 6, occasions: 4, refused: false, suggest: true } });
  });

  it('an answer told twice counts once', () => {
    const h = setup();
    const key = taskKey();
    for (let day = 0; day < 2; day += 1) {
      h.store.recordAnswer({ run_id: 'run-same', key, outcome: 'approved', occasion: writeRuleOccasionOf(chat(), T0 + day * DAY), at: T0 + day * DAY });
    }
    h.answer(T0 + 2 * DAY);
    expect(h.store.listSuggestions(T0 + 2 * DAY)).toEqual([]);
  });

  it('a refusal holds the suggestion back, and withdraws an open one', () => {
    const h = setup();
    h.answer(T0);
    h.answer(T0 + DAY, 'refused');
    h.answer(T0 + 2 * DAY);
    expect(h.answer(T0 + 3 * DAY).suggested).toBe(false);
    expect(h.store.listSuggestions(T0 + 3 * DAY)).toEqual([]);

    const g = setup();
    g.answer(T0); g.answer(T0 + DAY); g.answer(T0 + 2 * DAY);
    expect(g.store.listSuggestions(T0 + 2 * DAY)).toHaveLength(1);
    g.answer(T0 + 2 * DAY + 60_000, 'refused');
    expect(g.store.listSuggestions(T0 + 2 * DAY + 60_000)).toEqual([]);
  });

  it('counts only the last 30 days', () => {
    const h = setup();
    h.answer(T0);
    h.answer(T0 + DAY);
    expect(h.answer(T0 + WRITE_RULE_LOOKBACK_MS + DAY + 1).suggested).toBe(false);
  });

  it('one AI app\'s yeses never teach another, nor the owner\'s chats', () => {
    const h = setup();
    h.answer(T0, 'approved', app('k-1'));
    h.answer(T0 + DAY, 'approved', app('k-2'));
    expect(h.answer(T0 + 2 * DAY).suggested).toBe(false);
    expect(h.store.listSuggestions(T0 + 2 * DAY)).toEqual([]);
  });
});

const suggested = () => {
  const h = setup();
  h.answer(T0); h.answer(T0 + DAY); h.answer(T0 + 2 * DAY);
  return { ...h, at: T0 + 2 * DAY + 1 };
};

describe('D-329 §3.4 — minting, spending and ending a rule', () => {
  it('mints within the ceilings, tighter when asked, and a retry returns the same rule', () => {
    const h = suggested();
    const { rule } = h.store.accept(h.key_hash, {}, h.at);
    expect(rule).toMatchObject({ rule_id: 'rule-1', expires_at: h.at + WRITE_RULE_TTL_MS, max_uses: WRITE_RULE_MAX_USES,
      uses_remaining: WRITE_RULE_MAX_USES });
    expect(h.store.accept(h.key_hash, {}, h.at + 1).rule.rule_id).toBe('rule-1');
    expect(h.store.listSuggestions(h.at)).toEqual([]);

    const g = suggested();
    expect(g.store.accept(g.key_hash, { ttl_ms: DAY, max_uses: 3 }, g.at).rule).toMatchObject({ expires_at: g.at + DAY, max_uses: 3 });
  });

  it('refuses a wider rule, and a key with no open suggestion', () => {
    const h = suggested();
    expect(() => h.store.accept(h.key_hash, { ttl_ms: WRITE_RULE_TTL_MS + 1 }, h.at)).toThrow(/ttl_ms/);
    expect(() => h.store.accept(h.key_hash, { max_uses: WRITE_RULE_MAX_USES + 1 }, h.at)).toThrow(/max_uses/);
    expect(() => h.store.accept(h.key_hash, { max_uses: 1.5 }, h.at)).toThrow(/max_uses/);
    expect(() => h.store.accept('no-such-key', {}, h.at)).toThrow(expect.objectContaining({ code: 'not_found' }));
    const g = setup();
    g.answer(T0);
    expect(() => g.store.accept(g.key_hash, {}, T0)).toThrow(expect.objectContaining({ code: 'bad_request' }));
  });

  it('spends one use at a time, for its own key only, and not once it has ended', () => {
    const h = suggested();
    h.store.accept(h.key_hash, { max_uses: 2 }, h.at);
    expect(h.store.use(taskKey(app()), h.at)).toBeUndefined();
    expect(h.store.use(taskKey(telegram), h.at)?.uses_remaining).toBe(1);
    expect(h.store.use(taskKey(), h.at)?.uses_remaining).toBe(0);
    expect(h.store.use(taskKey(), h.at)).toBeUndefined();
    expect(h.store.listRules(h.at)).toEqual([]);

    const g = suggested();
    g.store.accept(g.key_hash, { ttl_ms: DAY }, g.at);
    expect(g.store.use(taskKey(), g.at + DAY)).toBeUndefined();
  });

  it('a revoked rule stops, and its key never suggests again', () => {
    const h = suggested();
    const { rule } = h.store.accept(h.key_hash, {}, h.at);
    expect(h.store.revoke(rule.rule_id, h.at + 1).revoked_at).toBe(h.at + 1);
    expect(h.store.use(taskKey(), h.at + 2)).toBeUndefined();
    h.answer(h.at + DAY); h.answer(h.at + 2 * DAY); h.answer(h.at + 3 * DAY);
    expect(h.store.listSuggestions(h.at + 3 * DAY)).toEqual([]);
    expect(() => h.store.revoke('no-such-rule', h.at)).toThrow(expect.objectContaining({ code: 'not_found' }));
  });

  it('a dismissed suggestion is gone for good, and a live rule cannot be dismissed', () => {
    const h = suggested();
    h.store.dismiss(h.key_hash, h.at);
    h.answer(h.at + DAY);
    expect(h.store.listSuggestions(h.at + DAY)).toEqual([]);
    expect(() => h.store.accept(h.key_hash, {}, h.at + DAY)).toThrow(expect.objectContaining({ code: 'bad_request' }));

    const g = suggested();
    g.store.accept(g.key_hash, {}, g.at);
    expect(() => g.store.dismiss(g.key_hash, g.at)).toThrow(expect.objectContaining({ code: 'bad_request' }));
  });

  it('an answer to an ask raised before the rule teaches nothing while the rule lives', () => {
    const h = suggested();
    h.store.accept(h.key_hash, {}, h.at);
    expect(h.answer(h.at + DAY).suggested).toBe(false);
    expect(h.store.listSuggestions(h.at + DAY)).toEqual([]);
    expect(h.store.listRules(h.at + DAY)).toHaveLength(1);
  });

  it('a suggestion a refusal withdrew is suggested, and told, afresh once the refusal ages out', () => {
    const h = suggested();
    h.answer(h.at, 'refused');
    expect(h.store.listSuggestions(h.at)).toEqual([]);
    const later = h.at + WRITE_RULE_LOOKBACK_MS + DAY;
    h.answer(later);
    h.answer(later + DAY);
    expect(h.answer(later + 2 * DAY).suggested).toBe(true);
  });

  it('a rule that ran out lets the key learn again', () => {
    const h = suggested();
    h.store.accept(h.key_hash, { max_uses: 1 }, h.at);
    h.store.use(taskKey(), h.at);
    expect(h.answer(h.at + DAY).suggested).toBe(true);
  });
});

describe('D-329 §3.4 — the owner\'s rpc', () => {
  const rig = () => {
    const db = new Database(':memory:');
    const contracts = createContractStore(db, { now: () => T0 });
    contracts.seedSchema(D165_CONTRACT_SCHEMA);
    const writeRules = createWriteRuleStore(db, { newId: () => 'rule-1' });
    const activities = createInMemoryCollection<ActivityEntry>();
    const auditLog = createAuditLogStore(createInMemoryCollection<AuditEntry>(), activities);
    const slice = makeContractHandlers({
      store: contracts, getManifest: () => null, listManifests: () => [], now: () => T0 + 3 * DAY, writeRules, auditLog,
    })!;
    const key = taskKey();
    for (let day = 0; day < 3; day += 1) {
      writeRules.recordAnswer({ run_id: `r${day}`, key, outcome: 'approved', occasion: writeRuleOccasionOf(chat(), T0 + day * DAY), at: T0 + day * DAY });
    }
    const handlers = slice.handlers as Record<string, (args: unknown, client?: unknown) => Promise<unknown>>;
    return { slice, handlers, writeRules, key_hash: writeRuleKeyHash(key), auditLog };
  };

  it('lists, accepts within the ceilings, lists the rule, and revokes it, auditing each decision', async () => {
    const h = rig();
    expect(h.slice.methods).toEqual(expect.arrayContaining([
      'collection.contract.listWriteRuleSuggestions', 'collection.contract.acceptWriteRuleSuggestion',
      'collection.contract.dismissWriteRuleSuggestion', 'collection.contract.listWriteRules',
      'collection.contract.revokeWriteRule',
    ]));
    const listed = await h.handlers['collection.contract.listWriteRuleSuggestions']!(undefined) as { suggestions: unknown[] };
    expect(listed.suggestions).toHaveLength(1);
    await expect(h.handlers['collection.contract.acceptWriteRuleSuggestion']!({ key_hash: h.key_hash, max_uses: 101 }))
      .rejects.toMatchObject({ code: 'bad_request' });
    const accepted = await h.handlers['collection.contract.acceptWriteRuleSuggestion']!({ key_hash: h.key_hash, max_uses: 5 }) as {
      rule: { rule_id: string; max_uses: number };
    };
    expect(accepted.rule).toMatchObject({ rule_id: 'rule-1', max_uses: 5 });
    const rules = await h.handlers['collection.contract.listWriteRules']!(undefined) as { rules: unknown[] };
    expect(rules.rules).toHaveLength(1);
    await h.handlers['collection.contract.revokeWriteRule']!({ rule_id: 'rule-1' });
    expect((await h.handlers['collection.contract.listWriteRules']!(undefined) as { rules: unknown[] }).rules).toEqual([]);
    await expect(h.handlers['collection.contract.revokeWriteRule']!({ rule_id: 'nope' })).rejects.toMatchObject({ code: 'not_found' });
    await new Promise((resolve) => setImmediate(resolve));
    const actions = (await h.auditLog.listActivities(50)).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['write_rule_minted', 'write_rule_revoked']));
  });

  it('dismisses for good, and answers not_configured with no store', async () => {
    const h = rig();
    await h.handlers['collection.contract.dismissWriteRuleSuggestion']!({ key_hash: h.key_hash });
    expect((await h.handlers['collection.contract.listWriteRuleSuggestions']!(undefined) as { suggestions: unknown[] }).suggestions)
      .toEqual([]);
    const db = new Database(':memory:');
    const contracts = createContractStore(db, { now: () => T0 });
    contracts.seedSchema(D165_CONTRACT_SCHEMA);
    const bare = makeContractHandlers({ store: contracts, getManifest: () => null, listManifests: () => [] })!;
    const err = await (bare.handlers as unknown as Record<string, (a: unknown) => Promise<unknown>>)['collection.contract.listWriteRules']!(undefined)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).code).toBe('not_configured');
  });
});

