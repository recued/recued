/** 2026-11-04 — the side panel's foldable sections (`folds.ts`): what each folded line says, which
 *  sections start open, and that the owner's choice is kept. The fold's DOM is checked on a fake
 *  document, as the panel's other tests are; a real `<details>` is driven in Chromium by the
 *  panel's screenshot harness. */

import { describe, expect, it, vi } from 'vitest';

import {
  createSidePanelFolds,
  foldOpenByDefault,
  foldSection,
  foldSummary,
  SIDE_PANEL_FOLD_ATTR,
  SIDE_PANEL_FOLDS_STORAGE_KEY,
} from '../folds.js';
import { createSidePanelStore, type SidePanelStoreState } from '../store/local-store.js';
import { SIDE_PANEL_SECTION_ATTR } from '../views.js';

const NOW = 1_800_000_000_000;

interface FakeElement {
  tagName: string;
  textContent: string;
  className: string;
  open?: boolean;
  children: FakeElement[];
  attrs: Map<string, string>;
  listeners: Map<string, Array<() => void>>;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  addEventListener(type: string, handler: () => void): void;
  appendChild(el: FakeElement): FakeElement;
  removeChild(el: FakeElement): FakeElement;
  readonly firstChild: FakeElement | null;
}

const fakeDocument = () => {
  const make = (tag: string): FakeElement => {
    const el: FakeElement = {
      tagName: tag.toUpperCase(), textContent: '', className: '', children: [], attrs: new Map(), listeners: new Map(),
      setAttribute(k, v) { el.attrs.set(k, v); },
      getAttribute(k) { return el.attrs.get(k) ?? null; },
      addEventListener(type, handler) { el.listeners.set(type, [...(el.listeners.get(type) ?? []), handler]); },
      appendChild(child) { el.children.push(child); return child; },
      removeChild(child) { el.children.splice(el.children.indexOf(child), 1); return child; },
      get firstChild() { return el.children[0] ?? null; },
    };
    return el;
  };
  return { createElement: make } as unknown as Document;
};

/** A rendered section as `views.ts` builds one: its heading, then its body. */
const renderedSection = (doc: Document, id: string) => {
  const section = doc.createElement('section');
  section.setAttribute(SIDE_PANEL_SECTION_ATTR, id);
  const h2 = doc.createElement('h2');
  h2.textContent = 'Server status';
  section.appendChild(h2);
  const body = doc.createElement('div');
  body.textContent = 'the rows';
  section.appendChild(body);
  return { section: section as unknown as FakeElement & HTMLElement, body: body as unknown as FakeElement };
};

const state = (patch: (store: ReturnType<typeof createSidePanelStore>) => void = () => undefined): SidePanelStoreState => {
  const store = createSidePanelStore({ pair: { paired: true, server_url: 'https://s.test', server_display_name: 'Home' } });
  patch(store);
  return store.getState();
};

const status = (over: Record<string, unknown> = {}) => ({
  name: 'Home', version: '26.11.4', uptime_seconds: 60, paired_client_count: 2, paired_client_connected: 1,
  ws_state: 'serving', last_sync_at: NOW, executions_last_hour: 1, executions_last_24h: 2, pending_asks: 0,
  ask_load: null, schedule_queue_depth: 0, recent_error_count: 0, keyfile_sealing: 'machine', snapshot_at: NOW, ...over,
}) as never;

const memoryStorage = (initial?: string) => {
  const data = new Map<string, string>(initial !== undefined ? [[SIDE_PANEL_FOLDS_STORAGE_KEY, initial]] : []);
  return { data, getItem: vi.fn((k: string) => data.get(k) ?? null), setItem: vi.fn((k: string, v: string) => { data.set(k, v); }) };
};

describe('2026-11-04 — the owner\'s open-or-closed sections are kept', () => {
  it('reads the choices saved before, and keeps each new one with them', () => {
    const storage = memoryStorage(JSON.stringify({ sites: true, 'server-status': false }));
    const folds = createSidePanelFolds(storage);
    expect(folds.get('sites')).toBe(true);
    expect(folds.get('server-status')).toBe(false);
    expect(folds.get('notifications')).toBeUndefined();
    folds.set('notifications', true);
    expect(JSON.parse(storage.data.get(SIDE_PANEL_FOLDS_STORAGE_KEY)!)).toEqual({
      sites: true, 'server-status': false, notifications: true,
    });
  });

  it('ignores what it cannot read: another section\'s name, a value that is not yes or no, broken JSON', () => {
    expect(createSidePanelFolds(memoryStorage(JSON.stringify({ approvals: true, sites: 'yes' }))).get('sites')).toBeUndefined();
    expect(createSidePanelFolds(memoryStorage('{broken')).get('sites')).toBeUndefined();
    expect(createSidePanelFolds(memoryStorage('[true]')).get('sites')).toBeUndefined();
  });

  it('a store that throws costs the memory, never the panel', () => {
    const folds = createSidePanelFolds({
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    });
    folds.set('sites', true);
    expect(folds.get('sites')).toBe(true);
    const unstored = createSidePanelFolds();
    unstored.set('watch', false);
    expect(unstored.get('watch')).toBe(false);
  });
});

