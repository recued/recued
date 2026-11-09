import { describe, expect, it, vi } from 'vitest';

import { mountSidePanel, sameSitesLists } from '../mount.js';
import { createSidePanelStore, type SidePanelSitesState } from '../store/local-store.js';
import { createSidePanelFolds, SIDE_PANEL_FOLD_ATTR, SIDE_PANEL_FOLDS_STORAGE_KEY } from '../folds.js';
import { createDiagnosticSummaryCopy, formatDiagnosticSummary } from '../diagnostic-summary.js';
import {
  SIDE_PANEL_PAIR_HOST_ATTR,
  SIDE_PANEL_PAIR_SECTION_ATTR,
  SIDE_PANEL_SECTION_ATTR,
  SIDE_PANEL_WATCH_BUTTON_ATTR,
  SIDE_PANEL_WATCH_CTA_ATTR,
  SIDE_PANEL_DIAGNOSTIC_REFRESH_ATTR,
  SIDE_PANEL_DIAGNOSTIC_COPY_ATTR,
  SIDE_PANEL_DIAGNOSTIC_SUMMARY_ATTR,
} from '../views.js';

interface FakeElement {
  tagName: string;
  textContent: string;
  className: string;
  children: FakeElement[];
  parent: FakeElement | null;
  attrs: Map<string, string>;
  listeners: Map<string, Array<() => void>>;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  addEventListener(type: string, handler: () => void): void;
  appendChild(el: FakeElement): FakeElement;
  removeChild(el: FakeElement): FakeElement;
  readonly firstChild: FakeElement | null;
}

/** Fire every registered listener of `type` on a fake element (test-only —
 *  the fake has no real event dispatch). */
const fireEvent = (el: FakeElement, type: string): void => {
  for (const handler of el.listeners.get(type) ?? []) handler();
};

interface FakeDocument {
  createElement(tag: string): FakeElement;
  getElementById(id: string): FakeElement | null;
}

const makeFakeDocument = (withRoot = true): { doc: FakeDocument; root: FakeElement | null } => {
  const byId = new Map<string, FakeElement>();
  const make = (tagName: string): FakeElement => {
    const el: FakeElement = {
      tagName: tagName.toUpperCase(),
      textContent: '',
      className: '',
      children: [],
      parent: null,
      attrs: new Map(),
      listeners: new Map(),
      setAttribute(k, v) {
        el.attrs.set(k, v);
        if (k === 'id') byId.set(v, el);
      },
      getAttribute(k) {
        return el.attrs.get(k) ?? null;
      },
      hasAttribute(k) {
        return el.attrs.has(k);
      },
      addEventListener(type, handler) {
        const list = el.listeners.get(type) ?? [];
        list.push(handler);
        el.listeners.set(type, list);
      },
      appendChild(child) {
        el.children.push(child);
        child.parent = el;
        return child;
      },
      removeChild(child) {
        const idx = el.children.indexOf(child);
        if (idx < 0) throw new Error('removeChild: not a child');
        el.children.splice(idx, 1);
        child.parent = null;
        return child;
      },
      get firstChild() {
        return el.children[0] ?? null;
      },
    };
    return el;
  };
  const root = withRoot ? make('main') : null;
  if (root) root.setAttribute('id', 'root');
  return {
    root,
    doc: {
      createElement: make,
      getElementById(id) {
        return byId.get(id) ?? null;
      },
    },
  };
};

const findByAttr = (
  root: FakeElement,
  attr: string,
  value?: string,
): FakeElement | null => {
  if (
    root.hasAttribute(attr)
    && (value === undefined || root.getAttribute(attr) === value)
  ) {
    return root;
  }
  for (const child of root.children) {
    const hit = findByAttr(child, attr, value);
    if (hit) return hit;
  }
  return null;
};

const countByAttr = (root: FakeElement, attr: string): number => {
  let count = root.hasAttribute(attr) ? 1 : 0;
  for (const child of root.children) count += countByAttr(child, attr);
  return count;
};

const textOf = (el: FakeElement): string =>
  `${el.textContent}${el.children.map(textOf).join('')}`;

