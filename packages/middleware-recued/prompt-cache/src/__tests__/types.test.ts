import { describe, it } from 'vitest';

import { mintEnvelopeId, type EnvelopeId } from '../types';

describe('EnvelopeId — brand', () => {
  it('rejects a raw string assignment without minting', () => {
    const minted: EnvelopeId = mintEnvelopeId('req-brand-ok');
    void minted;
    // @ts-expect-error — raw string is not assignable to the EnvelopeId brand.
    const raw: EnvelopeId = 'req-brand-bad';
    void raw;
  });
});
