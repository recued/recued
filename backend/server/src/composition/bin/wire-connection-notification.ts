/** D-122/D-125/D-127 — boot composer for the connection-notification
 *  cluster.
 *
 *  Three consts wired together at bin.ts boot, pivoting on
 *  `connectionStore` presence:
 *    - `notificationDeps` — `ConnectionNotificationHandlerDeps` shape
 *      built from the connection sub-DEK pipeline (`decodeAuth`) +
 *      eventBus (`emitInApp`) + mail collection (`mailRpc.send`).
 *    - `notificationHandler` — `ConnectionKindHandler` over those deps,
 *      shared between the connection adapter (kind: 'connection') and
 *      the kernel `notification-send` dispatcher bridge.
 *    - `channelDispatchers` — per-channel dispatcher map produced by
 *      iterating `NOTIFICATION_CHANNEL_REGISTRY`; one dispatcher per
 *      slack/telegram/email/in_app channel, each rescans the connection
 *      store at call time so re-enrollments pick up immediately. Adding
 *      a new channel is one append to the registry + a new
 *      `data/notification/<channel>/boot.ts` module — this composer
 *      stays unchanged.
 *
 *  Absent `connectionStore` (dbless harnesses) → all three undefined;
 *  bin.ts surfaces `executorConfig.connectionNotification` undefined
 *  + `notificationDeps.dispatchers` empty, exactly matching the
 *  pre-extraction posture. */

import type { ConnectionKindHandler } from '@recued/ingredients';
import {
  createConnectionNotificationHandler,
  type ConnectionNotificationHandlerDeps,
} from '@recued/ingredients';
import { NOTIFICATION_DELIVERY_CHANNELS, totalRecord } from '@recued/contracts';
import type { ConnectionStoreSqlite } from '../../storage/connection-store.js';
import type { CollectionRegistry } from '../../collections/registry.js';
import type { EventBus } from '../../events/bus.js';
import type { KeyManager } from '../../key-manager.js';
import { decodeAuthFromStorage } from '../../connection-handler.js';
import { handleCollectionMailSend } from '../../collections/collection-handler.js';
import { emitNotification } from '../../events/emit-sites.js';
import { NOTIFICATION_CHANNEL_REGISTRY } from '../../data/notification-channel-registry.js';
import type {
  NotificationChannel,
  NotificationChannelDispatcher,
} from '../../notification-handler.js';

export interface ComposeConnectionNotificationDeps {
  connectionStore: ConnectionStoreSqlite | undefined;
  keys: KeyManager | undefined;
  eventBus: EventBus;
  collectionRegistry: CollectionRegistry;
}

export interface ConnectionNotificationBundle {
  notificationDeps: ConnectionNotificationHandlerDeps | undefined;
  notificationHandler: ConnectionKindHandler | undefined;
  channelDispatchers:
    | Record<NotificationChannel, NotificationChannelDispatcher>
    | undefined;
}

/** Compose the cluster. All three outputs are undefined-together when
 *  `connectionStore` is absent. */
export const composeConnectionNotification = (
  deps: ComposeConnectionNotificationDeps,
): ConnectionNotificationBundle => {
  const { connectionStore, keys, eventBus, collectionRegistry } = deps;

  if (!connectionStore) {
    return {
      notificationDeps: undefined,
      notificationHandler: undefined,
      channelDispatchers: undefined,
    };
  }

  // D-125 P3.2 — the connection sub-DEK provider is wired only when
  // the encryption substrate has actually initialized. Locked / fresh
  // installs leave it undefined; the connection adapter's
  // `decodeAuthFromStorage` then falls through to the plaintext branch
  // for the lifetime of the locked window. Auth re-encrypts on first
  // upsert after unlock.
  const keyProvider = (keys && keys.state() !== 'uninitialized')
    ? keys.keyProvider('connection')
    : undefined;

  const notificationDeps: ConnectionNotificationHandlerDeps = {
    decodeAuth: (row) =>
      decodeAuthFromStorage(
        row.auth_ciphertext,
        { kind: row.kind, name: row.name },
        keyProvider,
      ),
    emitInApp: (body) =>
      emitNotification(eventBus, { subtype: 'in-app', body }),
    mailRpc: {
      send: (args) =>
        handleCollectionMailSend({ registry: collectionRegistry }, args),
    },
  };

  const notificationHandler =
    createConnectionNotificationHandler(notificationDeps);

  // Iterate the registry — each entry's `boot` returns its channel's
  // dispatcher closure. The composer threads `entry.channel` + `entry
  // .subtype` into the boot call so the registry stays the single
  // source of truth for the channel/subtype mapping; boot modules
  // build against the registry's labels rather than hard-coding their
  // own. Order in the resulting map mirrors registry order so boot
  // diagnostics are deterministic, but every key is accessed by
  // channel id (not by index) downstream.
  const booted: Partial<Record<NotificationChannel, NotificationChannelDispatcher>> = {};
  for (const entry of NOTIFICATION_CHANNEL_REGISTRY) {
    booted[entry.channel] = entry.boot({
      connectionStore,
      notificationHandler,
      channel: entry.channel,
      subtype: entry.subtype,
    });
  }
  // ⛔ COMPLETENESS IS CHECKED HERE, LOUDLY — this is the failure the registry's
  // own note describes ("an ARRAY cannot be checked for completeness by the
  // compiler … no dispatcher, meaning `notification.send` aimed at it would
  // resolve, enrol, probe healthy, and then do NOTHING. Green, ready, and mute:
  // the same failure this arc has now met three times").
  //
  // The map used to be built as `{} as Record<NotificationChannel, …>`, and that
  // cast asserted every key was present — so a channel missing from the array
  // produced `undefined` typed as a dispatcher, which is exactly the mute path.
  // `NOTIFICATION_DELIVERY_CHANNELS` is the derived source of the union, so this
  // walk is total by construction and a gap now fails the BOOT, not a send.
  const channelDispatchers = totalRecord(NOTIFICATION_DELIVERY_CHANNELS, (channel) => {
    const dispatcher = booted[channel];
    if (dispatcher === undefined) {
      throw new Error(
        `connection-notification: no dispatcher registered for channel '${channel}' `
        + '— add an entry to NOTIFICATION_CHANNEL_REGISTRY',
      );
    }
    return dispatcher;
  });

  return { notificationDeps, notificationHandler, channelDispatchers };
};
