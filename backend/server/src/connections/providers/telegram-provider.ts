/** D-148 P9 § A.13 — Telegram bot updates webhook provider (server-direct).
 *
 *  Telegram POSTs every bot update to `/webhooks/telegram/<connection_name>`
 *  on the user's server with the secret token in the
 *  `X-Telegram-Bot-Api-Secret-Token` header. Header-based verification
 *  is preferred over URL-secret because URL secrets leak through HTTP
 *  access logs, browser history, server-error stack traces, proxy logs,
 *  and accidental URL sharing; header secrets do not appear in any of
 *  those surfaces unless logging is misconfigured.
 *
 *  Verification path:
 *    1. Read `X-Telegram-Bot-Api-Secret-Token` header.
 *    2. Constant-time compare against the stored secret token.
 *    3. Hand the parsed update to the engine dispatcher.
 *
 *  The cloud relay shipped pre-D-148 is retired (D-146 absorbed).
 *
 *  Storage shape (consumes existing D-125 connection records):
 *    - kind: 'notification', subtype: 'telegram', name: <user-chosen>
 *    - auth: { type: 'bearer', token: <bot 12345:ABC-DEF…> }   (outbound)
 *    - config.webhook_secret: <secret_token passed to setWebhook>  (inbound)
 *
 *  `webhook_secret` is stripped from the resolver view by the
 *  `CONNECTION_INBOUND_SECRET_FIELDS` allowlist so recipes cannot read
 *  it. The webhook port reads it server-side at verification time only.
 *
 *  Outbound (Telegram sendMessage) keeps flowing through the
 *  pre-existing `connection.notification.telegram` adapter
 *  (`packages/ingredients/src/connection-notification.ts`) — no
 *  duplicate transport here.
 *
 *  Telegram supported webhook ports — Telegram Bot API only POSTs to
 *  ports 443 / 80 / 88 / 8443. The setWebhook helper enforces the
 *  closed list via `isTelegramSupportedPort` from `@recued/contracts`
 *  and surfaces `telegram_port_unsupported` for any other port. */

import type { IncomingMessage } from 'node:http';
import {
  TELEGRAM_SUPPORTED_PORTS,
  isTelegramSupportedPort,
  type ConnectionRow,
} from '@recued/contracts';
import type { WebhookVendorDescriptor } from '../../ports/webhook/handler.js';
import {
  TELEGRAM_SECRET_HEADER,
  isValidTelegramWebhookSecret,
  verifyTelegramWebhookSecret,
} from './telegram-webhook-protocol.js';

export { TELEGRAM_SECRET_HEADER } from './telegram-webhook-protocol.js';

export interface TelegramInboundUpdate {
  /** Connection record's name — picked off the URL path segment. */
  connection_name: string;
  /** Telegram update id when present (used for trace + log only;
   *  webhook port idempotency ledger keys on this when available). */
  update_id: string | null;
  /** Verified raw payload — passed through to the engine. */
  payload: unknown;
  /** Lower-cased headers, for trace. */
  headers: Record<string, string>;
}

export interface TelegramConnectionLookup {
  /** Connection row identity (audit + trace). */
  row: ConnectionRow;
  /** Telegram secret token — verified against the
   *  `X-Telegram-Bot-Api-Secret-Token` header on every inbound POST.
   *  Source-read from `config.webhook_secret` server-side. */
  secret_token: string;
}

export interface TelegramProviderDeps {
  /** Look up the connection's parsed config object. Returns null when
   *  no matching `kind: 'notification' subtype: 'telegram'` row
   *  exists. The boot site reads `config.webhook_secret` and exposes
   *  it as `secret_token`. */
  lookupTelegramConnection: (connection_name: string) => TelegramConnectionLookup | null;
  /** Engine dispatch — invoked AFTER header verification only. The
   *  boot site closes over the warehouse event bus + the
   *  `connection.event` warehouse path. Throws / rejects propagate as
   *  a 502 from the webhook port. */
  dispatchEvent: (update: TelegramInboundUpdate) => Promise<void>;
}

/** Build the WebhookVendorDescriptor for the Telegram provider.
 *
 *  Plugs into the D-148 P6 webhook port via:
 *    {
 *      vendors: { telegram: createTelegramVendorDescriptor(deps) }
 *    }
 *  alongside any existing per-vendor entries. */
