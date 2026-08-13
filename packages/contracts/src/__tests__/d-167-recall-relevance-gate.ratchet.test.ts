/** D-167 — recall relevance-gate descriptor ratchet.
 *
 *  The relevance gate (design §3/§6 of
 *  D-167) is the SOFTER,
 *  within-session half of the §2 ambiguity gate: the agent should skip
 *  `memory.search` when the answer is already in the current conversation
 *  (`chat_tail`) — `memory.search`'s real job is CROSS-SESSION recall (earlier
 *  sessions / older history / raw context the conversation never carried), not
 *  re-fetching what was already said. It is enacted as agent-read copy in the
 *  `memory.search` Tier-1 descriptor (LLM-read at runtime, § A.13), which flows into
 *  every turn's `available_tools`. These tests pin that guidance so it can't silently
 *  regress.
 */

import { describe, expect, it } from 'vitest';
import { TIER1_TOOL_DESCRIPTORS } from '../chat.js';

describe('D-167 — memory.search recall relevance gate', () => {
  const memorySearchDescription =
    TIER1_TOOL_DESCRIPTORS['memory.search'].description;

  it('frames memory.search as CROSS-SESSION recall', () => {
    expect(memorySearchDescription).toMatch(/cross-session/i);
  });

  it('directs the agent NOT to re-fetch what is already in this conversation', () => {
    expect(memorySearchDescription).toMatch(/do not call it to re-fetch/i);
    expect(memorySearchDescription).toMatch(/this conversation/i);
  });
});

/* 2026-08-11 — the match-quality signals are worth exactly as much as the
 * instruction that comes with them.
 *
 * `match` and `top_margin` are emitted so the agent can tell an answer from a
 * best-guess, but a field the model has not been told how to READ is noise it
 * pays context for. The whole value is the behavioural clause — "treat them as
 * candidates, never as the answer" on a loose match, "do not silently pick one"
 * on a flat margin. Shipping the fields without the copy would be a measurable
 * cost with no measurable benefit, so the copy is pinned. */
describe('memory.search — match / top_margin agent guidance', () => {
  const memorySearchDescription =
    TIER1_TOOL_DESCRIPTORS['memory.search'].description;

  it('names all four match kinds', () => {
    for (const kind of ['exact', 'relaxed', 'loose', 'semantic']) {
      expect(memorySearchDescription).toContain(`\`${kind}\``);
    }
  });

  it('⛔ tells the agent a SEMANTIC hit shares no words and must be checked', () => {
    // Rung 4 fires only when nothing lexical matched, so the entry was found by
    // meaning alone — a stronger claim than any lexical rung makes, and the one
    // most worth verifying before it becomes an answer.
    expect(memorySearchDescription).toMatch(/by MEANING alone/i);
    expect(memorySearchDescription).toMatch(/check the entry is really about/i);
  });

  it('⛔ tells the agent a LOOSE match is candidates, not an answer', () => {
    expect(memorySearchDescription).toMatch(/candidates/i);
    expect(memorySearchDescription).toMatch(/never as the answer/i);
    // …and to say so out loud rather than answering with a straight face.
    expect(memorySearchDescription).toMatch(/approximate/i);
  });

  it('⛔ tells the agent a LOW top_margin forbids silently picking a winner', () => {
    expect(memorySearchDescription).toContain('top_margin');
    expect(memorySearchDescription).toMatch(/must not silently pick one|not silently pick/i);
  });

  /* ⛔ The pool must stop SOLICITING what it cannot maintain.
   *
   * `kind` is a free-form string and there is no supersede / current-value
   * machinery anywhere in `user_memory` — verified, not assumed. A preference
   * is STATE, not an observation: when it changes, the old value is wrong
   * rather than historical. Stored here, both survive, and the retrieval work
   * makes that legible rather than harmless — two contradictory preferences
   * match equally, `top_margin` lands near 0, and the agent is told it "must
   * not silently pick one". The result is an assistant asking the owner which
   * of their own preferences is current, forever.
   *
   * Removing the invitation is not enough on its own: "a fact worth
   * persisting" still describes a preference, so the ban has to be explicit. */
  it('⛔ REFUSES preferences — the pool cannot supersede, so it must not invite state', () => {
    const write = TIER1_TOOL_DESCRIPTORS['memory.write'].description;
    expect(write).toMatch(/do NOT use it for PREFERENCES/i);
    expect(write).toMatch(/never supersedes/i);
    // The reason travels with the rule; a bare prohibition gets rationalised away.
    expect(write).toMatch(/contradiction/i);
    // …and the invitation is genuinely gone, not just counter-balanced.
    expect(write).not.toMatch(/states a lasting preference/i);
    expect(write).not.toMatch(/a fact, decision, preference/i);
  });

  it('directs the agent to read `match` BEFORE using the results', () => {
    // Ordering matters: the guidance is useless if it is read after the model
    // has already composed an answer from a loose hit.
    expect(memorySearchDescription).toMatch(/read `match` before using/i);
  });
});
