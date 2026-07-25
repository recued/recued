/** §5 — `core-<bare>` kernel aliases must route through the contracted-AI layer
 *  byte-identically to their bare slug. The slug is load-bearing (CONTRACTED_SLUGS
 *  membership, the prompt-builder switch, the output-parser switch, batch
 *  capability), so each consumer strips the `core-` prefix on read. */
import { describe, it, expect } from 'vitest';
import { CORE_CAPABILITY_SLUGS, isBatchCapableAISlug } from '@recued/contracts';
import { CONTRACTED_SLUGS, isContractedSlug, buildContractedPrompt } from '../prompts.js';
import { parseContractedOutput } from '../parse.js';
import { deriveRequires } from '../executor.js';
import type { IngredientManifest } from '@recued/contracts';

const aiManifest = (slug: string): IngredientManifest => ({
  slug, name: 'x', description: 'x', author: 'recued-core',
  kind: 'ai', category: 'ai', risk_tier: 'read', input: {}, output: {},
});

describe('§5 core- prefix normalization in the contracted-AI layer', () => {
  it('drift guard — every contracted slug is a core capability', () => {
    for (const s of CONTRACTED_SLUGS) {
      expect(CORE_CAPABILITY_SLUGS.has(s)).toBe(true);
    }
  });

  it('isContractedSlug accepts the core- alias and rejects non-core', () => {
    expect(isContractedSlug('ai-classify')).toBe(true);
    expect(isContractedSlug('core-ai-classify')).toBe(true);
    expect(isContractedSlug('core-ai-rewrite')).toBe(true);
    expect(isContractedSlug('core-http-fetch')).toBe(false);
    expect(isContractedSlug('ai-prompt')).toBe(false);
    expect(isContractedSlug('core-ai-prompt')).toBe(false); // ai-prompt is uncontracted
  });

  it('buildContractedPrompt builds an identical prompt for the core- alias', () => {
    const input = {
      'llm.data': 'A deal worth $40k closing next week.',
      'llm.categories': ['hot', 'warm', 'cold'],
      'llm.context': 'classify deal heat',
    };
    expect(buildContractedPrompt('core-ai-classify', input))
      .toEqual(buildContractedPrompt('ai-classify', input));
  });

  it('parseContractedOutput validates the core- alias identically', () => {
    const raw = JSON.stringify({ category: 'hot', confidence: 0.9, reasoning: 'big deal' });
    expect(parseContractedOutput('core-ai-classify', raw))
      .toEqual(parseContractedOutput('ai-classify', raw));
    // A malformed payload still fails for the alias.
    expect(parseContractedOutput('core-ai-classify', '{"category":"hot"}')).toBeNull();
  });

  it('§5 egress neutralization — llm.allow_search is forced off for every core- AI slug', () => {
    const searchOn = { 'llm.allow_search': true };
    // Kernel BARE slugs (trusted bundled recipes) keep web search.
    expect(deriveRequires(aiManifest('ai-prompt'), searchOn).needs_search).toBe(true);
    expect(deriveRequires(aiManifest('ai-classify'), searchOn).needs_search).toBe(true);
    // Publishable core- slugs (the only kind a published recipe may carry) get NO
    // web-search egress — not just core-ai-prompt, every core- AI slug.
    expect(deriveRequires(aiManifest('core-ai-prompt'), searchOn).needs_search).toBe(false);
    expect(deriveRequires(aiManifest('core-ai-extract'), searchOn).needs_search).toBe(false);
    // Without the flag, search is off regardless.
    expect(deriveRequires(aiManifest('ai-prompt'), {}).needs_search).toBe(false);
  });

  it('isBatchCapableAISlug accepts the core- alias for batch-capable slugs only', () => {
    expect(isBatchCapableAISlug('core-ai-classify')).toBe(true);
    expect(isBatchCapableAISlug('ai-classify')).toBe(true);
    // ai-compare is the lone non-batch contracted slug — its alias is non-batch too.
    expect(isBatchCapableAISlug('core-ai-compare')).toBe(false);
    expect(isBatchCapableAISlug('core-notification-send')).toBe(false);
  });
});
