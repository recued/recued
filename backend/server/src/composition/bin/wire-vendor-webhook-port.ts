/** D-148 P9 § A.13 — vendor webhook port composer.
 *
 *  Wires the `createWebhookPortHandler` substrate from `81554dc8` into
 *  a live HTTP handler with Slack + Telegram vendor descriptors and an
 *  optional Stripe descriptor. Until this composer existed, the port handler
 *  + per-vendor descriptors + idempotency ledger were exported as standalone
 *  modules with passing tests but nothing in the boot path instantiated
 *  the trio, so verified bot callbacks had nowhere to land — Slack
 *  signing-secret verification + Telegram `X-Telegram-Bot-Api-Secret-
 *  Token` constant-time compare existed in code but were never reached
 *  on a live request.
 *
 *  This composer threads the following state from the surrounding server:
 *    - `webhookPort` — the same `bootstrap.webhook_port > 0` gate the
 *      Phase D `/webhook/{slug}` listener consults. Port <= 0 ⇒ this
 *      composer returns `undefined` and the server.ts path branch
 *      never engages for `/webhooks/*` traffic (vendor-agnostic 404
 *      from the floor, matching the spec's
 *      "don't fingerprint which vendors are wired" posture).
 *    - `connectionStore` — backs the registered vendors' `resolveSecret`
 *      paths via plaintext-`config_json` reads (`signing_secret` for Slack
 *      per D-148 § A.13 / `webhook_secret` for Telegram and Stripe). The
 *      `CONNECTION_INBOUND_SECRET_FIELDS` allowlist already strips
 *      these fields from the resolver view so recipes never see them;
 *      this composer reads them directly from the row at verification
 *      time. Absent store ⇒ undefined (no connections to look up
 *      against → port stays unwired).
 *    - `messengerDispatchers` — the vendor → engine dispatch seam (D-192 seam 11;
 *      was a named `dispatchSlackEvent` / `dispatchTelegramEvent` pair). Each
 *      defaults to log-and-drop so the substrate slice lands LIVE without
 *      committing to a downstream warehouse integration; the inbound-answer
 *      dispatcher replaces them with an interceptor that routes
 *      `callback_query` / `block_actions` payloads through `block.submitAnswer`
 *      before falling through to the default. Spec § A.4 / D-158 § A.4.
 *    - `dispatchStripeEvent` — D-196 lifecycle convergence seam. Unlike the
 *      messenger vendors, Stripe has no log-and-drop default: its descriptor
 *      is registered only when a real post-verification dispatcher is wired.
 *
 *  Spec: docs/d-148-spec.md § A.13 (vendor webhook port); substrate
 *  commit: 81554dc8 (`feat(d-148.p9): Slack/Telegram inbound (server-
 *  direct) — substrate`). */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createDiscordVendorDescriptor,
  createSlackVendorDescriptor,
  createStripeVendorDescriptor,
  createTelegramVendorDescriptor,
  createWhatsAppVendorDescriptor,
  type SlackConnectionLookup,
  type SlackInboundEvent,
  type StripeConnectionLookup,
  type StripeInboundEvent,
  type TelegramConnectionLookup,
  type TelegramInboundUpdate,
} from '../../connections/providers/index.js';
import {
  getMessengerVendorDeclaration,
  listMessengerVendors,
  type ConnectionRow,
} from '@recued/contracts';
import {
  createIdempotencyLedger,
  createWebhookPortHandler,
  type IdempotencyLedger,
  type WebhookVendorDescriptor,
} from '../../ports/index.js';
import type { MessengerWebhookDispatch } from './wire-inbound-answer-dispatcher.js';
import {
  resolveConnectionVendor,
  type ConnectionStoreSqlite,
} from '../../storage/connection-store.js';

/** Vendor event dispatch seam. Defaults to log-and-drop in this substrate slice;
 *  the inbound-answer follow-on overrides.
 *
 *  D-192 seam 11 retired the per-vendor `DispatchSlackEvent` /
 *  `DispatchTelegramEvent` pair — the last per-vendor bridge Groups B and D left
 *  standing. Chat transports now share ONE `MessengerWebhookDispatch`, keyed by
 *  slug in `messengerDispatchers`. Stripe keeps its own: it is a payment webhook,
 *  not a chat transport, and is absent from the messenger registry by
 *  construction. */
