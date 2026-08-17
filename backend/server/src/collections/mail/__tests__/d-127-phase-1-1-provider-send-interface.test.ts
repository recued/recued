/** D-127 Phase 1.1 — MailProvider.send interface tests.
 *
 *  Pins the contract: every concrete provider exposes
 *  `sendCapable: false` until its real send implementation lands
 *  in P1.3 (gmail) / P1.4 (graph) / P1.5 (imap); the optional
 *  `send` method is undefined when not capable; the
 *  `assertSendCapable` helper narrows correctly. */

import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { IngredientError } from '@recued/ingredients';
import {
  assertSendCapable,
  type MailProvider,
  type OutgoingMessage,
  type SentMessageMeta,
  type ProviderHealth,
} from '../provider.js';
import {
  createImapProvider,
  type CreateImapProviderOptions,
  type ImapClient,
} from '../imap-provider.js';
import { createGmailProvider, type CreateGmailProviderOptions } from '../gmail-provider.js';
import { createGraphProvider, type CreateGraphProviderOptions } from '../graph-provider.js';
import type { OAuthAccountStore } from '../oauth.js';

// ────────────────────────────────────────────────────────────────
// Mock harnesses — minimal opts to construct each provider so we
// can assert the static interface fields without exercising the
// network paths. Construction-only — methods aren't called.
// ────────────────────────────────────────────────────────────────

const mkOAuthStore = (): OAuthAccountStore => {
  const data = new Map<string, string>();
  return {
    async get(k) { return data.get(k) ?? null; },
    async set(k, v) { data.set(k, v); },
    async delete(k) { data.delete(k); },
  };
};

const mkGmailOpts = (): CreateGmailProviderOptions => ({
  slug: 'work',
  config: () => ({ account_slug: 'work', poll_seconds: 60, backfill_days: 30 }),
  accountStore: mkOAuthStore(),
  providerConfig: { tokenUrl: 'https://example.com/token', clientId: 'test', clientSecret: 'test' },
  fetcher: async () => ({ status: 200, ok: true, json: async () => ({}), text: async () => '' }),
  scheduler: () => () => undefined,
});

const mkGraphOpts = (): CreateGraphProviderOptions => ({
  slug: 'work',
  config: () => ({ account_slug: 'work', poll_seconds: 60, backfill_days: 30 }),
  accountStore: mkOAuthStore(),
  providerConfig: { tokenUrl: 'https://example.com/token', clientId: 'test' },
  fetcher: async () => ({ status: 200, ok: true, json: async () => ({}), text: async () => '' }),
  scheduler: () => () => undefined,
});

/** Bare ImapClient stand-in — extends EventEmitter to satisfy the
 *  structural contract; methods throw if invoked since the
 *  P1.1 test only constructs the provider, never connects it. */
class StubImapClient extends EventEmitter implements ImapClient {
  usable = false;
  async connect() { throw new Error('not used in P1.1'); }
  async logout() { throw new Error('not used in P1.1'); }
  close() { /* no-op */ }
  async mailboxOpen(): Promise<never> { throw new Error('not used in P1.1'); }
  async search(): Promise<never> { throw new Error('not used in P1.1'); }
  fetch(): never { throw new Error('not used in P1.1'); }
  async idle(): Promise<boolean> { throw new Error('not used in P1.1'); }
}

const mkImapOpts = (): CreateImapProviderOptions => ({
  slug: 'work',
  config: () => ({
    host: 'imap.example.com',
    port: 993,
    secure: true,
    username: 'user',
    password: 'pass',
    folders: ['INBOX'],
  }),
  clientFactory: () => new StubImapClient(),
});

// ────────────────────────────────────────────────────────────────
// 1. Each concrete provider exposes sendCapable: false until P1.3-1.5
// ────────────────────────────────────────────────────────────────

