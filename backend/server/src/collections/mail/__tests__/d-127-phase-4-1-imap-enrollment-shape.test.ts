/** D-127 P4.1 — server-side enrollment-shape affirmation.
 *
 *  Pins one boundary: the rpc-payload shape the IMAP enrollment
 *  form emits feeds straight into `createImapProvider`'s
 *  `ImapProviderConfig` after slug carve-out. The test re-declares
 *  the shape inline (rather than importing across package
 *  boundaries) so this file stays self-contained inside the
 *  backend suite.
 *
 *  Two cases:
 *    1. SMTP block absent → sendCapable=false, no `send` method.
 *    2. SMTP block present → sendCapable=true, send method exists.
 *
 *  P1.5 already pins the wire-side behavior (transport, RFC 5322
 *  building, append-to-Sent). P4.1 only confirms the *enrollment
 *  payload* projects cleanly onto the existing config shape — the
 *  guarantee the (future) `collection.mail.enrollImap` rpc handler
 *  needs to stand up the provider unchanged. */

import { describe, it, expect } from 'vitest';
import {
  createImapProvider,
  type ImapClient,
  type ImapClientFactory,
  type ImapProviderConfig,
} from '../imap-provider.js';
import { EventEmitter } from 'node:events';
import type { MailboxObject } from 'imapflow';

// ────────────────────────────────────────────────────────────────
// Re-declared form shape (mirrors imap-form.ts ImapEnrollmentPayload)
// ────────────────────────────────────────────────────────────────

interface ImapEnrollmentPayload {
  name: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  folders: string[];
  smtp?: {
    host: string;
    port?: number;
    secure?: boolean;
    username?: string;
    password?: string;
    from?: string;
  };
}

/** The slug carve-out the (future) rpc handler will perform — name
 *  becomes the provider slug; everything else feeds into the config. */
const projectPayloadToProviderInputs = (
  payload: ImapEnrollmentPayload,
): { slug: string; config: ImapProviderConfig } => {
  const { name, ...rest } = payload;
  return { slug: name, config: rest };
};

class StubImapClient extends EventEmitter implements ImapClient {
  usable = true;
  async connect(): Promise<void> { /* no-op */ }
  async logout(): Promise<void> { this.usable = false; }
  close(): void { this.usable = false; }
  async mailboxOpen(path: string): Promise<MailboxObject> {
    return { path, delimiter: '/', flags: new Set(), exists: 0 } as unknown as MailboxObject;
  }
  async search(): Promise<number[]> { return []; }
  async *fetch(): AsyncIterable<never> { /* yields nothing */ }
  async idle(): Promise<boolean> { return true; }
}

const stubFactory: ImapClientFactory = () => new StubImapClient();

// ────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────

describe('D-127 P4.1 — IMAP enrollment payload feeds createImapProvider', () => {
  it('read-only enrollment (no smtp block) → sendCapable=false, no send method', () => {
    const payload: ImapEnrollmentPayload = {
      name: 'work-imap',
      host: 'imap.example.com',
      port: 993,
      secure: true,
      username: 'me@example.com',
      password: 'hunter2',
      folders: ['INBOX'],
      // smtp omitted by the form when sendEnabled=false.
    };
    const { slug, config } = projectPayloadToProviderInputs(payload);
    const provider = createImapProvider({
      slug,
      config: () => config,
      clientFactory: stubFactory,
    });

    expect(provider.kind).toBe('imap');
    expect(provider.slug).toBe('work-imap');
    expect(provider.sendCapable).toBe(false);
    expect(provider.send).toBeUndefined();
    // accountEmail still derives from username so the rpc-layer
    // self-loop guard has something to compare against (even though
    // this enrollment can never reach the send path).
    expect(provider.accountEmail).toBe('me@example.com');
  });

  it('send-enabled enrollment (smtp host only) → sendCapable=true, send wired, defaults at provider', () => {
    const payload: ImapEnrollmentPayload = {
      name: 'work-imap',
      host: 'imap.example.com',
      port: 993,
      secure: true,
      username: 'me@example.com',
      password: 'hunter2',
      folders: ['INBOX'],
      smtp: {
        host: 'smtp.example.com',
        // port / secure / username / password / from all blank — form
        // deliberately omits them so the provider's fallback ladder
        // runs untouched (port → 587, secure → false / STARTTLS,
        // username → 'me@example.com', password → 'hunter2', from →
        // 'me@example.com').
      },
    };
    const { slug, config } = projectPayloadToProviderInputs(payload);
    const provider = createImapProvider({
      slug,
      config: () => config,
      clientFactory: stubFactory,
    });

    expect(provider.sendCapable).toBe(true);
    expect(typeof provider.send).toBe('function');
    // accountEmail still derives from IMAP username when smtp.from
    // is absent — keeps the self-loop guard honest with the actual
    // sender identity that nodemailer will put on the envelope.
    expect(provider.accountEmail).toBe('me@example.com');
  });

  it('send-enabled with explicit smtp.from → accountEmail follows the override', () => {
    const payload: ImapEnrollmentPayload = {
      name: 'newsletter',
      host: 'imap.example.com',
      port: 993,
      secure: true,
      username: 'me@example.com',
      password: 'hunter2',
      folders: ['INBOX'],
      smtp: {
        host: 'smtp.example.com',
        from: 'newsletter@example.com',
      },
    };
    const { slug, config } = projectPayloadToProviderInputs(payload);
    const provider = createImapProvider({
      slug,
      config: () => config,
      clientFactory: stubFactory,
    });

    expect(provider.sendCapable).toBe(true);
    expect(provider.accountEmail).toBe('newsletter@example.com');
  });
});
