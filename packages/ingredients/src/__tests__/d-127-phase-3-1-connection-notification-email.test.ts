/** D-127 Phase 3.1 — connection.notification email-subtype handler tests.
 *
 *  Pins the contract for the wired-path email subhandler (spec § 3.1):
 *  the placeholder `NOTIFICATION_TRANSPORT_NOT_IMPLEMENTED` from D-125
 *  P4.3 graduates to a real façade over `MailCollection.send` via the
 *  injected `mailRpc.send` callback.
 *
 *  Coverage:
 *    1. Subtype dispatch — email → mailRpc.send invoked with resolved
 *       sender_mail_instance + to/subject/body_text payload.
 *    2. Body resolution — `body` (mail-post primary) wins over `text`
 *       (notification-send fan-out fallback). Missing both → IOVF.
 *    3. Subject resolution — `subject` (mail-post primary) wins over
 *       `title` (notification-send fallback) wins over '(no subject)'
 *       default.
 *    4. Recipient resolution — `to[]` (mail-post) wins over `recipient`
 *       (notification override) wins over `config.default_recipient`.
 *       String-form `to` coerces to a singleton array.
 *    5. body_format='html' → both body_text and body_html populated
 *       (legacy MUA fallback per spec example).
 *    6. Missing sender_mail_instance in config → CONNECTION_NOT_BOUND
 *       with subtype: 'email' on details.
 *    7. Missing to/recipient/default_recipient → IOVF with field: 'to'.
 *    8. Missing mailRpc dep → NOTIFICATION_TRANSPORT_NOT_IMPLEMENTED.
 *    9. mail-rpc errors propagate (MAIL_SEND_SELF_LOOP_TO,
 *       MAIL_SEND_NOT_CAPABLE, MAIL_SEND_AUTH_FAILED) — surfaces at
 *       adapter layer for connection_notification audit row.
 *   10. Bytes telemetry — bytes_in=0, bytes_out=JSON-stringify args
 *       (in-process rpc, mirrors in-app pattern).
 *   11. Auth not decoded — email subtype's auth.type='none' record
 *       never goes through decodeAuth.
 *   12. thread_id forwarded when mail rpc returns it.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ConnectionRow } from '@recued/contracts';
import {
  createConnectionNotificationHandler,
} from '../connection-notification.js';
import type {
  ConnectionNotificationHandlerDeps,
  MailRpcDep,
  MailRpcSendInput,
  MailRpcSendResult,
} from '../connection-notification.js';
import { IngredientError, type ResolvedCall } from '../types.js';
import type { ConnectionHandlerCtx } from '../connection.js';

// ────────────────────────────────────────────────────────────────
// Test fixtures
// ────────────────────────────────────────────────────────────────

const mkRow = (overrides: Partial<ConnectionRow> = {}): ConnectionRow => ({
  pk: `${overrides.kind ?? 'notification'}:${overrides.name ?? 'team-email'}`,
  kind: overrides.kind ?? 'notification',
  name: overrides.name ?? 'team-email',
  display_name: overrides.display_name ?? 'Team Email',
  config_json: overrides.config_json ?? JSON.stringify({
    sender_mail_instance: 'work-gmail',
  }),
  auth_ciphertext: overrides.auth_ciphertext ?? '',
  enrolled_at: overrides.enrolled_at ?? 1_700_000_000_000,
  updated_at: overrides.updated_at ?? 1_700_000_000_000,
  subtype: overrides.subtype ?? 'email',
  ...(overrides.publisher_id !== undefined ? { publisher_id: overrides.publisher_id } : {}),
  ...(overrides.last_used_at !== undefined ? { last_used_at: overrides.last_used_at } : {}),
  ...(overrides.health_json !== undefined ? { health_json: overrides.health_json } : {}),
});

const mkCall = (overrides: Partial<ResolvedCall> = {}): ResolvedCall => ({
  slug: overrides.slug ?? 'mail-post',
  risk_tier: overrides.risk_tier ?? 'write',
  input: overrides.input ?? {},
  output: overrides.output ?? {},
  ...(overrides.fallback ? { fallback: overrides.fallback } : {}),
});

interface RpcCall {
  args: MailRpcSendInput;
}

const mkMailRpc = (
  responder: (args: MailRpcSendInput) => MailRpcSendResult | Promise<MailRpcSendResult>,
): { rpc: MailRpcDep; calls: RpcCall[] } => {
  const calls: RpcCall[] = [];
  return {
    rpc: {
      send: async (args) => {
        calls.push({ args });
        return responder(args);
      },
    },
    calls,
  };
};

const okMeta = (overrides: Partial<MailRpcSendResult> = {}): MailRpcSendResult => ({
  source_id: overrides.source_id ?? 'src-123',
  message_id: overrides.message_id ?? '<msgid@example.com>',
  sent_at: overrides.sent_at ?? 1_700_000_000_000,
  ...(overrides.thread_id !== undefined ? { thread_id: overrides.thread_id } : {}),
  ...(overrides.warnings !== undefined ? { warnings: overrides.warnings } : {}),
});

const mkCtx = (): { ctx: ConnectionHandlerCtx; bytesIn?: number; bytesOut?: number } => {
  const state: { ctx: ConnectionHandlerCtx; bytesIn?: number; bytesOut?: number } = {
    ctx: {
      setBytes(bytes_in, bytes_out) {
        state.bytesIn = bytes_in;
        state.bytesOut = bytes_out;
      },
    },
  };
  return state;
};

const mkDeps = (
  overrides: Partial<ConnectionNotificationHandlerDeps> = {},
): ConnectionNotificationHandlerDeps => ({
  decodeAuth: overrides.decodeAuth ?? vi.fn(),
  ...(overrides.emitInApp ? { emitInApp: overrides.emitInApp } : {}),
  ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
  ...(overrides.now ? { now: overrides.now } : {}),
  ...(overrides.mailRpc ? { mailRpc: overrides.mailRpc } : {}),
});

// ────────────────────────────────────────────────────────────────
// 1. Subtype dispatch — wired path
// ────────────────────────────────────────────────────────────────

describe('D-127 P3.1 — email subtype dispatch', () => {
  it('routes email subtype through mailRpc.send with resolved sender + payload', async () => {
    const { rpc, calls } = mkMailRpc(() => okMeta());
    const handler = createConnectionNotificationHandler(mkDeps({ mailRpc: rpc }));
    const row = mkRow({
      config_json: JSON.stringify({ sender_mail_instance: 'work-gmail' }),
    });
    const result = await handler(
      row,
      { to: ['alice@example.com'], subject: 'Hi', body: 'plain body' },
      mkCall(),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].args.instance).toBe('work-gmail');
    expect(calls[0].args.to).toEqual(['alice@example.com']);
    expect(calls[0].args.subject).toBe('Hi');
    expect(calls[0].args.body_text).toBe('plain body');
    expect(calls[0].args.body_html).toBeUndefined();
    expect((result as { status: string }).status).toBe('ok');
    expect((result as { result: { message_id: string } }).result.message_id)
      .toBe('<msgid@example.com>');
  });

  it('returns NotificationOk envelope with message_id + sent_at', async () => {
    const { rpc } = mkMailRpc(() => okMeta({
      message_id: '<thread-1@example.com>',
      sent_at: 1_700_000_500_000,
    }));
    const handler = createConnectionNotificationHandler(mkDeps({ mailRpc: rpc }));
    const result = await handler(
      mkRow(),
      { to: ['x@y.com'], body: 'b' },
      mkCall(),
    );
    expect(result).toMatchObject({
      status: 'ok',
      result: {
        message_id: '<thread-1@example.com>',
        sent_at: 1_700_000_500_000,
      },
      headers: undefined,
    });
  });

  it('forwards thread_id from mail rpc when present', async () => {
    const { rpc } = mkMailRpc(() => okMeta({ thread_id: 'gmail-thread-9' }));
    const handler = createConnectionNotificationHandler(mkDeps({ mailRpc: rpc }));
    const result = await handler(mkRow(), { to: ['x@y.com'], body: 'b' }, mkCall());
    expect((result as { result: { thread_id?: string } }).result.thread_id)
      .toBe('gmail-thread-9');
  });

  it('omits thread_id from result when mail rpc does not return one', async () => {
    const { rpc } = mkMailRpc(() => okMeta());
    const handler = createConnectionNotificationHandler(mkDeps({ mailRpc: rpc }));
    const result = await handler(mkRow(), { to: ['x@y.com'], body: 'b' }, mkCall());
    expect((result as { result: Record<string, unknown> }).result).not.toHaveProperty('thread_id');
  });
});

// ────────────────────────────────────────────────────────────────
// 2. Body resolution — `body` wins, `text` fallback, missing both → IOVF
// ────────────────────────────────────────────────────────────────

describe('D-127 P3.1 — body resolution', () => {
  it('body field (mail-post primary) wins over text (fan-out fallback)', async () => {
    const { rpc, calls } = mkMailRpc(() => okMeta());
    const handler = createConnectionNotificationHandler(mkDeps({ mailRpc: rpc }));
    await handler(
      mkRow(),
      { to: ['a@b.c'], body: 'mail-post body', text: 'fan-out text' },
      mkCall(),
    );
    expect(calls[0].args.body_text).toBe('mail-post body');
  });

  it('falls back to text when body is missing (notification-send fan-out)', async () => {
    const { rpc, calls } = mkMailRpc(() => okMeta());
    const handler = createConnectionNotificationHandler(mkDeps({ mailRpc: rpc }));
    await handler(
      mkRow(),
      { to: ['a@b.c'], text: 'alert message from notification-send' },
      mkCall(),
    );
    expect(calls[0].args.body_text).toBe('alert message from notification-send');
  });

  it('throws IOVF when neither body nor text is supplied', async () => {
    const { rpc } = mkMailRpc(() => okMeta());
    const handler = createConnectionNotificationHandler(mkDeps({ mailRpc: rpc }));
    let caught: unknown;
    try {
      await handler(mkRow(), { to: ['a@b.c'] }, mkCall());
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(IngredientError);
    expect((caught as IngredientError).code).toBe('INGREDIENT_OUTPUT_VALIDATION_FAILED');
    expect((caught as IngredientError).details?.subtype).toBe('email');
    expect((caught as IngredientError).details?.field).toBe('body');
  });

  it('does NOT trigger top-level text fail-fast when body is supplied', async () => {
    // Slack/telegram/in-app fail fast on missing text. Email skips that
    // gate so `mail-post` recipes (which have no `text` field) work.
    const { rpc, calls } = mkMailRpc(() => okMeta());
    const handler = createConnectionNotificationHandler(mkDeps({ mailRpc: rpc }));
    await handler(
      mkRow(),
      { to: ['a@b.c'], subject: 's', body: 'b' },
      mkCall(),
    );
    expect(calls).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────────
// 3. Subject resolution — subject > title > '(no subject)'
// ────────────────────────────────────────────────────────────────

describe('D-127 P3.1 — subject resolution', () => {
  it('subject (mail-post) wins over title (fan-out)', async () => {
    const { rpc, calls } = mkMailRpc(() => okMeta());
    const handler = createConnectionNotificationHandler(mkDeps({ mailRpc: rpc }));
    await handler(
      mkRow(),
      { to: ['a@b.c'], body: 'b', subject: 'Real subject', title: 'Fan-out title' },
      mkCall(),
    );
    expect(calls[0].args.subject).toBe('Real subject');
  });

  it('falls back to title when subject is missing', async () => {
    const { rpc, calls } = mkMailRpc(() => okMeta());
    const handler = createConnectionNotificationHandler(mkDeps({ mailRpc: rpc }));
    await handler(
      mkRow(),
      { to: ['a@b.c'], body: 'b', title: 'Alert: deal at risk' },
      mkCall(),
    );
    expect(calls[0].args.subject).toBe('Alert: deal at risk');
  });

  it("falls back to '(no subject)' when neither subject nor title is supplied", async () => {
    const { rpc, calls } = mkMailRpc(() => okMeta());
    const handler = createConnectionNotificationHandler(mkDeps({ mailRpc: rpc }));
    await handler(mkRow(), { to: ['a@b.c'], body: 'b' }, mkCall());
    expect(calls[0].args.subject).toBe('(no subject)');
  });
});

// ────────────────────────────────────────────────────────────────
// 4. Recipient resolution — to[] > recipient > config.default_recipient
// ────────────────────────────────────────────────────────────────

describe('D-127 P3.1 — recipient resolution', () => {
  it('explicit to[] (mail-post primary) wins over recipient and default_recipient', async () => {
    const { rpc, calls } = mkMailRpc(() => okMeta());
    const handler = createConnectionNotificationHandler(mkDeps({ mailRpc: rpc }));
    const row = mkRow({
      config_json: JSON.stringify({
        sender_mail_instance: 'work-gmail',
        default_recipient: 'archive@self',
      }),
    });
    await handler(
      row,
      { to: ['ceo@bigco.com'], recipient: 'override@x', body: 'b' },
      mkCall(),
    );
    expect(calls[0].args.to).toEqual(['ceo@bigco.com']);
  });

  it('string-form to coerces to a singleton array', async () => {
    const { rpc, calls } = mkMailRpc(() => okMeta());
    const handler = createConnectionNotificationHandler(mkDeps({ mailRpc: rpc }));
    await handler(
      mkRow(),
      { to: 'alice@example.com', body: 'b' },
      mkCall(),
    );
    expect(calls[0].args.to).toEqual(['alice@example.com']);
  });

  it('falls back to recipient (notification override) when to is missing', async () => {
    const { rpc, calls } = mkMailRpc(() => okMeta());
    const handler = createConnectionNotificationHandler(mkDeps({ mailRpc: rpc }));
    const row = mkRow({
      config_json: JSON.stringify({
        sender_mail_instance: 'work-gmail',
        default_recipient: 'archive@self',
      }),
    });
    await handler(row, { recipient: 'override@x', body: 'b' }, mkCall());
    expect(calls[0].args.to).toEqual(['override@x']);
  });

  it('falls back to config.default_recipient when neither to nor recipient is supplied', async () => {
    const { rpc, calls } = mkMailRpc(() => okMeta());
    const handler = createConnectionNotificationHandler(mkDeps({ mailRpc: rpc }));
    const row = mkRow({
      config_json: JSON.stringify({
        sender_mail_instance: 'work-gmail',
        default_recipient: 'archive@self.com',
      }),
    });
    await handler(row, { body: 'b' }, mkCall());
    expect(calls[0].args.to).toEqual(['archive@self.com']);
  });

  it('throws IOVF when no recipient source is available', async () => {
    const { rpc } = mkMailRpc(() => okMeta());
    const handler = createConnectionNotificationHandler(mkDeps({ mailRpc: rpc }));
    let caught: unknown;
    try {
      await handler(mkRow(), { body: 'b' }, mkCall());
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(IngredientError);
    expect((caught as IngredientError).code).toBe('INGREDIENT_OUTPUT_VALIDATION_FAILED');
    expect((caught as IngredientError).details?.field).toBe('to');
  });
});

// ────────────────────────────────────────────────────────────────
// 5. body_format='html' — both body_text and body_html populated
// ────────────────────────────────────────────────────────────────

describe('D-127 P3.1 — body_format=html', () => {
  it("populates body_html when body_format === 'html'", async () => {
    const { rpc, calls } = mkMailRpc(() => okMeta());
    const handler = createConnectionNotificationHandler(mkDeps({ mailRpc: rpc }));
    await handler(
      mkRow(),
      { to: ['a@b.c'], body: '<p>hello</p>', body_format: 'html' },
      mkCall(),
    );
    expect(calls[0].args.body_html).toBe('<p>hello</p>');
    // body_text mirrored per spec § A.4 example — legacy MUA fallback.
    expect(calls[0].args.body_text).toBe('<p>hello</p>');
  });

  it("leaves body_html unset when body_format defaults to text", async () => {
    const { rpc, calls } = mkMailRpc(() => okMeta());
    const handler = createConnectionNotificationHandler(mkDeps({ mailRpc: rpc }));
    await handler(
      mkRow(),
      { to: ['a@b.c'], body: 'plain' },
      mkCall(),
    );
    expect(calls[0].args.body_html).toBeUndefined();
    expect(calls[0].args.body_text).toBe('plain');
  });
});

// ────────────────────────────────────────────────────────────────
// 6. CONNECTION_NOT_BOUND on missing sender_mail_instance
// ────────────────────────────────────────────────────────────────

describe('D-127 P3.1 — sender_mail_instance binding', () => {
  it('throws CONNECTION_NOT_BOUND when sender_mail_instance is missing from config', async () => {
    const { rpc } = mkMailRpc(() => okMeta());
    const handler = createConnectionNotificationHandler(mkDeps({ mailRpc: rpc }));
    const row = mkRow({ config_json: '{}' });
    let caught: unknown;
    try {
      await handler(row, { to: ['a@b.c'], body: 'b' }, mkCall());
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(IngredientError);
    expect((caught as IngredientError).code).toBe('CONNECTION_NOT_BOUND');
    expect((caught as IngredientError).details?.subtype).toBe('email');
  });

  it('throws CONNECTION_NOT_BOUND when sender_mail_instance is empty string', async () => {
    const { rpc } = mkMailRpc(() => okMeta());
    const handler = createConnectionNotificationHandler(mkDeps({ mailRpc: rpc }));
    const row = mkRow({ config_json: JSON.stringify({ sender_mail_instance: '' }) });
    await expect(handler(row, { to: ['a@b.c'], body: 'b' }, mkCall()))
      .rejects.toMatchObject({ code: 'CONNECTION_NOT_BOUND' });
  });
});

// ────────────────────────────────────────────────────────────────
// 7. Missing mailRpc → NOTIFICATION_TRANSPORT_NOT_IMPLEMENTED
// ────────────────────────────────────────────────────────────────

describe('D-127 P3.1 — no-mailRpc fallback', () => {
  it('throws NOTIFICATION_TRANSPORT_NOT_IMPLEMENTED when mailRpc is unwired', async () => {
    const handler = createConnectionNotificationHandler(mkDeps({}));
    let caught: unknown;
    try {
      await handler(mkRow(), { to: ['a@b.c'], body: 'b' }, mkCall());
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(IngredientError);
    expect((caught as IngredientError).code).toBe('NOTIFICATION_TRANSPORT_NOT_IMPLEMENTED');
    expect((caught as IngredientError).details?.subtype).toBe('email');
  });
});

// ────────────────────────────────────────────────────────────────
// 8. mail-rpc errors propagate (sender ≠ to / capability gate / network)
// ────────────────────────────────────────────────────────────────

describe('D-127 P3.1 — mail-rpc error propagation', () => {
  it('propagates MAIL_SEND_SELF_LOOP_TO from underlying rpc', async () => {
    const rpc: MailRpcDep = {
      send: async () => {
        throw new IngredientError(
          'MAIL_SEND_SELF_LOOP_TO',
          "This recipe is configured to send mail to itself",
          { offending: 'me@x' },
        );
      },
    };
    const handler = createConnectionNotificationHandler(mkDeps({ mailRpc: rpc }));
    let caught: unknown;
    try {
      await handler(mkRow(), { to: ['me@x'], body: 'b' }, mkCall());
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(IngredientError);
    expect((caught as IngredientError).code).toBe('MAIL_SEND_SELF_LOOP_TO');
  });

  it('propagates MAIL_SEND_NOT_CAPABLE when underlying mail instance lacks send capability', async () => {
    const rpc: MailRpcDep = {
      send: async () => {
        throw new IngredientError(
          'MAIL_SEND_NOT_CAPABLE',
          "Mail account is read-only",
        );
      },
    };
    const handler = createConnectionNotificationHandler(mkDeps({ mailRpc: rpc }));
    await expect(handler(mkRow(), { to: ['a@b.c'], body: 'b' }, mkCall()))
      .rejects.toMatchObject({ code: 'MAIL_SEND_NOT_CAPABLE' });
  });

  it('propagates MAIL_SEND_AUTH_FAILED for transport-level auth errors', async () => {
    const rpc: MailRpcDep = {
      send: async () => {
        throw new IngredientError('MAIL_SEND_AUTH_FAILED', 'gmail returned 401');
      },
    };
    const handler = createConnectionNotificationHandler(mkDeps({ mailRpc: rpc }));
    await expect(handler(mkRow(), { to: ['a@b.c'], body: 'b' }, mkCall()))
      .rejects.toMatchObject({ code: 'MAIL_SEND_AUTH_FAILED' });
  });
});

// ────────────────────────────────────────────────────────────────
// 9. Bytes telemetry — bytes_in=0, bytes_out=JSON-stringify args
// ────────────────────────────────────────────────────────────────

describe('D-127 P3.1 — bytes telemetry', () => {
  it('sets bytes_in=0 and bytes_out to JSON-stringify of mail rpc args', async () => {
    const { rpc } = mkMailRpc(() => okMeta());
    const handler = createConnectionNotificationHandler(mkDeps({ mailRpc: rpc }));
    const ctxState = mkCtx();
    await handler(
      mkRow(),
      { to: ['a@b.c'], subject: 's', body: 'plain body' },
      mkCall(),
      ctxState.ctx,
    );
    expect(ctxState.bytesIn).toBe(0);
    const expectedArgs: MailRpcSendInput = {
      instance: 'work-gmail',
      to: ['a@b.c'],
      subject: 's',
      body_text: 'plain body',
    };
    const expectedOut = new TextEncoder().encode(JSON.stringify(expectedArgs)).byteLength;
    expect(ctxState.bytesOut).toBe(expectedOut);
  });

  it('does not invoke ctx when mailRpc throws (rpc layer captures)', async () => {
    const rpc: MailRpcDep = {
      send: async () => { throw new IngredientError('MAIL_SEND_NETWORK_FAILED', 'boom'); },
    };
    const handler = createConnectionNotificationHandler(mkDeps({ mailRpc: rpc }));
    const ctxState = mkCtx();
    await expect(handler(
      mkRow(),
      { to: ['a@b.c'], body: 'b' },
      mkCall(),
      ctxState.ctx,
    )).rejects.toThrow();
    expect(ctxState.bytesIn).toBeUndefined();
    expect(ctxState.bytesOut).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// 10. decodeAuth not called for email subtype (auth.type='none')
// ────────────────────────────────────────────────────────────────

describe('D-127 P3.1 — auth handling', () => {
  it('does NOT decode auth for email subtype (creds live on the mail instance)', async () => {
    const { rpc } = mkMailRpc(() => okMeta());
    const decodeAuth = vi.fn();
    const handler = createConnectionNotificationHandler({
      decodeAuth,
      mailRpc: rpc,
    });
    await handler(mkRow(), { to: ['a@b.c'], body: 'b' }, mkCall());
    expect(decodeAuth).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────
// D-207 slice 3d — the no-resend fence is reachable from mail-post
// ────────────────────────────────────────────────────────────────

describe('D-207 3d — fence opt-in through the email façade', () => {
  it('forwards reconciliation_id so a mail-post recipe can arm the fence', async () => {
    // The fence lives in MailCollection.send, which this façade calls. It is
    // opt-in PER CALL by design; the defect was that this surface built its
    // send args without the field, so no mail-post recipe could opt in at all.
    const { rpc, calls } = mkMailRpc(() => okMeta());
    const handler = createConnectionNotificationHandler(mkDeps({ mailRpc: rpc }));
    await handler(
      mkRow(),
      { to: ['a@b.com'], body: 'b', reconciliation_id: 'recon-abc-123' },
      mkCall(),
    );
    expect(calls[0].args.reconciliation_id).toBe('recon-abc-123');
  });

  it('keeps ordinary retry semantics when no id is supplied', async () => {
    const { rpc, calls } = mkMailRpc(() => okMeta());
    const handler = createConnectionNotificationHandler(mkDeps({ mailRpc: rpc }));
    await handler(mkRow(), { to: ['a@b.com'], body: 'b' }, mkCall());
    expect(calls[0].args.reconciliation_id).toBeUndefined();
    expect('reconciliation_id' in calls[0].args).toBe(false);
  });

  it('treats a non-string or empty id as absent rather than passing junk on', async () => {
    // The id's SHAPE is the claim store's invariant, enforced there. This layer
    // only refuses to forward something that is plainly not an id.
    for (const bad of [42, '', null, {}, ['x']]) {
      const { rpc, calls } = mkMailRpc(() => okMeta());
      const handler = createConnectionNotificationHandler(mkDeps({ mailRpc: rpc }));
      await handler(
        mkRow(),
        { to: ['a@b.com'], body: 'b', reconciliation_id: bad },
        mkCall(),
      );
      expect(calls[0].args.reconciliation_id).toBeUndefined();
    }
  });

  it('surfaces already_sent so a recipe can tell a fence answer from a send', async () => {
    // Without this the recipe sees an ordinary success and cannot distinguish
    // "sent now" from "already sent an hour ago" — the exact ambiguity the
    // claim exists to remove.
    const { rpc } = mkMailRpc(() => ({
      ...okMeta({ message_id: '<original@example.com>' }),
      already_sent: true,
    }));
    const handler = createConnectionNotificationHandler(mkDeps({ mailRpc: rpc }));
    const result = await handler(
      mkRow(),
      { to: ['a@b.com'], body: 'b', reconciliation_id: 'recon-1' },
      mkCall(),
    );
    expect(result).toMatchObject({
      status: 'ok',
      result: { message_id: '<original@example.com>', already_sent: true },
    });
  });

  it('omits already_sent entirely on an ordinary send', async () => {
    // Absence keeps meaning "this handler sent it"; an explicit `false` would
    // read as a claim about a fence that was never armed.
    const { rpc } = mkMailRpc(() => okMeta());
    const handler = createConnectionNotificationHandler(mkDeps({ mailRpc: rpc }));
    const result = await handler(mkRow(), { to: ['a@b.com'], body: 'b' }, mkCall());
    expect('already_sent' in (result as { result: object }).result).toBe(false);
  });
});
