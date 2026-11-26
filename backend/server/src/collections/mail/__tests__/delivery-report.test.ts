import { afterEach, describe, expect, it } from 'vitest';
import { DELIVERY_REPORT_MAX_BYTES, parseDeliveryReport, storedDeliveryReport } from '../delivery-report.js';
import { canonicalizeGmail } from '../gmail-provider.js';
import { canonicalizeImap } from '../imap-provider.js';
import { createGraphProvider } from '../graph-provider.js';
import { buildRecord, mailChangedFields } from '../mail-collection.js';
import type { CanonicalMessage, MailProvider } from '../provider.js';
import { deliveryReportMime } from '../../../__tests__/fixtures/mail-delivery-report-fixture.js';

const providers: MailProvider[] = [];
afterEach(async () => { for (const provider of providers.splice(0)) await provider.close(); });
describe('bounded structured delivery reports', () => {
  it.each(['gmail', 'imap'] as const)('%s retains exact original and recipient evidence without exposing raw headers', async kind => {
    const raw = deliveryReportMime(), at = Date.parse('2026-11-23T18:00:00Z');
    const msg = kind === 'gmail' ? await canonicalizeGmail({ id: 'report', threadId: 'separate-report-thread', labelIds: ['INBOX'], raw: raw.toString('base64url') })
      : await canonicalizeImap(raw, { uid: 42, folder: 'INBOX', flags: new Set(), internalDate: new Date(at) });
    const { record } = buildRecord(msg, () => at, 'owner@example.test');
    expect(record.hot_fields.delivery_report_original_id).toBe('sent-1@example.test');
    expect(storedDeliveryReport(record.hot_fields.delivery_report)).toMatchObject({ version: 1, original_from: 'owner@example.test',
      original_recipients: ['alex@example.test', 'copy@example.test'], recipients: [{ address: 'alex@example.test', action: 'failed', status: '5.1.1', reason: '550 5.1.1 No such user' }] });
    expect(record.hot_fields.reply_automation).toBe('v1:unknown'); expect(JSON.stringify(record.hot_fields)).not.toContain('Received:');
    const legacy = structuredClone(record); delete legacy.hot_fields.delivery_report; delete legacy.hot_fields.delivery_report_original_id;
    expect(mailChangedFields(legacy, record)).toEqual([]);
  });

  it('accepts returned message headers and folded machine fields, retaining temporary reports without declaring them permanent', async () => {
    const raw = deliveryReportMime({ returnedType: 'message/rfc822', action: 'delayed', status: '4.2.2' }).toString().replace('550 5.1.1 No such user', '451 Mailbox\r\n full');
    const report = await parseDeliveryReport(Buffer.from(raw));
    expect(report?.recipients).toEqual([{ address: 'alex@example.test', action: 'delayed', status: '4.2.2', reason: '451 Mailbox full' }]);
  });

  it('keeps a correlatable but ambiguous machine report review-only instead of choosing conflicting fields', async () => {
    const report = await parseDeliveryReport(deliveryReportMime({ extraStatus: ['Action: delayed'] }));
    expect(report?.original_message_id).toBe('sent-1@example.test'); expect(report?.recipients).toEqual([]);
    expect(storedDeliveryReport(report)).toBeUndefined();
  });

  it('rejects prose, forwarded reports, duplicate original identities, missing boundaries and oversized MIME', async () => {
    const valid = deliveryReportMime().toString();
    for (const raw of [valid.replace('multipart/report;', 'multipart/mixed;'), valid.replace('Message-ID: <sent-1@example.test>', 'Message-ID: <sent-1@example.test>\r\nMessage-ID: <other@example.test>'),
      valid.replace('--dsn-boundary--', ''), valid.replace('boundary="dsn-boundary"', 'boundary="dsn-boundary"; boundary="other"'), 'Subject: Delivery failed\r\n\r\nFinal-Recipient: alex@example.test'])
      expect(await parseDeliveryReport(Buffer.from(raw))).toBeUndefined();
    expect(await parseDeliveryReport(Buffer.alloc(DELIVERY_REPORT_MAX_BYTES + 1))).toBeUndefined();
    const receipt = await canonicalizeGmail({ id: 'read-receipt', threadId: 'unrelated', labelIds: ['INBOX'],
      raw: Buffer.from(valid.replace('report-type=delivery-status', 'report-type=disposition-notification')).toString('base64url') });
    expect(receipt.delivery_report).toBeUndefined(); expect(receipt.delivery_report_unverified).toBeUndefined();
    const proof = await parseDeliveryReport(deliveryReportMime());
    expect(storedDeliveryReport({ ...proof, version: 2 })).toBeUndefined();
  });

  it('reads report MIME through the actual Graph initial scan and exact fetch, leaves ordinary messages alone and fails incomplete reads', async () => {
    let fail = false, oversized = false, rawReads = 0;
    const msg = { id: 'graph-report', parentFolderId: 'inbox', from: { emailAddress: { address: 'mailer-daemon@example.test' } },
      toRecipients: [{ emailAddress: { address: 'owner@example.test' } }], conversationId: 'different-thread', internetMessageId: '<failure@reports.example.test>',
      internetMessageHeaders: [{ name: 'Content-Type', value: 'multipart/report; report-type=delivery-status; boundary="dsn-boundary"' }], body: { contentType: 'text', content: 'Report prose.' } };
    const data = new Map([['graph.work.access_token', 'fixture-access'], ['graph.work.expires_at', String(Date.now() + 3600000)]]);
    const provider = createGraphProvider({ slug: 'work', accountStore: { async get(k) { return data.get(k) ?? null; }, async set(k, v) { data.set(k, v); }, async delete(k) { data.delete(k); } },
      providerConfig: { clientId: 'fixture', clientSecret: 'fixture', tokenUrl: 'https://fixture.example/token' },
      config: () => ({ account_slug: 'work', backfill_days: 30, poll_seconds: 30, folder_filter: ['inbox'] }),
      fetcher: async url => {
        if (url.endsWith('/$value')) { rawReads++; return new Response(fail ? 'unavailable' : oversized ? 'x'.repeat(DELIVERY_REPORT_MAX_BYTES + 1) : deliveryReportMime().toString(), { status: fail ? 503 : 200 }); }
        const path = new URL(url).pathname;
        const body = path.endsWith('/delta') ? { value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?cursor=one' }
          : path.endsWith('/messages') ? { value: [msg, { ...msg, id: 'ordinary', internetMessageHeaders: [] }] }
            : path.includes('/messages/') ? msg : { id: path.split('/').at(-1) };
        return new Response(JSON.stringify(body));
      } }); providers.push(provider); await provider.connect();
    const received: CanonicalMessage[] = [];
    await provider.initialScan({ backfill_days: 30, onMessage: async message => { received.push(message); return true; } });
    expect(received).toHaveLength(2); expect(rawReads).toBe(1); expect(received[0]!.delivery_report?.original_message_id).toBe('sent-1@example.test');
    expect(received[1]!.delivery_report).toBeUndefined();
    expect((await provider.fetchMessage!('graph-report'))?.delivery_report?.recipients[0]?.status).toBe('5.1.1');
    oversized = true; await expect(provider.fetchMessage!('graph-report')).rejects.toThrow('limit'); oversized = false;
    fail = true; await expect(provider.fetchMessage!('graph-report')).rejects.toThrow();
    await expect(provider.initialScan({ backfill_days: 30, onMessage: async () => true })).rejects.toThrow('incomplete');
  });
});
