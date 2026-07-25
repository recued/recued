/** D-149 follow-on § A.9 — Reception Settings PWA bootstrap acceptance.
 *
 *  `bootstrapReceptionRoute` is the DOM boundary above
 *  `mountReceptionRoute` — the one place in the webclient that calls
 *  `document.createElement`. These tests drive it through a fake
 *  Document (the webclient ships no jsdom in vitest) + a fake shell +
 *  a fake rpc conn, asserting the observable wire: which slot divs
 *  were appended where, whether the styles were injected once,
 *  whether dispose detaches the slot divs.
 *
 *  The fake Element supports the host-shape members the existing
 *  reception mounts use (innerHTML / addEventListener /
 *  removeEventListener / contains) PLUS the new bootstrap-touched
 *  members (setAttribute / getAttribute / appendChild / remove /
 *  textContent). The fake Document supports the two head members the
 *  bootstrap reaches for (querySelector / appendChild) + createElement.
 */

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

import {
  bootstrapReceptionRoute,
  RECEPTION_BOOTSTRAP_STYLES,
  RECEPTION_BOOTSTRAP_STYLES_MARKER,
} from '../settings/reception-bootstrap.js';
import type {
  LaunchWizardRunResult,
  ReceptionPageShell,
  ReceptionPageShellState,
} from '../settings/reception-page-shell.js';
import { buildReceptionPageModel } from '../settings/reception.js';

const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

// ──────────────────────────────────────────────────────────────────
// Fake Element — supports the host-shape members existing reception
// mounts use + the new bootstrap-touched members.
// ──────────────────────────────────────────────────────────────────

interface FakeElement extends HTMLElement {
  attrs: Map<string, string>;
  childList: FakeElement[];
  parentRef: FakeElement | null;
  /** Replay the registered listeners for an event (test-only). */
  fireEvent: (evt: string, target: unknown) => void;
}

const makeFakeElement = (tag: string): FakeElement => {
  let html = '';
  let textContent = '';
  const listeners: Record<string, Set<(event: Event) => void>> = {};
  const attrs = new Map<string, string>();
  const childList: FakeElement[] = [];
  const el: Partial<FakeElement> & { _ref?: FakeElement } = {
    tagName: tag.toUpperCase(),
    attrs,
    childList,
    parentRef: null,
    get innerHTML() {
      return html;
    },
    set innerHTML(value: string) {
      html = value;
    },
    get textContent() {
      return textContent;
    },
    set textContent(value: string) {
      textContent = value;
    },
    addEventListener: (evt: string, fn: (event: Event) => void): void => {
      (listeners[evt] ??= new Set()).add(fn);
    },
    removeEventListener: (evt: string, fn: (event: Event) => void): void => {
      listeners[evt]?.delete(fn);
    },
    fireEvent: (evt: string, target: unknown): void => {
      for (const fn of [...(listeners[evt] ?? [])]) {
        fn({ target, type: evt, preventDefault: () => {} } as unknown as Event);
      }
    },
    contains: (): boolean => true,
    setAttribute: (name: string, value: string): void => {
      attrs.set(name, value);
    },
    getAttribute: (name: string): string | null => attrs.get(name) ?? null,
    hasAttribute: (name: string): boolean => attrs.has(name),
    removeAttribute: (name: string): void => {
      attrs.delete(name);
    },
    appendChild: ((child: FakeElement): FakeElement => {
      childList.push(child);
      child.parentRef = el as FakeElement;
      return child;
    }) as unknown as HTMLElement['appendChild'],
    remove: (): void => {
      if (el.parentRef !== null && el.parentRef !== undefined) {
        const idx = el.parentRef.childList.indexOf(el as FakeElement);
        if (idx >= 0) el.parentRef.childList.splice(idx, 1);
      }
      el.parentRef = null;
    },
  };
  return el as FakeElement;
};

// ──────────────────────────────────────────────────────────────────
// Fake Document — the minimal surface the bootstrap touches.
// ──────────────────────────────────────────────────────────────────

interface FakeDocument extends Document {
  styleElements: FakeElement[];
}

