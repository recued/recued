/** Email channel boot — wires the kernel `notification-send` email
 *  dispatcher.
 *
 *  Selects the user's enrolled `connection.notification.<name>` record
 *  with `subtype: 'email'` at call time, then routes through the
 *  shared connection-notification handler. The wire transport
 *  (`MailCollection.send` façade reading `sender_mail_instance` from
 *  config, body/recipient resolution chain, mail_send audit row from
 *  D-127 P1.7) lives in `packages/ingredients/src/connection-notification.ts`. */

import type { NotificationChannelDispatcher } from '../../../notification-handler.js';
import { buildSubtypeDispatcher } from '../../../notification-dispatchers.js';
import type { NotificationChannelBootDeps } from '../../notification-channel-registry.js';

export const bootEmailChannel = (
  deps: NotificationChannelBootDeps,
): NotificationChannelDispatcher =>
  buildSubtypeDispatcher(deps);
