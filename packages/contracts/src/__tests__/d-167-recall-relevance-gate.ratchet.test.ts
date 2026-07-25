/** D-167 — recall relevance-gate descriptor ratchet.
 *
 *  The relevance gate (design §3/§6 of
 *  `docs/d-167-prefetch-index-and-recall-collision-design.md`) is the SOFTER,
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
