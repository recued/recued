/** Phase G (D-109) — `server.archive.*` rpc handler tests.
 *
 *  The handler wraps a `runtime` abstraction that the composition
 *  root wires to the Phase F export/import helpers. Tests inject a
 *  spy runtime so the handler logic is exercised without touching
 *  the filesystem or crypto. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArchiveManifest } from '@recued/contracts';
import { createAuditLogStore, createInMemoryCollection } from '@recued/storage';
import type { AuditLogStore } from '@recued/storage';
import { generateRecoveryKey } from '@recued/crypto';
import { makeArchiveHandlers, type ArchiveRuntime } from '../archive/archive-handler.js';
import { SCHEMA_VERSION } from '../archive/archive-format.js';

const manifest: ArchiveManifest = {
  format_version: 1,
  schema_version: 1,
  exported_at: '2026-04-21T00:00:00.000Z',
  record_count: 42,
  tables: { emails: 30, files: 12 },
  includes_blobs: true,
  includes_passport: false,
};

/** The spy runtime ignores the key, but the handler now BIP39-validates
 *  the mnemonic shape (`requireRecoveryKey`), so this must be a real valid
 *  phrase. Actual key derivation + crypto is covered against live sqlite
 *  in `archive-rpc-import.test.ts`. */
const KEY = generateRecoveryKey().mnemonic;

const okRuntime = (
  over: Partial<ArchiveRuntime> = {},
): ArchiveRuntime => ({
  canExport: over.canExport ?? (() => ({ ok: true })),
  preflightExport: over.preflightExport ?? (async () => ({ ok: true })),
  pruneExpiredExports: over.pruneExpiredExports ?? (() => ({ deleted: [] })),
  runExport:
    over.runExport ??
    (async () => ({
      path: '/tmp/archive-1.recued.archive',
      bytes_written: 1_024,
      expires_at: 999_999,
    })),
  readManifest: over.readManifest ?? (async () => manifest),
  verifyRestoreRealm:
    over.verifyRestoreRealm ?? (async () => ({ realm: 'same', authorized: true })),
  runImport:
    over.runImport ??
    (async () => ({ manifest, restored_at: 123_456 })),
});

