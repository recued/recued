/** D-348 slice 2 — what the chain evidence teaches: a request's suggestion, opened once its calls
 *  ran as proposed on 3 occasions; the rule the owner accepts; a longer chain suggested again,
 *  never added silently (Q6); a delete offered on its own (Q7); and "for good" when the owner says
 *  no or ends the rule. */

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { chainCallSignatureHash, CHAIN_RULE_TTL_MS, type ChainCallSignature } from '@recued/contracts';

import { recordChainUndo, tellChainRuleEndedByUndo } from '../chain-evidence.js';
import { createChainEvidenceStore } from '../storage/chain-evidence-store.js';
import { ChainRuleError, createChainRuleStore } from '../storage/chain-rule-store.js';

const DAY = 86_400_000;
const START = 20_000 * DAY;
const SEND: ChainCallSignature = { op: 'step:send@h|mail-send||', pins: { to: ['ann@example.com'] } };
const TASK: ChainCallSignature = { op: 'tier1:work.create:task', pins: {} };
const CLEAR: ChainCallSignature = { op: 'op:recued-core/tasks|task.delete|', pins: {}, delete: true };
const hash = chainCallSignatureHash;

type Call = { readonly signature: ChainCallSignature; readonly answer?: 'approved' | 'refused'; readonly outcome?: 'ran' | 'failed' };

const fixture = () => {
  const db = new Database(':memory:');
  const evidence = createChainEvidenceStore(db);
  let ids = 0;
  const rules = createChainRuleStore(db, evidence, { newId: () => `rule-${String((ids += 1))}` });
  let seq = 0;
  /** One request, on its own day, its calls each held as a run, answered and settled. Returns
   *  whether the last one opened or grew the suggestion. */
  const occasion = async (day: number, calls: readonly Call[], words = 'Tell Ann the new time'): Promise<boolean> => {
    const at = START + day * DAY;
    const request_id = `req-${String((seq += 1))}`;
    await evidence.openRequest({ request_id, session_id: 'chat-a', words, occasion: `chat:chat-a|${String(day)}`, at });
    let suggested = false;
    for (const call of calls) {
      const run_id = `run-${String((seq += 1))}`;
      evidence.heldRun({ run_id, request_id, at });
      await evidence.recordAnswer({ checkpoint_id: `cp-${run_id}`, run_id, signature: call.signature, answer: call.answer ?? 'approved', at });
      if ((call.answer ?? 'approved') === 'approved') evidence.runSettled(run_id, call.outcome ?? 'ran', at);
      suggested = rules.learnForRun(run_id, at).suggested || suggested;
    }
    return suggested;
  };
  const day = (n: number) => START + n * DAY;
  return { db, evidence, rules, occasion, day };
};

/** The run of the latest occasion. */
const lastRun = (f: ReturnType<typeof fixture>): string =>
  (f.db.prepare('SELECT run_id FROM chain_runs ORDER BY at DESC, run_id DESC LIMIT 1').get() as { run_id: string }).run_id;

