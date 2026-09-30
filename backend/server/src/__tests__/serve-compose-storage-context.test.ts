import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRuntimeConfigStore } from '@recued/config';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { createBootTrace, type BootTraceEvent } from '../cli/boot-trace.js';
import { composeStorageContext } from '../serve/compose-storage-context.js';
import {
  restoreSnapshot,
  snapshotReceiptEpochMarkerPath,
} from '../update/binary-apply-executor.js';

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
      expect(context.gatedActionStore).toBeDefined();
      expect(context.gateRegistry).toBeDefined();
      expect(context.pressureState).toBeDefined();

      const receiptEvents: unknown[] = [];
      context.eventBus.subscribe(
        'storage-context-gated-action-test',
        { kinds: ['execution'], cursor_since: context.eventBus.cursor() },
        (event) => receiptEvents.push(event),
      );
      const held = await context.gatedActionStore.createHeld({
        run_id: 'run-receipt-1',
        recipe_id: 'recipe-receipt-1',
        gated_step_id: 'send-mail',
        checkpoint_id: 'checkpoint-receipt-1',
      });
      await context.gatedActionStore.finish(held.action_ref, {
        status: 'succeeded',
        status_message: 'Completed.',
        result: { message_id: 'message-1' },
        observed: { items: 1, succeeded: 1, failed: 0 },
      });
      expect(receiptEvents).toEqual([
        expect.objectContaining({
          kind: 'execution',
          recipe_id: 'recipe-receipt-1',
          run_id: 'run-receipt-1',
          op: 'action_changed',
          action_ref: held.action_ref,
          approval_ref: held.action_ref,
          action_revision: 1,
        }),
        expect.objectContaining({
          kind: 'execution',
          op: 'action_changed',
          action_ref: held.action_ref,
          action_revision: 2,
        }),
      ]);
      expect(JSON.stringify(receiptEvents)).not.toContain('message_id');

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

  it('composes the public address over this server\'s hostname registry', async () => {
    const dir = makeTmp();
    const original = process.env.RECUED_PUBLIC_BASE_URL;
    delete process.env.RECUED_PUBLIC_BASE_URL;
    const context = await composeStorageContext({
      dbPath: join(dir, 'server.db'),
      bootTrace: createBootTrace({
        entrypoint: 'serve-entry', profile: 'serve', command: 'serve', env: {}, now: () => 1000,
        sink: () => undefined,
      }),
      runtimeConfig: createRuntimeConfigStore({}),
      vaultQuotas: { perPublisherBytes: 1_234_000, totalBytes: 5_678_000 },
    });
    try {
      expect(context.publicAddress.ownBaseUrls()).toEqual([]);
      context.hostnameRegistryStore.upsert({
        server_identity_id: context.serverInstanceId,
        hostname: 'alice.recued.net',
        cert_source: 'recued_acme',
        cert_fingerprint: 'sha256:ab',
        ownership_status: 'verified',
        listener_ports: [443],
        ddns_managed: true,
        enabled: true,
      });
      expect(context.publicAddress.ownBaseUrls()).toEqual(['https://alice.recued.net']);
      // No probe answer yet: the Pro card cannot say either way.
      expect(context.publicAddress.proReachability()).toBeNull();
    } finally {
      context.db.close();
      if (original === undefined) delete process.env.RECUED_PUBLIC_BASE_URL;
      else process.env.RECUED_PUBLIC_BASE_URL = original;
    }
  });

  it('hands the Pro card the public address\'s probe answer', () => {
    // ⛔ Unwired until 2026-09-29, so every entitled card said "Waiting until
    // your server can be reached" forever. The provisioner's own suite injects
    // this read, so only the composition shows it is supplied — and the
    // status path cannot reach the gate without a bound, entitled account.
    const source = readFileSync(storageContextPath, 'utf8');
    expect(source).toMatch(
      /createProConvenienceProvisioner\(\{[\s\S]*?readReachability: async \(\) => publicAddress\.proReachability\(\)/,
    );
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

  it('finishes a pending snapshot receipt epoch before composing the action store', async () => {
    const dir = makeTmp();
    const dbPath = join(dir, 'server.db');
    const snapshotPath = join(dir, 'snapshot.db');
    const snapshot = new Database(snapshotPath);
    snapshot.exec(`CREATE TABLE gated_action_receipts (
      key TEXT NOT NULL PRIMARY KEY,
      data TEXT NOT NULL
    )`);
    snapshot.prepare('INSERT INTO gated_action_receipts (key, data) VALUES (?, ?)').run(
      'restored-action',
      JSON.stringify({
        schema_version: 1,
        action_ref: 'restored-action',
        approval_ref: 'restored-action',
        run_id: 'restored-run',
        gated_step_id: 'send',
        status: 'succeeded',
        status_message: 'Restored.',
        current_checkpoint_id: 'restored-checkpoint',
        created_at: 1,
        updated_at: 1,
        change_seq: 9,
        revision: 2,
        terminal_at: 1,
        expires_at: Number.MAX_SAFE_INTEGER,
        result: { ok: true },
      }),
    );
    snapshot.close();
    const live = new Database(dbPath);
    live.exec('CREATE TABLE displaced (value TEXT)');
    live.close();
    restoreSnapshot(snapshotPath, dbPath, (from, to) => copyFileSync(from, to));

    const context = await composeStorageContext({
      dbPath,
      bootTrace: createBootTrace({
        entrypoint: 'serve-entry', profile: 'serve', command: 'serve', env: {},
      }),
      runtimeConfig: createRuntimeConfigStore({}),
      vaultQuotas: { perPublisherBytes: 1_000, totalBytes: 2_000 },
    });
    try {
      expect(existsSync(snapshotReceiptEpochMarkerPath(dbPath))).toBe(false);
      expect(context.gatedActionStore.changeClock()).toMatchObject({ floor: 10 });
      const created = await context.gatedActionStore.createHeld({
        run_id: 'new-run', gated_step_id: 'send', checkpoint_id: 'new-checkpoint',
      });
      expect(created.change_seq).toBe(11);
    } finally {
      context.db.close();
    }
  });
});
