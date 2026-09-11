/** D-213 — recall RECEIPTS.
 *
 *  Recall results are non-retainable (PII egress), so `partitionPriorToolCalls`
 *  routes them out of `prior_tool_calls`. Dropping the CALL along with its
 *  result erased the model's record of having made it, which is what these
 *  tests pin: the dispatch survives, the recalled content does not.
 */
import { describe, expect, it } from 'vitest';

import {
  NON_RETAINABLE_RECALL_TOOL_NAMES,
  partitionPriorToolCalls,
  RECALL_RECEIPT_RESULT,
  toRecallReceipt,
  withRecallReceipts,
  type ChatPriorToolCall,
} from '../index.js';

const SECRET = 'Dana Reyes drew 1695 units at the ring 09 checkpoint';

/** A recall dispatch — its result holds the owner's recalled content. */
const call = (tool_name: string, query: string): ChatPriorToolCall => ({
  tool_name,
  tier: 1,
  args: { query },
  status: 'ok',
  result: { memories: [{ memory_id: 'umem_1', body: SECRET }] },
  started_at: 10,
  completed_at: 20,
});

/** A retained dispatch. Its result must survive UNTOUCHED, so it deliberately
 *  carries no recalled content — a fixture that put `SECRET` here would make
 *  "no secret in the projection" fail for the correct behaviour. */
const retainedCall = (tool_name: string, query: string): ChatPriorToolCall => ({
  tool_name,
  tier: 1,
  args: { query },
  status: 'ok',
  result: { entities: [{ id: 'we1:note:1', title: 'Kestrel ring 05' }] },
  started_at: 10,
  completed_at: 20,
});

