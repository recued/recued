/** D-127 Phase 1.5 — imap-provider.send (SMTP submission + IMAP APPEND) tests.
 *
 *  Pins the wire shape:
 *    - sendCapable derives from `config.smtp` block presence.
 *    - send() builds RFC 5322 with explicit From + Message-Id, hands
 *      raw + envelope to the SMTP transport, then IMAP-APPENDs the
 *      same RFC 5322 to the user's Sent folder (best-effort).
 *    - Sent folder discovery: \Sent special-use flag wins; falls
 *      back through Sent / Sent Items / Sent Messages / INBOX.Sent.
 *    - APPEND failure → MAIL_SEND_APPEND_FAILED warning attached to
 *      SentMessageMeta.warnings (NON-FATAL — SMTP submission is not
 *      rolled back).
 *    - SMTP error mapping: EAUTH → AUTH_FAILED,
 *      EENVELOPE / 5xx → RECIPIENT_INVALID,
 *      ESOCKET / ETIMEDOUT / unknown → NETWORK_FAILED.
 */

import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { IngredientError } from '@recued/ingredients';
import {
  buildImapRfc5322,
  createImapProvider,
  generateImapMessageId,
  IMAP_SENT_FOLDER_FALLBACK_CANDIDATES,
  findSentFolder,
  type ImapClient,
  type ImapClientFactory,
  type ImapProviderConfig,
  type SmtpMailOptions,
  type SmtpSendResponse,
  type SmtpTransport,
  type SmtpTransportFactory,
} from '../imap-provider.js';
import {
  assertSendCapable,
  type OutgoingMessage,
} from '../provider.js';
import type { MailboxObject } from 'imapflow';

// ────────────────────────────────────────────────────────────────
// Fakes
// ────────────────────────────────────────────────────────────────

interface ListEntry { path: string; specialUse?: string }

class FakeImapClient extends EventEmitter implements ImapClient {
  usable = true;
  listEntries: ListEntry[] = [];
  appendCalls: Array<{ path: string; content: string; flags?: string[] }> = [];
  appendError: Error | null = null;

  async connect(): Promise<void> { /* no-op */ }
  async logout(): Promise<void> { this.usable = false; }
  close(): void { this.usable = false; }
  async mailboxOpen(path: string): Promise<MailboxObject> {
    return { path, delimiter: '/', flags: new Set(), exists: 0 } as unknown as MailboxObject;
  }
  async search(): Promise<number[]> { return []; }
  async *fetch(): AsyncIterable<never> { /* yields nothing */ }
  async idle(): Promise<boolean> { return true; }

  async list(): Promise<ListEntry[]> { return this.listEntries; }
  async append(path: string, content: string | Buffer, flags?: string[]): Promise<unknown> {
    if (this.appendError) throw this.appendError;
    this.appendCalls.push({
      path,
      content: typeof content === 'string' ? content : content.toString('utf-8'),
      flags,
    });
    return { uid: 1 };
  }
}

class FakeSmtpTransport implements SmtpTransport {
  calls: SmtpMailOptions[] = [];
  closeCalls = 0;
  /** Optional override: throw this on the next sendMail call. */
  throwOnSend: Error | null = null;
  /** Override the messageId returned (defaults to first 12 chars of raw header). */
  resp: SmtpSendResponse = { messageId: 'smtp-msg-id', response: '250 2.0.0 OK' };

  async sendMail(options: SmtpMailOptions): Promise<SmtpSendResponse> {
    this.calls.push(options);
    if (this.throwOnSend) throw this.throwOnSend;
    return this.resp;
  }
  close(): void { this.closeCalls++; }
}

const baseConfig = (
  overrides: Partial<ImapProviderConfig> = {},
): ImapProviderConfig => ({
  host: 'imap.example.com',
  port: 993,
  secure: true,
  username: 'alice@example.com',
  password: 'pass',
  folders: ['INBOX'],
  smtp: {
    host: 'smtp.example.com',
    port: 587,
    secure: false,
    from: 'alice@example.com',
  },
  ...overrides,
});

