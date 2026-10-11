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

import { afterEach, describe, expect, it, vi } from 'vitest';

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
  it('boots on a config an older install wrote, naming each removed setting it sets', () => {
    // The [bootstrap] block the VPS cloud-init templates wrote until 2026-10-08.
    // None of these keys was ever read; since 2026-10-09 they are not even
    // parsed, and boot says so instead of letting them read as applied.
    const dir = makeTmp();
    const configPath = join(dir, 'config.toml');
    writeFileSync(configPath, `
[bootstrap]
data_path = "/var/lib/recued"
bind_host = "0.0.0.0"
bind_port = 7717
mcp_port  = 7718
webhook_port = 0
`);
    const warnings: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...parts: unknown[]) => {
      warnings.push(parts.join(' '));
    });
    try {
      const context = composeBaseContext(['--config', configPath, '--db', join(dir, 'server.db')], {
        env: { HOME: dir, RECUED_BOOTSTRAP_LOG_PATH: '/var/log/recued' },
      });
      expect(context.loadedConfig.bootstrap).toEqual({ bind_port: 7717, webhooks_enabled: false });
    } finally {
      warn.mockRestore();
    }
    expect(warnings.filter((line) => line.startsWith('[config] '))).toEqual([
      expect.stringMatching(/^\[config\] IGNORED — bootstrap\.data_path was removed: .*--db <file> or DB_PATH$/),
      expect.stringMatching(/^\[config\] IGNORED — bootstrap\.bind_host was removed: .*"network\.lan_bind_address"/),
      expect.stringMatching(/^\[config\] IGNORED — bootstrap\.mcp_port was removed: MCP is served at \/mcp/),
      expect.stringMatching(/^\[config\] IGNORED — RECUED_BOOTSTRAP_LOG_PATH was removed: .*beside its database$/),
      // `webhook_port`, renamed `webhooks_enabled` 2026-10-10, still works: a notice, not a refusal.
      expect.stringMatching(/^\[config\] RENAMED — bootstrap\.webhook_port was renamed to webhooks_enabled .*read as webhooks_enabled = false$/),
    ]);
  });

  it('boots on a config that sets removed runtime settings, naming each as removed', () => {
    // The sample config offered `log.level` and the mail quota until 2026-10-10;
    // `collection.webhook.max_body_bytes` went with the webhook collection.
    // Nothing read any of them, and boot says so rather than calling them
    // unrecognised, which would read as a typo.
    const dir = makeTmp();
    const configPath = join(dir, 'config.toml');
    writeFileSync(configPath, `
[runtime]
"log.level" = "debug"
"collection.mail.default.quota_bytes" = 2147483648
"collection.webhook.max_body_bytes" = 1048576
`);
    const warnings: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...parts: unknown[]) => {
      warnings.push(parts.join(' '));
    });
    try {
      composeBaseContext(['--config', configPath, '--db', join(dir, 'server.db')], {
        env: { HOME: dir },
      });
    } finally {
      warn.mockRestore();
    }
    expect(warnings.filter((line) => line.startsWith('[config] '))).toEqual([
      "[config] IGNORED — runtime.log.level was removed: nothing read it; no setting filters the server's log by level",
      "[config] IGNORED — runtime.collection.mail.default.quota_bytes was removed: nothing read it; each mail account's own quota_bytes decides, 512 MiB when unset",
      '[config] IGNORED — runtime.collection.webhook.max_body_bytes was removed: nothing read it; the webhook collection it configured was removed',
    ]);
  });

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
      // ⚠ DB_PATH pinned: this test is about the PORT. Left unset, the realm
      // resolver refuses when a stray ./recued-server.db sits in the checkout,
      // which made a port test depend on the developer's working directory.
      env: { HOME: dir, DB_PATH: join(dir, 'realm.db') },
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
      env: { HOME: dir, PORT: '9000', DB_PATH: join(dir, 'realm.db') },
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
