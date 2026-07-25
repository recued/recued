import { describe, expect, it } from 'vitest';

import { buildQueryContext, scorePrefetchCandidates } from '../chat-prefetch-score.js';

describe('scorePrefetchCandidates', () => {
  it('fails closed by marking fuzzy candidates ambiguous when fuzzy coverage is incomplete', () => {
    const qctx = buildQueryContext({ tokens: ['sarah'] });

    const out = scorePrefetchCandidates([
      { email: 'sarah.adams@x.com', name: 'Sarah Adams' },
      { email: 'sarah.bell@x.com', name: 'Sarah Bell' },
    ], {
      ...qctx,
      limit: 5,
      fuzzyComplete: false,
      phoneFormsComplete: true,
      isUnique: () => true,
    });

    expect(out).toHaveLength(2);
    expect(new Set(out.map((c) => c.ref))).toEqual(new Set([
      'sarah.adams@x.com',
      'sarah.bell@x.com',
    ]));
    expect(out.every((c) => c.ambiguous === true)).toBe(true);
  });

  it('keeps an exact phone hit even when the fuzzy leg is incomplete (signals are independent)', () => {
    // fuzzyComplete:false (FTS capped) must NOT suppress the store-wide-unique phone
    // path — codex review: the two completeness signals are independent.
    const qctx = buildQueryContext({ tokens: ['14155550199'] });

    const out = scorePrefetchCandidates([
      { email: 'rae@x.com', name: 'Rae Kim', phone: '+14155550199' },
    ], {
      ...qctx,
      limit: 5,
      fuzzyComplete: false,
      phoneFormsComplete: true,
      isUnique: () => true,
    });

    expect(out).toEqual([
      { ref: 'rae@x.com', label: 'Rae Kim', kind: 'contact', score: 5, pinned: true, phone: '+14155550199' },
    ]);
  });
});
