/** Connections-readiness controller — pack-row scope-coverage block.
 *
 *  Covers the pure `resolveSlotStatus` (vendor-match + the multi-account
 *  reduce + the 5 status outcomes) and the `renderForPack` DOM output
 *  (null when no scope-bearing connection; rows + status attrs + CTA). */

import { describe, expect, it } from 'vitest';
import type { ConnectionView, PackListEntry } from '@recued/contracts';

import {
  connectionNeedsFromSignIns,
  createConnectionsReadinessController,
  rejectedConnectionSlots,
  resolveSlotStatus,
  unsetConnectionSlots,
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

describe('unsetConnectionSlots — what the pack list badge counts (D-321)', () => {
  it('counts every connection a list row signs in to that nothing backs, an API-key one too', () => {
    // A `packs.list` row: no manifest, but its requirements and scopes.
    const row = {
      connection_requirements: [{ vendor: 'exa' }, { vendor: 'hubspot' }],
      required_scopes_by_connection: { hubspot: ['crm.read'] },
    } as unknown as Pick<PackListEntry, 'connection_requirements' | 'required_scopes_by_connection'>;
    expect(unsetConnectionSlots(row, [])).toEqual(['exa', 'hubspot']);
    // An API-key connection backs `exa` with no scopes to check.
    expect(unsetConnectionSlots(row, [conn('exa', undefined)])).toEqual(['hubspot']);
    expect(unsetConnectionSlots(row, [conn('exa', undefined), conn('hubspot', ['crm.read'])])).toEqual([]);
    // Unknown is not missing: no connection list counts none.
    expect(unsetConnectionSlots(row, null)).toEqual([]);
  });
});

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

  it('under_scoped from a pasted key says so, so its fix is not a sign-in', () => {
    expect(resolveSlotStatus('hubspot', ['a', 'b'], [
      conn('hubspot', ['a'], { auth_type: 'bearer' }),
    ])).toEqual({ status: 'under_scoped', label: 'hubspot account', missing: ['b'], key: true });
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

/** D-321 P3 — the page said "connected" while the service turned down every call.
 *  `collection.connection.list` stamps each view's `health`; a run's own call
 *  writes it, and a failure stands until something succeeds. */
describe('a sign-in the service turned down (D-321 P3)', () => {
  const rejected = (vendor: string, extra: Partial<ConnectionView> = {}) =>
    conn(vendor, undefined, { health: { status: 'auth_failed', last_probed_at: 1 }, ...extra });

  it('a slot whose every connection was turned down is rejected, naming the one to reconnect', () => {
    expect(resolveSlotStatus('exa', [], [rejected('exa', { name: 'exa-key', display_name: 'Exa key' })]))
      .toEqual({ status: 'rejected', label: 'Exa key', name: 'exa-key' });
    // Scopes do not make it usable.
    expect(resolveSlotStatus('hubspot', ['crm.read'], [rejected('hubspot', { granted_scopes: ['crm.read'] })]).status)
      .toBe('rejected');
  });

  it('one that works still backs the slot; only a turned-down sign-in counts, never "unreachable" or an aged "ok"', () => {
    expect(resolveSlotStatus('exa', [], [rejected('exa'), conn('exa', undefined, { name: 'exa-team' })]))
      .toEqual({ status: 'covered', label: 'exa account' });
    for (const status of ['unreachable', 'unknown', 'ok'] as const) {
      expect(resolveSlotStatus('exa', [], [conn('exa', undefined, { health: { status } })]).status).toBe('covered');
    }
  });

  it('the pack list counts it apart from a connection never set up', () => {
    const row = {
      connection_requirements: [{ vendor: 'exa' }, { vendor: 'hubspot' }],
      required_scopes_by_connection: {},
    } as unknown as Pick<PackListEntry, 'connection_requirements' | 'required_scopes_by_connection'>;
    expect(rejectedConnectionSlots(row, [rejected('exa')])).toEqual(['exa']);
    expect(unsetConnectionSlots(row, [rejected('exa')])).toEqual(['hubspot']);
    expect(rejectedConnectionSlots(row, null)).toEqual([]);
  });

  it("renders it as not accepted, with Reconnect to that connection's editor", async () => {
    const ctrl = createConnectionsReadinessController({
      document: makeFakeDocument() as unknown as Document,
      runConnectionList: () => Promise.resolve({ connections: [rejected('exa', { name: 'exa-key' })] }),
    });
    await ctrl.refresh();
    const section = ctrl.renderForPack(packWith(
      [httpIngredient('exa-catalog', 'exa')],
      [op('search', 'exa-catalog')],
    )) as unknown as FakeElement;
    const row = findByAttr(section, CONNECTIONS_READINESS_ROW_ATTR, 'exa')!;
    expect(row.getAttribute(CONNECTIONS_READINESS_STATUS_ATTR)).toBe('rejected');
    expect(textOf(row)).toContain('sign-in not accepted');
    expect(textOf(row)).not.toContain('connected');
    const cta = findByAttr(section, CONNECTIONS_READINESS_CTA_ATTR)!;
    expect(textOf(cta)).toBe('Reconnect →');
    expect(cta.getAttribute('href')).toBe('#connections/others/review-access/api/exa-key');
  });
});

/** D-321 P4 — the pack list's badges from each pack's own list
 *  (`packs.connections.signins`), which is what its page's one block shows. */
describe("connectionNeedsFromSignIns — the list badges from each pack's own list (D-321 P4)", () => {
  const row = (pack_slug: string, cells: Record<string, string>, members: string[] = []) =>
    ({ pack_slug, members: members.map((slug) => ({ pack_slug: slug })), cells });
  const turnedDown = (vendor: string, name: string) =>
    conn(vendor, undefined, { name, health: { status: 'auth_failed', last_probed_at: 1 } });

  it('a list holding no set-up connection is unset, for the pack and each pack signing in through it', () => {
    const needs = connectionNeedsFromSignIns(
      [{ slot: 'hubspot', rows: [row('hubspot', { 'hubspot-app': 'available' }, ['hubspot-deals'])] }],
      [conn('hubspot', undefined, { name: 'hubspot-app' })],
    );
    expect(needs.get('hubspot')).toEqual({ unset: ['hubspot'], rejected: [] });
    expect(needs.get('hubspot-deals')).toEqual({ unset: ['hubspot'], rejected: [] });
  });

  it('every listed connection turned down is rejected; one listed that works needs nothing', () => {
    const key = turnedDown('exa', 'exa-key');
    expect(connectionNeedsFromSignIns([{ slot: 'exa', rows: [row('exa', { 'exa-key': 'default' })] }], [key]).get('exa'))
      .toEqual({ unset: [], rejected: ['exa'] });
    expect(connectionNeedsFromSignIns(
      [{ slot: 'exa', rows: [row('exa', { 'exa-key': 'default', 'exa-team': 'listed' })] }],
      [key, conn('exa', undefined, { name: 'exa-team' })],
    ).has('exa')).toBe(false);
  });

  it("a working connection of the service that is not on the list is not one the pack has, as its page says", () => {
    expect(connectionNeedsFromSignIns(
      [{ slot: 'exa', rows: [row('exa', { 'exa-other': 'available' })] }],
      [conn('exa', undefined, { name: 'exa-other' })],
    ).get('exa')).toEqual({ unset: ['exa'], rejected: [] });
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
    expect(cta.getAttribute('href')).toBe('#connections/others/enroll/stripe/pack/p/stripe');
    expect(textOf(cta)).toContain('Set up');
  });

  it('renders a NO-SCOPE connection as connected (no "Recued has not checked what it may do") once enrolled', async () => {
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
    expect(cta.getAttribute('href')).toBe('#connections/others/enroll/hubspot/pack/p/hubspot');
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

  it('sends a pasted key that lacks a scope to Probe, not to a new sign-in', async () => {
    // A HubSpot Service Key keeps its value when the owner adds a scope in
    // HubSpot; Probe on the connection then reads the scopes again.
    const pack = packWith(
      [httpIngredient('hs', 'hubspot')],
      [op('deal.write', 'hs', ['crm.objects.deals.read', 'crm.objects.deals.write'])],
    );
    const one = mount([conn('hubspot', ['crm.objects.deals.read'], { auth_type: 'bearer' })]);
    await one.refresh();
    const section = one.renderForPack(pack) as unknown as FakeElement;
    const row = findByAttr(section, CONNECTIONS_READINESS_ROW_ATTR, 'hubspot')!;
    expect(row.getAttribute(CONNECTIONS_READINESS_STATUS_ATTR)).toBe('under_scoped');
    expect(textOf(row)).toContain('missing crm.objects.deals.write');
    const cta = findByAttr(section, CONNECTIONS_READINESS_CTA_ATTR)!;
    expect(textOf(cta)).toBe('Add it to the key, then Probe →');
    expect(cta.getAttribute('href')).toBe('#connections/others');

    const two = mount([conn('hubspot', [], { auth_type: 'bearer', granted_scopes: ['x'] })]);
    await two.refresh();
    const both = findByAttr(two.renderForPack(pack) as unknown as FakeElement, CONNECTIONS_READINESS_CTA_ATTR)!;
    expect(textOf(both)).toBe('Add them to the key, then Probe →');
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
