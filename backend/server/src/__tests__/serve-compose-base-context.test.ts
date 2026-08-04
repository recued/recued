import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import type { BootTraceEvent } from '../cli/boot-trace.js';
import { composeBaseContext } from '../serve/compose-base-context.js';
import {
  prepareServerBundleSwap,
  reconcileServerBundleSwap,
} from '../archive/server-bundle-swap.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const baseContextPath = join(repoRoot, 'backend/server/src/serve/compose-base-context.ts');

let tmp: string | undefined;

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

const makeTmp = (): string => {
  tmp = mkdtempSync(join(tmpdir(), 'recued-serve-base-'));
  return tmp;
};

const parseTraceLines = (lines: string[]): BootTraceEvent[] =>
  lines.map((line) => JSON.parse(line.slice('[recued boot] '.length)) as BootTraceEvent);

describe('composeBaseContext', () => {
  it('parses serve args and loads runtime config before DB setup', () => {
    const dir = makeTmp();
    const configPath = join(dir, 'config.toml');
    const dbPath = join(dir, 'server.db');
    const args = ['--config', configPath, '--db', dbPath, '--port', '4567'];
    const traceLines: string[] = [];
    writeFileSync(configPath, `
[runtime]
"vault.quota.per_publisher_bytes" = 1234
"vault.quota.total_bytes" = 5678
public_port = 8443
`);

    const context = composeBaseContext(args, {
      env: {
        HOME: dir,
        RECUED_BOOT_TRACE: '1',
      },
      now: () => 1000,
      traceSink: (line) => traceLines.push(line),
    });

    expect(context.args).toBe(args);
    expect(context.positionals).toEqual([]);
    expect(context.subcommand).toBeUndefined();
    expect(context.bootProfile).toBe('serve');
    expect(context.dbPath).toBe(dbPath);
    expect(context.port).toBe(4567);
    expect(context.distribution).toBe('source');
    expect(context.loadedConfig.source).toBe(configPath);
    expect(context.runtimeConfig.get('vault.quota.per_publisher_bytes')).toBe(1234);
    expect(context.runtimeConfig.get('vault.quota.total_bytes')).toBe(5678);
    expect(context.runtimeConfig.get('public_port')).toBe(8443);
    expect(context.vaultQuotas).toEqual({
      perPublisherBytes: 1234,
      totalBytes: 5678,
    });
    expect(existsSync(dbPath)).toBe(false);

    const events = parseTraceLines(traceLines);
    expect(events.map((event) => event.phase)).toEqual([
      'trace-start',
      'cli-parsed',
      'config-loaded',
    ]);
    expect(events.every((event) => event.entrypoint === 'serve-entry')).toBe(true);
    expect(events.every((event) => event.profile === 'serve')).toBe(true);
    expect(events.every((event) => event.db_open_attempted === false)).toBe(true);
    expect(events.at(-1)?.detail).toBe('file');
  });

  it('uses config.toml bind_port as the effective serve port', () => {
    const dir = makeTmp();
    const configPath = join(dir, 'config.toml');
    writeFileSync(configPath, `
[bootstrap]
bind_port = 8080

[runtime]
"vault.quota.per_publisher_bytes" = 1234
"vault.quota.total_bytes" = 5678
`);

    const context = composeBaseContext(['--config', configPath], {
      env: { HOME: dir },
    });

    expect(context.port).toBe(8080);
    expect(context.loadedConfig.bootstrap.bind_port).toBe(8080);
  });

  it('uses PORT as the effective serve port without writing it back to loaded config', () => {
    const dir = makeTmp();
    const configPath = join(dir, 'config.toml');
    writeFileSync(configPath, `
[bootstrap]
bind_port = 8080

[runtime]
"vault.quota.per_publisher_bytes" = 1234
"vault.quota.total_bytes" = 5678
`);

    const context = composeBaseContext(['--config', configPath], {
      env: { HOME: dir, PORT: '9000' },
    });

    expect(context.port).toBe(9000);
    expect(context.loadedConfig.bootstrap.bind_port).toBe(8080);
  });

  it('finishes post-commit config recovery before derived boot settings escape', () => {
    const dir = makeTmp();
    const configPath = join(dir, 'config.toml');
    const dbPath = join(dir, 'server.db');
    const stagingPath = `${dbPath}.staging-${'a'.repeat(16)}`;
    writeFileSync(configPath, '[bootstrap]\nbind_port = 8080\n');
    writeFileSync(dbPath, 'old-db');
    writeFileSync(stagingPath, 'new-db');
    const prepared = prepareServerBundleSwap({
      dbPath,
      stagingDbPath: stagingPath,
      stamp: '2023-11-14T22-13-20-000Z-deadbeef',
      configPath,
      nextConfig: Buffer.from('[bootstrap]\nbind_port = 9090\n'),
    });

    // Hard-exit state immediately after the database commit point: the new db
    // is live, while config is still staged and the old file is what an eager
    // one-pass loader would read.
    renameSync(dbPath, prepared.dbBackupPath);
    renameSync(stagingPath, dbPath);
    expect(readFileSync(configPath, 'utf8')).toContain('8080');

    const context = composeBaseContext(['--config', configPath, '--db', dbPath], {
      env: { HOME: dir },
    });
    expect(context.port).toBe(9090);
    expect(readFileSync(configPath, 'utf8')).toContain('9090');
    expect(
      reconcileServerBundleSwap(dbPath, () => true, { configPath }).recovery,
    ).toBe('completed');
  });

  it('keeps the base context free of storage, listener, scheduler, and composition imports', () => {
    const source = readFileSync(baseContextPath, 'utf8');

    expect(source).not.toMatch(/better-sqlite3|@recued\/storage|['"]\.\.\/server\.js['"]/);
    expect(source).not.toMatch(/composition\/bin|path-listener|listener-coordinator/);
    expect(source).not.toMatch(/background-services|composeSchedulers|mcp-server/);
    expect(source).toMatch(/loadConfig/);
    expect(source).toMatch(/createRuntimeConfigStore/);
  });
});
