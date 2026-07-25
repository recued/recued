/** Reception ▸ Abuse — the first-class `#reception/abuse` section (R19).
 *
 *  R19 promotes the Abuse Inbox out of the buried "Open Abuse Inbox" CTA
 *  at the bottom of the old one-long-page spine into a first-class
 *  section. The rendering is unchanged — this mount reuses the exact
 *  `renderAbuseInboxPanel` (signal-cluster rows + the per-server banned-IP
 *  block list + Refresh) the spine grew, and drives the same
 *  `reception-{open-abuse-inbox,ban-ip,unban-ip,open-detail}` actions
 *  through its own dispatcher against the SHARED `ReceptionPageShell`
 *  (`loadAbuseInbox` / `banIp` / `unbanIp` + `state.abuse_inbox`). The one
 *  behavior change: it AUTO-LOADS on mount (a first-class section fetches
 *  when you navigate to it, rather than waiting for a CTA click).
 *
 *  Mirrors `mountReceptionPage`'s lifecycle (subscribe → render → action
 *  dispatcher → idempotent dispose) so the two reception mounts read
 *  identically. The "Investigate" per-row link navigates to the endpoint
 *  detail deep-link (`#reception/endpoints/<id>`), which the spine routes to
 *  that endpoint's detail view on mount (R19 Slice 4).
 *
 *  Design record: internal design notes §9
 *  + Review log R19 / R19.1. */

import { e } from '@recued/ui-shared/template';
import { emptyHint, panel } from '@recued/ui-shared/primitives';
import { createActionDispatcher } from '@recued/ui-shared/action-dispatcher';

import { serializeShellRoute } from '../shell/route.js';
import {
  renderAbuseInboxPanel,
  resolveReceptionErrorCopy,
} from './reception-page-render.js';
import type { ReceptionPageShell } from './reception-page-shell.js';

// ════════════════════════════════════════════════════════════════
// Actions
// ════════════════════════════════════════════════════════════════

/** The four actions the abuse panel emits. `reception-open-abuse-inbox`
 *  doubles as the Refresh button (it re-runs `loadAbuseInbox`). */
const RECEPTION_ABUSE_ACTIONS = [
  'reception-open-abuse-inbox',
  'reception-ban-ip',
  'reception-unban-ip',
  'reception-open-detail',
] as const;
type ReceptionAbuseAction = (typeof RECEPTION_ABUSE_ACTIONS)[number];

// ════════════════════════════════════════════════════════════════
// Options + handle
// ════════════════════════════════════════════════════════════════

export interface ReceptionAbuseSectionOptions {
  /** Host element — replaced on every state change; cleared on dispose. */
  host: HTMLElement;
  /** The SHARED reception page shell — the abuse section drives
   *  `loadAbuseInbox` / `banIp` / `unbanIp` off it and renders
   *  `state.abuse_inbox`. */
  shell: ReceptionPageShell;
  /** Navigation seam for the per-row "Investigate" link → the endpoint
   *  detail deep-link (`#reception/endpoints/<id>`). Defaults to setting
   *  `globalThis.location.hash`. Injected in tests. */
  navigate?: (hash: string) => void;
}

export interface ReceptionAbuseSectionMount {
  /** Force a re-render from current shell state. */
  update(): void;
  /** Unsubscribe + detach the dispatcher + clear the host. Idempotent. */
  dispose(): void;
}

// ════════════════════════════════════════════════════════════════
// mountReceptionAbuseSection
// ════════════════════════════════════════════════════════════════

export const mountReceptionAbuseSection = (
  opts: ReceptionAbuseSectionOptions,
): ReceptionAbuseSectionMount => {
  const { host, shell } = opts;
  const navigate =
    opts.navigate ??
    ((hash: string): void => {
      const loc = (globalThis as { location?: { hash: string } }).location;
      if (loc !== undefined) loc.hash = hash;
    });
  let disposed = false;
  let lastHtml = '';

  const render = (): void => {
    if (disposed) return;
    const state = shell.getState();
    const loading = state.loading
      ? '<div class="reception-loading-bar" role="status" aria-label="Working…"></div>'
      : '';
    const error =
      state.last_error !== null
        ? panel({
            tone: 'danger',
            title: 'Reception action failed',
            role: 'alert',
            // Resolve through the SAME closed-list registries the spine uses
            // (incl. the abuse-specific copy) rather than leaking the raw
            // rpc message.
            body: `<p class="reception-error-copy">${e(resolveReceptionErrorCopy(state.last_error))}</p>`,
          })
        : '';
    // `abuse_inbox` is `null` before the first `loadAbuseInbox` resolves
    // (the auto-load fires on mount); show a loading hint until it lands.
    // Once loaded, `renderAbuseInboxPanel` renders its own empty state for
    // a quiet window.
    const body =
      state.abuse_inbox !== null
        ? renderAbuseInboxPanel(state.abuse_inbox)
        : emptyHint({ message: 'Loading abuse signals…' });
    const html = `<div class="reception-page reception-abuse-section">${loading}${error}${body}</div>`;
    if (html === lastHtml) return;
    host.innerHTML = html;
    lastHtml = html;
  };

  // Fire-and-forget against the shell — the shell routes rpc failures into
  // `last_error` + the subscription re-renders, so `.catch` only swallows
  // the rejection (same posture as `mountReceptionPage`).
  const swallow = (p: Promise<unknown>): void => {
    void p.catch(() => {});
  };

  const handlers = {
    'reception-open-abuse-inbox': () => swallow(shell.loadAbuseInbox()),
    'reception-ban-ip': (d: DOMStringMap) => {
      if (d.endpointId && d.sourceIpHash) {
        swallow(shell.banIp(d.endpointId, d.sourceIpHash));
      }
    },
    'reception-unban-ip': (d: DOMStringMap) => {
      if (d.endpointId && d.sourceIpHash) {
        swallow(shell.unbanIp(d.endpointId, d.sourceIpHash));
      }
    },
    'reception-open-detail': (d: DOMStringMap) => {
      if (d.endpointId) {
        navigate(serializeShellRoute('reception', 'endpoints', d.endpointId));
      }
    },
  } satisfies Record<ReceptionAbuseAction, (dataset: DOMStringMap) => void>;

  const detachDispatcher = createActionDispatcher<ReceptionAbuseAction>({
    root: host,
    handlers,
  });
  const unsubscribe = shell.subscribe(render);
  render();
  // R19 — a first-class section auto-loads when navigated to (the old
  // surface waited for a manual "Open Abuse Inbox" CTA click).
  swallow(shell.loadAbuseInbox());

  return {
    update: render,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      detachDispatcher();
      host.innerHTML = '';
    },
  };
};