export type DispatchStripeEvent = (event: StripeInboundEvent) => Promise<void>;

export interface ComposeVendorWebhookPortDeps {
  /** Same gate the Phase D webhook listener uses. `<= 0` ⇒ no port. */
  webhookPort: number;
  /** Connection store for vendor connection lookup. Absent
   *  daemon ⇒ no port (no connections to look up against). */
  connectionStore?: ConnectionStoreSqlite;
  /** D-192 seam 11 — vendor → inbound dispatcher, from
   *  `composeInboundAnswerDispatcher`. Replaces the named `dispatchSlackEvent` /
   *  `dispatchTelegramEvent` pair. A vendor absent from the record (or an absent
   *  record entirely) falls back to the generic log-and-drop stub, so the port
   *  keeps a stable seam regardless of which substrates are wired. */
  messengerDispatchers?: Record<string, MessengerWebhookDispatch>;
  /** Optional Stripe event dispatch. Absent means the Stripe route is not
   *  registered; verified lifecycle events must never be accepted and dropped. */
  dispatchStripeEvent?: DispatchStripeEvent;
  /** Optional logger for the port handler + the default dispatch stubs. */
  log?: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void;
  /** Test-only: pre-built idempotency ledger. Default: a fresh ledger
   *  with the 24-hour spec window. */
  ledger?: IdempotencyLedger;
  /** Test-only: clock for the ledger. */
  now?: () => number;
  /** D-188 — master "Pause server" flag. When true, this vendor webhook
   *  port (messenger callbacks, Stripe events, and messenger turn ingest) is
   *  CLOSED: every inbound request is rejected (503 SERVER_PAUSED) without
   *  dispatching, until the owner resumes. The fourth inbound webhook
   *  intake path — gated alongside the singular `/webhook`, `/hook`, and
   *  `/v1/connection/webhook` listeners. Read per-request. Absent ⇒ never
   *  paused. */
  isPaused?: () => boolean;
}

export type VendorWebhookPortHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<void>;

/** D-192 seam 11 — ONE inbound-secret reader, over the DECLARED
 *  `ingress.secret_field`. The two readers it replaces (`readSlackSigningSecret`
 *  / `readTelegramWebhookSecret`) were byte-identical apart from which
 *  `config_json` key they read — and that key was already a declared fact, so it
 *  was never per-vendor knowledge, just an enumeration. Returns null when the row
 *  is missing, the JSON is malformed, the vendor is undeclared / non-webhook, or
 *  the field is absent / empty (fail-closed: no secret ⇒ no verification ⇒ the
 *  descriptor rejects the delivery). */
const readInboundSecret = (
  connectionStore: ConnectionStoreSqlite,
  vendor: string,
  connection_name: string,
): { row: ConnectionRow; secret: string } | null => {
  const secret_field = getMessengerVendorDeclaration(vendor)?.ingress.secret_field;
  if (secret_field === undefined) return null;
  const row = connectionStore.get('notification', connection_name);
  if (row === null) return null;
  let config: unknown;
  try {
    config = JSON.parse(row.config_json);
  } catch {
    return null;
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return null;
  }
  const secret = (config as Record<string, unknown>)[secret_field];
  if (typeof secret !== 'string' || secret.length === 0) return null;
  return { row, secret };
};

/** D-192 seam 11 — what every messenger webhook leaf is handed. The secret comes
 *  back through the ONE generic reader (keyed on the declared
 *  `ingress.secret_field`), and the dispatcher through the ONE generic normalizer
 *  (keyed on the declared `ingress.id_field`); a leaf's only job is to adapt those
 *  into its own descriptor's contract. */
interface MessengerWebhookLeafDeps {
  lookup: (connection_name: string) => { row: ConnectionRow; secret: string } | null;
  dispatch: MessengerWebhookDispatch;
  now?: () => number;
  /** D-192 Discord — the only leaf that needs a logger, and it genuinely does: it
   *  does NOT await its dispatch (Discord kills an unacknowledged interaction at 3
   *  seconds, while `closeAsk` fans out with 15-second HTTP timeouts), so a
   *  downstream failure has no other way to surface. The other leaves await and let
   *  the port's 502 speak for them. */
  log?: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void;
}

