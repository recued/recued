/** Theme toggle controller — light / dark / system. */
import { describe, it, expect } from 'vitest';
import {
  mountThemeToggle,
  THEME_STORAGE_KEY,
  THEME_TOGGLE_ATTR,
} from '../shell/theme-controller.js';

// ── Minimal fake DOM ────────────────────────────────────────────────
interface FakeEl {
  tagName: string;
  textContent: string;
  readonly attrs: Map<string, string>;
  readonly children: FakeEl[];
  parent: FakeEl | null;
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(el: FakeEl): FakeEl;
  remove(): void;
  addEventListener(name: string, fn: () => void): void;
  removeEventListener(name: string, fn: () => void): void;
  click(): void;
}

const makeEl = (tag: string): FakeEl => {
  const attrs = new Map<string, string>();
  const children: FakeEl[] = [];
  const listeners = new Map<string, Array<() => void>>();
  const el: FakeEl = {
    tagName: tag.toUpperCase(),
    textContent: '',
    attrs,
    children,
    parent: null,
    setAttribute: (k, v) => attrs.set(k, v),
    removeAttribute: (k) => attrs.delete(k),
    getAttribute: (k) => attrs.get(k) ?? null,
    hasAttribute: (k) => attrs.has(k),
    appendChild: (next) => {
      children.push(next);
      next.parent = el;
      return next;
    },
    remove: () => {
      if (el.parent) {
        const i = el.parent.children.indexOf(el);
        if (i >= 0) el.parent.children.splice(i, 1);
        el.parent = null;
      }
    },
    addEventListener: (name, fn) => {
      const arr = listeners.get(name) ?? [];
      arr.push(fn);
      listeners.set(name, arr);
    },
    removeEventListener: (name, fn) => {
      const arr = listeners.get(name);
      if (!arr) return;
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    click: () => {
      for (const fn of listeners.get('click') ?? []) fn();
    },
  };
  return el;
};

const makeDoc = () => {
  const root = makeEl('html');
  return {
    documentElement: root as unknown as HTMLElement,
    createElement: (t: string) => makeEl(t) as unknown as HTMLElement,
    querySelector: () => null, // no <meta theme-color> in the fake
    root,
  };
};

const makeStorage = (initial?: Record<string, string>) => {
  const map = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => map.set(k, v),
    map,
  };
};

describe('mountThemeToggle', () => {
  it('defaults to System (no data-theme attribute) + renders the System label', () => {
    const doc = makeDoc();
    const host = makeEl('div');
    const storage = makeStorage();
    const m = mountThemeToggle({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      storage,
    });
    expect(m.get()).toBe('system');
    expect(doc.root.hasAttribute('data-theme')).toBe(false);
    const btn = host.children[0]!;
    expect(btn.getAttribute(THEME_TOGGLE_ATTR)).toBe('');
    expect(btn.textContent).toContain('System');
    m.dispose();
  });

  it('applies a persisted dark choice to the root on mount', () => {
    const doc = makeDoc();
    const host = makeEl('div');
    const storage = makeStorage({ [THEME_STORAGE_KEY]: 'dark' });
    const m = mountThemeToggle({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      storage,
    });
    expect(m.get()).toBe('dark');
    expect(doc.root.getAttribute('data-theme')).toBe('dark');
    expect(host.children[0]!.textContent).toContain('Dark');
    m.dispose();
  });

  it('cycles System → Light → Dark → System on click, persisting + applying each', () => {
    const doc = makeDoc();
    const host = makeEl('div');
    const storage = makeStorage();
    const m = mountThemeToggle({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      storage,
    });
    const btn = host.children[0]!;

    btn.click(); // → light
    expect(m.get()).toBe('light');
    expect(doc.root.getAttribute('data-theme')).toBe('light');
    expect(storage.map.get(THEME_STORAGE_KEY)).toBe('light');

    btn.click(); // → dark
    expect(m.get()).toBe('dark');
    expect(doc.root.getAttribute('data-theme')).toBe('dark');

    btn.click(); // → system (attribute removed)
    expect(m.get()).toBe('system');
    expect(doc.root.hasAttribute('data-theme')).toBe(false);
    expect(storage.map.get(THEME_STORAGE_KEY)).toBe('system');
    m.dispose();
  });

  it('set() applies + persists a specific preference', () => {
    const doc = makeDoc();
    const host = makeEl('div');
    const storage = makeStorage();
    const m = mountThemeToggle({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      storage,
    });
    m.set('light');
    expect(doc.root.getAttribute('data-theme')).toBe('light');
    expect(storage.map.get(THEME_STORAGE_KEY)).toBe('light');
    m.dispose();
  });

  it('dispose() removes the button from its host', () => {
    const doc = makeDoc();
    const host = makeEl('div');
    const m = mountThemeToggle({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      storage: makeStorage(),
    });
    expect(host.children.length).toBe(1);
    m.dispose();
    expect(host.children.length).toBe(0);
  });

  it('falls back to System when storage is unavailable (null)', () => {
    const doc = makeDoc();
    const host = makeEl('div');
    const m = mountThemeToggle({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      storage: null,
    });
    expect(m.get()).toBe('system');
    // A click still applies in-session even without persistence.
    host.children[0]!.click();
    expect(m.get()).toBe('light');
    expect(doc.root.getAttribute('data-theme')).toBe('light');
    m.dispose();
  });
});
