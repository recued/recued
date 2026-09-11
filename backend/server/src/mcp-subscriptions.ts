/** Case 2 — Recued as the PUSHING end of MCP 2026-07-28.
 *
 *  The revision removed the GET stream, protocol sessions and server-initiated
 *  requests, leaving `subscriptions/listen` as the only server→client channel:
 *  a POST whose response never closes, opened with a filter, answered first
 *  with an acknowledgement of the subset the server will honour.
 *
 *  ⛔ RECUED CAN HONOUR EXACTLY ONE MEMBER OF THAT VOCABULARY, AND THAT IS A
 *  FACT ABOUT THE HOST, NOT A SIMPLIFICATION. The closed filter is
 *  `toolsListChanged` / `promptsListChanged` / `resourcesListChanged` /
 *  `resourceSubscriptions[]`, and `mcp-server.ts` serves `initialize`,
 *  `server/discover`, `notifications/initialized`, `tools/list` and
 *  `tools/call` — no resources, no prompts. Advertising a resource feed we
 *  cannot populate would be the exact failure the acknowledgement exists to
 *  prevent, so the ack OMITS them. A client reading it learns the truth in one
 *  frame rather than by waiting for notifications that never come.
 *
 *  ⛔ A FILTER WE HONOUR NOTHING OF STILL GETS A STREAM AND AN ACK. It is
 *  tempting to refuse — but a refusal is indistinguishable from "this server
 *  does not implement the method", and those are different facts. The empty
 *  acknowledgement is the information; the client can close immediately.
 *
 *  ── Why the fingerprint is taken THROUGH the door's own dispatch ──
 *  🔑 CALL THE RULE, DO NOT RE-IMPLEMENT IT. A token's catalog is not a static
 *  list: it is `tools/list` evaluated against that bearer — bound-contract
 *  liveness (revoked / expired / exhausted empties it), the door's per-tool
 *  grants checklist, seller admission, installed manifests, and the extension's
 *  reported manifests. Re-deriving any of that here would be a second authority
 *  path that can disagree with the first, and the disagreement would be
 *  invisible: the client would be told its catalog is current while the door
 *  answers something else. So the watcher issues a real `tools/list` through
 *  the SAME `dispatch` the door calls and hashes the answer. Authority is
 *  therefore re-derived on every check, not captured when the stream opened —
 *  the same rule the durable outbox states for delivery.
 *
 *  ── Why a timer and not the broadcast bus ────────────────────────
 *  ⚠ CONSIDERED AND DECLINED. The D-121 bus carries kinds that plainly bear on
 *  a catalog (`pack_installed`, `recipe_runnability_changed`,
 *  `exposure_changed`, `contract.contract_definition_changed`, …) and
 *  subscribing to them would cut latency. It would also be a hand-maintained
 *  list of "things that can change a catalog", with no completion criterion and
 *  a silent failure mode: the kind nobody adds next year simply never notifies.
 *  A periodic fingerprint has one mechanism, no list, and cannot miss a cause —
 *  it observes the EFFECT. The cost is bounded latency, not lost signal, and
 *  revocation does not depend on it: the door probes contract liveness live on
 *  every dispatch, so a stale catalog can only cause a call that is refused.
 *
 *  ⚠ WORK IS PER TOKEN, NOT PER STREAM. Four streams on one bearer see one
 *  catalog, so they share one check and one in-flight promise. Otherwise the
 *  per-token stream cap would multiply the cost of the very thing it bounds. */

import { createHash } from 'node:crypto';

import {
  MCP_CLIENT_CAPABILITIES_META_KEY,
  MCP_CLIENT_INFO_META_KEY,
  MCP_MODERN_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION_META_KEY,
  MCP_SUBSCRIPTIONS_ACKNOWLEDGED_METHOD,
  MCP_SUBSCRIPTION_ID_META_KEY,
  MCP_TOOLS_LIST_CHANGED_METHOD,
  type McpAcknowledgedNotifications,
} from '@recued/ingredients/mcp-protocol.js';

/** How often a token's catalog is re-fingerprinted while any stream is open.
 *
 *  The one knob that trades latency for work. Ten seconds means an owner who
 *  installs a pack sees connected clients told within ten seconds, and a server
 *  with the maximum 64 streams open across (worst case) 64 distinct tokens does
 *  at most ~6 catalog builds a second — and far fewer in reality, since streams
 *  sharing a bearer share a check. */
export const MCP_CATALOG_FINGERPRINT_INTERVAL_MS = 10_000;

/** Floor between two catalog builds for the SAME token, whatever asks. */
export const MCP_CATALOG_FINGERPRINT_MIN_GAP_MS = 2_000;

