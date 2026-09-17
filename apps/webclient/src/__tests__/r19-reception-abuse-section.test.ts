/** R19 — Reception ▸ Abuse section mount (`abuse-section.ts`).
 *
 *  The first-class `#reception/abuse` section: subscribes to the shared
 *  page shell, auto-loads the abuse inbox on mount, renders the reused
 *  `renderAbuseInboxPanel`, and drives refresh / ban / unban / investigate
 *  off the shell + the navigation seam. Driven through the same fake-host
 *  pattern the reception-page-host tests use (no jsdom in webclient
 *  vitest). */

import { describe, expect, it, vi } from 'vitest';
import type {
  AbuseInboxSummary,
  ReceptionIpBlockEntry,
} from '@recued/contracts';

import {
  mountReceptionAbuseSection,
  RECEPTION_ABUSE_HEADING_ATTR,
  RECEPTION_ABUSE_SECTION_ATTR,
} from '../reception/abuse-section.js';
import {
  buildAbuseInboxSubviewModel,
  type AbuseInboxSubviewModel,
} from '../reception/abuse-inbox.js';
import type {
  ReceptionPageShell,
  ReceptionPageShellState,
} from '../reception/page-shell.js';

const NOW = 1_700_000_000_000;

// ── Fake host — captures the dispatcher's click listener + replays it. ──
const makeFakeHost = () => {
  let html = '';
  const listeners: Record<string, Set<(event: Event) => void>> = {};
  const host = {
    get innerHTML() {
      return html;
    },
    set innerHTML(value: string) {
      html = value;
    },
    addEventListener: (evt: string, fn: (event: Event) => void) => {
      (listeners[evt] ??= new Set()).add(fn);
    },
    removeEventListener: (evt: string, fn: (event: Event) => void) => {
      listeners[evt]?.delete(fn);
    },
    contains: () => true,
  } as unknown as HTMLElement;
  const fire = (evt: string, target: unknown): void => {
    for (const fn of [...(listeners[evt] ?? [])]) {
      fn({ target, type: evt, preventDefault: () => {} } as unknown as Event);
    }
  };
  return {
    host,
    getHtml: () => html,
    listenerCount: () =>
      Object.values(listeners).reduce((t, s) => t + s.size, 0),
    click: (dataset: Record<string, string>) => {
      const el = { dataset, closest: () => el } as unknown;
      fire('click', el);
    },
  };
};

// ── Fake shell — only the surface the abuse section touches. ──
const initialState = (
  over: Partial<ReceptionPageShellState> = {},
): ReceptionPageShellState => ({
  page: null,
  detail: null,
  abuse_inbox: null,
  view_as_visitor: null,
  status: { reception_public: true, emergency_disabled: false, base_url: null },
  last_error: null,
  loading: false,
  ...over,
});

