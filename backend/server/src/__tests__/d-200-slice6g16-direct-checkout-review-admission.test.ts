/** D-200 Slice 6g.16 — exact paid admission for direct-checkout review.
 *
 * D-207 3d·6 — the phase machine is deleted; the admission keeps a NARROW
 * inline validator (see the module docstring). Fixtures here are literal row
 * shapes in the one form the V4 flow ever admitted. The state-key literal is
 * deliberate: rows were written under the machine's historical derivation, so
 * the key the admission reads must stay byte-identical to it. */

import { describe, expect, it, vi } from 'vitest';

import type { ReceptionPairBinding } from '@recued/contracts';

import { createPaidDocumentDirectCheckoutReviewAdmission } from '../paid-document-direct-checkout-review-admission.js';

const PAIR: ReceptionPairBinding = {
  version: 1,
  form_definition_id: 'form-1',
  recipe_id: 'direct-document-checkout',
  recipe_version: 3,
  pair_revision: `d200-pair-v1-${'a'.repeat(64)}`,
};
const SUBMISSION_ID = 'submission-1';
/** The retired machine's stable-row key format, pinned as a literal. */
const STATE_KEY =
  'data.shared.recipe.recued-core_paid-document-fulfillment.state.submission-1';

const paidState = (): Record<string, unknown> => ({
  schema_version: 4,
  bundle_key: 'recued-core/paid-document-fulfillment',
  submission_id: SUBMISSION_ID,
  phase: 'paid',
  revision: 3,
  checkout: {
    request: {
      source: { submission_id: SUBMISSION_ID, pair_binding: PAIR },
    },
    session_id: 'cs_direct_review',
    verified_status: 'paid',
    verified_at: 4_000,
  },
  template: {
    file_ref: 'file:abcdef0123456789abcdef0123456789',
    content_sha256: 'b'.repeat(64),
    format: 'markdown',
  },
  created_at: 1_000,
  updated_at: 4_000,
});

const stored = (
  state: Record<string, unknown>,
  casRevision: number | null = state.revision as number,
) => ({
  key: STATE_KEY,
  value: state,
  cas_revision: casRevision,
  size_bytes: 1,
  author_id: 'system',
  recipe_id: null,
  written_at: state.updated_at as number,
  last_read_at: null,
});

describe('D-200 Slice 6g.16 direct-checkout paid-review admission', () => {
  it('admits only the exact immutable v4 pair at or after verified payment', async () => {
    const state = paidState();
    const read = vi.fn(async () => stored(state));
    const admit = createPaidDocumentDirectCheckoutReviewAdmission({ read });

    await expect(admit({
      submission_id: SUBMISSION_ID,
      pair_binding: PAIR,
      approved_at: 4_000,
    })).resolves.toEqual({
      kind: 'admitted',
      state_revision: 3,
      verified_at: 4_000,
    });
    expect(read).toHaveBeenCalledWith(STATE_KEY);
  });

  it('keeps missing, unavailable, unpaid, and refunded source truth deferred', async () => {
    await expect(createPaidDocumentDirectCheckoutReviewAdmission(undefined)({
      submission_id: SUBMISSION_ID,
      pair_binding: PAIR,
    })).resolves.toEqual({ kind: 'deferred', reason: 'not_configured' });
    await expect(createPaidDocumentDirectCheckoutReviewAdmission({
      read: async () => null,
    })({
      submission_id: SUBMISSION_ID,
      pair_binding: PAIR,
    })).resolves.toEqual({ kind: 'deferred', reason: 'state_missing' });
    await expect(createPaidDocumentDirectCheckoutReviewAdmission({
      read: async () => { throw new Error('store unavailable'); },
    })({
      submission_id: SUBMISSION_ID,
      pair_binding: PAIR,
    })).resolves.toEqual({ kind: 'deferred', reason: 'source_unavailable' });

    const paid = paidState();
    const awaiting: Record<string, unknown> = {
      ...paid,
      phase: 'awaiting_payment',
      revision: 2,
      checkout: {
        ...(paid.checkout as Record<string, unknown>),
        verified_status: undefined,
        verified_at: undefined,
      },
      updated_at: 3_000,
    };
    const refunded: Record<string, unknown> = {
      ...paid,
      phase: 'refunded',
      revision: 4,
      updated_at: 5_000,
    };
    for (const state of [awaiting, refunded]) {
      const admit = createPaidDocumentDirectCheckoutReviewAdmission({
        read: async () => stored(state),
      });
      await expect(admit({
        submission_id: SUBMISSION_ID,
        pair_binding: PAIR,
      })).resolves.toEqual({ kind: 'deferred', reason: 'payment_unverified' });
    }
  });

  it('rejects a divergent pair, stale store token, and pre-payment approval', async () => {
    const state = paidState();
    const wrongPair: ReceptionPairBinding = {
      ...PAIR,
      pair_revision: `d200-pair-v1-${'c'.repeat(64)}`,
    };
    await expect(createPaidDocumentDirectCheckoutReviewAdmission({
      read: async () => stored(state),
    })({
      submission_id: SUBMISSION_ID,
      pair_binding: wrongPair,
    })).resolves.toEqual({ kind: 'deferred', reason: 'pair_mismatch' });
    await expect(createPaidDocumentDirectCheckoutReviewAdmission({
      read: async () => stored(state, 2),
    })({
      submission_id: SUBMISSION_ID,
      pair_binding: PAIR,
    })).resolves.toEqual({ kind: 'deferred', reason: 'state_invalid' });
    await expect(createPaidDocumentDirectCheckoutReviewAdmission({
      read: async () => stored(state),
    })({
      submission_id: SUBMISSION_ID,
      pair_binding: PAIR,
      approved_at: 3_999,
    })).resolves.toEqual({ kind: 'deferred', reason: 'approval_precedes_payment' });
  });
});
