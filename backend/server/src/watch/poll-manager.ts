/** Poll-manager / G6 — the central watch coordinator (design § 3),
 *  generalized over pluggable poll sources (design § 9 item 4: the
 *  WatchSource model's poll half).
 *
 *  `watch_key = (vendor, entity, connection)` is the coalescing unit.
 *  Demand derivation is a SOURCE concern: each registered
 *  `WatchPollSource` reads the enabled trigger rows and returns the
 *  concrete keys it can poll (the connection-api source parses
 *  `data.connection.api.<vendor>.<entity>.…` patterns and fans across
 *  enrolled connections — see `connection-api-source.ts`). However
 *  many recipes watch however many fields of however many records of
 *  one key, ONE poll loop runs — the full canonical projection covers
 *  every subscriber's field interest in one query, and the dispatcher
 *  routes per-trigger patterns downstream.
 *
 *  The manager core is source-agnostic: refcount-shaped `recompute()`
 *  (re-derive demand → arm/disarm/prune), per-key timer loops, D-124
 *  baseline suppression, snapshot hash-diff, commit-before-emit, the
 *  error cap, pause/resume. Callers hook `recompute()` to every
 *  demand-changing seam (trigger CRUD, connection enroll/delete,
 *  recipe install reconcile, maintenance exit); a live loop ALSO
 *  re-checks its own demand each tick, so a missed signal self-heals
 *  within one interval.
 *
 *  Fidelity deference (design § 2: webhook > reconciler-bus > poll) is
 *  also a source concern — a source marks a demand `deferred_to` when
 *  a higher-fidelity feed already covers it; the manager lists the key
 *  (governance sees WHY there is no poll) but never arms a loop.
 *
 *  Per tick: one gated + audited source fetch (walk-all) → hash-diff
 *  vs the persisted snapshot → emit per-record `created` / `updated` /
 *  `deleted` warehouse events (carrying `record` / `changed_fields` /
 *  `prev`) → commit the snapshot delta. Baseline suppression (D-124):
 *  the first-ever poll persists WITHOUT firing. `deleted` only on a
 *  COMPLETE walk — absence on a truncated walk proves nothing. */

import type { WarehouseEvent, WarehouseEventBus } from '@recued/warehouse-events';
import { diffChangedFields } from '@recued/warehouse-events';
import type { EventTrigger, WatchStatusEntry } from '@recued/contracts';
import {
  composeVendorEntityScope,
  WATCH_DEFAULT_POLL_INTERVAL_MS,
  WATCH_ERROR_CAP,
  WATCH_MIN_POLL_INTERVAL_MS,
} from '@recued/contracts';
import { hashRecipe } from '@recued/recipes';
import type { EventBus } from '../events/bus.js';
import { emitAutomationRule } from '../events/emit-sites.js';
import type { CanonicalPollOutcome } from './canonical-poll.js';
import type { WatchSnapshotEntry, WatchStateRow, WatchStore } from './snapshot-store.js';

/** Delay before the FIRST poll of a never-polled key (fresh demand at
 *  boot or first install) — long enough for boot to settle, short
 *  enough that the baseline lands promptly. */
export const WATCH_INITIAL_POLL_DELAY_MS = 5_000;

/** One concrete poll demand a source derived from the trigger rows.
 *  The `(vendor, entity, connection_name)` triple is the universal
 *  poll-key shape (a cli source maps profile → `vendor: 'cli'`, the mcp
 *  resource source maps server → `vendor: 'mcp-resource'`); `watch_key`
 *  is the source-composed coalescing key and MUST be globally unique
 *  in a namespace disjoint from every other source — the manager keeps
 *  the FIRST claimant on a same-recompute collision and logs the rest. */