const makeFakeShell = (start?: Partial<ReceptionPageShellState>) => {
  let current = initialState(start);
  const listeners = new Set<(s: ReceptionPageShellState) => void>();
  const notify = (): void => {
    for (const l of [...listeners]) l(current);
  };
  const fns = {
    loadAbuseInbox: vi.fn(() => Promise.resolve(undefined)),
    banIp: vi.fn(() => Promise.resolve(undefined)),
    unbanIp: vi.fn(() => Promise.resolve(undefined)),
  };
  const shell = {
    getState: () => current,
    subscribe: (l: (s: ReceptionPageShellState) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    ...fns,
  } as unknown as ReceptionPageShell;
  return {
    shell,
    fns,
    listenerCount: () => listeners.size,
    push: (next: Partial<ReceptionPageShellState>) => {
      current = { ...current, ...next };
      notify();
    },
  };
};

const abuseSummary = (
  over: Partial<AbuseInboxSummary> = {},
): AbuseInboxSummary => ({
  rows: [],
  total_signals: 0,
  window_start_at: NOW - 7 * 24 * 60 * 60 * 1000,
  window_end_at: NOW,
  cluster_threshold: 3,
  ...over,
});

const blockEntry = (
  over: Partial<ReceptionIpBlockEntry> = {},
): ReceptionIpBlockEntry => ({
  endpoint_id: 'ep-1',
  source_ip_hash: 'abc12345def67890',
  blocked_at: NOW - 120_000,
  blocked_by_client_id: 'client-A',
  reason: 'persistent abuse',
  ...over,
});

const loadedInbox = (): AbuseInboxSubviewModel =>
  buildAbuseInboxSubviewModel({
    summary: abuseSummary({
      rows: [
        {
          signal_kind: 'spam_burst',
          endpoint_id: 'ep-1',
          source_ip_hash: 'abc12345def67890',
          event_count: 12,
          first_seen_at: NOW - 600_000,
          last_seen_at: NOW - 60_000,
          ip_blocked: false,
        },
      ],
      total_signals: 1,
    }),
    blocked: [blockEntry()],
    now: NOW,
  });

describe('R19 — mountReceptionAbuseSection', () => {
  it('subscribes to the shell + auto-loads the abuse inbox on mount', () => {
    const fakeHost = makeFakeHost();
    const { shell, fns, listenerCount } = makeFakeShell();
    const mount = mountReceptionAbuseSection({ host: fakeHost.host, shell });
    expect(listenerCount()).toBe(1);
    expect(fns.loadAbuseInbox).toHaveBeenCalledTimes(1);
    mount.dispose();
  });

  it('shows a loading hint before the inbox loads, then the panel once loaded', () => {
    const fakeHost = makeFakeHost();
    const ctl = makeFakeShell();
    const mount = mountReceptionAbuseSection({ host: fakeHost.host, shell: ctl.shell });
    // abuse_inbox is null at mount → loading hint, no panel.
    expect(fakeHost.getHtml()).toContain(RECEPTION_ABUSE_SECTION_ATTR);
    expect(fakeHost.getHtml()).toContain('role="region"');
    expect(fakeHost.getHtml()).toContain(RECEPTION_ABUSE_HEADING_ATTR);
    expect(fakeHost.getHtml()).toContain('>Abuse signals</h2>');
    expect(fakeHost.getHtml()).toContain('Loading abuse signals');
    expect(fakeHost.getHtml()).not.toContain('Abuse Inbox');
    // Once the shell publishes the loaded inbox, the panel renders.
    ctl.push({ abuse_inbox: loadedInbox() });
    const html = fakeHost.getHtml();
    expect(html).toContain('Abuse Inbox');
    expect(html).toContain('Spam burst');
    expect(html).toContain('Currently banned');
    // ROUND-TRIP: the rendered buttons must carry the EXACT data-* keys the
    // action handlers read (`dataset.endpointId` / `dataset.sourceIpHash`
    // ← `data-endpoint-id` / `data-source-ip-hash`). A drift here would
    // make real clicks no-op while the synthesized-dataset click tests pass.
    expect(html).toContain('data-action="reception-ban-ip"');
    expect(html).toContain('data-endpoint-id="ep-1"');
    expect(html).toContain('data-source-ip-hash="abc12345def67890"');
    expect(html).toContain('data-action="reception-open-detail"');
    mount.dispose();
  });

  it('renders the loading bar + resolves the error through the abuse copy registry', () => {
    const fakeHost = makeFakeHost();
    // `bad_request` is an ABUSE_INBOX_ERROR_COPY code → the section must
    // render the registry remediation copy, NOT the raw rpc message (proves
    // it resolves errors the same way the spine does).
    const ctl = makeFakeShell({
      loading: true,
      last_error: { code: 'bad_request', message: 'raw-untranslated-message' },
    });
    const mount = mountReceptionAbuseSection({ host: fakeHost.host, shell: ctl.shell });
    expect(fakeHost.getHtml()).toContain('reception-loading-bar');
    expect(fakeHost.getHtml()).toContain('Recued could not read that request');
    expect(fakeHost.getHtml()).not.toContain('raw-untranslated-message');
    mount.dispose();
  });

  it('Refresh re-runs loadAbuseInbox', () => {
    const fakeHost = makeFakeHost();
    const { shell, fns } = makeFakeShell();
    const mount = mountReceptionAbuseSection({ host: fakeHost.host, shell });
    fns.loadAbuseInbox.mockClear();
    fakeHost.click({ action: 'reception-open-abuse-inbox' });
    expect(fns.loadAbuseInbox).toHaveBeenCalledTimes(1);
    mount.dispose();
  });

  it('Ban / Unban call the shell with the row endpoint + ip hash', () => {
    const fakeHost = makeFakeHost();
    const { shell, fns } = makeFakeShell();
    const mount = mountReceptionAbuseSection({ host: fakeHost.host, shell });
    fakeHost.click({
      action: 'reception-ban-ip',
      endpointId: 'ep-1',
      sourceIpHash: 'abc12345def67890',
    });
    expect(fns.banIp).toHaveBeenCalledWith('ep-1', 'abc12345def67890');
    fakeHost.click({
      action: 'reception-unban-ip',
      endpointId: 'ep-1',
      sourceIpHash: 'abc12345def67890',
    });
    expect(fns.unbanIp).toHaveBeenCalledWith('ep-1', 'abc12345def67890');
    mount.dispose();
  });

  it('Ban without both args is a no-op (guard)', () => {
    const fakeHost = makeFakeHost();
    const { shell, fns } = makeFakeShell();
    const mount = mountReceptionAbuseSection({ host: fakeHost.host, shell });
    fakeHost.click({ action: 'reception-ban-ip', endpointId: 'ep-1' }); // no ip hash
    expect(fns.banIp).not.toHaveBeenCalled();
    mount.dispose();
  });

  it('Investigate navigates to the endpoint detail deep-link', () => {
    const fakeHost = makeFakeHost();
    const { shell } = makeFakeShell();
    const navigate = vi.fn();
    const mount = mountReceptionAbuseSection({ host: fakeHost.host, shell, navigate });
    fakeHost.click({ action: 'reception-open-detail', endpointId: 'ep-1' });
    expect(navigate).toHaveBeenCalledWith('#reception/endpoints/ep-1');
    mount.dispose();
  });

  it('dispose unsubscribes, clears the host, and is idempotent', () => {
    const fakeHost = makeFakeHost();
    const ctl = makeFakeShell();
    const mount = mountReceptionAbuseSection({ host: fakeHost.host, shell: ctl.shell });
    expect(ctl.listenerCount()).toBe(1);
    mount.dispose();
    expect(ctl.listenerCount()).toBe(0);
    expect(fakeHost.getHtml()).toBe('');
    // A post-dispose shell push must not re-render.
    ctl.push({ abuse_inbox: loadedInbox() });
    expect(fakeHost.getHtml()).toBe('');
    expect(() => {
      mount.dispose();
      mount.dispose();
    }).not.toThrow();
  });
});
