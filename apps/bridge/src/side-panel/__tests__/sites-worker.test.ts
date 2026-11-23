import { afterEach, expect, it, vi } from 'vitest';
import type { MountSidePanelOptions } from '../mount.js';
import { SITE_LIST_EDIT_MESSAGE_TYPE } from '../../site-list-mutations.js';
import { BLOCKED_SITES_KEY } from '../../permissions/site-grants.js';
import { flush, siteWorker } from '../../__tests__/site-list-fixture.js';

const { mount } = vi.hoisted(() => ({ mount: vi.fn() }));
vi.mock('../mount.js', () => ({ mountSidePanel: mount }));
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('the production panel sends site edits to the worker and never writes the list directly', async () => {
  vi.useFakeTimers();
  const worker = siteWorker({ [BLOCKED_SITES_KEY]: ['existing.example.com'] });
  const directWrite = vi.fn(async () => { throw new Error('panel writes are forbidden'); });
  const sendMessage = vi.fn(async (message: unknown) => {
    if ((message as { type?: unknown })?.type === SITE_LIST_EDIT_MESSAGE_TYPE) return worker.send(message);
    return { ok: false, error: 'unavailable-in-fixture' };
  });
  vi.stubGlobal('chrome', {
    runtime: { sendMessage, getManifest: () => ({ version: 'test' }), onMessage: { addListener() {} } },
    storage: { local: { get: (keys: string[]) => worker.storage.get(keys), set: directWrite } },
    permissions: { contains: async () => true, request: async () => true, remove: async () => true },
  });
  await import('../side-panel-entry.js');
  await flush();
  const options = mount.mock.calls[0]?.[0] as MountSidePanelOptions;
  expect(options?.sites?.onAddBlocked).toBeTypeOf('function');
  await options.sites!.onAddBlocked!('new.example.com');
  expect(worker.saved[BLOCKED_SITES_KEY]).toEqual(['existing.example.com', 'new.example.com']);
  expect(worker.sent).toEqual([{ type: SITE_LIST_EDIT_MESSAGE_TYPE, edit: { list: 'blocked', op: 'add', site: 'new.example.com' } }]);
  expect(directWrite).not.toHaveBeenCalled();
});
