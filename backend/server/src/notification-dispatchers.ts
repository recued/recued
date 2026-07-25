/** D-122 follow-on — `notification-send` channel dispatcher bridge.
 *
 *  D-122 P4.5 shipped the `notification-send` kernel ingredient + the
 *  `notification.send` rpc handler with an *empty* dispatcher map —
 *  every channel surfaced as `failed[]` until concrete transports were
 *  wired. D-125 P4.3 + D-127 P3.1 then graduated the four notification
 *  subtypes (slack / telegram / email / in-app) into the connection
 *  adapter's `connection.notification.<name>` per-kind handler. This
 *  module is the shared per-subtype dispatcher builder used by every
 *  per-channel boot module under `data/notification/<channel>/boot.ts`:
 *  at boot, each channel builds its dispatcher by closing over the
 *  connection store + the same notification handler the connection
 *  adapter uses, so a `notification-send` recipe step routes to
 *  whichever `connection.notification.<name>` record the user enrolled
 *  per subtype.
 *
 *  Per-channel record selection: the *first* enrolled
 *  `connection.notification.*` record with matching subtype wins
 *  (newest `updated_at` first per `connectionStore.list({ kind })`).
 *  Re-enrollments pick up immediately because the dispatcher rescans
 *  the store on every call rather than caching at boot — the
 *  notification path is low-frequency (one call per alert fire,
 *  bounded by the alert pack's per-recipe cron / event interval) so
 *  the rescan cost is negligible vs the staleness risk of caching.
 *
 *  No record matches → `{ ok: false, reason: 'NO_CONNECTION_BOUND' }`.
 *  Recipe-side: the alert-pack `notification-send` step lands in the
 *  channel's `failed[]` slot; the recipe author can wire a follow-up
 *  `skip_when` or `fail_on` against the `failed[]` array. UI side
 *  (when D-119's connections settings page renders): the user's
 *  prompt is "no <channel> connection enrolled — go enroll one".
 *
 *  Architecture invariant: the per-call audit row is the connection
 *  adapter's `connection_notification` (D-125 P3.2 — emitted at the
 *  adapter shell, not here). The notification-send rpc is a pure
 *  aggregator with no audit row of its own. The kernel ingredient's
 *  `mail_send` audit row (D-127 P1.7) only fires for the email path
 *  via `MailCollection.send` — that's the *delivery* row, distinct
 *  from the *dispatcher* row. Both surface in the activity feed when
 *  an email leg fires; that's by design (different audit categories
 *  for different concerns).
 *
 *  Registry seam: the bridge layer's closed channel list (slack /
 *  telegram / email / in_app) lives in
 *  `data/notification-channel-registry.ts` as a per-entry record
 *  carrying `{ channel, subtype, boot }`. The composer iterates the
 *  registry; each per-channel boot module invokes
 *  `buildSubtypeDispatcher` with its own labels. Future per-channel
 *  divergence (rate limiters, capability flags, default-config
 *  validators) lands in the per-channel module without touching this
 *  shared builder. */

import type { ConnectionKindHandler, ResolvedCall } from '@recued/ingredients';
import { IngredientError } from '@recued/ingredients';
import type { ConnectionRow, NotificationSubtype } from '@recued/contracts';
import type {
  NotificationChannel,
  NotificationChannelDispatcher,
  NotificationDispatchResult,
  NotificationPayload,
} from './notification-handler.js';
import type { ConnectionStoreSqlite } from './storage/connection-store.js';

/** Synthetic `ResolvedCall` the bridge passes to the connection
 *  notification handler. The handler reads `risk_tier` for 5xx →
 *  `ACTION_DELIVERY_UNCERTAIN` classification and `slug` for error
 *  diagnostic strings. Notifications are write-tier deliverables —
 *  Slack / Telegram / Email all commit before ack, so the
 *  uncertain-on-5xx classification is correct here. */
const buildSyntheticCall = (channel: NotificationChannel): ResolvedCall => ({
  slug: `recued/notification-send.${channel}`,
  risk_tier: 'write',
  input: {},
  output: {},
});