const makeFakeDocument = (): FakeDocument => {
  const styleElements: FakeElement[] = [];
  // The bootstrap's selector is `style[<attr-name>]`. Parse it minimally.
  const matchSelector = (sel: string): { tag: string; attr: string } | null => {
    const m = sel.match(/^([\w-]+)\[([\w-]+)\]$/);
    if (m === null) return null;
    return { tag: m[1]!.toUpperCase(), attr: m[2]! };
  };
  const head: Partial<HTMLHeadElement> = {
    querySelector: (selector: string): FakeElement | null => {
      const parsed = matchSelector(selector);
      if (parsed === null) return null;
      const found = styleElements.find(
        (s) => s.tagName === parsed.tag && s.attrs.has(parsed.attr),
      );
      return found ?? null;
    },
    appendChild: ((el: FakeElement): FakeElement => {
      styleElements.push(el);
      return el;
    }) as unknown as HTMLHeadElement['appendChild'],
  };
  const doc: Partial<FakeDocument> = {
    head: head as HTMLHeadElement,
    styleElements,
    createElement: (tag: string): FakeElement => makeFakeElement(tag),
  };
  return doc as FakeDocument;
};

// ──────────────────────────────────────────────────────────────────
// Fake shell — same pattern as reception-route.test.ts.
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
  const current: ReceptionPageShellState = {
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
  return { shell, fns, listenerCount: () => listeners.size };
};

// ──────────────────────────────────────────────────────────────────
// Fake conn — record every call + serve default success responses.
// ──────────────────────────────────────────────────────────────────

interface FakeConn {
  conn: (method: string, payload?: unknown) => Promise<unknown>;
  calls: Array<{ method: string; payload: unknown }>;
}

const makeFakeConn = (): FakeConn => {
  const calls: Array<{ method: string; payload: unknown }> = [];
  const defaults: Record<string, unknown> = {
    'reception.page.get': { config: null, last_updated_at: null },
    'reception.template.list': { templates: [] as IntakeFormTemplate[] },
    // R19 — the Inbox section (the default) mounts the inbox panel, which
    // fetches `reception.inbox.list` on mount; the destination picker reads
    // `work_entity.source.list` lazily (kept here for completeness).
    'reception.inbox.list': { items: [] },
    'work_entity.source.list': { sources: [] },
    'reception.intake_recipe_pair.get': {
      endpoint_id: 'intake-1',
      status: 'unpaired',
      binding: null,
      created_at: null,
      updated_at: null,
    },
    'recipe.list': { recipes: [] },
  };
  const conn = (method: string, payload?: unknown): Promise<unknown> => {
    calls.push({ method, payload });
    return Promise.resolve(defaults[method] ?? undefined);
  };
  return { conn, calls };
};

const baseOpts = (
  root: FakeElement,
  fakeDoc: FakeDocument,
  shell: ReceptionPageShell,
  conn: FakeConn['conn'],
): Parameters<typeof bootstrapReceptionRoute>[0] => ({
  root,
  shell,
  conn: conn as unknown as Parameters<typeof bootstrapReceptionRoute>[0]['conn'],
  exposureProfile: RECEPTION_RECOMMENDED_EXPOSURE_PROFILE,
  document: fakeDoc,
  now: () => NOW,
});

const flush = (): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Synthesize a delegated `data-action` click on a fake element (the
 *  dispatcher reads `target.closest('[data-action]').dataset.action`). */
const fireAction = (el: FakeElement, dataset: Record<string, string>): void => {
  const node = { dataset, closest: () => node } as unknown;
  el.fireEvent('click', node);
};

