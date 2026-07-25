/** Connections-readiness controller — pack-row scope-coverage block.
 *
 *  Covers the pure `resolveSlotStatus` (vendor-match + the multi-account
 *  reduce + the 5 status outcomes) and the `renderForPack` DOM output
 *  (null when no scope-bearing connection; rows + status attrs + CTA). */

import { describe, expect, it } from 'vitest';
import type { ConnectionView, PackListEntry } from '@recued/contracts';

import {
  createConnectionsReadinessController,
  resolveSlotStatus,
  CONNECTIONS_READINESS_SECTION_ATTR,
  CONNECTIONS_READINESS_ROW_ATTR,
  CONNECTIONS_READINESS_STATUS_ATTR,
  CONNECTIONS_READINESS_CTA_ATTR,
} from '../connections-readiness-controls.js';

// ── minimal fake DOM (mirrors the other webclient render tests) ──
interface FakeElement {
  tagName: string;
  textContent: string;
  className: string;
  children: FakeElement[];
  parent: FakeElement | null;
  attrs: Map<string, string>;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(el: FakeElement): FakeElement;
  removeChild(el: FakeElement): FakeElement;
  remove(): void;
}
const makeFakeElement = (tagName: string): FakeElement => {
  const el: FakeElement = {
    tagName: tagName.toUpperCase(),
    textContent: '',
    className: '',
    children: [],
    parent: null,
    attrs: new Map(),
    setAttribute(k, v) { el.attrs.set(k, v); },
    getAttribute(k) { return el.attrs.get(k) ?? null; },
    hasAttribute(k) { return el.attrs.has(k); },
    appendChild(child) { el.children.push(child); child.parent = el; return child; },
    removeChild(child) {
      const i = el.children.indexOf(child);
      if (i >= 0) { el.children.splice(i, 1); child.parent = null; }
      return child;
    },
    remove() { if (el.parent) el.parent.removeChild(el); },
  };
  return el;
};
const makeFakeDocument = () => ({ createElement: makeFakeElement });
const textOf = (el: FakeElement): string =>
  `${el.textContent}${el.children.map(textOf).join('')}`;
const findAllByAttr = (
  root: FakeElement, attr: string, value?: string, out: FakeElement[] = [],
): FakeElement[] => {
  if (root.hasAttribute(attr) && (value === undefined || root.getAttribute(attr) === value)) {
    out.push(root);
  }
  for (const c of root.children) findAllByAttr(c, attr, value, out);
  return out;
};
const findByAttr = (root: FakeElement, attr: string, value?: string): FakeElement | null =>
  findAllByAttr(root, attr, value)[0] ?? null;

// ── fixtures ──
const conn = (
  vendor: string,
  granted_scopes?: string[],
  extra: Partial<ConnectionView> = {},
): ConnectionView =>
  ({
    name: extra.name ?? vendor,
    kind: 'api',
    display_name: extra.display_name ?? `${vendor} account`,
    vendor,
    ...(granted_scopes !== undefined ? { granted_scopes } : {}),
    ...extra,
  }) as ConnectionView;

const httpIngredient = (slug: string, connection: string): unknown => ({
  slug, kind: 'http', http: { base: 'https://x', connection },
});
const op = (opId: string, ingredient: string, required_scopes?: string[]): unknown => ({
  op: opId, ingredient, risk: 'read', approval: 'never',
  bind: { method: 'GET', path: '/' },
  ...(required_scopes !== undefined ? { required_scopes } : {}),
});
const packWith = (ingredients: unknown[], operations: unknown[]): PackListEntry =>
  ({
    slug: 'p',
    manifest: {
      contents: [{ type: 'composition', composition: { schema_version: 1, slug: 'c', ingredients, operations } }],
    },
  }) as unknown as PackListEntry;

