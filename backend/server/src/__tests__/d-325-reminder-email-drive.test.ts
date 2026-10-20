import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import {
  createAskDeliveryStore, createAskStore, createNotificationBlock, createNotificationSettingsStore, createUiChannel,
  type AskDeliveryDestination, type AskDeliveryRecord, type NotificationSettings, type PendingAsk,
} from '@recued/notification';
import type { ConnectionRow } from '@recued/contracts';
import type { MailRpcDep } from '@recued/ingredients';
import { composeEmailChannel } from '../composition/bin/wire-email-channel.js';
import { composeInboundEmailAnswer, type EmailAnswerAccounts } from '../composition/bin/wire-inbound-email-answer.js';
import type { CanonicalMessage } from '../collections/mail/provider.js';
import type { MailUpsertContext } from '../collections/mail/mail-collection.js';
import type { ConnectionStoreSqlite } from '../storage/connection-store.js';
import { createSQLiteCollection } from '../sqlite-collection.js';

const now = 1_800_000_000_000;
const destination: AskDeliveryDestination = { id: 'private-email', channel: 'email', connection_name: 'private-alerts',
  connection_enrolled_at: 100, recipient: 'owner@example.com', expected_sender: 'owner@example.com', sender_source: 'alerts' };
const accounts: EmailAnswerAccounts = { sender_slug: 'alerts', sender_address: 'alerts@example.net',
  recipient_address: 'owner@example.com', connection_name: 'private-alerts', connection_enrolled_at: 100 };
const reply = (text: string): CanonicalMessage => ({ source_id: `reply-${text}`, rfc_message_id: `<${text}@example.com>`,
  from: 'Owner <owner@example.com>', to: ['alerts@example.net'], cc: [],
  subject: 'Re: Reminders [#ask-email-first]', thread_id: 'thread', folder_or_label: 'INBOX',
  direction: 'inbound', is_read: false, is_flagged: false, has_attachments: false, received_at: now - 1000,
  body_text: `${text}\n\nOn Saturday Recued wrote:\n> 1. Passport`,
  headers: { 'authentication-results': 'mx.example.net; dmarc=pass header.from=example.com' } });
const context: MailUpsertContext = { slug: 'alerts', record_id: 'reply-record', account_email: 'alerts@example.net',
  first_seen: true, backfill_complete: true, backfill_days: 30, attachments: [] };

