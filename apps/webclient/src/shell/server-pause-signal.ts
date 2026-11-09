/** D-188 — the server's pause as the heartbeat reports it, for the surfaces whose content
 *  depends on it. An approval the pause holds back reads so (`ServerPendingAsk.paused`,
 *  decided by the server when it lists the asks), so a list showing approvals reads its asks
 *  again when the pause turns on or off — from this browser or any other, within one
 *  heartbeat (5 s).
 *
 *  Only a CHANGE is announced: the first report is what the lists already read when they
 *  loaded, so it re-reads nothing. */

type PauseListener = (paused: boolean) => void;

let current: boolean | undefined;
const listeners = new Set<PauseListener>();

/** Fed by the heartbeat. Announces a change to every listener. */
export const noteServerPaused = (paused: boolean | undefined): void => {
  if (paused === undefined || paused === current) return;
  const changed = current !== undefined;
  current = paused;
  if (!changed) return;
  for (const listener of [...listeners]) {
    try {
      listener(paused);
    } catch {
      // One surface's failure must not keep the others stale.
    }
  }
};

/** The pause as the heartbeat last reported it; false before the first report. The chat's
 *  queue reads it to say a message waits for Resume (D-188, the lockdown). */
export const isServerPausedNow = (): boolean => current === true;

/** Listen for the pause turning on or off; returns the unsubscribe. */
export const onServerPauseChange = (listener: PauseListener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Test seam: forget the last report and every listener. */
export const __resetServerPauseSignal = (): void => {
  current = undefined;
  listeners.clear();
};
