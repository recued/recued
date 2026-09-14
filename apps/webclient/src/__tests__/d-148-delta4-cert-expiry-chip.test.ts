/** R26.4 Delta 4 (D-148 § A.11) — cert-expiry warning chip acceptance.
 *
 *  Two halves:
 *    - `formatCertExpiry` (pure) — severity + relative copy across the
 *      none / expired / warning / ok thresholds, incl. the 14-day
 *      near-expiry boundary that mirrors the backend renewal window.
 *    - the chip render through `mountHostnamesPanel` (fake DOM) — the
 *      chip appears on the row with the right `severity` attr for a
 *      warning / expired / ok cert, and is ABSENT when the row carries
 *      no cert. `now` is pinned so the relative copy is deterministic. */

import { describe, expect, it } from 'vitest';

import {
  HOSTNAMES_ROW_CERT_EXPIRY_ATTR,
  formatCertExpiry,
  mountHostnamesPanel,
  type HostnamesListCaller,
} from '../settings/hostnames.js';
import type { HostnameListResponse, HostnameProjection } from '@recued/contracts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

// ──────────────────────────────────────────────────────────────────
// formatCertExpiry (pure)
// ──────────────────────────────────────────────────────────────────

describe('R26.4 Delta 4 — formatCertExpiry', () => {
  it('undefined / 0 / non-finite (±Infinity, NaN) → none (no chip)', () => {
    expect(formatCertExpiry(undefined, NOW)).toEqual({ severity: 'none', text: '' });
    expect(formatCertExpiry(0, NOW)).toEqual({ severity: 'none', text: '' });
    expect(formatCertExpiry(Number.NaN, NOW).severity).toBe('none');
    expect(formatCertExpiry(Number.POSITIVE_INFINITY, NOW).severity).toBe('none');
    expect(formatCertExpiry(Number.NEGATIVE_INFINITY, NOW).severity).toBe('none');
  });

  it('at or past the expiry → expired (incl. the diff===0 zero-crossing)', () => {
    expect(formatCertExpiry(NOW, NOW)).toEqual({ severity: 'expired', text: 'the certificate has run out' });
    expect(formatCertExpiry(NOW - 1, NOW)).toEqual({ severity: 'expired', text: 'the certificate has run out' });
    expect(formatCertExpiry(NOW - 30 * DAY, NOW).severity).toBe('expired');
  });

  it('within the 14-day window → warning + relative days', () => {
    expect(formatCertExpiry(NOW + 5 * DAY, NOW)).toEqual({
      severity: 'warning',
      text: 'runs out in 5 days',
    });
  });

  it('exactly at the 14-day boundary → ok (exclusive `<`, matches backend renew-when-< window)', () => {
    expect(formatCertExpiry(NOW + 14 * DAY, NOW).severity).toBe('ok');
  });

  it('just under the 14-day boundary → warning', () => {
    expect(formatCertExpiry(NOW + 14 * DAY - 1, NOW).severity).toBe('warning');
  });

  it('exactly one day out → "runs out within a day" (days===1 bucket edge)', () => {
    expect(formatCertExpiry(NOW + DAY, NOW)).toEqual({
      severity: 'warning',
      text: 'runs out within a day',
    });
  });

  it('under a day → "runs out within a day" (still warning)', () => {
    expect(formatCertExpiry(NOW + 12 * 60 * 60 * 1000, NOW)).toEqual({
      severity: 'warning',
      text: 'runs out within a day',
    });
  });

  it('far future → ok + month-granularity copy (incl. the days===60 day/month bucket edge)', () => {
    expect(formatCertExpiry(NOW + 90 * DAY, NOW)).toEqual({
      severity: 'ok',
      text: 'runs out in 3 months',
    });
    // < 60 days stays in day-granularity; exactly 60 flips to months.
    expect(formatCertExpiry(NOW + 45 * DAY, NOW)).toEqual({
      severity: 'ok',
      text: 'runs out in 45 days',
    });
    expect(formatCertExpiry(NOW + 60 * DAY, NOW)).toEqual({
      severity: 'ok',
      text: 'runs out in 2 months',
    });
  });
});

