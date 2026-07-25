/** Phase G (D-109) — server status pill entry point. */

export { renderServerPill, computePillState } from './render.js';
export type { ServerPillOptions } from './render.js';
export { mountServerPill } from './mount.js';
export type { ServerPillMountOptions, ServerPillHandle } from './mount.js';
export {
  integrateServerPill,
  readCachedServerSnapshot,
  openOptionsAtServerHome,
  SERVER_HEARTBEAT_BROADCAST_KIND,
  PILL_DEEP_LINK_HASH,
} from './integrate.js';
export type {
  IntegrateServerPillOptions,
  IntegratedServerPill,
  ServerHeartbeatBroadcast,
} from './integrate.js';
