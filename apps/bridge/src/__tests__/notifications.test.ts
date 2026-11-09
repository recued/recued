/** D-148 P3 — notification dispatcher tests.
 *
 *  Covers spec § A.3.5: content-minimization default + click routing
 *  per BridgeClickAction kind. */

import { describe, it, expect } from 'vitest';
import {
  buildNotificationOptions,
  createNotificationDispatcher,
  resolveClickRoute,
  type ChromeNotificationsApi,
} from '../notifications/dispatcher.js';
import type { ServerToBridgeNotification } from '@recued/contracts';

const default_icon = 'recued://default-icon.png';

describe('D-148 P3 — content-minimization default', () => {
  it('expanded_body false → message is title-only', () => {
    const notification: ServerToBridgeNotification = {
      notification_id: 'n-1',
      title: 'Recipe X has 2 alerts',
      body: 'Alert 1: Out-of-band engagement on deal #47291...',
    };
    const out = buildNotificationOptions(notification, { default_icon_url: default_icon });
    expect(out.chrome_options.message).toBe('Recipe X has 2 alerts — open Recued for detail');
    expect(out.chrome_options.message).not.toContain('#47291');
  });

  it('expanded_body true → full body renders', () => {
    const notification: ServerToBridgeNotification = {
      notification_id: 'n-1',
      title: 'Recipe X',
      body: 'Full alert text',
    };
    const out = buildNotificationOptions(notification, {
      default_icon_url: default_icon,
      expanded_body: true,
    });
    expect(out.chrome_options.message).toBe('Full alert text');
  });

  it('icon_url overrides default', () => {
    const notification: ServerToBridgeNotification = {
      notification_id: 'n-1',
      title: 'X',
      body: 'Y',
      icon_url: 'recued://override-icon.png',
    };
    const out = buildNotificationOptions(notification, { default_icon_url: default_icon });
    expect(out.chrome_options.iconUrl).toBe('recued://override-icon.png');
  });

  it('falls back to default icon when none supplied', () => {
    const notification: ServerToBridgeNotification = {
      notification_id: 'n-1',
      title: 'X',
      body: 'Y',
    };
    const out = buildNotificationOptions(notification, { default_icon_url: default_icon });
    expect(out.chrome_options.iconUrl).toBe(default_icon);
  });
});

describe('D-148 P3 — click route resolution', () => {
  it('open_url → returns target', () => {
    const route = resolveClickRoute(
      { kind: 'open_url', url: 'https://example.com' },
      { server_url: null },
    );
    expect(route).toEqual({ kind: 'open_url', url: 'https://example.com' });
  });

  it('open_webclient → joins server_url + path', () => {
    const route = resolveClickRoute(
      { kind: 'open_webclient', path: '/inbox' },
      { server_url: 'wss://alice.recued.cloud:8443/ws' },
    );
    expect(route.kind).toBe('open_webclient');
    expect(route.url).toBe('https://alice.recued.cloud:8443/inbox');
  });

  it('open_webclient → falls back to noop when server_url missing', () => {
    const route = resolveClickRoute(
      { kind: 'open_webclient', path: '/inbox' },
      { server_url: null },
    );
    expect(route.kind).toBe('noop');
  });

  it('rpc_callback → wraps payload', () => {
    const route = resolveClickRoute(
      { kind: 'rpc_callback', rpc: 'approval.respond', args: { id: 'a-1', decision: 'approve' } },
      { server_url: null },
    );
    expect(route.kind).toBe('rpc_callback');
    expect(route.rpc).toEqual({
      name: 'approval.respond',
      args: { id: 'a-1', decision: 'approve' },
    });
  });

  it('null click_action → noop', () => {
    const route = resolveClickRoute(null, { server_url: null });
    expect(route.kind).toBe('noop');
  });
});

describe('D-148 P3 — createNotificationDispatcher integration', () => {
  it('dispatch + click round-trip routes to expected handler', async () => {
    let click_route_kind = '';
    const created: Array<{ id: string; opts: unknown }> = [];
    const click_slot: { current: ((id: string) => void) | null } = { current: null };
    const close_slot: { current: ((id: string, by_user: boolean) => void) | null } = { current: null };

    const chrome: ChromeNotificationsApi = {
      async create(notification_id, opts) {
        created.push({ id: notification_id, opts });
        return notification_id;
      },
      async clear() {
        return true;
      },
      onClicked: {
        addListener(handler) {
          click_slot.current = handler;
        },
      },
      onClosed: {
        addListener(handler) {
          close_slot.current = handler;
        },
      },
    };

    const dispatcher = createNotificationDispatcher(
      chrome,
      { default_icon_url: default_icon },
      (route) => {
        click_route_kind = route.kind;
      },
      { server_url: 'wss://test/' },
    );
    await dispatcher.dispatch({
      notification_id: 'n-1',
      title: 'Recipe X',
      body: 'Detail',
      click_action: { kind: 'open_webclient', path: '/inbox' },
    });
    expect(created).toHaveLength(1);
    click_slot.current?.('n-1');
    expect(click_route_kind).toBe('open_webclient');

    // Closing removes the click route.
    close_slot.current?.('n-1', true);
    click_slot.current?.('n-1');
    expect(click_route_kind).toBe('noop'); // route was wiped by close
  });

  it('an approval notice opens its card in the web app, though no route was kept for it', () => {
    // Raised by `approval-notices.ts`, or by a service worker Chrome has since stopped.
    const routes: Array<{ kind: string; url?: string }> = [];
    const click_slot: { current: ((id: string) => void) | null } = { current: null };
    const chrome: ChromeNotificationsApi = {
      async create(id) { return id; },
      async clear() { return true; },
      onClicked: { addListener(handler) { click_slot.current = handler; } },
      onClosed: { addListener() {} },
    };
    createNotificationDispatcher(chrome, { default_icon_url: default_icon }, (route) => { routes.push(route); },
      { server_url: 'wss://alice.recued.cloud:8443/ws' });
    click_slot.current?.('recued-approval-ask-6f1c2c1e-9a5b-4b8e-8f0e-1d2c3b4a5f60');
    click_slot.current?.('recued-approval-not-an-ask');
    expect(routes).toEqual([
      { kind: 'open_webclient', url: 'https://alice.recued.cloud:8443/#approvals/ask-6f1c2c1e-9a5b-4b8e-8f0e-1d2c3b4a5f60' },
      { kind: 'noop' },
    ]);
  });
});