describe('D-213 recall receipt', () => {
  it('drops the recalled result and keeps the model-authored args', () => {
    const receipt = toRecallReceipt(call('memory.search', 'ring 09 cost'));

    expect(JSON.stringify(receipt)).not.toContain(SECRET);
    expect(JSON.stringify(receipt)).not.toContain('umem_1');
    expect((receipt.result as {retained:boolean}).retained).toBe(false);
    // The dispatch's own identity survives intact — this is the feedback.
    expect(receipt.args).toEqual({ query: 'ring 09 cost' });
    expect(receipt.tool_name).toBe('memory.search');
    expect(receipt.tier).toBe(1);
    expect(receipt.status).toBe('ok');
    expect(receipt.started_at).toBe(10);
    expect(receipt.completed_at).toBe(20);
  });

  it('states the result existed, so an empty store is not implied', () => {
    // ⛔ A receipt with NO result reads as "this query returned nothing" — a
    // false signal about the owner's store. The note is what forbids that read.
    expect(RECALL_RECEIPT_RESULT.retained).toBe(false);
    // ⛔ ASSERT THE CLAIM, NOT THE WORD. When the note was rescoped from query
    //   to tool it stopped containing the contiguous "not retained", and the
    //   assertion was WEAKENED to /retained/i to keep it green — which matches
    //   "Recall results ARE retained here" just as happily, i.e. it could no
    //   longer tell the invariant from its exact negation. Pin the statement.
  });

  // ⛔⛔ THE INVARIANT THE OLD WORDING TRIED TO CARRY, NOW STRUCTURAL. The note
  //   had to say non-retention was "a property of the TOOL, not of the query",
  //   because an earlier wording scoped it to "the same query" and the model
  //   correctly inferred a DIFFERENT query might retain — task 343 turn 7 walked
  //   "ring 01 checkpoint cost" -> "ring 01 cost" -> "ring 01 checkpoint cost
  //   units" -> back again, four rounds, never reaching a retaining tool.
  //
  //   🔑 A RECEIPT THAT SAYS NOTHING ABOUT THE QUERY CANNOT IMPLY ANYTHING
  //   ABOUT IT. The body no longer varies with `args` at all, so the
  //   query-scoped reading is unavailable by construction rather than by
  //   wording — and `match_count` supplies the one query-specific fact that IS
  //   true, as data.
  it('⛔ the receipt body never varies with the query', () => {
    const mk = (query: string) => toRecallReceipt({
      tool_name: 'recall.search', tier: 1, args: { query }, status: 'ok',
      result: { ok: true, matches: [] },
    } as never).result as Record<string, unknown>;
    const a = mk('ring 01 checkpoint cost');
    const b = mk('ring 01 cost');
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).not.toMatch(/ring 01/i);
    expect(a.retained).toBe(false);
  });

  it('passes an errored recall dispatch through untouched', () => {
    // No result was produced, so there is nothing to drop, and `reason` is the
    // whole signal. Substituting a result here would contradict status:'error'.
    const errored: ChatPriorToolCall = {
      tool_name: 'memory.search',
      tier: 1,
      args: { query: 'x' },
      status: 'error',
      reason: 'execution_error',
      detail: 'store unavailable',
      started_at: 0,
      completed_at: 1,
    };
    expect(toRecallReceipt(errored)).toBe(errored);
  });

  it('replaces only recall calls, preserving order and identity of the rest', () => {
    const work = retainedCall('work.search', 'kestrel');
    const mem = call('memory.search', 'kestrel');
    const read = retainedCall('work.read', 'note-1');

    const projected = withRecallReceipts([work, mem, read]);

    expect(projected).toHaveLength(3);
    expect(projected[0]).toBe(work); // untouched by identity
    expect(projected[2]).toBe(read);
    expect(projected[1]).not.toBe(mem);
    expect((projected[1]?.result as {retained:boolean}).retained).toBe(false);
    expect(JSON.stringify(projected)).not.toContain(SECRET);
    // Non-recall results are retained in full — the receipt is narrow.
    expect(projected[0]?.result).toEqual(work.result);
  });

  it('leaves the model a visible record when EVERY call was a recall', () => {
    // 🔑 THE REGRESSION. This is the shape that looped: an all-recall turn
    // partitioned to `prior: []`, so the model saw no dispatch history at all
    // and re-issued the identical query after every trim.
    const calls = [
      call('memory.search', 'ring 05 checkpoint cost'),
      call('memory.search', 'ring 06 checkpoint cost'),
    ];

    expect(partitionPriorToolCalls(calls).prior).toEqual([]);

    const projected = withRecallReceipts(calls);
    expect(projected).toHaveLength(2);
    expect(JSON.stringify(projected)).toContain('ring 05 checkpoint cost');
    expect(JSON.stringify(projected)).toContain('ring 06 checkpoint cost');
    expect(JSON.stringify(projected)).not.toContain(SECRET);
  });

  it('covers every non-retainable tool name, not just memory.search', () => {
    for (const name of NON_RETAINABLE_RECALL_TOOL_NAMES) {
      const [projected] = withRecallReceipts([call(name, 'q')]);
      expect((projected?.result as {retained:boolean}).retained).toBe(false);
    }
  });

  it('is a no-op for an empty list', () => {
    expect(withRecallReceipts([])).toEqual([]);
  });

  // ⛔⛔ THE RECEIPT REPORTS WHAT HAPPENED, IT DOES NOT ADVISE. The old body
  //   carried a `note` whose claims were checkable and two were FALSE — it said
  //   the result "was shown to you at the time" (untrue once a fold has passed,
  //   and receipts survive folds) and that asking again yields "another line
  //   like this one and nothing more" (untrue — a fresh call returns fresh
  //   content). A tool result carrying advice is a prompt, and it cannot be
  //   benched apart from retrieval.
  it('⛔ carries NO advisory prose — only the record', () => {
    const receipt = toRecallReceipt({
      tool_name: 'recall.search', tier: 1, args: { query: 'x' }, status: 'ok',
      result: { ok: true, matches: [] },
    } as never);
    const body = receipt.result as Record<string, unknown>;
    expect(body.note).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/should|try|instead|do not|rephras/i);
  });

  // 🔑 The count is what makes an unretained result honest: it distinguishes
  //   "the QUERY missed" from "the query hit and only the CONTENT is gone" —
  //   the exact inference the removed prose asserted without evidence.
  it('reports match_count so a miss is distinguishable from a hit', () => {
    const miss = toRecallReceipt({
      tool_name: 'recall.search', tier: 1, args: {}, status: 'ok',
      result: { ok: true, matches: [] },
    } as never);
    expect((miss.result as { match_count?: number }).match_count).toBe(0);

    const hit = toRecallReceipt({
      tool_name: 'memory.search', tier: 1, args: {}, status: 'ok',
      result: { memories: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
    } as never);
    expect((hit.result as { match_count?: number }).match_count).toBe(3);
  });

  it('omits match_count on an unrecognised shape rather than asserting zero', () => {
    const odd = toRecallReceipt({
      tool_name: 'recall.search', tier: 1, args: {}, status: 'ok',
      result: { some_future_field: 'x' },
    } as never);
    expect((odd.result as { match_count?: number }).match_count).toBeUndefined();
    expect((odd.result as { retained: boolean }).retained).toBe(false);
  });

  // ⛔⛔ THE POINTER MUST NEVER OUTLIVE THE THING IT POINTS AT. On first
  //   projection the live result is moved into this packet's `recall_context`,
  //   so naming it is a fact. A receipt that SURVIVES A FOLD is re-projected,
  //   and then `recall_context` holds receipts only — verified live on 343
  //   (2026-09-08 ac2-noanticalc-2), where post-fold packets alternate between
  //   live content and receipts-only. Keeping the pointer there would send the
  //   model to another copy of this same receipt.
  it('points at recall_context on first projection', () => {
    const r = toRecallReceipt({
      tool_name: 'recall.search', tier: 1, args: {}, status: 'ok',
      result: { ok: true, matches: [{ item_id: 'a' }, { item_id: 'b' }] },
    } as never).result as Record<string, unknown>;
    expect(r.result_in).toBe('recall_context');
    expect(r.match_count).toBe(2);
    expect(r.retained).toBe(false);
  });

  it('⛔ DROPS the pointer when a receipt is re-projected after a fold', () => {
    const once = toRecallReceipt({
      tool_name: 'recall.search', tier: 1, args: {}, status: 'ok',
      result: { ok: true, matches: [{ item_id: 'a' }] },
    } as never);
    expect((once.result as Record<string, unknown>).result_in).toBe('recall_context');

    // The survivor path: the receipt itself is projected again.
    const twice = toRecallReceipt(once as never).result as Record<string, unknown>;
    expect(twice.result_in).toBeUndefined();   // nowhere to point
    expect(twice.match_count).toBe(1);          // still true
    expect(twice.retained).toBe(false);
    // And it must be STABLE — a third projection changes nothing further.
    const thrice = toRecallReceipt({ ...once, result: twice }).result;
    expect(thrice).toEqual(twice);
  });
});
