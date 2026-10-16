/** D-318 step 5 — what the send path gains for the email door's answers: a
 *  Gmail send into the request's thread, and the marks of an automatic reply.
 *
 *  Gmail files a reply sent without its `threadId` in a new thread of the
 *  sending mailbox (§2.5). And an answer must keep auto-responders quiet
 *  (§4.7): RFC 3834's `Auto-Submitted` and Exchange's `X-Auto-Response-Suppress`
 *  — on Graph the second alone, as Graph documents only `x-` headers on a
 *  message it creates. Neither reaches the send from the wire: the rpc builds
 *  the send's input field by field. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { IngredientError } from '@recued/ingredients';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBlobStore } from '../../../storage/blob-store.js';
import { handleCollectionMailSend } from '../../collection-handler.js';
import { createCollectionRegistry } from '../../registry.js';
import { buildGmailRfc5322, createGmailProvider, GMAIL_SEND_SCOPE } from '../gmail-provider.js';
import { buildGraphMessage } from '../graph-provider.js';
import { buildImapRfc5322 } from '../imap-provider.js';
import { createMailCollection } from '../mail-collection.js';
import type { HttpFetcher } from '../oauth.js';
import { MAIL_AUTOMATIC_REPLY_HEADERS, type OutgoingMessage } from '../provider.js';

/** An answer's fields: the provider's message, and the collection's input. */
const fields = {
  to: ['me@owner.example'],
  subject: 'Re: ask: lunch?',
  body_text: 'Booked for 7.',
  in_reply_to: '<req-1@owner.example>',
  references: ['<req-1@owner.example>'],
  reconciliation_id: 'mail-chat-answer:0123456789abcdef0123456789abcdef',
};
const answer: OutgoingMessage = fields;

const headerLines = (rfc822: string): string[] => rfc822.split('\r\n\r\n')[0]!.split('\r\n');

describe('the marks of an automatic reply', () => {
  it('Gmail and IMAP write both headers on an automatic message, and neither on any other', () => {
    for (const build of [
      (msg: OutgoingMessage) => buildGmailRfc5322(msg, Date.UTC(2026, 9, 14)),
      (msg: OutgoingMessage) => buildImapRfc5322(msg, { from: 'recued@chat.example', messageId: '<m@chat.example>', sentAt: Date.UTC(2026, 9, 14) }),
    ]) {
      const automatic = headerLines(build({ ...answer, automatic: true }));
      expect(automatic).toContain('Auto-Submitted: auto-replied');
      expect(automatic).toContain('X-Auto-Response-Suppress: OOF, AutoReply');
      expect(automatic.some((line) => /^Precedence:/i.test(line))).toBe(false);
      const plain = headerLines(build(answer)).join('\n');
      expect(plain).not.toMatch(/^Auto-Submitted:/m);
      expect(plain).not.toMatch(/^X-Auto-Response-Suppress:/m);
    }
  });

  it('⛔ silences only the auto-responders, never a bounce', () => {
    // `All` also suppressed delivery and non-delivery reports: the first
    // Outlook answer never reached Gmail, and no bounce said so (live, 2026-10-15).
    const value = new Map(MAIL_AUTOMATIC_REPLY_HEADERS).get('X-Auto-Response-Suppress')!;
    const kinds = value.split(',').map((kind) => kind.trim());
    expect(kinds).toEqual(['OOF', 'AutoReply']);
    for (const bounce of ['All', 'NDR', 'DR']) expect(kinds).not.toContain(bounce);
  });

  it('Graph carries Exchange’s own mark alone', () => {
    const headers = buildGraphMessage({ ...answer, automatic: true }).internetMessageHeaders ?? [];
    expect(headers).toContainEqual({ name: 'X-Auto-Response-Suppress', value: 'OOF, AutoReply' });
    expect(headers.some((header) => header.name === 'Auto-Submitted')).toBe(false);
    expect(buildGraphMessage(answer).internetMessageHeaders?.some((header) => header.name === 'X-Auto-Response-Suppress'))
      .toBe(false);
  });
});

