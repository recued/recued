/** WatchSource generalization — the mcp `subscriptions/listen` push source.
 *
 *  The 4th push source (after webhook / messenger / reception), and the first
 *  higher-fidelity twin the mcp-resource POLL source has ever had. MCP
 *  2026-07-28 removed the GET stream and protocol sessions; `subscriptions/
 *  listen` is the only server→client channel left, and what it carries for a
 *  resource is exactly one bit — "this uri changed".
 *
 *  🔑 PUSH SAYS *WHEN*, THE POLL IS STILL THE *WHAT*. A listen frame has no
 *  content: reading the resource still costs a `resources/read`. So this source
 *  does NOT emit. It calls `pollNow` on the canonical watch key the
 *  mcp-resource poll source already owns, and that poll reads, hash-diffs and
 *  emits exactly as it does on its timer. Three things follow, and all three
 *  are the reason this shape was chosen over a second emit path:
 *    · a recipe sees a byte-identical event whether push is live or not —
 *      `record`, `changed_fields` and `prev` all come from the one differ;
 *    · there is no second place for the canonical path to drift;
 *    · deferral never arises. A push source that REPLACED the poll would have
 *      to mark the demand `deferred_to`, and then a silent feed would mean no
 *      reads at all. Here the timer stays armed underneath as the floor, and
 *      push only makes it earlier. `mcp-resource-source.ts` says "no
 *      higher-fidelity twin to defer to" — that stays true, deliberately.
 *
 *  ⛔ THE CORRELATION GUARD IS THE SERVER'S ACKNOWLEDGEMENT, NOT OUR REQUEST.
 *  The revision lets a server honour a SUBSET of the filter and requires the
 *  acknowledgement to say which. So a frame is accepted only for a uri in the
 *  acknowledged set of the feed it arrived on — never merely because we asked
 *  for it, and never because some other connection subscribes to that uri. A
 *  server that acknowledges no `resourceSubscriptions` at all pushes nothing we
 *  will act on, which is the correct reading of "omit what it does not
 *  support".
 *
 *  ⚠ WHAT IS NOT SUBSCRIBED, AND WHY. The closed filter vocabulary also offers
 *  `toolsListChanged` / `promptsListChanged` / `resourcesListChanged`. None is
 *  asked for here: no canonical change key exists for them, so accepting them
 *  would mean inventing an event family in a push handler. When one exists,
 *  it widens the filter — not this file's guard.
 *
 *  ⚠ GOVERNANCE VISIBILITY IS REAL BUT UNRENDERED TODAY. Rows register with
 *  `WatchSourceRegistry` and reach callers over `watch.list`, but the
 *  webclient's automation route dropped `.sources` in R21 — so the row is
 *  fetchable and not on screen. Registering anyway keeps the row where it
 *  belongs; it does not mean a user can see it. */

import type { EventTrigger, WatchSourceStatusEntry } from '@recued/contracts';
import {
  MCP_RESOURCE_WATCH_VENDOR,
  encodeMcpResourceUri,
  parseMcpResourceWatchDemand,
  watchKeyOf,
} from '@recued/contracts';
import type { McpPushUnavailableReason } from '@recued/ingredients';
import { mcpListenSourceKey, type WatchSourceProvider } from './source-registry.js';

/** What a caller's `openListen` hands back. Mirrors the ingredient's
 *  `McpListenOpenResult` without importing its transport shape — the server
 *  wiring owns endpoint + auth, this source owns demand + correlation. */
export type McpListenOpenOutcome =
  | {
      ok: true;
      /** The server's own declaration. `resourceSubscriptions` is the
       *  correlation set; absent means it acknowledged no resource feed. */
      acknowledged: { resourceSubscriptions?: string[] };
      /** Settles when the feed ends. `'closed'` iff we ended it. */
      ended: Promise<{ reason: 'closed' | 'ended' | 'error' }>;
      close(): void;
    }
  | { ok: false; reason: McpPushUnavailableReason };