// ──────────────────────────────────────────────────────────────────
// Fake DOM (same shape as the Delta-3 panel test)
// ──────────────────────────────────────────────────────────────────

interface FakeElement {
  tagName: string;
  textContent: string;
  disabled: boolean;
  className: string;
  type: string;
  children: FakeElement[];
  parent: FakeElement | null;
  attrs: Map<string, string>;
  listeners: Map<string, Array<(ev: unknown) => void>>;
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(el: FakeElement): FakeElement;
  removeChild(el: FakeElement): FakeElement;
  readonly firstChild: FakeElement | null;
  remove(): void;
  addEventListener(name: string, fn: (ev: unknown) => void): void;
  removeEventListener(name: string, fn: (ev: unknown) => void): void;
  click(): void;
}

const makeFakeElement = (tagName: string): FakeElement => {
  const listeners = new Map<string, Array<(ev: unknown) => void>>();
  const attrs = new Map<string, string>();
  const children: FakeElement[] = [];
  const el: FakeElement = {
    tagName: tagName.toUpperCase(),
    textContent: '',
    disabled: false,
    className: '',
    type: '',
    children,
    parent: null,
    attrs,
    listeners,
    setAttribute: (k, v) => attrs.set(k, v),
    removeAttribute: (k) => attrs.delete(k),
    getAttribute: (k) => attrs.get(k) ?? null,
    hasAttribute: (k) => attrs.has(k),
    appendChild: (next) => {
      children.push(next);
      next.parent = el;
      return next;
    },
    removeChild: (target) => {
      const idx = children.indexOf(target);
      if (idx < 0) throw new Error('removeChild: not a child');
      children.splice(idx, 1);
      target.parent = null;
      return target;
    },
    get firstChild() {
      return children[0] ?? null;
    },
    remove: () => {
      if (el.parent) el.parent.removeChild(el);
    },
    addEventListener: (name, fn) => {
      const arr = listeners.get(name) ?? [];
      arr.push(fn);
      listeners.set(name, arr);
    },
    removeEventListener: (name, fn) => {
      const arr = listeners.get(name);
      if (!arr) return;
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    },
    click: () => {
      for (const fn of listeners.get('click') ?? []) fn({ target: el });
    },
  };
  return el;
};

const makeFakeDocument = () => ({ createElement: (tag: string) => makeFakeElement(tag) });

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
  if (root.hasAttribute(attr)) out.push(root);
  for (const c of root.children) out.push(...findAllByAttr(c, attr));
  return out;
};

const sampleRow = (overrides: Partial<HostnameProjection> = {}): HostnameProjection => ({
  hostname_id: 'h-1',
  hostname: 'example.com',
  cert_source: 'recued_acme',
  ownership_status: 'verified',
  listener_ports: [443],
  ddns_managed: false,
  enabled: true,
  tls_topology: 'server_terminated',
  ...overrides,
});

const unusedCaller = (): never => {
  throw new Error('caller not expected in the list-render path');
};

const mountWith = (rows: HostnameProjection[]) => {
  const host = makeFakeElement('div');
  const doc = makeFakeDocument();
  const runList: HostnamesListCaller = async (): Promise<HostnameListResponse> => ({ hostnames: rows });
  const mount = mountHostnamesPanel({
    host: host as unknown as HTMLElement,
    document: doc as unknown as Document,
    runList,
    runGet: unusedCaller as never,
    runAdd: unusedCaller as never,
    runUpdate: unusedCaller as never,
    runRemove: unusedCaller as never,
    runVerifyOwnership: unusedCaller as never,
    now: () => NOW,
  });
  return { host, mount };
};

