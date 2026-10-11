/** D-320 slice 2h — the Connections page host mounts the per-sign-in grids into
 *  their placeholder after each render, and reads them again after a relist
 *  (an enroll, a delete). String-innerHTML fake host, as the D-192 slice 5
 *  controller test, with a placeholder the grid can be appended to. */

import { describe, expect, it, vi } from 'vitest';
import type { ConnectionView } from '@recued/contracts';
import { SIGNIN_GRIDS_HOST_ATTR } from '@recued/ui-shared';

import {
  mountConnectionsEnrollPanel,
  type ConnectionsDeleteCaller,
  type ConnectionsEnrollCaller,
  type ConnectionsEnrollListCaller,
  type ConnectionsProbeCaller,
  type ConnectionsUpdateCaller,
} from '../settings/connections-enroll-panel.js';
import { SIGNIN_GRIDS_ATTR, SIGNIN_OFFER_ATTR, type SignInGridCallers } from '../connections/sign-in-grid-controls.js';

interface Node {
  tagName: string;
  textContent: string;
  className: string;
  children: Node[];
  attrs: Map<string, string>;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(n: Node): Node;
  addEventListener(): void;
  [key: string]: unknown;
}
const node = (tag: string): Node => {
  const n: Node = {
    tagName: tag.toUpperCase(),
    textContent: '',
    className: '',
    children: [],
    attrs: new Map(),
    setAttribute: (k, v) => void n.attrs.set(k, v),
    getAttribute: (k) => n.attrs.get(k) ?? null,
    hasAttribute: (k) => n.attrs.has(k),
    appendChild: (c) => {
      n.children.push(c);
      return c;
    },
    addEventListener: () => undefined,
  };
  return n;
};

const makeFakeHost = () => {
  let html = '';
  /** The placeholder of the last render, which the grid is appended to. */
  let slot: Node | null = null;
  const listeners = new Map<string, Array<(ev: unknown) => void>>();
  const host = {
    get innerHTML() {
      return html;
    },
    set innerHTML(v: string) {
      html = v;
      slot = v.includes(SIGNIN_GRIDS_HOST_ATTR) ? node('div') : null;
    },
    addEventListener(type: string, fn: (ev: unknown) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    removeEventListener() {},
    contains() {
      return true;
    },
    querySelector(selector: string) {
      return selector === `[${SIGNIN_GRIDS_HOST_ATTR}]` ? slot : null;
    },
  };
  const click = (data: Record<string, string>): void => {
    const el = {
      dataset: data,
      closest: () => el,
      setAttribute: () => undefined,
      removeAttribute: () => undefined,
      getAttribute: () => null,
    };
    for (const fn of [...(listeners.get('click') ?? [])]) fn({ target: el, preventDefault() {} });
  };
  /** A field edit on a `data-conn-field` control. */
  const field = (key: string, value: string): void => {
    const el = { dataset: { connField: key }, value, tagName: 'INPUT', closest: () => el };
    for (const fn of [...(listeners.get('input') ?? [])]) fn({ target: el, type: 'input' });
  };
  return { host: host as unknown as HTMLElement, getHtml: () => html, getSlot: () => slot, click, field };
};

const tick = async (n = 20): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

const conn = (name: string): ConnectionView => ({ name, kind: 'api', display_name: name } as ConnectionView);

const gridCallers = (calls: string[]): SignInGridCallers => ({
  signins: async () => {
    calls.push('signins');
    return {
      signins: [{
        slot: 'hubspot',
        label: 'HubSpot',
        connections: [
          { connection_name: 'hubspot-key', display_name: 'Service Key' },
          { connection_name: 'hubspot-app', display_name: 'Sales app' },
        ],
        rows: [{
          pack_slug: 'hubspot',
          pack_name: 'HubSpot CRM',
          members: [],
          cells: { 'hubspot-key': 'default', 'hubspot-app': 'available' },
          default: 'hubspot-key',
        }],
      }],
    };
  },
  add: async () => ({}),
  remove: async () => ({}),
  setDefault: async () => ({}),
  addMany: async () => ({ signins: [] }),
});

const mountPanel = (signInGridCallers?: SignInGridCallers) => {
  const fake = makeFakeHost();
  mountConnectionsEnrollPanel({
    host: fake.host,
    document: { createElement: (tag: string) => node(tag) } as unknown as Document,
    runList: vi.fn<ConnectionsEnrollListCaller>(async () => ({ connections: [conn('hubspot-key'), conn('hubspot-app')] })),
    runEnroll: vi.fn<ConnectionsEnrollCaller>(async (args) => ({
      connection: { ...conn(args.name), display_name: args.display_name } as ConnectionView,
      probe: { status: 'ok' } as never,
    })),
    runUpdate: vi.fn<ConnectionsUpdateCaller>(),
    runDelete: vi.fn<ConnectionsDeleteCaller>(async () => ({ deleted: true })),
    runProbe: vi.fn<ConnectionsProbeCaller>(async () => ({ status: 'ok' }) as never),
    ...(signInGridCallers !== undefined ? { signInGridCallers } : {}),
  });
  return fake;
};

describe('D-320 slice 2h — the Connections page mounts the grids', () => {
  it('opens the API group with the placeholder, and mounts the grids read from the server into it', async () => {
    const calls: string[] = [];
    const h = mountPanel(gridCallers(calls));
    await tick();
    expect(h.getHtml()).toContain(SIGNIN_GRIDS_HOST_ATTR);
    expect(calls).toEqual(['signins']);
    const mounted = h.getSlot()!.children[0]!;
    expect(mounted.hasAttribute(SIGNIN_GRIDS_ATTR)).toBe(true);
  });

  it('without the calls, there is no placeholder and nothing is read', async () => {
    const h = mountPanel();
    await tick();
    expect(h.getHtml()).not.toContain(SIGNIN_GRIDS_HOST_ATTR);
  });

  it('reads the grids again after a delete relists the connections', async () => {
    const calls: string[] = [];
    const h = mountPanel(gridCallers(calls));
    await tick();
    h.click({ action: 'connections-delete', kind: 'api', name: 'hubspot-app' });
    await tick();
    h.click({ action: 'connections-delete-confirm', kind: 'api', name: 'hubspot-app' });
    await tick();
    expect(calls).toEqual(['signins', 'signins']);
  });

  it('a newly set-up API connection asks which packs may use it (slice 2i)', async () => {
    const calls: string[] = [];
    const callers = gridCallers(calls);
    const h = mountPanel(callers);
    await tick();
    h.click({ action: 'connections-open-add' });
    h.click({ action: 'connections-pick-kind', kind: 'api' });
    h.field('name', 'hubspot-app');
    h.field('display_name', 'Sales app');
    h.field('config.base_url', 'https://api.hubapi.com');
    h.field('auth.token', 'pat-x');
    h.click({ action: 'connections-submit-form' });
    await tick(40);
    // The relist read the grids again, and the question is open for the new connection.
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const mounted = h.getSlot()!.children[0]!;
    const walk = (n: Node): Node[] => [n, ...n.children.flatMap(walk)];
    expect(walk(mounted).some((n) => n.getAttribute(SIGNIN_OFFER_ATTR) === 'hubspot-app')).toBe(true);
  });
});