describe('archive rpc', () => {
  let dir: string;
  let auditLog: AuditLogStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'archive-rpc-'));
    auditLog = createAuditLogStore(createInMemoryCollection(), createInMemoryCollection());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns undefined slice when deps absent', () => {
    const { slice } = makeArchiveHandlers(undefined);
    expect(slice).toBeUndefined();
  });

  it('export kicks off an async job and returns job_id', async () => {
    type ExportDone = { path: string; bytes_written: number; expires_at: number };
    let resolveExport!: (v: ExportDone) => void;
    const slowDone = new Promise<ExportDone>((r) => {
      resolveExport = r;
    });
    const runtime = okRuntime({ runExport: () => slowDone });
    const { slice, getJob } = makeArchiveHandlers({ runtime, auditLog, dataPath: dir });
    const res = (await slice!.handlers['server.archive.export']!(
      { include_blobs: true, recoveryKey: KEY },
      {} as never,
    )) as { job_id: string };
    expect(res.job_id).toMatch(/^arx-/);
    expect(getJob(res.job_id)?.state).toBe('running');
    resolveExport({ path: '/tmp/done.recued.archive', bytes_written: 2_048, expires_at: 777 });
    await new Promise((r) => setImmediate(r));
    expect(getJob(res.job_id)?.state).toBe('done');
    expect(getJob(res.job_id)?.path).toBe('/tmp/done.recued.archive');
    expect(getJob(res.job_id)?.expires_at).toBe(777);
  });

  it('export reports error state when runtime throws', async () => {
    const runtime = okRuntime({
      runExport: async () => { throw new Error('disk full'); },
    });
    const { slice, getJob } = makeArchiveHandlers({ runtime, auditLog, dataPath: dir });
    const res = (await slice!.handlers['server.archive.export']!(
      { recoveryKey: KEY },
      {} as never,
    )) as { job_id: string };
    await new Promise((r) => setImmediate(r));
    const status = getJob(res.job_id);
    expect(status?.state).toBe('error');
    expect(status?.error).toContain('disk full');
  });

  it('status 404s a done job whose export file was evicted (missing file, not yet expired)', async () => {
    const gonePath = join(dir, 'already-evicted.recued.archive'); // never created
    const future = Date.now() + 3_600_000; // not expired — exercises the missing-file branch
    const runtime = okRuntime({
      runExport: async () => ({ path: gonePath, bytes_written: 5, expires_at: future }),
    });
    const { slice, getJob } = makeArchiveHandlers({ runtime, auditLog, dataPath: dir });
    const res = (await slice!.handlers['server.archive.export']!(
      { recoveryKey: KEY }, {} as never,
    )) as { job_id: string };
    await new Promise((r) => setImmediate(r));
    expect(getJob(res.job_id)?.state).toBe('done'); // raw record is done…
    // …but the public status API refuses to hand back a path to a missing file.
    await expect(
      slice!.handlers['server.archive.status']!({ job_id: res.job_id }, {} as never),
    ).rejects.toMatchObject({ code: 'archive_job_unknown' });
    // The pointless record is dropped on the way out.
    expect(getJob(res.job_id)).toBeNull();
  });

  it('status enforces expiry — past expires_at unlinks the file + 404s, even if present', async () => {
    const livePath = join(dir, 'expired.recued.archive');
    await writeFile(livePath, 'archive-bytes');
    const past = Date.now() - 1_000; // already past the advertised GC time
    const runtime = okRuntime({
      runExport: async () => ({ path: livePath, bytes_written: 13, expires_at: past }),
    });
    const { slice, getJob } = makeArchiveHandlers({ runtime, auditLog, dataPath: dir });
    const res = (await slice!.handlers['server.archive.export']!(
      { recoveryKey: KEY }, {} as never,
    )) as { job_id: string };
    await new Promise((r) => setImmediate(r));
    await expect(
      slice!.handlers['server.archive.status']!({ job_id: res.job_id }, {} as never),
    ).rejects.toMatchObject({ code: 'archive_job_unknown' });
    // Self-enforcing TTL: the lingering file is unlinked + the record dropped.
    expect(existsSync(livePath)).toBe(false);
    expect(getJob(res.job_id)).toBeNull();
  });

  it('status returns done + expires_at while the export is live (file present, not expired)', async () => {
    const livePath = join(dir, 'live.recued.archive');
    await writeFile(livePath, 'archive-bytes');
    const future = Date.now() + 3_600_000;
    const runtime = okRuntime({
      runExport: async () => ({ path: livePath, bytes_written: 13, expires_at: future }),
    });
    const { slice } = makeArchiveHandlers({ runtime, auditLog, dataPath: dir });
    const res = (await slice!.handlers['server.archive.export']!(
      { recoveryKey: KEY }, {} as never,
    )) as { job_id: string };
    await new Promise((r) => setImmediate(r));
    const status = (await slice!.handlers['server.archive.status']!(
      { job_id: res.job_id }, {} as never,
    )) as { state: string; path?: string; expires_at?: number };
    expect(status.state).toBe('done');
    expect(status.path).toBe(livePath);
    expect(status.expires_at).toBe(future);
  });

  it('status 404s for unknown job_id', async () => {
    const { slice } = makeArchiveHandlers({ runtime: okRuntime(), auditLog, dataPath: dir });
    await expect(
      slice!.handlers['server.archive.status']!({ job_id: 'does-not-exist' }, {} as never),
    ).rejects.toMatchObject({ code: 'archive_job_unknown' });
  });

  it('status rejects bad input', async () => {
    const { slice } = makeArchiveHandlers({ runtime: okRuntime(), auditLog, dataPath: dir });
    await expect(
      slice!.handlers['server.archive.status']!({ job_id: '' }, {} as never),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('export with canExport=false returns not_configured', async () => {
    const runtime = okRuntime({
      canExport: () => ({ ok: false, reason: 'recovery key missing' }),
    });
    const { slice } = makeArchiveHandlers({ runtime, auditLog, dataPath: dir });
    await expect(
      slice!.handlers['server.archive.export']!({ recoveryKey: KEY }, {} as never),
    ).rejects.toMatchObject({ code: 'not_configured' });
  });

  it('export refuses with insufficient_storage when the pre-flight fails, no job started', async () => {
    const runExport = vi.fn();
    const runtime = okRuntime({
      preflightExport: async () => ({
        ok: false,
        reason: 'need ~5.0 GB free, 1.0 GB available',
        need_bytes: 5_000_000_000,
        free_bytes: 1_000_000_000,
      }),
      runExport,
    });
    const { slice } = makeArchiveHandlers({ runtime, auditLog, dataPath: dir });
    await expect(
      slice!.handlers['server.archive.export']!({ recoveryKey: KEY }, {} as never),
    ).rejects.toMatchObject({ code: 'insufficient_storage', status: 507 });
    // Doomed export never started — the rpc rejected before the job existed.
    expect(runExport).not.toHaveBeenCalled();
  });

  it('a pre-flight refusal releases the latch (a later export is not wedged)', async () => {
    let refuse = true;
    const runtime = okRuntime({
      preflightExport: async () =>
        refuse
          ? { ok: false, reason: 'no room', need_bytes: 9, free_bytes: 1 }
          : { ok: true },
    });
    const { slice } = makeArchiveHandlers({ runtime, auditLog, dataPath: dir });
    await expect(
      slice!.handlers['server.archive.export']!({ recoveryKey: KEY }, {} as never),
    ).rejects.toMatchObject({ code: 'insufficient_storage' });
    // The failed start must not leave the latch stuck closed.
    refuse = false;
    const res = (await slice!.handlers['server.archive.export']!(
      { recoveryKey: KEY }, {} as never,
    )) as { job_id: string };
    expect(res.job_id).toMatch(/^arx-/);
  });

  it('holds the export latch across the async pre-flight (no overlap during the await)', async () => {
    let resolvePreflight!: (v: { ok: true }) => void;
    const slowPreflight = new Promise<{ ok: true }>((r) => { resolvePreflight = r; });
    const runtime = okRuntime({ preflightExport: () => slowPreflight });
    const { slice } = makeArchiveHandlers({ runtime, auditLog, dataPath: dir });

    // Export 1's rpc is pending on the slow pre-flight (latch already claimed).
    const first = slice!.handlers['server.archive.export']!({ recoveryKey: KEY }, {} as never);
    // A concurrent export 2 is rejected — the latch was set synchronously,
    // BEFORE export 1 awaited the pre-flight, so no overlap slips through.
    await expect(
      slice!.handlers['server.archive.export']!({ recoveryKey: KEY }, {} as never),
    ).rejects.toMatchObject({ code: 'archive_export_in_progress' });

    resolvePreflight({ ok: true });
    await first; // export 1 completes cleanly
  });

  it('export sweeps expired files BEFORE the storage pre-flight (so stale archives free space first)', async () => {
    const order: string[] = [];
    const runtime = okRuntime({
      pruneExpiredExports: () => { order.push('prune'); return { deleted: [] }; },
      preflightExport: async () => { order.push('preflight'); return { ok: true }; },
    });
    const { slice } = makeArchiveHandlers({ runtime, auditLog, dataPath: dir });
    await slice!.handlers['server.archive.export']!({ recoveryKey: KEY }, {} as never);
    expect(order).toEqual(['prune', 'preflight']);
  });

  it('serializes exports — a second concurrent export gets archive_export_in_progress', async () => {
    type ExportDone = { path: string; bytes_written: number; expires_at: number };
    let resolveFirst!: (v: ExportDone) => void;
    const slow = new Promise<ExportDone>((r) => { resolveFirst = r; });
    const runtime = okRuntime({ runExport: () => slow });
    const { slice, getJob } = makeArchiveHandlers({ runtime, auditLog, dataPath: dir });

    const first = (await slice!.handlers['server.archive.export']!(
      { recoveryKey: KEY }, {} as never,
    )) as { job_id: string };
    expect(getJob(first.job_id)?.state).toBe('running');

    await expect(
      slice!.handlers['server.archive.export']!({ recoveryKey: KEY }, {} as never),
    ).rejects.toMatchObject({ code: 'archive_export_in_progress', status: 409 });

    // Latch releases on settle — a follow-up export is accepted again.
    resolveFirst({ path: '/tmp/first.recued.archive', bytes_written: 10, expires_at: 1 });
    await new Promise((r) => setImmediate(r));
    const third = (await slice!.handlers['server.archive.export']!(
      { recoveryKey: KEY }, {} as never,
    )) as { job_id: string };
    expect(third.job_id).toMatch(/^arx-/);
  });

  it('prunes done jobs by their completion expiry, not started_at (long exports survive)', async () => {
    const DAY = 24 * 60 * 60 * 1000;
    let clock = 1_000_000;
    const farExpiry = clock + 100 * DAY; // completion + TTL, well in the future
    const runtime = okRuntime({
      runExport: async () => ({ path: '/tmp/long.recued.archive', bytes_written: 9, expires_at: farExpiry }),
    });
    const { slice, getJob, pruneExpired } = makeArchiveHandlers({
      runtime, auditLog, dataPath: dir, now: () => clock,
    });
    const res = (await slice!.handlers['server.archive.export']!(
      { recoveryKey: KEY }, {} as never,
    )) as { job_id: string };
    await new Promise((r) => setImmediate(r));
    expect(getJob(res.job_id)?.state).toBe('done');

    // Advance PAST started_at + 7-day retention, but BEFORE the file expiry.
    clock = 1_000_000 + 8 * DAY;
    pruneExpired();
    // started_at-anchored pruning would have dropped it here; expiry-anchored
    // keeps it (the archive is still on disk until its own mtime sweep).
    expect(getJob(res.job_id)?.state).toBe('done');

    // Past the file expiry → the record is finally pruned.
    clock = farExpiry + 1;
    pruneExpired();
    expect(getJob(res.job_id)).toBeNull();
  });

  it('releases the export latch even when the export errors', async () => {
    const runtime = okRuntime({ runExport: async () => { throw new Error('boom'); } });
    const { slice } = makeArchiveHandlers({ runtime, auditLog, dataPath: dir });
    await slice!.handlers['server.archive.export']!({ recoveryKey: KEY }, {} as never);
    await new Promise((r) => setImmediate(r));
    // A new export after the failure is not wedged behind a stuck latch.
    const next = (await slice!.handlers['server.archive.export']!(
      { recoveryKey: KEY }, {} as never,
    )) as { job_id: string };
    expect(next.job_id).toMatch(/^arx-/);
  });

  it('import 404s when path does not exist', async () => {
    const { slice } = makeArchiveHandlers({ runtime: okRuntime(), auditLog, dataPath: dir });
    await expect(
      slice!.handlers['server.archive.import']!(
        { path: '/tmp/nonexistent-archive.dat', recoveryKey: KEY },
        {} as never,
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('import dry_run reads manifest without restarting', async () => {
    const archivePath = join(dir, 'snap.recued.archive');
    await writeFile(archivePath, 'stub');
    const runImport = vi.fn();
    const { slice } = makeArchiveHandlers({
      runtime: okRuntime({ runImport }),
      auditLog,
      dataPath: dir,
    });
    const res = (await slice!.handlers['server.archive.import']!(
      { path: archivePath, dry_run: true, recoveryKey: KEY },
      {} as never,
    )) as { manifest: ArchiveManifest; restored_at: number | null; realm: string };
    expect(res.manifest.record_count).toBe(42);
    expect(res.restored_at).toBeNull();
    expect(res.realm).toBe('same');
    expect(runImport).not.toHaveBeenCalled();
  });

  it('dry_run reports the cross-realm relation so the ext can branch the UI', async () => {
    const archivePath = join(dir, 'foreign.recued.archive');
    await writeFile(archivePath, 'stub');
    const { slice } = makeArchiveHandlers({
      runtime: okRuntime({
        verifyRestoreRealm: async () => ({ realm: 'cross', authorized: false }),
      }),
      auditLog,
      dataPath: dir,
    });
    const res = (await slice!.handlers['server.archive.import']!(
      { path: archivePath, dry_run: true, recoveryKey: KEY },
      {} as never,
    )) as { realm: string };
    expect(res.realm).toBe('cross');
  });

  it('M5 S3.0 — dry_run reports schema_compat ok for a same/older-schema archive', async () => {
    const archivePath = join(dir, 'compat.recued.archive');
    await writeFile(archivePath, 'stub');
    const { slice } = makeArchiveHandlers({ runtime: okRuntime(), auditLog, dataPath: dir });
    const res = (await slice!.handlers['server.archive.import']!(
      { path: archivePath, dry_run: true, recoveryKey: KEY },
      {} as never,
    )) as { schema_compat?: { status: string; server_schema_version: number } };
    expect(res.schema_compat).toEqual({ status: 'ok', server_schema_version: SCHEMA_VERSION });
  });

  it('M5 S3.0 — dry_run reports schema_compat archive_too_new for a newer-schema archive', async () => {
    const archivePath = join(dir, 'toonew.recued.archive');
    await writeFile(archivePath, 'stub');
    const { slice } = makeArchiveHandlers({
      runtime: okRuntime({
        readManifest: async () => ({ ...manifest, schema_version: SCHEMA_VERSION + 1 }),
      }),
      auditLog,
      dataPath: dir,
    });
    const res = (await slice!.handlers['server.archive.import']!(
      { path: archivePath, dry_run: true, recoveryKey: KEY },
      {} as never,
    )) as { schema_compat?: { status: string } };
    expect(res.schema_compat?.status).toBe('archive_too_new');
  });

  it('M5 S3.0 — commit maps an ARCHIVE_SCHEMA_TOO_NEW staging throw to archive_schema_too_new 409', async () => {
    const archivePath = join(dir, 'toonew.recued.archive');
    await writeFile(archivePath, 'stub');
    const { slice } = makeArchiveHandlers({
      runtime: okRuntime({
        runImport: async () => {
          throw new Error(
            'ARCHIVE_SCHEMA_TOO_NEW: archive schema_version 3 > server 2 — upgrade this server before restoring',
          );
        },
      }),
      auditLog,
      dataPath: dir,
    });
    await expect(
      slice!.handlers['server.archive.import']!(
        { path: archivePath, recoveryKey: KEY },
        {} as never,
      ),
    ).rejects.toMatchObject({ code: 'archive_schema_too_new', status: 409 });
  });

  it('commit refuses a cross-realm restore that is not authorized (archive_realm_mismatch 403)', async () => {
    const archivePath = join(dir, 'foreign.recued.archive');
    await writeFile(archivePath, 'stub');
    const runImport = vi.fn();
    const { slice } = makeArchiveHandlers({
      runtime: okRuntime({
        verifyRestoreRealm: async () => ({ realm: 'cross', authorized: false }),
        runImport,
      }),
      auditLog,
      dataPath: dir,
    });
    await expect(
      slice!.handlers['server.archive.import']!(
        { path: archivePath, recoveryKey: KEY },
        {} as never,
      ),
    ).rejects.toMatchObject({ code: 'archive_realm_mismatch', status: 403 });
    // The destructive restore never ran — the gate fired first.
    expect(runImport).not.toHaveBeenCalled();
  });

  it('M5 S3 — commit refuses a non-empty unenrolled target (archive_restore_target_not_empty 409)', async () => {
    const archivePath = join(dir, 'own.recued.archive');
    await writeFile(archivePath, 'stub');
    const runImport = vi.fn();
    const { slice } = makeArchiveHandlers({
      runtime: okRuntime({
        verifyRestoreRealm: async () => ({
          realm: 'same',
          authorized: false,
          reason: 'target_not_empty',
        }),
        runImport,
      }),
      auditLog,
      dataPath: dir,
    });
    await expect(
      slice!.handlers['server.archive.import']!(
        { path: archivePath, recoveryKey: KEY },
        {} as never,
      ),
    ).rejects.toMatchObject({ code: 'archive_restore_target_not_empty', status: 409 });
    // The destructive restore never ran — the empty-target gate fired first.
    expect(runImport).not.toHaveBeenCalled();
  });

  it('commit proceeds for an authorized cross-realm restore + echoes the realm', async () => {
    const archivePath = join(dir, 'foreign.recued.archive');
    await writeFile(archivePath, 'stub');
    const runImport = vi.fn(async () => ({ manifest, restored_at: 1 }));
    const { slice } = makeArchiveHandlers({
      runtime: okRuntime({
        verifyRestoreRealm: async () => ({ realm: 'cross', authorized: true }),
        runImport,
      }),
      auditLog,
      dataPath: dir,
    });
    const res = (await slice!.handlers['server.archive.import']!(
      { path: archivePath, recoveryKey: KEY, currentRealmKey: KEY },
      {} as never,
    )) as { realm: string };
    expect(res.realm).toBe('cross');
    expect(runImport).toHaveBeenCalledTimes(1);
  });

  it('M5 S2a — resolves the driving client, passes it to runImport, and returns its rebind', async () => {
    const archivePath = join(dir, 'snap.recued.archive');
    await writeFile(archivePath, 'stub');
    const runImport = vi.fn(async () => ({
      manifest,
      restored_at: 1,
      rebind: { token_id: 'tk-new', bearer: 'be-new', instance_id: 'inst-x' },
    }));
    const { slice } = makeArchiveHandlers({
      runtime: okRuntime({ runImport }),
      auditLog,
      dataPath: dir,
    });
    // A verified paired webclient: instance_id null (never `register`s),
    // token_instance_id bearer-derived, client_token_id present (so the owner
    // resolves to the self-host owner id).
    const ctx = {
      instance_id: null,
      token_instance_id: 'inst-x',
      client_kind: 'webclient',
      client_label: 'Laptop',
      display_name: 'Laptop',
      client_token_id: 'tk-old',
    } as never;
    const res = (await slice!.handlers['server.archive.import']!(
      { path: archivePath, recoveryKey: KEY },
      ctx,
    )) as { rebind?: { token_id: string; bearer: string; instance_id: string } };
    expect(runImport).toHaveBeenCalledWith(
      expect.objectContaining({
        drivingClient: {
          instance_id: 'inst-x',
          client_kind: 'webclient',
          client_label: 'Laptop',
          display_name: 'Laptop',
          user_id: 'self',
        },
      }),
    );
    expect(res.rebind).toEqual({ token_id: 'tk-new', bearer: 'be-new', instance_id: 'inst-x' });
  });

  it('M5 S2a — omits the handoff when the caller carries no resolvable paired identity', async () => {
    const archivePath = join(dir, 'snap.recued.archive');
    await writeFile(archivePath, 'stub');
    const runImport = vi.fn(async () => ({ manifest, restored_at: 1 }));
    const { slice } = makeArchiveHandlers({
      runtime: okRuntime({ runImport }),
      auditLog,
      dataPath: dir,
    });
    // `{}` ctx — no instance, no client_kind, no client_token_id → nothing to
    // hand off to (drivingClient stays undefined); the client re-pairs.
    await slice!.handlers['server.archive.import']!(
      { path: archivePath, recoveryKey: KEY },
      {} as never,
    );
    expect(runImport).toHaveBeenCalledTimes(1);
    expect(runImport).toHaveBeenCalledWith(
      expect.not.objectContaining({ drivingClient: expect.anything() }),
    );
  });

  it('rejects an invalid currentRealmKey mnemonic with bad_request', async () => {
    const archivePath = join(dir, 'snap.recued.archive');
    await writeFile(archivePath, 'stub');
    const { slice } = makeArchiveHandlers({ runtime: okRuntime(), auditLog, dataPath: dir });
    await expect(
      slice!.handlers['server.archive.import']!(
        { path: archivePath, recoveryKey: KEY, currentRealmKey: 'not a real phrase' },
        {} as never,
      ),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('import writes the archive_import lifecycle pair', async () => {
    const archivePath = join(dir, 'snap.recued.archive');
    await writeFile(archivePath, 'stub');
    const { slice } = makeArchiveHandlers({
      runtime: okRuntime(),
      auditLog,
      dataPath: dir,
    });
    await slice!.handlers['server.archive.import']!(
      { path: archivePath, recoveryKey: KEY },
      {} as never,
    );
    const activities = await auditLog.listActivities(10);
    const actions = activities.map((a) => a.action);
    expect(actions).toContain('archive_import_start');
    expect(actions).toContain('archive_import_complete');
  });

  it('import rejects concurrent calls with archive_import_in_progress', async () => {
    const archivePath = join(dir, 'snap.recued.archive');
    await writeFile(archivePath, 'stub');
    let resolveFirst!: () => void;
    const slow = new Promise<void>((r) => {
      resolveFirst = r;
    });
    const runImport = vi.fn().mockImplementation(async () => {
      await slow;
      return { manifest, restored_at: 1_000 };
    });
    const { slice } = makeArchiveHandlers({
      runtime: okRuntime({ runImport }),
      auditLog,
      dataPath: dir,
    });
    const first = slice!.handlers['server.archive.import']!(
      { path: archivePath, recoveryKey: KEY },
      {} as never,
    );
    await new Promise((r) => setImmediate(r));
    await expect(
      slice!.handlers['server.archive.import']!(
        { path: archivePath, recoveryKey: KEY },
        {} as never,
      ),
    ).rejects.toMatchObject({ code: 'archive_import_in_progress' });
    resolveFirst();
    await first;
  });

  it('keeps the import latch CLOSED after a successful import (restart-window race)', async () => {
    // A successful import schedules a restart (the process exit()s + respawns to
    // reset the latch), so a SECOND import landing in that drain window must be
    // refused — never allowed to overwrite the staging file before the first
    // commits (the wrong-db-commit race). The latch stays closed post-success.
    const archivePath = join(dir, 'snap.recued.archive');
    await writeFile(archivePath, 'stub');
    const runImport = vi.fn(async () => ({ manifest, restored_at: 1 }));
    const { slice } = makeArchiveHandlers({
      runtime: okRuntime({ runImport }),
      auditLog,
      dataPath: dir,
    });
    await slice!.handlers['server.archive.import']!(
      { path: archivePath, recoveryKey: KEY },
      {} as never,
    );
    expect(runImport).toHaveBeenCalledTimes(1);
    // The restart hasn't happened (in-test), so a second import is refused.
    await expect(
      slice!.handlers['server.archive.import']!(
        { path: archivePath, recoveryKey: KEY },
        {} as never,
      ),
    ).rejects.toMatchObject({ code: 'archive_import_in_progress' });
    expect(runImport).toHaveBeenCalledTimes(1); // never reached the runtime again
  });

  it('RELEASES the import latch after a failed import (retry allowed)', async () => {
    // A failed import schedules NO restart (runImport throws during staging,
    // before it requests the drain), so the latch must reopen for a retry.
    const archivePath = join(dir, 'snap.recued.archive');
    await writeFile(archivePath, 'stub');
    let calls = 0;
    const runImport = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('stage boom');
      return { manifest, restored_at: 7 };
    });
    const { slice } = makeArchiveHandlers({
      runtime: okRuntime({ runImport }),
      auditLog,
      dataPath: dir,
    });
    await expect(
      slice!.handlers['server.archive.import']!(
        { path: archivePath, recoveryKey: KEY },
        {} as never,
      ),
    ).rejects.toThrow(/stage boom/);
    // Latch reopened → the retry reaches the runtime + succeeds.
    const res = (await slice!.handlers['server.archive.import']!(
      { path: archivePath, recoveryKey: KEY },
      {} as never,
    )) as { restored_at: number | null };
    expect(res.restored_at).toBe(7);
    expect(runImport).toHaveBeenCalledTimes(2);
  });

  it('export rejects a missing recoveryKey with bad_request', async () => {
    const { slice } = makeArchiveHandlers({ runtime: okRuntime(), auditLog, dataPath: dir });
    // The typed contract requires recoveryKey; the cast simulates a
    // malformed wire payload the runtime boundary must still reject.
    await expect(
      slice!.handlers['server.archive.export']!({ include_blobs: true } as never, {} as never),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('import rejects a missing recoveryKey with bad_request', async () => {
    const archivePath = join(dir, 'snap.recued.archive');
    await writeFile(archivePath, 'stub');
    const runImport = vi.fn();
    const { slice } = makeArchiveHandlers({
      runtime: okRuntime({ runImport }),
      auditLog,
      dataPath: dir,
    });
    // Missing key is rejected before the runtime is ever consulted. The
    // cast simulates a malformed wire payload (the typed contract requires
    // recoveryKey, but the runtime boundary still defends against it).
    await expect(
      slice!.handlers['server.archive.import']!({ path: archivePath } as never, {} as never),
    ).rejects.toMatchObject({ code: 'bad_request' });
    expect(runImport).not.toHaveBeenCalled();
  });

  it('export rejects an invalid (non-BIP39) recovery phrase with bad_request', async () => {
    const runExport = vi.fn();
    const { slice } = makeArchiveHandlers({ runtime: okRuntime({ runExport }), auditLog, dataPath: dir });
    // A structurally-invalid mnemonic is rejected synchronously — no
    // doomed export job is ever started.
    await expect(
      slice!.handlers['server.archive.export']!(
        { include_blobs: true, recoveryKey: 'totally not a real recovery phrase' },
        {} as never,
      ),
    ).rejects.toMatchObject({ code: 'bad_request' });
    expect(runExport).not.toHaveBeenCalled();
  });

  it('slice declares all 3 method names', () => {
    const { slice } = makeArchiveHandlers({
      runtime: okRuntime(),
      auditLog,
      dataPath: dir,
    });
    expect(slice?.methods.slice().sort()).toEqual([
      'server.archive.export',
      'server.archive.import',
      'server.archive.status',
    ]);
  });
});
