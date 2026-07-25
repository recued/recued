import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

// `vi.mock` is hoisted; keep the mocked export as a `vi.fn` so the
// composer's static named import closes over an inspectable function.
const serviceMocks = vi.hoisted(() => {
  const stack = { tag: 'service-stack' };
  return {
    stack,
    composeServiceStack: vi.fn(() => stack),
  };
});

vi.mock('../collections/service/compose.js', () => ({
  composeServiceStack: serviceMocks.composeServiceStack,
}));

import type Database from 'better-sqlite3';
import type { AuditLogStore } from '@recued/storage';
import type { ManifestRegistry } from '../manifest-loader.js';
import type {
  ComposeServiceStackOptions,
  ServiceStack,
  ServiceStackRuntimeConfig,
} from '../collections/service/compose.js';
import { composeServiceStack } from '../collections/service/compose.js';
import {
  composeServiceBoot,
  type ComposeServiceStackBootDeps,
} from '../composition/bin/wire-service-stack.js';

type ComposeCall = [
  Database.Database,
  ComposeServiceStackOptions,
];

const sentinelStack = serviceMocks.stack as unknown as ServiceStack;

const resetServiceMocks = (): void => {
  vi.mocked(composeServiceStack).mockReset();
  vi.mocked(composeServiceStack).mockImplementation(() => sentinelStack);
};

resetServiceMocks();

afterEach(() => {
  try {
    vi.restoreAllMocks();
  } finally {
    resetServiceMocks();
  }
});

const db = (): Database.Database =>
  ({ tag: 'db' }) as unknown as Database.Database;

const manifests = (): ManifestRegistry =>
  ({
    slugs: vi.fn(() => []),
    get: vi.fn(() => null),
  }) as unknown as ManifestRegistry;

const runtime = (): ServiceStackRuntimeConfig => ({
  defaultQuotaBytes: 512,
  minDiskFreeBytes: 128,
  invokeSlackBytes: 64,
  duSampleIntervalS: 30,
  invokeTimeoutCeilingMs: 600_000,
  maxConcurrentInvokes: 16,
  maxConcurrentInvokesPerInstance: 4,
});

const auditLog = (): AuditLogStore =>
  ({
    logActivity: vi.fn(),
    listActivities: vi.fn(),
  }) as unknown as AuditLogStore;

const buildDeps = (
  overrides: Partial<ComposeServiceStackBootDeps> = {},
): ComposeServiceStackBootDeps => ({
  db: db(),
  dataPath: '/tmp/recued-data',
  manifests: manifests(),
  runtime: runtime(),
  baseVault: {},
  ...overrides,
});

const lastComposeCall = (): ComposeCall => {
  const call = vi.mocked(composeServiceStack).mock.calls.at(-1);
  if (!call) throw new Error('composeServiceStack was not called');
  return call as ComposeCall;
};

const lastOptions = (): ComposeServiceStackOptions => {
  const [, options] = lastComposeCall();
  return options;
};

const resolveVault = (): NonNullable<ComposeServiceStackOptions['resolveVault']> => {
  const fn = lastOptions().resolveVault;
  if (!fn) throw new Error('resolveVault was not wired');
  return fn;
};

const log = (): NonNullable<ComposeServiceStackOptions['log']> => {
  const fn = lastOptions().log;
  if (!fn) throw new Error('log was not wired');
  return fn;
};

describe('composeServiceBoot', () => {
  it('returns undefined and skips composeServiceStack when db is undefined', () => {
    const stack = composeServiceBoot(buildDeps({ db: undefined }));

    expect(stack).toBeUndefined();
    expect(composeServiceStack).not.toHaveBeenCalled();
  });

  it('returns the composeServiceStack result and passes db and options', () => {
    const deps = buildDeps();

    const stack = composeServiceBoot(deps);

    expect(stack).toBe(sentinelStack);
    expect(composeServiceStack).toHaveBeenCalledTimes(1);
    expect(vi.mocked(composeServiceStack).mock.calls[0]).toHaveLength(2);
    const [dbArg, options] = lastComposeCall();
    expect(dbArg).toBe(deps.db);
    expect(options).toEqual(expect.any(Object));
  });

  it('passes dataPath through options verbatim', () => {
    const dataPath = '/var/recued/data path';

    composeServiceBoot(buildDeps({ dataPath }));

    expect(lastOptions().dataPath).toBe(dataPath);
  });

  it('passes manifests through options by reference', () => {
    const registry = manifests();

    composeServiceBoot(buildDeps({ manifests: registry }));

    expect(lastOptions().manifests).toBe(registry);
  });

  it('passes runtime through options by reference', () => {
    const runtimeConfig = runtime();

    composeServiceBoot(buildDeps({ runtime: runtimeConfig }));

    expect(lastOptions().runtime).toBe(runtimeConfig);
  });

  it('passes a resolveVault option', () => {
    composeServiceBoot(buildDeps());

    expect(lastOptions().resolveVault).toEqual(expect.any(Function));
  });

  it('resolves publisher-scoped string vault entries from baseVault', () => {
    composeServiceBoot(buildDeps({
      baseVault: {
        'pub1.key1': 'secret-value',
        'pub2.key1': 'other-secret',
      },
    }));

    expect(resolveVault()('pub1', 'key1')).toBe('secret-value');
  });

  it('returns undefined when the publisher-scoped vault entry is missing', () => {
    composeServiceBoot(buildDeps({
      baseVault: {
        'pub1.key1': 'secret-value',
      },
    }));

    expect(resolveVault()('pub1', 'missing')).toBeUndefined();
  });

  it('returns undefined when the publisher-scoped vault entry is a number', () => {
    composeServiceBoot(buildDeps({
      baseVault: {
        'pub1.numeric': 123,
      },
    }));

    expect(resolveVault()('pub1', 'numeric')).toBeUndefined();
  });

  it('returns undefined when the publisher-scoped vault entry is an object', () => {
    composeServiceBoot(buildDeps({
      baseVault: {
        'pub1.object': { token: 'secret-value' },
      },
    }));

    expect(resolveVault()('pub1', 'object')).toBeUndefined();
  });

  it('returns undefined when the publisher-scoped vault entry is null', () => {
    composeServiceBoot(buildDeps({
      baseVault: {
        'pub1.nullish': null,
      },
    }));

    expect(resolveVault()('pub1', 'nullish')).toBeUndefined();
  });

  it('omits auditLog from options when auditLog is not passed', () => {
    composeServiceBoot(buildDeps());

    expect(Object.hasOwn(lastOptions(), 'auditLog')).toBe(false);
  });

  it('threads auditLog through options when auditLog is passed', () => {
    const store = auditLog();

    composeServiceBoot(buildDeps({ auditLog: store }));

    expect(lastOptions().auditLog).toBe(store);
  });

  it('passes a log option', () => {
    composeServiceBoot(buildDeps());

    expect(lastOptions().log).toEqual(expect.any(Function));
  });

  it('routes error logs to console.error with a service-stack prefix', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    composeServiceBoot(buildDeps());
    log()('error', 'boom', { x: 1 });

    expect(errorSpy).toHaveBeenCalledWith('[service-stack] boom', { x: 1 });
  });

  it('routes info logs to console.log and defaults missing data to an empty string', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    composeServiceBoot(buildDeps());
    log()('info', 'hi', undefined);

    expect(logSpy).toHaveBeenCalledWith('[service-stack] hi', '');
  });
});
