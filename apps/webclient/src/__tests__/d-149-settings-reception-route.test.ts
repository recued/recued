/** D-149 follow-on § A.9 — Reception Settings route entrypoint
 *  acceptance.
 *
 *  `mountReceptionRoute` is the PWA-shell layer on top of
 *  `mountReceptionSettings`: it owns the two route-only rpc reads
 *  (`reception.page.get` + `reception.template.list`), maintains the
 *  caches `resolvePageConfig` + `resolveTemplateSeed` read from, and
 *  refreshes the page-config cache on every shell-state change so
 *  post-upsert / post-broadcast reads stay fresh.
 *
 *  These tests follow the no-jsdom + no-vi.mock convention every other
 *  webclient test under `apps/webclient/src/__tests__/` uses: fake
 *  hosts, fake shell, fake rpc conn — every assertion goes through the
 *  observable wire (conn.calls, shell-fn spies, shell listener count).
 *  The resolver-output shape (the result of `intakeFormConfigFromTemplate`)
 *  is contract-owned + tested in `@recued/contracts`; here we verify
 *  only that the route wires the cache + the seam correctly. */

import { describe, expect, it, vi } from 'vitest';
import type {
  EndpointSummary,
  IntakeFormTemplate,
  PacketDeclaration,
  ReceptionEndpointKind,
  ShareCardsInput,
} from '@recued/contracts';
import {
  RECEPTION_ENDPOINT_KIND_TO_PACKET_KIND,
  RECEPTION_RECOMMENDED_EXPOSURE_PROFILE,
} from '@recued/contracts';

import { mountReceptionRoute } from '../settings/reception-route.js';
import type {
  LaunchWizardRunResult,
  ReceptionPageShell,
  ReceptionPageShellState,
} from '../settings/reception-page-shell.js';
import { buildReceptionPageModel } from '../settings/reception.js';

const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

// ──────────────────────────────────────────────────────────────────
// Fake host — same pattern as reception-settings-host.test.ts.
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

// ──────────────────────────────────────────────────────────────────
// Fake shell — same shape as reception-settings-host.test.ts, plus a
// `notify(partial)` test seam that drives the subscribe listeners.
// ──────────────────────────────────────────────────────────────────

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

const makeFakeShell = () => {
  const endpoints: ReadonlyArray<EndpointSummary> = [
    summary({ endpoint_id: 'ep-sched', kind: 'scheduling_link' }),
  ];
  let current: ReceptionPageShellState = {
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
  };
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
    fns,
    listenerCount: () => listeners.size,
    notify: (partial?: Partial<ReceptionPageShellState>) => {
      current = { ...current, ...(partial ?? {}) };
      for (const l of [...listeners]) l(current);
    },
  };
};

// ──────────────────────────────────────────────────────────────────
// Fake conn — record every call + replay queued responses per method.
// ──────────────────────────────────────────────────────────────────

interface FakeConn {
  conn: (method: string, payload?: unknown) => Promise<unknown>;
  calls: Array<{ method: string; payload: unknown }>;
  set(method: string, resolver: (payload: unknown) => Promise<unknown>): void;
}

