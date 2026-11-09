/** "Watch this element" picker — injected content entry (brick 2).
 *
 *  esbuild bundles this (IIFE) into `build/picker/picker.js`. Brick 3's
 *  side-panel "Watch this element" action asks the SW to inject it into
 *  the active tab via `chrome.scripting.executeScript({ files })`. The
 *  script runs in the page's isolated world, starts the overlay, and
 *  reports the user's outcome back to the SW over
 *  `chrome.runtime.sendMessage` (the picker can't be returned synchronously
 *  from `executeScript` — the user takes time to hover, click + confirm).
 *
 *  Tests do NOT import this file — its top-level side effect references
 *  `document` + `chrome`. The testable logic lives in selector-engine.ts,
 *  preview.ts + picker-protocol.ts; this entry is the live binder. */

import { startPickerOverlay, type PickerOverlayHandle } from './overlay.js';
import {
  PICKER_RESULT_MESSAGE_TYPE,
  type PickerResult,
  type PickerResultMessage,
} from './picker-protocol.js';

interface ChromeRuntimeMessageBinding {
  runtime?: {
    sendMessage?(message: unknown): Promise<unknown> | void;
  };
}

/** Window-scoped singleton so a re-injection (the user clicks "Watch this
 *  element" twice) replaces the active overlay rather than stacking two. */
interface PickerWindowBinding {
  __recuedElementPickerHandle?: PickerOverlayHandle;
}

const main = (): void => {
  const win = globalThis as unknown as PickerWindowBinding;
  // Tear down any prior overlay before starting a fresh one.
  try {
    win.__recuedElementPickerHandle?.destroy();
  } catch {
    // best-effort — a stale handle from a torn-down page is harmless.
  }

  const deliver = (result: PickerResult): void => {
    win.__recuedElementPickerHandle = undefined;
    const chrome = (globalThis as { chrome?: ChromeRuntimeMessageBinding }).chrome;
    const message: PickerResultMessage = { type: PICKER_RESULT_MESSAGE_TYPE, result };
    try {
      const out = chrome?.runtime?.sendMessage?.(message);
      // Swallow a rejected promise (no receiver / SW asleep) — there is no
      // surface in the page to report it on, and the user can re-trigger.
      if (out && typeof (out as Promise<unknown>).then === 'function') {
        void (out as Promise<unknown>).catch(() => undefined);
      }
    } catch {
      // sendMessage can throw synchronously when the extension context is
      // gone (e.g. the bridge was disabled mid-pick). Nothing to do.
    }
  };

  win.__recuedElementPickerHandle = startPickerOverlay({ onResult: deliver });
};

main();
