/** D-192 slice 5 — the delete-confirm CONTROLLER flow (connections enroll panel).
 *
 *  A Delete click now OPENS a confirm + fetches the `previewPurge` count (no rpc
 *  mutates yet); Remove runs the delete with the `remove_mirror_data` opt-in;
 *  Cancel closes without deleting. Uses the string-innerHTML fake host the
 *  d-165 panel test established (delegated click dispatch, no jsdom).
 */

import { describe, expect, it, vi } from 'vitest';
import type { ConnectionView } from '@recued/contracts';
import {
  mountConnectionsEnrollPanel,
  type ConnectionsDeleteCaller,
  type ConnectionsEnrollCaller,
  type ConnectionsEnrollListCaller,
  type ConnectionsPreviewPurgeCaller,
  type ConnectionsProbeCaller,
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
  const fire = (type: string, ev: unknown): void => {
    for (const fn of [...(listeners.get(type) ?? [])]) fn(ev);
  };
  const click = (data: Record<string, string>): void => {
    const el = { dataset: data, closest: () => el };
    fire('click', { target: el, preventDefault() {} });
  };
  return { host: host as unknown as HTMLElement, getHtml: () => html, click };
};

const tick = async (n = 10): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

const mountPanel = (
  opts: {
    withPreview?: boolean;
    previewCount?: number;
    previewImpl?: ConnectionsPreviewPurgeCaller;
    connections?: string[];
  } = {},
) => {
  const fake = makeFakeHost();
  const runList = vi.fn<ConnectionsEnrollListCaller>(async () => ({
    connections: (opts.connections ?? ['acme-hubspot']).map(conn),
  }));
  const runDelete = vi.fn<ConnectionsDeleteCaller>(async () => ({ deleted: true }));
  const runPreviewPurge = vi.fn<ConnectionsPreviewPurgeCaller>(
    opts.previewImpl ?? (async () => ({ count: opts.previewCount ?? 5 })),
  );
  const mount = mountConnectionsEnrollPanel({
    host: fake.host,
    document: {} as unknown as Document,
    runList,
    runEnroll: vi.fn<ConnectionsEnrollCaller>(),
    runUpdate: vi.fn<ConnectionsUpdateCaller>(),
    runDelete,
    runProbe: vi.fn<ConnectionsProbeCaller>(),
    ...(opts.withPreview === false ? {} : { runPreviewPurge }),
  });
  return { ...fake, mount, runList, runDelete, runPreviewPurge };
};

