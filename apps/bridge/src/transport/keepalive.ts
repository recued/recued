/** D-148 § A.3.3 — MV3 keepalive coordination.
 *
 *  Three-pronged approach to fight Chrome's 30s SW idle-kill:
 *
 *    1. **Offscreen document** holds the WebSocket. Offscreen
 *       documents aren't subject to SW idle-kill; they live as long
 *       as the parent extension is loaded.
 *
 *    2. **Server ping every 25 s** — the server-side ping cadence
 *       (chosen because Chrome's SW idle is 30 s) keeps the SW alive
 *       without the offscreen path. Inbound pings translate to a
 *       `chrome.runtime.sendMessage` from the offscreen doc to the
 *       SW; that message wakes the SW.
 *
 *    3. **`chrome.alarms` safety net** — `chrome.alarms.create` fires
 *       every 30 s and the handler does a no-op
 *       `chrome.runtime.getPlatformInfo()` call. Forces SW wake even
 *       when both offscreen + ping fail.
 *
 *  This module exposes a pure scheduler the SW wires to
 *  chrome.alarms; it carries the timing constants + the action a
 *  tick fires (check WS state; reconnect if disconnected; sweep
 *  expired idempotency entries).
 *
 *  Timing constants are in spec § A.3.3.
 */

import type { WsClient } from './ws-client.js';
import type { IdempotencyCache } from '../idempotency/cache.js';

export const KEEPALIVE_ALARM_NAME = 'recued.bridge.keepalive' as const;
/** D-148 § A.3.3 — `chrome.alarms.create('bridge_keepalive', { periodInMinutes: 0.5 })`. */
export const KEEPALIVE_PERIOD_MINUTES = 0.5 as const;
/** D-148 § A.3.3 — server pings every 25 s; bridge expects pings within 30 s. */
export const KEEPALIVE_PING_INTERVAL_MS = 25_000 as const;

export interface KeepaliveTickContext {
  ws: WsClient;
  idempotency: IdempotencyCache;
  now(): number;
}

export interface KeepaliveTickReport {
  ws_connected: boolean;
  reconnected: boolean;
  expired_swept: number;
}

/** Run one keepalive tick. The chrome.alarms handler invokes this
 *  every 30 s; the SW boot path also invokes it on startup so the
 *  first tick is immediate.
 *
 *  Pure-async; no chrome.* calls inside. Tests pass an in-memory ws
 *  client + cache. */
export const runKeepaliveTick = async (ctx: KeepaliveTickContext): Promise<KeepaliveTickReport> => {
  let reconnected = false;
  if (!ctx.ws.isConnected()) {
    // Trigger reconnect — the WS client's loop will attempt with
    // exponential backoff; we just nudge by calling start (idempotent).
    await ctx.ws.start();
    reconnected = true;
  }
  const swept = await ctx.idempotency.sweepExpired(ctx.now());
  return {
    ws_connected: ctx.ws.isConnected(),
    reconnected,
    expired_swept: swept,
  };
};

/** Adapter for the chrome.alarms API. Tests call `runKeepaliveTick`
 *  directly; production wires this adapter into the SW boot flow. */
export interface ChromeAlarmsApi {
  create(name: string, opts: { periodInMinutes: number }): void;
  clear(name: string): void;
  onAlarm: { addListener(handler: (alarm: { name: string }) => void): void };
}

export interface ChromeRuntimeInfoApi {
  getPlatformInfo(): Promise<unknown>;
}

export const installKeepaliveAlarm = (
  alarms: ChromeAlarmsApi,
  runtime: ChromeRuntimeInfoApi,
  tickRunner: () => Promise<KeepaliveTickReport>,
): void => {
  alarms.create(KEEPALIVE_ALARM_NAME, { periodInMinutes: KEEPALIVE_PERIOD_MINUTES });
  alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== KEEPALIVE_ALARM_NAME) return;
    // Force SW wake via a no-op call before running the tick logic.
    void runtime.getPlatformInfo().catch(() => undefined);
    // Storage maintenance can fail (for example, quota or a blocked database).
    // The next alarm may retry; do not turn it into an unhandled SW rejection.
    void tickRunner().catch(() => undefined);
  });
};

export const removeKeepaliveAlarm = (alarms: ChromeAlarmsApi): void => {
  alarms.clear(KEEPALIVE_ALARM_NAME);
};
