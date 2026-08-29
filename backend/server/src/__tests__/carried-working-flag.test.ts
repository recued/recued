import { describe, expect, it } from 'vitest';

import { composeChatMainTurnPromptParts } from '../chat-turn-executor.js';

/** EXPERIMENT flag `RECUED_CARRY_REASONING` — the packet half.
 *
 *  ⛔ OFF BY DEFAULT AND THE DEFAULT IS THE ASSERTION. An experiment that
 *  quietly ships is not an experiment; the whole point of the flag is that the
 *  effect gets MEASURED before anyone argues about it. */
describe('prior_working_unverified rides the packet only when asked for', () => {
  const base = {
    content: { chat_tail: [], user_message: 'what is the invoice total?' },
    available_tools: [],
  } as never;

  it('is absent from the wire when no working was carried', () => {
    const { body } = composeChatMainTurnPromptParts(base);
    expect(body).not.toContain('prior_working_unverified');
  });

  it('serialises BEFORE prior_tool_calls, so the freshest evidence stays last', () => {
    const { body } = composeChatMainTurnPromptParts({
      ...(base as object),
      prior_working_unverified: 'MARKER-WORKING',
      prior_tool_calls: [{
        tool_name: 'mail.search', tier: 1, args: {}, status: 'ok',
        result: { matches: [] }, started_at: 1, completed_at: 2,
      }],
    } as never);
    const w = body.indexOf('prior_working_unverified');
    const p = body.indexOf('prior_tool_calls');
    expect(w).toBeGreaterThan(-1);
    expect(p).toBeGreaterThan(-1);
    // ⛔ THE ORDER IS THE ASSERTION, not the presence. Unverified model working
    // must not sit closer to the generation point than the results it reasons
    // about — that is the same key-order argument the reasoning field itself
    // rests on, applied one level up.
    expect(w).toBeLessThan(p);
  });
});

/** The verify-pass flag's packet half. Same posture as the carry flag: dark by
 *  default, and the default is what the test asserts. */
describe('draft_for_review rides the packet only when asked for', () => {
  const base = {
    content: { chat_tail: [], user_message: 'what is the invoice total?' },
    available_tools: [],
  } as never;

  it('is absent from the wire by default', () => {
    const { body } = composeChatMainTurnPromptParts(base);
    expect(body).not.toContain('draft_for_review');
  });

  it('serialises LAST — it is the newest turn-internal signal', () => {
    const { body } = composeChatMainTurnPromptParts({
      ...(base as object),
      draft_for_review: 'DRAFT-MARKER',
      prior_tool_calls: [{
        tool_name: 'mail.search', tier: 1, args: {}, status: 'ok',
        result: { matches: [] }, started_at: 1, completed_at: 2,
      }],
    } as never);
    expect(body.indexOf('draft_for_review')).toBeGreaterThan(body.indexOf('prior_tool_calls'));
  });
});
