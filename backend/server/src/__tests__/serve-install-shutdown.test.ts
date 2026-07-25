import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  installShutdown,
  type InstallShutdownOptions,
  type ShutdownProcess,
} from '../serve/install-shutdown.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const installShutdownPath = join(
  repoRoot,
  'backend/server/src/serve/install-shutdown.ts',
);
const startPostHousekeepingTailPath = join(
  repoRoot,
  'backend/server/src/serve/start-post-housekeeping-tail.ts',
);
const startPostListenerRuntimePath = join(
  repoRoot,
  'backend/server/src/serve/start-post-listener-runtime.ts',
);
const startListenerExposureRuntimePath = join(
  repoRoot,
  'backend/server/src/serve/start-listener-exposure-runtime.ts',
);

const makeProcessHandle = (): {
  processHandle: ShutdownProcess;
  listeners: Map<string, () => void>;
  exit: ReturnType<typeof vi.fn>;
} => {
  const listeners = new Map<string, () => void>();
  const exit = vi.fn();
  return {
    listeners,
    exit,
    processHandle: {
      on: vi.fn((signal: 'SIGINT' | 'SIGTERM', listener: () => void) => {
        listeners.set(signal, listener);
      }),
      exit,
    },
  };
};

const makeOptions = (
  overrides: Partial<InstallShutdownOptions> = {},
): InstallShutdownOptions => {
  const { processHandle } = makeProcessHandle();
  return {
    lifecycle: undefined,
    backgroundServices: { stopAll: vi.fn(async () => undefined) },
    fileStack: undefined,
    calendarStack: undefined,
    serviceStack: undefined,
    cascade: undefined,
    server: { close: vi.fn(async () => undefined) },
    db: undefined,
    processHandle,
    log: vi.fn(),
    ...overrides,
  };
};

describe('installShutdown', () => {
  it('installs and marks the lifecycle booted when lifecycle is present', () => {
    const { processHandle } = makeProcessHandle();
    const lifecycle = {
      install: vi.fn(),
      markBooted: vi.fn(),
    };
    const stopAll = vi.fn(async () => undefined);

    const result = installShutdown(makeOptions({
      lifecycle,
      backgroundServices: { stopAll },
      processHandle,
    }));

    expect(result.fallbackShutdown).toBeUndefined();
    expect(lifecycle.install).toHaveBeenCalledTimes(1);
    expect(lifecycle.markBooted).toHaveBeenCalledTimes(1);
    expect(processHandle.on).not.toHaveBeenCalled();
    expect(stopAll).not.toHaveBeenCalled();
  });

  it('registers fallback signal handlers and preserves shutdown order', async () => {
    const order: string[] = [];
    const processHarness = makeProcessHandle();
    const result = installShutdown(makeOptions({
      backgroundServices: {
        stopAll: vi.fn(async () => { order.push('stopAll'); }),
      },
      fileStack: {
        disposeAll: vi.fn(async () => { order.push('file'); }),
      },
      calendarStack: {
        disposeAll: vi.fn(async () => { order.push('calendar'); }),
      },
      serviceStack: {
        disposeAll: vi.fn(async () => { order.push('service'); }),
      },
      cascade: {
        close: vi.fn(() => { order.push('cascade'); }),
      },
      server: {
        close: vi.fn(async () => { order.push('server'); }),
      },
      db: {
        close: vi.fn(() => { order.push('db'); }),
      },
      processHandle: {
        on: vi.fn((signal: 'SIGINT' | 'SIGTERM', listener: () => void) => {
          processHarness.listeners.set(signal, listener);
        }),
        exit: vi.fn((code?: number) => { order.push(`exit:${code}`); }),
      },
      log: vi.fn((message?: unknown) => {
        order.push(String(message).trim());
      }),
    }));

    expect(processHarness.listeners.has('SIGINT')).toBe(true);
    expect(processHarness.listeners.has('SIGTERM')).toBe(true);

    await result.fallbackShutdown?.();

    expect(order).toEqual([
      'Shutting down...',
      'stopAll',
      'file',
      'calendar',
      'service',
      'cascade',
      'server',
      'db',
      'Bye.',
      'exit:0',
    ]);
  });

  it('continues fallback shutdown through best-effort dispose failures', async () => {
    const exit = vi.fn();
    const dbClose = vi.fn();
    const result = installShutdown(makeOptions({
      backgroundServices: {
        stopAll: vi.fn(async () => undefined),
      },
      fileStack: {
        disposeAll: vi.fn(async () => {
          throw new Error('file dispose failed');
        }),
      },
      calendarStack: {
        disposeAll: vi.fn(async () => {
          throw new Error('calendar dispose failed');
        }),
      },
      serviceStack: {
        disposeAll: vi.fn(async () => {
          throw new Error('service dispose failed');
        }),
      },
      server: {
        close: vi.fn(async () => {
          throw new Error('server close failed');
        }),
      },
      db: { close: dbClose },
      processHandle: {
        on: vi.fn(),
        exit,
      },
    }));

    await result.fallbackShutdown?.();

    expect(dbClose).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });
});

describe('install-shutdown source boundary', () => {
  it('keeps post-banner shutdown installation behind the post-housekeeping tail', () => {
    const bridgeSource = readFileSync(startListenerExposureRuntimePath, 'utf8');
    const runtimeSource = readFileSync(startPostListenerRuntimePath, 'utf8');
    const tailSource = readFileSync(startPostHousekeepingTailPath, 'utf8');

    expect(bridgeSource).toMatch(/start-post-listener-runtime\.js/);
    expect(runtimeSource).toMatch(/start-post-housekeeping-tail\.js/);
    expect(tailSource).toMatch(/install-shutdown\.js/);
    // D-178 slice 4b (63d229697) split this: the tail now binds the handle,
    // fires the boot reconcile, then returns it. The boundary this guards —
    // the tail OWNS shutdown installation — is unchanged.
    expect(tailSource).toMatch(/const shutdown = installShutdown\(\{/);
    expect(tailSource).toMatch(/return shutdown;/);
  });

  it('keeps shutdown ownership out of unrelated serve phases', () => {
    const source = readFileSync(installShutdownPath, 'utf8');

    expect(source).toMatch(/lifecycle\.install\(\)/);
    expect(source).toMatch(/lifecycle\.markBooted\(\)/);
    expect(source).toMatch(/backgroundServices\.stopAll\(\)/);
    expect(source).toMatch(/processHandle\.on\(['"]SIGINT['"]/);
    expect(source).toMatch(/processHandle\.on\(['"]SIGTERM['"]/);
    expect(source).toMatch(/processHandle\.exit\(0\)/);
    expect(source).not.toMatch(/composeSchedulers|composeHousekeepingScheduler/);
    expect(source).not.toMatch(/createServerHandlerSet|createProductionPathListenerCoordinator/);
    expect(source).not.toMatch(/composeRetentionPruners|composeDdnsUpdatePoller/);
    expect(source).not.toMatch(/bootTrace|createLifecycle|LockHeldError/);
  });
});
