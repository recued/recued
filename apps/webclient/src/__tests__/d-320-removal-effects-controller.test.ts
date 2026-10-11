/** D-320 slice 2g (ruling 16) — the Connections page's Delete dialog says what
 *  deleting does to the packs whose lists hold the connection
 *  (`runRemovalEffects` → `packs.connections.removal`). The same string-innerHTML
 *  fake host as the D-192 slice 5 controller test. */

import { describe, expect, it, vi } from 'vitest';
import type { ConnectionView } from '@recued/contracts';
import {
  mountConnectionsEnrollPanel,
  type ConnectionsDeleteCaller,
  type ConnectionsEnrollCaller,
  type ConnectionsEnrollListCaller,
  type ConnectionsProbeCaller,
  type ConnectionsRemovalEffectsCaller,
  type ConnectionsUpdateCaller,
} from '../settings/connections-enroll-panel.js';

const conn = (name: string): ConnectionView =>
  ({ name, kind: 'api', display_name: name } as ConnectionView);

const makeFakeHost = () => {
  let html = '';
  const listeners = new Map<string, Array<(ev: unknown) => void>>();
  const host = {
    get innerHTML() {
      return html;
    },
    set innerHTML(v: string) {
      html = v;
    },
    addEventListener(type: string, fn: (ev: unknown) => void) {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    removeEventListener() {},
    contains() {
      return true;
    },
    querySelector() {
      return null;
    },
  };
  const click = (data: Record<string, string>): void => {
    const el = { dataset: data, closest: () => el };
    for (const fn of [...(listeners.get('click') ?? [])]) fn({ target: el, preventDefault() {} });
  };
  return { host: host as unknown as HTMLElement, getHtml: () => html, click };
};

const tick = async (n = 10): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

const view = (connection_name: string): Awaited<ReturnType<ConnectionsRemovalEffectsCaller>> => ({
  connection_name,
  packs: [{
    pack_slug: 'hubspot',
    pack_name: 'HubSpot CRM',
    slot: 'hubspot',
    members: [],
    outcome: 'moves',
    before: { connection_name, display_name: 'Service Key' },
    after: { connection_name: 'hubspot-app', display_name: 'Sales app' },
    remaining: [{ connection_name: 'hubspot-app', display_name: 'Sales app' }],
  }],
});

const mountPanel = (runRemovalEffects?: ConnectionsRemovalEffectsCaller) => {
  const fake = makeFakeHost();
  const runDelete = vi.fn<ConnectionsDeleteCaller>(async () => ({ deleted: true }));
  mountConnectionsEnrollPanel({
    host: fake.host,
    document: {} as unknown as Document,
    runList: vi.fn<ConnectionsEnrollListCaller>(async () => ({ connections: [conn('hubspot-key'), conn('hubspot-app')] })),
    runEnroll: vi.fn<ConnectionsEnrollCaller>(),
    runUpdate: vi.fn<ConnectionsUpdateCaller>(),
    runDelete,
    runProbe: vi.fn<ConnectionsProbeCaller>(),
    ...(runRemovalEffects !== undefined ? { runRemovalEffects } : {}),
  });
  return { ...fake, runDelete };
};

describe("D-320 slice 2g — Delete says what changes for the owner's packs", () => {
  it('asks on open, says it is checking, then names each pack whose runs move', async () => {
    let answer: (v: Awaited<ReturnType<ConnectionsRemovalEffectsCaller>>) => void = () => undefined;
    const removal = vi.fn<ConnectionsRemovalEffectsCaller>(() => new Promise((resolve) => { answer = resolve; }));
    const h = mountPanel(removal);
    await tick();
    h.click({ action: 'connections-delete', kind: 'api', name: 'hubspot-key' });
    expect(removal).toHaveBeenCalledWith({ connection_name: 'hubspot-key', kind: 'api' });
    expect(h.getHtml()).toContain('Checking what changes for your packs');
    answer(view('hubspot-key'));
    await tick();
    expect(h.getHtml()).toContain('HubSpot CRM will run on Sales app from now on.');
    expect(h.runDelete).not.toHaveBeenCalled();
  });

  it('says it could not check when the call fails; a server without it says nothing', async () => {
    const failing = mountPanel(vi.fn<ConnectionsRemovalEffectsCaller>(async () => { throw new Error('boom'); }));
    await tick();
    failing.click({ action: 'connections-delete', kind: 'api', name: 'hubspot-key' });
    await tick();
    expect(failing.getHtml()).toContain('Could not check what changes for your packs.');

    const older = mountPanel(vi.fn<ConnectionsRemovalEffectsCaller>(async () => {
      throw Object.assign(new Error('no such method'), { code: 'unknown_method' });
    }));
    await tick();
    older.click({ action: 'connections-delete', kind: 'api', name: 'hubspot-key' });
    await tick();
    expect(older.getHtml()).toContain('Remove hubspot-key?');
    expect(older.getHtml()).not.toContain('data-connections-delete-effects');
  });

  it("drops an answer for a dialog that was closed and opened on another connection", async () => {
    const answers: Array<(v: Awaited<ReturnType<ConnectionsRemovalEffectsCaller>>) => void> = [];
    const removal = vi.fn<ConnectionsRemovalEffectsCaller>(() => new Promise((resolve) => { answers.push(resolve); }));
    const h = mountPanel(removal);
    await tick();
    h.click({ action: 'connections-delete', kind: 'api', name: 'hubspot-key' });
    h.click({ action: 'connections-delete-cancel' });
    h.click({ action: 'connections-delete', kind: 'api', name: 'hubspot-app' });
    answers[0]!(view('hubspot-key'));
    await tick();
    expect(h.getHtml()).toContain('Remove hubspot-app?');
    expect(h.getHtml()).not.toContain('HubSpot CRM will run on Sales app');
    expect(h.getHtml()).toContain('Checking what changes for your packs');
  });

  it('without the caller, the dialog is as before', async () => {
    const h = mountPanel();
    await tick();
    h.click({ action: 'connections-delete', kind: 'api', name: 'hubspot-key' });
    await tick();
    expect(h.getHtml()).toContain('Remove hubspot-key?');
    expect(h.getHtml()).not.toContain('data-connections-delete-effects');
  });
});
