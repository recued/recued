import { afterEach, expect, it, vi } from 'vitest';
import { BLOCKED_SITES_KEY } from '../permissions/site-grants.js';
import { SITE_LIST_EDIT_MESSAGE_TYPE } from '../site-list-mutations.js';
import { flush } from './site-list-fixture.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('the production worker handles local site edits even when server boot fails', async () => {
  const saved: Record<string, unknown> = { [BLOCKED_SITES_KEY]: ['existing.example.com'] };
  let handler!: (message: unknown, sender: unknown, respond: (reply: unknown) => void) => boolean | undefined;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('chrome', {
    runtime: {
      getURL() { throw new Error('intentional boot failure'); },
      onMessage: { addListener(fn: typeof handler) { handler = fn; } },
    },
    storage: { local: {
      async get(keys: string[]) { return Object.fromEntries(keys.filter(key => key in saved).map(key => [key, structuredClone(saved[key])])); },
      async set(items: Record<string, unknown>) { Object.assign(saved, structuredClone(items)); },
    } },
  });
  await import('../boot/service-worker-entry.js');
  await flush();
  const ask = (message: unknown) => new Promise<unknown>(resolve => { handler(message, {}, resolve); });
  await expect(ask({ type: SITE_LIST_EDIT_MESSAGE_TYPE, edit: { list: 'blocked', op: 'add', site: 'new.example.com' } }))
    .resolves.toMatchObject({ ok: true, written: true });
  expect(saved[BLOCKED_SITES_KEY]).toEqual(['existing.example.com', 'new.example.com']);
  await expect(ask({ type: 'recued.bridge.inspect' })).resolves.toMatchObject({ ok: false, error: 'bridge_boot_failed' });
});