describe('2026-11-04 — a section starts open only where something happens now or needs the owner', () => {
  it('nothing running, nothing wrong: every section starts folded', () => {
    const quiet = state((store) => {
      store.applyStatusFrame({ status: status(), fetched_at: NOW, error: null });
      store.applySitesState({ every_site: true, screenshots: false, blocked: [], message: '' });
    });
    for (const id of ['active-executions', 'notifications', 'recipe-results', 'watch', 'sites', 'server-status'] as const) {
      expect(foldOpenByDefault(id, quiet), id).toBe(false);
    }
  });

  it('opens what runs, and what needs the owner: the server offline, unreachable or unsealed, a site not allowed, a disconnect', () => {
    const running = state((store) => store.applyActiveFrame({ entries: [{ state: 'running' }] as never, lanes: [],
      fetched_at: NOW, error: null, notice: '' }));
    expect(foldOpenByDefault('active-executions', running)).toBe(true);
    for (const frame of [
      { status: status({ ws_state: 'offline' }), fetched_at: NOW, error: null },
      { status: status({ keyfile_sealing: 'none' }), fetched_at: NOW, error: null },
      { status: null, fetched_at: null, error: 'socket closed' },
    ]) {
      expect(foldOpenByDefault('server-status', state((store) => store.applyStatusFrame(frame))), JSON.stringify(frame)).toBe(true);
    }
    expect(foldOpenByDefault('server-status', state((store) => store.applyStatusFrame({ status: null, fetched_at: null,
      error: 'bridge_connecting' })))).toBe(false);
    expect(foldOpenByDefault('server-status', state((store) => store.applyDisconnectState({ phase: 'confirming', message: '' }))))
      .toBe(true);
    expect(foldOpenByDefault('sites', state((store) => store.applySitesState({ every_site: false, screenshots: null,
      blocked: [], message: '' })))).toBe(true);
    expect(foldOpenByDefault('watch', state((store) => store.applyElementWatchStatus({ message: 'Watch created',
      tone: 'info', webclient_link: true })))).toBe(true);
  });
});

