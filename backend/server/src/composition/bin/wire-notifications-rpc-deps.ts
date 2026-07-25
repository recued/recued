/** D-163 Slice C — notifications rpc-deps composer.
 *
 *  Builds the `NotificationRpcDeps` shape consumed by the three
 *  `notifications.*` rpcs (`describe` / `set_channel` /
 *  `set_verification_phrase`). The bundle is just a reference to the
 *  already-composed `NotificationBlock` instance — the block owns its
 *  settings store + readiness probe internally, so this composer is a
 *  thin presence gate: when the block is absent (dbless harness, or a
 *  boot where the notification block's four prerequisites didn't
 *  resolve), the bundle drops and the handler set surfaces
 *  `not_configured` on the wire.
 *
 *  Threaded through `composeRpcContext` into
 *  `createServerHandlerSet({ notificationsDeps })`. */

import type { NotificationBlock } from '@recued/notification';

import type { EventBus } from '../../events/bus.js';
import type { NotificationRpcDeps } from '../../notifications-handler.js';

export interface ComposeNotificationsRpcDepsInput {
  /** The `@recued/notification` block composed earlier in boot via
   *  `composeNotificationBlock`. Absent → composer returns the
   *  undefined-bundle and the caller drops the `notificationsDeps`
   *  spread. */
  block: NotificationBlock | undefined;
  /** D-169 P2 Slice 4 (live-mode propagation) — D-121 broadcast bus.
   *  Optional — when present the composer threads a narrow emitter onto
   *  `notificationsDeps.emit` so a successful `set_bridge_mode` fans out
   *  a `notification.bridge_mode_changed` event to the affected bridge.
   *  Absent → the handler runs without emit (dbless / pre-bus harness).
   *  Mirrors the `eventBus` thread in `wire-pack-install-rpc-deps.ts`. */
  eventBus?: EventBus;
}

export interface NotificationsRpcBundle {
  /** Threaded into `createServerHandlerSet({ notificationsDeps })`.
   *  Undefined when `block` is missing → caller drops the conditional
   *  spread + every `notifications.*` rpc returns `not_configured`. */
  notificationsDeps: NotificationRpcDeps | undefined;
}

export const composeNotificationsRpcDeps = (
  input: ComposeNotificationsRpcDepsInput,
): NotificationsRpcBundle => {
  const { block, eventBus } = input;
  if (!block) {
    return { notificationsDeps: undefined };
  }
  return {
    notificationsDeps: {
      block,
      // D-169 P2 Slice 4 — bus-backed emitter (cursor stamped by the bus
      // on emit). Threaded only when the bus is present; the handler's
      // `emit?.` makes it a no-op otherwise.
      ...(eventBus
        ? {
            emit: (event) => {
              eventBus.emit(event);
            },
          }
        : {}),
    },
  };
};
