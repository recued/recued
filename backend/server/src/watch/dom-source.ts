/** WatchSource generalization — the dom poll source.
 *
 *  The 3rd `WatchPollSource` (after connection-api + mcp-resource):
 *  demand parses from enabled trigger rows whose pattern targets
 *  `data.dom.element.<encoded_target>.…`, and reads ONE DOM selector's
 *  text per tick off a matching browser tab — the poll "fetch" is a
 *  read-only `read_dom` dispatched to a paired Browser Bridge (injected
 *  here as the `readDom` plug, so this source stays unit-testable
 *  without a live bridge). The manager core hash-diffs the element text
 *  against the persisted snapshot and emits the canonical change event
 *  on the dedicated `dom` bus family (via `event_scope`), never the
 *  connection-api / connection.mcp scopes.
 *
 *  Mapping onto the universal `(vendor, entity, connection)` poll key:
 *    - `vendor`  = `dom-watch` (sentinel — `DOM_WATCH_VENDOR`);
 *    - `entity`  = `encodeDomWatchTarget(url_pattern, selector)` (a
 *                  url-pattern + selector carry `/` `:` `[` `]` ` `, so
 *                  the base64url form rides one bus segment + keys the
 *                  watch; `poll` decodes it back for the dispatch);
 *    - `connection_name` = `DOM_WATCH_CONNECTION` (`bridge` sentinel — a
 *                  dom watch has no connection-store record; the fetch
 *                  fans across eligible bridges).
 *  `watchKeyOf('dom-watch', encoded, 'bridge')` = `dom-watch/<encoded>/bridge`
 *  — a namespace neither the connection-api nor mcp-resource source ever
 *  mints (the hyphenated vendor sentinel can never alias an api key),
 *  so the manager's first-claimant collision guard never trips.
 *
 *  Like mcp-resource, there is no higher-fidelity twin to defer to (the
 *  MutationObserver push upgrade is recipe-transparent but not yet
 *  built), so every demand is `deferred_to: null`. And like mcp-resource
 *  the fetch reads exactly one element — a different shape from the
 *  connection-api `<entity>.search` walk, so it is a dedicated plug
 *  (`readDom`), not a reuse of `runCanonicalWatchPoll`. */

import type { EventTrigger } from '@recued/contracts';
import {
  DOM_WATCH_CONNECTION,
  DOM_WATCH_POLL_SOURCE_ID,
  DOM_WATCH_VENDOR,
  decodeDomWatchTarget,
  domWatchEventScope,
  encodeDomWatchTarget,
  parseDomWatchDemand,
  watchKeyOf,
} from '@recued/contracts';
import type { CanonicalPollOutcome } from './canonical-poll.js';
import type { WatchPollDemand, WatchPollSource } from './poll-manager.js';

/** Outcome of one `read_dom` fetch-plug call — the failure variant IS
 *  the `CanonicalPollOutcome` failure variant, so `poll` forwards it
 *  verbatim (no mapping). An `ok` outcome carries the element's text
 *  (`null` = the selector is absent on the page — a VALID observation:
 *  an element appearing / disappearing is a content change, so it rides
 *  the snapshot rather than the error path).
 *
 *  Failure `kind` discipline (it decides error-cap auto-disable):
 *    - `'unavailable'` — TRANSIENT: no eligible bridge online / the
 *      watched tab isn't open. The COMMON resting state (you don't keep
 *      every watched page open). Does NOT count toward the error cap —
 *      the manager keeps the watch armed and retries next interval, so
 *      closing the browser never disables a watch.
 *    - `'config'` — a stable misconfiguration (e.g. a malformed target).
 *    - `'policy'` — a grant / permission denial.
 *    - `'error'` — the read itself failed (transport / bridge error).
 *  The latter three DO count toward `WATCH_ERROR_CAP` — a genuinely
 *  broken watch fails loud rather than retry-storming. The brick-2
 *  bridge-fetch plug owns the classification (capacity_gap → unavailable,
 *  selector/transport failure → error). */
export type DomReadOutcome =
  | { ok: true; text: string | null }
  | { ok: false; kind: 'unavailable' | 'config' | 'policy' | 'error'; reason: string };

export interface DomSourceDeps {
  /** The fetch plug — a read-only `read_dom` of one selector on a tab
   *  matching `url_pattern`, dispatched to an eligible paired bridge.
   *  Read-only by construction (a watch never fills / clicks). The
   *  freshness discipline (the bridge idempotency cache MUST be bypassed
   *  per detection tick or change-detection goes blind — design § 6) is
   *  the plug's concern, not this source's. */
  readDom: (input: { url_pattern: string; selector: string }) => Promise<DomReadOutcome>;
}