describe('D-192 slice 5 — delete-confirm controller flow', () => {
  it('Delete opens the confirm + fetches the count; no delete until confirmed', async () => {
    const h = mountPanel({ previewCount: 7 });
    await tick(); // initial list load

    h.click({ action: 'connections-delete', kind: 'api', name: 'acme-hubspot' });
    // Confirm is open; previewPurge was fired; delete has NOT run.
    expect(h.getHtml()).toContain('Remove acme-hubspot?');
    expect(h.runPreviewPurge).toHaveBeenCalledWith({ name: 'acme-hubspot', kind: 'api' });
    expect(h.runDelete).not.toHaveBeenCalled();

    await tick(); // previewPurge resolves → count fills the checkbox
    expect(h.getHtml()).toContain('Also remove the 7 items this connection synced');
  });

  it('Remove runs the delete with remove_mirror_data when opted in, then refreshes', async () => {
    const h = mountPanel({ previewCount: 3 });
    await tick();

    h.click({ action: 'connections-delete', kind: 'api', name: 'acme-hubspot' });
    await tick(); // count resolves
    h.click({ action: 'connections-delete-toggle-mirror' }); // check the box
    expect(h.getHtml()).toMatch(/checked/);

    const listCallsBefore = h.runList.mock.calls.length;
    h.click({ action: 'connections-delete-confirm', kind: 'api', name: 'acme-hubspot' });
    await tick();

    expect(h.runDelete).toHaveBeenCalledWith({
      name: 'acme-hubspot',
      kind: 'api',
      remove_mirror_data: true,
    });
    // Confirm closed + list refreshed.
    expect(h.getHtml()).not.toContain('Remove acme-hubspot?');
    expect(h.runList.mock.calls.length).toBeGreaterThan(listCallsBefore);
  });

  it('Remove without opting in deletes with remove_mirror_data:false (mirror kept)', async () => {
    const h = mountPanel({ previewCount: 4 });
    await tick();
    h.click({ action: 'connections-delete', kind: 'api', name: 'acme-hubspot' });
    await tick();
    h.click({ action: 'connections-delete-confirm', kind: 'api', name: 'acme-hubspot' });
    await tick();
    expect(h.runDelete).toHaveBeenCalledWith({
      name: 'acme-hubspot',
      kind: 'api',
      remove_mirror_data: false,
    });
  });

  it('Cancel closes the confirm without deleting', async () => {
    const h = mountPanel();
    await tick();
    h.click({ action: 'connections-delete', kind: 'api', name: 'acme-hubspot' });
    await tick();
    h.click({ action: 'connections-delete-cancel' });
    expect(h.getHtml()).not.toContain('Remove acme-hubspot?');
    expect(h.runDelete).not.toHaveBeenCalled();
  });

  it('degrades to a plain confirm (no checkbox) when previewPurge is unwired', async () => {
    const h = mountPanel({ withPreview: false });
    await tick();
    h.click({ action: 'connections-delete', kind: 'api', name: 'acme-hubspot' });
    await tick();
    expect(h.getHtml()).toContain('Remove acme-hubspot?');
    expect(h.getHtml()).not.toContain('connections-delete-toggle-mirror');
    // Remove still works — deletes with the mirror kept.
    h.click({ action: 'connections-delete-confirm', kind: 'api', name: 'acme-hubspot' });
    await tick();
    expect(h.runDelete).toHaveBeenCalledWith({
      name: 'acme-hubspot',
      kind: 'api',
      remove_mirror_data: false,
    });
  });

  // ── Codex-review fixes ─────────────────────────────────────────

  it('drops a stale preview that lands after cancel+reopen of the same row', async () => {
    let resolveFirst!: (v: { count: number }) => void;
    let n = 0;
    const previewImpl: ConnectionsPreviewPurgeCaller = async () => {
      n += 1;
      if (n === 1) return new Promise<{ count: number }>((r) => { resolveFirst = r; });
      return { count: 3 };
    };
    const h = mountPanel({ previewImpl });
    await tick();

    // open (preview #1 hangs), cancel, reopen the SAME row (preview #2 → 3)
    h.click({ action: 'connections-delete', kind: 'api', name: 'acme-hubspot' });
    await tick();
    h.click({ action: 'connections-delete-cancel' });
    h.click({ action: 'connections-delete', kind: 'api', name: 'acme-hubspot' });
    await tick();
    expect(h.getHtml()).toContain('Also remove the 3 items');

    // the STALE preview #1 now resolves with a different count — must be dropped.
    resolveFirst({ count: 999 });
    await tick();
    expect(h.getHtml()).toContain('Also remove the 3 items');
    expect(h.getHtml()).not.toContain('999');
  });

  it('opening the enroll dialog dismisses an open delete confirm', async () => {
    const h = mountPanel({ previewCount: 5 });
    await tick();
    h.click({ action: 'connections-delete', kind: 'api', name: 'acme-hubspot' });
    await tick();
    expect(h.getHtml()).toContain('Remove acme-hubspot?');

    h.click({ action: 'connections-open-add' }); // mutual exclusion
    await tick();
    expect(h.getHtml()).not.toContain('Remove acme-hubspot?');
    expect(h.getHtml()).not.toContain('connections-delete-confirm');
  });

  it('does not open a delete confirm while the enroll dialog is open', async () => {
    const h = mountPanel();
    await tick();
    h.click({ action: 'connections-open-add' }); // dialog open
    await tick();
    h.click({ action: 'connections-delete', kind: 'api', name: 'acme-hubspot' });
    await tick();
    expect(h.getHtml()).not.toContain('Remove acme-hubspot?'); // guard held
  });
});
