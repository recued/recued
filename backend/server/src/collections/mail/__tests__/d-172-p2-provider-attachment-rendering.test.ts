/** D-172 P2 (Attachments-v2) — per-provider native attachment shape.
 *
 *  Pins how each of the three mail providers renders a resolved
 *  `OutgoingAttachment` into its native wire format:
 *    - Gmail / IMAP → a `multipart/mixed` RFC 5322 with the body as the
 *      lead part and each attachment a base64 `Content-Disposition:
 *      attachment` part (the same builder shape; IMAP adds From +
 *      Message-Id headers).
 *    - Graph → an `attachments[]` array of
 *      `#microsoft.graph.fileAttachment` resources carrying
 *      `contentBytes` (base64) verbatim.
 *
 *  These are pure-function tests over the builders — no network. The
 *  resolve path (refs → bytes) + over-size warn + mutation guard live in
 *  `d-172-p2-mail-collection-attachments.test.ts`. */

import { describe, it, expect } from 'vitest';
import { buildGmailRfc5322 } from '../gmail-provider.js';
import { buildImapRfc5322 } from '../imap-provider.js';
import { buildGraphMessage } from '../graph-provider.js';
import type { OutgoingAttachment, OutgoingMessage } from '../provider.js';

const PDF_BYTES = Buffer.from('%PDF-1.4 hello world attachment body');
const PDF_B64 = PDF_BYTES.toString('base64');

const oneAttachment: OutgoingAttachment = {
  filename: 'contract.pdf',
  mime_type: 'application/pdf',
  bytes_b64: PDF_B64,
  size_bytes: PDF_BYTES.length,
};

const twoAttachments: OutgoingAttachment[] = [
  oneAttachment,
  {
    filename: 'photo.png',
    mime_type: 'image/png',
    bytes_b64: Buffer.from('\x89PNG fake image').toString('base64'),
    size_bytes: Buffer.from('\x89PNG fake image').length,
  },
];

// ────────────────────────────────────────────────────────────────
// Gmail — multipart/mixed RFC 5322
// ────────────────────────────────────────────────────────────────

describe('D-172 P2 — buildGmailRfc5322 attachment rendering', () => {
  const SENT = Date.UTC(2024, 0, 1, 10, 0, 0);

  it('no attachments → unchanged single-part text/plain (byte-compatible with the legacy shape)', () => {
    const out = buildGmailRfc5322(
      { to: ['a@example.com'], subject: 'hi', body_text: 'hello' },
      SENT,
    );
    expect(out).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(out).not.toContain('multipart/mixed');
    expect(out.endsWith('hello')).toBe(true);
  });

  it('one attachment → multipart/mixed with the body part + a base64 attachment part', () => {
    const out = buildGmailRfc5322(
      { to: ['a@example.com'], subject: 'hi', body_text: 'hello', attachments: [oneAttachment] },
      SENT,
      () => 0.42, // deterministic boundary
    );
    expect(out).toMatch(/Content-Type: multipart\/mixed; boundary="recued_[a-z0-9_]+"/);
    // Body part still present (text/plain lead part).
    expect(out).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(out).toContain('hello');
    // Attachment part: native MIME shape.
    expect(out).toContain('Content-Type: application/pdf; name="contract.pdf"');
    expect(out).toContain('Content-Transfer-Encoding: base64');
    expect(out).toContain('Content-Disposition: attachment; filename="contract.pdf"');
    // base64 payload present (small payload => single ≤76-char line).
    expect(out).toContain(PDF_B64);
    // Closing mixed delimiter.
    expect(out).toMatch(/--recued_[a-z0-9_]+--$/);
  });

  it('html body + attachment → multipart/mixed wrapping a multipart/alternative lead part', () => {
    const out = buildGmailRfc5322(
      {
        to: ['a@example.com'], subject: 'hi',
        body_text: 'plain', body_html: '<p>rich</p>',
        attachments: [oneAttachment],
      },
      SENT,
    );
    expect(out).toContain('multipart/mixed');
    expect(out).toContain('multipart/alternative');
    expect(out).toContain('<p>rich</p>');
    expect(out).toContain('Content-Disposition: attachment; filename="contract.pdf"');
  });

  it('multiple attachments → one base64 part per attachment', () => {
    const out = buildGmailRfc5322(
      { to: ['a@example.com'], subject: 'hi', body_text: 'b', attachments: twoAttachments },
      SENT,
    );
    expect(out).toContain('Content-Disposition: attachment; filename="contract.pdf"');
    expect(out).toContain('Content-Disposition: attachment; filename="photo.png"');
    expect(out).toContain('Content-Type: image/png; name="photo.png"');
  });

  it('wraps long base64 payloads to ≤76-char lines (RFC 2045 §6.8)', () => {
    const bigBytes = Buffer.alloc(500, 0x61); // 500 'a' bytes → ~668 base64 chars
    const out = buildGmailRfc5322(
      {
        to: ['a@example.com'], subject: 'hi', body_text: 'b',
        attachments: [{
          filename: 'big.bin', mime_type: 'application/octet-stream',
          bytes_b64: bigBytes.toString('base64'), size_bytes: bigBytes.length,
        }],
      },
      SENT,
    );
    // Extract the attachment payload region and assert no line exceeds 76 chars.
    const afterDisp = out.split('Content-Disposition: attachment; filename="big.bin"')[1] ?? '';
    const payloadLines = afterDisp.split('\r\n').filter((l) => /^[A-Za-z0-9+/=]+$/.test(l));
    expect(payloadLines.length).toBeGreaterThan(1);
    for (const line of payloadLines) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
  });
});