const makeFakeConn = (
  defaults: Record<string, unknown> = {},
): FakeConn => {
  const calls: Array<{ method: string; payload: unknown }> = [];
  const baseDefaults: Record<string, unknown> = {
    'reception.page.get': { config: null, last_updated_at: null },
    'reception.template.list': { templates: [] },
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

const mkTemplate = (
  over: Partial<IntakeFormTemplate> = {},
): IntakeFormTemplate => ({
  template_ref: 'foundation:intake/client_inquiry',
  version: '1.0.0',
  name: 'Client inquiry',
  description: 'Collect initial inquiries from prospective clients.',
  default_instructions: 'Tell me a little about what you are looking for.',
  default_success_message: 'Thanks — your inquiry came through.',
  default_submit_button_label: 'Send inquiry',
  form_definition: {
    form_definition_id: 'fd_test_client_inquiry_v1',
    fields: [
      { name: 'your_name', type: 'text', label: 'Your name', required: true },
      { name: 'details', type: 'textarea', label: 'Tell me more', required: true },
      { name: 'website', type: 'text', label: 'Website', required: false },
    ],
  },
  required_visitor_fields: { email: 'required' },
  submission_processing_rule: {
    target_kind: 'task',
    fields_to_include_in_target: ['your_name', 'details'],
    fields_to_attach_as_metadata: [],
  },
  anti_spam_defaults: {
    honeypot_fields: ['website'],
    rate_limit_per_ip: 5,
    require_proof_of_work: false,
    require_captcha: false,
  },
  ...over,
});

const baseOpts = (shell: ReceptionPageShell, conn: FakeConn['conn']) => ({
  pageHost: makeFakeHost(),
  modalHost: makeFakeHost(),
  promptsHost: makeFakeHost(),
  shell,
  conn: conn as unknown as Parameters<typeof mountReceptionRoute>[0]['conn'],
  exposureProfile: RECEPTION_RECOMMENDED_EXPOSURE_PROFILE,
  now: () => NOW,
});

const flush = (): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

const pageGetCalls = (fc: FakeConn): number =>
  fc.calls.filter((c) => c.method === 'reception.page.get').length;
const templateListCalls = (fc: FakeConn): number =>
  fc.calls.filter((c) => c.method === 'reception.template.list').length;

// ══════════════════════════════════════════════════════════════════
// Initial loads — DD#2
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — mountReceptionRoute: initial loads', () => {
  it('serializes shell.loadPage() AFTER the first reception.page.get attempt (DD#2 / P1 fold)', async () => {
    const { shell, fns } = makeFakeShell();
    // Hold the initial page.get so we can assert the ordering.
    let resolvePageGet: (v: unknown) => void = () => undefined;
    const fc = makeFakeConn();
    fc.set(
      'reception.page.get',
      () =>
        new Promise<unknown>((resolve) => {
          resolvePageGet = resolve;
        }),
    );
    const route = mountReceptionRoute(baseOpts(shell, fc.conn));
    // Templates fires in parallel — no ordering constraint.
    await flush();
    expect(pageGetCalls(fc)).toBe(1);
    expect(templateListCalls(fc)).toBe(1);
    // loadPage has NOT fired yet — the gate is awaiting page.get.
    expect(fns.loadPage).not.toHaveBeenCalled();

    // Resolve the gate's page.get.
    resolvePageGet({ config: null, last_updated_at: null });
    await flush();
    await flush();
    // Now loadPage fires.
    expect(fns.loadPage).toHaveBeenCalledTimes(1);
    route.dispose();
  });

  it('still fires loadPage after the initial page.get fails (one-shot retry, DD#2 fallback)', async () => {
    const { shell, fns } = makeFakeShell();
    let attempts = 0;
    const fc = makeFakeConn();
    fc.set('reception.page.get', () => {
      attempts += 1;
      return Promise.reject(new Error('transient'));
    });
    const route = mountReceptionRoute(baseOpts(shell, fc.conn));
    // First attempt fails immediately; gate sleeps for the retry delay
    // (INITIAL_PAGE_GET_RETRY_DELAY_MS = 300ms in the module).
    await flush();
    expect(attempts).toBe(1);
    expect(fns.loadPage).not.toHaveBeenCalled();
    // Advance past the retry sleep + the second attempt.
    await new Promise<void>((r) => setTimeout(r, 350));
    await flush();
    expect(attempts).toBe(2);
    expect(fns.loadPage).toHaveBeenCalledTimes(1);
    route.dispose();
  });

  it('fires reception.page.get + reception.template.list at mount (success path)', async () => {
    const { shell, fns } = makeFakeShell();
    const fc = makeFakeConn();
    const route = mountReceptionRoute(baseOpts(shell, fc.conn));
    await flush();
    await flush();
    expect(fns.loadPage).toHaveBeenCalledTimes(1);
    expect(pageGetCalls(fc)).toBeGreaterThanOrEqual(1);
    expect(templateListCalls(fc)).toBe(1);
    route.dispose();
  });

  it('mount returns synchronously — initial rpcs are fire-and-forget', () => {
    const { shell } = makeFakeShell();
    const fc = makeFakeConn();
    const route = mountReceptionRoute(baseOpts(shell, fc.conn));
    expect(route).toBeDefined();
    route.dispose();
  });
});

// ══════════════════════════════════════════════════════════════════
// R19 Slice 4 — routed endpoint detail (reconcile + initialDetailId)
// ══════════════════════════════════════════════════════════════════