describe('a Gmail send into a thread', () => {
  const sender = () => {
    const bodies: Array<{ raw?: string; threadId?: string }> = [];
    const fetcher: HttpFetcher = async (url, init) => {
      if (url.endsWith('/messages/send') && init?.method === 'POST') {
        bodies.push(JSON.parse(init.body!) as { raw?: string; threadId?: string });
        return { status: 200, ok: true, async json() { return { id: 'g1', threadId: 'thread-9' }; }, async text() { return ''; } };
      }
      return { status: 404, ok: false, async json() { return {}; }, async text() { return ''; } };
    };
    const data = new Map<string, string>([
      ['gmail.chat.access_token', 'at'], ['gmail.chat.expires_at', String(Date.now() + 3_600_000)],
      ['gmail.chat.refresh_token', 'rt'],
    ]);
    const provider = createGmailProvider({
      slug: 'chat',
      config: () => ({ account_slug: 'chat', backfill_days: 7, poll_seconds: 30, granted_scopes: [GMAIL_SEND_SCOPE] }),
      accountStore: { async get(k) { return data.get(k) ?? null; }, async set(k, v) { data.set(k, v); }, async delete(k) { data.delete(k); } },
      providerConfig: { tokenUrl: 'https://oauth2.googleapis.com/token', clientId: 'c', clientSecret: 's' },
      fetcher,
      scheduler: () => () => undefined,
    });
    return { provider, bodies };
  };

  it('names the thread when asked to, and only then', async () => {
    const { provider, bodies } = sender();
    const sent = await provider.send!({ ...answer, thread_id: 'thread-9' });
    expect(sent.thread_id).toBe('thread-9');
    expect(bodies[0]!.threadId).toBe('thread-9');
    await provider.send!(answer);
    expect(Object.keys(bodies[1]!)).toEqual(['raw']);
  });
});

describe('the mail collection’s send', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  const collection = () => {
    const dir = mkdtempSync(join(tmpdir(), 'd318-send-'));
    dirs.push(dir);
    const send = vi.fn(async (_msg: OutgoingMessage) => ({ source_id: 'g1', message_id: 'g1', sent_at: 1, thread_id: 't' }));
    const mail = createMailCollection({
      db: new Database(':memory:'),
      blobs: createBlobStore(dir),
      gate: { addUsed: () => {}, getUsed: () => 0 } as never,
      bus: createWarehouseEventBus(),
      slug: 'recued-chat',
      provider: {
        kind: 'gmail', sendCapable: true, accountEmail: 'recued@chat.example', send,
        initialScan: async () => {}, poll: async () => {}, stop: async () => {},
      } as never,
      config: () => ({ backfill_days: 30, retention_days: 365, quota_bytes: 1024 * 1024 }) as never,
    });
    return { mail, send };
  };

  it('hands the thread and the automatic mark to the provider', async () => {
    const { mail, send } = collection();
    await mail.send({ ...fields, thread_id: '18c2f0a9b7e4d321', automatic: true });
    expect(send.mock.calls[0]![0]).toMatchObject({ thread_id: '18c2f0a9b7e4d321', automatic: true });
    const { reconciliation_id: _unfenced, ...plain } = fields;
    await mail.send(plain);
    expect(send.mock.calls[1]![0]).not.toHaveProperty('thread_id');
    expect(send.mock.calls[1]![0]).not.toHaveProperty('automatic');
  });

  it('refuses a thread id with a space or a line break in it, before anything is sent', async () => {
    const { mail, send } = collection();
    for (const thread_id of ['a b', 'a\r\nBcc: x@y', '']) {
      const refused = await mail.send({ ...fields, thread_id }).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(IngredientError);
      expect((refused as IngredientError).code).toBe('BAD_INPUT');
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('⛔ the rpc never passes either on: they are the server’s, not the wire’s', async () => {
    const { mail, send } = collection();
    const registry = createCollectionRegistry();
    registry.register(mail);
    await handleCollectionMailSend({ registry } as never, {
      instance: 'recued-chat', to: ['me@owner.example'], subject: 's', body_text: 'b',
      thread_id: 'thread-9', automatic: true,
    } as never);
    expect(send.mock.calls[0]![0]).not.toHaveProperty('thread_id');
    expect(send.mock.calls[0]![0]).not.toHaveProperty('automatic');
  });
});