export interface McpListenSourceDeps {
  /** Enabled trigger rows — the SAME demand basis the poll source parses, so
   *  the two can never disagree about which uris are watched. */
  listTriggers: () => EventTrigger[];
  /** Enrolled `connection.mcp` connection names. */
  listMcpConnections: () => string[];
  openListen: (input: {
    connection_name: string;
    uris: string[];
    onResourceUpdated: (uri: string) => void;
  }) => Promise<McpListenOpenOutcome>;
  /** Accelerate one canonical watch key. A key with no armed loop is a no-op
   *  in the manager — which is what enforces "we only act on live demand"
   *  even for a frame that arrives between a demand change and a re-open. */
  pollNow: (watch_key: string) => Promise<void>;
  markEvent?: (source_key: string, at: number) => void;
  now?: () => number;
  /** Deferred execution seam (backoff + throttle), so tests drive the clock
   *  instead of waiting on it. Defaults to an unref'd `setTimeout`. */
  schedule?: (fn: () => void, ms: number) => void;
  log?: (level: 'warn', msg: string) => void;
}

export interface McpListenSourceHandle {
  /** Re-derive demand → open / close / re-open feeds. Idempotent; call it on
   *  every demand-changing seam, exactly like the poll manager's own. */
  recompute(): void;
  /** Close every feed. Re-armable — a later `recompute()` re-opens. */
  stop(): Promise<void>;
  provider: WatchSourceProvider;
  /** Open feed count (tests + diagnostics). */
  activeFeedCount(): number;
}

/** Minimum gap between two accelerations of the SAME key.
 *
 *  ⛔ A PUSH SOURCE IS PACED BY SOMEBODY ELSE. A poll loop's cost is bounded by
 *  its own interval; a feed's is bounded by whatever the far server chooses to
 *  send. Without a floor, a chatty (or hostile) server turns one subscription
 *  into an unbounded `resources/read` amplifier against itself and against our
 *  audit trail. Frames inside the window are DROPPED, not queued: the next
 *  poll reads current content anyway, so a coalesced burst loses nothing. */
export const MCP_LISTEN_ACCELERATE_MIN_GAP_MS = 2_000;

/** Backoff ladder for re-opening a dropped feed, capped rather than latched.
 *  ⚠ A LATCH WOULD NEVER CLEAR. "This server refused once" must not become
 *  "this server can never push", or a vendor that ships listen support next
 *  month is never noticed. The ceiling makes a permanent refusal cost one
 *  request per connection per ceiling, and `recompute()` resets the ladder
 *  whenever demand changes. */
export const MCP_LISTEN_REOPEN_BACKOFF_MS = [1_000, 5_000, 30_000, 120_000] as const;
export const MCP_LISTEN_REOPEN_CEILING_MS = 900_000;

/** Every reason a governance row can carry, as a sentence an owner can act on.
 *
 *  ⛔ THE ROW IS A USER SURFACE, AND A RAW ENUM IS NOT AN EXPLANATION. Three of
 *  the four reasons here reached it as bare tokens (`listen_method_unsupported`,
 *  `listen_not_streamed`, `listen_error`) because the row fell through to the
 *  enum whenever no feed existed — and the fix that stopped holding a dead
 *  stream made the fourth (`listen_no_acknowledgement`) the COMMON one, since
 *  that is how every server without a resources surface answers.
 *
 *  ⚠ EXHAUSTIVE BY TYPE, not by a default branch: a new `McpPushUnavailableReason`
 *  fails the build here rather than silently shipping its identifier to an owner. */
const INACTIVE_SENTENCE: Record<McpPushUnavailableReason | 'no_demand', string> = {
  no_demand: 'no recipe watches a resource on this connection',
  listen_method_unsupported:
    'this MCP server does not implement subscriptions — the resource is polled instead',
  listen_not_streamed:
    'this MCP server answered the subscription without opening a stream — the resource is polled instead',
  listen_no_acknowledgement:
    'this MCP server subscribes to no resources — the resource is polled instead',
  listen_error: 'the subscription stream could not be opened — retrying',
};