describe('D-348 slice 2 — a suggestion opens on the third occasion', () => {
  it('tells the owner once, and lists the words and each call as asked', async () => {
    const f = fixture();
    expect(await f.occasion(1, [{ signature: SEND }])).toBe(false);
    expect(await f.occasion(2, [{ signature: SEND }])).toBe(false);
    expect(await f.rules.listSuggestions(f.day(2))).toEqual([]);
    expect(await f.occasion(3, [{ signature: SEND }])).toBe(true);
    // Once: a fourth occasion that adds nothing tells nothing.
    expect(await f.occasion(4, [{ signature: SEND }])).toBe(false);
    const [suggestion] = await f.rules.listSuggestions(f.day(4));
    expect(suggestion).toMatchObject({
      words: 'Tell Ann the new time', members: [{ signature_hash: hash(SEND), signature: SEND }], deletes: [],
      evidence: { occasions: 4, members: [hash(SEND)] }, suggested_at: f.day(3),
    });
    expect(suggestion!.rule_id).toBeUndefined();
  });

  it('a refusal withdraws it, and the count starts again', async () => {
    const f = fixture();
    for (const n of [1, 2, 3]) await f.occasion(n, [{ signature: SEND }]);
    expect(await f.occasion(4, [{ signature: SEND, answer: 'refused' }])).toBe(false);
    expect(await f.rules.listSuggestions(f.day(4))).toEqual([]);
    for (const n of [5, 6]) expect(await f.occasion(n, [{ signature: SEND }])).toBe(false);
    expect(await f.occasion(7, [{ signature: SEND }])).toBe(true);
  });

  it('a call that failed withdraws it too', async () => {
    const f = fixture();
    for (const n of [1, 2, 3]) await f.occasion(n, [{ signature: SEND }]);
    await f.occasion(4, [{ signature: SEND, outcome: 'failed' }]);
    expect(await f.rules.listSuggestions(f.day(4))).toEqual([]);
  });

  it('an undo withdraws it as of when the owner undid the change, and the count starts again then', async () => {
    const f = fixture();
    for (const n of [1, 2, 3]) await f.occasion(n, [{ signature: SEND }]);
    const [open] = await f.rules.listSuggestions(f.day(3));
    // Half a day after the third, the owner undoes what the first one changed.
    const first = (f.db.prepare('SELECT run_id FROM chain_runs ORDER BY at, run_id LIMIT 1').get() as { run_id: string }).run_id;
    expect(f.evidence.runUndone({ run_id: first, receipt_id: 'lmr_1', at: f.day(3) + DAY / 2 })).toBeDefined();
    expect(await f.rules.listSuggestions(f.day(3) + DAY / 2)).toEqual([]);
    await expect(f.rules.accept(open!.key_hash, {}, f.day(3) + DAY / 2)).rejects.toThrow(/no open chain suggestion/);
    // Days 2 and 3 went with it, though they came after the change it undid.
    expect(await f.occasion(4, [{ signature: SEND }])).toBe(false);
    expect(await f.occasion(5, [{ signature: SEND }])).toBe(false);
    expect(await f.rules.listSuggestions(f.day(5))).toEqual([]);
    // The third after it opens it again, and the owner is told again.
    expect(await f.occasion(6, [{ signature: SEND }])).toBe(true);
    expect((await f.rules.listSuggestions(f.day(6)))[0]).toMatchObject({
      evidence: { occasions: 3, spoiled_at: f.day(3) + DAY / 2 }, suggested_at: f.day(6),
    });
  });

  it('an undo of another request\'s change resets nothing here', async () => {
    const f = fixture();
    await f.occasion(1, [{ signature: TASK }], 'Add the weekly review');
    const other = (f.db.prepare('SELECT run_id FROM chain_runs ORDER BY at, run_id LIMIT 1').get() as { run_id: string }).run_id;
    for (const n of [2, 3]) await f.occasion(n, [{ signature: SEND }]);
    f.evidence.runUndone({ run_id: other, receipt_id: 'lmr_1', at: f.day(3) + 1 });
    expect(await f.occasion(4, [{ signature: SEND }])).toBe(true);
  });

  it('a suggestion whose occasions aged out of the month is listed no more', async () => {
    const f = fixture();
    for (const n of [1, 2, 3]) await f.occasion(n, [{ signature: SEND }]);
    expect(await f.rules.listSuggestions(f.day(3))).toHaveLength(1);
    expect(await f.rules.listSuggestions(f.day(32))).toEqual([]);
    await expect(f.rules.accept((await f.rules.listSuggestions(f.day(3)))[0]!.key_hash, {}, f.day(32)))
      .rejects.toThrow(/no open chain suggestion/);
  });

  it('another wording is another request', async () => {
    const f = fixture();
    await f.occasion(1, [{ signature: SEND }], 'Tell Ann the new time');
    await f.occasion(2, [{ signature: SEND }], 'tell ann the new time!');
    expect(await f.occasion(3, [{ signature: SEND }], 'Let Ann know the new time')).toBe(false);
    expect(await f.occasion(4, [{ signature: SEND }], 'Tell Ann the new time.')).toBe(true);
  });
});

