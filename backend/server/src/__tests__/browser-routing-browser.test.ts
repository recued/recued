/** Two real Chrome profiles, the shipped Bridge queue/grant/executor, and the
 * server router. Cookie identity proves which account receives the write. */
import { describe, expect, it } from 'vitest';
import { BRIDGE_ACTIONS, BRIDGE_COMMAND_DEFAULT_TIMEOUT_MS, type BridgeCapabilityProfile, type BridgeResult } from '@recued/contracts';
import { createBridgeRegistry } from '../bridges/registry.js';
import { createBridgeDispatcher, createBridgeResultListener } from '../bridges/dispatcher.js';
import { createBridgeDomAdapter } from '../bridges/dom-adapter.js';
import { createPageReadStore } from '../bridges/page-outline.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import { createReviewedBrowserFixture } from './d-261-browser-fixture.js';

describe('Browser routing in real Chrome profiles', () => {
  it('discovers both profiles and keeps a batched form action in the chosen cookie session', async () => {
    const writes: Array<{ profile: string; value: string }> = [];
    const url = 'https://browser-routing.test/';
    const browsers = new Map<string, Awaited<ReturnType<typeof createReviewedBrowserFixture>>>();
    try {
      for (const id of ['work', 'personal']) {
        const chrome = await createReviewedBrowserFixture('about:blank', { siteGrants: 'chrome', hostPermissions: [url + '*'] }); browsers.set(id, chrome);
        await chrome.browser.route(url + '**', async route => {
          const request = route.request(), cookie = await request.headerValue('cookie');
          const profile = /profile=(work|personal)/.exec(cookie ?? '')?.[1] ?? 'unknown';
          if (request.method() === 'POST') {
            writes.push({ profile, value: request.postData() ?? '' });
            await route.fulfill({ status: 200, body: 'Saved' }); return;
          }
          await route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>${profile} account</title><h1>${profile} orders</h1>
            <label for="note">Note</label><input id="note"><button id="save">Save</button><p id="result"></p>
            <script>document.querySelector('#save').onclick=async()=>{await fetch('/save',{method:'POST',body:document.querySelector('#note').value});document.querySelector('#result').textContent='Saved';};</script>` });
        });
        await chrome.browser.addCookies([{ name: 'profile', value: id, domain: 'browser-routing.test', path: '/' }]);
        await chrome.reset(url);
      }
      const registry = createBridgeRegistry(), listener = createBridgeResultListener();
      const capabilities: BridgeCapabilityProfile = { software_version: '0.0.8', chrome_version: '140',
        permissions_granted: ['tabs', 'scripting'], granted_origins: [url + '*'],
        offscreen_supported: true, alarms_supported: true, supported_actions: [...BRIDGE_ACTIONS] };
      for (const id of browsers.keys()) registry.attach({ client_token_id: id, client_label: `${id} Chrome`,
        session_id: id, online_since: 1, last_seen_at: 1, capabilities });
      let firstPersonalDiscovery = true;
      const receipts: Array<{ bridge: string; action: string; result: BridgeResult }> = [];
      const dispatcher = createBridgeDispatcher({ registry, listener, transport: {
        cancel: async () => ({ ok: true }), send: async (id, envelope) => {
          if (envelope.kind !== 'command') throw new Error('Expected browser command');
          if (typeof envelope.command.args.page === 'string') expect(envelope.command.args.page).toMatch(/^\d+:[\w-]+$/);
          // Discovery is allowed to answer partial after its five-second
          // budget. Exercise that path without repeating any browser effect.
          let result: BridgeResult;
          if (id === 'personal' && envelope.command.action === 'list_tabs' && firstPersonalDiscovery) {
            firstPersonalDiscovery = false;
            result = { command_id: envelope.command.command_id, status: 'timeout', duration_ms: envelope.command.timeout_ms,
              bridge_version: '0.0.8', idempotency_key_seen: false,
              error: { code: 'unknown', message: 'Controlled first-discovery timeout' } };
          } else ({ result } = await browsers.get(id)!.ordinaryCommand(envelope.command));
          receipts.push({ bridge: id, action: envelope.command.action, result });
          listener.resolveResult(result); return { ok: true };
        },
      } });
      const adapter = createBridgeDomAdapter({ getDispatcher: () => dispatcher, pageReads: createPageReadStore(),
        manifests: { get: slug => KERNEL_MANIFESTS.find(manifest => manifest.slug === slug) ?? null } });
      let step = 0;
      const run = (slug: string, input: Record<string, unknown>) => adapter({ slug, risk_tier: 'read',
        output: KERNEL_MANIFESTS.find(manifest => manifest.slug === slug)!.output, input: { target: '*://*/*', ...input },
        stepMeta: { run_id: 'two-browsers', recipe_id: 'browser-test', step_id: `step-${++step}` } }) as Promise<Record<string, unknown>>;
      const partial = await run('dom-tabs', {});
      expect(partial.complete).toBe(false);
      expect((partial.bridges as Array<Record<string, unknown>>).find(row => row.bridge_id === 'personal'))
        .toMatchObject({ status: 'partial' });
      expect(writes).toEqual([]);
      for (const chrome of browsers.values()) expect(await chrome.page.locator('#note').inputValue()).toBe('');
      let listed = partial;
      try {
        // Only discovery reads repeat. No account is selected for a write
        // until both profiles have positively observed document handles.
        await expect.poll(async () => {
          listed = await run('dom-tabs', {});
          return listed.complete === true && (listed.tabs as Array<{ bridge_id: string; url: string }> | undefined)
            ?.filter(tab => tab.url === url).map(tab => tab.bridge_id).sort().join(',') === 'personal,work';
        }, { timeout: BRIDGE_COMMAND_DEFAULT_TIMEOUT_MS, interval: 100 }).toBe(true);
      } catch (error) {
        throw new Error(`Browser routing inventory did not become complete: ${JSON.stringify({ listed, receipts: receipts.slice(-16) })}`,
          { cause: error });
      }
      expect(listed.complete).toBe(true);
      const tabs = listed.tabs as Array<{ bridge_id: string; page: string; title: string }>;
      expect(new Set(tabs.map(tab => tab.bridge_id))).toEqual(new Set(['work', 'personal']));
      const work = tabs.find(tab => tab.bridge_id === 'work')!;
      expect((await run('dom-inspect', { page: work.page, form: 'outline' })).outline).toContain('work orders');
      await run('dom-act', { page: work.page, steps: [
        { do: 'type', text: 'Note', value: 'work only' }, { do: 'click', text: 'Save' }, { do: 'read' }] });
      expect(writes).toEqual([{ profile: 'work', value: 'work only' }]);
      expect(await browsers.get('personal')!.page.locator('#note').inputValue()).toBe('');
      registry.detach('work');
      await expect(run('dom-click', { page: work.page, selector: '#save' })).rejects.toMatchObject({ code: 'ROLE_RESTRICTION' });
      expect(writes).toHaveLength(1);
    } finally {
      await Promise.all([...browsers.values()].map(chrome => chrome.close()));
    }
  }, 240_000);
});