describe('resolveSlotStatus (vendor-match + reduce)', () => {
  it('not_set_up when no api connection carries the vendor', () => {
    expect(resolveSlotStatus('hubspot', ['s'], [])).toEqual({ status: 'not_set_up' });
    expect(resolveSlotStatus('hubspot', ['s'], [conn('slack', ['s'])]))
      .toEqual({ status: 'not_set_up' });
  });

  it('covered when a backing connection grants every needed scope', () => {
    expect(resolveSlotStatus('hubspot', ['a'], [conn('hubspot', ['a', 'b'])]))
      .toEqual({ status: 'covered', label: 'hubspot account' });
  });

  it('under_scoped with the missing diff when granted but incomplete', () => {
    expect(resolveSlotStatus('hubspot', ['a', 'b'], [conn('hubspot', ['a'])]))
      .toEqual({ status: 'under_scoped', label: 'hubspot account', missing: ['b'] });
  });

  it('unverified when enrolled but granted scopes are unknown', () => {
    expect(resolveSlotStatus('hubspot', ['a'], [conn('hubspot', undefined)]))
      .toEqual({ status: 'unverified', label: 'hubspot account' });
  });

  it('no-scope slot (API-key, e.g. Stripe): covered when enrolled — no scope to verify', () => {
    // An enrolled connection with nothing to verify is ready, regardless of
    // whether granted scopes are known (undefined) or an empty set.
    expect(resolveSlotStatus('stripe', [], [conn('stripe', undefined)]))
      .toEqual({ status: 'covered', label: 'stripe account' });
    expect(resolveSlotStatus('stripe', [], [conn('stripe', [])]))
      .toEqual({ status: 'covered', label: 'stripe account' });
  });

  it('no-scope slot: not_set_up when no backing connection is enrolled', () => {
    expect(resolveSlotStatus('stripe', [], [])).toEqual({ status: 'not_set_up' });
  });

  it('unknown_enrollment when the connection list is unavailable (null)', () => {
    expect(resolveSlotStatus('hubspot', ['a'], null)).toEqual({ status: 'unknown_enrollment' });
  });

  it('multi-account: any covered connection wins over an under-scoped one', () => {
    const status = resolveSlotStatus('hubspot', ['a', 'b'], [
      conn('hubspot', ['a'], { name: 'hs1', display_name: 'HS 1' }),
      conn('hubspot', ['a', 'b'], { name: 'hs2', display_name: 'HS 2' }),
    ]);
    expect(status).toEqual({ status: 'covered', label: 'HS 2' });
  });

  it('multi-account: picks the under-scoped connection with the FEWEST missing', () => {
    const status = resolveSlotStatus('hubspot', ['a', 'b', 'c'], [
      conn('hubspot', ['a'], { name: 'hs1', display_name: 'HS 1' }),       // missing b,c
      conn('hubspot', ['a', 'b'], { name: 'hs2', display_name: 'HS 2' }),  // missing c
    ]);
    expect(status).toEqual({ status: 'under_scoped', label: 'HS 2', missing: ['c'] });
  });

  it('resolves the vendor from subtype when config.vendor is absent', () => {
    const c = { name: 'hs', kind: 'api', display_name: 'HS', subtype: 'hubspot', granted_scopes: ['a'] } as ConnectionView;
    expect(resolveSlotStatus('hubspot', ['a'], [c])).toEqual({ status: 'covered', label: 'HS' });
  });
});

