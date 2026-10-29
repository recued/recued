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
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

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
[${STATS_ROUTE_HOST_ATTR}] button, [${STATS_ROUTE_HOST_ATTR}] input {
  min-height: 44px; max-width: 100%; box-sizing: border-box; font: inherit;
}
[${STATS_ROUTE_HOST_ATTR}] button {
  padding: 8px 12px; border: 1px solid var(--border); border-radius: var(--wc-radius, 9px);
  color: var(--fg); background: var(--surface); cursor: pointer;
}
[${STATS_ROUTE_HOST_ATTR}] button[aria-disabled="true"] { opacity: .6; cursor: default; }
[${STATS_ROUTE_HOST_ATTR}] :focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
[${STATS_ROUTE_HOST_ATTR}] input { padding: 8px; min-width: 0; border: 1px solid var(--border); border-radius: 6px; color: var(--fg); background: var(--bg); }
[${STATS_ROUTE_HOST_ATTR}] .publish-start { display: flex; flex-wrap: wrap; align-items: end; gap: 10px; margin: 10px 0; }
[${STATS_ROUTE_HOST_ATTR}] .publish-start label { display: grid; gap: 4px; flex: 1 1 160px; min-width: 0; }
[${STATS_ROUTE_HOST_ATTR}] .publish-start input { width: 100%; }
[${STATS_ROUTE_HOST_ATTR}] .publish-confirm { margin-top: 12px; }
[${STATS_ROUTE_HOST_ATTR}] .publish-confirm > button { margin: 4px 8px 4px 0; }
[${STATS_ROUTE_HOST_ATTR}] .publish-payload { max-width: 100%; white-space: pre-wrap; overflow-wrap: anywhere; }
[${STATS_ROUTE_HOST_ATTR}] .publish-meta td { overflow-wrap: anywhere; }
[${STATS_ROUTE_HOST_ATTR}] [data-recued-stats-feedback] { margin: 10px 0; overflow-wrap: anywhere; }
[${STATS_ROUTE_HOST_ATTR}] [data-recued-stats-feedback] p { margin: 6px 0; }
[${STATS_ROUTE_HOST_ATTR}] [data-recued-stats-action-error] { color: var(--danger); }

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
/* ⛔ TWO DIFFERENT PROBLEMS, THE SAME WEIGHT. send_failed could not confirm delivery;
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
/* ⛔ break-word, NOT the inherited anywhere. The content root sets
   overflow-wrap: anywhere, which counts ANY letter as a break point when the
   table sizes its columns, so the meaning column's width: 100% took all but
   one letter of this one: the column fell to its header's 55px and
   "Autopilot" rendered as "Autopilo / t" (6 of 20 names, measured at 1440px
   and 390px). break-word still breaks a word that cannot fit a line at all,
   but sizes the column by whole words. */
