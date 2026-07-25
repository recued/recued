/** D-148 P9 § A.13 — Slack Events API webhook provider (server-direct).
 *
 *  Slack POSTs every event subscription delivery to
 *  `/webhooks/slack/<connection_name>` on the user's server. The
 *  cloud relay shipped pre-D-148 is retired (D-146 absorbed).
 *
 *  Verification path:
 *    1. Read `X-Slack-Request-Timestamp` + `X-Slack-Signature` headers.
 *    2. Reject deliveries whose timestamp is outside the ±5-minute
 *       replay window (Slack's documented recommendation).
 *    3. Recompute HMAC-SHA256 of `v0:<ts>:<rawBody>` keyed by the
 *       stored signing secret; constant-time compare against the
 *       header's `v0=…` digest.
 *    4. On a `url_verification` event, echo the `challenge` field as
 *       JSON via `response_override` so the Slack app config can
 *       confirm the URL.
 *    5. Otherwise hand the parsed event to the engine dispatcher.
 *
 *  Storage shape (consumes existing D-125 connection records):
 *    - kind: 'notification', subtype: 'slack', name: <user-chosen>
 *    - auth: { type: 'bearer', token: <bot xoxb-…> }   (outbound)
 *    - config.signing_secret: <Slack app signing secret>  (inbound)
 *
 *  `signing_secret` is stripped from the resolver view by adding it to
 *  `CONNECTION_INBOUND_SECRET_FIELDS` so recipes cannot read it via
 *  `{{connection.notification.<name>.signing_secret}}`. The webhook
 *  port reads it server-side at verification time only.
 *
 *  Outbound (Slack chat.postMessage) keeps flowing through the
 *  pre-existing `connection.notification.slack` adapter
 *  (`packages/ingredients/src/connection-notification.ts`) — no
 *  duplicate transport here. */

import type { IncomingMessage } from 'node:http';
import type { ConnectionRow } from '@recued/contracts';
import type { WebhookVendorDescriptor } from '../../ports/webhook/handler.js';
import {
  SLACK_REQUEST_TIMESTAMP_HEADER,
  SLACK_SIGNATURE_HEADER,
  isValidSlackSigningSecret,
  verifySlackWebhookSignature,
} from './slack-webhook-protocol.js';

export { SLACK_REPLAY_WINDOW_SECONDS } from './slack-webhook-protocol.js';

export interface SlackInboundEvent {
  /** Connection record's name — picked off the URL path segment. */
  connection_name: string;
  /** Slack event type. `'event_callback'` is the standard ingest
   *  shape; `'url_verification'` is handled inline (see provider) and
   *  never reaches the engine dispatcher. Tests treat any other
   *  type opaquely. */
  type: string;
  /** Slack-supplied event id when present. Used for trace + dedup
   *  (the webhook port's idempotency ledger keys on this when
   *  available; falls back to body hash otherwise). */
  event_id: string | null;
  /** Slack team id when present. */
  team_id: string | null;
  /** Verified raw payload — passed through to the engine. */
  payload: unknown;
  /** Lower-cased headers, for trace. */
  headers: Record<string, string>;
}

export interface SlackProviderDeps {
  /** Look up the connection's parsed config object. Returns null when
   *  no `kind: 'notification' subtype: 'slack' name: <connection_name>`
   *  row exists. The caller is expected to read `config.signing_secret`
   *  server-side and never project it into the resolver. */
  lookupSlackConnection: (connection_name: string) => SlackConnectionLookup | null;
  /** Engine dispatch — invoked AFTER signature verification + replay
   *  window check, only for non-`url_verification` events. The boot
   *  site closes over the warehouse event bus + the `connection.event`
   *  warehouse path. Throws / rejects propagate as a 502 from the
   *  webhook port (per the existing handler contract). */
  dispatchEvent: (event: SlackInboundEvent) => Promise<void>;
  /** Wall-clock source. Defaults to `Date.now`. Tests inject a
   *  deterministic stub so the ±5-minute window check is reproducible. */
  now?: () => number;
}

export interface SlackConnectionLookup {
  /** Connection row identity (audit + trace). */
  row: ConnectionRow;
  /** Slack signing secret — verified at every inbound POST. Source-
   *  read from `config.signing_secret` server-side. The provider
   *  receives it pre-resolved so the lookup site decides where to read
   *  the secret from (vault, sub_dek-decrypted blob, etc.) without
   *  coupling the provider to storage internals. */
  signing_secret: string;
}

