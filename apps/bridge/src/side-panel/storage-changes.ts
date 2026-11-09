/** Changes to `chrome.storage.local`, for the side panel.
 *
 *  ⛔ TWO EVENTS, TWO SIGNATURES. The area-level
 *  `chrome.storage.local.onChanged` passes only `changes`; the area name is
 *  an argument of the global `chrome.storage.onChanged` alone. The panel
 *  subscribed to the area-level event and then dropped every change whose
 *  `areaName` was not `'local'` — which was every change, since that
 *  argument is never passed there. So the panel never saw a pair finish
 *  while it was open; in 0.0.1 an extension reload after each pair hid it.
 *  Found 2026-10-10 by pairing from the open panel in Chromium. */

export type StorageChanges = Record<string, { newValue?: unknown; oldValue?: unknown }>;

export interface StorageChangeEvents {
  /** `chrome.storage.local.onChanged` — changes only. */
  local: {
    onChanged?: { addListener(handler: (changes: StorageChanges) => void): void };
  };
  /** `chrome.storage.onChanged` — changes, then the area name. */
  onChanged?: {
    addListener(handler: (changes: StorageChanges, areaName: string) => void): void;
  };
}

/** Calls `handler` with each change set to `chrome.storage.local`. Returns
 *  false when neither event exists. */
export const onLocalStorageChanged = (
  storage: StorageChangeEvents,
  handler: (changes: StorageChanges) => void,
): boolean => {
  if (storage.local.onChanged) {
    storage.local.onChanged.addListener((changes) => handler(changes));
    return true;
  }
  if (storage.onChanged) {
    storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local') handler(changes);
    });
    return true;
  }
  return false;
};
