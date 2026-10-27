/** SMTP transport and MIME composition shared by IMAP and send-only accounts. */
import { randomUUID } from 'node:crypto';
import { IngredientError } from '@recued/ingredients';
import { MAIL_RECONCILIATION_ID_HEADER } from '@recued/contracts';
import { MAIL_AUTOMATIC_REPLY_HEADERS, mimeFilenameParameter, type MailDispatchBoundary, type OutgoingMessage, type SentMessageMeta } from './provider.js';

/** Narrow SMTP transport surface that matches what nodemailer's
 *  `Transporter` exposes for our send path. `raw` carries the
 *  fully-built RFC 5322 message; `envelope` overrides the SMTP
 *  envelope addresses (To / Cc / Bcc all live in `to`). Tests inject
 *  a fake to assert wire shape + drive error paths without spinning
 *  up a real SMTP server. */
export interface SmtpMailOptions {
  raw: string | Buffer;
  envelope: { from: string; to: string[] };
}

export interface SmtpSendResponse {
  /** RFC 5322 Message-Id the server actually delivered with. We
   *  generate the Message-Id client-side in `buildImapRfc5322` so
   *  this value matches what we sent — exposed here for symmetry
   *  with the gmail-api / graph response shapes. */
  messageId?: string;
  /** Free-form server response string (e.g. `"250 2.0.0 OK"`). */
  response?: string;
}

export interface SmtpTransport {
  sendMail(options: SmtpMailOptions): Promise<SmtpSendResponse>;
  verify?(): Promise<boolean>;
  /** Idempotent close — production transport pools sockets, the
   *  fake is a no-op. */
  close(): void;
}

export type SmtpTransportFactory = (config: {
  host: string;
  port: number;
  secure: boolean;
  requireTLS?: boolean;
  forceAuth?: boolean;
  connectionTimeout?: number;
  greetingTimeout?: number;
  socketTimeout?: number;
  auth: { user: string; pass: string };
}) => SmtpTransport;

/** Wraps `nodemailer` for production. Same deferred-require pattern
 *  as `defaultImapClientFactory` — keeps the SMTP boot cost out of
 *  test runs that inject a fake transport. `nodemailer` ships
 *  without bundled types in the repo's tree, so we structural-type
 *  through `SmtpTransport` rather than reaching for `@types/nodemailer`
 *  (kept as a 1-line fix later if/when we ever need richer types). */
/** The PRODUCTION transport. Nothing else — no env branch.
 *
 *  ⛔ This used to consult `RECUED_BENCH_SMTP_OUTBOX` and, when set, divert the
 *  send to a no-network outbox recorder so the substrate-bench could execute an
 *  APPROVED `mail-send` offline. The lazy `require` meant production never
 *  LOADED the dev module, but the branch itself shipped: esbuild statically
 *  bundled it, so `dist/bin.js` carried the diversion. One env var on a real
 *  server therefore made every outbound mail silently not-send while the mock
 *  returned a synthetic `250 2.0.0 OK` — a delivery failure reported as
 *  `success: true`.
 *
 *  Callers that need a different transport now INJECT one:
 *  `MailAdapterBundle.smtpFactory` → `createImapProvider({ smtpFactory })`
 *  (`compose.ts`). The bench supplies it through its own source-patch step
 *  (internal benchmarks), the same mechanism it already
 *  uses for `wire-chat-orchestrator.ts` — so the diversion exists only in the
 *  bench's own bundle and cannot reach a release artifact. */
export const defaultSmtpTransportFactory: SmtpTransportFactory = (config) => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodemailer = require('nodemailer') as {
    createTransport: (cfg: unknown) => unknown;
  };
  return nodemailer.createTransport(config) as SmtpTransport;
};

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  requireTLS?: boolean;
  username: string;
  password: string;
  from: string;
  reply_to?: string;
}

