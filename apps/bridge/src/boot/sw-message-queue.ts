/** D-169 P1.5 follow-on — cold-start `chrome.runtime.onMessage` shim
 *  extracted from `service-worker-entry.ts` so the four HIGH ratchets
 *  (#3 / #4 / #6 / #10) it embodies become unit-testable without
 *  chrome-stub-aware module load.
 *
 *  The original inline shim solved a real MV3 cold-start race: a
 *  `chrome.runtime.sendMessage` from the side panel wakes a suspended
 *  service worker, but the SW's listeners are only registered AFTER
 *  the async boot (`openBridgeIdb` + the deferred
 *  `bootBridgeServiceWorker` call). If a side-panel
 *  `recued.bridge.pair` message arrives during that window, the
 *  bootstrap's listener doesn't exist yet → Chrome falls back to "no
 *  listener" → `sendMessage` rejects with channel-closed → the panel
 *  reports a failure for a pairing that never started.
 *
 *  This factory takes a `ChromeRuntimeOnMessageApi` adapter (optional
 *  so a non-SW host without `chrome` still composes), installs a
 *  synchronous shim listener at construction, and returns a handle
 *  exposing:
 *
 *    - `proxy` — the `ChromeRuntimeOnMessageApi`-shaped surface the
 *      bootstrap consumes. The bootstrap's
 *      `chromeRuntimeOnMessage.addListener(...)` call records its
 *      branching handler against this proxy without triggering a
 *      drain (HIGH #4); the entry calls
 *      `proxy.drainQueuedMessages()` after `bootBridgeServiceWorker`
 *      resolves so the handle's collaborators (`rpcConnForSidePanel`
 *      etc.) are fully wired when queued messages dispatch.
 *
 *    - `failQueuedAfterBootRejection(err)` — flushes the queue with
 *      structured failure responses when the SW boot itself rejects
 *      (HIGH #10): every queued kind gets `bridge_boot_failed`.
 *
 *  The factory is pure — every piece of mutable state lives inside the
 *  closure. Tests instantiate one queue per case with a fake
 *  `addListener` adapter that captures the shim callback for
 *  synchronous dispatch.
 *
 *  Invariants:
 *   - HIGH #3 — messages arriving before `drainQueuedMessages()` are
 *     queued; the shim returns `true` from the chrome listener so the
 *     message port stays open until the bootstrap responds.
 *   - HIGH #4 — `proxy.addListener` only records the handler; it does
 *     NOT drain. Drain happens on the explicit
 *     `drainQueuedMessages()` call so the bootstrap's collaborators
 *     are observable when queued messages dispatch.
 *   - HIGH #6 — the gate is the explicit `bootReady` boolean, not the
 *     presence of a handler. The bootstrap's listener registration
 *     happens before the rest of its wiring completes, so a handler-
 *     count gate would let some cold-start messages dispatch too
 *     eagerly.
 *   - HIGH #10 — `failQueuedAfterBootRejection` walks the same queue
 *     so a queued pairing gets a typed failure response instead of a
 *     Chrome channel-closed timeout.
 */

import type { ChromeRuntimeOnMessageApi } from './service-worker-bootstrap.js';

/** chrome.runtime.onMessage handler signature — mirrors the chrome API
 *  contract and matches what the bootstrap's branching handler
 *  returns. `true` keeps the message port open for an async
 *  `sendResponse`; `undefined`/`false` lets Chrome continue dispatch
 *  to other listeners. */