/** How long one catalog read may take before it is abandoned.
 *
 *  ⛔ WITHOUT THIS, ONE HUNG DISPATCH SILENCES A BEARER PERMANENTLY. The
 *  in-flight guard makes every later check join the pending promise, so a
 *  `tools/list` that never settles — an unresponsive extension inside
 *  `buildRouteMap`, say — means that bearer's clients are never told their
 *  catalog moved again, with no error and no log. Abandoning the read leaves
 *  the baseline untouched (an unreadable answer is not an empty catalog), so
 *  the next tick simply tries again. */
export const MCP_CATALOG_FINGERPRINT_TIMEOUT_MS = 15_000;

export type McpNotificationFrame = {
  jsonrpc: '2.0';
  method: string;
  params: Record<string, unknown>;
};

export interface McpSubscriptionsDeps {
  /** The door's own dispatcher — the same closure `createMcpPortHandler`
   *  calls. Passing anything else would fork the authority path. */
  dispatch: (envelope: unknown, token?: string) => Promise<unknown | null>;
  now?: () => number;
  /** Deferred-work seam; returns a cancel. Defaults to an unref'd interval so
   *  a subscription can never hold the process open. */
  scheduleInterval?: (fn: () => void, ms: number) => () => void;
  /** Abandon one catalog read after this long. Tests shorten it. */
  fingerprintTimeoutMs?: number;
  log?: (level: 'warn', msg: string) => void;
}

export interface McpListenSession {
  /** What this server actually agreed to send. */
  readonly acknowledged: McpAcknowledgedNotifications;
  /** Stop watching. Idempotent; called when the HTTP response closes. */
  close(): void;
}

export interface McpSubscriptions {
  open(input: {
    token: string;
    /** The client's `params.notifications`, unvalidated. */
    filter: unknown;
    /** The client's request id — echoed as the subscription id so a client
     *  can correlate frames back to the request that opened the feed. */
    subscription_id: string | number | null;
    /** Write one frame to this client's stream. */
    send: (frame: McpNotificationFrame) => void;
  }): Promise<McpListenSession>;
  /** Open stream count (caps + diagnostics). */
  activeStreamCount(): number;
}

/** Read the closed filter vocabulary out of an untrusted params object.
 *  Anything unrecognised is dropped rather than rejected: a newer client
 *  asking for something this revision does not define must still get a
 *  stream and an honest acknowledgement of what it will receive. */
const parseFilter = (value: unknown): McpAcknowledgedNotifications => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const row = value as Record<string, unknown>;
  const uris = Array.isArray(row.resourceSubscriptions)
    ? row.resourceSubscriptions.filter((u): u is string => typeof u === 'string')
    : undefined;
  return {
    ...(row.toolsListChanged === true ? { toolsListChanged: true } : {}),
    ...(row.promptsListChanged === true ? { promptsListChanged: true } : {}),
    ...(row.resourcesListChanged === true ? { resourcesListChanged: true } : {}),
    ...(uris !== undefined && uris.length > 0 ? { resourceSubscriptions: uris } : {}),
  };
};

/** The subset this host can honour.
 *
 *  ⛔ The ONLY place the answer is decided, and it is deliberately not a
 *  config knob: it is derived from what `mcp-server.ts` serves. When Recued
 *  gains a resources surface, this function grows a member and the ack starts
 *  telling the truth about it — there is nowhere else to remember. */
export const acknowledgeableFilter = (
  requested: McpAcknowledgedNotifications,
): McpAcknowledgedNotifications => (
  // `toolsListChanged` alone: the host serves tools/list and tools/call, and
  // neither a prompts nor a resources surface exists to change.
  requested.toolsListChanged === true ? { toolsListChanged: true } : {}
);

const hashTools = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value ?? null), 'utf8').digest('hex');

/** Extract the tool list from a `tools/list` response, or `null` when the
 *  answer was not one.
 *
 *  ⚠ `null` IS NOT AN EMPTY CATALOG. A dispatch that errored (token revoked
 *  mid-check, transport fault) must not be hashed as "the catalog is now
 *  empty" — that would push a spurious change and, worse, would settle the
 *  baseline to the wrong value so the REAL catalog then looks like a change
 *  when the error clears. An unreadable answer leaves the baseline alone. */
const toolsOf = (response: unknown): unknown | null => {
  if (response === null || typeof response !== 'object' || Array.isArray(response)) return null;
  const row = response as { result?: unknown; error?: unknown };
  if (row.error !== undefined) return null;
  if (row.result === null || typeof row.result !== 'object' || Array.isArray(row.result)) {
    return null;
  }
  const tools = (row.result as { tools?: unknown }).tools;
  return Array.isArray(tools) ? tools : null;
};