interface Harness {
  provider: ReturnType<typeof createImapProvider>;
  imapClients: FakeImapClient[];
  smtpTransports: FakeSmtpTransport[];
}

const newHarness = (
  cfgOverrides: Partial<ImapProviderConfig> = {},
  hookOverrides: {
    pendingAppendError?: Error;
    listEntries?: ListEntry[];
    smtpThrowOn?: Error;
    smtpFactoryReturning?: FakeSmtpTransport;
  } = {},
): Harness => {
  const imapClients: FakeImapClient[] = [];
  const smtpTransports: FakeSmtpTransport[] = [];

  const clientFactory: ImapClientFactory = () => {
    const c = new FakeImapClient();
    if (hookOverrides.listEntries) c.listEntries = hookOverrides.listEntries;
    if (hookOverrides.pendingAppendError) c.appendError = hookOverrides.pendingAppendError;
    imapClients.push(c);
    return c;
  };

  const smtpFactory: SmtpTransportFactory = () => {
    const t = hookOverrides.smtpFactoryReturning ?? new FakeSmtpTransport();
    if (hookOverrides.smtpThrowOn) t.throwOnSend = hookOverrides.smtpThrowOn;
    smtpTransports.push(t);
    return t;
  };

  const provider = createImapProvider({
    slug: 'work',
    config: () => baseConfig(cfgOverrides),
    clientFactory,
    smtpFactory,
    messageIdUuid: () => 'fixed-uuid-1234',
  });

  return { provider, imapClients, smtpTransports };
};

const minimalMsg: OutgoingMessage = {
  to: ['bob@example.com'],
  subject: 'hello',
  body_text: 'world',
};

// ────────────────────────────────────────────────────────────────
// 1. sendCapable wired to smtp block presence
// ────────────────────────────────────────────────────────────────

describe('D-127 P1.5 — sendCapable smtp block wiring', () => {
  it('flips true iff config.smtp is present', () => {
    const cap = newHarness();
    expect(cap.provider.sendCapable).toBe(true);
    expect(typeof cap.provider.send).toBe('function');

    const noSmtp = newHarness({ smtp: undefined });
    expect(noSmtp.provider.sendCapable).toBe(false);
    expect(noSmtp.provider.send).toBeUndefined();
  });

  it('assertSendCapable narrows on a send-capable imap provider', () => {
    const cap = newHarness();
    expect(() => assertSendCapable(cap.provider)).not.toThrow();
  });
});

// ────────────────────────────────────────────────────────────────
// 2. Pure helpers — Message-Id + RFC 5322 + Sent folder discovery
// ────────────────────────────────────────────────────────────────

describe('D-127 P1.5 — generateImapMessageId', () => {
  it('produces <uuid@<sender_domain>> when from has @', () => {
    const id = generateImapMessageId('alice@example.com', 'imap.fallback', () => 'uuid-1');
    expect(id).toBe('<uuid-1@example.com>');
  });

  it('falls back to host when from address has no @', () => {
    const id = generateImapMessageId('no-at-here', 'smtp.example.com', () => 'uuid-2');
    expect(id).toBe('<uuid-2@smtp.example.com>');
  });
});

