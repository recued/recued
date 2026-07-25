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

export const bootInAppChannel = (
  deps: NotificationChannelBootDeps,
): NotificationChannelDispatcher =>
  buildSubtypeDispatcher(deps);
