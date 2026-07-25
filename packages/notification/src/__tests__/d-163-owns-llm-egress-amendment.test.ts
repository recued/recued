/** D-163 `owns_llm_egress` amendment — the D-167 P0 "Channel ownership
 *  signal" no-op seam.
 *
 *  D-167 § "Channel ownership signal" files a D-163 follow-on: add
 *  `owns_llm_egress: boolean` to the notification `Channel` so the D-167
 *  P1 chat-mode PII-aliasing middleware can read `channel.owns_llm_egress`
 *  at hook time and no-op cleanly on external-egress channels. This suite
 *  locks the seam that lands AHEAD of that wiring (D-167 P0).
 *
 *  Invariants under test:
 *   - I-A: every shipped adapter declares `owns_llm_egress` (a boolean).
 *   - I-B: the per-medium values — only `ui` (the webclient surface Recued
 *          renders + restores on) owns the LLM↔user boundary; `bridge`
 *          (OS renders), `email` (external mail client renders), and
 *          `slack` / `telegram` (external apps own presentation) do not.
 *   - I-C: `owns_llm_egress` is a STRUCTURAL, readonly, REQUIRED member of
 *          `Channel` — a sibling of `capability` under D-163 N.2's
 *          static-adapter-declaration model (NOT folded into the
 *          `ChannelCapability` string union, so `channel.owns_llm_egress`
 *          is the access path the spec names).
 *   - I-D: the flag is a pure SEAM — the notification block routes by
 *          `capability` alone and never reads `owns_llm_egress`; the only
 *          reader is the future D-167 P1 middleware (out of scope here).
 *
 *  Spec: D-167 § "Channel ownership signal" + P0/P1;
 *  D-163 § A.1 / N.1 / N.2.
 */

import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  createBridgeChannel,
  createEmailChannel,
  createRemoteChannel,
  createUiChannel,
  type Channel,
  type CredentialResolver,
  type EmailSender,
  type RemoteChannelCredential,
} from '../index.js';
import type {
  InteractiveTransport,
  TransportSendResult,
  TransportVendor,
} from '@recued/transport';
import { isTypeScriptSource } from '../../../../test/source-file-extensions.js';

// ── Minimal adapter instantiations (mirror the canonical D-158 channel
//    tests — the seam value is a static literal on each factory return). ──

const okResult: TransportSendResult = { ok: true };

const credential: RemoteChannelCredential = {
  recipient: 'C123',
  token: 'xoxb-token',
};

const credentialResolver = (): ReturnType<typeof vi.fn<CredentialResolver>> =>
  vi.fn<CredentialResolver>(async () => credential);

const emailSender = (): ReturnType<typeof vi.fn<EmailSender>> =>
  vi.fn<EmailSender>(async () => {});

const fakeTransport = (vendor: TransportVendor): InteractiveTransport => ({
  vendor,
  send: vi.fn<InteractiveTransport['send']>(async () => okResult),
  parseInbound: vi.fn<InteractiveTransport['parseInbound']>(() => null),
  parseConversationId: vi.fn<InteractiveTransport['parseConversationId']>(
    () => null,
  ),
  sendPrompt: vi.fn<InteractiveTransport['sendPrompt']>(async () => okResult),
  parseInboundChoice: vi.fn<InteractiveTransport['parseInboundChoice']>(
    () => null,
  ),
  parseCallbackConversationId: vi.fn<InteractiveTransport['parseCallbackConversationId']>(
    () => null,
  ),
  closePrompt: vi.fn<InteractiveTransport['closePrompt']>(async () => okResult),
});

const uiChannel = (): Channel => createUiChannel({ busSink: () => {} });
const bridgeChannel = (): Channel =>
  createBridgeChannel({ bridgeSink: () => {} });
const emailChannel = (): Channel =>
  createEmailChannel({ sendEmail: emailSender() });
const remoteChannel = (vendor: TransportVendor): Channel =>
  createRemoteChannel({
    transport: fakeTransport(vendor),
    resolveCredential: credentialResolver(),
  });

