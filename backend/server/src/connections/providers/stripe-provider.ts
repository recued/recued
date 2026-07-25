/** D-196 S4 — Stripe webhook transport verifier.
 *
 *  Stripe signs each delivery with a `Stripe-Signature` header whose
 *  `v1` digest covers `<timestamp>.<raw request bytes>`. This provider is
 *  deliberately separate from the D-128 generic body-only HMAC funnel:
 *  accepting a Stripe event through that verifier would discard the signed
 *  timestamp and its replay bound.
 *
 *  This descriptor authenticates transport only. The injected dispatcher is
 *  responsible for the D-196 I-3 act-site read-back and lifecycle convergence;
 *  no customer, entitlement, period, or status field is trusted from the
 *  webhook payload itself. */

import type { IncomingMessage } from 'node:http';
import type { ConnectionRow } from '@recued/contracts';
import type { WebhookVendorDescriptor } from '../../ports/webhook/handler.js';
import { WEBHOOK_JSON_OBJECT_DECODER_V1 } from '../../webhook-json-object-decoder.js';
import {
  STRIPE_SIGNATURE_HEADER,
  STRIPE_WEBHOOK_TOLERANCE_SECONDS,
  decodeStripeWebhookEvent,
  isValidStripeEndpointSecret,
  verifyStripeWebhookSignature,
} from './stripe-webhook-protocol.js';

export {
  STRIPE_SIGNATURE_HEADER,
  STRIPE_WEBHOOK_TOLERANCE_SECONDS,
} from './stripe-webhook-protocol.js';

export interface StripeInboundEvent {
  /** Connection record selected by the final URL segment. */
  connection_name: string;
  /** Stripe's durable event identity, retained for trace and downstream
   *  idempotent convergence. */
  event_id: string;
  /** Stripe event type, for example `invoice.paid`. */
  type: string;
  /** Provider event creation time (Unix seconds). */
  created: number;
  /** Whether the event belongs to live mode. */
  livemode: boolean;
  /** Verified but otherwise untrusted Stripe envelope. Consumers must perform
   *  the D-196 I-3 provider read-back before changing customer access. */
  payload: unknown;
  /** Lower-cased request headers for trace. */
  headers: Record<string, string>;
}

export interface StripeConnectionLookup {
  /** Connection row identity for audit and trace. */
  row: ConnectionRow;
  /** Per-endpoint `whsec_...` signing secret, read server-side only. */
  webhook_secret: string;
}

export interface StripeProviderDeps {
  /** Resolve one `kind: 'api'`, vendor `stripe` connection and its stored
   *  endpoint signing secret. */
  lookupStripeConnection: (connection_name: string) => StripeConnectionLookup | null;
  /** Invoked only after signature, freshness, and event-shape checks succeed. */
  dispatchEvent: (event: StripeInboundEvent) => Promise<void>;
  /** Wall clock in milliseconds. Tests inject a deterministic source. */
  now?: () => number;
}

/** Build the Stripe entry for the shared `/webhooks/<vendor>/<connection>`
 *  port. Register it only when a real D-196 lifecycle dispatcher is present;
 *  accepting verified events into a log-and-drop stub would falsely advertise
 *  convergence while losing the webhook accelerator. */
export const createStripeVendorDescriptor = (
  deps: StripeProviderDeps,
): WebhookVendorDescriptor => {
  const now = deps.now ?? (() => Date.now());

  const resolveSecret = (connection_name: string): string | null => {
    const lookup = deps.lookupStripeConnection(connection_name);
    if (lookup === null) return null;
    return isValidStripeEndpointSecret(lookup.webhook_secret)
      ? lookup.webhook_secret
      : null;
  };

  const verifySignature = (
    req: IncomingMessage,
    body: Buffer,
    secret: string,
  ): boolean => {
    const header = req.headers[STRIPE_SIGNATURE_HEADER];
    if (typeof header !== 'string') return false;
    return verifyStripeWebhookSignature({
      header,
      raw_body: body,
      endpoint_secret: secret,
      now_ms: now(),
    });
  };

  const extractEventId = (_req: IncomingMessage, body: Buffer): string | null => {
    return decodeStripeWebhookEvent(
      body,
      WEBHOOK_JSON_OBJECT_DECODER_V1,
    )?.event_id ?? null;
  };

  const dispatch: WebhookVendorDescriptor['dispatch'] = async ({
    connection_name,
    body,
    headers,
  }) => {
    const event = decodeStripeWebhookEvent(
      body,
      WEBHOOK_JSON_OBJECT_DECODER_V1,
    );
    if (event === null) return { ok: false };

    try {
      await deps.dispatchEvent({
        connection_name,
        event_id: event.event_id,
        type: event.type,
        created: event.created,
        livemode: event.livemode,
        payload: event.payload,
        headers,
      });
    } catch {
      return { ok: false };
    }

    return { ok: true };
  };

  return {
    path_prefix: '/webhooks/stripe/',
    extractEventId,
    // D-196 §6 intentionally carries no general event ledger: retries and
    // replays converge through idempotent lifecycle operations, while the
    // timestamped signature limits captured-delivery replay. The shared port's
    // ledger records *before* dispatch and cannot roll a key back; using it here
    // would turn a transient 502 into a false dedup success on Stripe's retry.
    shouldSkipDedup: () => true,
    verifySignature,
    resolveSecret,
    dispatch,
  };
};
