// What a program the server starts for someone else may see of the server's environment.
//
// ⛔ THE IDENTITY PASSPHRASE WAS EVERY CHILD'S. `RECUED_IDENTITY_PASSPHRASE` unseals the
// server's key file, which carries the unwrap key of the encrypted database. The owner supplies
// it in the server's own environment (a systemd EnvironmentFile, a launchd entry, a container's
// environment), and every program the server started for a pack began from that environment:
// command-line tools, coding agents that can run `env` and hand the output to a model, and the
// services a pack installs, checks, invokes and runs.
//
// Each case runs a REAL child and asks it two things: can it see any `RECUED_*` variable (it
// must not; the passphrase is one, and so are the LLM keys the audit of 2026-10-09 found
// reaching every pack), and can it see an ordinary variable (it must). The second keeps the
// first honest: a child handed an empty environment would also "not see the passphrase".

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCliInvocationExecutor } from '../cli-invocation-executor.js';
import { envForOthers } from '../supervision/env-for-others.js';
import { defaultSpawnProcess } from '../collections/service/supervisor/process.js';
import { defaultSpawnWithTimeout } from '../collections/service/checkers/process.js';
import { defaultSpawnInvoke } from '../collections/service/dispatcher/spawn-invoke.js';
import { defaultSpawn as defaultInstallerSpawn } from '../collections/service/installers/process.js';

const PASSPHRASE = 'correct horse battery staple';

