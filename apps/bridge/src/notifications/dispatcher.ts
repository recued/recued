/** D-148 § A.3.5 — OS notification dispatch.
 *
 *  Server pushes notifications via WS → bridge dispatches via
 *  `chrome.notifications.create()`. Two-state contract:
 *
 *   - **Content-minimization default.** The body field renders as
 *     plain text without inline detail by default — "Recipe X has 2
 *     alerts" rather than the alert content. Per-recipe expanded
 *     bodies are opt-in. Lock-screen leak protection.
 *
 *   - **No content storage.** Notifications dispatch from the
 *     server's broadcast bus; the bridge displays then forgets. Audit
 *     of "what notifications fired" lives at the server (D-120 memory
 *     entries with `kind = 'notification.dispatched'`).
 *
 *  The chrome.notifications API is injected so the module is
 *  testable; the click router is also pure (returns a typed action;
 *  the SW maps actions to chrome runtime calls).
 */

import type {
  BridgeClickAction,
  ServerToBridgeNotification,
} from '@recued/contracts';
import { askIdOfApprovalNotice } from './approval-notices.js';

export interface ChromeNotificationsApi {
  getPermissionLevel?(): Promise<'granted' | 'denied'>;
  create(notification_id: string, options: ChromeNotificationOptions): Promise<string>;
  clear(notification_id: string): Promise<boolean>;
  onClicked: { addListener(handler: (notification_id: string) => void): void };
  onClosed: {
    addListener(handler: (notification_id: string, by_user: boolean) => void): void;
  };
}

/** Subset of chrome.notifications.NotificationOptions that the bridge
 *  uses. Strictly-typed so the dispatcher cannot drift into inline
 *  per-button actions or buttons that would surface CRM detail on the
 *  notification surface. */
export interface ChromeNotificationOptions {
  type: 'basic';
  title: string;
  message: string;
  iconUrl: string;
  isClickable: true;
  silent?: boolean;
}

export interface NotificationDispatchOptions {
  /** When true, the body renders in full per the server's notification
   *  payload. When false (default), body is title-only ("Recipe X"
   *  without inline alert detail). Per-recipe opt-in flips this. */
  expanded_body?: boolean;
  /** Default icon URL the bridge ships with — overridden if the
   *  server-supplied notification carries `icon_url`. */
  default_icon_url: string;
}

/** Translate a server notification into the chrome.notifications
 *  payload + a routing slot for the click action. The pure function
 *  lets tests assert content-minimization is honored. */
export const buildNotificationOptions = (
  notification: ServerToBridgeNotification,
  options: NotificationDispatchOptions,
): { chrome_options: ChromeNotificationOptions; click_action: BridgeClickAction | null } => {
  const message = options.expanded_body
    ? notification.body
    : titleOnlyMessage(notification.title);
  return {
    chrome_options: {
      type: 'basic',
      title: notification.title,
      message,
      iconUrl: notification.icon_url ?? options.default_icon_url,
      isClickable: true,
    },
    click_action: notification.click_action ?? null,
  };
};

/** Default body when expanded_body is false. Title-only with a soft
 *  affordance so users know they can tap to see detail. */
const titleOnlyMessage = (title: string): string => `${title} — open Recued for detail`;

/** Routing decision for a notification click. The SW maps the
 *  `kind` field to a chrome runtime call:
 *
 *   - `open_url` → `chrome.tabs.create({ url })`
 *   - `open_webclient` → `chrome.tabs.create({ url: server_url + path })`
 *   - `rpc_callback` → enqueue rpc on the bridge ws
 *
 *  Pure helper so tests can verify the routing decision without
 *  invoking chrome APIs. */
export interface ResolvedClickRoute {
  kind: 'open_url' | 'open_webclient' | 'rpc_callback' | 'noop';
  url?: string;
  rpc?: { name: string; args: Record<string, unknown> };
}

export const resolveClickRoute = (
  click_action: BridgeClickAction | null,
  ctx: { server_url: string | null },
): ResolvedClickRoute => {
  if (!click_action) return { kind: 'noop' };
  if (click_action.kind === 'open_url') {
    return { kind: 'open_url', url: click_action.url };
  }
  if (click_action.kind === 'open_webclient') {
    if (!ctx.server_url) return { kind: 'noop' };
    // Server URL is the WS endpoint (wss://host:port/ws). The
    // webclient lives on the same origin via HTTPS — drop the WS
    // path + scheme + use the supplied click path.
    const origin = wsOriginToHttpsOrigin(ctx.server_url);
    if (!origin) return { kind: 'noop' };
    return {
      kind: 'open_webclient',
      url: origin + ensureLeadingSlash(click_action.path),
    };
  }
  return {
    kind: 'rpc_callback',
    rpc: { name: click_action.rpc, args: click_action.args },
  };
};

const ensureLeadingSlash = (p: string): string => (p.startsWith('/') ? p : `/${p}`);

/** The click of a notification with no route kept for it — one raised by an earlier run of the
 *  service worker, which Chrome stops when idle, or one this dispatcher did not raise — read
 *  from its id: a reminder opens its occurrences, an approval its card
 *  (`approval-notices.ts`). */
const clickActionFromId = (notification_id: string): BridgeClickAction | null => {
  if (/^recued-reminder-[a-f0-9]{64}$/u.test(notification_id)) {
    return { kind: 'open_webclient', path: '/#yours/occurrences' };
  }
  const ask_id = askIdOfApprovalNotice(notification_id);
  return ask_id !== undefined ? { kind: 'open_webclient', path: `/#approvals/${encodeURIComponent(ask_id)}` } : null;
};

const wsOriginToHttpsOrigin = (server_url: string): string | null => {
  try {
    const parsed = new URL(server_url);
    const scheme =
      parsed.protocol === 'wss:' || parsed.protocol === 'https:' ? 'https' : 'http';
    const host = parsed.host; // includes port when non-default
    return `${scheme}://${host}`;
  } catch {
    return null;
  }
};

/** Production dispatcher — wires chrome.notifications.create + the
 *  click handler. */
export const createNotificationDispatcher = (
  chrome_notifications: ChromeNotificationsApi,
  options: NotificationDispatchOptions,
  click_handler: (route: ResolvedClickRoute, notification_id: string) => void,
  ctx: { server_url: string | null },
): {
  dispatch(notification: ServerToBridgeNotification): Promise<void>;
} => {
  const click_routes = new Map<string, BridgeClickAction | null>();
  chrome_notifications.onClicked.addListener((notification_id) => {
    const action = click_routes.get(notification_id) ?? clickActionFromId(notification_id);
    const route = resolveClickRoute(action, ctx);
    click_handler(route, notification_id);
  });
  chrome_notifications.onClosed.addListener((notification_id) => {
    click_routes.delete(notification_id);
  });
  return {
    async dispatch(notification) {
      const { chrome_options, click_action } = buildNotificationOptions(notification, options);
      click_routes.set(notification.notification_id, click_action);
      try { await chrome_notifications.create(notification.notification_id, chrome_options); }
      catch (error) { click_routes.delete(notification.notification_id); throw error; }
    },
  };
};
