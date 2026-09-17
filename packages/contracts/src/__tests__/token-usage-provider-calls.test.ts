/** A per-turn token aggregate says how many provider calls it covers.
 *
 *  ⛔ WHY. `recued.token_usage` fires ONCE PER TURN with the sum across every
 *  provider call the turn made, so "one expensive call" and "three cheap ones"
 *  arrive as the same number. The long-conversation lane exists to detect a
 *  packet that GROWS with conversation length, and it read a turn at 10,706
 *  input tokens against a flat ~5,300 baseline as 2.06x growth — while the
 *  likeliest reading was two calls of ~5,300, because the model chose a tool on
 *  that turn and not on the others. The SAME prompt at two earlier turns cost
 *  ~5,300, which is what rules the prompt out. Same measure, opposite
 *  conclusions, and no way to tell them apart.
 *
 *  ⛔ THE SINGLE-REPORT PATHS ARE THE ONES THAT MATTER. The first cut only
 *  summed a count when TWO reports met, so a turn making one call — the
 *  overwhelming majority — reported nothing, and the field was absent exactly
 *  where the baseline is set. The lane printed `calls=?` on 14 of 14 turns. */

import { describe, expect, it } from 'vitest';

import { aggregateTokenUsageReports } from '../token-usage-report.js';
import type { TokenUsageReport } from '../token-usage-report.js';

const rep = (input: number, over: Partial<TokenUsageReport> = {}): TokenUsageReport => ({
  input_tokens: input,
  output_tokens: 10,
  total_tokens: input + 10,
  ...over,
});

describe('token usage: provider_calls', () => {
  it('⛔ a lone report counts as ONE call, not absent', () => {
    // The baseline case. Absent here means every quiet turn is indistinguishable
    // from an unannotated one.
    expect(aggregateTokenUsageReports(undefined, rep(5000))?.provider_calls).toBe(1);
    expect(aggregateTokenUsageReports(rep(5000), undefined)?.provider_calls).toBe(1);
  });

  it('⛔ two reports sum to two calls, and the tokens still sum', () => {
    const agg = aggregateTokenUsageReports(rep(5300), rep(5406));
    expect(agg?.provider_calls).toBe(2);
    expect(agg?.input_tokens).toBe(10_706);   // the turn this was found on
  });

  it('⛔ three calls accumulate across successive aggregations', () => {
    // The tool loop aggregates pairwise, repeatedly — a count that reset on each
    // step would under-report every loop past the first.
    let agg = aggregateTokenUsageReports(undefined, rep(100));
    agg = aggregateTokenUsageReports(agg, rep(100));
    agg = aggregateTokenUsageReports(agg, rep(100));
    expect(agg?.provider_calls).toBe(3);
    expect(agg?.input_tokens).toBe(300);
  });

  it('⛔ an un-annotated report counts as 1, never 0', () => {
    // Defaulting to zero would make an aggregate of two legacy reports claim it
    // covered no calls — worse than the ambiguity the field removes, because it
    // makes per-call arithmetic divide by zero.
    const legacy = rep(500);
    const agg = aggregateTokenUsageReports(legacy, legacy);
    expect(agg?.provider_calls).toBe(2);
  });

  it('an explicit count is preserved, not overwritten', () => {
    const pre = rep(900, { provider_calls: 4 });
    expect(aggregateTokenUsageReports(undefined, pre)?.provider_calls).toBe(4);
    expect(aggregateTokenUsageReports(pre, rep(100))?.provider_calls).toBe(5);
  });

  it('both undefined stays undefined — no phantom call', () => {
    expect(aggregateTokenUsageReports(undefined, undefined)).toBeUndefined();
  });

  it('the other fields are unchanged by the addition', () => {
    // Equivalence: this field must not perturb what the aggregate already said.
    const agg = aggregateTokenUsageReports(
      rep(100, { cache_read_input_tokens: 7, reasoning_tokens: 3 }),
      rep(200, { cache_read_input_tokens: 5 }),
    );
    expect(agg?.input_tokens).toBe(300);
    expect(agg?.output_tokens).toBe(20);
    expect(agg?.total_tokens).toBe(320);
    expect(agg?.cache_read_input_tokens).toBe(12);
    expect(agg?.reasoning_tokens).toBe(3);
  });
});

/** ⛔ `model_id` ACROSS AN AGGREGATION — amended 2026-09-16.
 *
 *  It used to drop unconditionally, justified as "the aggregate spans
 *  heterogeneous sources, so no single id applies". That is a claim about
 *  HETEROGENEOUS sources and it was being applied to every sum — so a recipe's
 *  `foreach`, which repeats ONE step against ONE slot, lost an id that nothing
 *  in the run disagreed about. The owner's question was the narrow one: the
 *  field is already there, so what does keeping it cost?
 *
 *  ⚠ THE DISAGREEMENT CASE IS WHAT MAKES THE CHANGE HONEST, and it is the half
 *  a "just keep it" fix would skip: a pool entry that round-robins across models
 *  must still produce NO id, because there is no true answer to "which model
 *  wrote this run". Absent must keep meaning "cannot say", never "nobody
 *  recorded it". */
describe('token usage: model_id survives agreement, not disagreement', () => {
  it('⛔⛔ TWO CALLS ON THE SAME MODEL — the id survives the sum', () => {
    const got = aggregateTokenUsageReports(
      rep(100, { model_id: 'claude-opus-5' }),
      rep(200, { model_id: 'claude-opus-5' }),
    );
    expect(got?.provider_calls).toBe(2);
    expect(got?.model_id).toBe('claude-opus-5');
  });

  it('⛔⛔ TWO DIFFERENT MODELS — the id is DROPPED, there is no true answer', () => {
    const got = aggregateTokenUsageReports(
      rep(100, { model_id: 'claude-opus-5' }),
      rep(200, { model_id: 'gemini-2.0-pro' }),
    );
    expect(got?.provider_calls).toBe(2);
    expect(got?.model_id).toBeUndefined();
  });

  it('⛔ ONE SIDE UNRECORDED — dropped; a later call may not speak for an earlier one', () => {
    // The asymmetric case, and the one most likely to be got wrong by a
    // `prev.model_id ?? next.model_id` shortcut: an absent id is not a wildcard.
    expect(
      aggregateTokenUsageReports(rep(100), rep(200, { model_id: 'claude-opus-5' }))?.model_id,
    ).toBeUndefined();
    expect(
      aggregateTokenUsageReports(rep(100, { model_id: 'claude-opus-5' }), rep(200))?.model_id,
    ).toBeUndefined();
  });

  it('a THREE-call chain still agrees — the survival is not just a two-report trick', () => {
    const two = aggregateTokenUsageReports(
      rep(100, { model_id: 'gpt-4o-mini' }),
      rep(100, { model_id: 'gpt-4o-mini' }),
    );
    const three = aggregateTokenUsageReports(two, rep(100, { model_id: 'gpt-4o-mini' }));
    expect(three?.provider_calls).toBe(3);
    expect(three?.model_id).toBe('gpt-4o-mini');
  });

  it('a lone report keeps its id, as it always did', () => {
    expect(aggregateTokenUsageReports(undefined, rep(50, { model_id: 'x' }))?.model_id).toBe('x');
  });
});
