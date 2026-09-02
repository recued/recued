/** Handoff for the host-wide update lease taken by `bin.ts` before interrupted
 * pair recovery and released only after `compose-lifecycle` claims the realm.
 *
 * This leaf deliberately imports only a type. It is reachable before the native
 * SQLite addon is loaded, including when an interrupted pair swap left that
 * addon absent. */
import type { UpdateLease } from './update-lease.js';

let earlyBootLease: UpdateLease | null = null;

export const installEarlyBootUpdateLease = (lease: UpdateLease): void => {
  if (earlyBootLease !== null) {
    lease.release();
    throw new Error('early boot update lease is already installed');
  }
  earlyBootLease = lease;
};

/** Idempotent. Returns true when this call released the handoff. */
export const releaseEarlyBootUpdateLease = (): boolean => {
  const lease = earlyBootLease;
  earlyBootLease = null;
  if (lease === null) return false;
  lease.release();
  return true;
};