export const createTelegramVendorDescriptor = (
  deps: TelegramProviderDeps,
): WebhookVendorDescriptor => {
  /** Codex P9 #6 fold — Telegram update_ids are always integers per
   *  Bot API docs (`update_id: integer`). Accepting any string would
   *  let a maliciously-shaped payload route a fresh delivery into
   *  the wrong dedup slot (or evade dedup by submitting a non-numeric
   *  string the legitimate delivery would never produce). Tighten to
   *  finite integers only; everything else falls through to body-hash
   *  fallback in the handler. */
  const extractUpdateId = (_req: IncomingMessage, body: Buffer): string | null => {
    try {
      const parsed = JSON.parse(body.toString('utf-8'));
      const id = (parsed as { update_id?: unknown })?.update_id;
      if (typeof id === 'number' && Number.isInteger(id)) return String(id);
    } catch {
      return null;
    }
    return null;
  };

  /** Verify Telegram's `X-Telegram-Bot-Api-Secret-Token` header against
   *  the stored secret in constant time. Empty / missing headers fail
   *  closed.
   *
   *  Telegram's secret token has a closed 1-256 character ASCII grammar.
   *  The shared verifier rejects values outside that grammar, hashes both
   *  admitted strings to fixed-length digests, and compares those digests in
   *  constant time. */
  const verifySignature = (req: IncomingMessage, _body: Buffer, secret: string): boolean => {
    const headerVal = req.headers[TELEGRAM_SECRET_HEADER];
    const presented = typeof headerVal === 'string' ? headerVal : null;
    return presented !== null
      && verifyTelegramWebhookSecret({ presented, expected: secret });
  };

  const resolveSecret = (connection_name: string): string | null => {
    const lookup = deps.lookupTelegramConnection(connection_name);
    if (lookup === null) return null;
    return isValidTelegramWebhookSecret(lookup.secret_token)
      ? lookup.secret_token
      : null;
  };

  const dispatch: WebhookVendorDescriptor['dispatch'] = async ({
    connection_name,
    body,
    headers,
  }) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf-8'));
    } catch {
      return { ok: false };
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false };
    }

    const envelope = parsed as Record<string, unknown>;
    const update_id = (() => {
      const direct = envelope.update_id;
      if (typeof direct === 'number' && Number.isFinite(direct)) return String(direct);
      if (typeof direct === 'string' && direct.length > 0) return direct;
      return null;
    })();

    try {
      await deps.dispatchEvent({
        connection_name,
        update_id,
        payload: parsed,
        headers,
      });
    } catch {
      return { ok: false };
    }

    return { ok: true };
  };

  return {
    path_prefix: '/webhooks/telegram/',
    extractEventId: extractUpdateId,
    verifySignature,
    resolveSecret,
    dispatch,
  };
};

// ────────────────────────────────────────────────────────────────
// setWebhook helper
// ────────────────────────────────────────────────────────────────

/** Result of an attempted `setWebhook` call. */
export type TelegramSetWebhookResult =
  | {
      ok: true;
      url: string;
      port: number;
    }
  | {
      ok: false;
      code: 'telegram_port_unsupported';
      port: number;
      supported_ports: ReadonlyArray<number>;
    }
  | {
      ok: false;
      code: 'telegram_api_error';
      status: number;
      message: string;
    }
  | {
      ok: false;
      code: 'network_error';
      message: string;
    };

export interface TelegramSetWebhookArgs {
  /** Bot token (`<bot_id>:<auth_secret>`). Used in the path of the
   *  Telegram Bot API URL. */
  bot_token: string;
  /** Public URL Telegram should POST to. The port in this URL is
   *  validated against `TELEGRAM_SUPPORTED_PORTS`. */
  webhook_url: string;
  /** Secret token passed to setWebhook; Telegram echoes it on every
   *  delivery in `X-Telegram-Bot-Api-Secret-Token`. 1-256 ASCII chars. */
  secret_token: string;
  /** Inject for testing; defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

/** Validate the URL's scheme + port against Telegram's documented
 *  closed list (443 / 80 / 88 / 8443) and call `setWebhook`.
 *
 *  Codex P9 #3 fold — Telegram requires HTTPS, so we hard-reject
 *  every non-`https:` scheme before the port check. Without this
 *  gate `http://example.com/...` would default to port 80 (which is
 *  in the supported list because Telegram does accept HTTPS-on-port-
 *  80 too) and pass; `file:`, `ws:`, etc. would default to 443 and
 *  also pass. The single scheme check fail-closes every non-HTTPS
 *  path before any cleartext bytes leave the box. */
export const setTelegramWebhook = async (
  args: TelegramSetWebhookArgs,
): Promise<TelegramSetWebhookResult> => {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(args.webhook_url);
  } catch {
    return {
      ok: false,
      code: 'telegram_port_unsupported',
      port: -1,
      supported_ports: TELEGRAM_SUPPORTED_PORTS,
    };
  }

  if (parsedUrl.protocol !== 'https:') {
    return {
      ok: false,
      code: 'telegram_port_unsupported',
      port: parsedUrl.port === '' ? -1 : Number.parseInt(parsedUrl.port, 10),
      supported_ports: TELEGRAM_SUPPORTED_PORTS,
    };
  }

  const port = parsedUrl.port === ''
    ? 443
    : Number.parseInt(parsedUrl.port, 10);

  if (!Number.isFinite(port) || !isTelegramSupportedPort(port)) {
    return {
      ok: false,
      code: 'telegram_port_unsupported',
      port,
      supported_ports: TELEGRAM_SUPPORTED_PORTS,
    };
  }

  const fetchImpl = args.fetchImpl ?? globalThis.fetch;
  const apiUrl = `https://api.telegram.org/bot${encodeURIComponent(args.bot_token)}/setWebhook`;

  let response: Response;
  try {
    response = await fetchImpl(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        url: args.webhook_url,
        secret_token: args.secret_token,
      }),
    });
  } catch (e) {
    return {
      ok: false,
      code: 'network_error',
      message: e instanceof Error ? e.message : 'unknown network error',
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      code: 'telegram_api_error',
      status: response.status,
      message: `Telegram setWebhook returned ${response.status} ${response.statusText}`,
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (e) {
    return {
      ok: false,
      code: 'telegram_api_error',
      status: response.status,
      message: `Telegram setWebhook returned malformed JSON: ${(e as Error).message}`,
    };
  }

  const okFlag = (body as { ok?: unknown })?.ok;
  if (okFlag !== true) {
    const description = typeof (body as { description?: unknown })?.description === 'string'
      ? String((body as { description: string }).description)
      : 'setWebhook returned ok: false';
    return {
      ok: false,
      code: 'telegram_api_error',
      status: response.status,
      message: description,
    };
  }

  return { ok: true, url: args.webhook_url, port };
};