/** The per-vendor webhook LEAVES — the thin adapters for what genuinely cannot
 *  generalize (§0): each vendor's descriptor factory owns its real verification
 *  scheme (Slack HMAC-SHA256 over `v0:<ts>:<body>` with a replay window, needing
 *  `now`; Telegram a constant-time compare of a header secret-token, needing no
 *  clock) and names the field it wants the secret under. Slug-keyed, so a new
 *  transport is ONE entry here plus its declaration — never an edit to the
 *  composer. Mirrors `MESSENGER_TRANSPORT_FACTORIES` (Group C). */
export const MESSENGER_WEBHOOK_DESCRIPTOR_LEAVES: Record<
  string,
  (deps: MessengerWebhookLeafDeps) => WebhookVendorDescriptor
> = {
  slack: ({ lookup, dispatch, now }) =>
    createSlackVendorDescriptor({
      lookupSlackConnection: (connection_name) => {
        const found = lookup(connection_name);
        return found === null
          ? null
          : { row: found.row, signing_secret: found.secret };
      },
      dispatchEvent: dispatch,
      ...(now ? { now } : {}),
    }),
  telegram: ({ lookup, dispatch }) =>
    createTelegramVendorDescriptor({
      lookupTelegramConnection: (connection_name) => {
        const found = lookup(connection_name);
        return found === null
          ? null
          : { row: found.row, secret_token: found.secret };
      },
      dispatchEvent: dispatch,
    }),
  // D-192 make-live. Two things are WhatsApp's alone and live inside the leaf:
  // the HMAC is over the RAW body with no timestamp (so no replay window is even
  // possible — the port's body-hash dedup is the defence, and it is exact because
  // a Meta retry is byte-identical), and the descriptor carries a `verifyChallenge`
  // for Meta's GET ownership handshake. The leaf gets the ROW, not just the secret,
  // because the handshake needs a SECOND config value (`verify_token`) that the
  // generic one-declared-secret-field reader does not fetch — correctly, since one
  // secret is the right shape for every other vendor.
  whatsapp: ({ lookup, dispatch }) =>
    createWhatsAppVendorDescriptor({
      lookupWhatsAppConnection: (connection_name) => {
        const found = lookup(connection_name);
        return found === null
          ? null
          : { row: found.row, app_secret: found.secret };
      },
      dispatchEvent: dispatch,
    }),
  // D-192 Discord. The verification material is a PUBLIC key (Ed25519 — the first
  // asymmetric scheme in the family), which the generic reader fetches through the
  // declared `ingress.secret_field` unchanged: the facet names the config KEY the
  // verifier reads, not a secret. The `log` is threaded because this leaf is the one
  // that does not await its dispatch — see `discord-provider.ts`.
  discord: ({ lookup, dispatch, log }) =>
    createDiscordVendorDescriptor({
      lookupDiscordConnection: (connection_name) => {
        const found = lookup(connection_name);
        return found === null
          ? null
          : { row: found.row, public_key: found.secret };
      },
      dispatchEvent: dispatch,
      ...(log ? { log } : {}),
    }),
};

/** Read the Stripe endpoint signing secret from a canonical
 *  `connection.api.stripe` row. Both the connection kind and shared vendor
 *  resolver must match so a same-named non-Stripe row cannot lend authority to
 *  the Stripe webhook route. */
const readStripeWebhookSecret = (
  connectionStore: ConnectionStoreSqlite,
  connection_name: string,
): StripeConnectionLookup | null => {
  const row = connectionStore.get('api', connection_name);
  if (row === null || resolveConnectionVendor(row) !== 'stripe') return null;
  let config: unknown;
  try {
    config = JSON.parse(row.config_json);
  } catch {
    return null;
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return null;
  }
  const webhook_secret = (config as Record<string, unknown>).webhook_secret;
  if (typeof webhook_secret !== 'string' || webhook_secret.length === 0) return null;
  return { row, webhook_secret };
};

