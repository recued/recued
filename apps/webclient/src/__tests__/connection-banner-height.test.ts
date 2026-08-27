/** The connection banner publishes its measured height.
 *
 *  The banner is fixed to the bottom of the viewport and spans its full width,
 *  so it sits ON TOP of whatever else ends down there. The left drawer's menu
 *  is now taller than a normal desktop window, and what the banner covered was
 *  its last item — the account row — with no way to reach it.
 *
 *  ⛔ MEASURED, NOT ASSUMED, and driven live to prove why: the banner is 16px
 *  empty, 60px with its real message and 44px action button, and 86px on a
 *  narrow window where the row wraps to two lines. Any hard-coded offset is
 *  wrong in at least two of those three.
 */

import { describe, expect, it } from 'vitest';

import {
  CONNECTION_BANNER_ATTR,
  CONNECTION_BANNER_HEIGHT_VAR,
  mountConnectionIndicator,
} from '../shell/connection-indicator.js';
import {
  WEBCLIENT_SHELL_STYLES,
  WEBCLIENT_SHELL_DRAWER_ATTR,
} from '../webclient-bootstrap.js';

interface El {
  tagName: string;
  attrs: Map<string, string>;
  children: El[];
  parent: El | null;
  textContent: string;
  offsetHeight?: number;
  style?: { props: Map<string, string>; setProperty(k: string, v: string): void };
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  removeAttribute(k: string): void;
  hasAttribute(k: string): boolean;
  appendChild(c: El): El;
  removeChild(c: El): El;
  addEventListener(): void;
  removeEventListener(): void;
}

const el = (tagName: string, withStyle = false): El => {
  const node: El = {
    tagName, attrs: new Map(), children: [], parent: null, textContent: '',
    ...(withStyle
      ? {
          style: {
            props: new Map<string, string>(),
            setProperty(k: string, v: string) { node.style!.props.set(k, v); },
          },
        }
      : {}),
    setAttribute(k, v) { node.attrs.set(k, v); },
    getAttribute(k) { return node.attrs.get(k) ?? null; },
    removeAttribute(k) { node.attrs.delete(k); },
    hasAttribute(k) { return node.attrs.has(k); },
    appendChild(c) { c.parent = node; node.children.push(c); return c; },
    removeChild(c) {
      const i = node.children.indexOf(c);
      if (i >= 0) node.children.splice(i, 1);
      return c;
    },
    addEventListener() {}, removeEventListener() {},
  };
  return node;
};

const find = (root: El, attr: string): El | null => {
  if (root.attrs.has(attr)) return root;
  for (const child of root.children) {
    const hit = find(child, attr);
    if (hit !== null) return hit;
  }
  return null;
};

const mount = (bannerHost: El) => {
  const doc = {
    activeElement: null,
    defaultView: null,
    createElement: (tag: string) => el(tag),
    addEventListener() {}, removeEventListener() {},
  };
  let current = 'connected';
  const listeners = new Set<(s: string) => void>();
  const mounted = mountConnectionIndicator({
    statusHost: el('div') as unknown as HTMLElement,
    bannerHost: bannerHost as unknown as HTMLElement,
    document: doc as unknown as Document,
    status: (() => current) as never,
    onStatus: ((listener: (s: string) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }) as never,
  });
  return {
    mounted,
    setStatus: (next: string) => {
      current = next;
      for (const listener of [...listeners]) listener(next);
    },
  };
};

describe('connection banner height', () => {
  /** ⛔ THE GUARD THAT MATTERS MOST. The webclient's document doubles create
   *  elements with no `style` and no `offsetHeight`; touching either unguarded
   *  throws for EVERY mount, which is a whole-suite outage rather than a
   *  cosmetic bug. The publisher has to no-op on such a host. */
  it('mounts without throwing on a host that has no style', () => {
    const host = el('div'); // deliberately styleless
    expect(() => mount(host)).not.toThrow();
    expect(find(host, CONNECTION_BANNER_ATTR)).not.toBeNull();
  });

  it('publishes zero while the banner is not showing', () => {
    const host = el('div', true);
    mount(host);
    const banner = find(host, CONNECTION_BANNER_ATTR)!;
    // `display: none` measures 0 in a browser; the double reports nothing,
    // and both must land on 0px rather than on a guess.
    expect(banner.getAttribute('data-state')).toBe('ok');
    expect(host.style!.props.get(CONNECTION_BANNER_HEIGHT_VAR)).toBe('0px');
  });

  it('publishes the measured height once the banner is actually up', () => {
    const host = el('div', true);
    const { setStatus } = mount(host);
    const banner = find(host, CONNECTION_BANNER_ATTR)!;
    // The narrow, two-line case, taken from the live drive.
    banner.offsetHeight = 86;

    setStatus('offline');

    expect(banner.getAttribute('data-state')).toBe('offline');
    expect(host.style!.props.get(CONNECTION_BANNER_HEIGHT_VAR)).toBe('86px');
  });

  it('drops back to zero when the banner retires', () => {
    const host = el('div', true);
    const { setStatus } = mount(host);
    const banner = find(host, CONNECTION_BANNER_ATTR)!;
    banner.offsetHeight = 60;
    setStatus('offline');
    expect(host.style!.props.get(CONNECTION_BANNER_HEIGHT_VAR)).toBe('60px');

    // ⛔ A stale non-zero would leave a permanent gap at the bottom of a
    // drawer with nothing under it — the bug this fix causes if the publisher
    // only ever runs on the way up.
    banner.offsetHeight = 0;
    setStatus('connected');
    expect(host.style!.props.get(CONNECTION_BANNER_HEIGHT_VAR)).toBe('0px');
  });
});

describe('the drawer keeps clear of the banner', () => {
  /** ⛔ RATCHET. The padding must stay expressed in terms of the published
   *  height: a literal would be right for exactly one banner, and the live
   *  drive measured three different ones (16 / 60 / 86px). */
  it('pads its bottom by the published banner height, not a literal', () => {
    const drawerRule = WEBCLIENT_SHELL_STYLES.slice(
      WEBCLIENT_SHELL_STYLES.indexOf(`[${WEBCLIENT_SHELL_DRAWER_ATTR}] {`),
    ).split('}')[0]!;
    expect(drawerRule).toContain(`var(${CONNECTION_BANNER_HEIGHT_VAR}, 0px)`);
    expect(drawerRule).toMatch(/padding:[^;]*calc\(/);
  });
});
