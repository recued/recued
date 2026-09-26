/** In-app channel boot — wires the kernel `notification-send` in_app
 *  dispatcher.
 *
 *  Selects the user's enrolled `connection.notification.<name>` record
 *  with `subtype: 'in-app'` at call time, then routes through the
 *  shared connection-notification handler. The handler emits onto the
 *  broadcast bus via the boot-wired `emitInApp` callback — no HTTP,
 *  no auth, no creds. See `packages/ingredients/src/connection-notification.ts`
 *  `sendInApp` for the emit path.
 *
 *  The rpc-side channel id is `in_app` (underscore — D-122 P4.5 closed
 *  channel list) while the connection-row subtype is `in-app` (dash —
 *  D-125 P1.1 row contract). The boot keeps both labels explicit so
 *  the underscore/dash mismatch never leaks to recipe authors. */

import type { NotificationChannelDispatcher } from '../../../notification-handler.js';
import { buildSubtypeDispatcher } from '../../../notification-dispatchers.js';
import type { NotificationChannelBootDeps } from '../../notification-channel-registry.js';

/** ⛔ D-312 — IN-APP IS BUILT IN. It needed an enrolled in-app connection like
 *  the other channels, but it has nothing to enroll: no credentials, and its only
 *  destination is this server's own paired clients. A fresh server had none, so
 *  the 218 shipped recipes whose channel setting defaulted to in-app reported
 *  "Could not send to: in_app" until the owner found Connections → Apps & APIs →
 *  Add Connection → Notification → In-app. An enrolled one is still used; with none,
 *  the notification goes out on the broadcast bus directly.
 *
 *  ⚠ The built-in path writes no `connection_notification` audit row: that row
 *  names the connection it went through, and there is none. The run that sent
 *  it records the step and its `delivered_to`. */
export const bootInAppChannel = (
  deps: NotificationChannelBootDeps,
): NotificationChannelDispatcher => {
  const enrolled = buildSubtypeDispatcher(deps);
  return async (payload) => {
    const result = await enrolled(payload);
    if (result.ok || result.reason !== 'NO_CONNECTION_BOUND' || deps.emitInApp === undefined) {
      return result;
    }
    deps.emitInApp({
      text: payload.text,
      ...(payload.title !== undefined ? { title: payload.title } : {}),
      ...(payload.link_url !== undefined ? { link_url: payload.link_url } : {}),
    });
    return { ok: true };
  };
};
