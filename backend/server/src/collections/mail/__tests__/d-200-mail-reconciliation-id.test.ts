import { describe, expect, it } from 'vitest';
import {
  isMailReconciliationId,
  MAIL_RECONCILIATION_ID_HEADER,
} from '@recued/contracts';

import {
  buildGmailRfc5322,
  canonicalizeGmail,
} from '../gmail-provider.js';
import {
  buildGraphMessage,
  canonicalizeGraph,
} from '../graph-provider.js';
import {
  buildImapRfc5322,
  canonicalizeImap,
} from '../imap-provider.js';
import { buildRecord } from '../mail-collection.js';
import type { OutgoingMessage } from '../provider.js';

const RECONCILIATION_ID = `d200-${'a'.repeat(64)}`;
const SENT_AT = Date.UTC(2026, 6, 11, 12, 0, 0);
const OUTGOING: OutgoingMessage = {
  to: ['visitor@example.test'],
  subject: 'Your document is ready',
  body_text: 'Attached.',
  reconciliation_id: RECONCILIATION_ID,
};

describe('D-200 provider reconciliation identity carrier', () => {
  it('accepts only compact header-safe identities', () => {
    expect(isMailReconciliationId(RECONCILIATION_ID)).toBe(true);
    expect(isMailReconciliationId('contains whitespace')).toBe(false);
    expect(isMailReconciliationId('safe\r\nBcc: attacker@example.test')).toBe(false);
    expect(isMailReconciliationId('a'.repeat(256))).toBe(false);
  });

  it('round-trips the identity through Gmail RFC 5322 and canonical ingest', async () => {
    const raw = buildGmailRfc5322(OUTGOING, SENT_AT);
    expect(raw).toContain(
      `${MAIL_RECONCILIATION_ID_HEADER}: ${RECONCILIATION_ID}\r\n`,
    );
    const canonical = await canonicalizeGmail({
      id: 'gmail-message-1',
      threadId: 'gmail-thread-1',
      labelIds: ['SENT'],
      internalDate: String(SENT_AT),
      raw: Buffer.from(raw).toString('base64url'),
    });
    expect(canonical.reconciliation_id).toBe(RECONCILIATION_ID);
    expect(buildRecord(canonical, () => SENT_AT).record.hot_fields)
      .toMatchObject({ reconciliation_id: RECONCILIATION_ID });
  });

  it('round-trips the identity through Graph custom headers and canonical ingest', () => {
    const message = buildGraphMessage(OUTGOING);
    expect(message.internetMessageHeaders).toContainEqual({
      name: MAIL_RECONCILIATION_ID_HEADER,
      value: RECONCILIATION_ID,
    });
    const canonical = canonicalizeGraph({
      id: 'graph-message-1',
      subject: OUTGOING.subject,
      internetMessageHeaders: message.internetMessageHeaders,
      toRecipients: message.toRecipients,
      receivedDateTime: new Date(SENT_AT).toISOString(),
      body: { contentType: 'text', content: OUTGOING.body_text },
    });
    expect(canonical.reconciliation_id).toBe(RECONCILIATION_ID);
    expect(buildRecord(canonical, () => SENT_AT).record.hot_fields)
      .toMatchObject({ reconciliation_id: RECONCILIATION_ID });
  });

  it('round-trips the identity through IMAP/SMTP RFC 5322 and canonical ingest', async () => {
    const raw = buildImapRfc5322(OUTGOING, {
      from: 'sender@example.test',
      messageId: '<message@example.test>',
      sentAt: SENT_AT,
    });
    expect(raw).toContain(
      `${MAIL_RECONCILIATION_ID_HEADER}: ${RECONCILIATION_ID}\r\n`,
    );
    const canonical = await canonicalizeImap(Buffer.from(raw), {
      uid: 7,
      folder: 'Sent',
      flags: new Set(['\\Seen']),
      internalDate: new Date(SENT_AT),
    });
    expect(canonical.reconciliation_id).toBe(RECONCILIATION_ID);
    expect(buildRecord(canonical, () => SENT_AT).record.hot_fields)
      .toMatchObject({ reconciliation_id: RECONCILIATION_ID });
  });

  it('does not index an ambiguous duplicate reconciliation header', async () => {
    const gmailRaw = buildGmailRfc5322(OUTGOING, SENT_AT).replace(
      `${MAIL_RECONCILIATION_ID_HEADER}: ${RECONCILIATION_ID}\r\n`,
      `${MAIL_RECONCILIATION_ID_HEADER}: ${RECONCILIATION_ID}\r\n`
        + `${MAIL_RECONCILIATION_ID_HEADER}: d200-${'b'.repeat(64)}\r\n`,
    );
    const gmail = await canonicalizeGmail({
      id: 'gmail-duplicate',
      threadId: 'gmail-thread-duplicate',
      labelIds: ['SENT'],
      raw: Buffer.from(gmailRaw).toString('base64url'),
    });
    expect(gmail.reconciliation_id).toBeUndefined();

    const imapRaw = buildImapRfc5322(OUTGOING, {
      from: 'sender@example.test',
      messageId: '<duplicate@example.test>',
      sentAt: SENT_AT,
    }).replace(
      `${MAIL_RECONCILIATION_ID_HEADER}: ${RECONCILIATION_ID}\r\n`,
      `${MAIL_RECONCILIATION_ID_HEADER}: ${RECONCILIATION_ID}\r\n`
        + `${MAIL_RECONCILIATION_ID_HEADER}: d200-${'b'.repeat(64)}\r\n`,
    );
    const imap = await canonicalizeImap(Buffer.from(imapRaw), {
      uid: 8,
      folder: 'Sent',
      flags: new Set(['\\Seen']),
      internalDate: new Date(SENT_AT),
    });
    expect(imap.reconciliation_id).toBeUndefined();

    const graph = canonicalizeGraph({
      id: 'graph-duplicate',
      internetMessageHeaders: [
        { name: MAIL_RECONCILIATION_ID_HEADER, value: RECONCILIATION_ID },
        { name: MAIL_RECONCILIATION_ID_HEADER, value: `d200-${'b'.repeat(64)}` },
      ],
    });
    expect(graph.reconciliation_id).toBeUndefined();
  });
});