const pairedNotif = (notification: boolean) => ({
  pair: {
    paired: true,
    server_url: 'https://local.recued.test',
    server_display_name: 'Local Recued',
  },
  notifications: {
    items: [{ id: 'n1', text: 'A live notification', fired_at: 1 }],
    fetched_at: 1,
    error: null,
  },
  bridge_mode: { notification, approval: false },
});

describe('D-169 P1 side-panel mount', () => {
  it('keeps copy feedback and the click guard through polling without triggering a refresh', async () => {
    const { doc, root } = makeFakeDocument();
    const store = createSidePanelStore({ pair: pairedNotif(false).pair });
    let release!: () => void, copying: Promise<void> | undefined;
    const write = vi.fn((_text: string) => new Promise<void>(resolve => { release = resolve; }));
    const copy = createDiagnosticSummaryCopy({
      getSummary: () => formatDiagnosticSummary(store.getState().diagnostic, { bridgeVersion: '0.0.2', createdAt: 1_700_000_000_000 }),
      canCopy: () => store.getState().pair.paired, writeText: write,
      getScope: () => ({ server_public_key: 'server', token_id: 'owner' }),
      apply: state => store.applyDiagnosticCopyState(state),
    });
    const onRefreshDiagnostic = vi.fn();
    const mounted = mountSidePanel({ document: doc as unknown as Document, store, onRefreshDiagnostic,
      onCopyDiagnostic: () => { copying = copy.copy(); } });
    const button = (): FakeElement => findByAttr(root!, SIDE_PANEL_DIAGNOSTIC_COPY_ATTR)!;
    expect(button().getAttribute('aria-disabled')).toBe('false');
    fireEvent(button(), 'click');
    expect(button().textContent).toBe('Copying…');
    store.applyDiagnosticFrame({ ...store.getState().diagnostic, refreshing: true });
    fireEvent(button(), 'click');
    expect(write).toHaveBeenCalledTimes(1);
    expect(onRefreshDiagnostic).not.toHaveBeenCalled();
    expect(button().getAttribute('aria-disabled')).toBe('true');
    release(); await copying;
    expect(textOf(root!)).toContain('Diagnostic summary copied.');
    store.applyDiagnosticFrame({ ...store.getState().diagnostic, refreshing: false });
    expect(textOf(root!)).toContain('Diagnostic summary copied.');
    expect(button().getAttribute('aria-disabled')).toBe('false');
    mounted.dispose(); copy.dispose();
  });

  it('keeps a manual-copy summary through refreshes and removes it on unpair', async () => {
    const { doc, root } = makeFakeDocument();
    const store = createSidePanelStore({ pair: pairedNotif(false).pair });
    const copy = createDiagnosticSummaryCopy({ getSummary: () => 'Allowlisted summary',
      getScope: () => ({ server_public_key: 'server', token_id: 'owner' }),
      canCopy: () => store.getState().pair.paired, apply: state => store.applyDiagnosticCopyState(state) });
    const mounted = mountSidePanel({ document: doc as unknown as Document, store, onCopyDiagnostic: () => { void copy.copy(); } });
    fireEvent(findByAttr(root!, SIDE_PANEL_DIAGNOSTIC_COPY_ATTR)!, 'click');
    expect(findByAttr(root!, SIDE_PANEL_DIAGNOSTIC_SUMMARY_ATTR)?.textContent).toBe('Allowlisted summary');
    store.applyDiagnosticFrame({ ...store.getState().diagnostic, pending_command_count: 99 });
    expect(findByAttr(root!, SIDE_PANEL_DIAGNOSTIC_SUMMARY_ATTR)?.textContent).toBe('Allowlisted summary');
    copy.invalidate(); store.reset();
    expect(findByAttr(root!, SIDE_PANEL_DIAGNOSTIC_SUMMARY_ATTR)).toBeNull();
    expect(findByAttr(root!, SIDE_PANEL_DIAGNOSTIC_COPY_ATTR)).toBeNull();
    mounted.dispose(); copy.dispose();
  });

  it('routes manual refreshes and refuses repeated clicks while a diagnostic read is pending', () => {
    const { doc, root } = makeFakeDocument();
    const store = createSidePanelStore({ pair: pairedNotif(false).pair });
    const onRefreshDiagnostic = vi.fn();
    const mounted = mountSidePanel({ document: doc as unknown as Document, store, onRefreshDiagnostic });
    const button = (): FakeElement => findByAttr(root!, SIDE_PANEL_DIAGNOSTIC_REFRESH_ATTR)!;
    expect(button().getAttribute('aria-disabled')).toBe('false');
    fireEvent(button(), 'click');
    expect(onRefreshDiagnostic).toHaveBeenCalledTimes(1);
    store.applyDiagnosticFrame({ ...store.getState().diagnostic, refreshing: true });
    expect(button().textContent).toBe('Refreshing…');
    fireEvent(button(), 'click');
    expect(onRefreshDiagnostic).toHaveBeenCalledTimes(1);
    store.applyDiagnosticFrame({ ...store.getState().diagnostic, refreshing: false });
    fireEvent(button(), 'click');
    expect(onRefreshDiagnostic).toHaveBeenCalledTimes(2);
    mounted.dispose();
  });

  it('D-347 follow-up 20 — what is typed in Sites is carried over a status or a message, not over a site added or removed', () => {
    const sites: SidePanelSitesState = { every_site: true, screenshots: false, blocked: ['bank.example'], message: '',
      keep: [{ entry: { site: 'console.example.com', every_minutes: 10, mode: 'session' } }] };
    expect(sameSitesLists(sites, { ...sites, message: 'Chrome did not allow every site, so nothing changed.', every_site: false }))
      .toBe(true);
    expect(sameSitesLists(sites, { ...sites, keep: [{ ...sites.keep![0]!,
      status: { next_at: 2, last: { at: 1, what: 'kept', said: 'Kept the session.' } } }] })).toBe(true);
    expect(sameSitesLists(sites, { ...sites, blocked: ['bank.example', 'mail.example'] })).toBe(false);
    expect(sameSitesLists(sites, { ...sites, keep: [] })).toBe(false);
    expect(sameSitesLists(sites, { ...sites, keep: [{ entry: { site: 'console.example.com', every_minutes: 5, mode: 'session' } }] }))
      .toBe(false);
  });

  it("throws when <main id='root'> is absent", () => {
    const { doc } = makeFakeDocument(false);

    expect(() =>
      mountSidePanel({
        document: doc as unknown as Document,
        store: createSidePanelStore(),
      }),
    ).toThrow(/expected <main id="root">/);
  });

  it('mounts only the pairing section when unpaired, with the pair form in its slot', () => {
    const { doc, root } = makeFakeDocument();
    const slots: FakeElement[] = [];

    mountSidePanel({
      document: doc as unknown as Document,
      store: createSidePanelStore(),
      mountPairing: (slot) => {
        slots.push(slot as unknown as FakeElement);
        return { dispose: () => undefined };
      },
    });

    expect(root!.children).toHaveLength(1);
    expect(findByAttr(root!, SIDE_PANEL_PAIR_SECTION_ATTR)).not.toBeNull();
    expect(countByAttr(root!, SIDE_PANEL_SECTION_ATTR)).toBe(0);
    expect(slots).toHaveLength(1);
    expect(slots[0]).toBe(findByAttr(root!, SIDE_PANEL_PAIR_HOST_ATTR));
  });

  it('keeps the pair form through store updates while unpaired, and disposes it once paired', () => {
    const { doc, root } = makeFakeDocument();
    const store = createSidePanelStore();
    const dispose = vi.fn();
    const mountPairing = vi.fn(() => ({ dispose }));
    mountSidePanel({
      document: doc as unknown as Document,
      store,
      now: () => 1_800_000_000_000,
      mountPairing,
    });
    // finalize writes the server URL first: a new unpaired pair state. The
    // form holds what the user typed, so it must not be rebuilt.
    store.reset({ paired: false, server_url: 'wss://local.recued.test/ws', server_display_name: null });
    expect(mountPairing).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();

    store.applyPairState({
      paired: true,
      server_url: 'wss://local.recued.test/ws',
      server_display_name: null,
    });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(findByAttr(root!, SIDE_PANEL_PAIR_SECTION_ATTR)).toBeNull();
    expect(countByAttr(root!, SIDE_PANEL_SECTION_ATTR)).toBe(8);

    // Unpaired again (the stored pair removed): a fresh form.
    store.reset({ paired: false, server_url: null, server_display_name: null });
    expect(mountPairing).toHaveBeenCalledTimes(2);
  });

  it('mounts the side-panel sections when paired, approvals first', () => {
    const { doc, root } = makeFakeDocument();
    const store = createSidePanelStore({
      pair: {
        paired: true,
        server_url: 'https://local.recued.test',
        server_display_name: 'Local Recued',
      },
    });

    mountSidePanel({
      document: doc as unknown as Document,
      store,
      now: () => 1_800_000_000_000,
    });

    expect(findByAttr(root!, SIDE_PANEL_PAIR_SECTION_ATTR)).toBeNull();
    expect(countByAttr(root!, SIDE_PANEL_SECTION_ATTR)).toBe(8);
    // 2026-11-04 — approvals lead, then what is happening now, then this
    // browser's settings; the "Watch this element" CTA is a section of its own.
    expect(root!.children.map((el) => el.getAttribute(SIDE_PANEL_SECTION_ATTR))).toEqual([
      'approvals',
      'active-executions',
      'notifications',
      'recipe-results',
      'watch',
      'sites',
      'server-status',
      'bridge-diagnostic',
    ]);
  });

  it('2026-11-04 — a section the owner opened stays open through a re-render, and the choice is kept', () => {
    const { doc, root } = makeFakeDocument();
    const saved = new Map<string, string>();
    const store = createSidePanelStore({
      pair: { paired: true, server_url: 'https://local.recued.test', server_display_name: 'Local Recued' },
    });
    mountSidePanel({
      document: doc as unknown as Document,
      store,
      now: () => 1_800_000_000_000,
      folds: createSidePanelFolds({ getItem: (k) => saved.get(k) ?? null, setItem: (k, v) => { saved.set(k, v); } }),
    });
    const sites = () => findByAttr(root!, SIDE_PANEL_FOLD_ATTR, 'sites') as FakeElement & { open?: boolean };
    expect(sites().open).toBe(false);
    sites().open = true;
    fireEvent(sites(), 'toggle');
    expect(JSON.parse(saved.get(SIDE_PANEL_FOLDS_STORAGE_KEY)!)).toEqual({ sites: true });
    // A change to the section rebuilds it: it stays as the owner left it.
    store.applySitesState({ every_site: true, screenshots: false, blocked: ['bank.example.com'], message: '' });
    expect(sites().open).toBe(true);
    expect(textOf(sites())).toContain('bank.example.com');
  });

  it('2026-11-04 — the server opens by itself when it needs the owner, and the header says so', () => {
    const { doc, root } = makeFakeDocument();
    const pill = doc.createElement('span') as FakeElement & { hidden?: boolean };
    pill.setAttribute('id', 'header-status');
    const store = createSidePanelStore({
      pair: { paired: true, server_url: 'https://local.recued.test', server_display_name: 'Local Recued' },
      status: { fetched_at: 1, error: null, status: {
        name: 'Local Recued', version: '26.11.4', uptime_seconds: 1, paired_client_count: 1, paired_client_connected: 0,
        ws_state: 'offline', last_sync_at: null, executions_last_hour: null, executions_last_24h: null, pending_asks: null,
        ask_load: null, schedule_queue_depth: null, recent_error_count: null, keyfile_sealing: 'none', snapshot_at: 1,
      } },
    });
    mountSidePanel({ document: doc as unknown as Document, store, now: () => 1_800_000_000_000 });
    const server = findByAttr(root!, SIDE_PANEL_FOLD_ATTR, 'server-status') as FakeElement & { open?: boolean };
    expect(server.open).toBe(true);
    expect(textOf(server)).toContain('Offline · keyfile not sealed');
    expect(pill.textContent).toBe('Offline');
    expect(pill.className).toContain('pill-danger');
    expect(pill.hidden).toBe(false);
  });

  it('re-renders from the pairing section to sections on store change without refetching', () => {
    const { doc, root } = makeFakeDocument();
    const store = createSidePanelStore();
    mountSidePanel({
      document: doc as unknown as Document,
      store,
      now: () => 1_800_000_000_000,
    });
    expect(findByAttr(root!, SIDE_PANEL_PAIR_SECTION_ATTR)).not.toBeNull();

    store.applyPairState({
      paired: true,
      server_url: 'https://local.recued.test',
      server_display_name: 'Local Recued',
    });

    expect(findByAttr(root!, SIDE_PANEL_PAIR_SECTION_ATTR)).toBeNull();
    expect(countByAttr(root!, SIDE_PANEL_SECTION_ATTR)).toBe(8);
  });

  it('dispose removes rendered DOM and unsubscribes from future patches', () => {
    const { doc, root } = makeFakeDocument();
    const store = createSidePanelStore({
      pair: {
        paired: true,
        server_url: 'https://local.recued.test',
        server_display_name: 'Local Recued',
      },
    });
    const mounted = mountSidePanel({
      document: doc as unknown as Document,
      store,
      now: () => 1_800_000_000_000,
    });
    expect(root!.children.length).toBeGreaterThan(0);

    mounted.dispose();
    expect(root!.children).toHaveLength(0);

    expect(() =>
      store.applyPairState({
        paired: false,
        server_url: null,
        server_display_name: null,
      }),
    ).not.toThrow();
    expect(root!.children).toHaveLength(0);
  });

  it('gates the notifications section on the bridge notification mode (off → affordance)', () => {
    const { doc, root } = makeFakeDocument();
    mountSidePanel({
      document: doc as unknown as Document,
      store: createSidePanelStore(pairedNotif(false)),
      now: () => 1_800_000_000_000,
    });

    // The section element is still present (always-rendered shell)...
    expect(countByAttr(root!, SIDE_PANEL_SECTION_ATTR)).toBe(8);
    const section = findByAttr(root!, SIDE_PANEL_SECTION_ATTR, 'notifications');
    expect(section).not.toBeNull();
    // ...but it shows the webclient-config affordance, not the live item.
    expect(textOf(section!)).toContain('turn them on in the webclient');
    expect(textOf(section!)).not.toContain('A live notification');
  });

  it('renders the live notifications list when the bridge notification mode is on', () => {
    const { doc, root } = makeFakeDocument();
    mountSidePanel({
      document: doc as unknown as Document,
      store: createSidePanelStore(pairedNotif(true)),
      now: () => 1_800_000_000_000,
    });

    const section = findByAttr(root!, SIDE_PANEL_SECTION_ATTR, 'notifications');
    expect(section).not.toBeNull();
    expect(textOf(section!)).toContain('A live notification');
    expect(textOf(section!)).not.toContain('turn them on in the webclient');
  });

  it('D-163 O-1 — says when Chrome turns off this Bridge\'s notifications, and stops when it shows them again', () => {
    const { doc, root } = makeFakeDocument();
    const store = createSidePanelStore(pairedNotif(true));
    mountSidePanel({ document: doc as unknown as Document, store, now: () => 1_800_000_000_000 });
    const section = (): FakeElement => findByAttr(root!, SIDE_PANEL_SECTION_ATTR, 'notifications')!;
    expect(textOf(section())).not.toContain('Chrome has notifications from Recued Bridge turned off');
    store.applyDesktopNotifications('denied');
    expect(textOf(section())).toContain('Chrome has notifications from Recued Bridge turned off');
    expect(textOf(section())).toContain('A live notification');
    store.applyDesktopNotifications('granted');
    expect(textOf(section())).not.toContain('Chrome has notifications from Recued Bridge turned off');
  });

  it('the Disconnect under the server\'s status asks first, through the handlers the panel was given', () => {
    const { doc, root } = makeFakeDocument();
    const store = createSidePanelStore(pairedNotif(true));
    const onAsk = vi.fn(() => store.applyDisconnectState({ phase: 'confirming', message: '' }));
    const onConfirm = vi.fn(async () => undefined);
    mountSidePanel({ document: doc as unknown as Document, store, now: () => 1_800_000_000_000,
      disconnect: { onAsk, onCancel: vi.fn(), onConfirm } });
    const status = (): FakeElement => findByAttr(root!, SIDE_PANEL_SECTION_ATTR, 'server-status')!;
    fireEvent(findByAttr(status(), 'data-recued-side-panel-disconnect', 'ask')!, 'click');
    expect(onAsk).toHaveBeenCalledTimes(1);
    expect(textOf(status())).toContain('Disconnect this bridge from Local Recued?');
    fireEvent(findByAttr(status(), 'data-recued-side-panel-disconnect', 'confirm')!, 'click');
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('renders the "Watch this element" CTA and wires the launch handler', () => {
    const { doc, root } = makeFakeDocument();
    const onLaunchPicker = vi.fn();
    mountSidePanel({
      document: doc as unknown as Document,
      store: createSidePanelStore({
        pair: {
          paired: true,
          server_url: 'https://local.recued.test',
          server_display_name: 'Local Recued',
        },
      }),
      now: () => 1_800_000_000_000,
      onLaunchPicker,
    });

    // 2026-11-04 — the CTA sits in a section of its own, so it folds as the others do.
    expect(findByAttr(root!, SIDE_PANEL_WATCH_CTA_ATTR)).not.toBeNull();
    expect(countByAttr(root!, SIDE_PANEL_SECTION_ATTR)).toBe(8);

    const button = findByAttr(root!, SIDE_PANEL_WATCH_BUTTON_ATTR);
    expect(button).not.toBeNull();
    fireEvent(button!, 'click');
    expect(onLaunchPicker).toHaveBeenCalledTimes(1);
  });

  it('renders the watch CTA status line from the store', () => {
    const { doc, root } = makeFakeDocument();
    mountSidePanel({
      document: doc as unknown as Document,
      store: createSidePanelStore({
        pair: {
          paired: true,
          server_url: 'https://local.recued.test',
          server_display_name: 'Local Recued',
        },
        element_watch: {
          message: 'Watch created — it is off. Enable it in the webclient.',
          tone: 'info',
          webclient_link: true,
        },
      }),
      now: () => 1_800_000_000_000,
    });

    const cta = findByAttr(root!, SIDE_PANEL_WATCH_CTA_ATTR);
    expect(cta).not.toBeNull();
    expect(textOf(cta!)).toContain('Watch created');
  });

  it('preserves an unchanged approvals surface across unrelated polls', () => {
    const { doc, root } = makeFakeDocument();
    const approval = {
      ask_id: 'ask-1',
      title: 'Send update?',
      text: 'Send the weekly update now?',
      options: [{ id: 'yes', label: 'Send' }],
      created_at: 1_799_999_999_000,
    };
    const store = createSidePanelStore({
      pair: {
        paired: true,
        server_url: 'https://local.recued.test',
        server_display_name: 'Local Recued',
      },
      approvals: {
        items: [approval],
        fetched_at: 1,
        error: null,
      },
    });
    mountSidePanel({
      document: doc as unknown as Document,
      store,
      now: () => 1_800_000_000_000,
    });

    const first = findByAttr(root!, SIDE_PANEL_SECTION_ATTR, 'approvals');
    expect(first).not.toBeNull();

    store.applyStatusFrame({ status: null, fetched_at: 2, error: null });
    expect(findByAttr(root!, SIDE_PANEL_SECTION_ATTR, 'approvals')).toBe(first);

    store.applyBusFrames(
      {
        recipe_results: [],
        notifications: [],
        approvals: [{ ...approval, options: [{ ...approval.options[0]! }] }],
      },
      { fetched_at: 3, error: null },
    );
    expect(findByAttr(root!, SIDE_PANEL_SECTION_ATTR, 'approvals')).toBe(first);

    store.applyBusFrames(
      {
        recipe_results: [],
        notifications: [],
        approvals: [{ ...approval, text: 'Changed copy' }],
      },
      { fetched_at: 4, error: null },
    );
    expect(findByAttr(root!, SIDE_PANEL_SECTION_ATTR, 'approvals')).not.toBe(first);
  });

  it('replaces approvals loading with the first authoritative empty state', () => {
    const { doc, root } = makeFakeDocument();
    const store = createSidePanelStore({
      pair: {
        paired: true,
        server_url: 'https://local.recued.test',
        server_display_name: 'Local Recued',
      },
    });
    mountSidePanel({
      document: doc as unknown as Document,
      store,
      now: () => 1_800_000_000_000,
    });
    expect(
      textOf(findByAttr(root!, SIDE_PANEL_SECTION_ATTR, 'approvals')!),
    ).toContain('Loading approvals');

    store.applyBusFrames(
      { recipe_results: [], notifications: [], approvals: [] },
      { fetched_at: 1_800_000_000_000, error: null },
    );
    expect(
      textOf(findByAttr(root!, SIDE_PANEL_SECTION_ATTR, 'approvals')!),
    ).toContain('No pending approvals');
  });
});
