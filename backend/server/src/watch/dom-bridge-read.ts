/** Brick 2 — the dom poll source's `readDom` bridge-fetch plug.
 *
 *  `createDomPollSource` (brick 1) takes a `readDom` plug and stays
 *  unit-testable without a live bridge. This module is the production
 *  plug: it dispatches a read-only `read_dom` of ONE selector to an
 *  eligible paired Browser Bridge via the existing `BridgeDispatcher`
 *  (the same path the DOM-ingredient runner uses — see
 *  `bridges/dom-adapter.ts`) and maps the `DispatchOutcome` to the
 *  brick-1 `DomReadOutcome` shape.
 *
 *  Three design pins (the brick-2 traps, design § 6 + the brick-1
 *  handover):
 *
 *  1. **Synthetic kernel ingredient + grant model.** A dom watch has no
 *     recipe ingredient, so the dispatch carries a synthetic kernel
 *     `recued/dom-watch` `BridgeIngredientRef` whose single
 *     `domain_allowlist` member IS the watched `url_pattern`. The
 *     dispatcher's `filterEligible` then only routes to a bridge whose
 *     `granted_origins` includes that pattern — so a dom watch reads
 *     ONLY domains the user has granted the Bridge. `surface_kind:
 *     'reading'` + `domain_allowlist_signature: ''` (the dev no-op the
 *     dom-adapter also uses; the bridge's signature gate no-ops on the
 *     empty string pre-launch).
 *
 *  2. **Idempotency BYPASS.** The bridge replays a result for 24h keyed
 *     by `idempotency_key`. A poll MUST mint a FRESH key per tick or the
 *     bridge replays a stale read and change-detection goes BLIND. The
 *     DOM-ingredient runner deliberately STABILIZES its key (retry of a
 *     side-effecting step should dedup); a watch read is the exact
 *     opposite — the freshness oracle — so it randomizes.
 *
 *  3. **Outcome classification → the brick-1 `kind` discipline.** The
 *     classification decides error-cap auto-disable, so the routine
 *     resting state (bridge offline / watched tab not open) maps to the
 *     non-error `'unavailable'` kind (kept off the cap → the watch never
 *     auto-disables on routine client absence), while a genuine
 *     grant/transport failure maps to `policy`/`error` (counts → fails
 *     loud). See `classifyDomReadOutcome`. */

import { randomUUID } from 'node:crypto';

import type { BridgeIngredientRef } from '@recued/contracts';
import type {
  BridgeDispatcher,
  DispatchOutcome,
  DispatchRequest,
} from '../bridges/dispatcher.js';
import type { DomReadOutcome } from './dom-source.js';

/** Kernel publisher namespace (`recued`) — NOT the D-170 `core-` slug
 *  prefix. The ref is server-internal (never named by a recipe, never in
 *  the manifest registry), so the publish-trust gate does not touch it.
 *  See the brick-1 handover "Namespace / core-pack interaction". */
const DOM_WATCH_INGREDIENT_SLUG = 'dom-watch';
const DOM_WATCH_INGREDIENT_PUBLISHER = 'recued';

/** Stable audit anchor — matches the canonical poll's `WATCH_POLL_RECIPE`
 *  identity (`recipe_id: 'watch-poll'`, audit `step_id: 'watch_poll'`) so
 *  dom poll dispatches read the same in the bridge dispatch / audit
 *  trail. The dispatcher keys its in-flight map by the per-dispatch random
 *  `command_id`, so a shared `recipe_run_id` across concurrent dom watches
 *  can never cross-talk on cancel (same reasoning as the dom-adapter). */
const DOM_WATCH_RECIPE_RUN_ID = 'watch-poll';
const DOM_WATCH_STEP_ID = 'watch_poll';