// ────────────────────────────────────────────────────────────────
// IMAP — multipart/mixed RFC 5322 (From + Message-Id explicit)
// ────────────────────────────────────────────────────────────────

describe('D-172 P2 — buildImapRfc5322 attachment rendering', () => {
  const meta = { from: 'me@example.com', messageId: '<mid@example.com>', sentAt: Date.UTC(2024, 0, 1, 10, 0, 0) };

  it('no attachments → unchanged single-part text/plain', () => {
    const out = buildImapRfc5322(
      { to: ['a@example.com'], subject: 'hi', body_text: 'hello' },
      meta,
    );
    expect(out).toContain('From: me@example.com');
    expect(out).toContain('Message-ID: <mid@example.com>');
    expect(out).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(out).not.toContain('multipart/mixed');
  });

  it('one attachment → multipart/mixed, From/Message-Id preserved, base64 attachment part', () => {
    const out = buildImapRfc5322(
      { to: ['a@example.com'], subject: 'hi', body_text: 'hello', attachments: [oneAttachment] },
      meta,
      () => 0.7,
    );
    expect(out).toContain('From: me@example.com');
    expect(out).toContain('Message-ID: <mid@example.com>');
    expect(out).toMatch(/Content-Type: multipart\/mixed; boundary="recued_[a-z0-9_]+"/);
    expect(out).toContain('Content-Type: application/pdf; name="contract.pdf"');
    expect(out).toContain('Content-Disposition: attachment; filename="contract.pdf"');
    expect(out).toContain(PDF_B64);
    expect(out).toContain('hello');
  });

  it('html body + attachment → multipart/mixed wrapping multipart/alternative', () => {
    const out = buildImapRfc5322(
      { to: ['a@example.com'], subject: 'hi', body_text: 'plain', body_html: '<b>x</b>', attachments: [oneAttachment] },
      meta,
    );
    expect(out).toContain('multipart/mixed');
    expect(out).toContain('multipart/alternative');
    expect(out).toContain('<b>x</b>');
    expect(out).toContain('Content-Disposition: attachment; filename="contract.pdf"');
  });
});

// ────────────────────────────────────────────────────────────────
// Graph — fileAttachment[] with contentBytes
// ────────────────────────────────────────────────────────────────

