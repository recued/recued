/** D-122 Phase 4.5 — `notification-send` ingredient + rpc handler.
 *
 *  Generic outbound notification surface. Alert recipes call this
 *  rather than channel-specific ingredients (slack-post, telegram-send,
 *  email-send) so channel choice stays in the recipe's `config` rather
 *  than its step graph. The handler fan-outs to per-channel
 *  dispatchers — Slack / Telegram / email route through the existing
 *  remote-trigger config (D-099); in-app rides the realtime broadcast
 *  bus (D-121 Phase 6). Each channel's dispatcher reports per-call
 *  success / failure; the handler aggregates into `delivered_to[]` +
 *  `failed[]`.
 *
 *  Substrate-only landing: the channel implementations are caller-
 *  injected. Boot wires the live dispatchers; tests inject mocks.
 *  Channels with no dispatcher report as `failed[]` so recipe authors
 *  see a clean per-channel signal in the audit log. */

import { NOTIFICATION_DELIVERY_CHANNELS, RpcError } from '@recued/contracts';
import type {
  HandlerSlice,
  NotificationDeliveryChannel,
  ServerRpcRegistry,
} from '@recued/contracts';
import type { WsClient } from './ws-server.js';

/** D-192 seam 10 — the `notification.send` delivery vocabulary, from contracts
 *  (every declared chat transport + `email` + `in_app`). A new chat transport
 *  becomes sendable with no edit here. */
export type NotificationChannel = NotificationDeliveryChannel;

export const ALL_NOTIFICATION_CHANNELS: ReadonlyArray<NotificationChannel> =
  NOTIFICATION_DELIVERY_CHANNELS;

export interface NotificationPayload {
  channel: NotificationChannel;
  text: string;
  title?: string;
  link_url?: string;
}

export interface NotificationDispatchResult {
  ok: boolean;
  /** Optional reason surfaced when `ok: false` so the caller's audit
   *  log can record why a channel failed without parsing prose. */
  reason?: string;
}

/** Channel dispatcher signature. The boot composition wires one per
 *  configured channel; absent dispatchers surface as `failed[]` rather
 *  than throwing so a misconfigured channel doesn't tank the entire
 *  notification path. */
export type NotificationChannelDispatcher = (
  payload: NotificationPayload,
) => Promise<NotificationDispatchResult>;

export interface NotificationDeps {
  /** Per-channel dispatcher map. Channels not present in the map are
   *  considered unconfigured and surface as `failed[]`. */
  dispatchers: Partial<Record<NotificationChannel, NotificationChannelDispatcher>>;
}

export interface NotificationSendArgs {
  /** Omitted means fan out to every channel the owner has SET UP (in-app is
   *  always set up; D-312): a channel with nothing enrolled is left out of both
   *  lists. Named channels are the owner's own choice, so a named one that is
   *  not set up is reported in `failed`. Recipes should only pass channels when
   *  the user expressed a delivery preference. */
  channels?: NotificationChannel[];
  text: string;
  title?: string;
  link_url?: string;
  /** Which recipe asked for this — rendered as a trailing attribution line.
   *
   *  ⛔ ENGINE-OWNED, NEVER AUTHORED. The kernel adapter sets this from
   *  `call.stepMeta.recipe_id`, which the engine stamps; it is deliberately
   *  NOT read from the step's own `args`, because an attribution a recipe can
   *  write is an attribution a recipe can forge — and a forgeable "from" line
   *  is worse than none, since it invites trust it cannot earn. Same posture
   *  as `RECIPE_KEYED_WATCHER_SLUGS`, where the adapter overwrites
   *  `args.recipe_id` for exactly this reason.
   *
   *  ⚠ WHY THIS EXISTS AT ALL: until `core.notification.send` was retiered to
   *  `read` (2026-08-20), every recipe notification was preceded by an approval
   *  ask, and THAT ask named the sending recipe ("Recipe X wants to run
   *  core-notification-send"). Removing the gate removed the only thing that
   *  said who was talking. The gate was the wrong place to carry it — it cost
   *  the owner a decision to learn a name — but the name itself was worth
   *  keeping.
   *
   *  Absent ⇒ no attribution line, byte-identical to the pre-attribution
   *  delivery (the rpc surface passes none). */
  source_recipe_id?: string;
}

/** Cap on a rendered recipe id, so a pathological slug cannot dominate a
 *  push notification's preview line. Ids are kebab slugs well under this. */
const SOURCE_RECIPE_ID_MAX = 64;