[${STATS_ROUTE_HOST_ATTR}] .stats-table__name {
  font-size: 13px;
  font-weight: 650;
  overflow-wrap: break-word;
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

  type PublishChoice = { metric_id: string; tag: string; season_id: string };
  type Operation = { kind: 'publish'; choice: PublishChoice } | { kind: 'stop'; tag: string } | { kind: 'submit' };
  let pending: PublishChoice | undefined;
  const drafts = new Map<string, { tag: string; season_id: string }>();
  let data: MetricReadOutput | undefined;
  let readGeneration = 0;
  let reading = false;
  let readError: string | undefined;
  let actionError: string | undefined;
  let actionStatus: string | undefined;
  let operation: Operation | undefined;
  let uncertain: Operation | undefined;
  let needsCheck = false;
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

  const escape = (value: string): string => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  const fieldDraft = (form: Element): { tag: string; season_id: string } => ({
    tag: form.querySelector<HTMLInputElement>('[data-recued-publish-tag]')?.value ?? '',
    season_id: form.querySelector<HTMLInputElement>('[data-recued-publish-season]')?.value ?? '1',
  });
  const captureDrafts = (): void => {
    for (const form of Array.from(root.querySelectorAll?.<HTMLElement>('[data-recued-publish-start]') ?? [])) {
      const metric = form.getAttribute('data-recued-publish-start');
      if (metric !== null) drafts.set(metric, fieldDraft(form));
    }
  };
  // Keep unchanged forms and their ancestry connected. Detaching a text field,
  // even temporarily, discards native Undo/Redo and an active composition.
  const paintMarkup = (html: string): void => {
    const current = root.querySelector?.<HTMLElement>('.stats-panel');
    if (!current) { root.innerHTML = html; return; }
    const next = doc.createElement('div'); next.innerHTML = html;
    const panel = next.querySelector?.<HTMLElement>('.stats-panel');
    if (!panel) { root.innerHTML = html; return; }
    const forms = Array.from(current.querySelectorAll<HTMLElement>('[data-recued-publish-start]'));
    const kept = new Map<Node, Node>();
    for (const form of Array.from(panel.querySelectorAll<HTMLElement>('[data-recued-publish-start]'))) {
      const old = forms.find(candidate => candidate.getAttribute('data-recued-publish-start') === form.getAttribute('data-recued-publish-start'));
      if (old && old.parentElement === current && form.parentElement === panel && old.textContent === form.textContent) {
        const before = fieldDraft(old), after = fieldDraft(form);
        if (before.tag === after.tag && before.season_id === after.season_id) kept.set(form, old);
      }
    }
    const anchors = Array.from(current.childNodes).filter(node => [...kept.values()].includes(node));
    const wanted = Array.from(panel.childNodes).flatMap(node => kept.has(node) ? [kept.get(node)!] : []);
    if (anchors.some((node, index) => node !== wanted[index])) { root.innerHTML = html; return; }
    const replaceAround = (host: HTMLElement, fresh: HTMLElement, keep: Map<Node, Node>): void => {
      const held = Array.from(host.childNodes).filter(node => [...keep.values()].includes(node));
      for (const child of Array.from(host.childNodes)) if (!held.includes(child)) host.removeChild(child);
      let index = 0;
      for (const child of Array.from(fresh.childNodes)) {
        if (keep.has(child)) index++;
        else host.insertBefore(child, held[index] ?? null);
      }
    };
    replaceAround(current, panel, kept);
    replaceAround(root, next, new Map([[panel, current]]));
  };
  const mutationAttrs = ['data-recued-publish-confirm-action', 'data-recued-publish-stop-action', 'data-recued-submit-action'] as const;
  const controlAttrs = [...mutationAttrs, 'data-recued-publish-preview-action', 'data-recued-publish-cancel-action', 'data-recued-stats-retry'] as const;
  const paint = (): void => {
    if (disposed) return;
    captureDrafts();
    const active = doc.activeElement as HTMLInputElement | null;
    const held = active && root.contains?.(active) === true ? active : null;
    const formId = held?.closest?.('[data-recued-publish-start]')?.getAttribute('data-recued-publish-start');
    const field = held?.hasAttribute('data-recued-publish-tag') ? 'tag' : held?.hasAttribute('data-recued-publish-season') ? 'season' : null;
    const selection = field ? [held?.selectionStart, held?.selectionEnd, held?.selectionDirection] as const : null;
    const attr = controlAttrs.find(key => held?.hasAttribute(key));
    const metric = held?.getAttribute('data-metric'), tag = held?.getAttribute('data-tag');
    const busyText = operation?.kind === 'publish' ? `Enabling publishing for #${operation.choice.tag}…`
      : operation?.kind === 'stop' ? `Stopping publishing to #${operation.tag}…` : operation ? 'Sending today’s scores…' : null;
    const stale = readError && data !== undefined ? '<p class="stats-note" data-recued-stats-stale>Showing your last loaded stats. Refresh failed; publishing controls wait for a successful read.</p>' : '';
    const feedback = `<div data-recued-stats-feedback>
      ${busyText ? `<p role="status">${escape(busyText)}</p>` : ''}
      ${actionStatus ? `<p role="status">${escape(actionStatus)}</p>` : ''}
      ${actionError ? `<p role="alert" data-recued-stats-action-error>${escape(actionError)}</p>` : ''}
      ${readError ? `<section class="stats-panel--error" data-recued-stats-error role="alert"><p>Could not read your stats from this server.</p><p class="stats-note">${escape(readError)}</p>${stale}</section>` : ''}
      ${readError || actionError || needsCheck ? `<button type="button" data-recued-stats-retry aria-label="Retry reading stats">${reading ? 'Retrying…' : 'Retry reading stats'}</button>` : ''}
    </div>`;
    const body = data === undefined
      ? reading ? '<p class="stats-note" data-recued-stats-loading>Reading your stats…</p>' : ''
      : renderStatsPanel({ data, now: now(), publishDrafts: Object.fromEntries(drafts),
        ...(pending !== undefined ? { pendingPublish: pending } : {}),
        ...(submitOutcome !== undefined ? { submitOutcome } : {}) });
    paintMarkup(`<h1 data-recued-stats-route-heading tabindex="-1">Stats</h1>${feedback}${body}`);
    root.setAttribute('aria-busy', String(reading || operation !== undefined));
    for (const button of Array.from(root.querySelectorAll?.<HTMLButtonElement>('button') ?? [])) {
      const mutation = mutationAttrs.some(key => button.hasAttribute(key));
      const retry = button.hasAttribute('data-recued-stats-retry');
      const cancel = button.hasAttribute('data-recued-publish-cancel-action');
      const needsFreshData = mutation || button.hasAttribute('data-recued-publish-preview-action');
      const blocked = operation !== undefined || (retry ? reading : cancel ? false : reading || (needsFreshData && (readError !== undefined || needsCheck)));
      if (blocked) button.setAttribute('aria-disabled', 'true'); else button.removeAttribute('aria-disabled');
      const own = operation?.kind === 'publish' && button.hasAttribute('data-recued-publish-confirm-action') && button.getAttribute('data-metric') === operation.choice.metric_id
        || operation?.kind === 'stop' && button.hasAttribute('data-recued-publish-stop-action') && button.getAttribute('data-tag') === operation.tag
        || operation?.kind === 'submit' && button.hasAttribute('data-recued-submit-action');
      if (own) { button.setAttribute('aria-busy', 'true'); button.textContent = operation?.kind === 'publish' ? 'Publishing…' : operation?.kind === 'stop' ? 'Stopping…' : 'Sending…'; }
      else button.removeAttribute('aria-busy');
    }
    if (held && active !== doc.activeElement) {
      let target: HTMLElement | undefined;
      if (formId && field) target = Array.from(root.querySelectorAll<HTMLElement>('[data-recued-publish-start]'))
        .find(form => form.getAttribute('data-recued-publish-start') === formId)?.querySelector<HTMLElement>(`[data-recued-publish-${field}]`) ?? undefined;
      else if (attr) target = Array.from(root.querySelectorAll<HTMLElement>(`[${attr}]`)).find(button => button.getAttribute('data-metric') === metric && button.getAttribute('data-tag') === tag);
      target ??= root.querySelector<HTMLElement>('[data-recued-stats-route-heading]') ?? undefined;
      target?.focus({ preventScroll: true });
      if (field && selection && target?.tagName === 'INPUT') (target as HTMLInputElement).setSelectionRange(selection[0] ?? 0, selection[1] ?? 0, selection[2] ?? undefined);
    }
  };
  const reconcile = (): void => {
    if (!data || !uncertain) return;
    if (uncertain.kind === 'publish') {
      const choice = uncertain.choice;
      if (data.publications.some(pub => pub.tag === choice.tag && pub.metric_id === choice.metric_id && pub.season_id === choice.season_id && pub.state === 'active')) {
        if (pending === choice) { pending = undefined; drafts.delete(choice.metric_id); }
        actionStatus = `Publishing is enabled for #${choice.tag}.`; actionError = undefined; uncertain = undefined;
      }
    } else if (uncertain.kind === 'stop') {
      const tag = uncertain.tag;
      if (!data.publications.some(pub => pub.tag === tag && pub.state === 'active')) {
        actionStatus = `Publishing is stopped on this server for #${tag}.`; actionError = undefined; uncertain = undefined;
      }
    }
  };
  const refresh = async (): Promise<void> => {
    if (disposed) return;
    const generation = ++readGeneration; reading = true; paint();
    try {
      const fresh = await opts.read();
      if (disposed || generation !== readGeneration) return;
      data = fresh; readError = undefined; needsCheck = false; reconcile();
    } catch (error) {
      if (!disposed && generation === readGeneration) readError = humanizeRpcError(error).trim() || 'Try reading your stats again.';
    } finally {
      if (!disposed && generation === readGeneration) { reading = false; paint(); }
    }
  };
  const perform = async (next: Operation): Promise<void> => {
    if (disposed || reading || operation || readError || needsCheck || !data) return;
    captureDrafts(); operation = next; actionError = undefined; actionStatus = undefined; uncertain = undefined; paint();
    try {
      if (next.kind === 'publish') {
        await opts.publish(next.choice);
        if (disposed) return;
        if (pending === next.choice) { pending = undefined; drafts.delete(next.choice.metric_id); }
        actionStatus = `Publishing enabled for #${next.choice.tag}.`;
      } else if (next.kind === 'stop') {
        await opts.unpublish({ tag: next.tag });
        if (disposed) return;
        actionStatus = `Stop request saved for #${next.tag}.`;
      } else {
        const res = await opts.submit();
        if (disposed) return;
        submitOutcome = res.sent ? { sent: true, ...classify(res.results ?? []) } : { sent: false, reason: res.skip_reason ?? 'send_failed' };
      }
    } catch (error) {
      if (disposed) return;
      uncertain = next;
      if (next.kind === 'submit') submitOutcome = { sent: false, reason: 'send_failed' };
      else actionError = `Couldn’t confirm ${next.kind === 'publish' ? 'publishing' : 'stopping publication'}. ${humanizeRpcError(error)} Check the current settings before trying again.`;
    } finally {
      if (!disposed) { readGeneration++; reading = false; operation = undefined; needsCheck = true; paint(); }
    }
    // Release command ownership before this read; a newer command can start
    // after a newer refresh supersedes it, without an old finally clearing it.
    if (!disposed) await refresh();
  };
  const onClick = (event: Event): void => {
    const target = event.target as HTMLElement | null;
    if (disposed || target?.isConnected === false || root.contains?.(target) === false) return;
    if (target?.closest?.('[data-recued-stats-retry]')) { if (!reading && !operation) void refresh(); return; }
    if (operation) return;
    if (target?.closest?.('[data-recued-publish-cancel-action]')) {
      const metric = pending?.metric_id; pending = undefined; paint();
      if (metric) {
        const form = Array.from(root.querySelectorAll?.<HTMLElement>('[data-recued-publish-start]') ?? []).find(form => form.getAttribute('data-recued-publish-start') === metric);
        form?.querySelector<HTMLElement>('[data-recued-publish-tag]')?.focus();
      }
      return;
    }
    if (reading || readError || needsCheck || !data) return;
    const stop = target?.closest?.('[data-recued-publish-stop-action]');
    const tag = stop?.getAttribute('data-tag');
    if (tag !== null && tag !== undefined) { void perform({ kind: 'stop', tag }); return; }
    const preview = target?.closest?.('[data-recued-publish-preview-action]');
    const metric = preview?.getAttribute('data-metric');
    if (metric !== null && metric !== undefined) {
      const form = opts.container.querySelector?.<HTMLElement>(`[data-recued-publish-start="${metric}"]`);
      const values = form ? fieldDraft(form) : { tag: '', season_id: '' };
      if (!values.tag || !values.season_id) return;
      drafts.set(metric, values); pending = { metric_id: metric, ...values }; actionError = undefined; actionStatus = undefined; paint();
      root.querySelector<HTMLElement>('[data-recued-publish-confirm]')?.focus();
      return;
    }
    const confirm = target?.closest?.('[data-recued-publish-confirm-action]');
    if (confirm && pending && confirm.getAttribute('data-metric') === pending.metric_id && confirm.getAttribute('data-tag') === pending.tag && confirm.getAttribute('data-season') === pending.season_id) {
      void perform({ kind: 'publish', choice: pending }); return;
    }
    if (target?.closest?.('[data-recued-submit-action]')) void perform({ kind: 'submit' });
  };
  const onInput = (): void => { captureDrafts(); };
  root.addEventListener?.('input', onInput);
  opts.container.addEventListener?.('click', onClick);
  void refresh();

  return {
    refresh,
    dispose: () => {
      disposed = true;
      (opts.container as unknown as {
        removeEventListener?: (t: string, h: (e: Event) => void) => void;
      }).removeEventListener?.('click', onClick);
      root.removeEventListener?.('input', onInput);
      readGeneration++;
      // ⛔ THE HALF THAT WAS MISSING. Dropping the listener without removing
      // the markup left the page on screen under its successor.
      root.remove?.();
    },
  };
};