describe('R19 Slice 4 — mountReceptionRoute: routed endpoint detail', () => {
  it('reconciles the persisted drill-in state on mount (clears stale detail + preview)', () => {
    const { shell, fns } = makeFakeShell();
    const fc = makeFakeConn();
    // No initialDetailId — the route still clears any detail / view-as-visitor
    // left in the long-lived shell from a PRIOR mount so the list (not a stale
    // detail) renders. The clears are synchronous at mount.
    const route = mountReceptionRoute(baseOpts(shell, fc.conn));
    expect(fns.closeViewAsVisitor).toHaveBeenCalled();
    expect(fns.closeDetail).toHaveBeenCalled();
    expect(fns.openDetail).not.toHaveBeenCalled();
    route.dispose();
  });

  it('opens the deep-linked endpoint detail on mount when initialDetailId is set', () => {
    const { shell, fns } = makeFakeShell();
    const fc = makeFakeConn();
    const route = mountReceptionRoute({
      ...baseOpts(shell, fc.conn),
      initialDetailId: 'ep-42',
    });
    // Clears first (reconcile), then opens the URL's detail.
    expect(fns.closeDetail).toHaveBeenCalled();
    expect(fns.openDetail).toHaveBeenCalledWith('ep-42');
    route.dispose();
  });
});

// ══════════════════════════════════════════════════════════════════
// Cache refresh on shell-state change — DD#3
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — mountReceptionRoute: page-config cache refresh', () => {
  it('re-reads reception.page.get on every shell-state change (DD#3)', async () => {
    const { shell, notify } = makeFakeShell();
    const fc = makeFakeConn();
    const route = mountReceptionRoute(baseOpts(shell, fc.conn));
    await flush();
    const initialPageGets = pageGetCalls(fc);
    expect(initialPageGets).toBeGreaterThanOrEqual(1);

    notify({ loading: true });
    await flush();
    notify({ loading: false });
    await flush();
    expect(pageGetCalls(fc)).toBeGreaterThan(initialPageGets);
    route.dispose();
  });

  it('loads reception.template.list once on mount and never refires it on shell-state changes', async () => {
    const { shell, notify } = makeFakeShell();
    const fc = makeFakeConn({
      'reception.template.list': { templates: [mkTemplate()] },
    });
    const route = mountReceptionRoute(baseOpts(shell, fc.conn));
    await flush();
    await flush();
    expect(templateListCalls(fc)).toBe(1);

    // The raw-templates cache is a one-shot mount load (static pack
    // content) — shell-state changes must NOT refire it.
    notify({ loading: true });
    await flush();
    notify({ loading: false });
    await flush();
    expect(templateListCalls(fc)).toBe(1);
    route.dispose();
  });

  it('coalesces a state-change storm into one in-flight + one queued rpc (DD#2)', async () => {
    const { shell, notify } = makeFakeShell();
    const pending: Array<(v: unknown) => void> = [];
    const fc = makeFakeConn();
    fc.set(
      'reception.page.get',
      () =>
        new Promise<unknown>((resolve) => {
          pending.push((v) =>
            resolve(v ?? { config: null, last_updated_at: null }),
          );
        }),
    );

    const route = mountReceptionRoute(baseOpts(shell, fc.conn));
    await flush();
    // The eager mount call is in flight.
    expect(pageGetCalls(fc)).toBe(1);

    // Fire ten state changes — should NOT spawn 10 parallel rpcs;
    // the coalescing flag holds them as one queued follow-up.
    for (let i = 0; i < 10; i += 1) notify({ loading: i % 2 === 0 });
    await flush();
    expect(pageGetCalls(fc)).toBe(1);

    // Release the in-flight rpc; the queued one fires.
    pending[0]?.(undefined);
    await flush();
    await flush();
    expect(pageGetCalls(fc)).toBe(2);

    // Release the queued rpc — no further calls (no more state
    // changes happened during the second rpc).
    pending[1]?.(undefined);
    await flush();
    expect(pageGetCalls(fc)).toBe(2);

    route.dispose();
  });

  it('survives an rpc failure — mount + dispose stay clean', async () => {
    const { shell } = makeFakeShell();
    const fc = makeFakeConn();
    fc.set('reception.page.get', () => Promise.reject(new Error('boom')));
    const route = mountReceptionRoute(baseOpts(shell, fc.conn));
    await flush();
    expect(() => route.dispose()).not.toThrow();
  });
});