const readIntervalPref = (trigger: EventTrigger): number | undefined => {
  // The dedicated trigger-row field (D-179 P2), shared with the
  // connection-api + mcp-resource sources' interval semantics.
  const raw = trigger.watch_interval_ms;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : undefined;
};

export const createDomPollSource = (deps: DomSourceDeps): WatchPollSource => ({
  source_id: DOM_WATCH_POLL_SOURCE_ID,

  deriveDemands(triggers, opts) {
    interface Wanted {
      url_pattern: string;
      selector: string;
      encoded: string;
      recipe_ids: Set<string>;
      prefs: number[];
    }
    const wanted = new Map<string, Wanted>();
    for (const trigger of triggers) {
      const parsed = parseDomWatchDemand(trigger.pattern);
      if (parsed === null) continue;
      const encoded = encodeDomWatchTarget(parsed.url_pattern, parsed.selector);
      // base64url carries no `/` — an injective coalescing key for the
      // (url_pattern, selector) target.
      const demandKey = encoded;
      let entry = wanted.get(demandKey);
      if (entry === undefined) {
        entry = {
          url_pattern: parsed.url_pattern,
          selector: parsed.selector,
          encoded,
          recipe_ids: new Set(),
          prefs: [],
        };
        wanted.set(demandKey, entry);
      }
      entry.recipe_ids.add(trigger.recipe_id);
      const pref = readIntervalPref(trigger);
      if (pref !== undefined) entry.prefs.push(pref);
    }
    if (wanted.size === 0) return [];

    // No enrollment gate (unlike the mcp-resource source's enrolled
    // connections): a dom watch is derivable from its pattern alone. A
    // briefly-offline bridge / closed tab never disables the watch
    // because the fetch reports those as the non-error `'unavailable'`
    // kind (kept out of the manager's error cap) rather than dropping
    // the demand — so the snapshot survives and the watch resumes the
    // moment the client returns.
    const out: WatchPollDemand[] = [];
    for (const entry of wanted.values()) {
      const watch_key = watchKeyOf(DOM_WATCH_VENDOR, entry.encoded, DOM_WATCH_CONNECTION);
      const interval_ms = Math.max(
        opts.floorMs,
        entry.prefs.length > 0 ? Math.min(...entry.prefs) : opts.defaultMs,
      );
      out.push({
        watch_key,
        vendor: DOM_WATCH_VENDOR,
        entity: entry.encoded,
        connection_name: DOM_WATCH_CONNECTION,
        recipe_ids: [...entry.recipe_ids].sort(),
        interval_ms,
        deferred_to: null,
        event_scope: domWatchEventScope(entry.encoded),
      });
    }
    return out;
  },

  async poll(target): Promise<CanonicalPollOutcome> {
    // `entity` is the base64url-encoded (url_pattern, selector) target
    // deriveDemands minted; decode it for the dispatch. A decode miss is
    // a substrate bug (we encoded it) — surface as config, never crash
    // the tick.
    const decoded = decodeDomWatchTarget(target.entity);
    if (decoded === null) {
      return {
        ok: false,
        kind: 'config',
        reason: `dom-watch: watch key carries an undecodable target segment '${target.entity}'`,
      };
    }
    const outcome = await deps.readDom({
      url_pattern: decoded.url_pattern,
      selector: decoded.selector,
    });
    // The failure variant IS the CanonicalPollOutcome failure variant
    // (incl. the non-error `'unavailable'` skip) — forward verbatim.
    if (!outcome.ok) return outcome;
    // ONE element per poll → one record keyed by the selector (the
    // meaningful record id downstream). `text: null` (selector absent on
    // an OPEN page) is a valid snapshot value — appear/disappear is a
    // content change. `truncated: false` marks a complete walk; the
    // snapshot only ever holds this selector, so a `deleted` is never
    // synthesized — a vanished element surfaces as a `text: null` content
    // change, while a read that couldn't happen at all (no bridge / no
    // open tab) surfaces as `'unavailable'` (kept off the error cap), not
    // a phantom delete.
    return {
      ok: true,
      records: new Map([[decoded.selector, { text: outcome.text }]]),
      truncated: false,
      // A single-selector DOM read is a complete walk of its one-record snapshot
      // (and never synthesizes a `deleted`, per above) — so `complete: true`.
      complete: true,
      skipped_no_id: 0,
    };
  },
});