describe('D-127 P1.1 — concrete providers default sendCapable: false', () => {
  it('gmail provider exposes sendCapable: false + no send method', () => {
    const provider = createGmailProvider(mkGmailOpts());
    expect(provider.sendCapable).toBe(false);
    expect(provider.send).toBeUndefined();
  });

  it('graph provider exposes sendCapable: false + no send method', () => {
    const provider = createGraphProvider(mkGraphOpts());
    expect(provider.sendCapable).toBe(false);
    expect(provider.send).toBeUndefined();
  });

  it('imap provider exposes sendCapable: false + no send method', () => {
    const provider = createImapProvider(mkImapOpts());
    expect(provider.sendCapable).toBe(false);
    expect(provider.send).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// 2. assertSendCapable narrows the type / throws on read-only providers
// ────────────────────────────────────────────────────────────────

describe('D-127 P1.1 — assertSendCapable', () => {
  const stubProvider = (overrides: Partial<MailProvider>): MailProvider => ({
    kind: 'gmail',
    slug: 'work',
    sendCapable: false,
    mutationCapable: false,
    accountEmail: '',
    async connect() {},
    async initialScan() {},
    async startSync() { return async () => {}; },
    async close() {},
    health(): ProviderHealth {
      return { last_successful_sync_at: 0, error_count_24h: 0, pending_queue_size: 0 };
    },
    ...overrides,
  });

  it('throws IngredientError(MAIL_SEND_NOT_CAPABLE) on a read-only provider', () => {
    const provider = stubProvider({ sendCapable: false });
    try {
      assertSendCapable(provider);
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(IngredientError);
      expect((err as IngredientError).code).toBe('MAIL_SEND_NOT_CAPABLE');
      expect((err as IngredientError).details).toMatchObject({ kind: 'gmail', slug: 'work' });
    }
  });

  it('throws when sendCapable is true but send method is missing (lockstep guard)', () => {
    // Defensive: even if a buggy provider sets the flag without
    // wiring the method, the assertion catches it before dispatch.
    const provider = stubProvider({ sendCapable: true /* no send */ });
    try {
      assertSendCapable(provider);
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(IngredientError);
      expect((err as IngredientError).code).toBe('MAIL_SEND_NOT_CAPABLE');
    }
  });

  it('passes silently on a send-capable provider + narrows type so send() is callable without optional chain', async () => {
    const sendStub = vi.fn(
      async (_msg: OutgoingMessage): Promise<SentMessageMeta> => ({
        source_id: 'msg-123',
        message_id: '<msg-123@example.com>',
        sent_at: 1_700_000_000_000,
      }),
    );
    const provider = stubProvider({ sendCapable: true, send: sendStub });
    expect(() => assertSendCapable(provider)).not.toThrow();
    assertSendCapable(provider);
    // Type narrowed — `provider.send` is non-optional inside this scope.
    const result = await provider.send({
      to: ['recipient@example.com'],
      subject: 'hello',
      body_text: 'world',
    });
    expect(result.source_id).toBe('msg-123');
    expect(sendStub).toHaveBeenCalledOnce();
  });
});

// ────────────────────────────────────────────────────────────────
// 3. OutgoingMessage / SentMessageMeta shape sanity
// ────────────────────────────────────────────────────────────────

describe('D-127 P1.1 — OutgoingMessage / SentMessageMeta shape', () => {
  it('OutgoingMessage accepts required fields only (cc / bcc / threading optional)', () => {
    const minimal: OutgoingMessage = {
      to: ['a@example.com'],
      subject: 'hi',
      body_text: 'hello',
    };
    expect(minimal.to).toHaveLength(1);
    expect(minimal.cc).toBeUndefined();
    expect(minimal.bcc).toBeUndefined();
    expect(minimal.body_html).toBeUndefined();
    expect(minimal.in_reply_to).toBeUndefined();
    expect(minimal.references).toBeUndefined();
    expect(minimal.reply_to).toBeUndefined();
  });

  it('OutgoingMessage accepts all optional fields when threading + html supplied', () => {
    const full: OutgoingMessage = {
      to: ['a@example.com'],
      cc: ['b@example.com'],
      bcc: ['c@example.com'],
      subject: 'thread reply',
      body_text: 'plain',
      body_html: '<p>html</p>',
      in_reply_to: '<parent@example.com>',
      references: ['<grandparent@example.com>', '<parent@example.com>'],
      reply_to: 'replies@example.com',
    };
    expect(full.cc).toHaveLength(1);
    expect(full.bcc).toHaveLength(1);
    expect(full.body_html).toContain('html');
    expect(full.references).toHaveLength(2);
  });

  it('SentMessageMeta carries provider-side identifiers; thread_id optional for SMTP', () => {
    const minimal: SentMessageMeta = {
      source_id: 'rfc5322-msgid',
      message_id: '<rfc5322-msgid@sender.example.com>',
      sent_at: 1_700_000_000_000,
    };
    expect(minimal.thread_id).toBeUndefined();
    const threaded: SentMessageMeta = {
      ...minimal,
      thread_id: 'gmail-thread-abc',
    };
    expect(threaded.thread_id).toBe('gmail-thread-abc');
  });
});