interface Feed {
  connection_name: string;
  /** The uris we ASKED for — the re-open trigger when demand moves. */
  requested: string[];
  /** The uris the server ACKNOWLEDGED — the correlation guard. */
  acknowledged: Set<string>;
  close(): void;
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

export const createMcpListenSource = (
  deps: McpListenSourceDeps,
): McpListenSourceHandle => {
  const now = deps.now ?? (() => Date.now());
  const schedule = deps.schedule ?? ((fn, ms) => {
    const timer = setTimeout(fn, ms) as { unref?: () => void };
    timer.unref?.();
  });

  /** Open feeds, by connection. */
  const feeds = new Map<string, Feed>();
  /** Connections with an open() in flight — never two at once per connection. */
  const opening = new Set<string>();
  /** Re-open attempts since the last success, by connection. */
  const attempts = new Map<string, number>();
  /** Why a connection has no feed, when knowable — the governance row's line. */
  const inactive = new Map<string, McpPushUnavailableReason | 'no_demand'>();
  /** Last acceleration per watch key — the throttle floor. */
  const lastAccelerated = new Map<string, number>();
  let stopped = false;

  /** `Map<connection_name, sorted uris>` from the enabled trigger rows,
   *  restricted to enrolled mcp connections. */
  const deriveDemand = (): Map<string, string[]> => {
    const wanted = new Map<string, Set<string>>();
    for (const trigger of deps.listTriggers()) {
      const parsed = parseMcpResourceWatchDemand(trigger.pattern);
      if (parsed === null) continue;
      let uris = wanted.get(parsed.connection_name);
      if (uris === undefined) {
        uris = new Set();
        wanted.set(parsed.connection_name, uris);
      }
      uris.add(parsed.uri);
    }
    const enrolled = new Set(deps.listMcpConnections());
    const out = new Map<string, string[]>();
    for (const [connection_name, uris] of wanted) {
      if (!enrolled.has(connection_name)) continue;
      out.set(connection_name, [...uris].sort());
    }
    return out;
  };

  /** Throttle + dispatch. The correlation guard does NOT live here — see
   *  `openFor`, where the acknowledged set is bound to the open that produced
   *  it rather than looked up by connection name. */
  const accelerate = (connection_name: string, uri: string): void => {
    const watch_key = watchKeyOf(
      MCP_RESOURCE_WATCH_VENDOR,
      encodeMcpResourceUri(uri),
      connection_name,
    );
    const at = now();
    const last = lastAccelerated.get(watch_key);
    if (last !== undefined && at - last < MCP_LISTEN_ACCELERATE_MIN_GAP_MS) return;
    lastAccelerated.set(watch_key, at);
    deps.markEvent?.(mcpListenSourceKey(connection_name), at);
    void deps.pollNow(watch_key).catch((err: unknown) => {
      deps.log?.(
        'warn',
        `mcp-listen: accelerated poll of ${watch_key} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  };

  const scheduleReopen = (
    connection_name: string,
    /** A DEFINITIVE refusal — the server said it does not implement the
     *  method. Unlike a dropped feed, retrying it soon cannot succeed, so it
     *  skips the fast rungs and waits the ceiling. Still not a latch: an
     *  ordinary MCP server that adds listen support next month is picked up on
     *  the next ceiling tick or the next demand change, without anyone
     *  clearing state. */
    definitive = false,
  ): void => {
    if (stopped) return;
    const attempt = attempts.get(connection_name) ?? 0;
    attempts.set(connection_name, attempt + 1);
    const delay = definitive || attempt >= MCP_LISTEN_REOPEN_BACKOFF_MS.length
      ? MCP_LISTEN_REOPEN_CEILING_MS
      : MCP_LISTEN_REOPEN_BACKOFF_MS[attempt]!;
    schedule(() => {
      if (stopped) return;
      // ⛔ THIS TIMER REOPENS *THIS* CONNECTION, NOT EVERY CONNECTION. It used
      // to call the global `recompute()`, which opens every demanded connection
      // that has no feed — so the ladder was per-connection in appearance only:
      // a peer that refused with 404 and earned the 900s ceiling was retried
      // one second later by ANY other connection's transient-failure timer.
      // Each connection now serves its own sentence.
      const uris = deriveDemand().get(connection_name);
      // Re-derived rather than reusing the old filter: demand may have moved
      // while we were backing off, and re-opening a stale subscription would
      // subscribe to uris nobody watches any more.
      if (uris === undefined || feeds.has(connection_name)) return;
      openFor(connection_name, uris);
    }, delay);
  };

  const openFor = (connection_name: string, uris: string[]): void => {
    if (stopped || opening.has(connection_name)) return;
    opening.add(connection_name);
    void (async () => {
      // ⛔ THE CORRELATION SET BELONGS TO *THIS* OPEN. Resolving it by
      // connection name at frame time reads whatever feed is CURRENT, which is
      // not the feed that sent the frame: after a demand change closes feed A
      // and opens feed B, an in-flight frame from A was judged against B's
      // acknowledgement — so a uri A never acknowledged was accepted because B
      // happened to. `live` closes the same hole for a frame that lands after
      // its own feed was closed. Both are bound here, per open, where the
      // server's answer actually arrives.
      const acknowledged = new Set<string>();
      let live = false;
      let outcome: McpListenOpenOutcome;
      try {
        outcome = await deps.openListen({
          connection_name,
          uris,
          onResourceUpdated: (uri) => {
            if (!live || !acknowledged.has(uri)) return;
            accelerate(connection_name, uri);
          },
        });
      } catch (err) {
        outcome = { ok: false, reason: 'listen_error' };
        deps.log?.(
          'warn',
          `mcp-listen: open threw for ${connection_name}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      } finally {
        opening.delete(connection_name);
      }
      if (!outcome.ok) {
        inactive.set(connection_name, outcome.reason);
        scheduleReopen(connection_name, outcome.reason === 'listen_method_unsupported');
        return;
      }
      if (stopped) {
        outcome.close();
        return;
      }
      // ⛔ A STREAM THAT ACKNOWLEDGED NOTHING IS NOT A STREAM WORTH HOLDING.
      // The open SUCCEEDED, so nothing else here would ever close it — and a
      // socket held open against a server that just declared it will send us
      // nothing is pure cost. This is not hypothetical: a peer RECUED answers
      // exactly this way, because `subscriptions/listen` on our own host
      // honours `toolsListChanged` and serves no resources at all, while this
      // source asks only for `resourceSubscriptions`. The two halves connect
      // and agree on nothing.
      //
      // Treated as DEFINITIVE, like a refused method: retrying in a second
      // cannot change what a server supports, but the ceiling still retries so
      // a peer that later grows a resources surface is picked up.
      if ((outcome.acknowledged.resourceSubscriptions ?? []).length === 0) {
        outcome.close();
        inactive.set(connection_name, 'listen_no_acknowledgement');
        scheduleReopen(connection_name, true);
        return;
      }
      inactive.delete(connection_name);
      attempts.delete(connection_name);
      for (const uri of outcome.acknowledged.resourceSubscriptions ?? []) {
        acknowledged.add(uri);
      }
      // ⚠ DEMAND MAY HAVE MOVED WHILE THE OPEN WAS IN FLIGHT. `opening`
      // suppresses a replacement attempt during the await, so without this the
      // stale filter would be installed and stay wrong until some unrelated
      // seam fired a recompute — subscribing to a uri nobody watches, and not
      // subscribing to the one that arrived.
      const current = deriveDemand().get(connection_name);
      if (current === undefined || !sameSet(current, uris)) {
        outcome.close();
        if (current !== undefined) openFor(connection_name, current);
        return;
      }
      live = true;
      // Closing retires this open's guard as well as the socket, so a frame
      // already in flight when we let go is dropped rather than raced.
      const close = (): void => {
        live = false;
        outcome.close();
      };
      feeds.set(connection_name, {
        connection_name,
        requested: uris,
        acknowledged,
        close,
      });
      void outcome.ended.then(({ reason }) => {
        live = false;
        // Only drop the record if it is still OUR feed — a re-open that
        // already replaced it must not be erased by the old one's ending.
        if (feeds.get(connection_name)?.close === close) {
          feeds.delete(connection_name);
        }
        if (reason === 'closed' || stopped) return;
        inactive.set(connection_name, 'listen_error');
        scheduleReopen(connection_name);
      });
    })();
  };

  /** Drop this connection's throttle marks. The key is
   *  `<vendor>/<encoded_uri>/<connection_name>`, so the connection is the
   *  suffix — see `watchKeyOf`. Without this the map keeps one entry per
   *  (connection, uri) ever accelerated, for the life of the process, long
   *  after the trigger that demanded it was deleted. */
  const forgetThrottle = (connection_name: string): void => {
    const suffix = `/${connection_name}`;
    for (const key of [...lastAccelerated.keys()]) {
      if (key.endsWith(suffix)) lastAccelerated.delete(key);
    }
  };

  const closeFeed = (connection_name: string): void => {
    const feed = feeds.get(connection_name);
    if (feed === undefined) return;
    feeds.delete(connection_name);
    forgetThrottle(connection_name);
    try {
      feed.close();
    } catch { /* closing a dead feed is not an error */ }
  };

  const recompute = (): void => {
    // Clears `stopped`, mirroring the poll manager: `recompute()` is the
    // explicit re-arm entry point, so calling it after `stop()` rebuilds the
    // feeds (the maintenance-exit posture). SCHEDULED work must therefore
    // check `stopped` BEFORE calling in — `scheduleReopen` does — or a
    // backoff timer that outlived a stop would resurrect the source.
    stopped = false;
    const demand = deriveDemand();
    // Close feeds that lost demand entirely.
    for (const connection_name of [...feeds.keys()]) {
      if (!demand.has(connection_name)) {
        closeFeed(connection_name);
        inactive.set(connection_name, 'no_demand');
        attempts.delete(connection_name);
      }
    }
    // A connection whose demand vanished without ever holding a feed still
    // leaves throttle marks behind.
    for (const connection_name of [...inactive.keys()]) {
      if (!demand.has(connection_name)) forgetThrottle(connection_name);
    }
    for (const [connection_name, uris] of demand) {
      const feed = feeds.get(connection_name);
      if (feed === undefined) {
        openFor(connection_name, uris);
        continue;
      }
      // 2026-07-28 has no verb for widening a live subscription, so a changed
      // filter means close-and-re-open. Demand moving is also the signal that
      // resets the backoff ladder — a new filter deserves a fresh attempt.
      if (!sameSet(feed.requested, uris)) {
        closeFeed(connection_name);
        attempts.delete(connection_name);
        openFor(connection_name, uris);
      }
    }
    // A connection that regained demand clears its stale `no_demand` line.
    for (const connection_name of demand.keys()) {
      if (inactive.get(connection_name) === 'no_demand') inactive.delete(connection_name);
    }
  };

  const provider: WatchSourceProvider = {
    list(): WatchSourceStatusEntry[] {
      const demand = deriveDemand();
      const rows: WatchSourceStatusEntry[] = [];
      const names = new Set([...demand.keys(), ...feeds.keys()]);
      for (const connection_name of [...names].sort()) {
        const feed = feeds.get(connection_name);
        const uris = demand.get(connection_name) ?? feed?.requested ?? [];
        const reason = inactive.get(connection_name);
        rows.push({
          source_key: mcpListenSourceKey(connection_name),
          mechanism: 'mcp',
          label: `mcp listen — ${connection_name}`,
          // What it ACCELERATES, not what it emits — the poll source owns the
          // emit, and claiming otherwise here would misname the row.
          emits: uris.map(
            (uri) =>
              `data.connection.mcp.${connection_name}.resource.${encodeMcpResourceUri(uri)}.updated`,
          ),
          active: feed !== undefined && feed.acknowledged.size > 0,
          inactive_reason:
            feed !== undefined && feed.acknowledged.size > 0
              ? null
              : reason === undefined
                ? 'connecting'
                : INACTIVE_SENTENCE[reason],
          // The registry decorates this from `markEvent`.
          last_event_at: null,
        });
      }
      return rows;
    },
  };

  return {
    recompute,
    async stop() {
      stopped = true;
      for (const connection_name of [...feeds.keys()]) closeFeed(connection_name);
      lastAccelerated.clear();
    },
    provider,
    activeFeedCount: () => feeds.size,
  };
};