describe('D-348 slice 2 — the owner accepts it', () => {
  const learned = async () => {
    const f = fixture();
    for (const n of [1, 2, 3]) await f.occasion(n, [{ signature: SEND }, { signature: TASK }]);
    return f;
  };

  it('mints a rule of its calls, within the ceilings, and spends a use per call on it', async () => {
    const f = await learned();
    const [suggestion] = await f.rules.listSuggestions(f.day(3));
    const { rule } = await f.rules.accept(suggestion!.key_hash, {}, f.day(3));
    expect(rule).toMatchObject({
      rule_id: 'rule-1', words: 'Tell Ann the new time', created_at: f.day(3), expires_at: f.day(3) + CHAIN_RULE_TTL_MS,
      max_uses: 100, uses_remaining: 100, deletes: [],
    });
    expect(rule.members.map((view) => view.signature)).toEqual(
      [SEND, TASK].sort((a, b) => (hash(a) < hash(b) ? -1 : 1)));
    expect(await f.rules.listSuggestions(f.day(3))).toEqual([]);
    expect(f.rules.use(suggestion!.key_hash, hash(SEND), f.day(4))).toEqual({ rule_id: 'rule-1', uses_remaining: 99, delete: false });
    // A call not on it, another request's key: nothing.
    expect(f.rules.use(suggestion!.key_hash, hash({ ...SEND, pins: { to: ['ben@example.com'] } }), f.day(4))).toBeUndefined();
    expect(f.rules.use('another-key', hash(SEND), f.day(4))).toBeUndefined();
    expect((await f.rules.listRules(f.day(4)))[0]).toMatchObject({ rule_id: 'rule-1', uses_remaining: 99 });
    // Past its 30 days it is spent no more.
    expect(f.rules.use(suggestion!.key_hash, hash(SEND), f.day(3) + CHAIN_RULE_TTL_MS)).toBeUndefined();
  });

  it('the owner may tighten its bounds, never widen them', async () => {
    const f = await learned();
    const [suggestion] = await f.rules.listSuggestions(f.day(3));
    await expect(f.rules.accept(suggestion!.key_hash, { max_uses: 101 }, f.day(3))).rejects.toBeInstanceOf(ChainRuleError);
    await expect(f.rules.accept(suggestion!.key_hash, { ttl_ms: CHAIN_RULE_TTL_MS + 1 }, f.day(3))).rejects.toThrow(/ttl_ms/);
    const { rule } = await f.rules.accept(suggestion!.key_hash, { max_uses: 2, ttl_ms: DAY }, f.day(3));
    expect(rule).toMatchObject({ max_uses: 2, uses_remaining: 2, expires_at: f.day(4) });
    f.rules.use(rule.key_hash, hash(SEND), f.day(3));
    f.rules.use(rule.key_hash, hash(TASK), f.day(3));
    expect(f.rules.use(rule.key_hash, hash(SEND), f.day(3))).toBeUndefined();
  });

  it('a retry of the accept returns the rule it minted, not a twin', async () => {
    const f = await learned();
    const [suggestion] = await f.rules.listSuggestions(f.day(3));
    const first = await f.rules.accept(suggestion!.key_hash, {}, f.day(3));
    const again = await f.rules.accept(suggestion!.key_hash, {}, f.day(3));
    expect(again.rule.rule_id).toBe(first.rule.rule_id);
    expect(await f.rules.listRules(f.day(3))).toHaveLength(1);
  });

  it('still reads as the owner accepted it after the conversation is deleted', async () => {
    const f = await learned();
    const [suggestion] = await f.rules.listSuggestions(f.day(3));
    await f.rules.accept(suggestion!.key_hash, {}, f.day(3));
    f.evidence.deleteSession('chat-a');
    const [rule] = await f.rules.listRules(f.day(3));
    expect(rule).toMatchObject({ words: 'Tell Ann the new time' });
    expect(rule!.members.every((view) => view.signature !== undefined)).toBe(true);
  });
});

