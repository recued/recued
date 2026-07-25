import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRuntimeConfigStore } from '@recued/config';
import { afterEach, describe, expect, it } from 'vitest';

import { createBootTrace, type BootTraceEvent } from '../cli/boot-trace.js';
import { composeStorageContext } from '../serve/compose-storage-context.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const storageContextPath = join(repoRoot, 'backend/server/src/serve/compose-storage-context.ts');

let tmp: string | undefined;

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

const makeTmp = (): string => {
  tmp = mkdtempSync(join(tmpdir(), 'recued-serve-storage-'));
  return tmp;
};

const parseTraceLines = (lines: string[]): BootTraceEvent[] =>
  lines.map((line) => JSON.parse(line.slice('[recued boot] '.length)) as BootTraceEvent);

describe('composeStorageContext', () => {
  it('opens SQLite, applies pragmas, and composes core DB stores after tracing DB open', async () => {
    const dir = makeTmp();
    const dbPath = join(dir, 'server.db');
    const traceLines: string[] = [];
    const bootTrace = createBootTrace({
      entrypoint: 'serve-entry',
      profile: 'serve',
      command: 'serve',
      env: { RECUED_BOOT_TRACE: '1' },
      now: () => 1000,
      sink: (line) => traceLines.push(line),
    });

    const context = await composeStorageContext({
      dbPath,
      bootTrace,
      runtimeConfig: createRuntimeConfigStore({}),
      vaultQuotas: {
        perPublisherBytes: 1_234_000,
        totalBytes: 5_678_000,
      },
    });

    try {
      expect(existsSync(dbPath)).toBe(true);
      expect(context.db.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(context.db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(context.recipeStore.size()).toBeGreaterThan(0);
      expect(context.pairing?.getRealmToken()).toEqual(expect.any(String));
      expect(context.serverInstanceId).not.toBe('server');
      expect(context.auditLog).toBeDefined();
      expect(context.commitStore).toBeDefined();
      expect(context.checkpointStore).toBeDefined();
      expect(context.gateRegistry).toBeDefined();
      expect(context.pressureState).toBeDefined();

      const events = parseTraceLines(traceLines);
      expect(events.map((event) => event.phase)).toEqual([
        'trace-start',
        'db-open-attempted',
        'db-opened',
        'shared-setup-start',
      ]);
      expect(events.filter((event) => event.phase === 'db-open-attempted')[0])
        .toMatchObject({ db_open_attempted: true, detail: 'configured-db-path' });
    } finally {
      context.db.close();
    }
  });

  it('keeps storage context out of listener, scheduler, and MCP imports', () => {
    const source = readFileSync(storageContextPath, 'utf8');

    expect(source).toMatch(/better-sqlite3/);
    expect(source).toMatch(/createAuditLogStore/);
    expect(source).toMatch(/ensureMemorySchema/);
    expect(source).not.toMatch(/createServerHandlerSet|path-listener|listener-coordinator/);
    expect(source).not.toMatch(/composeSchedulers|background-services/);
    expect(source).not.toMatch(/mcp-server|wire-mcp-http-transport/);
  });
});
