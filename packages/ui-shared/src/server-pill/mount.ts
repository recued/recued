/** Phase G (D-109) — server status pill mount helper.
 *
 *  Wires the pill into a host element. The caller supplies a
 *  `getSnapshot()` (sync; reads from chrome.storage.session cache)
 *  and an `onClick` handler (usually opens Options → Server → Home).
 *  The mount subscribes to re-render events that the caller pipes in
 *  via `onUpdate` — every time the SW broadcasts a fresh heartbeat,
 *  the caller invokes the returned `update()` handle.
 *
 *  The module is framework-free (no React) — it matches the rest of
 *  the extension's vanilla-JS rendering convention. */

import type { ServerHeartbeatSnapshot } from '@recued/contracts';
import { renderServerPill, type ServerPillOptions } from './render.js';

export interface ServerPillMountOptions extends ServerPillOptions {
  /** Host element the pill is rendered into. Replaces innerHTML on
   *  every update. When the snapshot is absent, the host is cleared
   *  (hidden via the empty string). */
  host: HTMLElement;
  /** Read the latest snapshot. Called on mount + on every `update()`
   *  invocation. Return `null` when no server is paired. */
  getSnapshot: () => ServerHeartbeatSnapshot | null;
  /** Handler invoked when the pill button is clicked (clickable
   *  variants only). Receives the snapshot that was rendered at
   *  click time so callers can target server-specific routes. */
  onClick?: (snapshot: ServerHeartbeatSnapshot) => void;
  /** Override the now() source — used by tests. */
  now?: () => number;
}

export interface ServerPillHandle {
  /** Re-render the pill from the current snapshot. Safe to call
   *  repeatedly; idempotent when the snapshot hasn't changed. */
  update(): void;
  /** Remove the pill + event listeners. Idempotent. */
  dispose(): void;
}

export const mountServerPill = (
  opts: ServerPillMountOptions,
): ServerPillHandle => {
  const now = opts.now ?? (() => Date.now());
  let lastHtml = '';
  let disposed = false;

  const clickHandler = (event: Event): void => {
    if (disposed) return;
    const target = event.target as HTMLElement | null;
    if (!target) return;
    // Delegate: match the sentinel data-action on the pill root.
    const button = target.closest('[data-action="server-pill-click"]');
    if (!button) return;
    const snapshot = opts.getSnapshot();
    if (snapshot) opts.onClick?.(snapshot);
  };

  const render = (): void => {
    if (disposed) return;
    const snapshot = opts.getSnapshot();
    const html = renderServerPill(snapshot, opts, now());
    if (html === lastHtml) return;
    opts.host.innerHTML = html;
    lastHtml = html;
  };

  opts.host.addEventListener('click', clickHandler);
  render();

  return {
    update: render,
    dispose() {
      if (disposed) return;
      disposed = true;
      opts.host.removeEventListener('click', clickHandler);
      opts.host.innerHTML = '';
    },
  };
};