export interface WatchPollDemand {
  watch_key: string;
  vendor: string;
  entity: string;
  connection_name: string;
  recipe_ids: string[];
  /** Source-resolved effective interval (its own subscriber-pref
   *  semantics, already floored at `floorMs`). */
  interval_ms: number;
  /** Names the higher-fidelity source covering this key, when one
   *  exists — the manager lists but never arms a deferred key. */
  deferred_to: string | null;
  /** Non-api sources override the emitted change event's three
   *  path-shaping fields (`data.<platform>.<slug>.<entity_type>.<kind>`).
   *  Absent → the connection-api convention: platform =
   *  `composeVendorEntityScope(vendor, entity)`, slug = connection_name,
   *  entity_type = entity. The mcp-resource source sets this so its
   *  events land on the dedicated `connection.mcp` family — AND so the
   *  manager never feeds a base64url-encoded `entity` to
   *  `composeVendorEntityScope` (which would throw on the non-identifier
   *  segment). `vendor` / `entity` / `connection_name` still key the
   *  watch + the snapshot store; only the bus path changes. */
  event_scope?: { platform: string; slug: string; entity_type: string };
}

/** A pluggable poll source — the WatchSource model's poll half
 *  (design § 2: "a tight reusable poll-manager with a pluggable
 *  fetch"). Owns pattern recognition, instance fan-out, deference, and
 *  the fetch; the manager owns loops, baseline, diff, emit, and
 *  governance state. */
export interface WatchPollSource {
  source_id: string;
  /** Derive concrete demands from the enabled trigger rows. Called on
   *  every recompute + every tick's self-heal check — keep it cheap
   *  (pure derivation over in-memory rows). */
  deriveDemands(
    triggers: EventTrigger[],
    opts: { floorMs: number; defaultMs: number },
  ): WatchPollDemand[];
  /** Run one poll for a demanded key. */
  poll(target: {
    vendor: string;
    entity: string;
    connection_name: string;
  }): Promise<CanonicalPollOutcome>;
}

/** A demand joined with its claiming source — the manager's index
 *  entry. */
type IndexedDemand = WatchPollDemand & { source_id: string };

interface WatchLoop {
  demand: IndexedDemand;
  timer: unknown | undefined;
  /** Loop-instance token, minted from a manager-global counter at arm
   *  time and NEVER reused — a tick that awaited across a disarm (or a
   *  disarm + re-arm) detects staleness by comparing its captured
   *  token against the CURRENT loop's. A per-loop counter would reset
   *  on re-arm and could collide with a stale capture (codex fold). */
  generation: number;
  in_flight: boolean;
  /** The in-flight tick's run promise — lets `pollNow` AWAIT a poll
   *  that is already running instead of returning before its result
   *  lands (the Run-Now rpc's "resolves once the poll lands" contract;
   *  codex MEDIUM fold). Stale after `in_flight` flips false — readers
   *  gate on `in_flight`. */
  run?: Promise<void>;
}

export interface PollManagerDeps {
  store: WatchStore;
  triggersStore: { listEnabled(): EventTrigger[] };
  /** Registered poll sources, in claim-priority order — the first
   *  source to claim a watch key on a recompute keeps it. */
  sources: WatchPollSource[];
  /** Warehouse bus the diff events emit on (the dispatcher's source). */
  bus: WarehouseEventBus;
  /** Broadcast bus — `automation_rule_changed {mechanism: 'watch'}` on
   *  pause/resume, error-cap auto-disable, and armed-set changes. */
  eventBus?: EventBus;
  /** Best-effort substrate-bug surface (cross-source key collisions).
   *  Production may wire the daemon log; tests assert through it. */
  log?: (level: 'warn', msg: string) => void;
  now?: () => number;
  setTimer?: (handler: () => void, delayMs: number) => unknown;
  clearTimer?: (token: unknown) => void;
  errorCap?: number;
  intervalFloorMs?: number;
  defaultIntervalMs?: number;
  initialPollDelayMs?: number;
  /** Vault-unlocked gate. When provided and `false`, `recompute()`
   *  disarms every loop and arms nothing (it's the single arm/disarm
   *  chokepoint — every demand-changing caller routes through it, so
   *  this one guard keeps them ALL from polling while sealed), and a
   *  racing `tick()` skips its poll. Polling must not run while the
   *  vault is locked — a poll source can't reach credentials, and a
   *  fired recipe would write cache rows the locked store can't encrypt.
   *  The coordinator calls `recompute()` on unlock to re-arm. Absent →
   *  un-gated (legacy / tests). */
  isVaultUnlocked?: () => boolean;
}

