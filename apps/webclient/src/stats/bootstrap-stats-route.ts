/** D-250 § D7 — the `#stats` route: mount, fetch, render.
 *
 *  ⛔ DISPLAY AND HID ONLY (D-148 P12). The server computes; this reads `metric.read` and
 *  renders. There is no compute, no threshold, and no formatting decision here that the
 *  server did not already make — the panel is handed a `MetricReadOutput` and shows it.
 *
 *  ✅ THE ERASE IS WIRED (§ C4 / § D7's "PROMINENT action"). ⛔ THE PUBLISH IS NOT, and
 *  that asymmetry is deliberate rather than half-finished: leaving a board must always be
 *  one click, while JOINING one starts from choosing a tag — an owner gesture § D4 says
 *  the legitimacy comes from. A button that published to a guessed tag would be exactly
 *  the "legitimacy from which bus it rides" that § D4 rules out.
 */

import { renderStatsPanel } from '@recued/ui-shared';
import type { MetricReadOutput } from '@recued/contracts';

export interface BootstrapStatsRouteOptions {
  container: HTMLElement;
  read: () => Promise<MetricReadOutput>;
  /** § C4 — revoke. Absent means the surface renders read-only, which is what an older
   *  server without the method looks like. */
  unpublish?: (args: { tag: string }) => Promise<unknown>;
  now?: () => number;
}

export interface StatsRoute {
  /** Re-fetch and re-render. Exposed so a server switch can refresh in place. */
  refresh: () => Promise<void>;
  dispose: () => void;
}

export const bootstrapStatsRoute = (opts: BootstrapStatsRouteOptions): StatsRoute => {
  const now = opts.now ?? (() => Date.now());
  let disposed = false;

  const paint = (inner: string): void => {
    if (disposed) return;
    opts.container.innerHTML = `
      <h1 data-recued-stats-route-heading tabindex="-1">Stats</h1>
      ${inner}`;
  };

  const refresh = async (): Promise<void> => {
    // ⛔⛔ A FAILED READ IS NOT AN EMPTY SURFACE. Rendering the "nothing measured yet"
    // panel on an rpc error would tell an owner with months of history that their server
    // has none — the same absent-versus-zero confusion the panel itself is built to
    // avoid, one layer up.
    try {
      const data = await opts.read();
      paint(renderStatsPanel({ data, now: now() }));
    } catch (err) {
      // ⚠ NO `if (disposed) return` HERE — `paint` already holds the only guard, and a
      // second copy is a mutation-equivalent no-op: it reads as protection while
      // protecting nothing. Proved by mutation — removing it reddens nothing, removing
      // paint's reddens the dispose test.
      const message = err instanceof Error ? err.message : String(err);
      paint(`
        <section class="stats-panel stats-panel--error" data-recued-stats-error>
          <p>Could not read your stats from this server.</p>
          <p class="stats-note">${message.replace(/[&<>"']/g, '')}</p>
        </section>`);
    }
  };

  // ⛔⛔ PAINT SYNCHRONOUSLY BEFORE THE READ. Two reasons, and the second is why a test
  // could not see this route at all: a user gets the heading immediately instead of a
  // blank pane while the rpc is in flight, AND the mount becomes observable even when
  // the read never settles — which is exactly the state a fixture with no live server
  // is in. Waiting for the promise meant "mounted" and "hung" looked identical.
  paint('<p class="stats-note" data-recued-stats-loading>Reading your stats…</p>');
  // ⛔ DELEGATED, NOT PER-BUTTON. Every repaint replaces the markup, so a listener bound
  // to a button would die on the first refresh — and the erase would silently stop
  // working exactly when the owner used it, since the first click repaints.
  const onClick = (ev: Event): void => {
    const target = ev.target as { closest?: (s: string) => { getAttribute(a: string): string | null } | null };
    const btn = target?.closest?.('[data-recued-publish-stop-action]');
    const tag = btn?.getAttribute('data-tag');
    if (tag === null || tag === undefined || opts.unpublish === undefined) return;
    void opts.unpublish({ tag }).then(refresh, refresh);
  };
  (opts.container as unknown as { addEventListener?: (t: string, h: (e: Event) => void) => void })
    .addEventListener?.('click', onClick);

  void refresh();

  return {
    refresh,
    dispose: () => {
      disposed = true;
      (opts.container as unknown as {
        removeEventListener?: (t: string, h: (e: Event) => void) => void;
      }).removeEventListener?.('click', onClick);
    },
  };
};