/** ⛔ NOT TRUNCATED, UNLIKE THE PORT'S RATE-LIMIT KEY. There a collision merely
 *  merges two callers' budgets; here the key selects WHICH BEARER a catalog is
 *  computed as, so a collision would fingerprint one principal's catalog and
 *  hand the result to another's stream. The full digest costs nothing. */
const tokenKeyOf = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

interface TokenWatch {
  /** Every open stream on this bearer. */
  streams: Set<{ send: (frame: McpNotificationFrame) => void; subscription_id: string | number | null }>;
  fingerprint: string | null;
  /** ⚠ A BASELINE THAT NEVER LANDED IS NOT THE SAME AS A FRESH STREAM. If the
   *  first read fails, the client has meanwhile listed the catalog itself and
   *  holds SOME version; suppressing the next successful read as "the first
   *  one" would hide every change that happened in between, indefinitely. So a
   *  failed attempt makes the next success NOTIFY. A spurious notification
   *  costs the client one re-list; a suppressed one costs it correctness. */
  baselineFailed: boolean;
  lastCheckedAt: number;
  inFlight: Promise<void> | undefined;
  /** ⚠ THE RAW BEARER, HELD IN MEMORY FOR THE LIFE OF THE STREAM. This is the
   *  price of re-deriving authority instead of capturing it: the fingerprint
   *  is a real `tools/list` dispatched AS this principal, and the dispatcher
   *  takes a bearer. Caching a resolved principal instead would drop the
   *  bearer but fork the authority path — the exact thing this module refuses
   *  to do. Dropped the moment the last stream on it closes. */
  token: string;
}