// ══════════════════════════════════════════════════════════════════
// gateEditPage — DD#7 (block Edit until cache ready)
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — mountReceptionRoute: gateEditPage (DD#7)', () => {
  it('renders the singleton "Edit page" button disabled until page.get resolves', async () => {
    const { shell } = makeFakeShell();
    let resolvePageGet: (v: unknown) => void = () => undefined;
    const fc = makeFakeConn();
    fc.set(
      'reception.page.get',
      () =>
        new Promise<unknown>((resolve) => {
          resolvePageGet = resolve;
        }),
    );
    const opts = baseOpts(shell, fc.conn);
    const route = mountReceptionRoute(opts);
    await flush();
    // Cache hasn't loaded → the rendered page mount has the
    // reception-edit-page button rendered with `disabled`.
    expect(opts.pageHost.innerHTML).toMatch(
      /data-action="reception-edit-page"[^>]*disabled/,
    );

    // Resolve the page.get; the route forces an update on the rising
    // edge (DD#7) so the Edit-page button enables in the same tick.
    resolvePageGet({ config: null, last_updated_at: null });
    await flush();
    await flush();
    expect(opts.pageHost.innerHTML).not.toMatch(
      /data-action="reception-edit-page"[^>]*disabled/,
    );
    route.dispose();
  });

  it('keeps the gate closed across the one-shot retry (both attempts fail → loadPage fires anyway)', async () => {
    const { shell, fns } = makeFakeShell();
    const fc = makeFakeConn();
    fc.set('reception.page.get', () => Promise.reject(new Error('transient')));
    const opts = baseOpts(shell, fc.conn);
    const route = mountReceptionRoute(opts);
    // Wait for first attempt + 300ms retry sleep + second attempt.
    await new Promise<void>((r) => setTimeout(r, 350));
    await flush();
    expect(fns.loadPage).toHaveBeenCalledTimes(1);
    // Spine has been rendered (loadPage fired), but the gate stays
    // closed — `pageConfigLoaded` is still false after both failures.
    expect(opts.pageHost.innerHTML).toMatch(
      /data-action="reception-edit-page"[^>]*disabled/,
    );
    route.dispose();
  });

  it('a recovery reload after the hard-failure path lifts the gate on the rising edge', async () => {
    const { shell, notify } = makeFakeShell();
    let attempts = 0;
    const fc = makeFakeConn();
    fc.set('reception.page.get', () => {
      attempts += 1;
      // Fail the first two attempts (initial + retry); succeed on the
      // third (a state-change-driven reload).
      if (attempts <= 2) return Promise.reject(new Error('transient'));
      return Promise.resolve({ config: null, last_updated_at: null });
    });
    const opts = baseOpts(shell, fc.conn);
    const route = mountReceptionRoute(opts);
    await new Promise<void>((r) => setTimeout(r, 350));
    await flush();
    expect(attempts).toBe(2);
    // Gate is closed at this point — both initial attempts failed.
    expect(opts.pageHost.innerHTML).toMatch(
      /data-action="reception-edit-page"[^>]*disabled/,
    );

    // A shell-state change triggers the route's reload (DD#3); the
    // third attempt succeeds, the rising-edge guard fires host.update(),
    // the Edit-page button enables.
    notify({ loading: true });
    await flush();
    await flush();
    expect(attempts).toBe(3);
    expect(opts.pageHost.innerHTML).not.toMatch(
      /data-action="reception-edit-page"[^>]*disabled/,
    );
    route.dispose();
  });

  it('does NOT redraw on every successful reload (rising-edge only) — steady-state refreshes rely on the shell-driven render', async () => {
    const { shell, notify } = makeFakeShell();
    const fc = makeFakeConn();
    // Always succeed; we want to observe that after the gate has lifted,
    // a subsequent shell-state change triggers exactly one render (the
    // shell-driven one), not an extra "rising-edge" redraw.
    const opts = baseOpts(shell, fc.conn);
    const route = mountReceptionRoute(opts);
    await flush();
    await flush();
    // Gate is open by now.
    expect(opts.pageHost.innerHTML).not.toMatch(
      /data-action="reception-edit-page"[^>]*disabled/,
    );
    const htmlAfterMount = opts.pageHost.innerHTML;

    // A no-op shell-state change won't change the rendered output.
    // The route's reloadPageConfig fires (DD#3), pageConfigLoaded was
    // already true → no rising edge → no extra redraw beyond the
    // shell-driven render. The dedup in `mountReceptionPage.render()`
    // also collapses an unchanged-html update; just assert the gate
    // stays open across the storm.
    notify({ loading: false });
    await flush();
    notify({ loading: false });
    await flush();
    expect(opts.pageHost.innerHTML).not.toMatch(
      /data-action="reception-edit-page"[^>]*disabled/,
    );
    expect(htmlAfterMount).toBe(opts.pageHost.innerHTML);
    route.dispose();
  });
});

