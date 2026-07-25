import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

// `vi.mock` is hoisted; keep the mocked export as a `vi.fn` so the
// composer's static named import closes over an inspectable function.
const fileMocks = vi.hoisted(() => {
  const stack = { tag: 'file-stack' };
  return {
    stack,
    composeFileStack: vi.fn(() => stack),
  };
});

vi.mock('../collections/file/compose.js', () => ({
  composeFileStack: fileMocks.composeFileStack,
}));

import type Database from 'better-sqlite3';
import type {
  ComposeFileStackOptions,
  FileStack,
} from '../collections/file/compose.js';
import { composeFileStack } from '../collections/file/compose.js';
import {
  composeFileBoot,
  type ComposeFileStackBootDeps,
} from '../composition/bin/wire-file-stack.js';

type ComposeCall = [
  Database.Database,
  ComposeFileStackOptions,
];

const sentinelStack = fileMocks.stack as unknown as FileStack;

const resetFileMocks = (): void => {
  vi.mocked(composeFileStack).mockReset();
  vi.mocked(composeFileStack).mockImplementation(() => sentinelStack);
};

resetFileMocks();

afterEach(() => {
  try {
    vi.restoreAllMocks();
  } finally {
    resetFileMocks();
  }
});

const db = (): Database.Database =>
  ({ tag: 'db' }) as unknown as Database.Database;

const buildDeps = (
  overrides: Partial<ComposeFileStackBootDeps> = {},
): ComposeFileStackBootDeps => ({
  db: db(),
  ...overrides,
});

const lastComposeCall = (): ComposeCall => {
  const call = vi.mocked(composeFileStack).mock.calls.at(-1);
  if (!call) throw new Error('composeFileStack was not called');
  return call as unknown as ComposeCall;
};

const lastOptions = (): ComposeFileStackOptions => {
  const [, options] = lastComposeCall();
  return options;
};

const log = (): NonNullable<ComposeFileStackOptions['log']> => {
  const fn = lastOptions().log;
  if (!fn) throw new Error('log was not wired');
  return fn;
};

describe('composeFileBoot', () => {
  it('returns undefined and skips composeFileStack when db is undefined', () => {
    const stack = composeFileBoot(buildDeps({ db: undefined }));

    expect(stack).toBeUndefined();
    expect(composeFileStack).not.toHaveBeenCalled();
  });

  it('returns the composeFileStack result and passes db and options', () => {
    const deps = buildDeps();

    const stack = composeFileBoot(deps);

    expect(stack).toBe(sentinelStack);
    expect(composeFileStack).toHaveBeenCalledTimes(1);
    expect(vi.mocked(composeFileStack).mock.calls[0]).toHaveLength(2);
    const [dbArg, options] = lastComposeCall();
    expect(dbArg).toBe(deps.db);
    expect(options).toEqual(expect.any(Object));
  });

  it('passes a log option', () => {
    composeFileBoot(buildDeps());

    expect(lastOptions().log).toEqual(expect.any(Function));
  });

  it('routes error logs to console.error with a file-stack prefix', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    composeFileBoot(buildDeps());
    log()('error', 'boom', { x: 1 });

    expect(errorSpy).toHaveBeenCalledWith('[file-stack] boom', { x: 1 });
  });

  it('routes info logs to console.log and defaults missing data to an empty string', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    composeFileBoot(buildDeps());
    log()('info', 'hi', undefined);

    expect(logSpy).toHaveBeenCalledWith('[file-stack] hi', '');
  });

  it('routes warn logs to console.log without calling console.error', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    composeFileBoot(buildDeps());
    log()('warn', 'caution', { detail: 'x' });

    expect(logSpy).toHaveBeenCalledWith('[file-stack] caution', { detail: 'x' });
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