export interface PollManagerHandle {
  /** Re-derive demand → arm/disarm loops → prune orphans. Idempotent;
   *  cheap enough for every demand-changing seam. */
  recompute(): void;
  /** The merged governance list (`watch.list`). */
  listEntries(): WatchStatusEntry[];
  /** Pause / resume one key (`watch.update`). Null = unknown key. */
  setEnabled(watch_key: string, enabled: boolean): WatchStatusEntry | null;
  /** Run one key's poll immediately (tests + a future Run-Now
   *  affordance). No-op when the key has no armed loop. */
  pollNow(watch_key: string): Promise<void>;
  /** Disarm every loop and resolve once in-flight polls settle.
   *  Re-armable — a later `recompute()` re-derives demand and re-arms
   *  (the maintenance-exit rebuild posture, mirroring the dispatcher's
   *  dispose() / rebuild() pair). */
  stop(): Promise<void>;
  activeLoopCount(): number;
  inFlight(): boolean;
}

export const createWatchPollManager = (deps: PollManagerDeps): PollManagerHandle => {
  const now = deps.now ?? (() => Date.now());
  const setTimer =
    deps.setTimer ?? ((handler: () => void, delayMs: number) => setTimeout(handler, delayMs));
  const clearTimer = deps.clearTimer ?? ((token: unknown) => clearTimeout(token as NodeJS.Timeout));
  const errorCap = deps.errorCap ?? WATCH_ERROR_CAP;
  const floorMs = deps.intervalFloorMs ?? WATCH_MIN_POLL_INTERVAL_MS;
  const defaultMs = deps.defaultIntervalMs ?? WATCH_DEFAULT_POLL_INTERVAL_MS;
  const initialDelayMs = deps.initialPollDelayMs ?? WATCH_INITIAL_POLL_DELAY_MS;
  // First-wins keyed source index (codex LOW fold): a duplicate
  // source_id would otherwise derive demand through the FIRST source
  // (demand collision keeps the first claimant) but poll through the
  // LAST (Map constructor overwrites). Keep both paths on the first
  // registrant and surface the config bug.
  const sourceById = new Map<string, WatchPollSource>();
  for (const source of deps.sources) {
    if (sourceById.has(source.source_id)) {
      deps.log?.(
        'warn',
        `duplicate watch poll source id '${source.source_id}' — keeping the first registrant`,
      );
      continue;
    }
    sourceById.set(source.source_id, source);
  }

  const loops = new Map<string, WatchLoop>();
  /** Monotone loop-instance token mint — see `WatchLoop.generation`. */
  let generationCounter = 0;
  /** Last recompute's full demand (armed or not) — `listEntries` joins
   *  state rows against it for subscriber/deference columns. */
  let demandIndex = new Map<string, IndexedDemand>();
  const inFlightPolls = new Set<Promise<void>>();
  /** True between `stop()` and the next `recompute()` — blocks timer
   *  re-arming while a drain is in progress. `recompute()` clears it
   *  (the maintenance-exit rebuild re-arms a stopped manager). */
  let stopped = false;
  /** Armed/demand signature from the previous recompute — emits
   *  `automation_rule_changed` only on CHANGE, and stays silent on the
   *  boot-time first compute (null baseline). */
  let lastSignature: string | null = null;

  const reportBackgroundFailure = (watch_key: string, error: unknown): void => {
    const message = `watch '${watch_key}' background poll rejected: ${
      error instanceof Error ? error.message : String(error)
    }`;
    try {
      if (deps.log) {
        deps.log('warn', message);
      } else {
        console.warn(`[watch-poll] ${message}`);
      }
    } catch {
      // A diagnostics failure must not recreate the unhandled rejection this
      // background boundary is responsible for containing.
    }
  };

  const deriveDemand = (): Map<string, IndexedDemand> => {
    const triggers = deps.triggersStore.listEnabled();
    const out = new Map<string, IndexedDemand>();
    for (const source of sourceById.values()) {
      for (const demand of source.deriveDemands(triggers, { floorMs, defaultMs })) {
        const existing = out.get(demand.watch_key);
        if (existing !== undefined) {
          // Key collision — a substrate/config bug (sources mint keys
          // in their own namespace by contract). First claimant wins;
          // the duplicate never arms, so two loops can never poll the
          // same key.
          deps.log?.(
            'warn',
            `watch key '${demand.watch_key}' from source '${source.source_id}' already claimed by '${existing.source_id}' — duplicate skipped`,
          );
          continue;
        }
        out.set(demand.watch_key, { ...demand, source_id: source.source_id });
      }
    }
    return out;
  };

  const disarm = (watch_key: string): void => {
    const loop = loops.get(watch_key);
    if (loop === undefined) return;
    if (loop.timer !== undefined) clearTimer(loop.timer);
    loop.timer = undefined;
    loops.delete(watch_key);
  };

  const schedule = (watch_key: string, delayMs: number): void => {
    const loop = loops.get(watch_key);
    if (loop === undefined || stopped) return;
    if (loop.timer !== undefined) clearTimer(loop.timer);
    const generation = loop.generation;
    loop.timer = setTimer(() => {
      loop.timer = undefined;
      void tick(watch_key, generation).catch((error) => {
        reportBackgroundFailure(watch_key, error);
      });
    }, Math.max(0, delayMs));
  };

  /** Pure diff: snapshot delta + the events it implies. Emission is
   *  the CALLER's last step, strictly AFTER the snapshot commit —
   *  emit-then-commit would double-fire recipes when the commit fails
   *  (re-diffed next poll), violating the substrate's at-most-once
   *  trigger-delivery posture (codex HIGH fold). */
  const computeDiff = (
    demand: WatchPollDemand,
    outcome: Extract<CanonicalPollOutcome, { ok: true }>,
    snapshot: Map<string, { hash: string; record: Record<string, unknown> }>,
    baselined: boolean,
    at: number,
  ): { upserts: WatchSnapshotEntry[]; deletes: string[]; events: WarehouseEvent[] } => {
    // Path-shaping fields: a source may override all three via
    // `event_scope` (the mcp-resource source emits on `connection.mcp`,
    // NOT the connection-api scope). Absent → the founding connection-api
    // convention. Composing the api scope only on the fallback path also
    // keeps `composeVendorEntityScope` away from non-identifier `entity`
    // segments (an mcp `entity` is a base64url uri).
    const platform =
      demand.event_scope?.platform ?? composeVendorEntityScope(demand.vendor, demand.entity);
    const slug = demand.event_scope?.slug ?? demand.connection_name;
    const entity_type = demand.event_scope?.entity_type ?? demand.entity;
    const upserts: WatchSnapshotEntry[] = [];
    const deletes: string[] = [];
    const events: WarehouseEvent[] = [];

    for (const [record_id, record] of outcome.records) {
      const record_hash = hashRecipe(record);
      const existing = snapshot.get(record_id);
      if (existing === undefined) {
        upserts.push({ record_id, record_hash, record });
        if (baselined) {
          events.push({
            platform,
            slug,
            entity_type,
            event_kind: 'created',
            record_id,
            at,
            record,
          });
        }
        continue;
      }
      if (existing.hash === record_hash) continue;
      upserts.push({ record_id, record_hash, record });
      if (baselined) {
        events.push({
          platform,
          slug,
          entity_type,
          event_kind: 'updated',
          record_id,
          at,
          prev: existing.record,
          record,
          changed_fields: diffChangedFields(existing.record, record),
        });
      }
    }

    // `deleted` only on a COMPLETE walk — an absence proves nothing unless the
    // gateway PROVABLY saw the whole set. Gate on `outcome.complete`, NOT
    // `!truncated`: a non-paginating catalog (a `search_style` without
    // `pagination_style`) returns the first page with `truncated:false`, so
    // `!truncated` alone would false-`deleted` every record past page 1 (codex S2
    // review fold — the same bug the generic CRM reconciler's delete detection had).
    if (outcome.complete) {
      for (const [record_id, existing] of snapshot) {
        if (outcome.records.has(record_id)) continue;
        deletes.push(record_id);
        if (baselined) {
          events.push({
            platform,
            slug,
            entity_type,
            event_kind: 'deleted',
            record_id,
            at,
            prev: existing.record,
          });
        }
      }
    }

    return { upserts, deletes, events };
  };

  const tick = async (watch_key: string, generation: number): Promise<void> => {
    const loop = loops.get(watch_key);
    if (loop === undefined || loop.generation !== generation || stopped) return;
    if (loop.in_flight) {
      schedule(watch_key, loop.demand.interval_ms);
      return;
    }
    // Vault-locked gate (race backstop): a tick scheduled before a lock
    // skips its poll and DISARMS the loop, so the coordinator's
    // recompute() RE-CREATES it on unlock. A bare return would leave a
    // timerless loop in `loops`, which recompute()'s arm pass treats as
    // already-armed (`existing !== undefined → continue`) and never
    // re-schedules — permanently dormant. The steady-state pause is
    // recompute() disarming every loop; this catches the in-flight timer
    // that fired between the lock and that recompute.
    if (deps.isVaultUnlocked && !deps.isVaultUnlocked()) {
      disarm(watch_key);
      return;
    }

    // Demand self-heal: a tick on a key whose last subscriber left (a
    // missed recompute signal — e.g. the dispatcher's own error-cap
    // auto-disable) recomputes instead of polling. A key re-claimed by
    // a DIFFERENT source mid-flight recomputes too (fresh loop, fresh
    // attribution) rather than polling through the stale source.
    const fresh = deriveDemand().get(watch_key);
    if (fresh === undefined || fresh.deferred_to !== null || fresh.source_id !== loop.demand.source_id) {
      recompute();
      return;
    }
    loop.demand = fresh;

    const source = sourceById.get(loop.demand.source_id);
    if (source === undefined) {
      // Unreachable by construction (demands only come from registered
      // sources) — recompute rather than crash a timer tick.
      recompute();
      return;
    }

    loop.in_flight = true;
    const run = (async () => {
      const at = now();
      try {
        const outcome = await source.poll({
          vendor: loop.demand.vendor,
          entity: loop.demand.entity,
          connection_name: loop.demand.connection_name,
        });
        // Staleness re-check AFTER the await (codex HIGH fold): a
        // pause / disarm / stop that landed while the poll was in
        // flight DISCARDS the result — no emit, no commit, no error
        // bookkeeping. The user paused the watch; a recipe firing off
        // a poll that completed after the pause breaks the governance
        // promise. The next arm re-polls fresh against the kept
        // snapshot, so nothing is lost.
        //
        // R21.1 — a vault LOCK that landed mid-poll discards the result
        // the same way. Committing the snapshot here would advance past a
        // change whose event the trigger dispatcher then drops (sealed),
        // losing it forever (the next poll sees no diff). Leaving the
        // snapshot untouched lets the post-unlock poll re-detect it.
        if (
          loops.get(watch_key)?.generation !== generation ||
          (deps.isVaultUnlocked && !deps.isVaultUnlocked())
        ) {
          return;
        }
        if (outcome.ok) {
          const state = deps.store.getState(watch_key);
          const baselined = state?.baselined === true;
          const snapshot = deps.store.loadSnapshot(watch_key);
          const diff = computeDiff(loop.demand, outcome, snapshot, baselined, at);
          // Durable BEFORE visible: commit the snapshot, then emit. A
          // crash / store failure between the two LOSES events
          // (at-most-once — the substrate's documented posture) rather
          // than re-firing them on the next poll.
          deps.store.commitSnapshot(watch_key, diff);
          deps.store.recordPollSuccess(watch_key, { at, baselined: true });
          for (const event of diff.events) deps.bus.emit(event);
        } else if (outcome.kind === 'unavailable') {
          // Transient — the source had nothing to poll (e.g. the dom
          // source's bridge offline / watched tab not open). NOT a
          // failure: leave the error counter + snapshot untouched and
          // just reschedule (the `finally` re-arms), so routine client
          // absence never trips the error cap → auto-disable. The watch
          // resumes the moment the client returns.
          void outcome.reason;
        } else {
          const failures = deps.store.recordPollError(watch_key, { at, error: outcome.reason });
          if (failures >= errorCap) {
            deps.store.disable(watch_key, at);
            disarm(watch_key);
            emitAutomationRule(deps.eventBus, 'watch');
          }
        }
      } catch (err) {
        // The poll fetch reports failures as outcomes; a throw here is
        // a manager-side bug or a store error. Count it the same way —
        // a watch must never crash the process.
        const msg = err instanceof Error ? err.message : String(err);
        const failures = deps.store.recordPollError(watch_key, { at, error: msg });
        if (failures >= errorCap) {
          deps.store.disable(watch_key, at);
          disarm(watch_key);
          emitAutomationRule(deps.eventBus, 'watch');
        }
      } finally {
        loop.in_flight = false;
        if (loops.get(watch_key)?.generation === generation && !stopped) {
          if (deps.isVaultUnlocked && !deps.isVaultUnlocked()) {
            // Vault locked mid-poll: go dormant by DISARMING (not
            // re-arming) so the unlock recompute() re-creates the loop.
            // Re-arming would either leave a timerless loop recompute()
            // skips, or busy-loop a sealed poll.
            disarm(watch_key);
          } else {
            schedule(watch_key, loop.demand.interval_ms);
          }
        }
      }
    })();
    loop.run = run;
    inFlightPolls.add(run);
    const clear = (): void => {
      inFlightPolls.delete(run);
    };
    // `finally()` creates a new promise that mirrors `run`'s rejection. Since
    // nobody owns that derived promise, a double failure (poll + error-store)
    // reached the process-wide fatal rejection listener even when pollNow's
    // caller handled the original `run`. Both branches clear without creating
    // another rejected chain.
    void run.then(clear, clear);
    await run;
  };

  const signatureOf = (
    demand: Map<string, IndexedDemand>,
    armed: ReadonlySet<string>,
  ): string => {
    const parts: string[] = [];
    for (const key of [...demand.keys()].sort()) {
      const d = demand.get(key)!;
      parts.push(
        `${key}:${d.deferred_to !== null ? 'd' : armed.has(key) ? 'a' : 'p'}:${d.interval_ms}`,
      );
    }
    return parts.join('|');
  };

  const recompute = (): void => {
    // Re-arm after a stop() — the maintenance-exit rebuild calls
    // recompute() on a drained manager (dispatcher rebuild posture).
    stopped = false;
    demandIndex = deriveDemand();

    // State rows: ensure for every demanded key; prune the rest.
    const ts = now();
    for (const demand of demandIndex.values()) {
      deps.store.ensureState({
        watch_key: demand.watch_key,
        source_id: demand.source_id,
        connection_name: demand.connection_name,
        vendor: demand.vendor,
        entity: demand.entity,
        now: ts,
      });
    }
    deps.store.prune(new Set(demandIndex.keys()));

    // Vault-locked gate: with the vault sealed, disarm every loop and arm
    // nothing. recompute() is the single arm/disarm chokepoint, so this
    // one guard also neutralises every OTHER caller (trigger CRUD,
    // connection enroll, the tick self-heal) while locked. The signature
    // flips to "all paused" so the automation surface reflects it; the
    // coordinator re-runs recompute() on unlock to re-arm.
    if (deps.isVaultUnlocked && !deps.isVaultUnlocked()) {
      for (const watch_key of [...loops.keys()]) disarm(watch_key);
      const sig = signatureOf(demandIndex, new Set());
      if (lastSignature !== null && sig !== lastSignature) {
        emitAutomationRule(deps.eventBus, 'watch');
      }
      lastSignature = sig;
      return;
    }

    // Disarm loops that lost demand / got deferred / got paused / got
    // re-claimed by a different source (fresh loop re-arms below).
    for (const watch_key of [...loops.keys()]) {
      const demand = demandIndex.get(watch_key);
      const state = demand === undefined ? null : deps.store.getState(watch_key);
      if (
        demand === undefined ||
        demand.deferred_to !== null ||
        state === null ||
        !state.enabled ||
        demand.source_id !== loops.get(watch_key)!.demand.source_id
      ) {
        disarm(watch_key);
      }
    }

    // Arm newly-runnable keys.
    for (const demand of demandIndex.values()) {
      if (demand.deferred_to !== null) continue;
      const state = deps.store.getState(demand.watch_key);
      if (state === null || !state.enabled) continue;
      const existing = loops.get(demand.watch_key);
      if (existing !== undefined) {
        existing.demand = demand;
        continue;
      }
      const loop: WatchLoop = {
        demand,
        timer: undefined,
        generation: ++generationCounter,
        in_flight: false,
      };
      loops.set(demand.watch_key, loop);
      const delay =
        state.last_poll_at === null
          ? initialDelayMs
          : Math.min(
              demand.interval_ms,
              Math.max(0, state.last_poll_at + demand.interval_ms - ts),
            );
      schedule(demand.watch_key, delay);
    }

    const signature = signatureOf(demandIndex, new Set(loops.keys()));
    if (lastSignature !== null && signature !== lastSignature) {
      emitAutomationRule(deps.eventBus, 'watch');
    }
    lastSignature = signature;
  };

  const entryFor = (state: WatchStateRow): WatchStatusEntry => {
    const demand = demandIndex.get(state.watch_key);
    return {
      watch_key: state.watch_key,
      source_id: state.source_id,
      connection_name: state.connection_name,
      vendor: state.vendor,
      entity: state.entity,
      enabled: state.enabled,
      active: loops.has(state.watch_key),
      deferred_to: demand?.deferred_to ?? null,
      effective_interval_ms: demand?.interval_ms ?? defaultMs,
      subscriber_recipe_ids: demand?.recipe_ids ?? [],
      last_poll_at: state.last_poll_at,
      last_status: state.last_status,
      last_error: state.last_error,
      baselined: state.baselined,
      consecutive_failures: state.consecutive_failures,
    };
  };

  return {
    recompute,
    listEntries() {
      return deps.store
        .listStates()
        .map((state) => entryFor(state));
    },
    setEnabled(watch_key, enabled) {
      const row = deps.store.setEnabled(watch_key, enabled, now());
      if (row === null) return null;
      recompute();
      emitAutomationRule(deps.eventBus, 'watch');
      const state = deps.store.getState(watch_key);
      return state === null ? null : entryFor(state);
    },
    async pollNow(watch_key) {
      const loop = loops.get(watch_key);
      if (loop === undefined) return;
      // A poll already in flight IS the run the caller asked for —
      // await its result instead of bouncing off the tick's in-flight
      // guard (which would resolve before the poll landed and hand the
      // caller a stale entry).
      if (loop.in_flight && loop.run !== undefined) {
        await loop.run;
        return;
      }
      await tick(watch_key, loop.generation);
    },
    async stop() {
      stopped = true;
      for (const watch_key of [...loops.keys()]) disarm(watch_key);
      await Promise.allSettled([...inFlightPolls]);
    },
    activeLoopCount: () => loops.size,
    inFlight: () => inFlightPolls.size > 0,
  };
};
