/** The owner's Re-sync on a mailbox or calendar restarts its collection, and a
 *  restart only STARTS the read: the call used to answer before anything was
 *  read, so the page it reloads showed the read before (live, 2026-10-23: Gmail's
 *  "Last mailbox read" stood still on every press). It answers once the restarted
 *  collection has caught up (`caughtUp`), or once this wait runs out.
 *
 *  The webclient gives the call 60 s, and stopping the old sync takes part of it. */
export const RESYNC_WAIT_MS = 20_000;

/** Waits for `caughtUp` at most `ms`. */
export const awaitCaughtUp = async (caughtUp: Promise<void> | undefined, ms: number): Promise<void> => {
  if (caughtUp === undefined) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      caughtUp.catch(() => undefined),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
