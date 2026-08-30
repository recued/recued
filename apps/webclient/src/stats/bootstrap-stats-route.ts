/** D-250 § D7 — the `#stats` route: mount, fetch, render.
 *
 *  ⛔ DISPLAY AND HID ONLY (D-148 P12). The server computes; this reads `metric.read` and
 *  renders. There is no compute, no threshold, and no formatting decision here that the
 *  server did not already make — the panel is handed a `MetricReadOutput` and shows it.
 *
 *  ⛔⛔ THE PUBLISH ENTRY POINT WAS MISSING, AND ITS ABSENCE MADE THE DIALOG DEAD CODE.
 *  Publications are the only thing that makes the publish dialog or the erase render, and
 *  nothing could create one — so both were unreachable UI. The original call ("no button
 *  should guess a tag") was right about GUESSING and wrong in its conclusion: ask for the
 *  tag. § D4's legitimacy comes from the owner's act, and typing a tag IS that act.
 *
 *  🔑 TWO STEPS, IN § D7's ORDER: name the tag → SEE the exact bytes → confirm. A one-click
 *  publish would send a number the owner never saw, which is the thing the dialog exists to
 *  prevent.
 */

import { renderStatsPanel } from '@recued/ui-shared';
import type { MetricReadOutput, MetricSubmitSkipReason } from '@recued/contracts';

/** The route's own element, so it can be removed whole on dispose. */
export const STATS_ROUTE_HOST_ATTR = 'data-recued-stats-route';
export const STATS_ROUTE_STYLES_MARKER = 'data-recued-stats-route-styles';

/** ⛔ THESE CLASSES HAD NO STYLESHEET AT ALL. `renderStatsPanel` emits
 *  `stats-card` / `stats-record` / `stats-milestone`, and nothing anywhere
 *  styled them — so the page rendered as bare markup: the heading flush at
 *  x=0 while every other route sits in a content column, metric readings as
 *  BULLET POINTS, and value/label/meta as inline spans running together into
 *  one sentence ("128 Chat turns higher is better · v2"). Driven live before
 *  writing a line of this.
 *
 *  ⚠ Sized from the shell's tokens (`--wc-content-max`, `--wc-radius`,
 *  `--wc-gap`), not fresh literals — a surface that invents its own scale is
 *  how one app ends up with nine radii, which this session already paid to
 *  unpick once. */