const transportConfig = (config: SmtpConfig, forceAuth = false): Parameters<SmtpTransportFactory>[0] => ({
  host: config.host, port: config.port, secure: config.secure,
  ...(config.requireTLS !== undefined ? { requireTLS: config.requireTLS } : {}),
  ...(forceAuth ? { forceAuth: true } : {}),
  connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
  auth: { user: config.username, pass: config.password },
});

export const verifySmtpCredentials = async (config: SmtpConfig, factory = defaultSmtpTransportFactory): Promise<void> => {
  const transport = factory(transportConfig(config, true));
  try {
    if (!transport.verify) throw new Error('SMTP login verification is unavailable.');
    await transport.verify();
  } finally { transport.close(); }
};

/** The SMTP envelope retains blind recipients; their header never leaves us. */
const smtpWireMessage = (raw: string): string => {
  const end = raw.indexOf('\r\n\r\n');
  let blind = false;
  const headers = raw.slice(0, end).split('\r\n').filter(line => {
    if (!/^[ \t]/.test(line)) blind = /^bcc:/i.test(line);
    return !blind;
  });
  return headers.join('\r\n') + raw.slice(end);
};

export const submitSmtp = async (opts: {
  kind: 'imap' | 'smtp'; slug: string; msg: OutgoingMessage; config: SmtpConfig;
  factory?: SmtpTransportFactory; now?: () => number; uuid?: () => string;
  beforeSubmit?: (meta: SentMessageMeta) => Promise<void>;
  boundary?: MailDispatchBoundary;
}): Promise<{ meta: SentMessageMeta; raw: string }> => {
  const meta: SentMessageMeta = {
    source_id: generateSmtpMessageId(opts.config.from, opts.config.host, opts.uuid),
    message_id: '', sent_at: (opts.now ?? Date.now)(),
  };
  meta.message_id = meta.source_id;
  const msg = { ...opts.msg, reply_to: opts.msg.reply_to ?? opts.config.reply_to };
  const raw = buildSmtpRfc5322(msg, { from: opts.config.from, messageId: meta.message_id, sentAt: meta.sent_at });
  let transport: SmtpTransport;
  try {
    transport = (opts.factory ?? defaultSmtpTransportFactory)(transportConfig(opts.config, opts.kind === 'smtp'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new IngredientError('MAIL_SEND_NETWORK_FAILED', `SMTP submission could not start: ${message.slice(0, 200)}`,
      { kind: opts.kind, slug: opts.slug, not_sent: true });
  }
  try {
    try { if (opts.beforeSubmit) await opts.beforeSubmit(meta); }
    catch { throw new IngredientError('MAIL_SEND_NETWORK_FAILED', 'The outgoing message could not be saved before submission.',
      { kind: opts.kind, slug: opts.slug, not_sent: true }); }
    try {
      if (opts.boundary?.revalidate) await opts.boundary.revalidate();
      // No await belongs between this check and handing the message to SMTP.
      opts.boundary?.assertActive();
    } catch (error) {
      throw new IngredientError(error instanceof IngredientError ? error.code : 'MAIL_SEND_NETWORK_FAILED',
        error instanceof IngredientError ? error.message : 'SMTP submission was stopped before sending.',
        { ...(error instanceof IngredientError ? error.details : {}), kind: opts.kind, slug: opts.slug,
          not_sent: true, dispatch_blocked: true });
    }
    try {
      await transport.sendMail({ raw: smtpWireMessage(raw),
        envelope: { from: opts.config.from, to: [...msg.to, ...(msg.cc ?? []), ...(msg.bcc ?? [])] } });
    } catch (error) {
      const err = error as { code?: string; responseCode?: number } | null;
      const code = err?.code === 'EAUTH' ? 'MAIL_SEND_AUTH_FAILED'
        : err?.code === 'EENVELOPE' || (typeof err?.responseCode === 'number' && err.responseCode >= 500
          && err.responseCode < 600 && err.responseCode !== 530 && err.responseCode !== 535)
          ? 'MAIL_SEND_RECIPIENT_INVALID' : 'MAIL_SEND_NETWORK_FAILED';
      throw new IngredientError(code, 'SMTP submission failed. Check the account and provider response.', {
        kind: opts.kind, slug: opts.slug, smtp_code: err?.code, smtp_response_code: err?.responseCode,
        ...(smtpProvablyNotAccepted(error) ? { not_sent: true } : {}),
      });
    }
    return { meta, raw };
  } finally { try { transport.close(); } catch { /* submission outcome is authoritative */ } }
};

/** Does this SMTP failure PROVE the server never accepted the message?
 *
 *  Only then may the send claim start afresh (`not_sent`); anything else is an
 *  unknown outcome, because an SMTP server that has taken the whole message may
 *  deliver it even when the reply never reaches us.
 *
 *  Proof is one of:
 *   - the server's own REFUSAL: a 4xx/5xx reply, at any stage. Acceptance is a
 *     2xx after the message, and nodemailer only raises an error carrying a code
 *     when the server said no;
 *   - a stage that ends before the message is ever transmitted: DNS, TLS, sign-in
 *     (`EDNS` / `ETLS` / `EAUTH`), the envelope (`EENVELOPE`, `EREQUIRETLS`);
 *   - the socket never connected (`syscall` `connect` / `getaddrinfo`).
 *
 *  ⚠ NOT `command === 'CONN'`: nodemailer labels EVERY socket error and timeout
 *  that way, including ones in the middle of the message. */
export const smtpProvablyNotAccepted = (err: unknown): boolean => {
  if (err === null || typeof err !== 'object') return false;
  const e = err as { code?: unknown; responseCode?: unknown; syscall?: unknown };
  if (typeof e.responseCode === 'number' && e.responseCode >= 400 && e.responseCode < 600) {
    return true;
  }
  if (
    e.code === 'EDNS' || e.code === 'ETLS' || e.code === 'EAUTH'
    || e.code === 'EENVELOPE' || e.code === 'EREQUIRETLS'
  ) {
    return true;
  }
  return e.syscall === 'connect' || e.syscall === 'getaddrinfo';
};

/** RFC 5322 Date header serialization. Mirrors the gmail-provider
 *  helper — `+0000` form, not `GMT`. */
const formatRfc5322Date = (ms: number): string =>
  new Date(ms).toUTCString().replace(/GMT$/, '+0000');

/** D-127 P1.5 — derive a UUID-based Message-Id whose host suffix
 *  matches the sender's domain so receiving MTAs see a coherent
 *  envelope ↔ Message-Id pairing. Falls back to the SMTP server
 *  hostname when the from address has no `@` (defensive — should
 *  not happen with a validated config). */
export const generateSmtpMessageId = (
  fromAddress: string,
  hostFallback: string,
  uuid: () => string = randomUUID,
): string => {
  const at = fromAddress.indexOf('@');
  const domain = at >= 0 ? fromAddress.slice(at + 1) : hostFallback;
  return `<${uuid()}@${domain}>`;
};

const newMimeBoundary = (rand: () => number): string =>
  `recued_${Date.now().toString(36)}_${rand().toString(36).slice(2, 10)}`;

/** D-172 P2 — RFC 2045 §6.8 base64 line wrap (≤76 chars/line). Mirrors
 *  the gmail-provider helper. */
const wrapBase64 = (b64: string): string =>
  (b64.match(/.{1,76}/g) ?? []).join('\r\n');

/** D-172 P2 — render the message body as one MIME part: bare
 *  text/plain, or a nested multipart/alternative when `body_html` is
 *  present. Used both at top level (no attachments) and as the lead
 *  part of a multipart/mixed (with attachments). */
const renderImapBodyPart = (
  msg: OutgoingMessage,
  rand: () => number,
): { contentTypeHeaders: string[]; body: string } => {
  if (msg.body_html) {
    const boundary = newMimeBoundary(rand);
    return {
      contentTypeHeaders: [
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
      ],
      body: [
        `--${boundary}`,
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: 7bit',
        '',
        msg.body_text,
        `--${boundary}`,
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: 7bit',
        '',
        msg.body_html,
        `--${boundary}--`,
      ].join('\r\n'),
    };
  }
  return {
    contentTypeHeaders: [
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 7bit',
    ],
    body: msg.body_text,
  };
};

/** D-127 P1.5 — RFC 5322 builder for the IMAP+SMTP send path.
 *  Differs from `buildGmailRfc5322` by adding explicit From and
 *  Message-Id headers (Gmail's API derives From from the OAuth
 *  account; SMTP requires both fields explicit). Otherwise the
 *  composition rules match: text/plain default, multipart/alternative
 *  when body_html is set, threading headers verbatim.
 *
 *  D-172 P2 — when `attachments` are present, the message is wrapped in
 *  a multipart/mixed container (body part first, each attachment a
 *  base64-encoded `Content-Disposition: attachment` part). The same
 *  RFC822 string is both SMTP-submitted (via `raw`) and IMAP-APPENDed
 *  to Sent, so attachments land in both places. */
export const buildSmtpRfc5322 = (
  msg: OutgoingMessage,
  meta: { from: string; messageId: string; sentAt: number },
  rand: () => number = Math.random,
): string => {
  const headers: string[] = [];
  headers.push('MIME-Version: 1.0');
  headers.push(`Date: ${formatRfc5322Date(meta.sentAt)}`);
  headers.push(`From: ${meta.from}`);
  headers.push(`Message-ID: ${meta.messageId}`);
  if (msg.reconciliation_id) {
    headers.push(`${MAIL_RECONCILIATION_ID_HEADER}: ${msg.reconciliation_id}`);
  }
  if (msg.to.length > 0) headers.push(`To: ${msg.to.join(', ')}`);
  if (msg.cc && msg.cc.length > 0) headers.push(`Cc: ${msg.cc.join(', ')}`);
  if (msg.bcc && msg.bcc.length > 0) headers.push(`Bcc: ${msg.bcc.join(', ')}`);
  headers.push(`Subject: ${msg.subject}`);
  if (msg.reply_to) headers.push(`Reply-To: ${msg.reply_to}`);
  if (msg.in_reply_to) headers.push(`In-Reply-To: ${msg.in_reply_to}`);
  if (msg.references && msg.references.length > 0) {
    headers.push(`References: ${msg.references.join(' ')}`);
  }
  if (msg.automatic === true) {
    for (const [name, value] of MAIL_AUTOMATIC_REPLY_HEADERS) headers.push(`${name}: ${value}`);
  }

  const part = renderImapBodyPart(msg, rand);
  const attachments = msg.attachments ?? [];
  if (attachments.length === 0) {
    headers.push(...part.contentTypeHeaders);
    return `${headers.join('\r\n')}\r\n\r\n${part.body}`;
  }

  // D-172 P2 — multipart/mixed: body part first, then each attachment.
  const mixed = newMimeBoundary(rand);
  headers.push(`Content-Type: multipart/mixed; boundary="${mixed}"`);
  const segments: string[] = [
    `--${mixed}`,
    ...part.contentTypeHeaders,
    '',
    part.body,
  ];
  for (const att of attachments) {
    segments.push(
      `--${mixed}`,
      `Content-Type: ${att.mime_type}; ${mimeFilenameParameter('name', att.filename)}`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; ${mimeFilenameParameter('filename', att.filename)}`,
      '',
      wrapBase64(att.bytes_b64),
    );
  }
  segments.push(`--${mixed}--`);
  return `${headers.join('\r\n')}\r\n\r\n${segments.join('\r\n')}`;
};