describe('D-348 slice 2 — never silent (Q6), a delete on its own (Q7), and for good', () => {
  it('a call approved beside a live rule grows the chain, suggested again; accepted, the older rule ends', async () => {
    const f = fixture();
    for (const n of [1, 2, 3]) await f.occasion(n, [{ signature: SEND }]);
    const [first] = await f.rules.listSuggestions(f.day(3));
    const { rule } = await f.rules.accept(first!.key_hash, {}, f.day(3));
    // The send runs on the rule now, so only the task asks, and is approved each time.
    expect(await f.occasion(4, [{ signature: TASK }])).toBe(false);
    expect(await f.occasion(5, [{ signature: TASK }])).toBe(false);
    expect(await f.occasion(6, [{ signature: TASK }])).toBe(true);
    // Not added to the rule: suggested, with the rule's calls and the new one.
    expect(f.rules.use(rule.key_hash, hash(TASK), f.day(6))).toBeUndefined();
    const [longer] = await f.rules.listSuggestions(f.day(6));
    expect(longer).toMatchObject({ rule_id: rule.rule_id });
    expect(longer!.members.map((view) => view.signature_hash).sort()).toEqual([hash(SEND), hash(TASK)].sort());
    const { rule: next } = await f.rules.accept(longer!.key_hash, {}, f.day(6));
    expect((await f.rules.listRules(f.day(6))).map((row) => row.rule_id)).toEqual([next.rule_id]);
    expect(next.members.map((view) => view.signature).every((signature) => signature !== undefined)).toBe(true);
    expect(f.rules.use(rule.key_hash, hash(TASK), f.day(7))).toMatchObject({ rule_id: next.rule_id });
  });

  it('a delete is offered on its own after 5 occasions, and taken only when the owner says so', async () => {
    const f = fixture();
    for (const n of [1, 2, 3, 4]) await f.occasion(n, [{ signature: TASK }, { signature: CLEAR }], 'clear my done tasks');
    const [chain] = await f.rules.listSuggestions(f.day(4));
    expect(chain!.deletes).toEqual([]);
    expect(await f.occasion(5, [{ signature: TASK }, { signature: CLEAR }], 'clear my done tasks')).toBe(true);
    const [withDelete] = await f.rules.listSuggestions(f.day(5));
    expect(withDelete!.deletes).toEqual([{ signature_hash: hash(CLEAR), signature: CLEAR }]);
    // Accepted without it: the rule holds the chain, and the delete stays offered, on its own.
    const { rule } = await f.rules.accept(withDelete!.key_hash, {}, f.day(5));
    expect(rule.deletes).toEqual([]);
    expect(f.rules.use(rule.key_hash, hash(CLEAR), f.day(5))).toBeUndefined();
    const [stillOffered] = await f.rules.listSuggestions(f.day(5));
    expect(stillOffered).toMatchObject({ rule_id: rule.rule_id, deletes: [{ signature_hash: hash(CLEAR) }] });
    // Taken when the owner says so.
    const { rule: withIt } = await f.rules.accept(stillOffered!.key_hash, { deletes: true }, f.day(5));
    expect(withIt.deletes).toEqual([{ signature_hash: hash(CLEAR), signature: CLEAR }]);
    expect(f.rules.use(rule.key_hash, hash(CLEAR), f.day(6))).toMatchObject({ rule_id: withIt.rule_id, delete: true });
    expect(await f.rules.listSuggestions(f.day(6))).toEqual([]);
  });

  it('replacing a rule with no bounds given keeps its days and uses left; a tightened rule never loosens', async () => {
    const f = fixture();
    for (const n of [1, 2, 3, 4, 5]) await f.occasion(n, [{ signature: TASK }, { signature: CLEAR }], 'clear my done tasks');
    const [suggestion] = await f.rules.listSuggestions(f.day(5));
    const { rule } = await f.rules.accept(suggestion!.key_hash, { ttl_ms: 7 * DAY, max_uses: 10 }, f.day(5));
    f.rules.use(rule.key_hash, hash(TASK), f.day(6));
    const { rule: withDelete } = await f.rules.accept(suggestion!.key_hash, { deletes: true }, f.day(6));
    expect(withDelete).toMatchObject({ expires_at: f.day(12), max_uses: 10, uses_remaining: 9 });
    // Bounds the owner gives are a new rule's own.
    const g = fixture();
    for (const n of [1, 2, 3, 4, 5]) await g.occasion(n, [{ signature: TASK }, { signature: CLEAR }], 'clear my done tasks');
    const [open] = await g.rules.listSuggestions(g.day(5));
    await g.rules.accept(open!.key_hash, { ttl_ms: 7 * DAY, max_uses: 10 }, g.day(5));
    const { rule: given } = await g.rules.accept(open!.key_hash, { deletes: true, max_uses: 50 }, g.day(6));
    expect(given).toMatchObject({ max_uses: 50, uses_remaining: 50, expires_at: g.day(6) + CHAIN_RULE_TTL_MS });
  });

  it('"not the delete": the chain stays, and the delete is never offered again', async () => {
    const f = fixture();
    for (const n of [1, 2, 3, 4, 5]) await f.occasion(n, [{ signature: TASK }, { signature: CLEAR }], 'clear my done tasks');
    const [suggestion] = await f.rules.listSuggestions(f.day(5));
    await f.rules.accept(suggestion!.key_hash, {}, f.day(5));
    f.rules.dismiss(suggestion!.key_hash, 'deletes', f.day(5));
    expect(await f.rules.listSuggestions(f.day(5))).toEqual([]);
    for (const n of [6, 7, 8]) expect(await f.occasion(n, [{ signature: CLEAR }], 'clear my done tasks')).toBe(false);
    expect(await f.rules.listRules(f.day(8))).toHaveLength(1);
  });

  it('dismissed, a request is never suggested again; while it has a rule, end the rule instead', async () => {
    const f = fixture();
    for (const n of [1, 2, 3]) await f.occasion(n, [{ signature: SEND }]);
    const [suggestion] = await f.rules.listSuggestions(f.day(3));
    f.rules.dismiss(suggestion!.key_hash, 'all', f.day(3));
    for (const n of [4, 5, 6, 7]) expect(await f.occasion(n, [{ signature: SEND }])).toBe(false);
    expect(await f.rules.listSuggestions(f.day(7))).toEqual([]);
    await expect(f.rules.accept(suggestion!.key_hash, {}, f.day(7))).rejects.toThrow(/dismissed for good/);

    const g = fixture();
    for (const n of [1, 2, 3]) await g.occasion(n, [{ signature: SEND }]);
    const [open] = await g.rules.listSuggestions(g.day(3));
    await g.rules.accept(open!.key_hash, {}, g.day(3));
    expect(() => g.rules.dismiss(open!.key_hash, 'all', g.day(3))).toThrow(/end the rule instead/);
  });

  it('ended, its rule is spent no more and its request is never suggested again', async () => {
    const f = fixture();
    for (const n of [1, 2, 3]) await f.occasion(n, [{ signature: SEND }]);
    const [suggestion] = await f.rules.listSuggestions(f.day(3));
    const { rule } = await f.rules.accept(suggestion!.key_hash, {}, f.day(3));
    expect(await f.rules.revoke(rule.rule_id, f.day(4))).toMatchObject({ rule_id: rule.rule_id, revoked_at: f.day(4) });
    expect(f.rules.use(rule.key_hash, hash(SEND), f.day(4))).toBeUndefined();
    expect(await f.rules.listRules(f.day(4))).toEqual([]);
    for (const n of [5, 6, 7]) expect(await f.occasion(n, [{ signature: SEND }])).toBe(false);
    await expect(f.rules.revoke('no-such-rule', f.day(7))).rejects.toThrow(/no chain rule/);
  });

  it('an undo of a change a call on the live rule made ends it, but not for good', async () => {
    const f = fixture();
    for (const n of [1, 2, 3]) await f.occasion(n, [{ signature: SEND }]);
    const [suggestion] = await f.rules.listSuggestions(f.day(3));
    const { rule } = await f.rules.accept(suggestion!.key_hash, {}, f.day(3));
    const changes: string[] = [];
    f.rules.onChange((change) => changes.push(`${change.op}:${change.rule_id}`));
    const ended = recordChainUndo({ chainEvidence: f.evidence, chainRules: f.rules, now: () => f.day(4) },
      { run_id: lastRun(f), receipt_id: 'lmr_1' });
    expect(ended).toEqual({ rule_id: rule.rule_id, key_hash: rule.key_hash, uses_remaining: 100, at: f.day(4) });
    expect(changes).toEqual([`revoke:${rule.rule_id}`]);
    expect(await f.rules.listRules(f.day(4))).toEqual([]);
    expect(f.rules.use(rule.key_hash, hash(SEND), f.day(4))).toBeUndefined();
    // Not for good, as an End is: three occasions after the undo suggest it again, and the owner is told.
    expect(await f.occasion(5, [{ signature: SEND }])).toBe(false);
    expect(await f.occasion(6, [{ signature: SEND }])).toBe(false);
    expect(await f.occasion(7, [{ signature: SEND }])).toBe(true);
  });

  it('an undo of a change the live rule does not hold leaves the rule', async () => {
    const f = fixture();
    for (const n of [1, 2, 3]) await f.occasion(n, [{ signature: SEND }]);
    const [suggestion] = await f.rules.listSuggestions(f.day(3));
    const { rule } = await f.rules.accept(suggestion!.key_hash, {}, f.day(3));
    // A task approved beside the rule, then undone.
    await f.occasion(4, [{ signature: TASK }]);
    expect(recordChainUndo({ chainEvidence: f.evidence, chainRules: f.rules, now: () => f.day(5) },
      { run_id: lastRun(f), receipt_id: 'lmr_1' })).toBeUndefined();
    expect(f.rules.use(rule.key_hash, hash(SEND), f.day(5))).toMatchObject({ rule_id: rule.rule_id, uses_remaining: 99 });
    // So does an undo of another request's change, or of one no request held.
    expect(recordChainUndo({ chainEvidence: f.evidence, chainRules: f.rules, now: () => f.day(5) },
      { run_id: 'run-elsewhere', receipt_id: 'lmr_2' })).toBeUndefined();
    expect(await f.rules.listRules(f.day(5))).toHaveLength(1);
  });

  it('an undo of a change the rule itself made, its commit naming it: the rule ends, and its request is reset though it held nothing', async () => {
    const f = fixture();
    for (const n of [1, 2, 3]) await f.occasion(n, [{ signature: SEND }]);
    const [suggestion] = await f.rules.listSuggestions(f.day(3));
    const { rule } = await f.rules.accept(suggestion!.key_hash, {}, f.day(3));
    const changes: string[] = [];
    f.rules.onChange((change) => changes.push(`${change.op}:${change.rule_id}`));
    // Made on day 4 with no ask (no run of it was held), undone on day 5.
    expect(recordChainUndo({ chainEvidence: f.evidence, chainRules: f.rules, now: () => f.day(5) },
      { run_id: 'run-ruled', receipt_id: 'lmr_1', chain_rule_id: rule.rule_id }))
      .toEqual({ rule_id: rule.rule_id, key_hash: rule.key_hash, uses_remaining: 100, at: f.day(5) });
    expect(changes).toEqual([`revoke:${rule.rule_id}`]);
    expect(await f.rules.listRules(f.day(5))).toEqual([]);
    // Kept once per change.
    expect(f.rules.endRuleForUndo(rule.rule_id, 'lmr_1', f.day(5) + 1)).toBeUndefined();
    expect(f.db.prepare('SELECT count(*) FROM chain_rule_undos').pluck().get()).toBe(1);
    // Not for good, and reset as of the undo: days 1 to 3 no longer count.
    expect(await f.occasion(6, [{ signature: SEND }])).toBe(false);
    expect(await f.occasion(7, [{ signature: SEND }])).toBe(false);
    expect(await f.occasion(8, [{ signature: SEND }])).toBe(true);
  });

  it('a rule the owner ended for good stays so; a rule no store knows changes nothing', async () => {
    const f = fixture();
    for (const n of [1, 2, 3]) await f.occasion(n, [{ signature: SEND }]);
    const [suggestion] = await f.rules.listSuggestions(f.day(3));
    const { rule } = await f.rules.accept(suggestion!.key_hash, {}, f.day(3));
    await f.rules.revoke(rule.rule_id, f.day(4));
    expect(f.rules.endRuleForUndo(rule.rule_id, 'lmr_1', f.day(5))).toBeUndefined();
    for (const n of [6, 7, 8]) expect(await f.occasion(n, [{ signature: SEND }])).toBe(false);
    expect(f.rules.endRuleForUndo('no-such-rule', 'lmr_2', f.day(9))).toBeUndefined();
  });

  it('the owner is told, in the words they asked in, and the end is audited as an End is', async () => {
    const f = fixture();
    for (const n of [1, 2, 3]) await f.occasion(n, [{ signature: SEND }]);
    const [suggestion] = await f.rules.listSuggestions(f.day(3));
    const { rule } = await f.rules.accept(suggestion!.key_hash, {}, f.day(3));
    const notify = vi.fn(async () => undefined);
    const logActivity = vi.fn(async () => undefined);
    tellChainRuleEndedByUndo({ chainRules: f.rules, preflightNotifier: { notify } as never, auditLog: { logActivity } },
      { rule_id: rule.rule_id, key_hash: rule.key_hash, uses_remaining: 100, at: f.day(4) });
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify).toHaveBeenCalledWith({
      title: 'A rule ended because you undid a change',
      text: expect.stringContaining('You undid a change made when you asked "Tell Ann the new time".'),
    });
    expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'chain_rule_revoked', target: rule.rule_id,
      detail: JSON.stringify({ key_hash: rule.key_hash, uses_remaining: 100, ended_by: 'undo' }) }));
  });

  it('a rule that ran out: its request is suggested again on the next occasion, as D-329\'s is', async () => {
    const f = fixture();
    for (const n of [1, 2, 3]) await f.occasion(n, [{ signature: SEND }]);
    const [suggestion] = await f.rules.listSuggestions(f.day(3));
    await f.rules.accept(suggestion!.key_hash, { ttl_ms: DAY }, f.day(3));
    // Past its day the send asks again; answered, the month's occasions still hold.
    expect(await f.occasion(5, [{ signature: SEND }])).toBe(true);
    expect((await f.rules.listSuggestions(f.day(5)))[0]!.rule_id).toBeUndefined();
  });
});