describe('D-325 named email reminder drive', () => {
  it('reopens durable receipts, answers item two without a public address, and never emails the bundle again', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'd325-email-'));
    const path = join(directory, 'drive.sqlite');
    let db = new Database(path);
    try {
      let row: ConnectionRow | null = { pk: 'notification:private-alerts', kind: 'notification', subtype: 'email',
        name: 'private-alerts', display_name: 'Private alerts', enrolled_at: 100, updated_at: 100,
        auth_ciphertext: '', config_json: JSON.stringify({ sender_mail_instance: 'alerts', default_recipient: 'owner@example.com' }) };
      const connectionStore = { get: (kind: string, name: string) => kind === 'notification' && name === row?.name ? row : null,
        list: () => row ? [row] : [] } as unknown as ConnectionStoreSqlite;
      const send = vi.fn<MailRpcDep['send']>(async () => ({ source_id: 'smtp-source', message_id: '<smtp-id@example.net>', sent_at: now }));
      let sequence = 0;
      const completed = vi.fn();
      const boot = () => {
        const deliveries = createAskDeliveryStore(createSQLiteCollection<AskDeliveryRecord>(db, 'ask_deliveries'));
        const block = createNotificationBlock({ askStore: createAskStore(createSQLiteCollection<PendingAsk>(db, 'pending_asks')),
          deliveryStore: deliveries, settingsStore: createNotificationSettingsStore(createSQLiteCollection<NotificationSettings>(db, 'notification_settings')),
          channels: [createUiChannel({ busSink: () => {} }), composeEmailChannel({ connectionStore, mailRpc: { send } })],
          now: () => now, mintAskId: () => `ask-receipt-${++sequence}` });
        block.registerAskHandler('reminder.occurrence', completed);
        return { block, deliveries };
      };
      const first = boot();
      await first.block.askBundle({ group_id: 'email-drive', destinations: [destination], asks: [
        { ask_id: 'ask-email-first', message: { title: 'Passport', text: 'Renew passport.' },
          options: [{ id: 'done', label: 'Done' }], handler: { kind: 'reminder.occurrence', payload: { occurrence_id: 'passport' } } },
        { ask_id: 'ask-email-second', message: { title: 'Driving licence', text: 'Renew licence.' },
          options: [{ id: 'done', label: 'Done' }], handler: { kind: 'reminder.occurrence', payload: { occurrence_id: 'licence' } } },
        { ask_id: 'ask-email-third', message: { title: 'Insurance', text: 'Renew insurance.' },
          options: [{ id: 'done', label: 'Done' }], handler: { kind: 'reminder.occurrence', payload: { occurrence_id: 'insurance' } } },
      ] });
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]![0]).toMatchObject({ instance: 'alerts', to: ['owner@example.com'], reconciliation_id: 'ask-receipt-1' });
      expect(send.mock.calls[0]![0].body_text).toContain('2. Driving licence');
      expect((await first.deliveries.get('email-drive'))!.attempts[0]!.result).toMatchObject({ provider_message_id: '<smtp-id@example.net>' });
      db.close();
      db = new Database(path);
      const restarted = boot();
      const answer = async (text: string, accountOverride = accounts) => {
        const funnel = composeInboundEmailAnswer({ block: restarted.block, now: () => now,
          resolveAccounts: name => name === 'private-alerts' ? accountOverride : null,
          resolveAccountCandidates: () => [accountOverride] });
        funnel.onMessageUpserted(reply(text), context);
        await funnel.dispose();
      };
      await answer('Done');
      await answer('8 done');
      expect(completed).not.toHaveBeenCalled();
      expect((await restarted.block.listUnmatchedAskReplies()).map(item => item.reason)).toEqual(['item_required', 'unknown_item']);
      await answer('2 done', { ...accounts, connection_enrolled_at: 101 });
      expect(completed).not.toHaveBeenCalled();
      await answer('2 done');
      expect(completed).toHaveBeenCalledTimes(1);
      expect(completed.mock.calls[0]![0]).toEqual({ occurrence_id: 'licence' });
      // §5.1 — the same answer after the item closed changes nothing. Email cannot
      // say so in place, so the owner finds it with the unmatched replies, under the
      // item's title. A reply not proven to come from where the reminder went is not kept.
      await answer('2 done', { ...accounts, connection_enrolled_at: 101 });
      await answer('2 done');
      expect(completed).toHaveBeenCalledTimes(1);
      expect((await restarted.block.listUnmatchedAskReplies()).map(({ reason, text }) => ({ reason, text }))
        .sort((a, b) => a.reason.localeCompare(b.reason)))
        .toEqual([{ reason: 'already_closed', text: 'Driving licence: 2 done' },
          { reason: 'item_required', text: 'Done' }, { reason: 'unknown_item', text: '8 done' }]);
      expect((await restarted.block.getAsk('ask-email-first'))!.status).toBe('open');
      // The subject still names the first item; it can also answer the other
      // item after that first one has already become terminal.
      await answer('1 done');
      expect(completed).toHaveBeenCalledTimes(2);
      await answer('3 done');
      expect(completed).toHaveBeenCalledTimes(3);
      await restarted.block.recoverPendingAsks();
      expect(send).toHaveBeenCalledTimes(1);
      row = null;
      await restarted.block.recoverPendingAsks();
      expect(send).toHaveBeenCalledTimes(1);
    } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});