describe('R26.4 Delta 4 — cert-expiry chip render', () => {
  it('renders a warning chip with the relative copy for a near-expiry cert', async () => {
    const { host, mount } = mountWith([sampleRow({ cert_expires_at: NOW + 8 * DAY })]);
    await mount.whenLoaded();
    const chip = findByAttr(host, HOSTNAMES_ROW_CERT_EXPIRY_ATTR);
    expect(chip).not.toBeNull();
    expect(chip!.getAttribute(HOSTNAMES_ROW_CERT_EXPIRY_ATTR)).toBe('warning');
    expect(chip!.textContent).toContain('runs out in 8 days');
    expect(chip!.textContent).toContain('⚠');
    mount.dispose();
  });

  it('renders an expired chip for a lapsed cert', async () => {
    const { host, mount } = mountWith([sampleRow({ cert_expires_at: NOW - DAY })]);
    await mount.whenLoaded();
    const chip = findByAttr(host, HOSTNAMES_ROW_CERT_EXPIRY_ATTR);
    expect(chip!.getAttribute(HOSTNAMES_ROW_CERT_EXPIRY_ATTR)).toBe('expired');
    expect(chip!.textContent).toContain('the certificate has run out');
    mount.dispose();
  });

  it('renders an ok chip (no warning glyph) for a healthy cert', async () => {
    const { host, mount } = mountWith([sampleRow({ cert_expires_at: NOW + 120 * DAY })]);
    await mount.whenLoaded();
    const chip = findByAttr(host, HOSTNAMES_ROW_CERT_EXPIRY_ATTR);
    expect(chip!.getAttribute(HOSTNAMES_ROW_CERT_EXPIRY_ATTR)).toBe('ok');
    expect(chip!.textContent).not.toContain('⚠');
    mount.dispose();
  });

  it('renders NO chip when the row carries no cert', async () => {
    const { host, mount } = mountWith([sampleRow({ cert_expires_at: undefined })]);
    await mount.whenLoaded();
    expect(findByAttr(host, HOSTNAMES_ROW_CERT_EXPIRY_ATTR)).toBeNull();
    mount.dispose();
  });

  it('also renders the chip in the opened detail panel (2 chips: row + detail)', async () => {
    const row = sampleRow({ cert_expires_at: NOW + 8 * DAY });
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const mount = mountHostnamesPanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      runList: async () => ({ hostnames: [row] }),
      runGet: async () => ({ hostname: row }),
      runAdd: unusedCaller as never,
      runUpdate: unusedCaller as never,
      runRemove: unusedCaller as never,
      runVerifyOwnership: unusedCaller as never,
      now: () => NOW,
    });
    await mount.whenLoaded();
    // List render → one chip (the row).
    expect(findAllByAttr(host, HOSTNAMES_ROW_CERT_EXPIRY_ATTR)).toHaveLength(1);
    // Opening the detail loads the projection + renders a second chip.
    await mount.openDetail('example.com');
    expect(findAllByAttr(host, HOSTNAMES_ROW_CERT_EXPIRY_ATTR)).toHaveLength(2);
    mount.dispose();
  });

  it('uses a fresh now() per render (re-render with an advanced clock updates the copy)', async () => {
    const row = sampleRow({ cert_expires_at: NOW + 8 * DAY });
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    let clock = NOW;
    const mount = mountHostnamesPanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      runList: async () => ({ hostnames: [row] }),
      runGet: unusedCaller as never,
      runAdd: unusedCaller as never,
      runUpdate: unusedCaller as never,
      runRemove: unusedCaller as never,
      runVerifyOwnership: unusedCaller as never,
      now: () => clock,
    });
    await mount.whenLoaded();
    expect(findByAttr(host, HOSTNAMES_ROW_CERT_EXPIRY_ATTR)!.textContent).toContain('in 8 days');
    // Advance the clock 6 days + re-render via refresh: the chip reflects now().
    clock = NOW + 6 * DAY;
    await mount.refresh();
    expect(findByAttr(host, HOSTNAMES_ROW_CERT_EXPIRY_ATTR)!.textContent).toContain('in 2 days');
    mount.dispose();
  });
});
