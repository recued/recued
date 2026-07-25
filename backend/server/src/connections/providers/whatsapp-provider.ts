/** D-192 CORE #6 make-live — the WhatsApp (Meta Cloud API) webhook descriptor.
 *
 *  Plugs into the D-148 P9 vendor webhook port via
 *  `MESSENGER_WEBHOOK_DESCRIPTOR_LEAVES` (`wire-vendor-webhook-port.ts`), which
 *  iterates the messenger registry — so this file is the ONLY per-vendor inbound
 *  code WhatsApp needs. The secret read, the dispatcher wiring, and the default
 *  log-and-drop stub are all shared and registry-driven.
 *
 *  Two things here are genuinely WhatsApp's own:
 *
 *  **The GET handshake.** Meta refuses to deliver a single POST until the endpoint
 *  echoes `hub.challenge` on a GET. Slack's `url_verification` is a POST and rides
 *  `dispatch`'s `response_override`; Meta's is a different HTTP method entirely,
 *  which is why the port grew an optional `verifyChallenge` hook. A vendor that
 *  declares none keeps the port's old POST-only behavior exactly.
 *
 *  **The nested id.** The registry's `ingress.id_field` is a flat KEY NAME, read
 *  off the provider event — and WhatsApp's message id is buried at
 *  `entry[].changes[].value.messages[].id`. So the walk happens HERE and the id is
 *  re-surfaced under the declared flat key (`message_id`). That is the seam
 *  working as designed: the nesting is leaf knowledge, not registry vocabulary.
 */

import type { IncomingMessage } from 'node:http';
import type { Buffer } from 'node:buffer';

import { whatsAppMessageId } from '@recued/transport';
import type { ConnectionRow } from '@recued/contracts';

import type { WebhookVendorDescriptor } from '../../ports/index.js';
import {
  answerWhatsAppChallenge,
  isValidWhatsAppAppSecret,
  verifyWhatsAppSignature,
  WHATSAPP_SIGNATURE_HEADER,
} from './whatsapp-webhook-protocol.js';

/** What the shared leaf hands back for a `connection.notification.whatsapp` row.
 *  The ROW rides along because the GET handshake needs a SECOND config value (the
 *  verify token) that the generic `ingress.secret_field` reader does not fetch —
 *  it reads exactly one declared secret field, which is the right shape for every
 *  other vendor. */
export interface WhatsAppConnectionLookup {
  row: ConnectionRow;
  app_secret: string;
}

/** The inbound event handed to the shared messenger dispatcher. `message_id` is
 *  the DECLARED `ingress.id_field` — a flat key, per the seam's contract. */
export interface WhatsAppInboundEvent {
  connection_name: string;
  message_id: string | null;
  payload: unknown;
  headers: Record<string, string>;
}

export interface WhatsAppProviderDeps {
  lookupWhatsAppConnection: (connection_name: string) => WhatsAppConnectionLookup | null;
  dispatchEvent: (event: WhatsAppInboundEvent) => Promise<void>;
}

/** Read `config.verify_token` off the row. Kept here rather than threaded through
 *  the shared lookup: it is a WhatsApp-only fact, and inventing a second generic
 *  "other inbound secret" slot for one vendor would be exactly the kind of
 *  speculative vocabulary this arc exists to avoid. */
const readVerifyToken = (row: ConnectionRow): string | null => {
  let config: unknown;
  try {
    config = JSON.parse(row.config_json);
  } catch {
    return null;
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return null;
  const token = (config as Record<string, unknown>).verify_token;
  return typeof token === 'string' && token.length > 0 ? token : null;
};

export const createWhatsAppVendorDescriptor = (
  deps: WhatsAppProviderDeps,
): WebhookVendorDescriptor => {
  const resolveSecret = (connection_name: string): string | null => {
    const lookup = deps.lookupWhatsAppConnection(connection_name);
    if (lookup === null) return null;
    return isValidWhatsAppAppSecret(lookup.app_secret) ? lookup.app_secret : null;
  };

  const verifySignature = (req: IncomingMessage, body: Buffer, secret: string): boolean => {
    const header = req.headers[WHATSAPP_SIGNATURE_HEADER];
    return verifyWhatsAppSignature({
      raw_body: body,
      signature_header: typeof header === 'string' ? header : undefined,
      app_secret: secret,
    });
  };

  /** ⚠ Deliberately `null` — the port falls back to a sha256 of the RAW BODY as
   *  the dedup key, and for Meta that is not a fallback but the CORRECT key.
   *
   *  A single delivery can batch several `entry[] × changes[] × messages[]`, so
   *  there is no one message id that identifies it. Keying on the first message's
   *  id would be actively wrong: if Meta ever re-batched (say `[A,B]` then
   *  `[A,C]`), the second delivery would be swallowed as a duplicate and message C
   *  would be lost silently. The body hash cannot make that mistake — and it is
   *  exact for the case that actually matters, because a Meta retry is a
   *  byte-identical redelivery. It is also this vendor's only replay defence:
   *  Meta signs the body alone, with no timestamp to bound a window with. */
  const extractEventId = (): string | null => null;

  /** Meta's subscription handshake. Returns null on any failure, which the port
   *  renders as the same generic 404 an unwired path returns — so a GET cannot be
   *  used to discover that a WhatsApp connection exists here. */
  const verifyChallenge = (
    req: IncomingMessage,
    connection_name: string,
  ): { status: number; body: string; content_type: string } | null => {
    const lookup = deps.lookupWhatsAppConnection(connection_name);
    if (lookup === null) return null;
    const verify_token = readVerifyToken(lookup.row);
    if (verify_token === null) return null;
    // `req.url` is the raw path + query; the origin is irrelevant to the parse.
    let query: URLSearchParams;
    try {
      query = new URL(req.url ?? '', 'https://placeholder.invalid').searchParams;
    } catch {
      return null;
    }
    return answerWhatsAppChallenge({ query, verify_token });
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
    try {
      await deps.dispatchEvent({
        connection_name,
        // The nested walk — re-surfaced under the declared flat `id_field`.
        message_id: whatsAppMessageId(parsed),
        payload: parsed,
        headers,
      });
    } catch {
      return { ok: false };
    }
    return { ok: true };
  };

  return {
    path_prefix: '/webhooks/whatsapp/',
    extractEventId,
    verifySignature,
    resolveSecret,
    verifyChallenge,
    dispatch,
  };
};
