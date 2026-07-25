/** D-169 P2 (N.9) — Approvals nav count badge acceptance.
 *
 *  The reception status header's Approvals nav link carries a
 *  "N awaiting you" count badge sourced from the `notification.pending_asks`
 *  list length and kept live by the route's `notification.ask` /
 *  `notification.ask_closed` bus subscription. Two surfaces under test:
 *
 *    1. **Render** (`renderReceptionPage`) — the pure projection: a
 *       `pendingAsksCount > 0` emits the badge inside the Approvals anchor;
 *       zero / omitted emits no badge (the pre-badge `>Approvals<` shape the
 *       hash-link test pins stays intact).
 *    2. **Route wiring** (`mountReceptionRoute`) — the end-to-end seam: seed
 *       the count off `notification.pending_asks` at mount, re-read it on
 *       each ask bus frame, force the badge to redraw when the count moves,
 *       drop the subscriptions on dispose, and stay completely inert (no
 *       rpc, no badge) when the bus seam is absent.
 *
 *  Same no-jsdom + no-`vi.mock` convention as the sibling reception tests:
 *  fake host (innerHTML store), fake shell, fake rpc conn, fake subscriber.
 *  Every assertion goes through the observable wire (rendered HTML,
 *  conn.calls, subscriber listener counts).
 *
 *  Spec: D-169 § N.9 (count badge). */

import { describe, expect, it, vi } from 'vitest';
import type {
  EndpointSummary,
  PacketDeclaration,
  ReceptionEndpointKind,
  ServerPendingAsk,
  ShareCardsInput,
} from '@recued/contracts';
import {
  RECEPTION_ENDPOINT_KIND_TO_PACKET_KIND,
  RECEPTION_RECOMMENDED_EXPOSURE_PROFILE,
} from '@recued/contracts';

import { mountReceptionRoute } from '../settings/reception-route.js';
import {
  renderReceptionPage,
  RECEPTION_APPROVALS_COUNT_ATTR,
  RECEPTION_PAGE_STYLES,
} from '../settings/reception-page-render.js';
import type {
  LaunchWizardRunResult,
  ReceptionPageShell,
  ReceptionPageShellState,
} from '../settings/reception-page-shell.js';
import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import { buildReceptionPageModel } from '../settings/reception.js';

const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

// ──────────────────────────────────────────────────────────────────
// Shared fakes — same shapes as d-149-settings-reception-route.test.ts.
// ──────────────────────────────────────────────────────────────────

