/** D-207 slice 3d — `core.mail.sent.reconcile`, the general no-resend fence's op.
 *
 *  The REAL fences are the storage boundary (`mail-send-claim-store.ts`) and the
 *  server binding that derives the query from the claim. What only THIS layer can
 *  carry is the CLOSED INPUT KEY SET — and that is the whole point of the op:
 *
 *  A caller who could supply the recipient, the sender, the subject, the time window,
 *  the provider evidence, or the outcome could forge a `matched`. And a forged
 *  `matched` is the dangerous direction: it marks a document DELIVERED that was never
 *  sent, silently, to a customer who paid for it.
 *
 *  So the op takes a reconciliation id and NOTHING ELSE. The fence is the absent
 *  field — an absence that cannot be wrong — not a validator that can.
 */

import { describe, expect, it, vi } from 'vitest';
import { createKernelAdapter } from '../kernel.js';

const mkCall = (slug: string, input: Record<string, unknown>) => ({
  slug,
  risk_tier: 'read' as const,
  input,
  output: {},
  manifest_version: 1,
});

const reconcileDispatcher = () =>
  vi.fn(async () => ({
    status: 'reconciled',
    settled: true,
    provider_message_id: '<abc@mail>',
    sent_at: 1_700_000_000_500,
    ambiguity_reason: null,
    scanned_candidates: 1,
  }));

describe('D-207 slice 3d — the op names a send, and cannot describe it', () => {
  /** ⛔ THE FENCE. Every one of these is a field the SERVER derives from the claim it
   *  wrote before dispatch. A caller who could name any of them could aim the
   *  reconciler at a message that is not theirs, or manufacture the answer. */
  it.each([
    ['recipient', 'attacker@example.com'],
    ['sender', 'owner@example.com'],
    ['sender_slug', 'other-account'],
    ['subject', 'Your research brief'],
    ['sent_after', 0],
    ['sent_before', 9_999_999_999_999],
    ['proof_kind', 'envelope'],
    ['attachment_sha256', 'a'.repeat(64)],
    ['provider_message_id', '<forged@mail>'],
    ['status', 'reconciled'],
    ['result', 'matched'],
    ['ambiguity_reason', 'duplicate_header'],
  ])('refuses a caller-supplied `%s`', async (field, value) => {
    const mailSentReconcile = reconcileDispatcher();
    const adapter = createKernelAdapter({ mailSentReconcile });

    await expect(
      adapter(
        mkCall('mail-sent-reconcile', {
          reconciliation_id: 'ord:paid-doc:sub_1:delivery',
          [field]: value,
        }),
      ),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });

    // Refused before the server could ever be asked — the forgery never lands.
    expect(mailSentReconcile).not.toHaveBeenCalled();
  });

  it('reconciles with an id, and nothing else', async () => {
    const mailSentReconcile = reconcileDispatcher();
    const adapter = createKernelAdapter({ mailSentReconcile });

    const result = await adapter(
      mkCall('mail-sent-reconcile', {
        reconciliation_id: 'ord:paid-doc:sub_1:delivery',
      }),
    );

    expect(mailSentReconcile).toHaveBeenCalledWith({
      reconciliation_id: 'ord:paid-doc:sub_1:delivery',
    });
    expect(result).toMatchObject({ status: 'reconciled', settled: true });
  });

  /** Without a server there is no claim, and without a claim there is no honest
   *  answer. Refusing beats returning a `not_found`-shaped nothing that a caller could
   *  read as "safe to resend". */
  it('⛔ REFUSES when no dispatcher is wired, rather than answering emptily', async () => {
    const adapter = createKernelAdapter({});

    await expect(
      adapter(
        mkCall('mail-sent-reconcile', {
          reconciliation_id: 'ord:paid-doc:sub_1:delivery',
        }),
      ),
    ).rejects.toMatchObject({ code: 'SERVER_NOT_REACHABLE' });
  });
});
