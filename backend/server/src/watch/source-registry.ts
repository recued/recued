/** WatchSource generalization — the push-source governance registry.
 *
 *  The push half of the WatchSource model (design § 2): push sources
 *  keep their own inbound plumbing (a webhook receiver, the vendor
 *  webhook port, the reception path handler) and share exactly two
 *  obligations — emit canonical change events on the ONE warehouse bus,
 *  and be VISIBLE in the one Automation governance surface. This
 *  registry is the visibility half: each source registers a status
 *  provider; `watch.list` flattens every provider's rows into the
 *  `sources` wire field.
 *
 *  `markEvent` is the shared last-event bookkeeping: emit sites call it
 *  with their stable `source_key` right after a bus emit, and `list()`
 *  decorates provider rows with the marks. In-memory, since process
 *  start — push sources keep no persisted delivery log (the events
 *  themselves land in the audit/warehouse trail; this is a liveness
 *  hint for the surface, not a ledger).
 *
 *  Providers are read at every `list()` call — rows derive fresh from
 *  the stores they wrap (connection enrollment, endpoint registry), so
 *  enrollment changes surface without registration churn. */

import type { WatchSourceStatusEntry } from '@recued/contracts';

/** Stable `source_key` mints — slash-delimited like `WatchKey`, one
 *  helper per mechanism so emit sites and providers can never drift. */
export const webhookSourceKey = (vendor: string, connection_name: string): string =>
  ['webhook', vendor, connection_name].join('/');
export const messengerSourceKey = (vendor: string): string => ['messenger', vendor].join('/');
export const receptionSourceKey = (endpoint_kind: string): string =>
  ['reception', endpoint_kind].join('/');

export interface WatchSourceProvider {
  /** Current governance rows for this source. Called per `watch.list`;
   *  keep it cheap (in-memory / indexed store reads). A provider throw
   *  is contained — its rows drop from that listing rather than
   *  failing the rpc. */
  list(): WatchSourceStatusEntry[];
}

export interface WatchSourceRegistry {
  /** Register (or REPLACE) the provider for `provider_id` — keyed so a
   *  recomposition (or a second test in the same worker reaching the
   *  process-default instance) swaps the provider in place instead of
   *  accumulating duplicates (codex MEDIUM fold). One id per
   *  mechanism's wire site: 'webhook' / 'messenger' / 'reception'. */
  register(provider_id: string, provider: WatchSourceProvider): void;
  /** Record an emit onto the bus for `source_key` — decorates the
   *  matching row's `last_event_at` on subsequent `list()` calls, and
   *  opens / coalesces into the change-notifier window (if wired). */
  markEvent(source_key: string, at: number): void;
  /** Wire the surface-refresh notifier — fired (coalesced) once per
   *  rate-limit window so the #automation governance surface refreshes
   *  live when a push source fires or flips active. Push sources are
   *  pull-based (no transition signal), so one notify per window lets
   *  the client re-pull `watch.list` and recompute `active` /
   *  `last_event_at` fresh — covering BOTH the liveness bump and any
   *  active-flip since the last refresh.
   *
   *  Semantics are a COALESCING THROTTLE, not a trailing-edge debounce:
   *  the window arms on the first `markEvent` and fires at its END
   *  (later marks in the window coalesce — no re-arm). Each fire reads
   *  live state via `list()`, so it reflects every mark up to that
   *  instant. Under a sustained inbound flood this caps refreshes to
   *  ≤1 / window — DELIBERATELY a rate cap rather than a debounce, so a
   *  continuously-active source keeps surfacing fresh liveness instead
   *  of being starved (a reset-on-every-mark debounce would never fire
   *  until the stream went quiet — the wrong shape for a liveness ping).
   *
   *  Called once in the listener phase (where the server `EventBus`
   *  exists); the registry stays dependency-free — `notify` closes over
   *  the bus emit, the registry only owns the window. The optional
   *  `schedule` seam (defaults to `setTimeout`, unref'd so a liveness
   *  ping never holds the process open) keeps the window deterministic
   *  under test. */
  setChangeNotifier(
    notify: () => void,
    opts?: {
      window_ms?: number;
      schedule?: (fn: () => void, ms: number) => void;
    },
  ): void;
  /** Every provider's rows, last-event-decorated, sorted by
   *  `source_key` for a stable wire order. */
  list(): WatchSourceStatusEntry[];
}

/** Coalescing rate-limit window for push-source liveness emits — at
 *  most one `automation_rule_changed` per window keeps a webhook /
 *  message flood from fanning out to every paired client per inbound
 *  event, while staying fresh on the next window for a sustained source. */
const DEFAULT_NOTIFY_WINDOW_MS = 1_000;

/** Process-wide default instance — the same module-global idiom as
 *  `getDefaultReconcilerRegistry`: push sources compose in different
 *  composition phases (salesforce CometD at vendor boot, reception in
 *  the ingress phase, the vendor webhook port in the listener phase),
 *  so a shared default avoids threading one handle through all of
 *  them. Tests construct isolated instances via
 *  `createWatchSourceRegistry`. */
export const getDefaultWatchSourceRegistry = (): WatchSourceRegistry => defaultRegistry;

export const createWatchSourceRegistry = (deps?: {
  log?: (level: 'warn', msg: string) => void;
}): WatchSourceRegistry => {
  const providers = new Map<string, WatchSourceProvider>();
  const lastEventAt = new Map<string, number>();

  let notify: (() => void) | null = null;
  let windowMs = DEFAULT_NOTIFY_WINDOW_MS;
  let schedule: (fn: () => void, ms: number) => void = (fn, ms) => {
    const timer = setTimeout(fn, ms) as { unref?: () => void };
    timer.unref?.();
  };
  let windowOpen = false;
  const scheduleNotify = (): void => {
    // Coalescing throttle: the first mark opens a window; marks during
    // it coalesce (no re-arm). When the window closes we emit once,
    // reading live state, then the next mark opens a fresh window.
    if (!notify || windowOpen) return;
    windowOpen = true;
    schedule(() => {
      windowOpen = false;
      try {
        notify?.();
      } catch {
        /* a surface-refresh ping must never break the emit path */
      }
    }, windowMs);
  };

  return {
    register(provider_id, provider) {
      providers.set(provider_id, provider);
    },
    markEvent(source_key, at) {
      const prev = lastEventAt.get(source_key);
      if (prev === undefined || at > prev) lastEventAt.set(source_key, at);
      scheduleNotify();
    },
    setChangeNotifier(notifyFn, opts) {
      notify = notifyFn;
      if (opts?.window_ms !== undefined) windowMs = opts.window_ms;
      if (opts?.schedule) schedule = opts.schedule;
    },
    list() {
      const out: WatchSourceStatusEntry[] = [];
      for (const provider of providers.values()) {
        let rows: WatchSourceStatusEntry[];
        try {
          rows = provider.list();
        } catch (err) {
          deps?.log?.(
            'warn',
            `watch source provider threw on list(): ${err instanceof Error ? err.message : String(err)}`,
          );
          continue;
        }
        for (const row of rows) {
          const marked = lastEventAt.get(row.source_key);
          out.push(
            marked !== undefined && (row.last_event_at === null || marked > row.last_event_at)
              ? { ...row, last_event_at: marked }
              : row,
          );
        }
      }
      return out.sort((a, b) => a.source_key.localeCompare(b.source_key));
    },
  };
};

const defaultRegistry = createWatchSourceRegistry();
