import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  createSignalListener,
  type SignalListener,
  type SignalListenerDeps,
} from '../lifecycle/signal-listener.js';

// Build a fake process object that mimics the parts of
// NodeJS.Process the listener uses.
class FakeProcess extends EventEmitter {
  emitSignal(signal: string, ...args: unknown[]): void {
    this.emit(signal, ...args);
  }
  // Node 22's Process.on / .off are compatible with EventEmitter's —
  // the listener only needs the emitter surface.
}

interface Harness {
  proc: FakeProcess;
  listener: SignalListener;
  events: string[];
  exits: number[];
  onShutdown: SignalListenerDeps['onShutdown'];
  onReload: SignalListenerDeps['onReload'];
  onDumpSnapshot: SignalListenerDeps['onDumpSnapshot'];
  onUncaughtException: SignalListenerDeps['onUncaughtException'];
  resolveShutdown?: () => void;
}

const newHarness = (overrides: Partial<SignalListenerDeps> = {}): Harness => {
  const proc = new FakeProcess();
  const events: string[] = [];
  const exits: number[] = [];
  const h: Harness = {
    proc,
    listener: undefined as never,
    events,
    exits,
    onShutdown: async (reason) => {
      events.push(`shutdown:${reason}`);
    },
    onReload: async (reason) => {
      events.push(`reload:${reason}`);
    },
    onDumpSnapshot: () => {
      events.push('dump');
    },
    onUncaughtException: async (err, origin) => {
      events.push(`fatal:${origin}:${err.message}`);
    },
  };
  h.listener = createSignalListener({
    onShutdown: 'onShutdown' in overrides ? overrides.onShutdown! : h.onShutdown,
    onReload: 'onReload' in overrides ? overrides.onReload : h.onReload,
    onDumpSnapshot: 'onDumpSnapshot' in overrides ? overrides.onDumpSnapshot : h.onDumpSnapshot,
    onUncaughtException: 'onUncaughtException' in overrides
      ? overrides.onUncaughtException!
      : h.onUncaughtException,
    log: () => { /* silent */ },
    exit: (code) => { exits.push(code); },
    processRef: proc as unknown as NodeJS.Process,
  });
  return h;
};

describe('SignalListener.install', () => {
  let h: Harness;

  beforeEach(() => { h = newHarness(); });
  afterEach(() => { h.listener.uninstall(); });

  it('is false before install, true after', () => {
    expect(h.listener.installed).toBe(false);
    h.listener.install();
    expect(h.listener.installed).toBe(true);
  });

  it('is a no-op when called twice', () => {
    h.listener.install();
    const listenersBefore = h.proc.listenerCount('SIGTERM');
    h.listener.install();
    expect(h.proc.listenerCount('SIGTERM')).toBe(listenersBefore);
  });

  it('uninstall removes every handler it added', () => {
    h.listener.install();
    const events = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGUSR1', 'uncaughtException', 'unhandledRejection'];
    for (const e of events) expect(h.proc.listenerCount(e)).toBeGreaterThan(0);
    h.listener.uninstall();
    for (const e of events) expect(h.proc.listenerCount(e)).toBe(0);
    expect(h.listener.installed).toBe(false);
  });

  it('uninstall is a no-op when not installed', () => {
    expect(() => h.listener.uninstall()).not.toThrow();
  });
});

describe('SIGTERM / SIGINT → shutdown', () => {
  let h: Harness;

  beforeEach(() => { h = newHarness(); h.listener.install(); });
  afterEach(() => { h.listener.uninstall(); });

  it('invokes onShutdown with SIGTERM reason', async () => {
    h.proc.emitSignal('SIGTERM');
    await new Promise((r) => setImmediate(r));
    expect(h.events).toEqual(['shutdown:SIGTERM']);
  });

  it('invokes onShutdown with SIGINT reason', async () => {
    h.proc.emitSignal('SIGINT');
    await new Promise((r) => setImmediate(r));
    expect(h.events).toEqual(['shutdown:SIGINT']);
  });

  it('does NOT exit on shutdown signal (supervisor handoff does that)', async () => {
    h.proc.emitSignal('SIGTERM');
    await new Promise((r) => setImmediate(r));
    expect(h.exits).toEqual([]);
  });

  it('swallows shutdown callback rejection', async () => {
    h = newHarness({
      onShutdown: async () => { throw new Error('boom'); },
    });
    h.listener.install();
    h.proc.emitSignal('SIGTERM');
    // No throw up the tree; test passes if this line runs.
    await new Promise((r) => setImmediate(r));
    expect(true).toBe(true);
  });
});

describe('SIGHUP → reload', () => {
  let h: Harness;

  beforeEach(() => { h = newHarness(); h.listener.install(); });
  afterEach(() => { h.listener.uninstall(); });

  it('invokes onReload with SIGHUP reason', async () => {
    h.proc.emitSignal('SIGHUP');
    await new Promise((r) => setImmediate(r));
    expect(h.events).toEqual(['reload:SIGHUP']);
  });

  it('is a logged no-op when onReload is not provided', async () => {
    h = newHarness({ onReload: undefined });
    h.listener.install();
    h.proc.emitSignal('SIGHUP');
    await new Promise((r) => setImmediate(r));
    expect(h.events).toEqual([]);
  });
});

describe('SIGUSR1 → dump snapshot', () => {
  let h: Harness;

  beforeEach(() => { h = newHarness(); h.listener.install(); });
  afterEach(() => { h.listener.uninstall(); });

  it('invokes onDumpSnapshot synchronously', () => {
    h.proc.emitSignal('SIGUSR1');
    expect(h.events).toEqual(['dump']);
  });

  it('catches thrown exceptions from onDumpSnapshot', () => {
    h = newHarness({
      onDumpSnapshot: () => { throw new Error('boom'); },
    });
    h.listener.install();
    expect(() => h.proc.emitSignal('SIGUSR1')).not.toThrow();
  });
});

describe('uncaughtException / unhandledRejection → fatal', () => {
  let h: Harness;

  beforeEach(() => { h = newHarness(); h.listener.install(); });
  afterEach(() => { h.listener.uninstall(); });

  it('invokes onUncaughtException and then exits 1', async () => {
    h.proc.emitSignal('uncaughtException', new Error('boom'), 'uncaughtException');
    // The listener awaits the callback before exit; give it a tick.
    await new Promise((r) => setImmediate(r));
    expect(h.events).toEqual(['fatal:uncaughtException:boom']);
    expect(h.exits).toEqual([1]);
  });

  it('wraps non-Error rejections into Error objects', async () => {
    h.proc.emitSignal('unhandledRejection', 'string rejection');
    await new Promise((r) => setImmediate(r));
    expect(h.events[0]).toContain('fatal:unhandledRejection:unhandledRejection: string rejection');
    expect(h.exits).toEqual([1]);
  });

  it('handles Error rejections directly', async () => {
    h.proc.emitSignal('unhandledRejection', new Error('real error'));
    await new Promise((r) => setImmediate(r));
    expect(h.events).toEqual(['fatal:unhandledRejection:real error']);
    expect(h.exits).toEqual([1]);
  });

  it('exits 1 even when onUncaughtException itself rejects', async () => {
    h = newHarness({
      onUncaughtException: async () => { throw new Error('callback boom'); },
    });
    h.listener.install();
    h.proc.emitSignal('uncaughtException', new Error('original'), 'uncaughtException');
    await new Promise((r) => setImmediate(r));
    expect(h.exits).toEqual([1]);
  });
});