describe('D-163 owns_llm_egress — per-adapter declarations (I-A / I-B)', () => {
  it('ui owns the LLM↔user boundary (webclient renders + restores on it)', () => {
    expect(uiChannel().owns_llm_egress).toBe(true);
  });

  it('bridge does NOT own egress (the OS renders the notification body)', () => {
    expect(bridgeChannel().owns_llm_egress).toBe(false);
  });

  it('email does NOT own egress (an external mail client renders the body)', () => {
    expect(emailChannel().owns_llm_egress).toBe(false);
  });

  it('slack does NOT own egress (external app owns downstream presentation)', () => {
    expect(remoteChannel('slack').owns_llm_egress).toBe(false);
  });

  it('telegram does NOT own egress (external app owns downstream presentation)', () => {
    expect(remoteChannel('telegram').owns_llm_egress).toBe(false);
  });

  it('every shipped adapter declares a boolean owns_llm_egress; exactly one (ui) is true', () => {
    const adapters: ReadonlyArray<{ channel: Channel; expected: boolean }> = [
      { channel: uiChannel(), expected: true },
      { channel: bridgeChannel(), expected: false },
      { channel: emailChannel(), expected: false },
      { channel: remoteChannel('slack'), expected: false },
      { channel: remoteChannel('telegram'), expected: false },
    ];

    for (const { channel, expected } of adapters) {
      expect(typeof channel.owns_llm_egress).toBe('boolean');
      expect(channel.owns_llm_egress).toBe(expected);
    }

    const owning = adapters.filter((a) => a.channel.owns_llm_egress);
    expect(owning.map((a) => a.channel.name)).toEqual(['ui']);
  });
});

describe('D-163 owns_llm_egress — structural declaration (I-C / D-163 N.2)', () => {
  it('is readonly — reassignment is a compile-time error (TS ratchet, like capability)', () => {
    const channel = bridgeChannel();
    expect(channel.owns_llm_egress).toBe(false);
    // @ts-expect-error — D-163 N.2: owns_llm_egress is a readonly structural
    // declaration and cannot be reassigned post-construction.
    channel.owns_llm_egress = true;
  });

  it('is REQUIRED — omitting only owns_llm_egress from an otherwise-complete Channel is rejected', () => {
    // A fully-typed Channel fixture, checked NORMALLY (no directive): if
    // `Channel` gains another required member, THIS line fails outside any
    // suppression, so interface drift surfaces here instead of being masked
    // by the single-error `@ts-expect-error` on the negative assertion below.
    const complete: Channel = {
      name: 'ui',
      capability: 'inline',
      owns_llm_egress: true,
      async deliverNotify() {},
      async deliverAsk() {},
      async closeAsk() {},
    };

    // Strip EXACTLY owns_llm_egress; every other required member remains, so
    // the assignment errors on this one missing field and nothing else — the
    // directive cannot accidentally mask unrelated interface drift.
    const withoutEgress: Omit<Channel, 'owns_llm_egress'> = complete;
    // @ts-expect-error — Channel requires owns_llm_egress (the only error).
    const incomplete: Channel = withoutEgress;
    void incomplete;
  });
});

describe('D-163 owns_llm_egress — pure seam, no block routing dependency (I-D)', () => {
  const NOTIFICATION_SRC = join(__dirname, '..');
  // The interface declaration file is the one place the dotted token appears
  // (in the field docstring); the reader the seam is built for lands in
  // D-167 P1, outside this package.
  const DECLARATION_FILE = join('channels', 'channel.ts');

  const walkSource = function* (dir: string): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__' || entry.name === 'dist') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) yield* walkSource(full);
      else if (isTypeScriptSource(entry.name)) yield full;
    }
  };

  it('no notification-block / settings code reads channel.owns_llm_egress yet (D-167 P1 wires the read)', () => {
    const readers: string[] = [];
    for (const file of walkSource(NOTIFICATION_SRC)) {
      if (file.endsWith(DECLARATION_FILE)) continue;
      // A READ is a `.owns_llm_egress` member access; the four adapter
      // DECLARATIONS are `owns_llm_egress:` property literals (no leading
      // dot) and so are deliberately not matched.
      if (/\.owns_llm_egress\b/.test(readFileSync(file, 'utf8'))) {
        readers.push(file);
      }
    }
    expect(readers).toEqual([]);
  });
});
