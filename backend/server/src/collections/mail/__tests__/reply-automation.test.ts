import { describe, expect, it } from 'vitest';
import { canonicalizeGmail } from '../gmail-provider.js';
import { canonicalizeImap } from '../imap-provider.js';
import { canonicalizeGraph } from '../graph-provider.js';
import { buildRecord, mailChangedFields } from '../mail-collection.js';
import { classifyReplyAutomation, storedReplyAutomation } from '../reply-automation.js';

const stamp = Date.parse('2026-11-23T18:00:00Z');
const raw = (headers: Array<[string, string]>) => ['From: Alex <alex@example.test>', 'To: owner@example.test',
  'Subject: Automatic reply: Renewal', 'Message-ID: <reply@example.test>', 'Date: ' + new Date(stamp).toUTCString(),
  'Content-Type: text/plain', ...headers.map(([name, value]) => `${name}: ${value}`), '', 'Hello'].join('\r\n');
const source = async (kind: 'gmail' | 'imap' | 'graph', headers: Array<[string, string]>) => kind === 'gmail'
  ? canonicalizeGmail({ id: 'gmail-reply', threadId: 'thread', labelIds: ['INBOX'], internalDate: String(stamp), raw: Buffer.from(raw(headers)).toString('base64url') })
  : kind === 'imap' ? canonicalizeImap(Buffer.from(raw(headers)), { uid: 1, folder: 'INBOX', flags: new Set(), internalDate: new Date(stamp) })
    : canonicalizeGraph({ id: 'graph-reply', from: { emailAddress: { address: 'alex@example.test' } }, conversationId: 'thread',
      internetMessageId: '<reply@example.test>', receivedDateTime: new Date(stamp).toISOString(), subject: 'Automatic reply: Renewal',
      internetMessageHeaders: headers.map(([name, value]) => ({ name, value })), body: { contentType: 'text', content: 'Hello' } });

describe('source evidence for reply automation', () => {
  it.each(['gmail', 'imap', 'graph'] as const)('%s carries explicit and duplicate header evidence into the stored record', async kind => {
    const automatic = await source(kind, [['aUtO-sUbMiTtEd', ' auto-replied; owner-email="alex@example.test"']]);
    expect(buildRecord(automatic, () => stamp).record.hot_fields.reply_automation).toBe('v1:automatic');
    const ambiguous = await source(kind, [['Auto-Submitted', 'no'], ['Auto-Submitted', 'auto-replied']]);
    expect(buildRecord(ambiguous, () => stamp).record.hot_fields.reply_automation).toBe('v1:unknown');
    // A subject and a suppression request cannot label a personal message automatic.
    const ordinary = await source(kind, [['X-Auto-Response-Suppress', 'OOF, AutoReply']]);
    expect(buildRecord(ordinary, () => stamp).record.hot_fields.reply_automation).toBe('v1:unmarked');
    const row = JSON.stringify(buildRecord(automatic, () => stamp).record);
    expect(row).not.toContain('owner-email'); expect(row).not.toContain('auto-submitted');
  });

  it('keeps missing Graph headers and external-adapter evidence unknown instead of inventing an ordinary reply', async () => {
    const graph = canonicalizeGraph({ id: 'legacy', from: { emailAddress: { address: 'alex@example.test' } } });
    expect(buildRecord(graph, () => stamp).record.hot_fields.reply_automation).toBe('v1:unknown');
    const external = await source('gmail', []); delete external.reply_automation;
    expect(buildRecord(external, () => stamp).record.hot_fields.reply_automation).toBe('v1:unknown');
    expect(storedReplyAutomation(undefined)).toBe('unknown'); expect(storedReplyAutomation('v2:unmarked')).toBe('unknown');
  });

  it.each([
    { headers: [['Auto-Submitted', 'auto-generated']] }, { headers: [['X-Autoreply', 'yes']] },
    { headers: [['X-Autorespond', 'true']] }, { headers: [['Precedence', 'Auto_Reply']] },
  ] as Array<{ headers: Array<[string, string]> }>)('recognizes an explicit automatic marker $headers', ({ headers }) => {
    expect(classifyReplyAutomation(headers)).toBe('automatic');
  });

  it('requires review for malformed evidence and delivery or list traffic', () => {
    for (const headers of [undefined, [['Auto-Submitted', '']], [['Auto-Submitted', 'no, auto-replied']],
      [['Auto-Submitted', 'no\nAuto-Submitted: auto-replied']], [['X-Autoreply', 'false']],
      [['Content-Type', 'multipart/report; report-type=delivery-status']], [['Return-Path', '<>']], [['List-Id', '<list@example.test>']], [['Precedence', 'bulk']]] as Array<Array<[string, string]> | undefined>) {
      expect(classifyReplyAutomation(headers)).toBe('unknown');
    }
    expect(classifyReplyAutomation([['Auto-Submitted', 'No; comment="ordinary"']])).toBe('unmarked');
  });

  it('does not emit an apparent source edit when a rescan adds only classification metadata', async () => {
    const { record } = buildRecord(await source('gmail', []), () => stamp), legacy = structuredClone(record);
    delete legacy.hot_fields.reply_automation;
    expect(mailChangedFields(legacy, record)).toEqual([]);
    expect(mailChangedFields(legacy, { ...record, body_inline: 'Actually changed text.' })).toEqual(['body']);
  });
});
