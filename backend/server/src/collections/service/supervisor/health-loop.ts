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
  /** Cancel the pending tick (if any). In-flight ticks finish. */
  stop(): void;
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
  let inFlight = false;
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
    inFlight = true;
    try {
      const result = await ctx.runCheck(instance.health_check, instance.config);
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
    } finally {
      inFlight = false;
    }
    if (!stopped) {
      timer = ctx.setTimeout(() => { void tick(); }, interval);
    }
  };

  return {
    start(): void {
      if (timer !== null || inFlight) return;
      stopped = false;
      timer = ctx.setTimeout(() => { void tick(); }, interval);
    },
    stop(): void {
      stopped = true;
      if (timer !== null) {
        ctx.clearTimeout(timer);
        timer = null;
      }
    },
    isRunning(): boolean {
      return timer !== null || inFlight;
    },
  };
};

/** Registry that owns a health loop per slug. Phase 8 composition
 *  wires the registry to the supervisor's start / stop lifecycle
 *  so loops come up with the service and die with it. */
export interface HealthLoopRegistry {
  add(instance: ServiceInstanceSpec): void;
  remove(slug: string): void;
  has(slug: string): boolean;
  stopAll(): void;
}

export const createHealthLoopRegistry = (
  ctx: HealthLoopContext,
): HealthLoopRegistry => {
  const loops = new Map<string, HealthLoop>();
  return {
    add(instance): void {
      if (!instance.health_check) return;
      if (loops.has(instance.slug)) return;
      const loop = createHealthLoop(instance, ctx);
      loops.set(instance.slug, loop);
      loop.start();
    },
    remove(slug): void {
      const loop = loops.get(slug);
      if (!loop) return;
      loop.stop();
      loops.delete(slug);
    },
    has(slug): boolean {
      return loops.has(slug);
    },
    stopAll(): void {
      for (const loop of loops.values()) loop.stop();
      loops.clear();
    },
  };
};
