/** D-192 — the Discord Interactions webhook descriptor.
 *
 *  Plugs into the D-148 P9 vendor webhook port via
 *  `MESSENGER_WEBHOOK_DESCRIPTOR_LEAVES`, which iterates the messenger registry — so
 *  this is the only per-vendor inbound code Discord needs. The secret read, the
 *  dispatcher wiring, and the 401-on-bad-signature are all shared.
 *
 *  ⚠ **THE 3-SECOND RULE, and why this leaf does NOT await the downstream.**
 *
 *  Discord gives an interaction **3 seconds** to be acknowledged. Miss it and the
 *  user sees a red "This interaction failed" — *even though the press was recorded* —
 *  which is about the most confusing thing an approval channel can do.
 *
 *  The other vendors' descriptors `await` the messenger dispatcher and let its result
 *  become the HTTP status, because a 502 makes Slack / Telegram / Meta **retry the
 *  delivery**. Discord does not retry an interaction — it is a live request, not a
 *  delivery — so awaiting buys nothing here and costs everything: `submitAnswer`
 *  fans `closeAsk` out across every enrolled channel, each an HTTP call with a
 *  15-second timeout, so ONE slow vendor would blow the 3-second budget on a press
 *  that worked perfectly.
 *
 *  So the ack is returned immediately and the dispatch runs on. This is not a
 *  shortcut around the contract — `DEFERRED_UPDATE_MESSAGE` is Discord's own
 *  documented pattern for exactly this ("acknowledge now, edit the message later"),
 *  and the later edit is precisely what `closeAsk` → `closePrompt` does. A press that
 *  loses its race is safe by the block's first-answer-wins dedup. The one thing we
 *  give up is the 502, which was never going to be read.
 */

import type { IncomingMessage } from 'node:http';
import { Buffer } from 'node:buffer';

import { discordInteractionId } from '@recued/transport';
import type { ConnectionRow } from '@recued/contracts';

import type { WebhookVendorDescriptor } from '../../ports/index.js';
import {
  DISCORD_DEFERRED_ACK_BODY,
  DISCORD_PONG_BODY,
  DISCORD_SIGNATURE_HEADER,
  DISCORD_TIMESTAMP_HEADER,
  isValidDiscordPublicKey,
  verifyDiscordSignature,
} from './discord-webhook-protocol.js';

/** Discord interaction types. Only these two can reach us: we register no slash
 *  commands and send no modals, so `APPLICATION_COMMAND` (2) and `MODAL_SUBMIT` (5)
 *  have no way to arrive. */
const INTERACTION_PING = 1;
const INTERACTION_MESSAGE_COMPONENT = 3;

const JSON_RESPONSE = { status: 200, content_type: 'application/json' } as const;

export interface DiscordConnectionLookup {
  row: ConnectionRow;
  /** The application's Ed25519 verification key. PUBLIC — see the protocol file. */
  public_key: string;
}

/** The inbound event handed to the shared messenger dispatcher. `interaction_id` is
 *  the DECLARED `ingress.id_field` — a flat key, per the seam's contract. */
export interface DiscordInboundEvent {
  connection_name: string;
  interaction_id: string | null;
  payload: unknown;
  headers: Record<string, string>;
}

export interface DiscordProviderDeps {
  lookupDiscordConnection: (connection_name: string) => DiscordConnectionLookup | null;
  dispatchEvent: (event: DiscordInboundEvent) => Promise<void>;
  /** Optional logger. Load-bearing here, unlike the other providers: because the
   *  dispatch is not awaited (see the file header), a downstream failure has NO
   *  other way to surface. Without this it would be a genuinely silent drop. */
  log?: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void;
}

export const createDiscordVendorDescriptor = (
  deps: DiscordProviderDeps,
): WebhookVendorDescriptor => {
  const resolveSecret = (connection_name: string): string | null => {
    const lookup = deps.lookupDiscordConnection(connection_name);
    if (lookup === null) return null;
    return isValidDiscordPublicKey(lookup.public_key) ? lookup.public_key : null;
  };

  const verifySignature = (req: IncomingMessage, body: Buffer, secret: string): boolean => {
    const signature = req.headers[DISCORD_SIGNATURE_HEADER];
    const timestamp = req.headers[DISCORD_TIMESTAMP_HEADER];
    return verifyDiscordSignature({
      raw_body: body,
      signature_header: typeof signature === 'string' ? signature : undefined,
      timestamp_header: typeof timestamp === 'string' ? timestamp : undefined,
      public_key: secret,
    });
  };

  /** Every interaction carries a unique snowflake `id` — the exact dedup key, and
   *  the whole replay defence (the Ed25519 signature covers a timestamp but Discord
   *  specifies no tolerance, so there is no window to bound). */
  const extractEventId = (_req: IncomingMessage, body: Buffer): string | null => {
    try {
      return discordInteractionId(JSON.parse(body.toString('utf-8')));
    } catch {
      return null;
    }
  };

  /** The PING is Discord's endpoint validation and it REPEATS — every time the
   *  Interactions URL is saved, and periodically after. If a re-PING hit the
   *  idempotency ledger it would be answered `{ok:true, deduped:true}` instead of a
   *  PONG, and Discord would mark the endpoint invalid. Exactly the trap Slack's
   *  `url_verification` opt-out exists for. */
  const shouldSkipDedup = (_req: IncomingMessage, body: Buffer): boolean => {
    try {
      const parsed = JSON.parse(body.toString('utf-8')) as { type?: unknown };
      return parsed?.type === INTERACTION_PING;
    } catch {
      return false;
    }
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
    const type = (parsed as Record<string, unknown>).type;

    // PING → PONG. Reached only AFTER the signature verified, which is the point:
    // Discord replays this same PING with a deliberately BAD signature to check that
    // we answer 401, and the port does that for us before we ever get here.
    if (type === INTERACTION_PING) {
      return { ok: true, response_override: { ...JSON_RESPONSE, body: DISCORD_PONG_BODY } };
    }

    if (type === INTERACTION_MESSAGE_COMPONENT) {
      // ⚠ NOT awaited — see the file header. Ack inside Discord's 3-second budget;
      // let the answer land on its own time. The catch is the ONLY place a
      // downstream failure can surface, so it must never be dropped.
      void deps
        .dispatchEvent({
          connection_name,
          interaction_id: discordInteractionId(parsed),
          payload: parsed,
          headers,
        })
        .catch((err: unknown) => {
          deps.log?.('warn', 'discord interaction dispatch failed after ack', {
            connection_name,
            interaction_id: discordInteractionId(parsed) ?? undefined,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      return {
        ok: true,
        response_override: { ...JSON_RESPONSE, body: DISCORD_DEFERRED_ACK_BODY },
      };
    }

    // Anything else (a slash command, a modal submit) cannot reach us — we register
    // no commands and send no modals. If one somehow does, the port's default
    // `{ok:true}` envelope is not a valid interaction response and Discord shows the
    // user "interaction failed". That is honest: we genuinely do not handle it, and
    // inventing an ack for an interaction we then ignore would be worse.
    deps.log?.('info', 'discord interaction ignored (unhandled type)', {
      connection_name,
      type: typeof type === 'number' ? type : undefined,
    });
    return { ok: true };
  };

  return {
    path_prefix: '/webhooks/discord/',
    extractEventId,
    verifySignature,
    resolveSecret,
    shouldSkipDedup,
    dispatch,
  };
};
