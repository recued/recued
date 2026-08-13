import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { BootTraceEvent } from '../cli/boot-trace.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const binPath = join(repoRoot, 'backend/server/src/bin.ts');
const serveEntryPath = join(repoRoot, 'backend/server/src/serve-entry.ts');
const serverTsconfigPath = join(repoRoot, 'backend/server/tsconfig.json');
const moduleLoadRecorderPath = join(
  repoRoot,
  'backend/server/src/__tests__/helpers/module-load-recorder.mjs',
);

let tmp: string | undefined;

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

const makeTmp = (): string => {
  tmp = mkdtempSync(join(tmpdir(), 'recued-bin-router-'));
  return tmp;
};

const runBin = (
  args: string[],
  options: { env?: Record<string, string | undefined>; loaderTracePath?: string } = {},
) => spawnSync(
  'npx',
  [
    '--no-install',
    'tsx',
    ...(options.loaderTracePath ? ['--loader', moduleLoadRecorderPath] : []),
    binPath,
    ...args,
  ],
  {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      TSX_TSCONFIG_PATH: serverTsconfigPath,
      ...options.env,
      ...(options.loaderTracePath ? { RECUED_MODULE_LOAD_TRACE: options.loaderTracePath } : {}),
    },
    timeout: 20_000,
  },
);

const parseBootTrace = (stderr: string): BootTraceEvent[] =>
  stderr
    .split('\n')
    .filter((line) => line.startsWith('[recued boot] '))
    .map((line) => JSON.parse(line.slice('[recued boot] '.length)) as BootTraceEvent);

interface ModuleLoadEntry {
  specifier: string;
  parentURL?: string;
  url: string;
}

const readModuleLoads = (path: string): ModuleLoadEntry[] => {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ModuleLoadEntry);
};

const moduleLoadValues = (entry: ModuleLoadEntry): string[] => [
  entry.specifier,
  entry.parentURL ?? '',
  entry.url,
];

const loadedModuleMatches = (entry: ModuleLoadEntry, predicate: (value: string) => boolean): boolean =>
  moduleLoadValues(entry).some(predicate);

const seedPairHome = (dir: string): string => {
  const home = join(dir, 'home');
  const stateDir = join(home, '.recued');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, 'state.json'),
    JSON.stringify({ public_ip: { ip: '203.0.113.42', fetched_at: Date.now() } }),
    'utf8',
  );
  return home;
};

const normalizePairOutput = (stdout: string): string =>
  stdout
    .replace(/\r\n/g, '\n')
    .replace(/Pairing code: [2-9A-HJ-NP-Za-km-z]{8}\s+\(TTL\s+\d+\s+min\)/g, 'Pairing code: <code> (TTL <ttl>)')
    .replace(/\?code=[2-9A-HJ-NP-Za-km-z]{8}/g, '?code=<code>');