/** Translate the connection-notification handler's `NotificationResponse`
 *  envelope (`{ status: 'ok' | 'send_error', result, headers }`) into
 *  the kernel `notification-send` dispatcher's simpler `{ ok, reason? }`
 *  shape. Thrown `IngredientError` collapses to `{ ok: false }` with
 *  the error code as `reason` so the failed[] row carries enough
 *  context for the recipe author to act without parsing prose. */
const toDispatchResult = (raw: unknown): NotificationDispatchResult => {
  if (
    raw && typeof raw === 'object'
    && 'status' in raw
    && (raw as { status: unknown }).status === 'ok'
  ) {
    return { ok: true };
  }
  if (
    raw && typeof raw === 'object'
    && 'status' in raw
    && (raw as { status: unknown }).status === 'send_error'
  ) {
    const result = (raw as { result?: { error?: unknown } }).result;
    const errMsg = result && typeof result === 'object' && 'error' in result
      ? String(result.error)
      : 'send_error';
    return { ok: false, reason: errMsg };
  }
  return { ok: false, reason: 'unexpected_envelope' };
};

/** Per-channel dispatcher builder deps. Per-channel boot modules under
 *  `data/notification/<channel>/boot.ts` invoke this with their channel
 *  + subtype labels so the resulting closure carries the channel
 *  identity (used in the synthetic call's slug + the error envelope's
 *  vendor diagnostic) without the shared builder hard-coding any
 *  channel-specific knowledge. */
export interface SubtypeDispatcherDeps {
  connectionStore: ConnectionStoreSqlite;
  /** The same connection-notification handler the connection adapter
   *  uses (built once at boot via `createConnectionNotificationHandler`).
   *  Sharing the handler means re-enrollments + auth refreshes flow
   *  through one code path; the kernel notification-send and the
   *  wrapper-style `mail-post` / future slack-post / telegram-post
   *  send through the same transport. */
  notificationHandler: ConnectionKindHandler;
  /** Channel id surfaced to the kernel `notification-send` rpc
   *  (`slack` / `telegram` / `email` / `in_app`). Used in the synthetic
   *  call's slug + the error envelope. */
  channel: NotificationChannel;
  /** Underlying connection-row subtype (`slack` / `telegram` / `email` /
   *  `in-app`). Used to pick the matching connection record at call
   *  time. The dash vs underscore mismatch for `in_app` ↔ `in-app`
   *  lives at the channel-boot boundary; this builder treats them
   *  separately by design. */
  subtype: NotificationSubtype;
}

/** Build one channel's dispatcher closure. The returned closure
 *  rescans the connection store on every call, picks the first
 *  matching `kind: 'notification'` record by subtype, and invokes the
 *  connection-notification handler against that record. Channels with
 *  no enrolled connection report `{ ok: false, reason:
 *  'NO_CONNECTION_BOUND' }` rather than throwing — the kernel
 *  `notification-send` rpc's failure semantics stay stable whether
 *  zero or all channels are enrolled. */
export const buildSubtypeDispatcher = (
  deps: SubtypeDispatcherDeps,
): NotificationChannelDispatcher => {
  const call = buildSyntheticCall(deps.channel);
  return async (payload: NotificationPayload): Promise<NotificationDispatchResult> => {
    const records = deps.connectionStore.list({ kind: 'notification' });
    const match = records.find((r): r is ConnectionRow => r.subtype === deps.subtype);
    if (!match) {
      return { ok: false, reason: 'NO_CONNECTION_BOUND' };
    }

    const params: Record<string, unknown> = {
      text: payload.text,
      ...(payload.title !== undefined ? { title: payload.title } : {}),
      ...(payload.link_url !== undefined ? { link_url: payload.link_url } : {}),
    };

    try {
      const raw = await deps.notificationHandler(match, params, call, undefined);
      return toDispatchResult(raw);
    } catch (e) {
      if (e instanceof IngredientError) {
        return { ok: false, reason: e.code };
      }
      return { ok: false, reason: (e as Error).message ?? 'unknown_error' };
    }
  };
};
