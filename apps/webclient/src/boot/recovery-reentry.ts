/** Privacy-safe continuity after the final guided-recovery document is lost.
 *
 * Reauthorization normally carries its return route, draft, trusted server,
 * and reason in memory. Reloading or restoring that last tab destroys those
 * values. This module persists only one constant state in same-tab
 * `sessionStorage`: recovery was unresolved, deliberately paused, or waiting
 * for fresh-server verification when the document ended.
 * It never stores a route, server address, draft, pairing code, recovery key,
 * credential, or error detail. The current URL remains the route authority.
 *
 * Each new document consumes the state before startup work. If durable access is
 * still absent or damaged, the recovery surface arms it again. A healthy boot
 * leaves it retired, so neither reconnect framing nor a success receipt can be
 * replayed by a later ordinary reload. */

import { cleanConsumedPairEntryUrl } from './secure-access-resume.js';

export const RECOVERY_REENTRY_SESSION_KEY =
  'recued.webclient.recovery-reentry.v1';

const RECOVERY_REENTRY_ARMED = '1';
const RECOVERY_REENTRY_SAFE_STOP = '2';
const RECOVERY_REENTRY_REPLACEMENT_SERVER = '3';
const RECOVERY_REENTRY_RETIRED = '0';

/** The only meanings a consumed constant marker may carry. No value
 * includes recovery material or work context; the current URL remains the
 * sole route authority after a document boundary. */
export type RecoveryReentryState =
  | 'unresolved'
  | 'safe_stop'
  | 'replacement_server';

export type RecoveryReentryStorage = Pick<
  Storage,
  'getItem' | 'setItem' | 'removeItem'
>;

const resolveStorage = (
  storage?: RecoveryReentryStorage | null,
): RecoveryReentryStorage | undefined => {
  if (storage === null) return undefined;
  if (storage !== undefined) return storage;
  try {
    return (globalThis as { sessionStorage?: Storage }).sessionStorage;
  } catch {
    return undefined;
  }
};

/** Invalidate before deletion so a privacy mode that denies `removeItem`
 * cannot leave a replayable recovery marker behind. */
export const retireRecoveryReentry = (
  storage?: RecoveryReentryStorage | null,
): boolean => {
  const resolved = resolveStorage(storage);
  if (resolved === undefined) return false;
  try {
    resolved.setItem(
      RECOVERY_REENTRY_SESSION_KEY,
      RECOVERY_REENTRY_RETIRED,
    );
    try {
      resolved.removeItem(RECOVERY_REENTRY_SESSION_KEY);
    } catch {
      /* the already-retired value is safe to leave behind */
    }
    return true;
  } catch {
    try {
      resolved.removeItem(RECOVERY_REENTRY_SESSION_KEY);
      return true;
    } catch {
      return false;
    }
  }
};

/** Keep one constant recovery-intent value for this tab. Storage denial degrades
 * to the existing fresh-pair experience and never blocks recovery itself. */
export const armRecoveryReentry = (
  storage?: RecoveryReentryStorage | null,
): boolean => {
  const resolved = resolveStorage(storage);
  if (resolved === undefined) return false;
  try {
    resolved.setItem(RECOVERY_REENTRY_SESSION_KEY, RECOVERY_REENTRY_ARMED);
    return true;
  } catch {
    return false;
  }
};

/** Preserve that recovery deliberately stopped after the server was confirmed
 * and no usable original key was available. This is still one constant value:
 * no server, rejection count, diagnostic, route, draft, key, or code crosses
 * the document boundary. */
export const armSafeStopRecoveryReentry = (
  storage?: RecoveryReentryStorage | null,
): boolean => {
  const resolved = resolveStorage(storage);
  if (resolved === undefined) return false;
  try {
    resolved.setItem(
      RECOVERY_REENTRY_SESSION_KEY,
      RECOVERY_REENTRY_SAFE_STOP,
    );
    return true;
  } catch {
    return false;
  }
};

/** Preserve only that an administrator confirmed the old server was replaced
 * or reset and the person had begun the fresh-server verification path. The
 * current server URL, one-time code, generated key, and review choice remain
 * document-local and are intentionally lost on reload. */
export const armReplacementServerRecoveryReentry = (
  storage?: RecoveryReentryStorage | null,
): boolean => {
  const resolved = resolveStorage(storage);
  if (resolved === undefined) return false;
  try {
    resolved.setItem(
      RECOVERY_REENTRY_SESSION_KEY,
      RECOVERY_REENTRY_REPLACEMENT_SERVER,
    );
    return true;
  } catch {
    return false;
  }
};

/** Read and retire one prior-document marker. Unknown or unreadable state is
 * never enough to claim that a recovery was in progress. */
export const consumeRecoveryReentryState = (
  storage?: RecoveryReentryStorage | null,
): RecoveryReentryState | null => {
  const resolved = resolveStorage(storage);
  if (resolved === undefined) return null;
  let value: string | null = null;
  try {
    value = resolved.getItem(RECOVERY_REENTRY_SESSION_KEY);
  } catch {
    retireRecoveryReentry(resolved);
    return null;
  }
  if (value === null) return null;
  const retired = retireRecoveryReentry(resolved);
  if (!retired) return null;
  if (value === RECOVERY_REENTRY_ARMED) return 'unresolved';
  if (value === RECOVERY_REENTRY_SAFE_STOP) return 'safe_stop';
  if (value === RECOVERY_REENTRY_REPLACEMENT_SERVER) {
    return 'replacement_server';
  }
  return null;
};

/** Backward-compatible boolean consumer for integrations that only need to
 * know whether any unresolved recovery document was replaced. New startup
 * composition uses `consumeRecoveryReentryState` to retain the exact
 * credential-free checkpoint. */
export const consumeRecoveryReentry = (
  storage?: RecoveryReentryStorage | null,
): boolean => consumeRecoveryReentryState(storage) !== null;

export interface ScrubRecoveryReentryAddressOptions {
  readonly currentUrl?: () => string;
  readonly replaceUrl?: (url: string) => void;
  readonly document?: Document;
}

/** A restored recovery never trusts or replays pairing inputs from its URL.
 * Preserve every unrelated query byte, path, and hash while removing consumed
 * code/resume parameters with history replacement rather than navigation. */
export const scrubRecoveryReentryAddress = (
  options: ScrubRecoveryReentryAddressOptions = {},
): string | null => {
  try {
    const view = options.document?.defaultView
      ?? (globalThis as unknown as Window | undefined);
    const source = options.currentUrl?.() ?? view?.location?.href;
    if (typeof source !== 'string' || source.length === 0) return null;
    const cleaned = cleanConsumedPairEntryUrl(source);
    if (cleaned === source) return cleaned;
    if (options.replaceUrl !== undefined) {
      options.replaceUrl(cleaned);
      return cleaned;
    }
    view?.history?.replaceState?.(view.history.state, '', cleaned);
    return cleaned;
  } catch {
    // The caller still suppresses every pair-entry seed. Address-bar cleanup
    // is best-effort and must not turn recovery into a startup failure.
    return null;
  }
};