/** Append the attribution line to a delivered body.
 *
 *  ⚠ Rendered into `text` rather than added as a structured field on purpose:
 *  `NotificationPayload` reaches four independently-written channel dispatchers
 *  (slack / telegram / email / in-app), and a new optional field would be
 *  silently DROPPED by each one until it was taught to render it — the
 *  enumerating-copier failure this repo has hit before. Folding it into the
 *  body means every channel carries it the day it ships. */
const withAttribution = (text: string, source_recipe_id?: string): string => {
  if (typeof source_recipe_id !== 'string') return text;
  const id = source_recipe_id.trim();
  if (id.length === 0) return text;
  return `${text}\n\n— sent by recipe ${id.slice(0, SOURCE_RECIPE_ID_MAX)}`;
};

const isChannel = (s: unknown): s is NotificationChannel =>
  typeof s === 'string' && (ALL_NOTIFICATION_CHANNELS as readonly string[]).includes(s);

export const handleNotificationSend = async (
  deps: NotificationDeps,
  args: NotificationSendArgs,
): Promise<{ delivered_to: NotificationChannel[]; failed: NotificationChannel[] }> => {
  if (args.channels !== undefined && (!Array.isArray(args.channels) || args.channels.length === 0)) {
    throw new RpcError('bad_request', 'notification.send: channels[] is required');
  }
  if (typeof args.text !== 'string' || args.text.length === 0) {
    throw new RpcError('bad_request', 'notification.send: text is required');
  }
  // D-312 — no channels named: every channel the owner has set up. A recipe's
  // default is this, and reporting each channel the owner never set up as a
  // failure made every reminder say "Could not send to: slack, telegram, email".
  const fanOut = args.channels === undefined;
  const channels = args.channels ?? [...ALL_NOTIFICATION_CHANNELS];
  for (const channel of channels) {
    if (!isChannel(channel)) {
      throw new RpcError(
        'bad_request',
        `notification.send: invalid channel '${String(channel)}' (allowed: ${ALL_NOTIFICATION_CHANNELS.join(', ')})`,
      );
    }
  }

  const delivered: NotificationChannel[] = [];
  const failed: NotificationChannel[] = [];

  // Run channels in parallel; per-channel failure doesn't block
  // others. The `Promise.all` shape preserves the index alignment so
  // the per-channel outcome maps back cleanly.
  const results = await Promise.all(
    channels.map(async (channel): Promise<{ channel: NotificationChannel; ok: boolean; notSetUp: boolean }> => {
      const dispatcher = deps.dispatchers[channel];
      if (!dispatcher) return { channel, ok: false, notSetUp: true };
      try {
        const out = await dispatcher({
          channel,
          text: withAttribution(args.text, args.source_recipe_id),
          ...(args.title !== undefined ? { title: args.title } : {}),
          ...(args.link_url !== undefined ? { link_url: args.link_url } : {}),
        });
        return { channel, ok: out.ok, notSetUp: !out.ok && out.reason === 'NO_CONNECTION_BOUND' };
      } catch {
        return { channel, ok: false, notSetUp: false };
      }
    }),
  );

  // A channel the owner never set up is left out of a fan-out's failures only
  // while something got through: a note that reached nobody is reported, never
  // quiet. In-app is built in, so on a server this takes a broken bus.
  const reachedSomeone = results.some((result) => result.ok);
  for (const result of results) {
    if (result.ok) delivered.push(result.channel);
    else if (!(fanOut && result.notSetUp && reachedSomeone)) failed.push(result.channel);
  }

  return { delivered_to: delivered, failed };
};

// D-177 N.12 — `notification.send` STAYS a wire method (unlike
// `collection.mail.send`). Its authorization model is the deliberate
// endpoint SETUP, not the per-action contract: the user enrolls + assigns +
// switches on each notification channel (bridge / Slack / Telegram / email),
// and `notification.send` carries NO recipient — it pushes `text` to the
// SWITCHED-ON channels, whose destination is the enrolled config
// (`config.default_recipient` for email). It cannot be aimed at an arbitrary
// target the way `collection.mail.send`'s per-call `to[]` can, so it is not a
// trust-bypass. The arbitrary-recipient path (`mail-post` with `to[]`) is the
// gated kernel ingredient (outbound-send escalation), distinct from this.

type NotificationMethods = 'notification.send';

export const makeNotificationHandlers = (
  deps: NotificationDeps | undefined,
): HandlerSlice<ServerRpcRegistry, NotificationMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['notification.send'],
    handlers: {
      'notification.send': async (args) =>
        handleNotificationSend(deps, args as Parameters<typeof handleNotificationSend>[1]),
    },
  };
};
