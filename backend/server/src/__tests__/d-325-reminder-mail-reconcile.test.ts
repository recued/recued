import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { createMailSendClaimStore } from '../storage/mail-send-claim-store.js';
import { createReminderMailReconciler } from '../reminders/mail-delivery-reconcile.js';
import type { MailSentReconciliationResult } from '../collections/mail/provider.js';

describe('D-325 read-only notification mail reconciliation', () => {
  it('treats a missing pre-send claim as never dispatched and never contacts a mailbox to send it', async () => {
    const db = new Database(':memory:');
    try {
      const mailbox = vi.fn();
      const reconcile = createReminderMailReconciler({ claims: createMailSendClaimStore(db), mailbox });
      expect(await reconcile('attempt-before-io')).toEqual({ outcome: 'not_delivered' });
      expect(mailbox).not.toHaveBeenCalled();
    } finally { db.close(); }
  });

  it('asks the original mailbox for exact provider proof, persists it, and returns the provider id', async () => {
    const db = new Database(':memory:');
    try {
      const claims = createMailSendClaimStore(db);
      claims.claim({ reconciliation_id: 'original-attempt', sender_slug: 'original-mailbox', recipient: 'owner@example.com',
        subject: 'Numbered reminder bundle', proof_kind: 'envelope', now: 1000 });
      const lookupSentByReconciliationId = vi.fn(async (_query: unknown): Promise<MailSentReconciliationResult> => ({ status: 'matched',
        match: { proof_kind: 'envelope', source_id: 'sent-source', provider_message_id: '<provider-id>', sent_at: 1500 }, scanned_candidates: 1 }));
      const mailbox = vi.fn((slug: string) => slug === 'original-mailbox' ? { lookupSentByReconciliationId } : undefined);
      const reconcile = createReminderMailReconciler({ claims, mailbox, now: () => 2000 });
      expect(await reconcile('original-attempt')).toEqual({ outcome: 'delivered', provider_message_id: '<provider-id>' });
      expect(mailbox).toHaveBeenCalledWith('original-mailbox');
      expect(lookupSentByReconciliationId.mock.calls[0]![0]).toMatchObject({ reconciliation_id: 'original-attempt',
        recipient: 'owner@example.com', subject: 'Numbered reminder bundle', proof_kind: 'envelope' });
      expect(claims.get('original-attempt')?.status).toBe('reconciled');
      await reconcile('original-attempt');
      expect(lookupSentByReconciliationId).toHaveBeenCalledTimes(1);
    } finally { db.close(); }
  });

  it('does not turn a not-found provider search into proof that mail was not delivered', async () => {
    const db = new Database(':memory:');
    try {
      const claims = createMailSendClaimStore(db);
      claims.claim({ reconciliation_id: 'uncertain-attempt', sender_slug: 'mailbox', recipient: 'owner@example.com',
        subject: 'Reminder', proof_kind: 'envelope', now: 1000 });
      const reconcile = createReminderMailReconciler({ claims, now: () => 2000, mailbox: () => ({
        lookupSentByReconciliationId: async () => ({ status: 'not_found', scanned_candidates: 0 }),
      }) });
      expect(await reconcile('uncertain-attempt')).toEqual({ outcome: 'unknown' });
      expect(claims.get('uncertain-attempt')?.status).toBe('claimed');
    } finally { db.close(); }
  });
});