type SwOnMessageHandler = (
  message: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => boolean | undefined;

interface QueuedSwMessage {
  message: unknown;
  sender: unknown;
  sendResponse: (response: unknown) => void;
}

/** Bootstrap-facing proxy. Extends `ChromeRuntimeOnMessageApi` so it
 *  drops in as the `chromeRuntimeOnMessage` dep without a wrapper, and
 *  adds the `drainQueuedMessages` knob the entry uses post-boot. */
export interface SwOnMessageProxy extends ChromeRuntimeOnMessageApi {
  drainQueuedMessages(): void;
}

export interface SwMessageQueueHandle {
  /** Drop-in `chromeRuntimeOnMessage` dep for the bootstrap. */
  proxy: SwOnMessageProxy;
  /** Flush every queued message with a structured failure response.
   *  Invoke from the entry's `bridgeServiceWorkerMain().catch(...)`
   *  arm when the SW boot itself rejects. Subsequent calls are
   *  idempotent — the queue is drained at most once across the pair. */
  failQueuedAfterBootRejection(err: unknown): void;
}

export interface CreateSwMessageQueueDeps {
  /** chrome.runtime.onMessage. Optional: when absent (non-SW host /
   *  test that imports the entry by mistake), the factory still
   *  returns a working proxy + flush, just with no shim listener
   *  registered against chrome. */
  chromeRuntimeOnMessage?: ChromeRuntimeOnMessageApi;
}

export const createSwMessageQueue = (
  deps: CreateSwMessageQueueDeps,
): SwMessageQueueHandle => {
  const handlers: SwOnMessageHandler[] = [];
  const queue: QueuedSwMessage[] = [];
  /** HIGH #6 — the bootstrap registers its handler BEFORE wiring the
   *  paired-path collaborators. Gating dispatch on handler presence
   *  would let a cold-start `side-panel.fetch-status` reach a null
   *  `rpcConnForSidePanel`. Gate on the explicit boot-ready boolean
   *  instead; it flips inside `drainQueuedMessages` which the entry
   *  calls AFTER `bootBridgeServiceWorker` resolves. */
  let bootReady = false;
  /** Codex 2026-05-28 ANGLE 7 MAJOR fold (this extraction) —
   *  post-rejection terminal state. Once `failQueuedAfterBootRejection`
   *  runs, every subsequent cold-start arrival must respond
   *  synchronously with the same structured failure shape; otherwise
   *  the listener's `return true` keeps Chrome's message port open
   *  forever (no further drain is scheduled — the boot path is one-
   *  shot). The original inline shim shared this gap; closing it as
   *  part of the extraction. */
  let bootFailed = false;
  let bootFailureDetail: string | null = null;

  const dispatchToHandlers = (q: QueuedSwMessage): boolean => {
    let asyncResponse = false;
    for (const h of handlers) {
      try {
        const ret = h(q.message, q.sender, q.sendResponse);
        if (ret === true) asyncResponse = true;
      } catch {
        /* listener errors isolated — same posture as the bootstrap */
      }
    }
    return asyncResponse;
  };

  const respondWithFailure = (q: QueuedSwMessage, detail: string): void => {
    try {
      // One shape for every queued kind. The entry's catch arm calls this
      // after the boot promise rejects, so the caller gets something to
      // render instead of a Chrome channel-closed timeout. The side panel's
      // pairing client reads it as "the background service didn't
      // respond" — and a pairing queued here never reached `/auth/pair`,
      // so its code is still good.
      q.sendResponse({ ok: false, error: 'bridge_boot_failed', detail });
    } catch {
      /* sender-side dispatch errors are not our concern at boot-failure */
    }
  };

  if (deps.chromeRuntimeOnMessage) {
    deps.chromeRuntimeOnMessage.addListener(
      (message, sender, sendResponse) => {
        const q = { message, sender, sendResponse };
        if (bootFailed) {
          // Post-rejection arrival. Respond immediately with the
          // structured failure shape rather than queuing — no drain
          // will run for this message, so queuing it would leak the
          // sendResponse callback + leave the port open until
          // Chrome's internal timeout.
          respondWithFailure(q, bootFailureDetail ?? 'bridge boot failed');
          return false;
        }
        if (!bootReady) {
          queue.push(q);
          // HIGH #3 — keep Chrome's message port open until the
          // bootstrap drains. Returning `true` is the chrome.runtime
          // contract for "I'll call sendResponse later".
          return true;
        }
        return dispatchToHandlers(q);
      },
    );
  }

  const proxy: SwOnMessageProxy = {
    addListener(handler) {
      handlers.push(handler);
    },
    drainQueuedMessages() {
      if (bootFailed) {
        // Defensive no-op — boot already failed + queue already
        // drained with failure responses. Flipping `bootReady` here
        // would let a post-failure arrival dispatch to handlers that
        // never finished wiring.
        return;
      }
      bootReady = true;
      while (queue.length > 0) {
        const q = queue.shift()!;
        dispatchToHandlers(q);
      }
    },
  };

  const failQueuedAfterBootRejection = (err: unknown): void => {
    if (bootReady) {
      // Defensive — boot already resolved + drained. Nothing to fail.
      return;
    }
    if (bootFailed) {
      // Idempotent — a second call (e.g. from a stale catch arm or a
      // doubly-attached rejection handler) must not overwrite the
      // terminal `bootFailureDetail` string captured at the first
      // failure. The post-rejection listener arm already uses that
      // captured detail for any cold-start arrival.
      return;
    }
    const detail = err instanceof Error ? err.message : String(err);
    bootFailed = true;
    bootFailureDetail = detail;
    while (queue.length > 0) {
      const q = queue.shift()!;
      respondWithFailure(q, detail);
    }
  };

  return { proxy, failQueuedAfterBootRejection };
};
