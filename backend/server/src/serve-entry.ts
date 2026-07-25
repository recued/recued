/** Foreground serve composition for the production router.
 *
 * Heavy server/runtime imports are intentionally inside serve() so importing
 * this module alone cannot open SQLite, bind listeners, start schedulers,
 * print the boot banner, or install signal handlers.
 */

import { composeBaseContext } from "./serve/compose-base-context.js";
import { SERVER_VERSION } from "./server-version.js";

export async function serve(inputArgs: string[]): Promise<void> {
const {
  setRole,
} = await import("@recued/contracts");
setRole('server');

// ────────────────────────────────────────────────────────────────
// Base parse/config context
// ────────────────────────────────────────────────────────────────

const baseContext = composeBaseContext(inputArgs);
const { bootTrace } = baseContext;

// Server version (surfaces on `ServerStatus` rpc + the boot banner + the archive
// restore `min_consumer_version` check) — resolved once in `./server-version`.

let cleanup = (): void => {};

// ────────────────────────────────────────────────────────────────
// Dispatch
// ────────────────────────────────────────────────────────────────

const dispatch = async (): Promise<void> => {
  bootTrace.mark('dispatch-start');
  const { startPostBaseStorageVaultRuntime } =
    await import("./serve/start-post-storage-app-collection-execution-runtime.js");
  await startPostBaseStorageVaultRuntime({
    base: baseContext,
    serverVersion: SERVER_VERSION,
    env: process.env,
    publishDbCleanup: (nextCleanup) => {
      cleanup = nextCleanup;
    },
  });
};

try {
  await dispatch();
  bootTrace.finish('dispatch-complete');
} catch (e) {
  bootTrace.finish('dispatch-error', e instanceof Error ? e.message : String(e));
  cleanup();
  throw e;
}
}