// ══════════════════════════════════════════════════════════════════
// DOM construction
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — bootstrapReceptionRoute: route chrome + sections (R19)', () => {
  it('renders the route chrome — header + section tab bar + content host', () => {
    const fakeDoc = makeFakeDocument();
    const root = makeFakeElement('div');
    const { shell } = makeFakeShell();
    const fc = makeFakeConn();
    const route = bootstrapReceptionRoute(baseOpts(root, fakeDoc, shell, fc.conn));
    // One route root appended to the caller-supplied root.
    expect(root.childList.length).toBe(1);
    const routeRoot = root.childList[0]!;
    expect(routeRoot.attrs.has('data-recued-reception-route')).toBe(true);
    // header + tab bar + content.
    expect(routeRoot.childList.length).toBe(3);
    const header = routeRoot.childList[0]!;
    expect(header.childList.map((node) => node.textContent)).toEqual([
      'Reception',
      'Review incoming requests, protect public access, and manage every visitor-facing endpoint.',
    ]);
    const tabBar = routeRoot.childList[1]!;
    expect(tabBar.attrs.has('data-recued-reception-route-tabs')).toBe(true);
    // Sections in frequency order: inbox · records · abuse · endpoints (D-210 §4c added
    // `records` second — see `r19-reception-sections.test.ts` for the vocabulary ratchet).
    expect(tabBar.childList.map((a) => a.attrs.get('href'))).toEqual([
      '#reception/inbox',
      '#reception/records',
      '#reception/abuse',
      '#reception/endpoints',
    ]);
    expect(tabBar.childList.map((a) => a.textContent)).toEqual([
      'Inbox',
      'Records',
      'Abuse',
      'Endpoints',
    ]);
    route.dispose();
  });

  it('defaults to the Inbox section (active tab = Inbox; fetches the inbox list, NOT the spine)', async () => {
    const fakeDoc = makeFakeDocument();
    const root = makeFakeElement('div');
    const { shell, fns } = makeFakeShell();
    const fc = makeFakeConn();
    const route = bootstrapReceptionRoute(baseOpts(root, fakeDoc, shell, fc.conn));
    expect(route.activeSection()).toBe('inbox');
    const tabBar = root.childList[0]!.childList[1]!;
    expect(tabBar.childList[0]!.attrs.get('aria-current')).toBe('page'); // Inbox
    expect(tabBar.childList[2]!.attrs.has('aria-current')).toBe(false); // Endpoints
    await flush();
    expect(fc.calls.some((c) => c.method === 'reception.inbox.list')).toBe(true);
    // The Endpoints spine is NOT mounted for the Inbox section.
    expect(fns.loadPage).not.toHaveBeenCalled();
    expect(fc.calls.some((c) => c.method === 'reception.page.get')).toBe(false);
    route.dispose();
  });

  it('mounts the Endpoints spine (page main + modal + prompts slots) for #reception/endpoints', async () => {
    const fakeDoc = makeFakeDocument();
    const root = makeFakeElement('div');
    const { shell, listenerCount, fns } = makeFakeShell();
    const fc = makeFakeConn();
    const route = bootstrapReceptionRoute({
      ...baseOpts(root, fakeDoc, shell, fc.conn),
      initialSection: 'endpoints',
    });
    expect(route.activeSection()).toBe('endpoints');
    const content = root.childList[0]!.childList[2]!;
    expect(content.childList.length).toBe(3);
    expect(content.childList[0]!.attrs.has('data-reception-shell-page-main')).toBe(true);
    expect(content.childList[1]!.attrs.get('data-reception-shell-slot')).toBe('modal');
    expect(content.childList[2]!.attrs.get('data-reception-shell-slot')).toBe('prompts');
    // The spine subscribes to the shell + fires the spine's initial rpcs.
    expect(listenerCount()).toBeGreaterThan(0);
    await flush();
    await flush();
    expect(fns.loadPage).toHaveBeenCalledTimes(1);
    expect(fc.calls.some((c) => c.method === 'reception.page.get')).toBe(true);
    expect(fc.calls.some((c) => c.method === 'reception.template.list')).toBe(true);
    route.dispose();
  });

  it('mounts the Abuse section for #reception/abuse (subscribes + auto-loads the abuse inbox)', async () => {
    const fakeDoc = makeFakeDocument();
    const root = makeFakeElement('div');
    const { shell, listenerCount, fns } = makeFakeShell();
    const fc = makeFakeConn();
    const route = bootstrapReceptionRoute({
      ...baseOpts(root, fakeDoc, shell, fc.conn),
      initialSection: 'abuse',
    });
    expect(route.activeSection()).toBe('abuse');
    expect(listenerCount()).toBeGreaterThan(0);
    await flush();
    expect(fns.loadAbuseInbox).toHaveBeenCalled();
    // The spine is NOT mounted for the Abuse section.
    expect(fns.loadPage).not.toHaveBeenCalled();
    route.dispose();
  });

  it('degrades an unknown section to the Inbox default', () => {
    const fakeDoc = makeFakeDocument();
    const root = makeFakeElement('div');
    const { shell } = makeFakeShell();
    const fc = makeFakeConn();
    const route = bootstrapReceptionRoute({
      ...baseOpts(root, fakeDoc, shell, fc.conn),
      initialSection: 'not_a_section',
    });
    expect(route.activeSection()).toBe('inbox');
    route.dispose();
  });
});

// ══════════════════════════════════════════════════════════════════
// R19 Slice 2 — routed full-page authoring (#reception/endpoints/new|edit)
// ══════════════════════════════════════════════════════════════════

