import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBackgroundServiceRegistry } from "../composition/bin/wire-background-services";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("createBackgroundServiceRegistry register + list", () => {
  it("returns an empty list for an empty registry", () => {
    const registry = createBackgroundServiceRegistry();

    expect(registry.list()).toEqual([]);
  });

  it("lists one registered service by name", () => {
    const registry = createBackgroundServiceRegistry();

    registry.register({ name: "alpha", kind: "scheduler", stop: vi.fn() });

    expect(registry.list()).toEqual(["alpha"]);
  });

  it("preserves registration order for multiple services", () => {
    const registry = createBackgroundServiceRegistry();

    registry.register({ name: "alpha", kind: "scheduler", stop: vi.fn() });
    registry.register({ name: "beta", kind: "scheduler", stop: vi.fn() });
    registry.register({ name: "gamma", kind: "scheduler", stop: vi.fn() });

    expect(registry.list()).toEqual(["alpha", "beta", "gamma"]);
  });

  it("returns a fresh list snapshot on each call", () => {
    const registry = createBackgroundServiceRegistry();

    registry.register({ name: "alpha", kind: "scheduler", stop: vi.fn() });
    const firstSnapshot = registry.list() as string[];
    firstSnapshot.push("mutated");

    expect(registry.list()).toEqual(["alpha"]);
  });
});

describe("createBackgroundServiceRegistry registerInterval basic mechanics", () => {
  it("calls setInterval once with the tick function and intervalMs", () => {
    const registry = createBackgroundServiceRegistry();
    const tick = vi.fn();
    const setIntervalSpy = vi.spyOn(global, "setInterval");

    registry.registerInterval({ name: "interval", intervalMs: 1250, tick });

    expect(setIntervalSpy).toHaveBeenCalledOnce();
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 1250);
    const registeredTick = setIntervalSpy.mock.calls[0]![0] as () => void;
    registeredTick();
    expect(tick).toHaveBeenCalledOnce();
  });

  it("calls timer.unref once when present", () => {
    const registry = createBackgroundServiceRegistry();
    const unref = vi.fn();
    const timer = { unref } as unknown as ReturnType<typeof setInterval>;
    vi.spyOn(global, "setInterval").mockReturnValue(timer);

    registry.registerInterval({ name: "interval", intervalMs: 1250, tick: vi.fn() });

    expect(unref).toHaveBeenCalledOnce();
  });

  it("tolerates timer handles without unref", () => {
    const registry = createBackgroundServiceRegistry();
    const timer = {} as ReturnType<typeof setInterval>;
    vi.spyOn(global, "setInterval").mockReturnValue(timer);

    expect(() =>
      registry.registerInterval({ name: "interval", intervalMs: 1250, tick: vi.fn() }),
    ).not.toThrow();
  });

  it("calls tick once synchronously when fireImmediate is true", () => {
    const registry = createBackgroundServiceRegistry();
    const tick = vi.fn();

    registry.registerInterval({ name: "interval", intervalMs: 1250, tick, fireImmediate: true });

    expect(tick).toHaveBeenCalledOnce();
  });

  it("does not call tick at registration when fireImmediate is false", () => {
    const registry = createBackgroundServiceRegistry();
    const tick = vi.fn();

    registry.registerInterval({ name: "interval", intervalMs: 1250, tick, fireImmediate: false });

    expect(tick).not.toHaveBeenCalled();
  });

  it("does not call tick at registration when fireImmediate is omitted", () => {
    const registry = createBackgroundServiceRegistry();
    const tick = vi.fn();

    registry.registerInterval({ name: "interval", intervalMs: 1250, tick });

    expect(tick).not.toHaveBeenCalled();
  });

  it("fires tick exactly once after advancing by intervalMs", () => {
    const registry = createBackgroundServiceRegistry();
    const tick = vi.fn();

    registry.registerInterval({ name: "interval", intervalMs: 1250, tick });
    vi.advanceTimersByTime(1250);

    expect(tick).toHaveBeenCalledOnce();
  });

  it("returns a callable stop function", () => {
    const registry = createBackgroundServiceRegistry();

    const stop = registry.registerInterval({ name: "interval", intervalMs: 1250, tick: vi.fn() });

    expect(stop).toEqual(expect.any(Function));
  });
});