describe('D-127 P1.5 — buildImapRfc5322', () => {
  it('emits explicit From + Message-Id headers (SMTP requires both)', () => {
    const rfc = buildImapRfc5322(minimalMsg, {
      from: 'alice@example.com',
      messageId: '<id-1@example.com>',
      sentAt: Date.UTC(2024, 0, 1, 10, 0, 0),
    });
    expect(rfc).toContain('From: alice@example.com');
    expect(rfc).toContain('Message-ID: <id-1@example.com>');
    expect(rfc).toContain('To: bob@example.com');
    expect(rfc).toContain('Subject: hello');
    expect(rfc).toMatch(/Date: Mon, 01 Jan 2024 10:00:00 \+0000/);
    expect(rfc).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(rfc.endsWith('world')).toBe(true);
  });

  it('upgrades to multipart/alternative + threading headers when supplied', () => {
    const rfc = buildImapRfc5322(
      {
        ...minimalMsg,
        cc: ['c@example.com'],
        bcc: ['d@example.com'],
        body_html: '<p>rich</p>',
        in_reply_to: '<parent@example.com>',
        references: ['<gp@example.com>', '<parent@example.com>'],
        reply_to: 'r@example.com',
      },
      { from: 'alice@example.com', messageId: '<id@example.com>', sentAt: 0 },
      () => 0.42, // deterministic boundary suffix
    );
    expect(rfc).toMatch(/Content-Type: multipart\/alternative; boundary="recued_/);
    expect(rfc).toContain('Cc: c@example.com');
    expect(rfc).toContain('Bcc: d@example.com');
    expect(rfc).toContain('In-Reply-To: <parent@example.com>');
    expect(rfc).toContain('References: <gp@example.com> <parent@example.com>');
    expect(rfc).toContain('Reply-To: r@example.com');
    expect(rfc).toContain('<p>rich</p>');
  });
});

describe('D-127 P1.5 — findSentFolder discovery', () => {
  it('prefers a mailbox with the \\Sent special-use flag', async () => {
    const c = new FakeImapClient();
    c.listEntries = [
      { path: 'INBOX' },
      { path: 'Custom-Sent-Path', specialUse: '\\Sent' },
      { path: 'Sent' }, // would be the fallback if flag absent
    ];
    expect(await findSentFolder(c)).toBe('Custom-Sent-Path');
  });

  it('falls back through the candidate chain when no mailbox has the flag', async () => {
    const c = new FakeImapClient();
    // No \\Sent flag; only "Sent Items" present (Outlook-style).
    c.listEntries = [
      { path: 'INBOX' },
      { path: 'Sent Items' },
    ];
    expect(await findSentFolder(c)).toBe('Sent Items');
    // fallback ordering — should pick 'Sent' over 'Sent Items' when both exist.
    c.listEntries = [
      { path: 'INBOX' },
      { path: 'Sent Items' },
      { path: 'Sent' },
    ];
    expect(await findSentFolder(c)).toBe('Sent');
  });

  it('returns null when no flag and no fallback candidate matches', async () => {
    const c = new FakeImapClient();
    c.listEntries = [{ path: 'INBOX' }, { path: 'Archive' }];
    expect(await findSentFolder(c)).toBe(null);
  });

  it('returns null when client lacks list capability', async () => {
    const noList = { /* no list method */ } as unknown as ImapClient;
    expect(await findSentFolder(noList)).toBe(null);
  });

  it('exports the canonical fallback candidate list', () => {
    expect([...IMAP_SENT_FOLDER_FALLBACK_CANDIDATES]).toEqual([
      'Sent', 'Sent Items', 'Sent Messages', 'INBOX.Sent',
    ]);
  });
});

// ────────────────────────────────────────────────────────────────
// 3. send() — happy path (SMTP success + APPEND success)
// ────────────────────────────────────────────────────────────────

describe('D-127 P1.5 — send() happy path', () => {
  it('submits via SMTP, APPENDs to Sent folder, returns SentMessageMeta', async () => {
    const h = newHarness({}, {
      listEntries: [
        { path: 'INBOX' },
        { path: 'Sent', specialUse: '\\Sent' },
      ],
    });
    await h.provider.connect();
    assertSendCapable(h.provider);

    const meta = await h.provider.send({
      ...minimalMsg,
      cc: ['c@example.com'],
      bcc: ['d@example.com'],
    });

    expect(meta).toMatchObject({
      source_id: '<fixed-uuid-1234@example.com>',
      message_id: '<fixed-uuid-1234@example.com>',
    });
    expect(meta.thread_id).toBeUndefined();
    expect(meta.warnings).toBeUndefined();

    // SMTP got the raw RFC 5322 + envelope listing every recipient.
    expect(h.smtpTransports).toHaveLength(1);
    const smtpCall = h.smtpTransports[0]?.calls[0];
    expect(smtpCall?.envelope).toEqual({
      from: 'alice@example.com',
      to: ['bob@example.com', 'c@example.com', 'd@example.com'],
    });
    expect(typeof smtpCall?.raw === 'string' && smtpCall.raw.includes('Message-ID: <fixed-uuid-1234@example.com>')).toBe(true);
    // Transport closed after the send.
    expect(h.smtpTransports[0]?.closeCalls).toBe(1);

    // APPEND fired to the discovered Sent folder.
    expect(h.imapClients[0]?.appendCalls).toHaveLength(1);
    expect(h.imapClients[0]?.appendCalls[0]?.path).toBe('Sent');
    expect(h.imapClients[0]?.appendCalls[0]?.flags).toEqual(['\\Seen']);
  });

  it('SMTP creds default to IMAP creds when omitted', async () => {
    const factorySpy = vi.fn();
    const h = newHarness(
      {
        smtp: { host: 'smtp.example.com' /* no port/secure/username/password */ },
      },
      { listEntries: [{ path: 'Sent', specialUse: '\\Sent' }] },
    );
    // Capture transport-construction args by wrapping smtpFactory.
    const provider = createImapProvider({
      slug: 'work',
      config: () => baseConfig({
        smtp: { host: 'smtp.example.com' },
      }),
      clientFactory: () => {
        const c = new FakeImapClient();
        c.listEntries = [{ path: 'Sent', specialUse: '\\Sent' }];
        return c;
      },
      smtpFactory: (cfg) => {
        factorySpy(cfg);
        return new FakeSmtpTransport();
      },
      messageIdUuid: () => 'u',
    });
    await provider.connect();
    assertSendCapable(provider);
    await provider.send(minimalMsg);
    expect(factorySpy).toHaveBeenCalledWith({
      host: 'smtp.example.com',
      port: 587, // DEFAULT_SMTP_PORT
      secure: false,
      auth: { user: 'alice@example.com', pass: 'pass' },
    });
  });
});

// ────────────────────────────────────────────────────────────────
// 4. APPEND best-effort behavior
// ────────────────────────────────────────────────────────────────

describe('D-127 P1.5 — APPEND best-effort', () => {
  it('APPEND failure → MAIL_SEND_APPEND_FAILED warning, send still succeeds', async () => {
    const h = newHarness({}, {
      listEntries: [{ path: 'Sent', specialUse: '\\Sent' }],
      pendingAppendError: new Error('mailbox quota exceeded'),
    });
    await h.provider.connect();
    assertSendCapable(h.provider);
    const meta = await h.provider.send(minimalMsg);
    expect(meta.message_id).toBe('<fixed-uuid-1234@example.com>');
    expect(meta.warnings).toBeDefined();
    expect(meta.warnings).toHaveLength(1);
    expect(meta.warnings?.[0].code).toBe('MAIL_SEND_APPEND_FAILED');
    expect(meta.warnings?.[0].message).toMatch(/quota exceeded/);
    // SMTP submission still considered successful.
    expect(h.smtpTransports[0]?.calls).toHaveLength(1);
  });

  it('No Sent folder discoverable → APPEND_FAILED warning with discovery context', async () => {
    const h = newHarness({}, {
      listEntries: [{ path: 'INBOX' }, { path: 'Archive' }],
    });
    await h.provider.connect();
    assertSendCapable(h.provider);
    const meta = await h.provider.send(minimalMsg);
    expect(meta.warnings?.[0].code).toBe('MAIL_SEND_APPEND_FAILED');
    expect(meta.warnings?.[0].message).toMatch(/Sent folder/i);
  });
});

// ────────────────────────────────────────────────────────────────
// 5. SMTP error mapping
// ────────────────────────────────────────────────────────────────

describe('D-127 P1.5 — SMTP error mapping', () => {
  const smtpErr = (overrides: Partial<{ code: string; responseCode: number; message: string }>): Error => {
    const e = new Error(overrides.message ?? 'smtp failed') as Error & {
      code?: string; responseCode?: number;
    };
    if (overrides.code !== undefined) e.code = overrides.code;
    if (overrides.responseCode !== undefined) e.responseCode = overrides.responseCode;
    return e;
  };

  it('EAUTH → MAIL_SEND_AUTH_FAILED', async () => {
    const h = newHarness({}, {
      smtpThrowOn: smtpErr({ code: 'EAUTH', responseCode: 535, message: 'Authentication failed' }),
    });
    await h.provider.connect();
    assertSendCapable(h.provider);
    try {
      await h.provider.send(minimalMsg);
      expect.fail('expected MAIL_SEND_AUTH_FAILED');
    } catch (err) {
      expect(err).toBeInstanceOf(IngredientError);
      expect((err as IngredientError).code).toBe('MAIL_SEND_AUTH_FAILED');
      expect((err as IngredientError).details).toMatchObject({
        kind: 'imap', slug: 'work', smtp_code: 'EAUTH',
      });
    }
    // Transport still closed even on error.
    expect(h.smtpTransports[0]?.closeCalls).toBe(1);
  });

  it('EENVELOPE → MAIL_SEND_RECIPIENT_INVALID', async () => {
    const h = newHarness({}, {
      smtpThrowOn: smtpErr({ code: 'EENVELOPE', responseCode: 550, message: 'No such user' }),
    });
    await h.provider.connect();
    assertSendCapable(h.provider);
    try {
      await h.provider.send(minimalMsg);
      expect.fail('expected MAIL_SEND_RECIPIENT_INVALID');
    } catch (err) {
      expect((err as IngredientError).code).toBe('MAIL_SEND_RECIPIENT_INVALID');
    }
  });

  it('5xx without EAUTH → MAIL_SEND_RECIPIENT_INVALID', async () => {
    const h = newHarness({}, {
      smtpThrowOn: smtpErr({ code: 'EMESSAGE', responseCode: 552, message: 'Message size limit' }),
    });
    await h.provider.connect();
    assertSendCapable(h.provider);
    try {
      await h.provider.send(minimalMsg);
      expect.fail('expected MAIL_SEND_RECIPIENT_INVALID');
    } catch (err) {
      expect((err as IngredientError).code).toBe('MAIL_SEND_RECIPIENT_INVALID');
    }
  });

  it('ESOCKET (network) → MAIL_SEND_NETWORK_FAILED', async () => {
    const h = newHarness({}, {
      smtpThrowOn: smtpErr({ code: 'ESOCKET', message: 'Connection reset' }),
    });
    await h.provider.connect();
    assertSendCapable(h.provider);
    try {
      await h.provider.send(minimalMsg);
      expect.fail('expected MAIL_SEND_NETWORK_FAILED');
    } catch (err) {
      expect((err as IngredientError).code).toBe('MAIL_SEND_NETWORK_FAILED');
    }
  });

  it('Unknown error code → MAIL_SEND_NETWORK_FAILED (default)', async () => {
    const h = newHarness({}, {
      smtpThrowOn: smtpErr({ message: 'generic boom' }),
    });
    await h.provider.connect();
    assertSendCapable(h.provider);
    try {
      await h.provider.send(minimalMsg);
      expect.fail('expected MAIL_SEND_NETWORK_FAILED');
    } catch (err) {
      expect((err as IngredientError).code).toBe('MAIL_SEND_NETWORK_FAILED');
    }
  });
});