describe('R19 Slice 2 — bootstrapReceptionRoute: routed authoring', () => {
  it('mounts the authoring section (NOT the spine) for #reception/endpoints/new/<kind>', () => {
    const fakeDoc = makeFakeDocument();
    const root = makeFakeElement('div');
    const { shell, fns } = makeFakeShell();
    const fc = makeFakeConn();
    const route = bootstrapReceptionRoute({
      ...baseOpts(root, fakeDoc, shell, fc.conn),
      initialSection: 'endpoints',
      initialSubview: 'new',
      initialKind: 'scheduling_link',
    });
    expect(route.activeSection()).toBe('endpoints');
    const content = root.childList[0]!.childList[2]!;
    // The authoring page mounted — NOT the spine's page/modal/prompts triad.
    expect(content.childList[0]!.attrs.get('data-reception-authoring-section')).toBe('new');
    expect(content.childList.some((c) => c.attrs.has('data-reception-shell-page-main'))).toBe(false);
    // The spine's list fetch never fired (the authoring page doesn't mount it).
    expect(fns.loadPage).not.toHaveBeenCalled();
    expect(fc.calls.some((c) => c.method === 'reception.template.list')).toBe(false);
    route.dispose();
  });

  it('mounts the authoring section in edit mode + fetches the singleton for #reception/endpoints/edit/reception_page', async () => {
    const fakeDoc = makeFakeDocument();
    const root = makeFakeElement('div');
    const { shell } = makeFakeShell();
    const fc = makeFakeConn();
    const route = bootstrapReceptionRoute({
      ...baseOpts(root, fakeDoc, shell, fc.conn),
      initialSection: 'endpoints',
      initialSubview: 'edit',
      initialKind: 'reception_page',
    });
    const content = root.childList[0]!.childList[2]!;
    expect(content.childList[0]!.attrs.get('data-reception-authoring-section')).toBe('edit');
    await flush();
    // Edit mode re-reads the live singleton (fetch-before-seed).
    expect(fc.calls.some((c) => c.method === 'reception.page.get')).toBe(true);
    route.dispose();
  });

  it('a segment-1 that is not an authoring verb mounts the spine (NOT authoring) — it is a detail id (Slice 4)', () => {
    const fakeDoc = makeFakeDocument();
    const root = makeFakeElement('div');
    const { shell, fns } = makeFakeShell();
    const fc = makeFakeConn();
    const route = bootstrapReceptionRoute({
      ...baseOpts(root, fakeDoc, shell, fc.conn),
      initialSection: 'endpoints',
      initialSubview: 'ep-some-id', // not new|edit|setup → an endpoint-detail id
    });
    const content = root.childList[0]!.childList[2]!;
    // The spine mounted (detail is a spine sub-view), NOT the authoring page.
    expect(content.childList[0]!.attrs.has('data-reception-shell-page-main')).toBe(true);
    expect(content.childList[0]!.attrs.has('data-reception-authoring-section')).toBe(false);
    // ...and the spine opened that endpoint's detail on mount (Slice 4).
    expect(fns.openDetail).toHaveBeenCalledWith('ep-some-id');
    route.dispose();
  });

  it('falls through to the spine LIST for #reception/endpoints/edit/<link-kind> (only reception_page has edit; no detail open)', () => {
    const fakeDoc = makeFakeDocument();
    const root = makeFakeElement('div');
    const { shell, fns } = makeFakeShell();
    const fc = makeFakeConn();
    const route = bootstrapReceptionRoute({
      ...baseOpts(root, fakeDoc, shell, fc.conn),
      initialSection: 'endpoints',
      initialSubview: 'edit',
      initialKind: 'scheduling_link', // a link kind — not editable
    });
    const content = root.childList[0]!.childList[2]!;
    expect(content.childList[0]!.attrs.has('data-reception-shell-page-main')).toBe(true);
    expect(content.childList[0]!.attrs.has('data-reception-authoring-section')).toBe(false);
    // `edit` is an authoring verb (excluded from the detail-id set), so the
    // spine shows the list — it does NOT open a detail.
    expect(fns.openDetail).not.toHaveBeenCalled();
    route.dispose();
  });

  it('falls through to the spine LIST for the create-hidden status_link kind (no detail open)', () => {
    const fakeDoc = makeFakeDocument();
    const root = makeFakeElement('div');
    const { shell, fns } = makeFakeShell();
    const fc = makeFakeConn();
    const route = bootstrapReceptionRoute({
      ...baseOpts(root, fakeDoc, shell, fc.conn),
      initialSection: 'endpoints',
      initialSubview: 'new',
      initialKind: 'status_link',
    });
    const content = root.childList[0]!.childList[2]!;
    expect(content.childList[0]!.attrs.has('data-reception-shell-page-main')).toBe(true);
    // `new` is an authoring verb — the list, not a detail.
    expect(fns.openDetail).not.toHaveBeenCalled();
    route.dispose();
  });

  it('the spine wires onEnterAuthoring → navigate to the routed authoring hash', () => {
    const fakeDoc = makeFakeDocument();
    const root = makeFakeElement('div');
    const { shell } = makeFakeShell();
    const fc = makeFakeConn();
    const navigate = vi.fn();
    const route = bootstrapReceptionRoute({
      ...baseOpts(root, fakeDoc, shell, fc.conn),
      initialSection: 'endpoints',
      navigate,
    });
    // The spine's page-main slot carries the page mount's click dispatcher.
    const content = root.childList[0]!.childList[2]!;
    const pageMain = content.childList[0]!;
    // Synthesize a "New scheduling link" click — the page host's
    // onEnterAuthoring seam (wired by the bootstrap) navigates instead of
    // opening the modal.
    fireAction(pageMain, { action: 'reception-new-endpoint', kind: 'scheduling_link' });
    expect(navigate).toHaveBeenCalledWith('#reception/endpoints/new/scheduling_link');
    route.dispose();
  });
});