export const STATS_ROUTE_STYLES = `
[${STATS_ROUTE_HOST_ATTR}] {
  max-width: var(--wc-content-max, 1080px);
  margin: 0 auto;
  padding: 16px;
  color: var(--fg);
}
[${STATS_ROUTE_HOST_ATTR}] h1 {
  margin: 0 0 4px;
  font-size: 20px;
  font-weight: 650;
}
[${STATS_ROUTE_HOST_ATTR}] h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 650;
}
[${STATS_ROUTE_HOST_ATTR}] h3 {
  margin: 22px 0 2px;
  font-size: 13px;
  font-weight: 680;
  letter-spacing: 0.02em;
}
[${STATS_ROUTE_HOST_ATTR}] .stats-panel {
  display: grid;
  gap: 6px;
}
[${STATS_ROUTE_HOST_ATTR}] .stats-asof,
[${STATS_ROUTE_HOST_ATTR}] .stats-note,
[${STATS_ROUTE_HOST_ATTR}] .publish-note,
[${STATS_ROUTE_HOST_ATTR}] .stats-empty {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
}
/* § B3.3 — what the last send did. ⚠ NOT muted like the notes around it: this is the
   answer to something the owner just did, and the previous behaviour was to say nothing
   at all. Styling it as ambient help would keep it nearly as easy to miss. */
[${STATS_ROUTE_HOST_ATTR}] .publish-submit-status {
  margin: 6px 0 0;
  font-size: 13px;
  color: var(--fg);
}
/* ⛔ TWO DIFFERENT PROBLEMS, THE SAME WEIGHT. send_failed never reached the board;
   rejected reached it and nothing was accepted. Both are states the owner has to act on,
   and the second one used to render as an unqualified success.
   ⚠ NO BACKTICKS IN THIS BLOCK — it lives inside a template literal, and one closes it. */
[${STATS_ROUTE_HOST_ATTR}] .publish-submit-status[data-recued-submit-status="send_failed"],
[${STATS_ROUTE_HOST_ATTR}] .publish-submit-status[data-recued-submit-status="rejected"] {
  color: var(--danger, #b3261e);
}
/* Every section is the SAME three-column table — what it is, the number now,
   and one sentence saying what that number means. The page previously mixed a
   card grid with two row lists, so the same kind of fact was shaped three ways
   and none of them said what it meant. */
[${STATS_ROUTE_HOST_ATTR}] .stats-table-wrap {
  margin-top: 8px;
  /* Wide content scrolls in its own box; the page body never scrolls sideways. */
  overflow-x: auto;
}
[${STATS_ROUTE_HOST_ATTR}] .stats-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  text-align: left;
}
[${STATS_ROUTE_HOST_ATTR}] .stats-table thead th {
  padding: 0 14px 6px 0;
  border-bottom: 1px solid var(--border-subtle);
  color: var(--muted);
  font-size: 10px;
  font-weight: 620;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  white-space: nowrap;
}
[${STATS_ROUTE_HOST_ATTR}] .stats-table tbody tr {
  border-bottom: 1px solid var(--border-subtle);
}
[${STATS_ROUTE_HOST_ATTR}] .stats-table tbody tr:last-child { border-bottom: 0; }
[${STATS_ROUTE_HOST_ATTR}] .stats-table th,
[${STATS_ROUTE_HOST_ATTR}] .stats-table td {
  padding: 9px 14px 9px 0;
  vertical-align: baseline;
}
[${STATS_ROUTE_HOST_ATTR}] .stats-table__name {
  font-size: 13px;
  font-weight: 650;
}
[${STATS_ROUTE_HOST_ATTR}] .stats-table__value {
  font-weight: 680;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
/* The meaning column takes the slack, so the two short columns stay tight
   against the label and the sentence wraps instead of the number. */
[${STATS_ROUTE_HOST_ATTR}] .stats-table__meaning {
  width: 100%;
  padding-right: 0;
  color: var(--muted);
  font-size: 12px;
  font-weight: 450;
  line-height: 1.5;
}
/* ⛔ THREE MILESTONE STATES, AND THEY MUST STAY DISTINGUISHABLE. "not tracked
   yet" is not a dimmer "not earned" — the panel's own comment says an
   undetectable milestone rendered like an unearned one tells the owner "you
   have not done this" when the truth is "we are not looking". In a table the
   old card borders are gone, so the state is carried by a leading rule: solid
   accent for earned, dashed for untracked, and a transparent one for pending
   so all three rows still line up. Shape, not colour alone. */
[${STATS_ROUTE_HOST_ATTR}] .stats-milestones .stats-table__name {
  border-left: 2px solid transparent;
  padding-left: 9px;
}
[${STATS_ROUTE_HOST_ATTR}] .stats-milestone--earned .stats-table__name {
  border-left-color: var(--accent);
}
[${STATS_ROUTE_HOST_ATTR}] .stats-milestone--earned .stats-milestone__status {
  color: var(--accent);
}
[${STATS_ROUTE_HOST_ATTR}] .stats-milestone--untracked .stats-table__name {
  border-left-style: dashed;
  border-left-color: var(--border);
  color: var(--muted);
  font-weight: 600;
}
[${STATS_ROUTE_HOST_ATTR}] .stats-milestone--untracked .stats-milestone__status {
  font-style: italic;
  font-weight: 550;
}
[${STATS_ROUTE_HOST_ATTR}] .stats-coverage {
  margin-top: 22px;
  padding: 10px 12px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--wc-radius, 9px);
  background: var(--surface-sunk);
}
[${STATS_ROUTE_HOST_ATTR}] .stats-coverage summary {
  cursor: pointer;
  font-size: 13px;
  font-weight: 650;
}
[${STATS_ROUTE_HOST_ATTR}] .stats-diag {
  margin-top: 8px;
  border-collapse: collapse;
  font-size: 12px;
}
[${STATS_ROUTE_HOST_ATTR}] .stats-diag th,
[${STATS_ROUTE_HOST_ATTR}] .stats-diag td {
  padding: 3px 12px 3px 0;
  text-align: left;
  font-weight: 500;
}
[${STATS_ROUTE_HOST_ATTR}] .stats-diag th { color: var(--muted); }
[${STATS_ROUTE_HOST_ATTR}] .stats-diag td { font-variant-numeric: tabular-nums; }
[${STATS_ROUTE_HOST_ATTR}] .stats-panel--error {
  padding: 12px 14px;
  border: 1px solid var(--danger, #b3261e);
  border-radius: var(--wc-radius, 9px);
  background: var(--danger-weak, #fdeceb);
}
`;

