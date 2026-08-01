/** One-shot continuity for an intentional startup-recovery reload.
 *
 * User-facing startup recovery surfaces can retry in-process or reload the
 * current document. In-process retries can carry their outcome in memory; a
 * reload cannot. This module bridges only those explicit product actions with
 * a constant, same-tab session marker. It never stores a route, draft,
 * diagnostic, server address, credential, or error detail.
 *
 * The next document invalidates and removes the marker before doing any
 * startup work, then holds only the resulting boolean in memory. A failed boot
 * may acknowledge that reload once on its reason-aware recovery surface; a
 * successful boot may queue the same transient connection-banner receipt used
 * by in-process recovery. Neither outcome can leak into a later ordinary
 * reload. */

export const STARTUP_RELOAD_RECOVERY_SESSION_KEY =
  'recued.webclient.startup-reload-recovery.v1';

const STARTUP_RELOAD_RECOVERY_ARMED = '1';
const STARTUP_RELOAD_RECOVERY_RETIRED = '0';

export type StartupReloadRecoveryStorage = Pick<
  Storage,
  'getItem' | 'setItem' | 'removeItem'
>;

const resolveStorage = (
  storage?: StartupReloadRecoveryStorage | null,
): StartupReloadRecoveryStorage | undefined => {
  if (storage === null) return undefined;
  if (storage !== undefined) return storage;
  try {
    return (globalThis as { sessionStorage?: Storage }).sessionStorage;
  } catch {
    return undefined;
  }
};

/** Make the marker incapable of replay before removing it. Some privacy modes
 * allow replacing a session-storage value but deny deletion. In that case the
 * inert retired value may remain, but it can never produce another receipt. */
const retireMarker = (
  storage: StartupReloadRecoveryStorage | undefined,
): boolean => {
  if (storage === undefined) return false;
  try {
    storage.setItem(
      STARTUP_RELOAD_RECOVERY_SESSION_KEY,
      STARTUP_RELOAD_RECOVERY_RETIRED,
    );
    try {
      storage.removeItem(STARTUP_RELOAD_RECOVERY_SESSION_KEY);
    } catch {
      /* the already-retired value is safe to leave behind */
    }
    return true;
  } catch {
    try {
      storage.removeItem(STARTUP_RELOAD_RECOVERY_SESSION_KEY);
      return true;
    } catch {
      return false;
    }
  }
};

/** Read and retire the prior explicit-reload marker. Unknown/stale values are
 * removed too, but never produce a success receipt. */
export const consumeStartupReloadRecovery = (
  storage?: StartupReloadRecoveryStorage | null,
): boolean => {
  const resolved = resolveStorage(storage);
  if (resolved === undefined) return false;
  let value: string | null = null;
  try {
    value = resolved.getItem(STARTUP_RELOAD_RECOVERY_SESSION_KEY);
  } catch {
    // Reading can be denied independently. Invalidate any possible marker,
    // but never acknowledge a recovery whose intent could not be verified.
    retireMarker(resolved);
    return false;
  }
  if (value === null) return false;
  const retired = retireMarker(resolved);
  return retired && value === STARTUP_RELOAD_RECOVERY_ARMED;
};

export interface RequestStartupRecoveryReloadOptions {
  /** Test/privacy seam. `null` disables the marker but still reloads. */
  readonly storage?: StartupReloadRecoveryStorage | null;
  /** Defaults to the current browser location's reload operation. */
  readonly reload?: () => void;
}

/** Arm continuity immediately before the explicit reload. If reload is
 * unavailable or throws, retire the marker so a later ordinary load cannot
 * claim that this recovery completed. Storage denial never blocks reload. */
export const requestStartupRecoveryReload = (
  options: RequestStartupRecoveryReloadOptions = {},
): void => {
  const storage = resolveStorage(options.storage);
  let markerArmed = false;
  if (storage !== undefined) {
    try {
      storage.setItem(
        STARTUP_RELOAD_RECOVERY_SESSION_KEY,
        STARTUP_RELOAD_RECOVERY_ARMED,
      );
      markerArmed = true;
    } catch {
      /* continuity degrades to a normal reload */
    }
  }

  const browserLocation = options.reload === undefined
    ? (globalThis as { location?: Location }).location
    : undefined;
  const reload = options.reload
    ?? (browserLocation !== undefined
      ? () => browserLocation.reload()
      : undefined);
  if (reload === undefined) {
    if (markerArmed) retireMarker(storage);
    return;
  }
  try {
    reload();
  } catch (error) {
    if (markerArmed) retireMarker(storage);
    throw error;
  }
};