// ══════════════════════════════════════════════════════════════════
// R19 Slice 3 — routed Launch Wizard
// ══════════════════════════════════════════════════════════════════

describe('R19 Slice 3 — bootstrapReceptionRoute: routed wizard', () => {
  it('mounts the wizard section (NOT the spine) for #reception/endpoints/setup', () => {
    const fakeDoc = makeFakeDocument();
    const root = makeFakeElement('div');
    const { shell, fns } = makeFakeShell();
    const fc = makeFakeConn();
    const route = bootstrapReceptionRoute({
      ...baseOpts(root, fakeDoc, shell, fc.conn),
      initialSection: 'endpoints',
      initialSubview: 'setup',
    });
    expect(route.activeSection()).toBe('endpoints');
    const content = root.childList[0]!.childList[2]!;
    // The wizard page mounted — NOT the spine's page/modal/prompts triad.
    expect(content.childList[0]!.attrs.has('data-reception-wizard-section')).toBe(true);
    expect(content.childList.some((c) => c.attrs.has('data-reception-shell-page-main'))).toBe(false);
    // The spine's list fetch never fired (the wizard page doesn't mount it).
    expect(fns.loadPage).not.toHaveBeenCalled();
    expect(fc.calls.some((c) => c.method === 'reception.template.list')).toBe(false);
    route.dispose();
  });

  it('the spine wires onEnterWizard → navigate to the routed wizard hash', () => {
    const fakeDoc = makeFakeDocument();
    const root = makeFakeElement('div');
    const { shell } = makeFakeShell();
    const fc = makeFakeConn();
    const navigate = vi.fn();
    const route = bootstrapReceptionRoute({
      ...baseOpts(root, fakeDoc, shell, fc.conn),
      initialSection: 'endpoints',
      navigate,
    });
    // The spine's page-main slot carries the page mount's click dispatcher.
    const content = root.childList[0]!.childList[2]!;
    const pageMain = content.childList[0]!;
    // Synthesize a "Start the Launch Wizard" click — the page host's
    // onEnterWizard seam (wired by the bootstrap) navigates instead of
    // opening the modal.
    fireAction(pageMain, { action: 'reception-launch-wizard' });
    expect(navigate).toHaveBeenCalledWith('#reception/endpoints/setup');
    route.dispose();
  });

  it('removes the wizard section from content on dispose', () => {
    const fakeDoc = makeFakeDocument();
    const root = makeFakeElement('div');
    const { shell } = makeFakeShell();
    const fc = makeFakeConn();
    const route = bootstrapReceptionRoute({
      ...baseOpts(root, fakeDoc, shell, fc.conn),
      initialSection: 'endpoints',
      initialSubview: 'setup',
    });
    const content = root.childList[0]!.childList[2]!;
    expect(content.childList.length).toBe(1);
    route.dispose();
    expect(content.childList.length).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════
// R19 Slice 4 — routed endpoint detail (#reception/endpoints/<id>)
// ══════════════════════════════════════════════════════════════════

describe('R19 Slice 4 — bootstrapReceptionRoute: routed endpoint detail', () => {
  it('opens the deep-linked endpoint detail on mount + reconciles stale drill-in state', () => {
    const fakeDoc = makeFakeDocument();
    const root = makeFakeElement('div');
    const { shell, fns } = makeFakeShell();
    const fc = makeFakeConn();
    const route = bootstrapReceptionRoute({
      ...baseOpts(root, fakeDoc, shell, fc.conn),
      initialSection: 'endpoints',
      initialSubview: 'ep-7', // an endpoint-detail id
    });
    // The spine reconciles the long-lived shell's drill-in state on mount
    // (the shell outlives route re-mounts) THEN opens the URL's detail.
    expect(fns.closeViewAsVisitor).toHaveBeenCalled();
    expect(fns.openDetail).toHaveBeenCalledWith('ep-7');
    route.dispose();
  });

  it('does NOT open a detail for the plain endpoints list (#reception/endpoints) + clears any stale detail', () => {
    const fakeDoc = makeFakeDocument();
    const root = makeFakeElement('div');
    const { shell, fns } = makeFakeShell();
    const fc = makeFakeConn();
    const route = bootstrapReceptionRoute({
      ...baseOpts(root, fakeDoc, shell, fc.conn),
      initialSection: 'endpoints',
      // no initialSubview — the list
    });
    expect(fns.openDetail).not.toHaveBeenCalled();
    // The reconcile still clears any detail / preview persisted from a prior
    // mount so the list (not a stale detail) renders.
    expect(fns.closeDetail).toHaveBeenCalled();
    expect(fns.closeViewAsVisitor).toHaveBeenCalled();
    route.dispose();
  });

  it('the spine wires onEnterDetail → navigate to the endpoint-detail hash (per-row "Detail")', () => {
    const fakeDoc = makeFakeDocument();
    const root = makeFakeElement('div');
    const { shell, fns } = makeFakeShell();
    const fc = makeFakeConn();
    const navigate = vi.fn();
    const route = bootstrapReceptionRoute({
      ...baseOpts(root, fakeDoc, shell, fc.conn),
      initialSection: 'endpoints',
      navigate,
    });
    const content = root.childList[0]!.childList[2]!;
    const pageMain = content.childList[0]!;
    // A per-row "Detail" click navigates to the deep link instead of the
    // in-place shell open.
    fireAction(pageMain, { action: 'reception-open-detail', endpointId: 'ep-7' });
    expect(navigate).toHaveBeenCalledWith('#reception/endpoints/ep-7');
    expect(fns.openDetail).not.toHaveBeenCalled();
    route.dispose();
  });

  it('the spine wires onExitDetail → navigate back to the endpoints list ("Back to Reception")', () => {
    const fakeDoc = makeFakeDocument();
    const root = makeFakeElement('div');
    const { shell, fns } = makeFakeShell();
    const fc = makeFakeConn();
    const navigate = vi.fn();
    const route = bootstrapReceptionRoute({
      ...baseOpts(root, fakeDoc, shell, fc.conn),
      initialSection: 'endpoints',
      navigate,
    });
    const content = root.childList[0]!.childList[2]!;
    const pageMain = content.childList[0]!;
    // `closeDetail` is called once by the mount reconcile; the click must NOT
    // add a second in-place call — it navigates instead.
    const closeCallsBeforeClick = fns.closeDetail.mock.calls.length;
    fireAction(pageMain, { action: 'reception-close-detail' });
    expect(navigate).toHaveBeenCalledWith('#reception/endpoints');
    expect(fns.closeDetail.mock.calls.length).toBe(closeCallsBeforeClick);
    route.dispose();
  });
});

// ══════════════════════════════════════════════════════════════════
// D-200 Slice 6g.4 — routed fixed intake-form/recipe pair selector
// ══════════════════════════════════════════════════════════════════

describe('D-200 Slice 6g.4 — bootstrapReceptionRoute: pair selector', () => {
  it('mounts the selector instead of the spine for #reception/endpoints/pair/<id>', async () => {
    const fakeDoc = makeFakeDocument();
    const root = makeFakeElement('div');
    const { shell, fns } = makeFakeShell();
    const fc = makeFakeConn();
    const route = bootstrapReceptionRoute({
      ...baseOpts(root, fakeDoc, shell, fc.conn),
      initialSection: 'endpoints',
      initialSubview: 'pair',
      initialKind: 'intake-1',
    });
    await flush();

    const content = root.childList[0]!.childList[2]!;
    expect(content.innerHTML).toContain(
      'data-reception-intake-recipe-pair-section="intake-1"',
    );
    expect(content.childList.some((child) =>
      child.attrs.has('data-reception-shell-page-main'))).toBe(false);
    expect(fns.loadPage).not.toHaveBeenCalled();
    expect(fc.calls).toContainEqual({
      method: 'reception.intake_recipe_pair.get',
      payload: { endpoint_id: 'intake-1' },
    });
    expect(fc.calls).toContainEqual({ method: 'recipe.list', payload: undefined });

    route.dispose();
    expect(content.innerHTML).toBe('');
  });

  it('routes an intake-row pair action with the endpoint id as an encoded segment', () => {
    const fakeDoc = makeFakeDocument();
    const root = makeFakeElement('div');
    const { shell } = makeFakeShell();
    const fc = makeFakeConn();
    const navigate = vi.fn();
    const route = bootstrapReceptionRoute({
      ...baseOpts(root, fakeDoc, shell, fc.conn),
      initialSection: 'endpoints',
      navigate,
    });
    const content = root.childList[0]!.childList[2]!;
    const pageMain = content.childList[0]!;

    fireAction(pageMain, {
      action: 'reception-pair-intake-recipe',
      endpointId: 'intake/owner',
    });

    expect(navigate).toHaveBeenCalledWith(
      '#reception/endpoints/pair/intake%2Fowner',
    );
    route.dispose();
  });

  it('keeps the pair broadcast subscription when the separate Approvals badge is disabled', async () => {
    const fakeDoc = makeFakeDocument();
    const root = makeFakeElement('div');
    const { shell } = makeFakeShell();
    const fc = makeFakeConn();
    const kinds: string[] = [];
    const subscribe = ((kind: string) => {
      kinds.push(kind);
      return () => {};
    }) as unknown as NonNullable<
      Parameters<typeof bootstrapReceptionRoute>[0]['subscribe']
    >;
    const route = bootstrapReceptionRoute({
      ...baseOpts(root, fakeDoc, shell, fc.conn),
      initialSection: 'endpoints',
      initialSubview: 'pair',
      initialKind: 'intake-1',
      subscribe,
      enablePendingAsks: false,
    });
    await flush();

    expect(kinds).toEqual(['reception.endpoint_changed']);
    expect(fc.calls.some((call) =>
      call.method === 'notification.pending_asks')).toBe(false);

    route.dispose();
  });
});

// ══════════════════════════════════════════════════════════════════
// Style injection
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — bootstrapReceptionRoute: style injection', () => {
  it('injects exactly one <style> tag carrying the aggregated payload + marker', () => {
    const fakeDoc = makeFakeDocument();
    const root = makeFakeElement('div');
    const { shell } = makeFakeShell();
    const fc = makeFakeConn();
    const route = bootstrapReceptionRoute(baseOpts(root, fakeDoc, shell, fc.conn));
    expect(fakeDoc.styleElements.length).toBe(1);
    const style = fakeDoc.styleElements[0]!;
    expect(style.tagName).toBe('STYLE');
    expect(style.attrs.has(RECEPTION_BOOTSTRAP_STYLES_MARKER)).toBe(true);
    expect(style.textContent).toBe(RECEPTION_BOOTSTRAP_STYLES);
    route.dispose();
  });

  it('is idempotent across two bootstraps on the same document (no duplicate <style> tags)', () => {
    const fakeDoc = makeFakeDocument();
    const root1 = makeFakeElement('div');
    const root2 = makeFakeElement('div');
    const { shell } = makeFakeShell();
    const fc1 = makeFakeConn();
    const fc2 = makeFakeConn();
    const r1 = bootstrapReceptionRoute(baseOpts(root1, fakeDoc, shell, fc1.conn));
    const r2 = bootstrapReceptionRoute(baseOpts(root2, fakeDoc, shell, fc2.conn));
    expect(fakeDoc.styleElements.length).toBe(1);
    r1.dispose();
    r2.dispose();
  });

  it('keeps the <style> tag after dispose (it is global; another route may share it)', () => {
    const fakeDoc = makeFakeDocument();
    const root = makeFakeElement('div');
    const { shell } = makeFakeShell();
    const fc = makeFakeConn();
    const route = bootstrapReceptionRoute(baseOpts(root, fakeDoc, shell, fc.conn));
    expect(fakeDoc.styleElements.length).toBe(1);
    route.dispose();
    expect(fakeDoc.styleElements.length).toBe(1);
  });

  it('aggregates the expected style layers (PRIMITIVE + the reception layers incl. R19 section nav)', () => {
    // Sanity-check the payload contains representative selectors from
    // each layer — keeps a future refactor honest.
    expect(RECEPTION_BOOTSTRAP_STYLES).toContain('.rx-btn'); // PRIMITIVE_STYLES
    expect(RECEPTION_BOOTSTRAP_STYLES).toContain('[data-recued-reception-route-tabs]'); // R19 section nav
    expect(RECEPTION_BOOTSTRAP_STYLES).toContain('[data-reception-shell-slot="modal"]'); // overlay shell styles
    expect(RECEPTION_BOOTSTRAP_STYLES).toContain('.reception-page'); // page renderer
    expect(RECEPTION_BOOTSTRAP_STYLES).toContain('.reception-form'); // authoring renderer
    expect(RECEPTION_BOOTSTRAP_STYLES).toContain('.reception-wizard'); // wizard renderer
    expect(RECEPTION_BOOTSTRAP_STYLES).toContain('.reception-intake-recipe-pair-section'); // D-200 pair selector
  });
});

// ══════════════════════════════════════════════════════════════════
// Dispose
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — bootstrapReceptionRoute: dispose', () => {
  it('removes the route chrome from root + tears down the active section mount', () => {
    const fakeDoc = makeFakeDocument();
    const root = makeFakeElement('div');
    const { shell, listenerCount } = makeFakeShell();
    const fc = makeFakeConn();
    // Use the Endpoints section so the spine subscribes to the shell — the
    // teardown is observable as a dropped shell listener.
    const route = bootstrapReceptionRoute({
      ...baseOpts(root, fakeDoc, shell, fc.conn),
      initialSection: 'endpoints',
    });
    expect(root.childList.length).toBe(1);
    expect(listenerCount()).toBeGreaterThan(0);
    route.dispose();
    expect(root.childList.length).toBe(0);
    expect(listenerCount()).toBe(0);
  });

  it('is idempotent', () => {
    const fakeDoc = makeFakeDocument();
    const root = makeFakeElement('div');
    const { shell } = makeFakeShell();
    const fc = makeFakeConn();
    const route = bootstrapReceptionRoute(baseOpts(root, fakeDoc, shell, fc.conn));
    expect(() => {
      route.dispose();
      route.dispose();
      route.dispose();
    }).not.toThrow();
  });

  it('update() after dispose() is a no-op', () => {
    const fakeDoc = makeFakeDocument();
    const root = makeFakeElement('div');
    const { shell } = makeFakeShell();
    const fc = makeFakeConn();
    const route = bootstrapReceptionRoute(baseOpts(root, fakeDoc, shell, fc.conn));
    route.dispose();
    expect(() => route.update()).not.toThrow();
  });
});