/** Compose the D-148 P9 vendor webhook port. Returns `undefined` when
 *  the port is disabled (`webhookPort <= 0`) or when the connection
 *  store is unwired (no rows to look up against — daemon-only mode).
 *  The path-router in `server.ts` gates the `/webhooks/*` branch on
 *  the returned handler, so undefined ⇒ all `/webhooks/*` traffic
 *  falls through to the floor 404. */
export const composeVendorWebhookPort = (
  deps: ComposeVendorWebhookPortDeps,
): VendorWebhookPortHandler | undefined => {
  if (deps.webhookPort <= 0) return undefined;
  if (!deps.connectionStore) return undefined;

  const { connectionStore } = deps;
  const log = deps.log;

  // D-192 seam 11 — the messenger ingress map, built by ITERATING the registry.
  // Only two things were ever per-vendor here: the descriptor factory (a genuine
  // leaf — HMAC-over-body vs. constant-time secret-token compare is real
  // cryptographic difference) and the shape it wants its secret handed back in.
  // Both live in the slug-keyed leaf map below; everything else — the secret
  // read, the default log-and-drop stub, the dispatcher wiring — is now written
  // once. A new chat transport is a declaration + a leaf, never an edit here.
  const messengerVendors: Record<string, WebhookVendorDescriptor> = {};
  for (const vendor of listMessengerVendors()) {
    const declaration = getMessengerVendorDeclaration(vendor);
    // Only a `webhook` ingress has a webhook descriptor. A `socket` / `poll`
    // vendor (Discord's Gateway) arrives by another path and must NOT be exposed
    // on this port — skipping is the fail-closed choice.
    if (declaration === null || declaration.ingress.mode !== 'webhook') continue;
    const leaf = MESSENGER_WEBHOOK_DESCRIPTOR_LEAVES[vendor];
    if (leaf === undefined) continue;

    const id_field = declaration.ingress.id_field ?? 'id';
    // Default dispatch stub — log + drop — when no inbound-answer dispatcher is
    // wired. The log detail reproduces the vendor's NATIVE id field name, as the
    // two per-vendor stubs it replaces did, so log lines stay byte-identical.
    const dispatch: MessengerWebhookDispatch =
      deps.messengerDispatchers?.[vendor] ?? (async (event) => {
        const raw = (event as unknown as Record<string, unknown>)[id_field];
        log?.('info', `webhook inbound (${vendor})`, {
          connection_name: event.connection_name,
          ...(typeof raw === 'string' ? { [id_field]: raw } : {}),
        });
      });

    messengerVendors[vendor] = leaf({
      lookup: (connection_name) => readInboundSecret(connectionStore, vendor, connection_name),
      dispatch,
      ...(deps.now ? { now: deps.now } : {}),
      ...(log ? { log } : {}),
    });
  }

  // D-196: no default accept-and-drop path. The webhook is an accelerator for
  // authoritative provider read-back; without that dispatcher, expose no
  // Stripe vendor fingerprint and let the shared handler return its generic 404.
  const stripe = deps.dispatchStripeEvent
    ? createStripeVendorDescriptor({
        lookupStripeConnection: (connection_name) =>
          readStripeWebhookSecret(connectionStore, connection_name),
        dispatchEvent: deps.dispatchStripeEvent,
        ...(deps.now ? { now: deps.now } : {}),
      })
    : null;

  const ledger = deps.ledger ?? createIdempotencyLedger(
    deps.now ? { now: deps.now } : {},
  );

  const handler = createWebhookPortHandler({
    vendors: {
      ...messengerVendors,
      // Stripe is NOT a chat transport — it is a payment webhook, absent from the
      // messenger registry by construction — so it stays a discrete entry.
      ...(stripe ? { stripe } : {}),
    },
    ledger,
    ...(log ? { log } : {}),
  });

  const isPaused = deps.isPaused;
  if (!isPaused) return handler;
  // D-188 — close the vendor webhook port while the server is paused (the
  // fourth inbound intake path; vendor callbacks bypass the op-admission gate,
  // so they must be closed here). Read per-request →
  // resume is instant.
  return async (req, res): Promise<void> => {
    if (isPaused()) {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          ok: false,
          error: {
            code: 'SERVER_PAUSED',
            message: 'server is paused — inbound webhooks are closed until the owner resumes',
          },
        }),
      );
      return;
    }
    await handler(req, res);
  };
};