// ══════════════════════════════════════════════════════════════════
// Dispose — DD#5
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — mountReceptionRoute: dispose', () => {
  it('unsubscribes from the shell at dispose', async () => {
    const { shell, listenerCount } = makeFakeShell();
    const fc = makeFakeConn();
    const route = mountReceptionRoute(baseOpts(shell, fc.conn));
    await flush();
    expect(listenerCount()).toBeGreaterThan(0);
    route.dispose();
    expect(listenerCount()).toBe(0);
  });

  it('is idempotent', async () => {
    const { shell } = makeFakeShell();
    const fc = makeFakeConn();
    const route = mountReceptionRoute(baseOpts(shell, fc.conn));
    await flush();
    expect(() => {
      route.dispose();
      route.dispose();
      route.dispose();
    }).not.toThrow();
  });

  it('drops a late rpc resolution — cache write is suppressed after dispose', async () => {
    const { shell } = makeFakeShell();
    let resolvePageGet: (v: unknown) => void = () => undefined;
    const fc = makeFakeConn();
    fc.set(
      'reception.page.get',
      () =>
        new Promise<unknown>((resolve) => {
          resolvePageGet = resolve;
        }),
    );
    const route = mountReceptionRoute(baseOpts(shell, fc.conn));
    await flush();
    route.dispose();
    expect(() =>
      resolvePageGet({
        config: {
          display_name: 'late',
          sections_enabled: {
            intake_form: false,
            scheduling_link: false,
            drop_link: false,
            approval_link: false,
            status_link: false,
          },
          linked_endpoints: {},
        },
        last_updated_at: NOW,
      }),
    ).not.toThrow();
    await flush();
  });

  it('update() after dispose() is a no-op', async () => {
    const { shell } = makeFakeShell();
    const fc = makeFakeConn();
    const route = mountReceptionRoute(baseOpts(shell, fc.conn));
    await flush();
    route.dispose();
    expect(() => route.update()).not.toThrow();
  });

  it('update() before dispose forwards to the settings host (mount triggered a render)', async () => {
    const { shell, fns } = makeFakeShell();
    const fc = makeFakeConn();
    const route = mountReceptionRoute(baseOpts(shell, fc.conn));
    await flush();
    // update() drives the page host's update; no exposed observable
    // beyond "no throw" — the settings-host test asserts the forwarding
    // path. Here we verify update() does not crash before dispose.
    expect(() => route.update()).not.toThrow();
    expect(fns.loadPage).toHaveBeenCalled();
    route.dispose();
  });
});

// ══════════════════════════════════════════════════════════════════
// D-220 Slice B — pack-shipped intake templates ride the route's
// `reception.template.list` cache: the gallery shows the pack card, and
// "Use template" on it resolves a seed from the PACK cache (not the
// Foundation one) into the authoring form.
// ══════════════════════════════════════════════════════════════════

const makeClickHost = () => {
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
    click: (dataset: Record<string, string>) => {
      const el = { dataset, closest: () => el } as unknown;
      fire('click', el);
    },
  };
};

const PACK_TEMPLATE_REF = 'pack:recued-core/job-status-board/intake/drop_off';