export const createMcpSubscriptions = (
  deps: McpSubscriptionsDeps,
): McpSubscriptions => {
  const now = deps.now ?? (() => Date.now());
  const scheduleInterval = deps.scheduleInterval ?? ((fn, ms) => {
    const timer = setInterval(fn, ms) as { unref?: () => void };
    timer.unref?.();
    return () => { clearInterval(timer as unknown as NodeJS.Timeout); };
  });

  const watches = new Map<string, TokenWatch>();
  let cancelTimer: (() => void) | undefined;

  /** One real `tools/list`, through the door's own authority path — bounded,
   *  so a dispatch that never settles cannot wedge this bearer. A timeout
   *  resolves to `null`, which the caller treats like any other unreadable
   *  answer: baseline untouched, try again next tick. */
  const readCatalog = async (token: string): Promise<unknown | null> => {
    const budget = deps.fingerprintTimeoutMs ?? MCP_CATALOG_FINGERPRINT_TIMEOUT_MS;
    let abandon: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<null>((resolve) => {
      abandon = setTimeout(() => { resolve(null); }, budget);
      (abandon as unknown as { unref?: () => void }).unref?.();
    });
    try {
      return await Promise.race([readCatalogUnbounded(token), expired]);
    } finally {
      if (abandon !== undefined) clearTimeout(abandon);
    }
  };

  const readCatalogUnbounded = async (token: string): Promise<unknown | null> => {
    const response = await deps.dispatch({
      jsonrpc: '2.0',
      id: 'recued-catalog-fingerprint',
      method: 'tools/list',
      params: {
        _meta: {
          [MCP_PROTOCOL_VERSION_META_KEY]: MCP_MODERN_PROTOCOL_VERSION,
          [MCP_CLIENT_INFO_META_KEY]: { name: 'recued-subscriptions', version: '1' },
          [MCP_CLIENT_CAPABILITIES_META_KEY]: {},
        },
      },
    }, token);
    return toolsOf(response);
  };

  const check = async (key: string): Promise<void> => {
    const watch = watches.get(key);
    if (watch === undefined || watch.streams.size === 0) return;
    if (watch.inFlight !== undefined) return watch.inFlight;
    const at = now();
    // One rule: a token with no baseline yet MUST build one (a stream cannot
    // detect change against nothing), and every other check respects the
    // floor. The earlier form passed a `force` flag from every caller, which
    // made the floor unreachable — a knob that reads as a control while being
    // decoration. Now a second stream opening on a bearer that already has a
    // baseline costs nothing at all.
    // The floor is UNIVERSAL. It used to exempt a watch with no baseline —
    // which sounds like "the first check must always run" but actually means
    // "a bearer whose reads keep FAILING has no floor at all", since the
    // baseline stays null. `lastCheckedAt` starts at 0, so the genuine first
    // check clears the floor anyway and nothing is exempted to get it.
    if (at - watch.lastCheckedAt < MCP_CATALOG_FINGERPRINT_MIN_GAP_MS) return;
    watch.lastCheckedAt = at;
    watch.inFlight = (async () => {
      let tools: unknown | null;
      try {
        tools = await readCatalog(watch.token);
      } catch (error) {
        watch.baselineFailed = watch.baselineFailed || watch.fingerprint === null;
        deps.log?.(
          'warn',
          `mcp subscriptions: catalog fingerprint failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return;
      }
      // See `toolsOf` — an unreadable answer leaves the baseline untouched.
      if (tools === null) {
        watch.baselineFailed = watch.baselineFailed || watch.fingerprint === null;
        return;
      }
      const fingerprint = hashTools(tools);
      const previous = watch.fingerprint;
      const recovering = previous === null && watch.baselineFailed;
      watch.fingerprint = fingerprint;
      watch.baselineFailed = false;
      if (previous === fingerprint) return;
      if (previous === null && !recovering) return;
      for (const stream of watch.streams) {
        try {
          stream.send({
            jsonrpc: '2.0',
            method: MCP_TOOLS_LIST_CHANGED_METHOD,
            params: {
              _meta: {
                [MCP_PROTOCOL_VERSION_META_KEY]: MCP_MODERN_PROTOCOL_VERSION,
                ...(stream.subscription_id !== null
                  ? { [MCP_SUBSCRIPTION_ID_META_KEY]: stream.subscription_id }
                  : {}),
              },
            },
          });
        } catch {
          // One broken socket must not deny the notification to the others;
          // the response's own `close` handler removes it.
        }
      }
    })().finally(() => {
      // ⛔ CLEAR ONLY *THIS* WATCH'S GUARD. The watch is deleted when its last
      // stream closes and rebuilt when the bearer reconnects, so a pending
      // check outliving its own watch would otherwise clear the guard of the
      // REPLACEMENT — letting two checks run concurrently on one bearer and an
      // out-of-order result settle the baseline.
      const live = watches.get(key);
      if (live === watch) live.inFlight = undefined;
    });
    return watch.inFlight;
  };

  const ensureTimer = (): void => {
    if (cancelTimer !== undefined || watches.size === 0) return;
    cancelTimer = scheduleInterval(() => {
      for (const key of [...watches.keys()]) void check(key);
    }, MCP_CATALOG_FINGERPRINT_INTERVAL_MS);
  };

  const stopTimerIfIdle = (): void => {
    if (watches.size > 0 || cancelTimer === undefined) return;
    cancelTimer();
    cancelTimer = undefined;
  };

  return {
    async open({ token, filter, subscription_id, send }) {
      const acknowledged = acknowledgeableFilter(parseFilter(filter));
      const key = tokenKeyOf(token);
      const stream = { send, subscription_id };

      // The acknowledgement goes out FIRST and unconditionally — before any
      // watching, and even when we honour nothing. It is the client's only way
      // to learn what this stream will carry.
      send({
        jsonrpc: '2.0',
        method: MCP_SUBSCRIPTIONS_ACKNOWLEDGED_METHOD,
        params: {
          notifications: acknowledged,
          _meta: {
            [MCP_PROTOCOL_VERSION_META_KEY]: MCP_MODERN_PROTOCOL_VERSION,
            ...(subscription_id !== null
              ? { [MCP_SUBSCRIPTION_ID_META_KEY]: subscription_id }
              : {}),
          },
        },
      });

      if (acknowledged.toolsListChanged !== true) {
        // Nothing acknowledged ⇒ nothing to watch. The stream stays open and
        // silent, which is exactly what the acknowledgement just promised.
        return { acknowledged, close: () => {} };
      }

      let watch = watches.get(key);
      if (watch === undefined) {
        watch = {
          streams: new Set(),
          fingerprint: null,
          baselineFailed: false,
          lastCheckedAt: 0,
          inFlight: undefined,
          token,
        };
        watches.set(key, watch);
      }
      watch.streams.add(stream);
      ensureTimer();
      // Baseline now, so the first CHANGE is a change and not this client's
      // own arrival. `fingerprint === null` suppresses the first emit.
      void check(key);

      let closed = false;
      return {
        acknowledged,
        close: () => {
          if (closed) return;
          closed = true;
          const live = watches.get(key);
          if (live === undefined) return;
          live.streams.delete(stream);
          if (live.streams.size === 0) watches.delete(key);
          stopTimerIfIdle();
        },
      };
    },
    activeStreamCount: () => {
      let total = 0;
      for (const watch of watches.values()) total += watch.streams.size;
      return total;
    },
  };
};
