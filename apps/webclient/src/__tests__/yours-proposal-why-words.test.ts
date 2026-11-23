/** Yours → a suggestion's "Why suggested" reads in the owner's words, never its codes. */
import { describe, expect, it } from 'vitest';
import { PROACTIVE_PROPOSAL_KINDS } from '@recued/contracts';

import { proposalSourceWords, proposalWhyLine } from '../yours/proposal-why-words.js';

describe('Yours: why a suggestion was made', () => {
  it('says how sure it is and what it is based on', () => {
    expect(proposalWhyLine({ confidence: 'medium', origin: 'learner' })).toBe('Somewhat sure · learned from what you did before');
    expect(proposalWhyLine({ confidence: 'high', origin: 'pack' })).toBe('Fairly sure · from a pack you installed');
    expect(proposalWhyLine({ confidence: 'low', origin: 'intake', lane: 'gift' })).toBe('Not sure · looks like a gift');
  });

  it('never shows a code, including one a newer server adds', () => {
    const line = proposalWhyLine({ confidence: 'medium', origin: 'brand_new' as never, lane: 'mystery' as never });
    expect(line).toBe('Somewhat sure');
    for (const origin of ['intake', 'owner', 'learner', 'pack'] as const) {
      for (const lane of [undefined, 'likely_asset', 'gift', 'return', 'pickup', 'bundle'] as const) {
        const text = proposalWhyLine({ confidence: 'high', origin, ...(lane ? { lane } : {}) });
        expect(text).not.toMatch(/_|learner|intake|confidence/);
        for (const kind of PROACTIVE_PROPOSAL_KINDS) expect(text).not.toContain(kind);
      }
    }
  });

  it('names an evidence record it cannot open by its kind, never its id', () => {
    expect(proposalSourceWords({ collection: 'contact' })).toBe('Based on a contact');
    expect(proposalSourceWords({ collection: 'warehouse_thing' })).toBe('Based on one of your records');
  });
});