describe("createBackgroundServiceRegistry stop closure behavior", () => {
  it("clears the interval and prevents later timer ticks", () => {
    const registry = createBackgroundServiceRegistry();
    const tick = vi.fn();
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");
    const stop = registry.registerInterval({ name: "interval", intervalMs: 1250, tick });

    stop();
    vi.advanceTimersByTime(1250);

    expect(clearIntervalSpy).toHaveBeenCalledOnce();
    expect(tick).not.toHaveBeenCalled();
  });

  it("invokes onStop once after clearInterval", () => {
    const registry = createBackgroundServiceRegistry();
    const onStop = vi.fn();
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");
    const stop = registry.registerInterval({
      name: "interval",
      intervalMs: 1250,
      tick: vi.fn(),
      onStop,
    });

    stop();

    expect(clearIntervalSpy).toHaveBeenCalledOnce();
    expect(onStop).toHaveBeenCalledOnce();
    expect(clearIntervalSpy.mock.invocationCallOrder[0]).toBeLessThan(
      onStop.mock.invocationCallOrder[0],
    );
  });

  it("keeps repeated stop calls idempotent", async () => {
    const registry = createBackgroundServiceRegistry();
    const onStop = vi.fn();
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");
    const stop = registry.registerInterval({
      name: "interval",
      intervalMs: 1250,
      tick: vi.fn(),
      onStop,
    });

    await Promise.all([Promise.resolve(stop()), Promise.resolve(stop())]);

    expect(clearIntervalSpy).toHaveBeenCalledOnce();
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("catches onStop errors and logs a warning", () => {
    const registry = createBackgroundServiceRegistry();
    const err = new Error("onStop failed");
    const stop = registry.registerInterval({
      name: "interval",
      intervalMs: 1250,
      tick: vi.fn(),
      onStop: () => {
        throw err;
      },
    });

    expect(() => stop()).not.toThrow();
    expect(console.warn).toHaveBeenCalledWith("[background-service] interval onStop failed", err);
  });

  it("completes normally when onStop is undefined", () => {
    const registry = createBackgroundServiceRegistry();
    const stop = registry.registerInterval({ name: "interval", intervalMs: 1250, tick: vi.fn() });

    expect(() => stop()).not.toThrow();
  });
});

describe("createBackgroundServiceRegistry stopAll fan-out + error reporting", () => {
  it("resolves without throwing for an empty registry", async () => {
    const registry = createBackgroundServiceRegistry();

    await expect(registry.stopAll()).resolves.toBeUndefined();
  });

  it("calls a single service stop once", async () => {
    const registry = createBackgroundServiceRegistry();
    const stop = vi.fn();

    registry.register({ name: "alpha", kind: "scheduler", stop });
    await registry.stopAll();

    expect(stop).toHaveBeenCalledOnce();
  });

  it("stops multiple services in reverse registration order", async () => {
    const registry = createBackgroundServiceRegistry();
    const events: string[] = [];

    registry.register({ name: "alpha", kind: "scheduler", stop: () => { events.push("alpha"); } });
    registry.register({ name: "beta", kind: "scheduler", stop: () => { events.push("beta"); } });
    registry.register({ name: "gamma", kind: "scheduler", stop: () => { events.push("gamma"); } });
    await registry.stopAll();

    expect(events).toEqual(["gamma", "beta", "alpha"]);
  });

  it("awaits async stop hooks before resolving", async () => {
    const registry = createBackgroundServiceRegistry();
    const events: string[] = [];
    let resolveStop: () => void = () => {};
    const pendingStop = new Promise<void>((resolve) => {
      resolveStop = resolve;
    });

    registry.register({
      name: "async",
      kind: "scheduler",
      stop: async () => {
        events.push("start");
        await pendingStop;
        events.push("end");
      },
    });
    const stopAllPromise = registry.stopAll().then(() => {
      events.push("settled");
    });

    expect(events).toEqual(["start"]);
    resolveStop();
    await stopAllPromise;

    expect(events).toEqual(["start", "end", "settled"]);
  });

  it("logs thrown stop errors, closes siblings, and surfaces the failure", async () => {
    const registry = createBackgroundServiceRegistry();
    const err = new Error("stop failed");
    const events: string[] = [];

    registry.register({ name: "alpha", kind: "scheduler", stop: () => { events.push("alpha"); } });
    registry.register({
      name: "broken",
      kind: "scheduler",
      stop: () => {
        events.push("broken");
        throw err;
      },
    });
    await expect(registry.stopAll()).rejects.toThrow(AggregateError);

    expect(events).toEqual(["broken", "alpha"]);
    expect(console.warn).toHaveBeenCalledWith("[background-service] broken stop failed", err);
  });

  it("continues to earlier-registered services after a mid-iteration throw", async () => {
    const registry = createBackgroundServiceRegistry();
    const events: string[] = [];

    registry.register({ name: "alpha", kind: "scheduler", stop: () => { events.push("alpha"); } });
    registry.register({
      name: "broken",
      kind: "scheduler",
      stop: () => {
        events.push("broken");
        throw new Error("stop failed");
      },
    });
    registry.register({ name: "gamma", kind: "scheduler", stop: () => { events.push("gamma"); } });
    await expect(registry.stopAll()).rejects.toThrow(AggregateError);

    expect(events).toEqual(["gamma", "broken", "alpha"]);
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it("handles mixed sync and async stop hooks", async () => {
    const registry = createBackgroundServiceRegistry();
    const events: string[] = [];

    registry.register({ name: "sync", kind: "scheduler", stop: () => { events.push("sync"); } });
    registry.register({
      name: "async",
      kind: "scheduler",
      stop: async () => {
        events.push("async:start");
        await Promise.resolve();
        events.push("async:end");
      },
    });
    await registry.stopAll();

    expect(events).toEqual(["async:start", "sync", "async:end"]);
  });
});

describe("createBackgroundServiceRegistry registerInterval integrated with stopAll", () => {
  it("awaits every started async tick before shutdown resolves", async () => {
    const registry = createBackgroundServiceRegistry();
    const releases: Array<() => void> = [];
    const tick = vi.fn(() => new Promise<void>((resolve) => {
      releases.push(resolve);
    }));
    registry.registerInterval({
      name: "async-drain",
      intervalMs: 1000,
      tick,
      fireImmediate: true,
    });
    vi.advanceTimersByTime(1000);

    let stopped = false;
    const stopping = registry.stopAll({ kind: "timer" }).then(() => {
      stopped = true;
    });
    await Promise.resolve();

    expect(tick).toHaveBeenCalledTimes(2);
    expect(stopped).toBe(false);
    releases[1]!();
    await Promise.resolve();
    expect(stopped).toBe(false);
    releases[0]!();
    await stopping;
    expect(stopped).toBe(true);
  });

  it("runs onStop only after an active async tick has drained", async () => {
    const registry = createBackgroundServiceRegistry();
    const events: string[] = [];
    let release: () => void = () => {};
    registry.registerInterval({
      name: "ordered-drain",
      intervalMs: 1000,
      fireImmediate: true,
      tick: async () => {
        events.push("tick:start");
        await new Promise<void>((resolve) => { release = resolve; });
        events.push("tick:end");
      },
      onStop: () => { events.push("onStop"); },
    });

    const stopping = registry.stopAll({ kind: "timer" });
    expect(events).toEqual(["tick:start"]);
    release();
    await stopping;

    expect(events).toEqual(["tick:start", "tick:end", "onStop"]);
  });

  it("clears all registered interval timers through stopAll", async () => {
    const registry = createBackgroundServiceRegistry();
    const firstTick = vi.fn();
    const secondTick = vi.fn();

    registry.registerInterval({ name: "first", intervalMs: 1000, tick: firstTick });
    registry.registerInterval({ name: "second", intervalMs: 1000, tick: secondTick });
    await registry.stopAll();
    vi.advanceTimersByTime(1000);

    expect(firstTick).not.toHaveBeenCalled();
    expect(secondTick).not.toHaveBeenCalled();
  });

  it("calls onStop for interval specs that define it", async () => {
    const registry = createBackgroundServiceRegistry();
    const onStop = vi.fn();

    registry.registerInterval({ name: "with-on-stop", intervalMs: 1000, tick: vi.fn(), onStop });
    registry.registerInterval({ name: "without-on-stop", intervalMs: 1000, tick: vi.fn() });
    await registry.stopAll();

    expect(onStop).toHaveBeenCalledOnce();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("stops registerInterval entries in reverse registration order", async () => {
    const registry = createBackgroundServiceRegistry();
    const firstTimer = { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
    const secondTimer = { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
    const events: string[] = [];
    vi.spyOn(global, "setInterval").mockReturnValueOnce(firstTimer).mockReturnValueOnce(secondTimer);
    vi.spyOn(global, "clearInterval").mockImplementation((timer) => {
      if (timer === secondTimer) {
        events.push("second");
      } else if (timer === firstTimer) {
        events.push("first");
      }
    });

    registry.registerInterval({ name: "first", intervalMs: 1000, tick: vi.fn() });
    registry.registerInterval({ name: "second", intervalMs: 1000, tick: vi.fn() });
    await registry.stopAll();

    expect(events).toEqual(["second", "first"]);
  });
});

describe("list with filter", () => {
  it("returns timer names in registration order from a mixed registry", () => {
    const registry = createBackgroundServiceRegistry();

    registry.register({ name: "timer-a", kind: "timer", stop: vi.fn() });
    registry.register({ name: "scheduler-a", kind: "scheduler", stop: vi.fn() });
    registry.register({ name: "timer-b", kind: "timer", stop: vi.fn() });
    registry.register({ name: "emitter-a", kind: "emitter", stop: vi.fn() });
    registry.register({ name: "timer-c", kind: "timer", stop: vi.fn() });

    expect(registry.list({ kind: "timer" })).toEqual(["timer-a", "timer-b", "timer-c"]);
  });

  it("returns scheduler names from a mixed registry", () => {
    const registry = createBackgroundServiceRegistry();

    registry.register({ name: "timer-a", kind: "timer", stop: vi.fn() });
    registry.register({ name: "scheduler-a", kind: "scheduler", stop: vi.fn() });
    registry.register({ name: "emitter-a", kind: "emitter", stop: vi.fn() });
    registry.register({ name: "scheduler-b", kind: "scheduler", stop: vi.fn() });

    expect(registry.list({ kind: "scheduler" })).toEqual(["scheduler-a", "scheduler-b"]);
  });

  it("returns emitter names from a mixed registry", () => {
    const registry = createBackgroundServiceRegistry();

    registry.register({ name: "emitter-a", kind: "emitter", stop: vi.fn() });
    registry.register({ name: "timer-a", kind: "timer", stop: vi.fn() });
    registry.register({ name: "scheduler-a", kind: "scheduler", stop: vi.fn() });
    registry.register({ name: "emitter-b", kind: "emitter", stop: vi.fn() });

    expect(registry.list({ kind: "emitter" })).toEqual(["emitter-a", "emitter-b"]);
  });

  it("returns all services when given an empty filter object", () => {
    const registry = createBackgroundServiceRegistry();

    registry.register({ name: "timer-a", kind: "timer", stop: vi.fn() });
    registry.register({ name: "scheduler-a", kind: "scheduler", stop: vi.fn() });
    registry.register({ name: "emitter-a", kind: "emitter", stop: vi.fn() });

    expect(registry.list({})).toEqual(["timer-a", "scheduler-a", "emitter-a"]);
  });

  it("returns all services when given undefined", () => {
    const registry = createBackgroundServiceRegistry();

    registry.register({ name: "scheduler-a", kind: "scheduler", stop: vi.fn() });
    registry.register({ name: "timer-a", kind: "timer", stop: vi.fn() });
    registry.register({ name: "emitter-a", kind: "emitter", stop: vi.fn() });

    expect(registry.list(undefined)).toEqual(["scheduler-a", "timer-a", "emitter-a"]);
  });
});

describe("stopAll with filter", () => {
  it("calls stop only on timer entries", async () => {
    const registry = createBackgroundServiceRegistry();
    const events: string[] = [];

    registry.register({ name: "timer-a", kind: "timer", stop: () => { events.push("timer-a"); } });
    registry.register({
      name: "scheduler-a",
      kind: "scheduler",
      stop: () => {
        events.push("scheduler-a");
      },
    });
    registry.register({ name: "timer-b", kind: "timer", stop: () => { events.push("timer-b"); } });
    registry.register({
      name: "emitter-a",
      kind: "emitter",
      stop: () => {
        events.push("emitter-a");
      },
    });
    await registry.stopAll({ kind: "timer" });

    expect(events).toEqual(["timer-b", "timer-a"]);
  });

  it("calls stop only on scheduler entries", async () => {
    const registry = createBackgroundServiceRegistry();
    const events: string[] = [];

    registry.register({ name: "timer-a", kind: "timer", stop: () => { events.push("timer-a"); } });
    registry.register({
      name: "scheduler-a",
      kind: "scheduler",
      stop: () => {
        events.push("scheduler-a");
      },
    });
    registry.register({ name: "emitter-a", kind: "emitter", stop: () => { events.push("emitter-a"); } });
    registry.register({
      name: "scheduler-b",
      kind: "scheduler",
      stop: () => {
        events.push("scheduler-b");
      },
    });
    await registry.stopAll({ kind: "scheduler" });

    expect(events).toEqual(["scheduler-b", "scheduler-a"]);
  });

  it("calls stop only on emitter entries", async () => {
    const registry = createBackgroundServiceRegistry();
    const events: string[] = [];

    registry.register({ name: "emitter-a", kind: "emitter", stop: () => { events.push("emitter-a"); } });
    registry.register({ name: "timer-a", kind: "timer", stop: () => { events.push("timer-a"); } });
    registry.register({
      name: "scheduler-a",
      kind: "scheduler",
      stop: () => {
        events.push("scheduler-a");
      },
    });
    registry.register({ name: "emitter-b", kind: "emitter", stop: () => { events.push("emitter-b"); } });
    await registry.stopAll({ kind: "emitter" });

    expect(events).toEqual(["emitter-b", "emitter-a"]);
  });

  it("stops everything when given an empty filter object", async () => {
    const registry = createBackgroundServiceRegistry();
    const events: string[] = [];

    registry.register({
      name: "scheduler-a",
      kind: "scheduler",
      stop: () => {
        events.push("scheduler-a");
      },
    });
    registry.register({ name: "timer-a", kind: "timer", stop: () => { events.push("timer-a"); } });
    registry.register({ name: "emitter-a", kind: "emitter", stop: () => { events.push("emitter-a"); } });
    await registry.stopAll({});

    expect(events).toEqual(["emitter-a", "timer-a", "scheduler-a"]);
  });

  it("stops everything when given undefined", async () => {
    const registry = createBackgroundServiceRegistry();
    const events: string[] = [];

    registry.register({ name: "timer-a", kind: "timer", stop: () => { events.push("timer-a"); } });
    registry.register({ name: "emitter-a", kind: "emitter", stop: () => { events.push("emitter-a"); } });
    registry.register({
      name: "scheduler-a",
      kind: "scheduler",
      stop: () => {
        events.push("scheduler-a");
      },
    });
    await registry.stopAll(undefined);

    expect(events).toEqual(["scheduler-a", "emitter-a", "timer-a"]);
  });

  it("preserves reverse registration order within a matched kind", async () => {
    const registry = createBackgroundServiceRegistry();
    const events: string[] = [];

    registry.register({ name: "timer-A", kind: "timer", stop: () => { events.push("timer-A"); } });
    registry.register({ name: "timer-B", kind: "timer", stop: () => { events.push("timer-B"); } });
    registry.register({
      name: "scheduler-X",
      kind: "scheduler",
      stop: () => {
        events.push("scheduler-X");
      },
    });
    registry.register({ name: "timer-C", kind: "timer", stop: () => { events.push("timer-C"); } });
    await registry.stopAll({ kind: "timer" });

    expect(events).toEqual(["timer-C", "timer-B", "timer-A"]);
  });

  it("logs matched stop errors, closes siblings, and surfaces the failure", async () => {
    const registry = createBackgroundServiceRegistry();
    const err = new Error("timer stop failed");
    const events: string[] = [];

    registry.register({
      name: "scheduler-a",
      kind: "scheduler",
      stop: () => {
        events.push("scheduler-a");
      },
    });
    registry.register({ name: "timer-alpha", kind: "timer", stop: () => { events.push("timer-alpha"); } });
    registry.register({ name: "emitter-a", kind: "emitter", stop: () => { events.push("emitter-a"); } });
    registry.register({
      name: "timer-broken",
      kind: "timer",
      stop: () => {
        events.push("timer-broken");
        throw err;
      },
    });
    registry.register({ name: "timer-gamma", kind: "timer", stop: () => { events.push("timer-gamma"); } });
    await expect(registry.stopAll({ kind: "timer" })).rejects.toThrow(AggregateError);

    expect(events).toEqual(["timer-gamma", "timer-broken", "timer-alpha"]);
    expect(console.warn).toHaveBeenCalledWith("[background-service] timer-broken stop failed", err);
  });

  it("stops registerInterval entries through the timer filter", async () => {
    const registry = createBackgroundServiceRegistry();
    const events: string[] = [];

    registry.registerInterval({
      name: "interval-timer",
      intervalMs: 1000,
      tick: vi.fn(),
      onStop: () => {
        events.push("interval-timer");
      },
    });
    registry.register({
      name: "explicit-timer",
      kind: "timer",
      stop: () => {
        events.push("explicit-timer");
      },
    });
    await registry.stopAll({ kind: "timer" });

    expect(events).toEqual(["explicit-timer", "interval-timer"]);
  });
});

describe("registerInterval kind assignment", () => {
  it("registers interval services under the timer kind", () => {
    const registry = createBackgroundServiceRegistry();

    registry.registerInterval({ name: "interval-timer", intervalMs: 1000, tick: vi.fn() });

    expect(registry.list({ kind: "timer" })).toEqual(["interval-timer"]);
    expect(registry.list({ kind: "scheduler" })).toEqual([]);
  });

  it("does not stop interval timers through the scheduler filter", async () => {
    const registry = createBackgroundServiceRegistry();
    const tick = vi.fn();
    const events: string[] = [];

    registry.registerInterval({ name: "interval-timer", intervalMs: 1000, tick });
    registry.register({
      name: "scheduler-a",
      kind: "scheduler",
      stop: () => {
        events.push("scheduler-a");
      },
    });
    await registry.stopAll({ kind: "scheduler" });
    const tickCountAfterSchedulerStop = tick.mock.calls.length;
    vi.advanceTimersByTime(1000);

    expect(events).toEqual(["scheduler-a"]);
    expect(tick).toHaveBeenCalledTimes(tickCountAfterSchedulerStop + 1);
  });
});
