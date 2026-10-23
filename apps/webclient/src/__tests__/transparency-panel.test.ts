import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_INSTANCE_PREFS,
  type InstancePrefs,
} from '@recued/contracts';

import {
  mountTransparencyPanel,
  TRANSPARENCY_PANEL_ERROR_ATTR,
  TRANSPARENCY_PANEL_FAILURE_ROW_ATTR,
  TRANSPARENCY_PANEL_HOST_ATTR,
  TRANSPARENCY_PANEL_OFF_HINT_ATTR,
  TRANSPARENCY_PANEL_STYLES,
  TRANSPARENCY_PANEL_TIER_ATTR,
  TRANSPARENCY_PANEL_TOGGLE_ATTR,
} from '../settings/transparency-panel.js';

interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  type: string;
  disabled: boolean;
  checked: boolean;
  selected: boolean;
  value: string;
  attrs: Map<string, string>;
  children: FakeEl[];
  parent: FakeEl | null;
  listeners: Map<string, Array<() => void>>;
  readonly firstChild: FakeEl | null;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  removeAttribute(k: string): void;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  remove(): void;
  addEventListener(type: string, fn: () => void): void;
  dispatchChange(): void;
}

interface FakeDoc {
  createElement(tag: string): FakeEl;
}

const makeFakeEl = (tag: string): FakeEl => {
  const el: FakeEl = {
    tagName: tag.toUpperCase(),
    className: '',
    textContent: '',
    type: '',
    disabled: false,
    checked: false,
    selected: false,
    value: '',
    attrs: new Map(),
    children: [],
    parent: null,
    listeners: new Map(),
    get firstChild() {
      return el.children[0] ?? null;
    },
    setAttribute(k, v) {
      el.attrs.set(k, v);
      if (k === 'type') el.type = v;
      if (k === 'value') el.value = v;
      if (k === 'selected') el.selected = true;
    },
    getAttribute(k) {
      return el.attrs.get(k) ?? null;
    },
    removeAttribute(k) {
      el.attrs.delete(k);
      if (k === 'selected') el.selected = false;
    },
    appendChild(c) {
      c.parent = el;
      el.children.push(c);
      return c;
    },
    removeChild(c) {
      const idx = el.children.indexOf(c);
      if (idx < 0) throw new Error('removeChild: not a child');
      el.children.splice(idx, 1);
      c.parent = null;
      return c;
    },
    remove() {
      if (el.parent === null) return;
      const idx = el.parent.children.indexOf(el);
      if (idx >= 0) el.parent.children.splice(idx, 1);
      el.parent = null;
    },
    addEventListener(type, fn) {
      const list = el.listeners.get(type) ?? [];
      list.push(fn);
      el.listeners.set(type, list);
    },
    dispatchChange() {
      if (el.disabled) return;
      for (const fn of el.listeners.get('change') ?? []) fn();
    },
  };
  return el;
};

const makeFakeDocument = (): FakeDoc => ({
  createElement: (tag) => makeFakeEl(tag),
});

const collectByAttr = (
  root: FakeEl,
  attr: string,
  out: FakeEl[] = [],
): FakeEl[] => {
  if (root.attrs.has(attr)) out.push(root);
  for (const child of root.children) collectByAttr(child, attr, out);
  return out;
};

const findByAttrValue = (root: FakeEl, attr: string, value: string): FakeEl => {
  const found = collectByAttr(root, attr).find(
    (el) => el.getAttribute(attr) === value,
  );
  if (found === undefined) throw new Error('missing element ' + value);
  return found;
};

const mergePrefs = (patch: Partial<InstancePrefs> = {}): InstancePrefs => ({
  ...DEFAULT_INSTANCE_PREFS,
  ...patch,
});

const makeSetCaller = () =>
  vi.fn(async (args: { patch: Partial<InstancePrefs> }) => ({
    prefs: mergePrefs(args.patch),
  }));