// ══════════════════════════════════════════════════════════════════
// Document seam
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — bootstrapReceptionRoute: document seam', () => {
  it('throws a clear error when neither opts.document nor globalThis.document is available', () => {
    const root = makeFakeElement('div');
    const { shell } = makeFakeShell();
    const fc = makeFakeConn();
    // The vitest node env has no `document` global, so omitting the
    // seam reaches the runtime guard.
    expect(() =>
      bootstrapReceptionRoute({
        root,
        shell,
        conn: fc.conn as unknown as Parameters<typeof bootstrapReceptionRoute>[0]['conn'],
        exposureProfile: RECEPTION_RECOMMENDED_EXPOSURE_PROFILE,
      }),
    ).toThrow(/no document available/);
  });
});

// ══════════════════════════════════════════════════════════════════
// Seam forwarding
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — bootstrapReceptionRoute: seam forwarding', () => {
  it('forwards now / buildPacketDeclaration / renderWizardStepContent / onSwitchProfile / onPromptClose to the route', async () => {
    const fakeDoc = makeFakeDocument();
    const root = makeFakeElement('div');
    const { shell } = makeFakeShell();
    const fc = makeFakeConn();
    const now = vi.fn(() => NOW);
    const buildPacketDeclaration = vi.fn(
      (_kind: string, _config: object): PacketDeclaration | null => null,
    );
    const renderWizardStepContent = vi.fn((_stepId: string): string | null => null);
    const onSwitchProfile = vi.fn();
    const onPromptClose = vi.fn();
    // These seams (buildPacketDeclaration / renderWizardStepContent /
    // onSwitchProfile / onPromptClose) are SPINE seams — only the
    // Endpoints section forwards them, so target it.
    const route = bootstrapReceptionRoute({
      ...baseOpts(root, fakeDoc, shell, fc.conn),
      initialSection: 'endpoints',
      now,
      buildPacketDeclaration,
      renderWizardStepContent,
      onSwitchProfile,
      onPromptClose,
    });
    // The `now` seam is reached during mount renders.
    expect(now).toHaveBeenCalled();
    await flush();
    route.dispose();
  });
});
