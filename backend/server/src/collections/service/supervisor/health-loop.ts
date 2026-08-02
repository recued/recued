/** D-118 Phase 5 — health-check polling loop.
 *
 *  Per-instance interval poller that evaluates
 *  `health_check` via the Phase 4 checker dispatcher, writes the
 *  outcome to the state table, emits a `health_changed`
 *  `service_event` on transitions, and resets
 *  `consecutive_crashes` on the first `healthy` tick after a
 *  restart (per crash-handling flow line 627 of the spec).
 *
 *  Interval is already floored to
 *  `SERVICE_HEALTH_CHECK_INTERVAL_MS_FLOOR` by the caller assembling
 *  the `ServiceInstanceSpec`; the loop doesn't reclamp. Tests drive
 *  the loop via the injected `setTimeout` + `now` seams.
 */
import {
  SERVICE_HEALTH_CHECK_INTERVAL_MS_FLOOR,
  type ServiceAuditEvent,
  type ServiceHealthState,
} from '@recued/contracts';

import type { ServiceInstanceStateStore } from '../service-state-table.js';
import type {
  RunCheckFn,
  ServiceEventEmitter,
  ServiceInstanceSpec,
  TimerSeams,
} from './types.js';

export interface HealthLoop {
  /** Schedule the first tick. Subsequent ticks self-schedule until
   *  `stop()` is called. Re-entrant — calling `start()` on an
   *  already-running loop is a no-op. */
  start(): void;
  /** Cancel the pending tick and wait for an in-flight check + state write. */
  stop(): Promise<void>;
  /** True iff a tick is scheduled or in flight. */
  isRunning(): boolean;
}

export interface HealthLoopContext extends TimerSeams {
  stateStore: ServiceInstanceStateStore;
  runCheck: RunCheckFn;
  emitEvent: ServiceEventEmitter;
}

const emitTransition = (
  slug: string,
  from: ServiceHealthState,
  to: ServiceHealthState,
  detail: string | undefined,
  emitEvent: ServiceEventEmitter,
  now: number,
): void => {
  const evt: ServiceAuditEvent = {
    type: 'service_event',
    slug,
    binary: null,
    event_name: 'health_changed',
    argv: [from, to],
    error: detail ?? null,
    timestamp: now,
  };
  emitEvent(evt);
};

export const createHealthLoop = (
  instance: ServiceInstanceSpec,
  ctx: HealthLoopContext,
): HealthLoop => {
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;
  let stopped = false;
  const interval = Math.max(
    instance.health_check_interval_ms,
    SERVICE_HEALTH_CHECK_INTERVAL_MS_FLOOR,
  );

  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (!instance.health_check) {
      // caps.health === 'none' — caller shouldn't have scheduled
      // this loop, but we defend with a clean exit rather than a
      // crash.
      stopped = true;
      return;
    }
    try {
      const result = await ctx.runCheck(instance.health_check, instance.config);
      // stop() closes persistence admission before waiting for an active
      // provider check. The check may outlive the lifecycle step timeout, so a
      // late result must not touch state or audit after close_db.
      if (stopped) return;
      const newState: ServiceHealthState = result.passed ? 'healthy' : 'unhealthy';
      const prior = ctx.stateStore.get(instance.slug);
      const priorState: ServiceHealthState = prior?.last_health_state ?? 'unknown';
      ctx.stateStore.upsert(instance.slug, {
        last_health_at: ctx.now(),
        last_health_state: newState,
      });
      if (newState === 'healthy' && (prior?.consecutive_crashes ?? 0) > 0) {
        ctx.stateStore.upsert(instance.slug, { consecutive_crashes: 0 });
      }
      if (newState !== priorState) {
        emitTransition(
          instance.slug,
          priorState,
          newState,
          result.detail,
          ctx.emitEvent,
          ctx.now(),
        );
      }
    } catch (err) {
      if (stopped) return;
      // Check throwing is a loop-level bug, not a service fault —
      // treat as unhealthy for this tick and move on. The caller
      // sees the state flip in the state row + an audit event with
      // the error message so debugging surfaces.
      const detail = err instanceof Error ? err.message : String(err);
      const prior = ctx.stateStore.get(instance.slug);
      const priorState: ServiceHealthState = prior?.last_health_state ?? 'unknown';
      ctx.stateStore.upsert(instance.slug, {
        last_health_at: ctx.now(),
        last_health_state: 'unhealthy',
      });
      if (priorState !== 'unhealthy') {
        emitTransition(
          instance.slug,
          priorState,
          'unhealthy',
          `check threw: ${detail}`,
          ctx.emitEvent,
          ctx.now(),
        );
      }
    }
    if (!stopped) {
      timer = ctx.setTimeout(runTick, interval);
    }
  };

  const runTick = (): void => {
    timer = null;
    if (stopped || inFlight) return;
    let active: Promise<void>;
    active = tick()
      .catch((err) => {
        // `tick` already maps checker failures to unhealthy. Reaching this
        // catch means the state/audit substrate itself failed; contain the
        // timer rejection while leaving an operator-visible diagnostic.
        console.warn(`[service-health] tick failed for '${instance.slug}'`, err);
      })
      .finally(() => {
        if (inFlight === active) inFlight = null;
      });
    inFlight = active;
  };

  return {
    start(): void {
      if (timer !== null || inFlight !== null) return;
      stopped = false;
      timer = ctx.setTimeout(runTick, interval);
    },
    async stop(): Promise<void> {
      stopped = true;
      if (timer !== null) {
        ctx.clearTimeout(timer);
        timer = null;
      }
      const active = inFlight;
      if (active) await active;
    },
    isRunning(): boolean {
      return timer !== null || inFlight !== null;
    },
  };
};

/** Registry that owns a health loop per slug. Phase 8 composition
 *  wires the registry to the supervisor's start / stop lifecycle
 *  so loops come up with the service and die with it. */
export interface HealthLoopRegistry {
  add(instance: ServiceInstanceSpec): void;
  remove(slug: string): Promise<void>;
  has(slug: string): boolean;
  stopAll(): Promise<void>;
}

export const createHealthLoopRegistry = (
  ctx: HealthLoopContext,
): HealthLoopRegistry => {
  const loops = new Map<string, HealthLoop>();
  let closed = false;
  return {
    add(instance): void {
      if (closed || !instance.health_check) return;
      if (loops.has(instance.slug)) return;
      const loop = createHealthLoop(instance, ctx);
      loops.set(instance.slug, loop);
      loop.start();
    },
    async remove(slug): Promise<void> {
      const loop = loops.get(slug);
      if (!loop) return;
      loops.delete(slug);
      await loop.stop();
    },
    has(slug): boolean {
      return loops.has(slug);
    },
    async stopAll(): Promise<void> {
      // Close admission before the first await. An already-admitted RPC can
      // otherwise re-add a loop after this snapshot and leave a timer running
      // beyond the lifecycle's pause_collections step.
      closed = true;
      const active = [...loops.values()];
      loops.clear();
      await Promise.all(active.map((loop) => loop.stop()));
    },
  };
};