describe('createConnectionsReadinessController.renderForPack', () => {
  const mount = (connections: ConnectionView[] | 'no-caller') =>
    createConnectionsReadinessController({
      document: makeFakeDocument() as unknown as Document,
      ...(connections === 'no-caller'
        ? {}
        : { runConnectionList: () => Promise.resolve({ connections }) }),
    });

  it('returns null for a pack that binds no connection at all (cli-only)', async () => {
    const ctrl = mount([]);
    await ctrl.refresh();
    // cli ingredient → no connection slot → nothing to render
    const pack = packWith(
      [{ slug: 'whisper', kind: 'cli' }],
      [op('transcribe', 'whisper', ['ignored'])],
    );
    expect(ctrl.renderForPack(pack)).toBeNull();
  });

  it('renders a NO-SCOPE (API-key) connection row — the Stripe case, not_set_up + Set up CTA', async () => {
    const ctrl = mount([]); // no enrolled connection
    await ctrl.refresh();
    // http connection with NO required_scopes — previously omitted entirely.
    const pack = packWith(
      [httpIngredient('stripe-billing', 'stripe')],
      [op('invoice.read', 'stripe-billing')],
    );
    const section = ctrl.renderForPack(pack) as unknown as FakeElement;
    expect(section).not.toBeNull();
    const row = findByAttr(section, CONNECTIONS_READINESS_ROW_ATTR, 'stripe')!;
    expect(row.getAttribute(CONNECTIONS_READINESS_STATUS_ATTR)).toBe('not_set_up');
    const cta = findByAttr(section, CONNECTIONS_READINESS_CTA_ATTR)!;
    expect(cta.getAttribute('href')).toBe('#connections/others/enroll/stripe');
    expect(textOf(cta)).toContain('Set up');
  });

  it('renders a NO-SCOPE connection as connected (no "scopes not verified") once enrolled', async () => {
    const ctrl = mount([conn('stripe', undefined)]); // enrolled, API-key (no granted scopes)
    await ctrl.refresh();
    const pack = packWith(
      [httpIngredient('stripe-billing', 'stripe')],
      [op('invoice.read', 'stripe-billing')],
    );
    const section = ctrl.renderForPack(pack) as unknown as FakeElement;
    const row = findByAttr(section, CONNECTIONS_READINESS_ROW_ATTR, 'stripe')!;
    expect(row.getAttribute(CONNECTIONS_READINESS_STATUS_ATTR)).toBe('covered');
    expect(textOf(row)).toContain('connected');
    expect(textOf(row)).not.toContain('not verified');
    expect(findByAttr(section, CONNECTIONS_READINESS_CTA_ATTR)).toBeNull();
  });

  it('renders a connected row (no CTA) when covered', async () => {
    const ctrl = mount([conn('hubspot', ['crm.objects.deals.read'])]);
    await ctrl.refresh();
    const pack = packWith(
      [httpIngredient('hs', 'hubspot')],
      [op('deal.read', 'hs', ['crm.objects.deals.read'])],
    );
    const section = ctrl.renderForPack(pack) as unknown as FakeElement;
    expect(section).not.toBeNull();
    const row = findByAttr(section, CONNECTIONS_READINESS_ROW_ATTR, 'hubspot')!;
    expect(row.getAttribute(CONNECTIONS_READINESS_STATUS_ATTR)).toBe('covered');
    expect(textOf(row)).toContain('connected');
    expect(findByAttr(section, CONNECTIONS_READINESS_CTA_ATTR)).toBeNull();
  });

  it('renders not_set_up + a "Set up" CTA when no backing connection', async () => {
    const ctrl = mount([]);
    await ctrl.refresh();
    const pack = packWith(
      [httpIngredient('hs', 'hubspot')],
      [op('deal.read', 'hs', ['crm.objects.deals.read'])],
    );
    const section = ctrl.renderForPack(pack) as unknown as FakeElement;
    const row = findByAttr(section, CONNECTIONS_READINESS_ROW_ATTR, 'hubspot')!;
    expect(row.getAttribute(CONNECTIONS_READINESS_STATUS_ATTR)).toBe('not_set_up');
    const cta = findByAttr(section, CONNECTIONS_READINESS_CTA_ATTR)!;
    expect(cta.getAttribute('href')).toBe('#connections/others/enroll/hubspot');
    expect(textOf(cta)).toContain('Set up');
  });

  it('renders under_scoped with the missing scopes + a "Re-authorize" CTA', async () => {
    const ctrl = mount([conn('hubspot', ['crm.objects.deals.read'])]);
    await ctrl.refresh();
    const pack = packWith(
      [httpIngredient('hs', 'hubspot')],
      [op('deal.write', 'hs', ['crm.objects.deals.read', 'crm.objects.deals.write'])],
    );
    const section = ctrl.renderForPack(pack) as unknown as FakeElement;
    const row = findByAttr(section, CONNECTIONS_READINESS_ROW_ATTR, 'hubspot')!;
    expect(row.getAttribute(CONNECTIONS_READINESS_STATUS_ATTR)).toBe('under_scoped');
    expect(textOf(row)).toContain('crm.objects.deals.write');
    expect(textOf(findByAttr(section, CONNECTIONS_READINESS_CTA_ATTR)!)).toContain('Re-authorize');
  });

  it('renders unknown_enrollment (soft) when no list caller is wired', async () => {
    const ctrl = mount('no-caller');
    await ctrl.refresh(); // no-op without a caller
    expect(ctrl.connections()).toBeNull();
    const pack = packWith(
      [httpIngredient('hs', 'hubspot')],
      [op('deal.read', 'hs', ['crm.objects.deals.read'])],
    );
    const section = ctrl.renderForPack(pack) as unknown as FakeElement;
    const row = findByAttr(section, CONNECTIONS_READINESS_ROW_ATTR, 'hubspot')!;
    expect(row.getAttribute(CONNECTIONS_READINESS_STATUS_ATTR)).toBe('unknown_enrollment');
    expect(findByAttr(section, CONNECTIONS_READINESS_CTA_ATTR)).not.toBeNull();
  });

  it('degrades to unknown_enrollment when the list caller throws', async () => {
    const ctrl = createConnectionsReadinessController({
      document: makeFakeDocument() as unknown as Document,
      runConnectionList: () => Promise.reject(new Error('rpc down')),
    });
    await ctrl.refresh();
    expect(ctrl.connections()).toBeNull();
    const pack = packWith(
      [httpIngredient('hs', 'hubspot')],
      [op('deal.read', 'hs', ['crm.objects.deals.read'])],
    );
    const section = ctrl.renderForPack(pack) as unknown as FakeElement;
    expect(findByAttr(section, CONNECTIONS_READINESS_ROW_ATTR, 'hubspot')!
      .getAttribute(CONNECTIONS_READINESS_STATUS_ATTR)).toBe('unknown_enrollment');
  });
});