describe('mountTransparencyPanel', () => {
  const retryAttr = 'data-recued-transparency-retry';
  const loadStatusAttr = 'data-recued-transparency-load-status';
  const click = (element: FakeEl) => { for (const listener of element.listeners.get('click') ?? []) listener(); };
  const retry = (host: FakeEl) => {
    const element = collectByAttr(host, retryAttr)[0];
    expect(element, 'A failed preference read needs an in-place Retry').toBeDefined();
    return element!;
  };

  it('retries only the read, keeps one request pending, and recovers non-default preferences after repeated failures', async () => {
    const doc = makeFakeDocument(), host = doc.createElement('div');
    let fail!: (error: Error) => void;
    const prefs = mergePrefs({ 'ui.transparency.enabled': false, 'ui.transparency.class.orchestration': true, 'ui.transparency.max_redaction_tier': 'none' });
    const runPrefsGet = vi.fn<() => Promise<{ prefs: InstancePrefs }>>()
      .mockRejectedValueOnce(new Error('Initial read unavailable'))
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }))
      .mockResolvedValue({ prefs });
    const runPrefsSet = makeSetCaller();
    const panel = mountTransparencyPanel({ host: host as unknown as HTMLElement, document: doc as unknown as Document, runPrefsGet, runPrefsSet });
    expect(collectByAttr(host, retryAttr)).toHaveLength(0);
    await panel.whenLoaded();
    const button = retry(host); expect(button.getAttribute('aria-disabled')).toBe('false');
    expect(collectByAttr(host, loadStatusAttr)[0]!.getAttribute('role')).toBe('alert');
    click(button); click(button);
    expect(runPrefsGet).toHaveBeenCalledTimes(2); expect(runPrefsSet).not.toHaveBeenCalled();
    expect(panel.hasInFlightWork()).toBe(false);
    expect(retry(host)).toBe(button); expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.disabled).toBe(false);
    let settled = false; const reading = panel.whenLoaded().then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    fail(new Error('Retry read unavailable')); await reading;
    expect(retry(host)).toBe(button); expect(button.getAttribute('aria-disabled')).toBe('false');
    expect(collectByAttr(host, loadStatusAttr)[0]!.getAttribute('role')).toBe('alert');
    click(button); await panel.whenLoaded();
    expect(panel.getState().phase).toBe('ready'); expect(panel.getState().prefs).toEqual(prefs);
    expect(findByAttrValue(host, TRANSPARENCY_PANEL_TOGGLE_ATTR, 'ui.transparency.enabled').checked).toBe(false);
    expect(findByAttrValue(host, TRANSPARENCY_PANEL_TOGGLE_ATTR, 'ui.transparency.class.orchestration').checked).toBe(true);
    expect(collectByAttr(host, TRANSPARENCY_PANEL_TIER_ATTR)[0]!.value).toBe('none');
    expect(collectByAttr(host, retryAttr)).toHaveLength(0);
    click(button); expect(runPrefsGet).toHaveBeenCalledTimes(3); expect(runPrefsSet).not.toHaveBeenCalled();
    panel.dispose();
  });

  it('keeps the recovered preferences and navigation guard through an uncertain write without repeating a read or write', async () => {
    const doc = makeFakeDocument(), host = doc.createElement('div');
    const prefs = mergePrefs({ 'ui.transparency.class.orchestration': true });
    const runPrefsGet = vi.fn().mockRejectedValueOnce(new Error('Read unavailable')).mockResolvedValue({ prefs });
    let failSave!: (error: Error) => void;
    const runPrefsSet = vi.fn(() => new Promise<{ prefs: InstancePrefs }>((_resolve, reject) => { failSave = reject; }));
    const panel = mountTransparencyPanel({ host: host as unknown as HTMLElement, document: doc as unknown as Document, runPrefsGet, runPrefsSet });
    await panel.whenLoaded(); const button = retry(host); click(button); await panel.whenLoaded();
    const master = findByAttrValue(host, TRANSPARENCY_PANEL_TOGGLE_ATTR, 'ui.transparency.enabled');
    master.checked = false; master.dispatchChange(); expect(panel.hasInFlightWork()).toBe(true);
    click(button); expect(runPrefsGet).toHaveBeenCalledTimes(2);
    failSave(new Error('Write acknowledgement lost')); await panel.whenSaveSettled();
    expect(panel.hasInFlightWork()).toBe(false); expect(panel.getState().prefs).toEqual(prefs);
    expect(findByAttrValue(host, TRANSPARENCY_PANEL_TOGGLE_ATTR, 'ui.transparency.enabled').checked).toBe(true);
    expect(findByAttrValue(host, TRANSPARENCY_PANEL_TOGGLE_ATTR, 'ui.transparency.class.orchestration').checked).toBe(true);
    click(button); expect(runPrefsGet).toHaveBeenCalledTimes(2); expect(runPrefsSet).toHaveBeenCalledTimes(1);
    expect(collectByAttr(host, retryAttr)).toHaveLength(0); panel.dispose();
    master.dispatchChange(); expect(runPrefsSet).toHaveBeenCalledTimes(1);
  });

  it.each(['success', 'failure'] as const)('ignores a late %s retry reply and a detached Retry activation after disposal', async outcome => {
    const doc = makeFakeDocument(), host = doc.createElement('div');
    let resolve!: (value: { prefs: InstancePrefs }) => void, reject!: (error: Error) => void;
    const runPrefsGet = vi.fn<() => Promise<{ prefs: InstancePrefs }>>()
      .mockRejectedValueOnce(new Error('Read unavailable'))
      .mockImplementationOnce(() => new Promise((done, fail) => { resolve = done; reject = fail; }));
    const runPrefsSet = makeSetCaller();
    const panel = mountTransparencyPanel({ host: host as unknown as HTMLElement, document: doc as unknown as Document, runPrefsGet, runPrefsSet });
    await panel.whenLoaded(); const button = retry(host); click(button); const reading = panel.whenLoaded();
    panel.dispose(); click(button);
    if (outcome === 'success') resolve({ prefs: mergePrefs() }); else reject(new Error('Late read failure'));
    await reading; expect(host.children).toHaveLength(0); expect(host.getAttribute(TRANSPARENCY_PANEL_HOST_ATTR)).toBeNull();
    expect(runPrefsGet).toHaveBeenCalledTimes(2); expect(runPrefsSet).not.toHaveBeenCalled();
  });

  it('gives every checkbox a full-size label target', () => {
    expect(TRANSPARENCY_PANEL_STYLES).toContain(
      '.transparency-row {\n  box-sizing: border-box;\n  min-height: 36px;',
    );
  });

  it('loads prefs and renders default toggle and tier states', async () => {
    const doc = makeFakeDocument();
    const host = doc.createElement('div');
    const runPrefsGet = vi.fn(async () => ({ prefs: mergePrefs() }));
    const runPrefsSet = makeSetCaller();
    const panel = mountTransparencyPanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      runPrefsGet,
      runPrefsSet,
    });

    expect(runPrefsGet).toHaveBeenCalledTimes(1);
    await panel.whenLoaded();
    expect(panel.getState().phase).toBe('ready');

    expect(
      findByAttrValue(
        host,
        TRANSPARENCY_PANEL_TOGGLE_ATTR,
        'ui.transparency.enabled',
      ).checked,
    ).toBe(true);
    expect(
      findByAttrValue(
        host,
        TRANSPARENCY_PANEL_TOGGLE_ATTR,
        'ui.transparency.class.ai_emitted',
      ).checked,
    ).toBe(true);
    expect(
      findByAttrValue(
        host,
        TRANSPARENCY_PANEL_TOGGLE_ATTR,
        'ui.transparency.class.engine_brokering',
      ).checked,
    ).toBe(true);
    expect(
      findByAttrValue(
        host,
        TRANSPARENCY_PANEL_TOGGLE_ATTR,
        'ui.transparency.class.orchestration',
      ).checked,
    ).toBe(false);

    const failureRow = collectByAttr(
      host,
      TRANSPARENCY_PANEL_FAILURE_ROW_ATTR,
    )[0]!;
    const failureBox = failureRow.children.find(
      (child) => child.tagName === 'INPUT',
    )!;
    expect(failureBox.checked).toBe(true);
    expect(failureBox.disabled).toBe(true);

    const tier = collectByAttr(host, TRANSPARENCY_PANEL_TIER_ATTR)[0]!;
    expect(tier.value).toBe('summary_only');
    expect(tier.children.filter((child) => child.tagName === 'OPTION'))
      .toHaveLength(2);
  });

  it('saves orchestration toggle changes and adopts merged prefs', async () => {
    const doc = makeFakeDocument();
    const host = doc.createElement('div');
    const runPrefsSet = makeSetCaller();
    const panel = mountTransparencyPanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      runPrefsGet: vi.fn(async () => ({ prefs: mergePrefs() })),
      runPrefsSet,
    });
    await panel.whenLoaded();

    const orchestration = findByAttrValue(
      host,
      TRANSPARENCY_PANEL_TOGGLE_ATTR,
      'ui.transparency.class.orchestration',
    );
    orchestration.checked = true;
    orchestration.dispatchChange();

    expect(runPrefsSet).toHaveBeenCalledWith({
      patch: { 'ui.transparency.class.orchestration': true },
    });
    await panel.whenSaveSettled();
    expect(panel.getState().prefs?.['ui.transparency.class.orchestration'])
      .toBe(true);
  });

  it('keeps a pending toggle truthful, focusable, and single-flight', async () => {
    const doc = makeFakeDocument();
    const host = doc.createElement('div');
    let settle!: (value: { prefs: InstancePrefs }) => void;
    const runPrefsSet = vi.fn(
      () => new Promise<{ prefs: InstancePrefs }>((resolve) => {
        settle = resolve;
      }),
    );
    const panel = mountTransparencyPanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      runPrefsGet: vi.fn(async () => ({ prefs: mergePrefs() })),
      runPrefsSet,
    });
    await panel.whenLoaded();
    expect(panel.hasInFlightWork()).toBe(false);

    let orchestration = findByAttrValue(
      host,
      TRANSPARENCY_PANEL_TOGGLE_ATTR,
      'ui.transparency.class.orchestration',
    );
    orchestration.checked = true;
    orchestration.dispatchChange();

    orchestration = findByAttrValue(
      host,
      TRANSPARENCY_PANEL_TOGGLE_ATTR,
      'ui.transparency.class.orchestration',
    );
    expect(panel.hasInFlightWork()).toBe(true);
    expect(orchestration.checked).toBe(true);
    expect(orchestration.disabled).toBe(false);
    expect(orchestration.getAttribute('aria-disabled')).toBe('true');
    expect(orchestration.getAttribute('aria-busy')).toBe('true');

    const tier = collectByAttr(host, TRANSPARENCY_PANEL_TIER_ATTR)[0]!;
    expect(tier.disabled).toBe(false);
    expect(tier.getAttribute('aria-disabled')).toBe('true');
    expect(tier.getAttribute('aria-busy')).toBeNull();
    tier.value = 'none';
    tier.dispatchChange();
    expect(tier.value).toBe('summary_only');

    orchestration.checked = false;
    orchestration.dispatchChange();
    expect(orchestration.checked).toBe(true);
    expect(runPrefsSet).toHaveBeenCalledTimes(1);

    settle({
      prefs: mergePrefs({
        'ui.transparency.class.orchestration': true,
      }),
    });
    await panel.whenSaveSettled();
    expect(panel.hasInFlightWork()).toBe(false);
    orchestration = findByAttrValue(
      host,
      TRANSPARENCY_PANEL_TOGGLE_ATTR,
      'ui.transparency.class.orchestration',
    );
    expect(orchestration.checked).toBe(true);
    expect(orchestration.getAttribute('aria-disabled')).toBeNull();
    expect(orchestration.getAttribute('aria-busy')).toBeNull();
  });

  it('saves max redaction tier changes', async () => {
    const doc = makeFakeDocument();
    const host = doc.createElement('div');
    const runPrefsSet = makeSetCaller();
    const panel = mountTransparencyPanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      runPrefsGet: vi.fn(async () => ({ prefs: mergePrefs() })),
      runPrefsSet,
    });
    await panel.whenLoaded();

    const tier = collectByAttr(host, TRANSPARENCY_PANEL_TIER_ATTR)[0]!;
    tier.value = 'none';
    tier.dispatchChange();

    expect(runPrefsSet).toHaveBeenCalledWith({
      patch: { 'ui.transparency.max_redaction_tier': 'none' },
    });
  });

  it('renders load errors and recovers controls after save errors', async () => {
    const loadDoc = makeFakeDocument();
    const loadHost = loadDoc.createElement('div');
    const loadPanel = mountTransparencyPanel({
      host: loadHost as unknown as HTMLElement,
      document: loadDoc as unknown as Document,
      runPrefsGet: vi.fn(async () => {
        throw new Error('no prefs');
      }),
      runPrefsSet: makeSetCaller(),
    });
    await loadPanel.whenLoaded();
    expect(loadPanel.getState().phase).toBe('error');
    expect(collectByAttr(loadHost, TRANSPARENCY_PANEL_ERROR_ATTR))
      .toHaveLength(1);

    const saveDoc = makeFakeDocument();
    const saveHost = saveDoc.createElement('div');
    const savePanel = mountTransparencyPanel({
      host: saveHost as unknown as HTMLElement,
      document: saveDoc as unknown as Document,
      runPrefsGet: vi.fn(async () => ({ prefs: mergePrefs() })),
      runPrefsSet: vi.fn(async () => {
        throw new Error('no write');
      }),
    });
    await savePanel.whenLoaded();

    const master = findByAttrValue(
      saveHost,
      TRANSPARENCY_PANEL_TOGGLE_ATTR,
      'ui.transparency.enabled',
    );
    master.checked = false;
    master.dispatchChange();
    await savePanel.whenSaveSettled();

    expect(savePanel.getState().phase).toBe('ready');
    expect(savePanel.getState().saving).toBeNull();
    expect(collectByAttr(saveHost, TRANSPARENCY_PANEL_ERROR_ATTR))
      .toHaveLength(1);
    for (const toggle of collectByAttr(saveHost, TRANSPARENCY_PANEL_TOGGLE_ATTR)) {
      expect(toggle.disabled).toBe(false);
    }
    expect(collectByAttr(saveHost, TRANSPARENCY_PANEL_TIER_ATTR)[0]!.disabled)
      .toBe(false);
  });

  it('shows the off hint while keeping class toggles enabled', async () => {
    const doc = makeFakeDocument();
    const host = doc.createElement('div');
    const panel = mountTransparencyPanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      runPrefsGet: vi.fn(async () => ({
        prefs: mergePrefs({ 'ui.transparency.enabled': false }),
      })),
      runPrefsSet: makeSetCaller(),
    });
    await panel.whenLoaded();

    expect(collectByAttr(host, TRANSPARENCY_PANEL_OFF_HINT_ATTR))
      .toHaveLength(1);
    for (const key of [
      'ui.transparency.class.ai_emitted',
      'ui.transparency.class.engine_brokering',
      'ui.transparency.class.orchestration',
    ]) {
      expect(findByAttrValue(host, TRANSPARENCY_PANEL_TOGGLE_ATTR, key).disabled)
        .toBe(false);
    }
  });

  it('clears host content and host marker on dispose', async () => {
    const doc = makeFakeDocument();
    const host = doc.createElement('div');
    const panel = mountTransparencyPanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      runPrefsGet: vi.fn(async () => ({ prefs: mergePrefs() })),
      runPrefsSet: makeSetCaller(),
    });
    await panel.whenLoaded();

    expect(host.getAttribute(TRANSPARENCY_PANEL_HOST_ATTR)).toBe('');
    expect(host.children.length).toBeGreaterThan(0);
    panel.dispose();
    expect(host.children).toHaveLength(0);
    expect(host.getAttribute(TRANSPARENCY_PANEL_HOST_ATTR)).toBeNull();
  });
});