const seedAuditDb = (dbPath: string): void => {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_entries (key TEXT NOT NULL PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit_activities (key TEXT NOT NULL PRIMARY KEY, data TEXT NOT NULL);
    `);
    const entryInsert = db.prepare(`INSERT INTO audit_entries (key, data) VALUES (?, ?)`);
    const activityInsert = db.prepare(`INSERT INTO audit_activities (key, data) VALUES (?, ?)`);
    const entries = [
      {
        run_id: 'run-old',
        recipe_id: 'recipe-b',
        recipe_hash: 'hash-b',
        started_at: 1_700_000_000_000,
        finished_at: 1_700_000_000_120,
        duration_ms: 120,
        commit_status: 'failed',
        config_snapshot: {},
        errors: [{ code: 'boom', message: 'failed', source_step: 'step-1' }],
        trigger_url: null,
        trigger_source: 'manual',
        instance_id: 'srv-old',
      },
      {
        run_id: 'run-new',
        recipe_id: 'recipe-a',
        recipe_hash: 'hash-a',
        started_at: 1_700_000_001_000,
        finished_at: 1_700_000_001_345,
        duration_ms: 345,
        commit_status: 'succeeded',
        config_snapshot: { threshold: 3 },
        errors: [],
        trigger_url: null,
        trigger_source: 'auto_run',
        instance_id: 'srv-22223333',
      },
    ];
    const activities = [
      {
        activity_id: 'act-old',
        timestamp: 1_700_000_000_500,
        action: 'server_boot',
        target: 'server',
        detail: 'port=7717',
      },
      {
        activity_id: 'act-new',
        timestamp: 1_700_000_001_500,
        action: 'audit_export',
        target: 'audit',
        detail: 'format=json',
      },
    ];
    for (const entry of entries) {
      entryInsert.run(entry.run_id, JSON.stringify(entry));
    }
    for (const activity of activities) {
      activityInsert.run(activity.activity_id, JSON.stringify(activity));
    }
  } finally {
    db.close();
  }
};

const seedAuthDb = (dbPath: string): void => {
  const db = new Database(dbPath);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS server_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    db.prepare(`INSERT OR REPLACE INTO server_config (key, value) VALUES ('realm_token', ?)`)
      .run('realm-test');
  } finally {
    db.close();
  }
};

const cleanLlmEnv = {
  RECUED_LLM_PROVIDER: '',
  RECUED_LLM_MODEL: '',
  RECUED_LLM_API_KEY: '',
  RECUED_LLM_BASE_URL: '',
  RECUED_LLM_SLOT2_PROVIDER: '',
  RECUED_LLM_SLOT2_MODEL: '',
  RECUED_LLM_SLOT2_API_KEY: '',
  RECUED_LLM_SLOT2_BASE_URL: '',
};

const archiveKeyHex = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const forbiddenLoadedModule = (entry: ModuleLoadEntry): boolean =>
  loadedModuleMatches(entry, (value) =>
    value.includes('better-sqlite3') ||
    value.endsWith('/backend/server/src/server.ts') ||
    value.endsWith('/server.js') ||
    value.includes('/composition/bin/'),
  );

const serveRuntimeLoadedModule = (entry: ModuleLoadEntry): boolean =>
  loadedModuleMatches(entry, (value) =>
    value.endsWith('/backend/server/src/serve-entry.ts') ||
    value.endsWith('/backend/server/src/serve-entry.js') ||
    value.endsWith('/backend/server/src/server.ts') ||
    value.endsWith('/backend/server/src/server.js') ||
    value.includes('/backend/server/src/serve/') ||
    value.includes('/backend/server/src/path-listener') ||
    value.includes('/backend/server/src/listener-coordinator') ||
    value.includes('/backend/server/src/background-services'),
  );

interface ProfileBoundaryOptions {
  allowedCommands?: string[];
  allowedContexts: string[];
  allowCompositionBin?: boolean;
  allowMcpServer?: boolean;
  forbiddenLoadedValue?: (value: string, entry: ModuleLoadEntry) => boolean;
}

const profileBoundaryForbiddenLoadedModule = (
  entry: ModuleLoadEntry,
  options: ProfileBoundaryOptions,
): boolean => {
  if (serveRuntimeLoadedModule(entry)) return true;
  return loadedModuleMatches(entry, (value) => {
    if (!options.allowCompositionBin && value.includes('/backend/server/src/composition/bin/')) {
      return true;
    }
    if (!options.allowMcpServer && value.includes('/backend/server/src/mcp-server.')) {
      return true;
    }
    if (options.forbiddenLoadedValue?.(value, entry)) {
      return true;
    }

    const contextMatch = value.match(/\/backend\/server\/src\/cli-context\/([^/.]+)\.(?:ts|js)$/);
    const contextName = contextMatch?.[1];
    if (contextName && !options.allowedContexts.includes(contextName)) return true;

    const commandMatch = value.match(/\/backend\/server\/src\/commands\/([^/.]+)\.(?:ts|js)$/);
    const commandName = commandMatch?.[1];
    if (commandName && !(options.allowedCommands ?? []).includes(commandName)) {
      return true;
    }

    return false;
  });
};

const backendServerSourceValue = (value: string, source: string): boolean =>
  value.includes(`/backend/server/src/${source}.ts`) ||
  value.includes(`/backend/server/src/${source}.js`) ||
  value.includes(`/backend/server/src/${source}-`) ||
  value.includes(`/backend/server/src/${source}/`);

const contextParentValue = (entry: ModuleLoadEntry, contextName: string): string =>
  entry.parentURL?.includes(`/backend/server/src/cli-context/${contextName}.ts`) ||
    entry.parentURL?.includes(`/backend/server/src/cli-context/${contextName}.js`)
    ? entry.specifier
    : '';

const stopProcessGroup = (pid: number | undefined, signal: NodeJS.Signals): void => {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try { process.kill(pid, signal); } catch { /* already gone */ }
  }
};

const runServeUntilBanner = (dbPath: string): Promise<{
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> => new Promise((resolve) => {
  const child = spawn(
    'npx',
    [
      '--no-install',
      'tsx',
      binPath,
      'serve',
      '--db',
      dbPath,
      '--port',
      '0',
    ],
    {
      cwd: repoRoot,
      detached: true,
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: serverTsconfigPath,
        RECUED_BOOT_TRACE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let stdout = '';
  let stderr = '';
  let stopping = false;
  let timedOut = false;

  const requestStop = (): void => {
    if (stopping) return;
    stopping = true;
    stopProcessGroup(child.pid, 'SIGTERM');
  };

  // ⚠ A CEILING, NOT A DEFECT — RAISED 2026-08-10 (D-234 § 234.4 slice 2). This
  // wall bounds a FULL cold server boot under tsx: D-212 identity-key generation,
  // SQLite open + migrations, the calendar stack, the MCP transport, then the
  // listener bind. At 10s it was already marginal — the same assertion failed at
  // 10,103ms in a CLEAN-HEAD worktree run earlier that day with none of these
  // changes present, and it had been failing intermittently under full-suite
  // parallelism for longer. It also passes on a good run at the old wall, which
  // is the definition of measuring the machine rather than the code.
  //
  // ⛔ The boot itself is HEALTHY: driven directly it progresses normally through
  // every stage and binds. A wall this close to the honest cost of the work
  // measures load, and a test that reds on someone else's build is one people
  // learn to ignore. Kept generous rather than removed, so a genuinely HUNG boot
  // still fails.
  const forceStop = setTimeout(() => {
    stopProcessGroup(child.pid, 'SIGKILL');
  }, 30_000);
  forceStop.unref();

  const timeout = setTimeout(() => {
    timedOut = true;
    requestStop();
  }, 25_000);

  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
    if (stdout.includes('Recued Server') && stdout.includes('[listener] path listener bound')) {
      requestStop();
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  child.once('exit', () => {
    clearTimeout(timeout);
    clearTimeout(forceStop);
    resolve({ stdout, stderr, timedOut });
  });
});

const stdoutHasJsonRpcId = (stdout: string, id: number): boolean => {
  return stdout
    .split('\n')
    .filter(Boolean)
    .some((line) => {
      try {
        return (JSON.parse(line) as { id?: unknown }).id === id;
      } catch {
        return false;
      }
    });
};

const parseJsonRpcLines = (stdout: string): Array<Record<string, unknown>> =>
  stdout
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });

const runMcpUntilToolsList = (
  dbPath: string,
  /** D-228 — `token` appends `--token <bearer>` so a boot can carry a contract.
   *  Without it the server offers nothing (slice 6), which is its own test. */
  options: { loaderTracePath?: string; token?: string } = {},
): Promise<{
  stdout: string;
  stderr: string;
  timedOut: boolean;
  exitCode: number | null;
}> => new Promise((resolve) => {
  const child = spawn(
    'npx',
    [
      '--no-install',
      'tsx',
      ...(options.loaderTracePath ? ['--loader', moduleLoadRecorderPath] : []),
      binPath,
      '--mcp',
      '--db',
      dbPath,
      ...(options.token !== undefined ? ['--token', options.token] : []),
    ],
    {
      cwd: repoRoot,
      detached: true,
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: serverTsconfigPath,
        RECUED_BOOT_TRACE: '1',
        ...(options.loaderTracePath ? { RECUED_MODULE_LOAD_TRACE: options.loaderTracePath } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );

  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let stdinClosed = false;

  const closeStdin = (): void => {
    if (stdinClosed) return;
    stdinClosed = true;
    child.stdin.end();
  };

  // ⚠ Same ceiling, same reason as the serve harness above — the --mcp profile
  // pays the same cold-boot cost plus catalog composition.
  const forceStop = setTimeout(() => {
    stopProcessGroup(child.pid, 'SIGKILL');
  }, 30_000);
  forceStop.unref();

  const timeout = setTimeout(() => {
    timedOut = true;
    closeStdin();
    stopProcessGroup(child.pid, 'SIGTERM');
  }, 25_000);

  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
    if (stdoutHasJsonRpcId(stdout, 2)) closeStdin();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  child.once('spawn', () => {
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    })}\n`);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    })}\n`);
  });
  child.once('error', (err) => {
    stderr += err instanceof Error ? err.message : String(err);
  });
  child.once('exit', (code) => {
    clearTimeout(timeout);
    clearTimeout(forceStop);
    resolve({ stdout, stderr, timedOut, exitCode: code });
  });
});

describe('production router', () => {
  it('prints a version without opening the configured DB path', () => {
    const dir = makeTmp();
    const dbPath = join(dir, 'must-not-exist.db');

    const result = runBin(['--version', '--db', dbPath]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect(result.stderr).toBe('');
    expect(existsSync(dbPath)).toBe(false);
  });

  it('prints help without opening the configured DB path', () => {
    const dir = makeTmp();
    const dbPath = join(dir, 'must-not-exist.db');

    const result = runBin(['--help', '--db', dbPath]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('recued');
    expect(result.stdout).toContain('Daemon (background):');
    expect(existsSync(dbPath)).toBe(false);
  });

  it('traces --version as profile none with no DB-open attempt', () => {
    const result = runBin(['--version'], {
      env: { RECUED_BOOT_TRACE: '1' },
    });

    expect(result.status).toBe(0);
    const events = parseBootTrace(result.stderr);

    expect(events.length).toBeGreaterThan(0);
    expect(events[0]).toMatchObject({
      entrypoint: 'bin',
      profile: 'none',
      phase: 'trace-start',
      db_open_attempted: false,
      command: '--version',
    });
    expect(events.map((event) => event.phase)).toContain('dispatch-version');
    expect(events.every((event) => event.db_open_attempted === false)).toBe(true);
  });

  it('initializes the runtime role before cheap dispatch paths', () => {
    const result = spawnSync(
      'npx',
      [
        '--no-install',
        'tsx',
        '-e',
        [
          '(async () => {',
          `  process.argv = ['node', ${JSON.stringify(binPath)}, '--version'];`,
          `  await import(${JSON.stringify(pathToFileURL(binPath).href)});`,
          "  const { ROLE } = await import('@recued/contracts');",
          "  console.log(`role:${ROLE.current}`);",
          '})().catch((error) => {',
          '  console.error(error instanceof Error ? error.message : String(error));',
          '  process.exit(1);',
          '});',
        ].join('\n'),
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          TSX_TSCONFIG_PATH: serverTsconfigPath,
        },
        timeout: 10_000,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('role:server');
    expect(result.stderr).toBe('');
  });

  it('sets the runtime role before argv parsing', () => {
    const source = readFileSync(binPath, 'utf8');
    const roleSetIndex = source.indexOf("setRole('server');");
    const argvParseIndex = source.indexOf('const args = process.argv.slice(2);');

    expect(roleSetIndex).toBeGreaterThanOrEqual(0);
    expect(argvParseIndex).toBeGreaterThanOrEqual(0);
    expect(roleSetIndex).toBeLessThan(argvParseIndex);
  });

  it.each([
    ['--version', ['--version']],
    ['--help', ['--help']],
  ])('does not load forbidden modules for %s', (_name, args) => {
    const dir = makeTmp();
    const tracePath = join(dir, 'modules.jsonl');

    const result = runBin(args, { loaderTracePath: tracePath });
    const loaded = readModuleLoads(tracePath);

    expect(result.status).toBe(0);
    expect(loaded.length).toBeGreaterThan(0);
    expect(loaded.filter(forbiddenLoadedModule)).toEqual([]);
  });

  it('imports serve-entry without import-time boot modules', () => {
    const dir = makeTmp();
    const tracePath = join(dir, 'serve-entry-modules.jsonl');
    const result = spawnSync(
      'npx',
      [
        '--no-install',
        'tsx',
        '--loader',
        moduleLoadRecorderPath,
        '-e',
        `await import(${JSON.stringify(pathToFileURL(serveEntryPath).href)}); console.log('imported');`,
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          TSX_TSCONFIG_PATH: serverTsconfigPath,
          RECUED_MODULE_LOAD_TRACE: tracePath,
        },
        timeout: 10_000,
      },
    );

    const loaded = readModuleLoads(tracePath);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('imported');
    expect(loaded.length).toBeGreaterThan(0);
    expect(loaded.filter(forbiddenLoadedModule)).toEqual([]);
  });

  it('serve-entry owns in-process serve instead of a process delegate', () => {
    const source = readFileSync(serveEntryPath, 'utf8');

    expect(source).toContain('export async function serve');
    expect(source).not.toMatch(/node:child_process|buildServeInvocation|spawnServeProcess|ChildProcess/);
    expect(source).not.toMatch(/startMCPServer|cmdPair|cmdLLM|cmdAudit|daemonStart|cmdHelp/);
  });

  it('routes the serve profile through serve-entry and reaches foreground boot', async () => {
    const dir = makeTmp();
    const dbPath = join(dir, 'server.db');

    const result = await runServeUntilBanner(dbPath);

    expect(result.timedOut).toBe(false);
    expect(result.stdout).toContain('[listener] path listener bound');
    expect(result.stdout).toContain('Recued Server');
    expect(result.stderr).toContain('"entrypoint":"bin"');
    expect(result.stderr).toContain('"detail":"./serve-entry.js"');
  }, 20_000);

  it.each([
    ['pair', ['pair']],
    ['pair generate', ['pair', 'generate']],
  ])('routes %s through the pair profile context', (_name, pairArgs) => {
    const dir = makeTmp();
    const dbPath = join(dir, 'server.db');
    const tracePath = join(dir, `${pairArgs.join('-')}-modules.jsonl`);
    const home = seedPairHome(dir);

    const result = runBin([...pairArgs, '--db', dbPath, '--port', '8123'], {
      loaderTracePath: tracePath,
      env: {
        HOME: home,
        RECUED_SERVER_NAME: 'pair.recued.test',
      },
    });
    const loaded = readModuleLoads(tracePath);

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('unmigrated-profile');
    expect(result.stderr).not.toContain('has not migrated profile');
    expect(result.stdout).toMatch(/Pairing code: [2-9A-HJ-NP-Za-km-z]{8}/);
    expect(result.stdout).toContain('Server reachable at:');
    expect(result.stdout).toContain('https://pair.recued.test');
    expect(result.stdout).toContain('https://203.0.113.42:8123');
    expect(existsSync(dbPath)).toBe(true);
    expect(loaded.length).toBeGreaterThan(0);
    expect(loaded.filter((entry) => profileBoundaryForbiddenLoadedModule(entry, {
      allowedCommands: ['pair'],
      allowedContexts: ['pair'],
    }))).toEqual([]);
  });

  it('keeps pair generate output stable after normalizing generated codes', () => {
    const dir = makeTmp();
    const firstDbPath = join(dir, 'first.db');
    const secondDbPath = join(dir, 'second.db');
    const home = seedPairHome(dir);
    const env = {
      HOME: home,
      RECUED_SERVER_NAME: 'pair.recued.test',
    };

    const first = runBin(['pair', 'generate', '--db', firstDbPath, '--port', '8123'], { env });
    const second = runBin(['pair', 'generate', '--db', secondDbPath, '--port', '8123'], { env });

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(normalizePairOutput(second.stdout)).toBe(normalizePairOutput(first.stdout));
  }, 30_000);

  it.each([
    ['recent entries', ['audit']],
    ['activity rows', ['audit', 'activities']],
    ['run detail', ['audit', 'run-new']],
  ])('keeps audit output stable for %s', (_name, auditArgs) => {
    const dir = makeTmp();
    const firstDbPath = join(dir, 'first.db');
    const secondDbPath = join(dir, 'second.db');
    const tracePath = join(dir, `${auditArgs.join('-')}-modules.jsonl`);
    seedAuditDb(firstDbPath);
    seedAuditDb(secondDbPath);

    const first = runBin([...auditArgs, '--db', firstDbPath]);
    const second = runBin([...auditArgs, '--db', secondDbPath], { loaderTracePath: tracePath });
    const loaded = readModuleLoads(tracePath);

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(second.stderr).not.toContain('unmigrated-profile');
    expect(second.stderr).not.toContain('has not migrated profile');
    expect(second.stdout).toBe(first.stdout);
    expect(loaded.length).toBeGreaterThan(0);
    expect(loaded.filter((entry) => profileBoundaryForbiddenLoadedModule(entry, {
      allowedCommands: ['audit'],
      allowedContexts: ['audit'],
      forbiddenLoadedValue: (value) =>
        backendServerSourceValue(value, 'pairing') ||
        backendServerSourceValue(value, 'recovery-key') ||
        backendServerSourceValue(value, 'server-vault') ||
        backendServerSourceValue(value, 'key-manager'),
    }))).toEqual([]);
  }, 30_000);

  it('routes the llm profile through the LLM profile context', () => {
    const dir = makeTmp();
    const dbPath = join(dir, 'server.db');
    const tracePath = join(dir, 'llm-modules.jsonl');

    const result = runBin(['llm', '--db', dbPath], {
      env: {
        ...cleanLlmEnv,
        RECUED_BOOT_TRACE: '1',
      },
      loaderTracePath: tracePath,
    });
    const events = parseBootTrace(result.stderr);
    const loaded = readModuleLoads(tracePath);

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('unmigrated-profile');
    expect(result.stderr).not.toContain('has not migrated profile');
    expect(result.stdout).toContain('Usage: recued llm <subcommand>');
    expect(events[0]).toMatchObject({
      entrypoint: 'bin',
      profile: 'llm',
      phase: 'trace-start',
      db_open_attempted: false,
      command: 'llm',
    });
    expect(events).toContainEqual(expect.objectContaining({
      phase: 'import',
      detail: './cli-context/llm.js',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      phase: 'db-open-attempted',
      db_open_attempted: true,
    }));
    expect(existsSync(dbPath)).toBe(true);
    expect(loaded.length).toBeGreaterThan(0);
    expect(loaded.some((entry) =>
      loadedModuleMatches(entry, (value) => backendServerSourceValue(value, 'key-manager')),
    )).toBe(true);
    expect(loaded.some((entry) =>
      loadedModuleMatches(entry, (value) => backendServerSourceValue(value, 'llm-config')),
    )).toBe(true);
    expect(loaded.filter((entry) => profileBoundaryForbiddenLoadedModule(entry, {
      allowedCommands: ['llm'],
      allowedContexts: ['llm'],
      forbiddenLoadedValue: (value, loadEntry) => {
        const directContextImport = contextParentValue(loadEntry, 'llm');
        return backendServerSourceValue(value, 'server-executor') ||
          value.includes('/packages/engine/src/') ||
          value.includes('/packages/ingredients/src/') ||
          directContextImport === '@recued/engine' ||
          directContextImport.startsWith('@recued/engine/') ||
          directContextImport === '@recued/ingredients' ||
          directContextImport.startsWith('@recued/ingredients/') ||
          directContextImport === '@recued/llm' ||
          directContextImport.startsWith('@recued/llm/');
      },
    }))).toEqual([]);
  });

  it('keeps llm output stable for DB-backed no-flag subcommands', () => {
    const dir = makeTmp();
    const firstDbPath = join(dir, 'first.db');
    const secondDbPath = join(dir, 'second.db');
    const env = cleanLlmEnv;

    const firstSetBudget = runBin(['llm', 'set-budget', '50000', '--db', firstDbPath], { env });
    const secondSetBudget = runBin(['llm', 'set-budget', '50000', '--db', secondDbPath], { env });
    const firstShow = runBin(['llm', 'show', '--db', firstDbPath], { env });
    const secondShow = runBin(['llm', 'show', '--db', secondDbPath], { env });

    expect(firstSetBudget.status).toBe(0);
    expect(secondSetBudget.status).toBe(0);
    expect(secondSetBudget.stderr).not.toContain('has not migrated profile');
    expect(secondSetBudget.stdout).toBe(firstSetBudget.stdout);
    expect(firstShow.status).toBe(0);
    expect(secondShow.status).toBe(0);
    expect(secondShow.stdout).toBe(firstShow.stdout);
    expect(secondShow.stdout).toContain('"budget": 50000');
  }, 30_000);

  it('preserves llm subcommand flags inside the profile context', () => {
    const dir = makeTmp();
    const dbPath = join(dir, 'server.db');
    const env = cleanLlmEnv;

    const set = runBin([
      'llm',
      'set-slot',
      'slot_1',
      '--provider',
      'openai',
      '--model',
      'gpt-4.1-mini',
      '--api-key',
      'sk-secret-abcd1234',
      '--speed',
      'fast',
      '--supports-json',
      '--db',
      dbPath,
    ], { env });
    const show = runBin(['llm', 'show', '--db', dbPath], { env });

    expect(set.status).toBe(0);
    expect(set.stdout).toContain('slot_1 set (openai / gpt-4.1-mini, speed=fast).');
    expect(show.status).toBe(0);
    expect(show.stdout).toContain('***1234');
    expect(show.stdout).not.toContain('sk-secret-abcd1234');
    expect(show.stdout).toContain('"supports_json": true');
  }, 30_000);

  /** ⛔⛔ CONTRACT MOVED — D-228 slice 6. This asserted that a bare `--mcp` boot
   *  lists `recued_listRecipes` / `recued_dataTimeline` / `recipe.run` /
   *  `contact.search`, and that IS what shipped: a token-less stdio server
   *  advertised and dispatched the whole catalog to any local process that could
   *  reach it. An absent per-tool checklist now DENIES, so the honest end-to-end
   *  expectation for a boot with no `--token` is an EMPTY catalog plus the
   *  stderr instruction that makes it recoverable.
   *
   *  🔑 This is the most production-faithful witness on this surface — it spawns
   *  the real binary — so it is the right place to pin the refusal. Its unique
   *  subject (profile routing, module-boundary, boot phases) is untouched below.
   *
   *  ⚠ WHAT IS NO LONGER COVERED END-TO-END: the catalog COMPOSITION (legacy +
   *  registry tools merging) for a caller that DOES present a token. That needs
   *  a seeded inbound token, which needs the DB schema to exist before the child
   *  boots — two spawns. It is covered at the unit level
   *  (`d-137-trio-d-mcp-registry-wiring`, `mcp-server.test.ts`), which is NOT the
   *  same as covering it here; a wiring regression that only manifests under a
   *  real boot would now be caught by neither. */
  /** ⛔⛔ D-228 — CATALOG COMPOSITION FOR A TOKENED CALLER, end-to-end at the real
   *  binary. The sibling test below pins the token-LESS boot (empty catalog), and
   *  when slice 6 flipped that default this was the coverage it cost: nothing
   *  proved, against a live boot, that the legacy `recued_*` tools and the
   *  registry Tier-1 names still MERGE into one catalog. A wiring regression that
   *  only manifests under a real boot would have been caught by neither.
   *
   *  ⚠ TWO SPAWNS, deliberately. The token row has to exist BEFORE the child
   *  boots, and the schema has to exist before the row — so: boot once to create
   *  the db, seed a bearer into it, boot again carrying `--token`. That cost is
   *  the reason this was deferred; it is not a reason to keep deferring it. */
  it('a TOKENED --mcp boot composes the legacy + registry catalog', async () => {
    const dir = makeTmp();
    const dbPath = join(dir, 'server.db');

    // Spawn 1 — create the db + schema (and prove the token-less path first).
    const first = await runMcpUntilToolsList(dbPath);
    expect(first.timedOut).toBe(false);
    expect(existsSync(dbPath)).toBe(true);

    // Seed a bearer the second boot can present. `issueToken` accepts the
    // plaintext, so the id derivation stays the server's own.
    const BEARER = 'recued_e2e_catalog_composition_bearer';
    const GRANTED = [
      'recued_listRecipes', 'recued_dataTimeline', 'recipe.run', 'contact.search',
    ];
    {
      const { createChatInboundTokenStore } = await import('../storage/chat-inbound-token-store.js');
      const db = new Database(dbPath);
      try {
        // ⚠ NO `as never` HERE, deliberately. My first draft cast this and the
        // cast hid TWO shape errors — `concurrency_tier: 'single'` (the type is
        // `3 | 5 | 10`) and `chat_mode: { enabled: false }` (it is
        // `ConnectionMcpChatMode | null`). A malformed blob makes the store
        // revoke the row, so the token was FOUND (no stderr notice) but INACTIVE,
        // and every tool silently denied — an empty catalog that looked like a
        // catalog bug. Same lesson as the `granted_permissions` defect this
        // suite exists for: a whole-object cast silences the check that matters.
        createChatInboundTokenStore(db).issueToken({
          value: {
            label: 'e2e',
            grants: Object.fromEntries(GRANTED.map((n) => [n, true])),
            concurrency_tier: 3,
            expires_at: 0, // sentinel: never expires
            chat_mode: null,
          },
          now: Date.now(),
          bearer_plaintext: BEARER,
        });
      } finally { db.close(); }
    }

    // Spawn 2 — the same binary, now carrying a contract.
    const result = await runMcpUntilToolsList(dbPath, { token: BEARER });
    const responses = parseJsonRpcLines(result.stdout);
    const toolListResponse = responses.find((response) => response.id === 2) as
      | { result?: { tools?: Array<{ name?: string }> } }
      | undefined;
    const toolNames = toolListResponse?.result?.tools?.map((tool) => tool.name) ?? [];

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    // ⚠ The recovery notice must NOT appear — it would mean the token did not
    // resolve and this test degenerated into the token-less case with extra steps.
    expect(result.stderr).not.toContain('no token supplied');
    expect(result.stderr).not.toContain('was not recognised');

    // ⛔ THE COMPOSITION ITSELF: a LEGACY `recued_*` tool and a REGISTRY Tier-1
    // name, from the two different sources `handleToolsList` merges.
    expect(toolNames).toContain('recued_listRecipes');
    expect(toolNames).toContain('recipe.run');
    expect(toolNames).toContain('contact.search');
    // …and the checklist still FILTERS at the same time — an ungranted tool is
    // absent, so this is a composed-then-filtered catalog, not "everything".
    expect(toolNames).not.toContain('recued_saveRecipe');
  }, 60_000);

  it('routes --mcp through the MCP profile context; a token-less boot offers NOTHING', async () => {
    const dir = makeTmp();
    const dbPath = join(dir, 'server.db');
    const tracePath = join(dir, 'mcp-modules.jsonl');

    const result = await runMcpUntilToolsList(dbPath, { loaderTracePath: tracePath });
    const responses = parseJsonRpcLines(result.stdout);
    const loaded = readModuleLoads(tracePath);
    const toolListResponse = responses.find((response) => response.id === 2) as
      | { result?: { tools?: Array<{ name?: string }> } }
      | undefined;
    const toolNames = toolListResponse?.result?.tools?.map((tool) => tool.name) ?? [];

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain('unmigrated-profile');
    expect(result.stderr).not.toContain('has not migrated profile');
    expect(result.stderr).toContain('"entrypoint":"bin"');
    expect(result.stderr).toContain('"profile":"mcp"');
    expect(result.stderr).toContain('"detail":"./cli-context/mcp.js"');
    expect(result.stderr).toContain('"phase":"db-open-attempted"');
    expect(result.stderr).toContain('"phase":"vault-init-complete"');
    expect(result.stderr).toContain('"phase":"dispatch-mcp"');
    expect(responses).toContainEqual(expect.objectContaining({ id: 1 }));
    // D-228 slice 6 — no `--token` on the command line ⇒ no checklist ⇒ nothing
    // offered. The tools/list call still SUCCEEDS (this is a governed empty
    // catalog, not a transport error), which is why the assertion is on the
    // names rather than on an error envelope.
    expect(toolNames).toEqual([]);
    // …and the refusal is recoverable rather than a mystery: the CLI says what
    // to do, on stderr (stdout is the MCP protocol stream).
    expect(result.stderr).toContain('no token supplied');
    expect(result.stderr).toContain('RECUED_MCP_TOKEN');
    expect(existsSync(dbPath)).toBe(true);
    expect(loaded.length).toBeGreaterThan(0);
    expect(loaded.filter((entry) => profileBoundaryForbiddenLoadedModule(entry, {
      allowedContexts: ['mcp'],
      allowCompositionBin: true,
      allowMcpServer: true,
    }))).toEqual([]);
  }, 25_000);

  it('routes archive through the archive profile context and preserves archive flags', () => {
    const dir = makeTmp();
    const dbPath = join(dir, 'server.db');
    const archivePath = join(dir, 'snapshot.recued.archive');
    const tracePath = join(dir, 'archive-modules.jsonl');
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE seed (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO seed (id, value) VALUES ('one', 'alpha');`);
    db.close();

    const result = runBin([
      'archive',
      'export',
      archivePath,
      '--key',
      archiveKeyHex,
      '--db',
      dbPath,
    ], {
      env: { RECUED_BOOT_TRACE: '1', RECUED_RECOVERY_KEY: '' },
      loaderTracePath: tracePath,
    });
    const loaded = readModuleLoads(tracePath);

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('unmigrated-profile');
    expect(result.stderr).not.toContain('has not migrated profile');
    expect(result.stderr).toContain('"profile":"archive"');
    expect(result.stderr).toContain('"detail":"./cli-context/archive.js"');
    expect(result.stderr).toContain('"phase":"config-loaded"');
    expect(result.stderr).toContain('"phase":"db-open-attempted"');
    expect(result.stdout).toContain('archive export: wrote');
    expect(result.stdout).toContain(archivePath);
    expect(existsSync(archivePath)).toBe(true);
    expect(loaded.length).toBeGreaterThan(0);
    expect(loaded.filter((entry) => profileBoundaryForbiddenLoadedModule(entry, {
      allowedCommands: ['archive'],
      allowedContexts: ['archive'],
    }))).toEqual([]);
  }, 30_000);

  // D-178 slice 5 — the `upgrade` subcommand + its `cli-context/upgrade`
  // profile are deleted (the legacy D-108 npm self-upgrade flow is superseded
  // by the D-178 release/update substrate). No routing test remains.

  it('routes daemon status through the daemon profile context', () => {
    const dir = makeTmp();
    const dbPath = join(dir, 'server.db');
    const tracePath = join(dir, 'daemon-status-modules.jsonl');
    const home = seedPairHome(dir);
    const env = {
      HOME: home,
      RECUED_SERVER_NAME: 'daemon.recued.test',
      RECUED_BOOT_TRACE: '1',
    };

    const result = runBin(['status', '--db', dbPath, '--port', '8123'], {
      env,
      loaderTracePath: tracePath,
    });
    const loaded = readModuleLoads(tracePath);

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('unmigrated-profile');
    expect(result.stderr).not.toContain('has not migrated profile');
    expect(result.stderr).toContain('"profile":"daemon"');
    expect(result.stderr).toContain('"detail":"./cli-context/daemon.js"');
    expect(result.stdout).toContain('Status: stopped');
    expect(result.stdout).toContain('Reachable at:');
    expect(result.stdout).toContain('https://daemon.recued.test');
    expect(existsSync(dbPath)).toBe(false);
    expect(loaded.length).toBeGreaterThan(0);
    expect(loaded.filter((entry) => profileBoundaryForbiddenLoadedModule(entry, {
      allowedContexts: ['daemon'],
    }))).toEqual([]);
  }, 30_000);

  it('prints missing daemon log output without creating the DB path', () => {
    const dir = makeTmp();
    const dbPath = join(dir, 'server.db');
    const tracePath = join(dir, 'daemon-logs-modules.jsonl');

    const result = runBin(['logs', '--db', dbPath], { loaderTracePath: tracePath });
    const loaded = readModuleLoads(tracePath);
    const createdDb = existsSync(dbPath);

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('has not migrated profile');
    expect(result.stdout).toContain('No log file at');
    expect(createdDb).toBe(false);
    expect(loaded.length).toBeGreaterThan(0);
    expect(loaded.filter((entry) => profileBoundaryForbiddenLoadedModule(entry, {
      allowedCommands: ['logs'],
      allowedContexts: ['daemon'],
    }))).toEqual([]);
  });

  it('routes auth-status through the daemon profile context when the daemon is unreachable', () => {
    const dir = makeTmp();
    const dbPath = join(dir, 'server.db');
    const tracePath = join(dir, 'daemon-auth-status-modules.jsonl');
    seedAuthDb(dbPath);

    const result = runBin(['auth-status', '--db', dbPath, '--port', '1'], {
      loaderTracePath: tracePath,
    });
    const loaded = readModuleLoads(tracePath);

    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain('has not migrated profile');
    expect(result.stderr).toContain('connection_error');
    expect(loaded.length).toBeGreaterThan(0);
    expect(loaded.filter((entry) => profileBoundaryForbiddenLoadedModule(entry, {
      allowedCommands: ['auth'],
      allowedContexts: ['daemon'],
    }))).toEqual([]);
  }, 30_000);

  it('has no forbidden router static imports', () => {
    const source = readFileSync(binPath, 'utf8');
    const staticImports = source
      .split('\n')
      .filter((line) => line.startsWith('import '));

    expect(staticImports.join('\n')).not.toMatch(/better-sqlite3/);
    expect(staticImports.join('\n')).not.toMatch(/['"]\.\/server\.js['"]/);
    expect(staticImports.join('\n')).not.toMatch(/['"]\.\/composition\/bin\//);
    expect(source).not.toMatch(/import\(['"]\.\/bin\.(?:js|ts)['"]\)/);
  });

});
