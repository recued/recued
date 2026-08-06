/** D-194 2b-2 — the install dialog's "Connect account" section render.
 *
 *  Pure render + `defaultChosenConnection`. Three branches: no candidates
 *  (enroll-only), candidates + collapsed (pre-selected one-liner + Customize),
 *  candidates + expanded (radio list + "don't connect" + enroll). The host
 *  state machine (`packs-panel.ts`) + the end-to-end flow are covered by the
 *  webclient browser-verify pass; this proves the render + the pick/toggle
 *  callbacks + the disabled gate in isolation. Fake DOM mirrors
 *  `d-182-install-grant-picker.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  INSTALL_CONNECT_ATTR,
  INSTALL_CONNECT_CANDIDATE_ATTR,
  INSTALL_CONNECT_CUSTOMIZE_ATTR,
  INSTALL_CONNECT_ENROLL_ATTR,
  INSTALL_CONNECT_NONE_ATTR,
  INSTALL_CONNECT_PICKER_STYLES,
  defaultChosenConnection,
  renderInstallConnectPicker,
  resolveChosenConnection,
} from '../settings/install-connect-picker.js';
import type { ConnectionRequirement, EndpointCandidate } from '@recued/contracts';

// ──────────────────────────────────────────────────────────────────
// Fake DOM (subset of d-182-install-grant-picker.test.ts's harness)
// ──────────────────────────────────────────────────────────────────

interface FakeElement {
  tagName: string;
  textContent: string;
  disabled: boolean;
  checked: boolean;
  className: string;
  type: string;
  name: string;
  children: FakeElement[];
  parent: FakeElement | null;
  attrs: Map<string, string>;
  listeners: Map<string, Array<(ev: unknown) => void>>;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(el: FakeElement): FakeElement;
  addEventListener(name: string, fn: (ev: unknown) => void): void;
  click(): void;
  dispatch(name: string): void;
}

const makeFakeElement = (tagName: string): FakeElement => {
  const listeners = new Map<string, Array<(ev: unknown) => void>>();
  const attrs = new Map<string, string>();
  const children: FakeElement[] = [];
  const el: FakeElement = {
    tagName: tagName.toUpperCase(),
    textContent: '',
    disabled: false,
    checked: false,
    className: '',
    type: '',
    name: '',
    children,
    parent: null,
    attrs,
    listeners,
    setAttribute: (k, v) => attrs.set(k, v),
    getAttribute: (k) => attrs.get(k) ?? null,
    hasAttribute: (k) => attrs.has(k),
    appendChild: (next) => {
      children.push(next);
      next.parent = el;
      return next;
    },
    addEventListener: (name, fn) => {
      const arr = listeners.get(name) ?? [];
      arr.push(fn);
      listeners.set(name, arr);
    },
    click: () => {
      for (const fn of listeners.get('click') ?? []) fn({ target: el });
    },
    dispatch: (name) => {
      for (const fn of listeners.get(name) ?? []) fn({ target: el });
    },
  };
  return el;
};

const makeFakeDocument = (): Document =>
  ({ createElement: (tag: string) => makeFakeElement(tag) }) as unknown as Document;

const findByAttr = (root: FakeElement, attr: string): FakeElement | null => {
  if (root.hasAttribute(attr)) return root;
  for (const c of root.children) {
    const hit = findByAttr(c, attr);
    if (hit) return hit;
  }
  return null;
};

const findAllByAttr = (root: FakeElement, attr: string): FakeElement[] => {
  const out: FakeElement[] = [];
  const walk = (n: FakeElement): void => {
    if (n.hasAttribute(attr)) out.push(n);
    for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
};

const collectText = (root: FakeElement): string => {
  let out = root.textContent ?? '';
  for (const c of root.children) out += collectText(c);
  return out;
};

// ──────────────────────────────────────────────────────────────────
// Builders
// ──────────────────────────────────────────────────────────────────

const REQUIREMENT: ConnectionRequirement = {
  authority: 'login.microsoftonline.com',
  api_base: 'https://graph.microsoft.com/v1.0',
  vendor: 'onedrive',
  auth: {
    type: 'oauth2_refresh',
    authorize_url: 'https://login.microsoftonline.com/authorize',
    token_endpoint: 'https://login.microsoftonline.com/token',
  },
};

const candidate = (name: string, display = name): EndpointCandidate => ({
  name,
  display_name: display,
  granted_scopes: [],
});

interface RenderOverrides {
  candidates?: readonly EndpointCandidate[];
  chosen?: string | undefined;
  expanded?: boolean;
  disabled?: boolean;
}

const render = (over: RenderOverrides = {}) => {
  const onPick = vi.fn();
  const onToggleExpanded = vi.fn();
  const el = renderInstallConnectPicker({
    document: makeFakeDocument(),
    requirement: REQUIREMENT,
    candidates: over.candidates ?? [],
    chosen: 'chosen' in over ? over.chosen : undefined,
    expanded: over.expanded ?? false,
    disabled: over.disabled ?? false,
    onPick,
    onToggleExpanded,
  }) as unknown as FakeElement;
  return { el, onPick, onToggleExpanded };
};

// ──────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────

describe('defaultChosenConnection', () => {
  it('is undefined for no candidates', () => {
    expect(defaultChosenConnection([])).toBeUndefined();
  });
  it('is the first candidate (name-sorted upstream) otherwise', () => {
    expect(defaultChosenConnection([candidate('a'), candidate('b')])).toBe('a');
  });
});

describe('resolveChosenConnection — render↔submit agreement', () => {
  const cs = [candidate('work-od'), candidate('home-od')];

  it('untouched → the pre-selected default (first candidate)', () => {
    expect(resolveChosenConnection({ touched: false, pick: undefined }, cs)).toBe('work-od');
  });

  it('untouched + no candidates → undefined', () => {
    expect(resolveChosenConnection({ touched: false, pick: undefined }, [])).toBeUndefined();
  });

  it('honors an explicit named pick while it is still a candidate', () => {
    expect(resolveChosenConnection({ touched: true, pick: 'home-od' }, cs)).toBe('home-od');
  });

  it('honors an explicit "don\'t connect" (undefined) even with candidates present', () => {
    expect(resolveChosenConnection({ touched: true, pick: undefined }, cs)).toBeUndefined();
  });

  it('falls back to the default when the explicit pick VANISHED from the list', () => {
    // The MEDIUM fix: an async list change dropped the picked connection — submit
    // must NOT send the stale name; both render + submit fall back to the default.
    expect(resolveChosenConnection({ touched: true, pick: 'gone-od' }, cs)).toBe('work-od');
  });

  it('falls back to undefined when the pick vanished AND no candidates remain', () => {
    expect(resolveChosenConnection({ touched: true, pick: 'gone-od' }, [])).toBeUndefined();
  });
});

describe('renderInstallConnectPicker — no candidates (enroll-only)', () => {
  it('renders the vendor enroll deep-link + hint, no radios', () => {
    const { el } = render({ candidates: [] });
    expect(el.hasAttribute(INSTALL_CONNECT_ATTR)).toBe(true);
    const enroll = findByAttr(el, INSTALL_CONNECT_ENROLL_ATTR);
    expect(enroll).not.toBeNull();
    expect(enroll?.getAttribute('href')).toBe('#connections/others/enroll/onedrive');
    expect(findAllByAttr(el, INSTALL_CONNECT_CANDIDATE_ATTR)).toHaveLength(0);
    expect(findByAttr(el, INSTALL_CONNECT_NONE_ATTR)).toBeNull();
    // The optional-connect hint is present.
    expect(collectText(el)).toContain('connect it later');
  });
});

describe('renderInstallConnectPicker — candidates, collapsed', () => {
  it('shows the chosen candidate in the one-liner + a Customize button, no radios', () => {
    const { el } = render({
      candidates: [candidate('work-od', 'work@contoso'), candidate('home-od', 'home@live')],
      chosen: 'work-od',
      expanded: false,
    });
    expect(collectText(el)).toContain('work@contoso');
    expect(findByAttr(el, INSTALL_CONNECT_CUSTOMIZE_ATTR)).not.toBeNull();
    expect(findAllByAttr(el, INSTALL_CONNECT_CANDIDATE_ATTR)).toHaveLength(0);
  });

  it('reads "install only" when chosen is undefined (owner declined)', () => {
    const { el } = render({ candidates: [candidate('work-od')], chosen: undefined, expanded: false });
    expect(collectText(el)).toContain('install only');
  });

  it('Customize click fires onToggleExpanded', () => {
    const { el, onToggleExpanded } = render({ candidates: [candidate('work-od')], chosen: 'work-od' });
    findByAttr(el, INSTALL_CONNECT_CUSTOMIZE_ATTR)?.click();
    expect(onToggleExpanded).toHaveBeenCalledTimes(1);
  });
});

describe('renderInstallConnectPicker — candidates, expanded', () => {
  const expandedEl = () =>
    render({
      candidates: [candidate('work-od', 'work@contoso'), candidate('home-od', 'home@live')],
      chosen: 'work-od',
      expanded: true,
    });

  it('renders one radio per candidate + a "don\'t connect" radio + the enroll link', () => {
    const { el } = expandedEl();
    const radios = findAllByAttr(el, INSTALL_CONNECT_CANDIDATE_ATTR);
    expect(radios.map((r) => r.getAttribute(INSTALL_CONNECT_CANDIDATE_ATTR))).toEqual([
      'work-od',
      'home-od',
    ]);
    expect(findByAttr(el, INSTALL_CONNECT_NONE_ATTR)).not.toBeNull();
    expect(findByAttr(el, INSTALL_CONNECT_ENROLL_ATTR)).not.toBeNull();
  });

  it('checks the chosen candidate radio (and not the others / the none option)', () => {
    const { el } = expandedEl();
    const radios = findAllByAttr(el, INSTALL_CONNECT_CANDIDATE_ATTR);
    const work = radios.find((r) => r.getAttribute(INSTALL_CONNECT_CANDIDATE_ATTR) === 'work-od');
    const home = radios.find((r) => r.getAttribute(INSTALL_CONNECT_CANDIDATE_ATTR) === 'home-od');
    expect(work?.checked).toBe(true);
    expect(home?.checked).toBe(false);
    expect(findByAttr(el, INSTALL_CONNECT_NONE_ATTR)?.checked).toBe(false);
  });

  it('checks the "don\'t connect" radio when chosen is undefined', () => {
    const { el } = render({ candidates: [candidate('work-od')], chosen: undefined, expanded: true });
    expect(findByAttr(el, INSTALL_CONNECT_NONE_ATTR)?.checked).toBe(true);
    expect(findAllByAttr(el, INSTALL_CONNECT_CANDIDATE_ATTR)[0]?.checked).toBe(false);
  });

  it('a candidate radio change fires onPick(name); the none radio fires onPick(undefined)', () => {
    const { el, onPick } = expandedEl();
    const home = findAllByAttr(el, INSTALL_CONNECT_CANDIDATE_ATTR).find(
      (r) => r.getAttribute(INSTALL_CONNECT_CANDIDATE_ATTR) === 'home-od',
    );
    home?.dispatch('change');
    expect(onPick).toHaveBeenCalledWith('home-od');
    findByAttr(el, INSTALL_CONNECT_NONE_ATTR)?.dispatch('change');
    expect(onPick).toHaveBeenCalledWith(undefined);
  });
});

describe('renderInstallConnectPicker — disabled (install in flight)', () => {
  it('disables the radios + drops their change listeners', () => {
    const { el, onPick } = render({
      candidates: [candidate('work-od')],
      chosen: 'work-od',
      expanded: true,
      disabled: true,
    });
    const radio = findAllByAttr(el, INSTALL_CONNECT_CANDIDATE_ATTR)[0];
    expect(radio?.disabled).toBe(true);
    radio?.dispatch('change');
    expect(onPick).not.toHaveBeenCalled();
  });

  it('disables the Customize button', () => {
    const { el, onToggleExpanded } = render({
      candidates: [candidate('work-od')],
      chosen: 'work-od',
      expanded: false,
      disabled: true,
    });
    const btn = findByAttr(el, INSTALL_CONNECT_CUSTOMIZE_ATTR);
    expect(btn?.disabled).toBe(true);
    btn?.click();
    expect(onToggleExpanded).not.toHaveBeenCalled();
  });
});

describe('renderInstallConnectPicker — presentation contract', () => {
  it('ships a card-based, bullet-free account chooser with a visible selected state', () => {
    expect(INSTALL_CONNECT_PICKER_STYLES).toContain(
      '[data-recued-install-connect] .packs-dialog-connect-list',
    );
    expect(INSTALL_CONNECT_PICKER_STYLES).toContain('list-style: none');
    expect(INSTALL_CONNECT_PICKER_STYLES).toContain(
      'label:has(input:checked)',
    );
    expect(INSTALL_CONNECT_PICKER_STYLES).toMatch(
      /\.packs-dialog-connect-customize,[\s\S]*?\.packs-dialog-connect-enroll \{[\s\S]*?min-height: 36px;/,
    );
  });
});