describe('2026-11-04 — a folded section says what it holds now', () => {
  it('what runs, what was said, what ran', () => {
    const busy = state((store) => {
      store.applyActiveFrame({ entries: [{ state: 'running' }, { state: 'waiting_slot' }] as never, lanes: [],
        fetched_at: NOW, error: null, notice: '' });
      store.applyBridgeMode({ notification: true, approval: true });
      store.applyBusFrames({
        recipe_results: [
          { run_id: 'a', recipe_id: 'a', status: 'ok', started_at: NOW, duration_ms: 1 },
          { run_id: 'b', recipe_id: 'b', status: 'error', started_at: NOW, duration_ms: 1 },
        ],
        notifications: [{ id: 'n1', text: 'old', fired_at: NOW - 3_600_000 }, { id: 'n2', text: 'new', fired_at: NOW - 600_000 }],
        approvals: [],
      }, { fetched_at: NOW, error: null });
    });
    expect(foldSummary('active-executions', busy, NOW)).toEqual({ text: '1 running · 1 waiting', tone: 'muted' });
    expect(foldSummary('notifications', busy, NOW)).toEqual({ text: '2 · latest 10m ago', tone: 'muted' });
    expect(foldSummary('recipe-results', busy, NOW)).toEqual({ text: '2 · 1 failed', tone: 'danger' });
  });

  it('nothing yet, and not loaded yet, are told apart', () => {
    const fresh = state((store) => store.applyBridgeMode({ notification: true, approval: true }));
    expect(foldSummary('recipe-results', fresh, NOW).text).toBe('Loading…');
    const loaded = state((store) => {
      store.applyBridgeMode({ notification: true, approval: true });
      store.applyBusFrames({ recipe_results: [], notifications: [], approvals: [] }, { fetched_at: NOW, error: null });
      store.applyActiveFrame({ entries: [], lanes: [], fetched_at: NOW, error: null, notice: '' });
    });
    expect(foldSummary('recipe-results', loaded, NOW).text).toBe('None yet');
    expect(foldSummary('notifications', loaded, NOW).text).toBe('None yet');
    expect(foldSummary('active-executions', loaded, NOW).text).toBe('Nothing running');
  });

  it('notifications off for this bridge, or turned off in Chrome', () => {
    expect(foldSummary('notifications', state(), NOW)).toEqual({ text: 'Off for this bridge', tone: 'muted' });
    expect(foldSummary('notifications', state((store) => {
      store.applyBridgeMode({ notification: true, approval: false });
      store.applyDesktopNotifications('denied');
    }), NOW)).toEqual({ text: 'Chrome has them turned off', tone: 'danger' });
  });

  it('the sites: every site, the ones never used, screenshots; or not allowed', () => {
    expect(foldSummary('sites', state((store) => store.applySitesState({ every_site: true, screenshots: true,
      blocked: ['bank.example.com', 'b.example'], message: '' })), NOW))
      .toEqual({ text: 'Every site · 2 never used · screenshots on', tone: 'muted' });
    expect(foldSummary('sites', state((store) => store.applySitesState({ every_site: false, screenshots: null,
      blocked: [], message: '' })), NOW)).toEqual({ text: 'Not allowed on every site', tone: 'danger' });
  });

  it('the server: connected with its version, or every problem it has', () => {
    expect(foldSummary('server-status', state((store) => store.applyStatusFrame({ status: status(), fetched_at: NOW,
      error: null })), NOW)).toEqual({ text: 'Connected · 26.11.4', tone: 'muted' });
    expect(foldSummary('server-status', state((store) => store.applyStatusFrame({
      status: status({ ws_state: 'offline', keyfile_sealing: 'none' }), fetched_at: NOW, error: null })), NOW))
      .toEqual({ text: 'Offline · keyfile not sealed', tone: 'danger' });
    expect(foldSummary('server-status', state((store) => store.applyStatusFrame({
      status: status({ keyfile_sealing: 'none' }), fetched_at: NOW, error: null })), NOW))
      .toEqual({ text: 'Keyfile not sealed', tone: 'danger' });
    expect(foldSummary('server-status', state((store) => store.applyStatusFrame({ status: null, fetched_at: null,
      error: 'socket closed' })), NOW)).toEqual({ text: 'Cannot reach your server', tone: 'danger' });
  });
});

describe('2026-11-04 — foldSection', () => {
  it('the heading becomes the summary line, the body the fold\'s, and the section keeps its own name', () => {
    const doc = fakeDocument();
    const { section, body } = renderedSection(doc, 'server-status');
    const folded = foldSection(doc, section, { id: 'server-status', open: false,
      summary: { text: 'Offline', tone: 'danger' } }) as unknown as FakeElement;
    expect(folded).toBe(section);
    expect(folded.getAttribute(SIDE_PANEL_SECTION_ATTR)).toBe('server-status');
    const [details] = folded.children;
    expect(details!.getAttribute(SIDE_PANEL_FOLD_ATTR)).toBe('server-status');
    expect(details!.open).toBe(false);
    const [summary, foldBody] = details!.children;
    expect(summary!.children.map((child) => [child.className, child.textContent])).toEqual([
      ['fold-title', 'Server'],
      ['fold-meta fold-meta-danger', 'Offline'],
    ]);
    // The section's own heading is gone; its body moved, as it was.
    expect(foldBody!.children).toEqual([body]);
    expect(JSON.stringify(folded.children.map((child) => child.tagName))).not.toContain('H2');
  });

  it('tells the owner\'s toggles, never the fold\'s first state', () => {
    const doc = fakeDocument();
    const onToggle = vi.fn();
    const folded = foldSection(doc, renderedSection(doc, 'sites').section,
      { id: 'sites', open: true, summary: { text: 'Every site', tone: 'muted' }, onToggle }) as unknown as FakeElement;
    const details = folded.children[0]!;
    const toggle = () => { for (const handler of details.listeners.get('toggle') ?? []) handler(); };
    toggle(); // what a browser reports for the open state the fold was built with
    expect(onToggle).not.toHaveBeenCalled();
    details.open = false;
    toggle();
    details.open = true;
    toggle();
    expect(onToggle.mock.calls).toEqual([[false], [true]]);
  });
});
