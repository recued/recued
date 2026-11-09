/** `onLocalStorageChanged` — the side panel's view of `chrome.storage.local`
 *  changes, over the two Chrome events and their two signatures.
 *
 *  The fakes call each listener exactly as Chrome does: the area-level
 *  `chrome.storage.local.onChanged` with `(changes)` ONLY, the global
 *  `chrome.storage.onChanged` with `(changes, areaName)`. The panel once
 *  filtered the area-level event on an `areaName` it is never given, and so
 *  never saw a pair finish while it was open. */

import { describe, expect, it, vi } from 'vitest';

import { onLocalStorageChanged, type StorageChanges } from '../storage-changes.js';

const TOKEN_WRITTEN: StorageChanges = { webclient_token: { newValue: { token_id: 't' } } };

/** `chrome.storage.local.onChanged`: Chrome passes the changes and nothing else. */
const areaEvent = () => {
  const listeners: Array<(changes: StorageChanges) => void> = [];
  return {
    addListener: (h: (changes: StorageChanges) => void) => listeners.push(h),
    fire: (changes: StorageChanges) => {
      for (const h of listeners) (h as (...args: unknown[]) => void)(changes);
    },
    count: () => listeners.length,
  };
};

/** `chrome.storage.onChanged`: Chrome passes the changes, then the area. */
const globalEvent = () => {
  const listeners: Array<(changes: StorageChanges, areaName: string) => void> = [];
  return {
    addListener: (h: (changes: StorageChanges, areaName: string) => void) => listeners.push(h),
    fire: (changes: StorageChanges, areaName: string) => {
      for (const h of listeners) h(changes, areaName);
    },
    count: () => listeners.length,
  };
};

describe('onLocalStorageChanged', () => {
  it('passes on every change from chrome.storage.local.onChanged, which names no area', () => {
    const local = areaEvent();
    const handler = vi.fn();
    expect(onLocalStorageChanged({ local: { onChanged: local } }, handler)).toBe(true);
    local.fire(TOKEN_WRITTEN);
    expect(handler).toHaveBeenCalledWith(TOKEN_WRITTEN);
  });

  it('prefers the area-level event, so a change is not handled twice', () => {
    const local = areaEvent();
    const global = globalEvent();
    onLocalStorageChanged({ local: { onChanged: local }, onChanged: global }, vi.fn());
    expect(local.count()).toBe(1);
    expect(global.count()).toBe(0);
  });

  it('falls back to chrome.storage.onChanged, keeping only the local area', () => {
    const global = globalEvent();
    const handler = vi.fn();
    expect(onLocalStorageChanged({ local: {}, onChanged: global }, handler)).toBe(true);
    global.fire(TOKEN_WRITTEN, 'session');
    global.fire(TOKEN_WRITTEN, 'sync');
    expect(handler).not.toHaveBeenCalled();
    global.fire(TOKEN_WRITTEN, 'local');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('says so when there is nothing to listen to', () => {
    expect(onLocalStorageChanged({ local: {} }, vi.fn())).toBe(false);
  });
});