export interface BridgeDomReadDeps {
  /** Late-bound dispatcher accessor — resolved PER tick so a bridge
   *  runtime that publishes its dispatcher after this composer runs (the
   *  WS server binds the dispatcher post-compose) is picked up without a
   *  recompose. Returns undefined before the WS binding lands, or in a
   *  bridgeless harness → the read reports `'unavailable'` (off the error
   *  cap), exactly the routine "no bridge yet" resting state. */
  getDispatcher: () => BridgeDispatcher | undefined;
  /** Fresh idempotency key per call — DEFAULT `randomUUID`. Bypasses the
   *  bridge's 24h replay cache (pin 2). The test seam injects a
   *  deterministic counter to assert freshness. */
  generateIdempotencyKey?: () => string;
}

/** Map one `BridgeDispatcher.dispatch(...)` outcome to the brick-1
 *  `DomReadOutcome`. Pure — split out so the (branchy) bucketing is
 *  unit-testable without a dispatcher.
 *
 *  The `kind` decides the manager's error-cap bookkeeping:
 *    - `ok: true`           — a real read (incl. `text: null` for an
 *                             absent selector on an OPEN tab: appear /
 *                             disappear is a content change, not an error).
 *    - `'unavailable'`      — TRANSIENT "nothing to poll right now" (no
 *                             bridge / no open tab / bridge busy / SW
 *                             torn down). The COMMON resting state — NEVER
 *                             counts toward the cap.
 *    - `'policy'`           — a grant / scope denial the user must resolve.
 *    - `'error'`            — a genuine read failure (transport / blocked
 *                             tab / unexpected). Both `policy` + `error`
 *                             count toward the cap so a broken watch fails
 *                             loud rather than retry-storming. */
export const classifyDomReadOutcome = (outcome: DispatchOutcome): DomReadOutcome => {
  // No eligible bridge / no connected bridge / preferred label missing
  // (`capacity_gap`), or every eligible bridge reported a per-bridge gap
  // — e.g. the watched tab is open on none (`aggregate_capacity_gap`).
  // Routine client absence → transient, never the cap.
  if (outcome.kind === 'capacity_gap') {
    return {
      ok: false,
      kind: 'unavailable',
      reason: `no eligible bridge / open tab for the watched origin (${outcome.reason})`,
    };
  }
  if (outcome.kind === 'aggregate_capacity_gap') {
    return {
      ok: false,
      kind: 'unavailable',
      reason: `no bridge could serve the read — ${outcome.aggregate.bridges.length} eligible bridge(s) reported a capacity gap (tab likely not open)`,
    };
  }
  // Server waited; the bridge never returned in time. Transient (a slow
  // / unresponsive tab), not a broken watch.
  if (outcome.kind === 'timeout') {
    return {
      ok: false,
      kind: 'unavailable',
      reason: 'the bridge did not return a read within the command budget',
    };
  }

  // outcome.kind === 'completed' — the bridge answered with a result.
  const { result } = outcome;
  if (result.status === 'ok') {
    // ONE element read → `{ text }`. A non-string / absent `text` snaps
    // as `null` (a valid observation), never an error.
    const text = result.outputs?.text;
    return { ok: true, text: typeof text === 'string' ? text : null };
  }
  if (result.status === 'timeout' || result.status === 'cancelled') {
    // The bridge accepted but couldn't finish (tab busy) / was cancelled.
    // Transient → retry next interval, off the cap.
    return {
      ok: false,
      kind: 'unavailable',
      reason: `the bridge read was ${result.status} (tab busy or interrupted)`,
    };
  }
  if (result.status === 'rejected') {
    // An eligible bridge's OWN two-way grant intersection (§ A.7) denied
    // the read — a real grant/scope conflict the user must resolve, so
    // it fails loud (counts toward the cap). Distinct from the
    // server-side no-eligible-bridge filter, which surfaces as
    // `capacity_gap` → `unavailable` above (the user may grant later).
    return {
      ok: false,
      kind: 'policy',
      reason:
        result.error?.message ??
        'the bridge rejected the read — the watched origin is outside the granted scope',
    };
  }

  // result.status === 'error' — a non-ok BridgeResult. Bucket by code.
  const code = result.error?.code;
  if (code === 'selector_not_found') {
    // The tab is OPEN + readable but the selector matched nothing — the
    // element is ABSENT. A valid content observation (appear/disappear),
    // snapped as `text: null`, NOT a failure.
    return { ok: true, text: null };
  }
  if (
    code === 'capacity_gap_logged_in' ||
    code === 'capacity_gap_tab_unavailable' ||
    code === 'capacity_gap_permission_missing' ||
    code === 'mv3_lifecycle_killed'
  ) {
    // Strict single-bridge dispatch surfaces capacity gaps as a completed
    // error result (multi-bridge aggregates them above); an MV3 service
    // worker torn down mid-read is a transient lifecycle event. All →
    // transient, off the cap.
    return {
      ok: false,
      kind: 'unavailable',
      reason: `the bridge read is unavailable (${code})`,
    };
  }
  if (
    code === 'authority_invalid' ||
    code === 'authority_expired' ||
    code === 'authority_invalid_grant_scope' ||
    code === 'ingredient_domain_signature_invalid'
  ) {
    return {
      ok: false,
      kind: 'policy',
      reason: result.error?.message ?? `the bridge denied the read (${code})`,
    };
  }
  // `tab_navigation_blocked`, `idempotency_violation`, `unknown`, or no
  // code — a genuine read failure. Counts toward the cap.
  return {
    ok: false,
    kind: 'error',
    reason:
      result.error?.message ?? `the bridge read failed${code ? ` (${code})` : ''}`,
  };
};