export interface BootstrapStatsRouteOptions {
  container: HTMLElement;
  read: () => Promise<MetricReadOutput>;
  /** ⛔⛔ ALL FOUR ARE REQUIRED, AND THAT IS THE REAL FIX HERE. They were optional so a
   *  test could mount with a `read` alone — and optionality is precisely what let the
   *  composition root forward `read` + `unpublish` and silently drop the rest: the
   *  handlers returned early, the surface rendered, and nothing anywhere went red.
   *  Required means forgetting one is a COMPILE error at the call site, which no test
   *  can be relied on to notice. The identical shape burned this feature twice already
   *  (`metric.read` in the registry but not `SERVER_RPC_METHODS`; `metricDeps` built and
   *  never forwarded), and both times the type system was the thing that could have said
   *  so and had been opted out of. */
  /** § C4 — revoke. */
  unpublish: (args: { tag: string }) => Promise<unknown>;
  /** § D4 — the owner's explicit opt-in. */
  publish: (args: { tag: string; metric_id: string; season_id: string }) => Promise<unknown>;
  /** § B3.3 — send the batch now.
   *  ⛔ THE RESULT IS THE POINT. This used to be `Promise<unknown>` and the route threw it
   *  away, so pressing the button produced no visible change of any kind — and with no
   *  board existing anywhere yet, `sent: false` was the guaranteed outcome. "It worked"
   *  and "it silently did nothing" rendered identically. */
  submit: () => Promise<{
    readonly sent: boolean;
    readonly skip_reason?: MetricSubmitSkipReason;
    /** ⛔ THE `kind` IS THE POINT. `ranked`, `withdrawn` and `rejected` are three
     *  different outcomes and summing them answers no question anyone has — see the
     *  classifier below. */
    readonly results?: ReadonlyArray<{
      readonly kind?: string;
      readonly reason?: string;
    }>;
  }>;
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

  // ⛔⛔ THIS ROUTE OWNS AN ELEMENT; IT DOES NOT PAINT INTO THE SHELL'S.
  //
  //  The shell's contract is `dispose()` then mount the next route, and it
  //  NEVER clears `contentRoot` — every route removes what it added. This one
  //  wrote straight into `container.innerHTML` and disposed by setting a flag
  //  and dropping a listener, so navigating away left the whole Stats page
  //  behind and the next route rendered UNDERNEATH it. Driven live: after
  //  `#stats` → `#chat`, contentRoot held the Stats heading, its note, AND the
  //  chat route's root, three children where there should be one.
  //
  //  ⚠ Owning a root also stops a repaint clobbering a sibling: `innerHTML` on
  //  the shared container would erase anything another surface had mounted
  //  there, which is a different bug waiting for the first surface that does.
  // ⚠ Injected once, keyed by a marker — a second mount must not stack a
  // second copy of the sheet.
  const doc = opts.container.ownerDocument ?? globalThis.document;
  if (doc?.head?.querySelector?.(`style[${STATS_ROUTE_STYLES_MARKER}]`) == null) {
    const style = doc?.createElement?.('style');
    if (style !== undefined && style !== null) {
      style.setAttribute(STATS_ROUTE_STYLES_MARKER, '');
      style.textContent = STATS_ROUTE_STYLES;
      doc?.head?.appendChild?.(style);
    }
  }
  const root = opts.container.ownerDocument?.createElement('div')
    ?? globalThis.document.createElement('div');
  root.setAttribute(STATS_ROUTE_HOST_ATTR, '');
  opts.container.appendChild(root);