describe('D-172 P2 — buildGraphMessage attachment rendering', () => {
  it('no attachments → no attachments field on the message', () => {
    const m = buildGraphMessage({ to: ['a@example.com'], subject: 'hi', body_text: 'b' });
    expect(m.attachments).toBeUndefined();
  });

  it('one attachment → a #microsoft.graph.fileAttachment with contentBytes verbatim', () => {
    const m = buildGraphMessage({
      to: ['a@example.com'], subject: 'hi', body_text: 'b', attachments: [oneAttachment],
    } as OutgoingMessage);
    expect(m.attachments).toHaveLength(1);
    expect(m.attachments?.[0]).toEqual({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: 'contract.pdf',
      contentType: 'application/pdf',
      contentBytes: PDF_B64,
    });
  });

  it('multiple attachments → one fileAttachment resource each, order preserved', () => {
    const m = buildGraphMessage({
      to: ['a@example.com'], subject: 'hi', body_text: 'b', attachments: twoAttachments,
    } as OutgoingMessage);
    expect(m.attachments).toHaveLength(2);
    expect(m.attachments?.[0].name).toBe('contract.pdf');
    expect(m.attachments?.[1].name).toBe('photo.png');
    expect(m.attachments?.[1].contentType).toBe('image/png');
    for (const att of m.attachments ?? []) {
      expect(att['@odata.type']).toBe('#microsoft.graph.fileAttachment');
    }
  });
});

// ────────────────────────────────────────────────────────────────
// Filename → MIME header parameter (`mimeFilenameParameter`)
//
// ⛔ REGRESSION PIN. Both RFC 5322 builders used to interpolate the filename
// raw into a quoted-string. Every assertion in this file passed throughout,
// because each one used a filename that needed no quoting — the cases below
// are the ones that DO. Found by driving a real send into a local SMTP sink
// and parsing what came back out (`dev/mail-attachment-smtp-drive.ts` check
// 6.1): `in"voice.pdf` reached the recipient as `invoice.pdf`.
//
// Non-ASCII is pinned on the RAW header, not on a parsed filename: the pre-fix
// build shipped it as raw 8-bit, and a lenient parser round-trips that
// perfectly — so an assertion phrased as "the parsed name matches" would have
// passed on the broken build too.
// ────────────────────────────────────────────────────────────────

const attachmentNamed = (filename: string): OutgoingAttachment => ({
  ...oneAttachment,
  filename,
});

describe('D-172 P2 — attachment filename → MIME header parameter', () => {
  const meta = {
    from: 'me@example.com',
    messageId: '<mid@example.com>',
    sentAt: Date.UTC(2024, 0, 1, 10, 0, 0),
  };

  it('escapes a double-quote as an RFC 2822 quoted-pair (IMAP + Gmail)', () => {
    const msg = (a: OutgoingAttachment): OutgoingMessage => ({
      to: ['a@example.com'], subject: 'hi', body_text: 'hello', attachments: [a],
    });
    const att = attachmentNamed('in"voice.pdf');
    for (const out of [
      buildImapRfc5322(msg(att), meta),
      buildGmailRfc5322(msg(att), 1_700_000_000_000),
    ]) {
      expect(out).toContain('Content-Disposition: attachment; filename="in\\"voice.pdf"');
      expect(out).toContain('name="in\\"voice.pdf"');
      // The unescaped form is what truncated the name at the recipient.
      expect(out).not.toContain('filename="in"voice.pdf"');
    }
  });

  it('escapes a backslash as a quoted-pair', () => {
    const out = buildImapRfc5322(
      {
        to: ['a@example.com'], subject: 'hi', body_text: 'hello',
        attachments: [attachmentNamed('back\\slash.pdf')],
      },
      meta,
    );
    expect(out).toContain('filename="back\\\\slash.pdf"');
  });

  it('RFC 2231-encodes a non-ASCII name and keeps an ASCII fallback', () => {
    const out = buildImapRfc5322(
      {
        to: ['a@example.com'], subject: 'hi', body_text: 'hello',
        attachments: [attachmentNamed('facturé.pdf')],
      },
      meta,
    );
    expect(out).toContain("filename*=UTF-8''factur%C3%A9.pdf");
    expect(out).toContain('filename="factur_.pdf"');
    // Raw 8-bit in a header is what RFC 5322 forbids and what shipped before.
    expect(out).not.toContain('filename="facturé.pdf"');
  });

  it('leaves an ordinary ASCII name untouched (no gratuitous encoding)', () => {
    const out = buildImapRfc5322(
      { to: ['a@example.com'], subject: 'hi', body_text: 'hello', attachments: [oneAttachment] },
      meta,
    );
    expect(out).toContain('Content-Disposition: attachment; filename="contract.pdf"');
    expect(out).not.toContain("filename*=");
  });
});
