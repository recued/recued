/** "Back to <server>" acceptance.
 *
 *  The control that makes "Add another server…" safe to offer at all. Adding
 *  a server means leaving the shell for the pair form; without a way back, an
 *  owner who changes their mind is stranded on a pairing screen with no route
 *  to the server that still works — the same dead end this feature set exists
 *  to remove, one step further along.
 */

import { describe, expect, it, vi } from 'vitest';

import type { WebclientServerProfile } from '@recued/contracts';
import {
  RETURN_TO_SERVER_ATTR,
  mountReturnToServer,
} from '../shell/return-to-server.js';

interface FakeEvent {
  type: string;
  target: FakeEl | null;
  key?: string;
}
type FakeListener = (event: FakeEvent) => void;

interface FakeEl {
  tagName: string;
  textContent: string;
  className: string;
  children: FakeEl[];
  parent: FakeEl | null;
  attrs: Map<string, string>;
  listeners: Map<string, Set<FakeListener>>;
  firstChild: FakeEl | null;
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  addEventListener(type: string, listener: FakeListener): void;
  click(): void;
  focus(): void;
  contains(node: FakeEl): boolean;
}

const buildFakeDocument = () => {
  let active: FakeEl | null = null;
  const documentListeners = new Map<string, Set<FakeListener>>();

  const makeEl = (tagName: string): FakeEl => {
    const el: FakeEl = {
      tagName: tagName.toUpperCase(),
      textContent: '',
      className: '',
      children: [],
      parent: null,
      attrs: new Map(),
      listeners: new Map(),
      get firstChild() { return el.children[0] ?? null; },
      setAttribute(k, v) { el.attrs.set(k, v); },
      removeAttribute(k) { el.attrs.delete(k); },
      getAttribute(k) { return el.attrs.get(k) ?? null; },
      hasAttribute(k) { return el.attrs.has(k); },
      appendChild(c) { el.children.push(c); c.parent = el; return c; },
      removeChild(c) {
        const i = el.children.indexOf(c);
        if (i < 0) throw new Error('removeChild: not a child');
        el.children.splice(i, 1);
        c.parent = null;
        return c;
      },
      addEventListener(type, listener) {
        const set = el.listeners.get(type) ?? new Set<FakeListener>();
        set.add(listener);
        el.listeners.set(type, set);
      },
      click() {
        for (const l of [...(el.listeners.get('click') ?? [])]) {
          l({ type: 'click', target: el });
        }
      },
      focus() { active = el; },
      contains(node) {
        if (node === el) return true;
        return el.children.some((c) => c.contains(node));
      },
    };
    return el;
  };

  const doc = {
    createElement: makeEl,
    addEventListener(type: string, listener: FakeListener) {
      const set = documentListeners.get(type) ?? new Set<FakeListener>();
      set.add(listener);
      documentListeners.set(type, set);
    },
    removeEventListener(type: string, listener: FakeListener) {
      documentListeners.get(type)?.delete(listener);
    },
  };

  return {
    document: doc as unknown as Document,
    activeElement: () => active,
    create: makeEl,
    fire(type: string, init?: { target?: FakeEl; key?: string }) {
      for (const l of [...(documentListeners.get(type) ?? [])]) {
        l({ type, target: init?.target ?? null, ...(init?.key !== undefined ? { key: init.key } : {}) });
      }
    },
    listenerCount: (type: string) => documentListeners.get(type)?.size ?? 0,
  };
};

const findByAttr = (root: FakeEl, attr: string): FakeEl | null => {
  if (root.hasAttribute(attr)) return root;
  for (const child of root.children) {
    const hit = findByAttr(child, attr);
    if (hit !== null) return hit;
  }
  return null;
};

const findAllByAttr = (root: FakeEl, attr: string): FakeEl[] => {
  const out: FakeEl[] = [];
  const walk = (el: FakeEl): void => {
    if (el.hasAttribute(attr)) out.push(el);
    for (const c of el.children) walk(c);
  };
  walk(root);
  return out;
};


const profile = (
  over: Partial<WebclientServerProfile> & Pick<WebclientServerProfile, 'id'>,
): WebclientServerProfile => ({
  label: 'home.example:8443',
  server_url: 'wss://home.example:8443/ws',
  webclient_token: null,
  server_public_key: null,
  pair_metadata: null,
  cert_pin_state: null,
  last_connected_at: null,
  ...over,
});

const setup = (profiles: ReadonlyArray<WebclientServerProfile>) => {
  const dom = buildFakeDocument();
  const host = dom.create('div');
  const onReturn = vi.fn();
  const mount = mountReturnToServer({
    host: host as unknown as HTMLElement,
    document: dom.document,
    profiles,
    onReturn,
  });
  return { dom, host, mount, onReturn };
};

const HOME = profile({ id: 'p1', last_connected_at: 1_000 });
const OFFICE = profile({
  id: 'p2',
  label: 'office.example:8443',
  server_url: 'wss://office.example:8443/ws',
  last_connected_at: 5_000,
});
const PENDING = profile({ id: 'p3', server_url: '', label: '' });

describe('mountReturnToServer', () => {
  it('offers the most recently connected server, not the first in the roster', () => {
    // The roster is insertion-ordered; the server you were last on is the one
    // you meant to go back to.
    const { host } = setup([HOME, OFFICE, PENDING]);
    const button = findByAttr(host, RETURN_TO_SERVER_ATTR)!;
    expect(button).not.toBeNull();
    expect(button.textContent).toBe('← Back to office.example:8443');
    expect(button.getAttribute('aria-label')).toContain('Cancel adding a server');
  });

  it('ignores corrupt recency when choosing the return destination', () => {
    const corruptHome = { ...HOME, last_connected_at: Number.POSITIVE_INFINITY };
    const { host } = setup([corruptHome, OFFICE, PENDING]);

    expect(findByAttr(host, RETURN_TO_SERVER_ATTR)?.textContent)
      .toBe('← Back to office.example:8443');
  });

  it('returns the chosen id', () => {
    const { host, onReturn } = setup([HOME, OFFICE]);
    findByAttr(host, RETURN_TO_SERVER_ATTR)!.click();
    expect(onReturn).toHaveBeenCalledWith('p2');
  });

  it('renders NOTHING when the only record is the attempt in progress', () => {
    // A first pairing: "back" has no meaning, and a button that cannot work
    // is worse than no button.
    const { host, mount } = setup([PENDING]);
    expect(mount.rendered()).toBe(false);
    expect(findByAttr(host, RETURN_TO_SERVER_ATTR)).toBeNull();
  });

  it('renders nothing for an empty roster', () => {
    const { host, mount } = setup([]);
    expect(mount.rendered()).toBe(false);
    expect(findByAttr(host, RETURN_TO_SERVER_ATTR)).toBeNull();
  });

  it('never offers a pending record as the destination', () => {
    const { host, onReturn } = setup([PENDING, HOME]);
    findByAttr(host, RETURN_TO_SERVER_ATTR)!.click();
    expect(onReturn).toHaveBeenCalledWith('p1');
  });

  it('dispose removes the control and is idempotent', () => {
    const { host, mount } = setup([HOME, OFFICE]);
    mount.dispose();
    mount.dispose();
    expect(findByAttr(host, RETURN_TO_SERVER_ATTR)).toBeNull();
  });
});