/** Build the WebhookVendorDescriptor for the Slack provider.
 *
 *  The descriptor plugs into the D-148 P6 webhook port via:
 *    {
 *      vendors: { slack: createSlackVendorDescriptor(deps) }
 *    }
 *  alongside any existing per-vendor entries. */
export const createSlackVendorDescriptor = (
  deps: SlackProviderDeps,
): WebhookVendorDescriptor => {
  const now = deps.now ?? (() => Date.now());

  const extractEventId = (req: IncomingMessage, body: Buffer): string | null => {
    // Prefer the `X-Slack-Request-Timestamp:event_id` header pair if
    // present (some Slack delivery shapes include `X-Slack-Event-Id`),
    // otherwise pull `event_id` from the parsed envelope.
    const headerId = req.headers['x-slack-event-id'];
    if (typeof headerId === 'string' && headerId.length > 0) return headerId;
    try {
      const parsed = JSON.parse(body.toString('utf-8'));
      const id = (parsed as { event_id?: unknown })?.event_id;
      if (typeof id === 'string' && id.length > 0) return id;
    } catch {
      return null;
    }
    return null;
  };

  const verifySignature = (req: IncomingMessage, body: Buffer, secret: string): boolean => {
    const timestamp = req.headers[SLACK_REQUEST_TIMESTAMP_HEADER];
    const signature = req.headers[SLACK_SIGNATURE_HEADER];
    return typeof timestamp === 'string'
      && typeof signature === 'string'
      && verifySlackWebhookSignature({
        timestamp,
        signature,
        raw_body: body,
        signing_secret: secret,
        now_ms: now(),
      });
  };

  const resolveSecret = (connection_name: string): string | null => {
    const lookup = deps.lookupSlackConnection(connection_name);
    if (lookup === null) return null;
    return isValidSlackSigningSecret(lookup.signing_secret)
      ? lookup.signing_secret
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
      // Malformed JSON post-signature is a vendor bug or a
      // signature-replay attempt where the body got mangled. Bail
      // with a structured 502 via the handler's normal path — the
      // dispatch contract only carries `{ ok }`, not status code.
      return { ok: false };
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false };
    }

    const envelope = parsed as Record<string, unknown>;
    const type = typeof envelope.type === 'string' ? envelope.type : 'unknown';

    // Slack URL verification — echo the challenge so the app-config
    // page can confirm the URL. Per Slack docs, both the JSON form
    // (`{"challenge": "<token>"}`) and a raw `text/plain` body
    // containing the token are accepted; we use JSON for safer
    // header parsing on the Slack side.
    if (type === 'url_verification') {
      const challenge = typeof envelope.challenge === 'string' ? envelope.challenge : null;
      if (challenge === null) {
        return { ok: false };
      }
      return {
        ok: true,
        response_override: {
          status: 200,
          body: JSON.stringify({ challenge }),
          content_type: 'application/json',
        },
      };
    }

    const event_id = (() => {
      const direct = envelope.event_id;
      if (typeof direct === 'string' && direct.length > 0) return direct;
      return null;
    })();
    const team_id = (() => {
      const direct = envelope.team_id;
      if (typeof direct === 'string' && direct.length > 0) return direct;
      return null;
    })();

    try {
      await deps.dispatchEvent({
        connection_name,
        type,
        event_id,
        team_id,
        payload: parsed,
        headers,
      });
    } catch {
      return { ok: false };
    }

    return { ok: true };
  };

  /** Codex P9 #4 fold — Slack URL verification is a control-plane
   *  flow that may legitimately reissue the same challenge during
   *  workspace re-connect. Skipping dedup here avoids a
   *  `{deduped: true}` echo that would leave the URL stuck in the
   *  Slack app config. */
  const shouldSkipDedup = (_req: IncomingMessage, body: Buffer): boolean => {
    try {
      const parsed = JSON.parse(body.toString('utf-8'));
      return (parsed as { type?: unknown })?.type === 'url_verification';
    } catch {
      return false;
    }
  };

  return {
    path_prefix: '/webhooks/slack/',
    extractEventId,
    verifySignature,
    resolveSecret,
    dispatch,
    shouldSkipDedup,
  };
};
