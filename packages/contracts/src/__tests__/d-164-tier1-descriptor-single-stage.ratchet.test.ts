/** D-164 — single-stage descriptor vocabulary ratchet.
 *
 *  Tier 1 descriptor descriptions are LLM-read at runtime (§ A.13).
 *  D-164 retired the literal "Stage 1" / "Stage 2" two-stage wording;
 *  these tests pin the agent-facing `contact.search` copy and prevent
 *  any Tier 1 descriptor from reintroducing that vocabulary.
 */

import { describe, expect, it } from 'vitest';
import { TIER1_TOOL_DESCRIPTORS } from '../chat.js';

describe('D-164 — Tier 1 descriptor single-stage vocabulary', () => {
  const contactSearchDescription =
    TIER1_TOOL_DESCRIPTORS['contact.search'].description;

  it('keeps contact.search on agent-read outcome-selection wording', () => {
    expect(contactSearchDescription).toContain(
      'the agent reads it to choose between',
    );
  });

  it('keeps every Tier 1 descriptor free of retired Stage 1 / Stage 2 vocabulary', () => {
    for (const [name, descriptor] of Object.entries(TIER1_TOOL_DESCRIPTORS)) {
      expect(
        descriptor.description,
        `${name} descriptor reintroduced retired Stage N vocabulary`,
      ).not.toMatch(/\bStage\s+[12]\b/);
    }
  });

  it('preserves contact.search load-bearing § A.13 outcome-selection tokens', () => {
    expect(contactSearchDescription).toContain('shape.pattern');
    expect(contactSearchDescription).toContain('(1-4)');
    expect(contactSearchDescription).toContain('silent execute');
    expect(contactSearchDescription).toContain('optimistic-with-alternatives');
    expect(contactSearchDescription).toContain('refuse');
    expect(contactSearchDescription).toContain('fall-through');
    expect(contactSearchDescription).toContain('memory.search');
  });
});