beforeEach(() => {
  vi.stubEnv('RECUED_IDENTITY_PASSPHRASE', PASSPHRASE);
  // Only a path, but no child needs to be told where the passphrase is kept.
  vi.stubEnv('RECUED_IDENTITY_PASSPHRASE_FILE', '/run/secrets/recued_identity_passphrase');
  vi.stubEnv('RECUED_LLM_API_KEY', 'sk-test-not-for-children');
  // OUTSIDE the namespace, deliberately: the control must be something a child keeps.
  vi.stubEnv('CHILD_ENV_CANARY', 'canary');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

/** Exit 0: sees the ordinary variable and no `RECUED_*` one. 3: one leaked.
 *  4: the ordinary variable is missing too, so the check would prove nothing. */
const ENV_CHECK = [
  process.execPath,
  '-e',
  'process.exit(Object.keys(process.env).some((k) => k.toUpperCase().startsWith("RECUED_")) ? 3'
    + ' : process.env.CHILD_ENV_CANARY === "canary" ? 0 : 4)',
];

const PRINT_ENV = 'process.stdout.write(JSON.stringify({'
  + 'recued: Object.keys(process.env).filter((k) => k.toUpperCase().startsWith("RECUED_")),'
  + 'canary: process.env.CHILD_ENV_CANARY ?? null}))';

describe('a pack command-line tool does not inherit the identity passphrase', () => {
  const run = async (binding: Record<string, unknown>, args: Record<string, unknown> = {}) => {
    const exec = createCliInvocationExecutor();
    const result = await exec({
      slug: 'envprobe',
      operation_key: 'env.probe',
      operation_id: 'recued-core/env.probe',
      args,
      timeout_ms: 10_000,
      binding: {
        kind: 'cli_invocation',
        argv_template: [process.execPath, '-e', PRINT_ENV],
        shape: 'text',
        exit_code_handling: 'zero_is_success',
        ...binding,
      },
    } as unknown as Parameters<typeof exec>[0]) as { stdout: string };
    return JSON.parse(result.stdout) as { recued: string[]; canary: string | null };
  };

  it('when the op names no folder and pins nothing (the child used to inherit outright)', async () => {
    expect(await run({})).toEqual({ recued: [], canary: 'canary' });
  });

  it('when the op runs in a folder of its own', async () => {
    expect(await run({ cwd: { arg: '{dir}' } }, { dir: process.cwd() }))
      .toEqual({ recued: [], canary: 'canary' });
  });

  it('when the op pins a variable of its own', async () => {
    expect(await run({ env: { OPENCODE_DISABLE_PROJECT_CONFIG: '1' } }))
      .toEqual({ recued: [], canary: 'canary' });
  });

  it('and the server keeps it: only the child is denied', async () => {
    // `database-encryption.ts` reads it again after boot, so removing it from the server's own
    // environment would break a passphrase-sealed install the next time it opens its database.
    await run({});
    expect(process.env.RECUED_IDENTITY_PASSPHRASE).toBe(PASSPHRASE);
  });
});

describe('a service a pack runs, checks, invokes or installs does not inherit it', () => {
  it('the supervised service process', async () => {
    const child = defaultSpawnProcess(ENV_CHECK, {});
    const code = await new Promise<number | null>((done) => { child.onExit((c) => done(c)); });
    expect(code).toBe(0);
  });

  it('the supervised service process given variables of its own', async () => {
    const child = defaultSpawnProcess(ENV_CHECK, { env: { SERVICE_OWN: '1' } });
    const code = await new Promise<number | null>((done) => { child.onExit((c) => done(c)); });
    expect(code).toBe(0);
  });

  it("the service's health check", async () => {
    expect((await defaultSpawnWithTimeout(ENV_CHECK, 10_000)).exit_code).toBe(0);
  });

  it("the service's invoke", async () => {
    expect((await defaultSpawnInvoke(ENV_CHECK, { timeout_ms: 10_000 })).exit_code).toBe(0);
  });

  it("the service's installer", async () => {
    expect((await defaultInstallerSpawn(ENV_CHECK)).exit_code).toBe(0);
  });
});

describe('every program the server starts for others goes through envForOthers', () => {
  // ⛔ THE NEXT SITE IS THE ONE THAT LEAKS. The five above were found by listing every
  // importer of `node:child_process`; a sixth would inherit the server's environment by
  // default. So the list is re-taken here: an importer either builds its child's environment
  // with `envForOthers` or is named below as starting the server itself or a system tool.
  const SERVER_SRC = resolve(__dirname, '..');
  const NOT_FOR_OTHERS: Readonly<Record<string, string>> = {
    'daemon.ts': 'the server re-launching itself in the background; it must open its key file',
    'launcher/managed-launcher.ts': 'execs the server binary on the data volume; it must open its key file',
    'update/release-config.ts': "asks the downloaded server binary for its --version",
    'mcp-stdio-spawner.ts': "passes PATH, HOME and the connection's own variables, and inherits nothing",
    'execution/resource-progress-source.ts': 'ps',
    'keys/machine-secret.ts': 'the OS keychain helpers',
    'network/read-default-route-gateway.ts': 'route',
    'supervision/process-group-kill.ts': 'taskkill',
  };
  const FOR_OTHERS = [
    'cli-invocation-executor.ts',
    'collections/service/checkers/process.ts',
    'collections/service/dispatcher/spawn-invoke.ts',
    'collections/service/installers/process.ts',
    'collections/service/supervisor/process.ts',
  ];

  const sourceFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        return ['__tests__', 'dev', 'node_modules', 'dist'].includes(entry.name) ? [] : sourceFiles(path);
      }
      return /\.[cm]?[jt]s$/.test(entry.name) && !/\.test\.[cm]?[jt]s$/.test(entry.name) && !entry.name.endsWith('.d.ts')
        ? [path] : [];
    });

  // Any way of reaching a process API: a static import, a `require`, a dynamic `import()`, and
  // worker threads, which copy the parent's environment by default.
  const STARTS_PROCESSES = /(?:from\s*|require\(\s*|import\(\s*)['"](?:node:)?(?:child_process|worker_threads)['"]/;
  // A comment that mentions `envForOthers()` is not a call to it.
  const code = (file: string): string => readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('names every importer of node:child_process', () => {
    const importers = sourceFiles(SERVER_SRC)
      .filter((file) => STARTS_PROCESSES.test(code(file)))
      .map((file) => relative(SERVER_SRC, file).split(sep).join('/'))
      .sort();
    // Not vacuous: the walk has to find the five sites it protects.
    expect(importers).toEqual(expect.arrayContaining(FOR_OTHERS));
    const unprotected = importers.filter((rel) => !(rel in NOT_FOR_OTHERS)
      && !/\benvForOthers\(/.test(code(join(SERVER_SRC, rel))));
    expect(unprotected, 'starts a program for others without envForOthers, or name it in NOT_FOR_OTHERS')
      .toEqual([]);
  });

  it('and nothing in packages/ starts a process at all', () => {
    // The engine is portable code; a spawn there would bypass every site above.
    const packagesDir = resolve(SERVER_SRC, '..', '..', '..', 'packages');
    const spawning = readdirSync(packagesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const src = join(packagesDir, entry.name, 'src');
        try { return sourceFiles(src); } catch { return []; }
      })
      .filter((file) => STARTS_PROCESSES.test(code(file)))
      .map((file) => relative(packagesDir, file).split(sep).join('/'));
    expect(spawning).toEqual([]);
  });
});

describe('envForOthers on Windows, where variable names are case-insensitive', () => {
  it('withholds a RECUED_ variable whatever case it was set in', () => {
    // On Windows `process.env` reads `recued_identity_passphrase` as the passphrase, so a child
    // would receive it under that spelling unless the comparison ignores case.
    vi.stubEnv('recued_identity_passphrase', PASSPHRASE);
    const onWindows = envForOthers(undefined, 'win32');
    expect(Object.keys(onWindows).filter((k) => /^recued_/i.test(k))).toEqual([]);
    expect(onWindows.CHILD_ENV_CANARY).toBe('canary');
    // Elsewhere names are case-sensitive: that is a different variable, and nothing reads it.
    expect(envForOthers(undefined, 'darwin').recued_identity_passphrase).toBe(PASSPHRASE);
  });

  it('withholds them even when a program sets one of its own', () => {
    expect(envForOthers({ RECUED_IDENTITY_PASSPHRASE: 'put back' }).RECUED_IDENTITY_PASSPHRASE)
      .toBeUndefined();
  });
});