const makeFakeHost = (): HTMLElement => {
  let html = '';
  const listeners: Record<string, Set<(event: Event) => void>> = {};
  return {
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
};

const placeholderPacket = (kind: ReceptionEndpointKind): PacketDeclaration => ({
  packet_kind: RECEPTION_ENDPOINT_KIND_TO_PACKET_KIND[kind],
  source_query_ref:
    kind === 'reception_page'
      ? { kind: 'reception_page_config' }
      : { kind: 'data.calendar.combined' },
});

const summary = (
  over: Partial<EndpointSummary> & {
    endpoint_id: string;
    kind: ReceptionEndpointKind;
  },
): EndpointSummary => ({
  endpoint_id: over.endpoint_id,
  kind: over.kind,
  metadata: over.metadata ?? {},
  enabled: over.enabled ?? true,
  packet_declaration: over.packet_declaration ?? placeholderPacket(over.kind),
  expires_at: over.expires_at ?? null,
  long_lived_acknowledged_at: over.long_lived_acknowledged_at ?? null,
  revoked_at: over.revoked_at ?? null,
  revocation_reason: over.revocation_reason ?? null,
  audit_count: over.audit_count ?? 0,
  last_accessed_at: over.last_accessed_at ?? null,
  created_at: over.created_at ?? NOW - DAY_MS,
  created_by_client_id: over.created_by_client_id ?? 'cli-test',
});

const baseState = (
  over: Partial<ReceptionPageShellState> = {},
): ReceptionPageShellState => {
  const endpoints: ReadonlyArray<EndpointSummary> = [
    summary({ endpoint_id: 'ep-sched', kind: 'scheduling_link' }),
  ];
  return {
    page: buildReceptionPageModel({
      endpoints,
      status: {
        reception_public: true,
        emergency_disabled: false,
        base_url: 'https://reception.example',
      },
      now: NOW,
    }),
    detail: null,
    abuse_inbox: null,
    view_as_visitor: null,
    status: {
      reception_public: true,
      emergency_disabled: false,
      base_url: 'https://reception.example',
    },
    last_error: null,
    loading: false,
    ...over,
  };
};

const makeFakeShell = () => {
  let current: ReceptionPageShellState = baseState();
  const listeners = new Set<(s: ReceptionPageShellState) => void>();
  const noop = (): void => undefined;
  const fns = {
    loadPage: vi.fn(() => Promise.resolve(undefined)),
    enableEndpoint: vi.fn(() => Promise.resolve(undefined)),
    disableEndpoint: vi.fn(() => Promise.resolve(undefined)),
    revokeEndpoint: vi.fn(() => Promise.resolve(undefined)),
    extendEndpoint: vi.fn(() => Promise.resolve(undefined)),
    rotateToken: vi.fn(() =>
      Promise.resolve({
        bearer_secret_once: 'bs',
        share_url_once: 'https://reception.example/x?t=once',
      }),
    ),
    emergencyDisableAll: vi.fn(() => Promise.resolve(undefined)),
    openDetail: vi.fn(() => Promise.resolve(undefined)),
    previewEndpointAsVisitor: vi.fn(() => Promise.resolve(undefined)),
    loadAbuseInbox: vi.fn(() => Promise.resolve(undefined)),
    banIp: vi.fn(() => Promise.resolve(undefined)),
    unbanIp: vi.fn(() => Promise.resolve(undefined)),
    runPreview: vi.fn(() =>
      Promise.resolve({ preview_hash: 'ph' } as Awaited<
        ReturnType<ReceptionPageShell['runPreview']>
      >),
    ),
    createEndpoint: vi.fn(() =>
      Promise.resolve({
        endpoint_id: 'ep-fresh',
        public_locator: 'pl-fresh',
        bearer_secret_once: 'bs-fresh',
        share_url_once: 'https://reception.example/new?t=once',
        enabled: false,
      }),
    ),
    upsertReceptionPage: vi.fn(() => Promise.resolve(undefined)),
    runLaunchWizard: vi.fn(() =>
      Promise.resolve({ page_upserted: true, created: [] } as LaunchWizardRunResult),
    ),
    closeDetail: vi.fn(noop),
    closeViewAsVisitor: vi.fn(noop),
    setStatus: vi.fn(noop),
    setEndpointShare: vi.fn((_id: string, _share: ShareCardsInput): void => undefined),
    dispose: vi.fn(noop),
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
    notify: (partial?: Partial<ReceptionPageShellState>) => {
      current = { ...current, ...(partial ?? {}) };
      for (const l of [...listeners]) l(current);
    },
  };
};

// ──────────────────────────────────────────────────────────────────
// Fake conn — resolver per method; rejects unknown methods.
// ──────────────────────────────────────────────────────────────────

interface FakeConn {
  conn: (method: string, payload?: unknown) => Promise<unknown>;
  calls: Array<{ method: string; payload: unknown }>;
  set(method: string, resolver: (payload: unknown) => Promise<unknown>): void;
}

const makeFakeConn = (defaults: Record<string, unknown> = {}): FakeConn => {
  const calls: Array<{ method: string; payload: unknown }> = [];
  const baseDefaults: Record<string, unknown> = {
    'reception.page.get': { config: null, last_updated_at: null },
    'reception.template.list': { templates: [] },
    'notification.pending_asks': { asks: [] },
    ...defaults,
  };
  const resolvers = new Map<string, (payload: unknown) => Promise<unknown>>();
  for (const [m, value] of Object.entries(baseDefaults)) {
    resolvers.set(m, () => Promise.resolve(value));
  }
  const conn = (method: string, payload?: unknown): Promise<unknown> => {
    calls.push({ method, payload });
    const resolver = resolvers.get(method);
    if (resolver === undefined) {
      return Promise.reject(new Error(`fake conn: no resolver for ${method}`));
    }
    return resolver(payload);
  };
  return {
    conn,
    calls,
    set: (method, resolver) => {
      resolvers.set(method, resolver);
    },
  };
};

// ──────────────────────────────────────────────────────────────────
// Fake broadcast subscriber — record listener counts + drive frames.
// ──────────────────────────────────────────────────────────────────

const makeFakeSubscriber = () => {
  const byKind = new Map<string, Set<(event: unknown) => void>>();
  const on = (kind: string, listener: (event: unknown) => void): (() => void) => {
    const set = byKind.get(kind) ?? new Set<(event: unknown) => void>();
    set.add(listener);
    byKind.set(kind, set);
    return () => {
      set.delete(listener);
    };
  };
  return {
    on: on as unknown as BroadcastSubscriber['on'],
    fire: (kind: string): void => {
      for (const l of [...(byKind.get(kind) ?? [])]) l({ kind });
    },
    count: (kind: string): number => byKind.get(kind)?.size ?? 0,
  };
};

const mkAsk = (id: string): ServerPendingAsk => ({
  ask_id: id,
  text: `question ${id}`,
  options: [{ id: 'ok', label: 'OK' }],
  created_at: NOW,
});

const asksResult = (n: number): { asks: ServerPendingAsk[] } => ({
  asks: Array.from({ length: n }, (_v, i) => mkAsk(`ask-${i}`)),
});

const flush = (): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

const baseOpts = (
  shell: ReceptionPageShell,
  conn: FakeConn['conn'],
  subscribe?: BroadcastSubscriber['on'],
) => ({
  pageHost: makeFakeHost(),
  modalHost: makeFakeHost(),
  promptsHost: makeFakeHost(),
  shell,
  conn: conn as unknown as Parameters<typeof mountReceptionRoute>[0]['conn'],
  exposureProfile: RECEPTION_RECOMMENDED_EXPOSURE_PROFILE,
  now: () => NOW,
  ...(subscribe !== undefined ? { subscribe } : {}),
});

const pendingAsksCalls = (fc: FakeConn): number =>
  fc.calls.filter((c) => c.method === 'notification.pending_asks').length;

// ══════════════════════════════════════════════════════════════════
// Render — pure projection
// ══════════════════════════════════════════════════════════════════

describe('D-169 P2 — Approvals count badge: render', () => {
  it('emits the badge inside the Approvals link when pendingAsksCount > 0', () => {
    const html = renderReceptionPage(baseState(), NOW, { pendingAsksCount: 3 });
    // Isolate the Approvals anchor (open tag through its own </a>) so the
    // placement assertions are scoped to it — not satisfied by the count
    // attribute appearing anywhere else in the document.
    const anchor = html.match(/<a[^>]*data-recued-approvals-link[^>]*>([\s\S]*?)<\/a>/);
    expect(anchor).not.toBeNull();
    const [anchorOuter, anchorInner] = [anchor![0], anchor![1]!];
    expect(anchorOuter).toContain('href="#approvals"');
    // The badge lives INSIDE this anchor (not the Settings link).
    expect(anchorInner).toContain(`${RECEPTION_APPROVALS_COUNT_ATTR}="3"`);
    expect(anchorInner).toContain('Approvals');
    expect(anchorInner).not.toContain('href="#settings"');
    // …and the Approvals anchor precedes the Settings link in the header.
    expect(html).toMatch(/data-recued-approvals-link[\s\S]*href="#settings"/);
  });

  it('voices the N.9 "N awaiting you" phrasing for assistive tech', () => {
    const html = renderReceptionPage(baseState(), NOW, { pendingAsksCount: 7 });
    expect(html).toContain('aria-label="7 awaiting you"');
    expect(html).toContain('title="7 awaiting you"');
    expect(html).toContain('>7</span>');
  });

  it('emits NO badge at zero', () => {
    const html = renderReceptionPage(baseState(), NOW, { pendingAsksCount: 0 });
    expect(html).not.toContain(RECEPTION_APPROVALS_COUNT_ATTR);
    // The link is still there, in its pre-badge shape.
    expect(html).toContain('href="#approvals"');
    expect(html).toContain('>Approvals<');
  });

  it('emits NO badge when the option is omitted (default 0)', () => {
    const html = renderReceptionPage(baseState(), NOW);
    expect(html).not.toContain(RECEPTION_APPROVALS_COUNT_ATTR);
    expect(html).toContain('>Approvals<');
  });

  it('renders the badge in the status header regardless of active view (unloaded)', () => {
    const html = renderReceptionPage(baseState({ page: null }), NOW, {
      pendingAsksCount: 2,
    });
    expect(html).toMatch(
      new RegExp(
        `reception-status-header[\\s\\S]*${RECEPTION_APPROVALS_COUNT_ATTR}="2"`,
      ),
    );
  });

  it('ships CSS scoped to the badge class', () => {
    // The actual style block (not just the markup) targets the badge.
    expect(RECEPTION_PAGE_STYLES).toContain('.reception-nav-badge');
    // …and the markup carries the class the rule selects.
    expect(renderReceptionPage(baseState(), NOW, { pendingAsksCount: 1 })).toContain(
      'class="reception-nav-badge"',
    );
  });
});

// ══════════════════════════════════════════════════════════════════
// Route wiring — seed + live updates + dispose + inert-without-subscribe
// ══════════════════════════════════════════════════════════════════

describe('D-169 P2 — Approvals count badge: route wiring', () => {
  it('seeds the count from notification.pending_asks at mount (badge appears)', async () => {
    const { shell } = makeFakeShell();
    const fc = makeFakeConn({ 'notification.pending_asks': asksResult(2) });
    const sub = makeFakeSubscriber();
    const opts = baseOpts(shell, fc.conn, sub.on);
    const route = mountReceptionRoute(opts);
    await flush();
    await flush();
    // Exactly one seed read fires at mount (no bus frame yet).
    expect(pendingAsksCalls(fc)).toBe(1);
    expect(opts.pageHost.innerHTML).toContain(`${RECEPTION_APPROVALS_COUNT_ATTR}="2"`);
    route.dispose();
  });

  it('re-reads + repaints the count on a notification.ask frame', async () => {
    const { shell } = makeFakeShell();
    const fc = makeFakeConn({ 'notification.pending_asks': asksResult(1) });
    const sub = makeFakeSubscriber();
    const opts = baseOpts(shell, fc.conn, sub.on);
    const route = mountReceptionRoute(opts);
    await flush();
    await flush();
    expect(opts.pageHost.innerHTML).toContain(`${RECEPTION_APPROVALS_COUNT_ATTR}="1"`);

    // A new ask is raised on the server → re-fetch returns a higher count.
    fc.set('notification.pending_asks', () => Promise.resolve(asksResult(4)));
    sub.fire('notification.ask');
    await flush();
    await flush();
    expect(opts.pageHost.innerHTML).toContain(`${RECEPTION_APPROVALS_COUNT_ATTR}="4"`);
    expect(opts.pageHost.innerHTML).not.toContain(`${RECEPTION_APPROVALS_COUNT_ATTR}="1"`);
    route.dispose();
  });

  it('drops the badge when a notification.ask_closed frame empties the list', async () => {
    const { shell } = makeFakeShell();
    const fc = makeFakeConn({ 'notification.pending_asks': asksResult(2) });
    const sub = makeFakeSubscriber();
    const opts = baseOpts(shell, fc.conn, sub.on);
    const route = mountReceptionRoute(opts);
    await flush();
    await flush();
    expect(opts.pageHost.innerHTML).toContain(`${RECEPTION_APPROVALS_COUNT_ATTR}="2"`);

    // The last ask is answered from any surface → re-fetch returns zero.
    fc.set('notification.pending_asks', () => Promise.resolve(asksResult(0)));
    sub.fire('notification.ask_closed');
    await flush();
    await flush();
    expect(opts.pageHost.innerHTML).not.toContain(RECEPTION_APPROVALS_COUNT_ATTR);
    // The Approvals link survives (only the badge is gone).
    expect(opts.pageHost.innerHTML).toContain('href="#approvals"');
    route.dispose();
  });

  it('applies only the freshest re-fetch when frames race (generation guard)', async () => {
    const { shell } = makeFakeShell();
    const fc = makeFakeConn({ 'notification.pending_asks': asksResult(1) });
    const sub = makeFakeSubscriber();
    const opts = baseOpts(shell, fc.conn, sub.on);
    const route = mountReceptionRoute(opts);
    await flush();
    await flush();
    expect(opts.pageHost.innerHTML).toContain(`${RECEPTION_APPROVALS_COUNT_ATTR}="1"`);

    // Hold the NEXT pending_asks response so we can land a later one first.
    let releaseStale: (v: { asks: ServerPendingAsk[] }) => void = () => undefined;
    fc.set(
      'notification.pending_asks',
      () =>
        new Promise<{ asks: ServerPendingAsk[] }>((resolve) => {
          releaseStale = resolve;
        }) as unknown as Promise<unknown>,
    );
    sub.fire('notification.ask'); // gen A — held below
    await flush();

    // A second frame whose response resolves immediately to a new count.
    fc.set('notification.pending_asks', () => Promise.resolve(asksResult(9)));
    sub.fire('notification.ask'); // gen B — wins
    await flush();
    await flush();
    expect(opts.pageHost.innerHTML).toContain(`${RECEPTION_APPROVALS_COUNT_ATTR}="9"`);

    // Now release the STALE (earlier-generation) response with a wrong count —
    // it must be discarded, leaving the badge at the gen-B value.
    releaseStale(asksResult(5));
    await flush();
    await flush();
    expect(opts.pageHost.innerHTML).toContain(`${RECEPTION_APPROVALS_COUNT_ATTR}="9"`);
    expect(opts.pageHost.innerHTML).not.toContain(`${RECEPTION_APPROVALS_COUNT_ATTR}="5"`);
    route.dispose();
  });

  it('subscribes to both ask bus kinds + unsubscribes on dispose', async () => {
    const { shell } = makeFakeShell();
    const fc = makeFakeConn({ 'notification.pending_asks': asksResult(1) });
    const sub = makeFakeSubscriber();
    const route = mountReceptionRoute(baseOpts(shell, fc.conn, sub.on));
    await flush();
    expect(sub.count('notification.ask')).toBe(1);
    expect(sub.count('notification.ask_closed')).toBe(1);
    route.dispose();
    expect(sub.count('notification.ask')).toBe(0);
    expect(sub.count('notification.ask_closed')).toBe(0);
  });

  it('suppresses a re-fetch resolving after dispose — the disposed guard returns before reading the result', async () => {
    const { shell } = makeFakeShell();
    let release: (v: { asks: ServerPendingAsk[] }) => void = () => undefined;
    const fc = makeFakeConn();
    fc.set(
      'notification.pending_asks',
      () =>
        new Promise<{ asks: ServerPendingAsk[] }>((resolve) => {
          release = resolve;
        }) as unknown as Promise<unknown>,
    );
    const sub = makeFakeSubscriber();
    const route = mountReceptionRoute(baseOpts(shell, fc.conn, sub.on));
    await flush(); // the seed read is now in flight (held)
    route.dispose();

    // Resolve the held seed read AFTER dispose. The result's `asks` is a
    // getter that records access; the disposed guard must short-circuit
    // before `result.asks.length` runs, so the getter is never read. (If
    // the `disposed` check were dropped, the gen would still match — only
    // the disposed guard catches this — so the getter would fire.)
    let asksRead = false;
    const sentinel = {
      get asks(): ServerPendingAsk[] {
        asksRead = true;
        return [mkAsk('late')];
      },
    };
    expect(() => release(sentinel as { asks: ServerPendingAsk[] })).not.toThrow();
    await flush();
    await flush();
    expect(asksRead).toBe(false);
  });

  it('is INERT without a subscribe seam — no badge, no pending_asks rpc', async () => {
    const { shell } = makeFakeShell();
    const fc = makeFakeConn({ 'notification.pending_asks': asksResult(5) });
    // No subscribe passed.
    const opts = baseOpts(shell, fc.conn);
    const route = mountReceptionRoute(opts);
    await flush();
    await flush();
    expect(pendingAsksCalls(fc)).toBe(0);
    expect(opts.pageHost.innerHTML).not.toContain(RECEPTION_APPROVALS_COUNT_ATTR);
    // The Approvals link is still rendered (the badge is the only thing gated).
    expect(opts.pageHost.innerHTML).toContain('href="#approvals"');
    route.dispose();
  });

  it('is INERT when pending asks are disabled without removing the shared bus seam', async () => {
    const { shell } = makeFakeShell();
    const fc = makeFakeConn({ 'notification.pending_asks': asksResult(5) });
    const sub = makeFakeSubscriber();
    const opts = {
      ...baseOpts(shell, fc.conn, sub.on),
      enablePendingAsks: false,
    };
    const route = mountReceptionRoute(opts);
    await flush();
    await flush();

    expect(pendingAsksCalls(fc)).toBe(0);
    expect(sub.count('notification.ask')).toBe(0);
    expect(sub.count('notification.ask_closed')).toBe(0);
    expect(opts.pageHost.innerHTML).not.toContain(RECEPTION_APPROVALS_COUNT_ATTR);
    // The option suppresses only the cross-route badge. The shared bus
    // function remains present for sibling Reception consumers.
    expect(opts.subscribe).toBe(sub.on);

    route.dispose();
  });

  it('re-fetches but does not re-render when an ask frame leaves the count unchanged', async () => {
    const { shell } = makeFakeShell();
    const fc = makeFakeConn({ 'notification.pending_asks': asksResult(2) });
    const sub = makeFakeSubscriber();
    // `renderReceptionPage` calls `now()` exactly once per render, so a
    // `now` spy counts re-renders BEFORE `mountReceptionPage`'s
    // `html === lastHtml` dedup — which would otherwise mask whether the
    // route's own `next === pendingAsksCount` early-return actually fired.
    const nowSpy = vi.fn(() => NOW);
    const opts = { ...baseOpts(shell, fc.conn, sub.on), now: nowSpy };
    const route = mountReceptionRoute(opts);
    await flush();
    await flush();
    expect(opts.pageHost.innerHTML).toContain(`${RECEPTION_APPROVALS_COUNT_ATTR}="2"`);
    expect(pendingAsksCalls(fc)).toBe(1);
    nowSpy.mockClear();

    // An ask frame whose re-fetch returns the SAME count (2): the route
    // re-reads the authoritative list (proving the frame WAS handled) but
    // the early-return skips `host.update()`, so NO render runs.
    sub.fire('notification.ask');
    await flush();
    await flush();
    expect(pendingAsksCalls(fc)).toBe(2); // re-fetch happened
    expect(nowSpy).not.toHaveBeenCalled(); // …but no re-render
    route.dispose();
  });
});