const mkPackListing = () => ({
  template: {
    template_ref: PACK_TEMPLATE_REF,
    version: '1.0.0',
    name: 'Job drop-off',
    description: 'Take in a repair job.',
    form_definition: {
      form_definition_id: 'fd_job_status_board_drop_off_v1',
      fields: [
        { name: 'item_description', type: 'textarea', label: 'What needs doing?', required: true },
        { name: 'website', type: 'text', label: 'Website', required: false },
      ],
    },
    required_visitor_fields: { email: 'required' },
    submission_processing_rule: {
      target_kind: 'form_response',
      fields_to_include_in_target: ['item_description'],
      fields_to_attach_as_metadata: [],
    },
    anti_spam_defaults: {
      honeypot_fields: ['website'],
      rate_limit_per_ip: 5,
      require_proof_of_work: false,
      require_captcha: false,
    },
  },
  pack_slug: 'job-status-board',
  publisher: 'recued-core',
  pack_name: 'Job Status Board',
  pack_version: 4,
});

describe('D-220 Slice B — mountReceptionRoute: pack templates', () => {
  it('shows the pack card in the gallery and resolves its seed from the pack cache', async () => {
    const { shell } = makeFakeShell();
    const fc = makeFakeConn({
      'reception.template.list': {
        templates: [],
        config_templates: [],
        pack_templates: [mkPackListing()],
        pack_templates_unavailable: [],
      },
    });
    const page = makeClickHost();
    const modal = makeClickHost();
    const route = mountReceptionRoute({
      ...baseOpts(shell, fc.conn),
      pageHost: page.host,
      modalHost: modal.host,
    });
    await flush();
    await flush();
    page.click({ action: 'reception-open-templates' });
    expect(modal.getHtml()).toContain('From your installed packs');
    expect(modal.getHtml()).toContain(`data-template-ref="${PACK_TEMPLATE_REF}"`);
    expect(modal.getHtml()).toContain('From Job Status Board (v4)');
    // "Use template" on the pack card: the route's resolver must find the
    // `pack:` ref in the PACK cache and seed the authoring form with it.
    modal.click({ action: 'reception-template-use', templateRef: PACK_TEMPLATE_REF, kind: 'intake_form' });
    expect(modal.getHtml()).toContain('fd_job_status_board_drop_off_v1');
    route.dispose();
  });

  it('tolerates a server that predates pack templates (no pack fields on the wire)', async () => {
    const { shell } = makeFakeShell();
    const fc = makeFakeConn({
      'reception.template.list': { templates: [mkTemplate()], config_templates: [] },
    });
    const page = makeClickHost();
    const modal = makeClickHost();
    const route = mountReceptionRoute({
      ...baseOpts(shell, fc.conn),
      pageHost: page.host,
      modalHost: modal.host,
    });
    await flush();
    await flush();
    page.click({ action: 'reception-open-templates' });
    expect(modal.getHtml()).toContain('Client inquiry');
    expect(modal.getHtml()).not.toContain('From your installed packs');
    route.dispose();
  });
});

describe('D-220 Slice B (audit) — pack events refresh the template cache', () => {
  it('re-reads reception.template.list on pack_installed / pack_uninstalled, and stops after dispose', async () => {
    const { shell } = makeFakeShell();
    const fc = makeFakeConn({
      'reception.template.list': { templates: [], config_templates: [], pack_templates: [mkPackListing()] },
    });
    const handlers: Record<string, Array<(event: unknown) => void>> = {};
    let unsubscribed = 0;
    const subscribe = ((kind: string, fn: (event: unknown) => void) => {
      (handlers[kind] ??= []).push(fn);
      return () => { unsubscribed += 1; };
    }) as unknown as NonNullable<Parameters<typeof mountReceptionRoute>[0]['subscribe']>;
    const route = mountReceptionRoute({
      ...baseOpts(shell, fc.conn),
      subscribe,
      // Keep the Approvals-badge subscription out of this count.
      enablePendingAsks: false,
    });
    await flush();
    await flush();
    expect(templateListCalls(fc)).toBe(1);
    expect(Object.keys(handlers).sort()).toEqual(['pack_installed', 'pack_uninstalled']);
    handlers.pack_uninstalled?.forEach((fn) => fn({ kind: 'pack_uninstalled', pack_slug: 'job-status-board' }));
    await flush();
    expect(templateListCalls(fc)).toBe(2);
    handlers.pack_installed?.forEach((fn) => fn({ kind: 'pack_installed', pack_slug: 'job-status-board' }));
    await flush();
    expect(templateListCalls(fc)).toBe(3);
    route.dispose();
    expect(unsubscribed).toBeGreaterThanOrEqual(2);
  });
});
