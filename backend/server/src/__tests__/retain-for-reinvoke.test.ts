/** ⚗ In-turn retention — the invariant that the CURRENT round is never cut.
 *
 *  ⛔ THIS TEST EXISTS BECAUSE ITS ABSENCE COST TWO LIVE BATCHES. The first
 *  version of the knob truncated in `composeChatMainTurnPromptParts`, which
 *  cannot see round boundaries, so the model was handed one of the three
 *  results it had just requested. The provider-fault rate then tracked the
 *  treatment monotonically — keep=ALL 10% · keep=3 78% · keep=2 78% ·
 *  keep=1 100%, against a 2.2% bench-wide base rate — and every retention
 *  number from those runs was void. Nothing in code or test would have said so.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { retainForReinvoke } from '../chat-turn-executor.js';
import type { ChatPriorToolCall } from '@recued/contracts';

const call = (n: number): ChatPriorToolCall =>
  ({ tool_name: `t${n}`, tier: 1, args: {}, status: 'ok', result: {} } as unknown as ChatPriorToolCall);
const names = (xs: readonly ChatPriorToolCall[]) => xs.map((x) => x.tool_name);

describe('retainForReinvoke', () => {
  const all = [call(1), call(2), call(3), call(4), call(5), call(6)];
  const ROUND_START = 3; // t4,t5,t6 are THIS round

  afterEach(() => { delete process.env.RECUED_CHAT_PRIOR_TOOL_CALLS_KEEP; });

  it('keeps everything when the knob is absent — the default path is untouched', () => {
    expect(names(retainForReinvoke(all, ROUND_START))).toEqual(['t1','t2','t3','t4','t5','t6']);
  });

  it('⛔ NEVER cuts the current round, even at keep=0', () => {
    process.env.RECUED_CHAT_PRIOR_TOOL_CALLS_KEEP = '0';
    expect(names(retainForReinvoke(all, ROUND_START))).toEqual(['t4','t5','t6']);
  });

  it('counts `keep` against EARLIER rounds only', () => {
    process.env.RECUED_CHAT_PRIOR_TOOL_CALLS_KEEP = '2';
    // 2 of the 3 older entries, plus the whole current round
    expect(names(retainForReinvoke(all, ROUND_START))).toEqual(['t2','t3','t4','t5','t6']);
  });

  it('drops the OLDEST first, not the newest', () => {
    process.env.RECUED_CHAT_PRIOR_TOOL_CALLS_KEEP = '1';
    expect(names(retainForReinvoke(all, ROUND_START))).toEqual(['t3','t4','t5','t6']);
  });

  it('a keep larger than the history is a no-op, not an error', () => {
    process.env.RECUED_CHAT_PRIOR_TOOL_CALLS_KEEP = '99';
    expect(names(retainForReinvoke(all, ROUND_START))).toEqual(['t1','t2','t3','t4','t5','t6']);
  });

  it('an invalid value keeps everything rather than silently truncating', () => {
    for (const bad of ['', 'abc', '-1']) {
      process.env.RECUED_CHAT_PRIOR_TOOL_CALLS_KEEP = bad;
      expect(names(retainForReinvoke(all, ROUND_START)), `value: ${bad}`).toHaveLength(6);
    }
  });

  it('the FIRST round has no earlier history, so nothing can be cut', () => {
    process.env.RECUED_CHAT_PRIOR_TOOL_CALLS_KEEP = '0';
    expect(names(retainForReinvoke([call(1), call(2)], 0))).toEqual(['t1','t2']);
  });
});