describe('D-348 — Live control is told of each change to a rule', () => {
  it('made, used, replaced by a longer chain, and ended: each once, as it happens', async () => {
    const f = fixture();
    const changes: Array<{ op: string; rule_id: string }> = [];
    const stop = f.rules.onChange((change) => changes.push({ ...change }));
    for (const n of [1, 2, 3]) await f.occasion(n, [{ signature: SEND }]);
    const [first] = await f.rules.listSuggestions(f.day(3));
    const { rule } = await f.rules.accept(first!.key_hash, {}, f.day(3));
    expect(changes).toEqual([{ op: 'mint', rule_id: rule.rule_id }]);
    // A use spent is told; a call not on it, which spends nothing, is not.
    f.rules.use(rule.key_hash, hash(SEND), f.day(4));
    f.rules.use(rule.key_hash, hash(TASK), f.day(4));
    expect(changes.slice(1)).toEqual([{ op: 'use', rule_id: rule.rule_id }]);
    // A longer chain accepted ends the older rule, then makes its own.
    for (const n of [4, 5, 6]) await f.occasion(n, [{ signature: TASK }]);
    const [longer] = await f.rules.listSuggestions(f.day(6));
    const { rule: next } = await f.rules.accept(longer!.key_hash, {}, f.day(6));
    expect(changes.slice(2)).toEqual([{ op: 'revoke', rule_id: rule.rule_id }, { op: 'mint', rule_id: next.rule_id }]);
    await f.rules.revoke(next.rule_id, f.day(7));
    expect(changes.slice(4)).toEqual([{ op: 'revoke', rule_id: next.rule_id }]);
    // Once no longer listening, nothing more.
    stop();
    for (const n of [8, 9, 10]) await f.occasion(n, [{ signature: TASK }], 'Add the review task');
    const [another] = await f.rules.listSuggestions(f.day(10));
    await f.rules.accept(another!.key_hash, {}, f.day(10));
    expect(changes).toHaveLength(5);
  });

  it('a listener that throws changes nothing: the rule is made, used and ended all the same', async () => {
    const f = fixture();
    f.rules.onChange(() => { throw new Error('the bus is down'); });
    for (const n of [1, 2, 3]) await f.occasion(n, [{ signature: SEND }]);
    const [suggestion] = await f.rules.listSuggestions(f.day(3));
    const { rule } = await f.rules.accept(suggestion!.key_hash, {}, f.day(3));
    expect(f.rules.use(rule.key_hash, hash(SEND), f.day(4))).toMatchObject({ uses_remaining: 99 });
    await expect(f.rules.revoke(rule.rule_id, f.day(5))).resolves.toMatchObject({ revoked_at: f.day(5) });
  });
});
