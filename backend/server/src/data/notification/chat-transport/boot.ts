/** D-192 WhatsApp make-live — the boot for EVERY chat transport.
 *
 *  This replaces `notification/slack/boot.ts` and `notification/telegram/boot.ts`,
 *  which were byte-identical to each other and to this: a one-line delegation to
 *  `buildSubtypeDispatcher(deps)`. They carried no vendor knowledge whatsoever —
 *  the channel and subtype labels they "supplied" already come from the registry
 *  entry, and the dispatcher itself is generic (find the first connection row by
 *  subtype, call the shared notification handler).
 *
 *  Two files per vendor for a function that never varied per vendor is exactly the
 *  hand-spelled-enumeration smell this arc exists to remove — and it had teeth:
 *  because the registry was a hand-written ARRAY, a newly declared transport
 *  simply had no entry, no dispatcher, and no error. One boot, derived entries,
 *  and a new transport is dispatchable the moment it is declared.
 *
 *  A transport that ever DOES need bespoke boot (a per-channel rate limit, a
 *  default-config validator) gets its own module and a literal registry entry
 *  again — the seam is unchanged, it just stops being paid for by vendors that
 *  don't use it. */

import type { NotificationChannelDispatcher } from '../../../notification-handler.js';
import { buildSubtypeDispatcher } from '../../../notification-dispatchers.js';
import type { NotificationChannelBootDeps } from '../../notification-channel-registry.js';

export const bootChatTransportChannel = (
  deps: NotificationChannelBootDeps,
): NotificationChannelDispatcher =>
  buildSubtypeDispatcher(deps);