  let pending: { metric_id: string; tag: string; season_id: string } | undefined;
  let submitOutcome:
    | {
        sent: true; ranked: number; withdrawn: number; rejected: number;
        rejectedReasons: readonly string[];
      }
    | { sent: false; reason: MetricSubmitSkipReason }
    | undefined;

/** ⛔⛔ A REJECTION IS AN ANSWER, AND THE ROUTE USED TO COUNT IT AS A SUCCESS. It read
 *  `results.length` and the panel said "N boards answered", so a batch whose every entry
 *  came back `unknown_board` rendered as an unqualified success. Once boards exist that
 *  is the ORDINARY failure — a local fork, a retired season — so the reassuring version
 *  would have been the common case.
 *  ⚠ AN UNRECOGNISED `kind` COUNTS AS REJECTED, NOT AS RANKED. A future kind this build
 *  does not know must not be reported to the owner as a score that landed. */
  const classify = (
    results: ReadonlyArray<{ readonly kind?: string; readonly reason?: string }>,
  ) => {
    let ranked = 0;
    let withdrawn = 0;
    let rejected = 0;
    const reasons = new Set<string>();
    for (const r of results) {
      if (r.kind === 'ranked') { ranked += 1; continue; }
      if (r.kind === 'withdrawn') { withdrawn += 1; continue; }
      rejected += 1;
      if (typeof r.reason === 'string' && r.reason.length > 0) reasons.add(r.reason);
    }
    return { ranked, withdrawn, rejected, rejectedReasons: [...reasons] };
  };

  const paint = (inner: string): void => {
    if (disposed) return;
    root.innerHTML = `
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
      paint(renderStatsPanel({
        data,
        now: now(),
        ...(pending !== undefined ? { pendingPublish: pending } : {}),
        ...(submitOutcome !== undefined ? { submitOutcome } : {}),
      }));
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
    const stop = target?.closest?.('[data-recued-publish-stop-action]');
    const stopTag = stop?.getAttribute('data-tag');
    if (stopTag !== null && stopTag !== undefined) {
      void opts.unpublish({ tag: stopTag }).then(refresh, refresh);
      return;
    }

    // Step 1 — read what the owner typed and open the preview. ⚠ NOTHING IS SENT HERE.
    const preview = target?.closest?.('[data-recued-publish-preview-action]');
    const previewMetric = preview?.getAttribute('data-metric');
    if (previewMetric !== null && previewMetric !== undefined) {
      const form = (opts.container as unknown as {
        querySelector?: (s: string) => {
          querySelector?: (s: string) => { value?: string } | null;
        } | null;
      }).querySelector?.(`[data-recued-publish-start="${previewMetric}"]`);
      const tag = form?.querySelector?.('[data-recued-publish-tag]')?.value ?? '';
      const season_id = form?.querySelector?.('[data-recued-publish-season]')?.value ?? '';
      // ⛔ AN EMPTY TAG OPENS NOTHING. Previewing a payload addressed to '' would show the
      // owner bytes that could never be sent, and the rpc refuses it anyway.
      if (tag.length === 0 || season_id.length === 0) return;
      pending = { metric_id: previewMetric, tag, season_id };
      void refresh();
      return;
    }

    // Step 2 — the owner saw the bytes and confirmed.
    const confirm = target?.closest?.('[data-recued-publish-confirm-action]');
    const cMetric = confirm?.getAttribute('data-metric');
    if (cMetric !== null && cMetric !== undefined) {
      const tag = confirm?.getAttribute('data-tag') ?? '';
      const season_id = confirm?.getAttribute('data-season') ?? '';
      pending = undefined;
      void opts.publish({ tag, metric_id: cMetric, season_id }).then(refresh, refresh);
      return;
    }

    if (target?.closest?.('[data-recued-publish-cancel-action]') != null) {
      pending = undefined;
      void refresh();
      return;
    }

    if (target?.closest?.('[data-recued-submit-action]') != null) {
      void opts.submit().then(
        (res) => {
          // ⛔ A MISSING `skip_reason` ON A NOT-SENT RESULT IS TREATED AS A SEND FAILURE,
          // not dropped. It can only come from a server older than the field, and the
          // honest reading of "it did not send and will not say why" is the recoverable
          // fault — never silence, which is the defect this replaces.
          submitOutcome = res.sent
            ? { sent: true, ...classify(res.results ?? []) }
            : { sent: false, reason: res.skip_reason ?? 'send_failed' };
          return refresh();
        },
        () => {
          // The rpc itself rejected — the socket, not the board.
          submitOutcome = { sent: false, reason: 'send_failed' };
          return refresh();
        },
      );
    }
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
      // ⛔ THE HALF THAT WAS MISSING. Dropping the listener without removing
      // the markup left the page on screen under its successor.
      root.remove?.();
    },
  };
};