/** Build the production `readDom` plug for `createDomPollSource`. */
export const createBridgeDomRead = (
  deps: BridgeDomReadDeps,
): ((input: { url_pattern: string; selector: string }) => Promise<DomReadOutcome>) => {
  const generateIdempotencyKey = deps.generateIdempotencyKey ?? (() => randomUUID());
  return async ({ url_pattern, selector }) => {
    const dispatcher = deps.getDispatcher();
    if (dispatcher === undefined) {
      // No bridge runtime wired yet (pre-WS-bind) / bridgeless harness —
      // the routine "no bridge" resting state, off the cap.
      return {
        ok: false,
        kind: 'unavailable',
        reason: 'no paired Browser Bridge runtime is wired',
      };
    }

    const ingredient: BridgeIngredientRef = {
      slug: DOM_WATCH_INGREDIENT_SLUG,
      publisher_id: DOM_WATCH_INGREDIENT_PUBLISHER,
      version: '1',
      surface_kind: 'reading',
      // The single allowlist member IS the watched origin — eligibility
      // (`filterEligible`) then routes only to bridges that granted it.
      domain_allowlist: [url_pattern],
      domain_allowlist_signature: '',
    };
    const request: DispatchRequest = {
      recipe_run_id: DOM_WATCH_RECIPE_RUN_ID,
      step_id: DOM_WATCH_STEP_ID,
      ingredient,
      action: 'read_dom',
      args: { selector },
      expects_output_keys: ['text'],
      // FRESH per tick — the freshness oracle (pin 2).
      idempotency_key: generateIdempotencyKey(),
      // Explicit target → the dispatcher matches it against the (single)
      // allowlist member exactly, no `args.target_url` heuristics.
      target_domain_pattern: url_pattern,
    };

    let outcome: DispatchOutcome;
    try {
      outcome = await dispatcher.dispatch(request);
    } catch (e) {
      // A throw from dispatch is a substrate/transport bug, not a routine
      // gap — count it (error), so it fails loud rather than retry-storms.
      return {
        ok: false,
        kind: 'error',
        reason: e instanceof Error ? e.message : String(e),
      };
    }
    return classifyDomReadOutcome(outcome);
  };
};
