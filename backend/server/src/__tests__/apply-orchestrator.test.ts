import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUpdateLedger, type UpdateLedger } from '../update/update-ledger.js';
import { createBootFailureCounter } from '../update/boot-failure-counter.js';
import { BOOT_FAILURE_THRESHOLD } from '../update/apply-state-machine.js';
import {
  closeUnresolvedUpdateOperation,
  deriveInFlightRelease,
  evaluatePendingApplyOnBoot,
  resolveUpdateOperationOutcome,
  runApply,
  runRollback,
  type ApplyContext,
  type ApplyOrchestratorPorts,
} from '../update/apply-orchestrator.js';
import type { VerifyArtifactResult } from '../update/binary-apply-executor.js';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'recued-orch-'));

const ctx = (over: Partial<ApplyContext> = {}): ApplyContext => ({
  releaseIdentity: 'stable:1.4.2',
  fromVersion: '1.3.0',
  toVersion: '1.4.2',
  channel: 'stable',
  migration: false,
  artifact: { url: 'https://x/bin', sha256: 'aa', sig: 'ss' },
  trigger: 'manual',
  ...over,
});

let idSeq = 0;
const makePorts = (over: Partial<ApplyOrchestratorPorts> = {}): ApplyOrchestratorPorts => {
  const d = tmp();
  return {
    ledger: createUpdateLedger(join(d, 'updates.log')),
    bootFailureCounter: createBootFailureCounter(join(d, 'boot-failures.json')),
    download: vi.fn(async () => {}),
    verifyArtifact: vi.fn((): VerifyArtifactResult => ({ ok: true })),
    preserveAndSwap: vi.fn(),
    rollbackSwap: vi.fn(),
    discardStaged: vi.fn(),
    takeSnapshot: vi.fn(async () => {}),
    restoreSnapshot: vi.fn(),
    hasPreviousBinary: () => true,
    hasSnapshot: () => false,
    isQuiesced: () => true,
    requestRestart: vi.fn(),
    newEntryId: () => `e${++idSeq}`,
    now: () => 1,
    trustedPubkey: 'PUB',
    stagedPath: join(d, 'recued.new'),
    ...over,
  };
};

describe('runApply', () => {
  it('not-configured with no trusted key (no download)', async () => {
    const ports = makePorts({ trustedPubkey: '' });
    const r = await runApply(ports, ctx());
    expect(r.status).toBe('not-configured');
    expect(ports.download).not.toHaveBeenCalled();
  });

  it('happy path: download→verify→swap→restart, ledger started+staged', async () => {
    const ports = makePorts();
    const r = await runApply(ports, ctx());
    expect(r).toMatchObject({
      status: 'restarting',
      operationId: expect.any(String),
    });
    expect(ports.preserveAndSwap).toHaveBeenCalledOnce();
    expect(ports.requestRestart).toHaveBeenCalledOnce();
    const kinds = ports.ledger.readAll().map((e) => e.kind);
    expect(kinds).toEqual(['apply_started', 'apply_staged']);
  });

  // D-152 § A.16 — best-effort webclient sync between the binary swap + restart.
  it('calls syncWebclient with the artifact AFTER the swap, BEFORE the restart', async () => {
    const order: string[] = [];
    const syncWebclient = vi.fn(async () => {
      order.push('sync');
    });
    const ports = makePorts({
      preserveAndSwap: vi.fn(() => order.push('swap')),
      requestRestart: vi.fn(() => order.push('restart')),
      syncWebclient,
    });
    const wc = { url: 'https://x/wc', sha256: 'ww', sig: 'wsig' };
    const r = await runApply(ports, ctx({ webclientArtifact: wc }));
    expect(r.status).toBe('restarting');
    expect(syncWebclient).toHaveBeenCalledWith(wc);
    expect(order).toEqual(['swap', 'sync', 'restart']);
  });

  it('does not call syncWebclient when the release carries no webclient artifact', async () => {
    const syncWebclient = vi.fn(async () => {});
    const ports = makePorts({ syncWebclient });
    await runApply(ports, ctx({ webclientArtifact: null }));
    expect(syncWebclient).not.toHaveBeenCalled();
  });

  it('a syncWebclient failure is NON-FATAL — the binary apply still restarts', async () => {
    const syncWebclient = vi.fn(async () => {
      throw new Error('cdn down');
    });
    const ports = makePorts({ syncWebclient });
    const r = await runApply(ports, ctx({ webclientArtifact: { url: 'u', sha256: 'w', sig: 's' } }));
    expect(r.status).toBe('restarting');
    expect(ports.requestRestart).toHaveBeenCalledOnce();
  });

  // ── D-178 S1 rev 2 item 4 — the native addon is staged through the SAME gate
  //    as the exe and swapped WITH it. The addon is dlopen'd into the server's
  //    own address space at the first database open, so an unverified one is
  //    arbitrary code execution with the binary's privileges — it is not a
  //    lesser artifact than the exe and is deliberately NOT best-effort.
  const LIB = { url: 'https://x/lib.node', sha256: 'bb', sig: 'libsig' };

  const withLib = (over: Partial<ApplyOrchestratorPorts> = {}): ApplyOrchestratorPorts => {
    const ports = makePorts(over);
    return { ...ports, stagedLibPath: `${ports.stagedPath}.lib` };
  };

  it('stages the addon: downloads it to stagedLibPath and verifies it against the pinned key', async () => {
    const ports = withLib();
    const r = await runApply(ports, ctx({ libArtifact: LIB }));
    expect(r.status).toBe('restarting');
    expect(ports.download).toHaveBeenCalledWith(LIB.url, ports.stagedLibPath);
    // Same pinned key, same verify port as the exe — one I-2 boundary, not two.
    expect(ports.verifyArtifact).toHaveBeenCalledWith({
      filePath: ports.stagedLibPath,
      sha256: LIB.sha256,
      sig: LIB.sig,
      trustedPubkey: 'PUB',
    });
    // …and the swap is told this apply staged one, so exe+addon move as a set.
    expect(ports.preserveAndSwap).toHaveBeenCalledWith(true);
  });

  it('⛔ an addon that FAILS verification is refused — nothing is swapped', async () => {
    // The exe verifies fine; only the addon is bad. Without the check the server
    // would swap in a signed exe next to an UNSIGNED .node and dlopen it.
    const ports = withLib({
      verifyArtifact: vi.fn((input): VerifyArtifactResult =>
        input.sig === LIB.sig ? { ok: false, reason: 'signature verification failed' } : { ok: true }),
    });
    const r = await runApply(ports, ctx({ libArtifact: LIB }));
    expect(r.status).toBe('verify-failed');
    if (r.status === 'verify-failed') expect(r.detail).toMatch(/native addon/);
    expect(ports.preserveAndSwap).not.toHaveBeenCalled();
    expect(ports.requestRestart).not.toHaveBeenCalled();
    // The lock is RELEASED (terminal appended) — a failed addon must not wedge
    // every future apply behind an unterminated `apply_started`.
    expect(ports.ledger.readAll().map((e) => e.kind)).toEqual(['apply_started', 'apply_reverted']);
    expect(deriveInFlightRelease(ports.ledger)).toBeNull();
    expect(ports.discardStaged).toHaveBeenCalled();
  });

  it('⛔ an addon that fails to DOWNLOAD is refused — nothing is swapped', async () => {
    const ports = withLib({
      download: vi.fn(async (url: string) => {
        if (url === LIB.url) throw new Error('404');
      }),
    });
    const r = await runApply(ports, ctx({ libArtifact: LIB }));
    expect(r.status).toBe('download-failed');
    if (r.status === 'download-failed') expect(r.detail).toMatch(/native addon/);
    expect(ports.preserveAndSwap).not.toHaveBeenCalled();
    expect(deriveInFlightRelease(ports.ledger)).toBeNull();
  });

  it('verifies the addon BEFORE the pre-migration snapshot — a bad addon costs no snapshot', async () => {
    const ports = withLib({
      verifyArtifact: vi.fn((input): VerifyArtifactResult =>
        input.sig === LIB.sig ? { ok: false, reason: 'bad' } : { ok: true }),
    });
    await runApply(ports, ctx({ libArtifact: LIB, migration: true }));
    expect(ports.takeSnapshot).not.toHaveBeenCalled();
  });

  it('swaps the exe ALONE when the release carries no addon (pre-sidecar / docker-thin)', async () => {
    const ports = withLib();
    const r = await runApply(ports, ctx({ libArtifact: null }));
    expect(r.status).toBe('restarting');
    expect(ports.download).toHaveBeenCalledOnce();
    expect(ports.preserveAndSwap).toHaveBeenCalledWith(false);
  });

  it('ignores ctx.libArtifact on an install with no managed sidecar path', async () => {
    // No `stagedLibPath` → nowhere to stage it. Must swap the exe alone rather
    // than download to `undefined` or silently claim a sidecar was applied.
    const ports = makePorts();
    const r = await runApply(ports, ctx({ libArtifact: LIB }));
    expect(r.status).toBe('restarting');
    expect(ports.download).toHaveBeenCalledOnce();
    expect(ports.preserveAndSwap).toHaveBeenCalledWith(false);
  });

  it('takes a pre-migration snapshot before the swap when migrating', async () => {
    const ports = makePorts();
    const order: string[] = [];
    (ports.takeSnapshot as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push('snapshot'); });
    (ports.preserveAndSwap as ReturnType<typeof vi.fn>).mockImplementation(() => { order.push('swap'); });
    await runApply(ports, ctx({ migration: true }));
    expect(order).toEqual(['snapshot', 'swap']);
    expect(ports.ledger.readAll().map((e) => e.kind)).toContain('snapshot_taken');
  });

  it('storage preflight — refuses (insufficient-storage) before any ledger entry when free < headroom', async () => {
    const ports = makePorts({ freeBytes: () => 10 * 1024 * 1024, minFreeHeadroomBytes: 256 * 1024 * 1024 });
    const r = await runApply(ports, ctx());
    expect(r.status).toBe('insufficient-storage');
    if (r.status === 'insufficient-storage') expect(r.detail).toMatch(/free/);
    expect(ports.download).not.toHaveBeenCalled();
    // refused BEFORE touching the ledger → no wedged in-flight lock left behind
    expect(ports.ledger.readAll()).toEqual([]);
    expect(deriveInFlightRelease(ports.ledger)).toBeNull();
  });

  it('storage preflight — adds the pre-migration snapshot (db size) to the need only when migrating', async () => {
    // headroom 100, db 100, free 150: non-migrating needs 100 (ok); migrating needs 200 (refused)
    const shared = { freeBytes: () => 150, dbSizeBytes: () => 100, minFreeHeadroomBytes: 100 };
    expect((await runApply(makePorts(shared), ctx({ migration: false }))).status).toBe('restarting');
    const r = await runApply(makePorts(shared), ctx({ migration: true }));
    expect(r.status).toBe('insufficient-storage');
    if (r.status === 'insufficient-storage') expect(r.detail).toMatch(/snapshot/);
  });

  it('storage preflight — gates OPEN when the free-space probe is unsupported (null)', async () => {
    // an unprobe-able filesystem must never wedge updates — even a migrating one
    const ports = makePorts({ freeBytes: () => null, dbSizeBytes: () => 999 * 1024 * 1024, minFreeHeadroomBytes: 256 * 1024 * 1024 });
    expect((await runApply(ports, ctx({ migration: true }))).status).toBe('restarting');
  });

  it('storage preflight — proceeds when free space covers the artifact + snapshot', async () => {
    const ports = makePorts({ freeBytes: () => 10 * 1024 * 1024 * 1024, dbSizeBytes: () => 500 * 1024 * 1024, minFreeHeadroomBytes: 256 * 1024 * 1024 });
    expect((await runApply(ports, ctx({ migration: true }))).status).toBe('restarting');
  });

  it('storage preflight — distinct volumes: refuses on the BINARY volume when the artifact will not fit', async () => {
    // data volume roomy for the snapshot, but the separate binary volume can't fit the artifact headroom
    const ports = makePorts({
      freeBytes: () => 10 * 1024 * 1024 * 1024,
      artifactVolumeFreeBytes: () => 10 * 1024 * 1024,
      sameVolumeAsData: () => false,
      dbSizeBytes: () => 100 * 1024 * 1024,
      minFreeHeadroomBytes: 256 * 1024 * 1024,
    });
    const r = await runApply(ports, ctx({ migration: true }));
    expect(r.status).toBe('insufficient-storage');
    if (r.status === 'insufficient-storage') expect(r.detail).toMatch(/binary volume/);
  });

  it('storage preflight — distinct volumes: refuses on the DATA volume when the snapshot will not fit', async () => {
    // binary volume fine for the artifact, but the separate data volume can't fit the snapshot
    const ports = makePorts({
      freeBytes: () => 50 * 1024 * 1024,
      artifactVolumeFreeBytes: () => 10 * 1024 * 1024 * 1024,
      sameVolumeAsData: () => false,
      dbSizeBytes: () => 500 * 1024 * 1024,
      minFreeHeadroomBytes: 256 * 1024 * 1024,
    });
    const r = await runApply(ports, ctx({ migration: true }));
    expect(r.status).toBe('insufficient-storage');
    if (r.status === 'insufficient-storage') expect(r.detail).toMatch(/snapshot/);
  });

  it('defers an auto apply when not quiesced (I-5)', async () => {
    const ports = makePorts({ isQuiesced: () => false });
    const r = await runApply(ports, ctx({ trigger: 'auto' }));
    expect(r.status).toBe('deferred');
    expect(ports.download).not.toHaveBeenCalled();
    // manual proceeds even when not quiesced
    const ports2 = makePorts({ isQuiesced: () => false });
    expect((await runApply(ports2, ctx({ trigger: 'manual' }))).status).toBe('restarting');
  });

  it('verify failure aborts, discards, swaps NOTHING, records a revert', async () => {
    const ports = makePorts({ verifyArtifact: vi.fn(() => ({ ok: false, reason: 'sha256 mismatch' })) });
    const r = await runApply(ports, ctx());
    expect(r).toMatchObject({ status: 'verify-failed', detail: 'sha256 mismatch' });
    expect(ports.preserveAndSwap).not.toHaveBeenCalled();
    expect(ports.requestRestart).not.toHaveBeenCalled();
    expect(ports.discardStaged).toHaveBeenCalledOnce();
    expect(ports.ledger.readAll().map((e) => e.kind)).toEqual(['apply_started', 'apply_reverted']);
  });

  it('download failure aborts cleanly AND releases the lock', async () => {
    const ports = makePorts({ download: vi.fn(async () => { throw new Error('HTTP 503'); }) });
    const r = await runApply(ports, ctx());
    expect(r).toMatchObject({ status: 'download-failed', detail: 'HTTP 503' });
    expect(ports.verifyArtifact).not.toHaveBeenCalled();
    expect(ports.discardStaged).toHaveBeenCalledOnce();
    expect(ports.ledger.readAll().map((e) => e.kind)).toEqual(['apply_started', 'apply_reverted']);
    // lock released → a fresh apply can proceed
    expect(deriveInFlightRelease(ports.ledger)).toBeNull();
  });

  it('snapshot failure releases the lock (no wedge, no swap)', async () => {
    const ports = makePorts({ takeSnapshot: vi.fn(async () => { throw new Error('disk full'); }) });
    const r = await runApply(ports, ctx({ migration: true }));
    expect(r).toMatchObject({ status: 'stage-failed', detail: 'disk full' });
    expect(ports.preserveAndSwap).not.toHaveBeenCalled();
    expect(ports.requestRestart).not.toHaveBeenCalled();
    expect(deriveInFlightRelease(ports.ledger)).toBeNull();
  });

  it('refuses a concurrent apply while one is in flight (ledger-derived lock)', async () => {
    const ports = makePorts();
    await runApply(ports, ctx()); // leaves apply_staged (in flight until commit)
    const r = await runApply(ports, ctx({ releaseIdentity: 'stable:1.4.3', toVersion: '1.4.3' }));
    expect(r.status).toBe('busy');
  });
});

describe('deriveInFlightRelease', () => {
  const seed = (l: UpdateLedger, kinds: Array<[string, string]>) => {
    let i = 0;
    for (const [kind, rel] of kinds) {
      l.append({ id: `s${++i}`, kind: kind as never, at: 1, from_version: '1', to_version: '2', channel: 'stable', trigger: 'auto', release_identity: rel });
    }
  };
  it('null when the last apply committed', () => {
    const l = createUpdateLedger(join(tmp(), 'updates.log'));
    seed(l, [['apply_started', 'r1'], ['apply_staged', 'r1'], ['apply_committed', 'r1']]);
    expect(deriveInFlightRelease(l)).toBeNull();
  });
  it('returns the release of an uncommitted apply', () => {
    const l = createUpdateLedger(join(tmp(), 'updates.log'));
    seed(l, [['apply_started', 'r1'], ['apply_staged', 'r1']]);
    expect(deriveInFlightRelease(l)).toBe('r1');
  });
  it('does NOT mask an older unresolved apply behind a later terminated one', () => {
    const l = createUpdateLedger(join(tmp(), 'updates.log'));
    // r1 started (never terminal); r2 started then reverted — r1 still in flight
    seed(l, [['apply_started', 'r1'], ['apply_started', 'r2'], ['apply_reverted', 'r2']]);
    expect(deriveInFlightRelease(l)).toBe('r1');
  });
  it('clears once every started release has a terminal', () => {
    const l = createUpdateLedger(join(tmp(), 'updates.log'));
    seed(l, [['apply_started', 'r1'], ['apply_started', 'r2'], ['rolled_back', 'r2'], ['apply_committed', 'r1']]);
    expect(deriveInFlightRelease(l)).toBeNull();
  });
});

describe('closeUnresolvedUpdateOperation', () => {
  it('durably records an unknown receipt without asserting its outcome', () => {
    const ports = makePorts();

    expect(closeUnresolvedUpdateOperation(
      ports,
      'lost-receipt',
      'update',
      '1.4.2',
      'stable',
    )).toEqual({
      status: 'closed_unresolved',
      operation: 'update',
    });
    expect(resolveUpdateOperationOutcome(
      ports.ledger,
      'lost-receipt',
      '1.4.2',
    )).toEqual({
      status: 'closed_unresolved',
      operation: 'update',
    });
    expect(ports.ledger.readAll()).toEqual([
      expect.objectContaining({
        kind: 'operation_closed',
        closed_operation_id: 'lost-receipt',
        closed_operation: 'update',
        from_version: '1.4.2',
        to_version: '1.4.2',
        trigger: 'manual',
      }),
    ]);

    // Repeating the owner request resolves the durable closure instead of
    // appending another row.
    closeUnresolvedUpdateOperation(
      ports,
      'lost-receipt',
      'update',
      '1.4.2',
      'stable',
    );
    expect(ports.ledger.readAll()).toHaveLength(1);
  });

  it('refuses closure while any release transition remains in flight', () => {
    const ports = makePorts();
    ports.ledger.append({
      id: 'active-receipt',
      kind: 'apply_started',
      at: 1,
      from_version: '1.3.0',
      to_version: '1.4.2',
      channel: 'stable',
      trigger: 'manual',
      release_identity: 'stable:1.4.2',
    });

    expect(closeUnresolvedUpdateOperation(
      ports,
      'lost-receipt',
      'rollback',
      '1.3.0',
      'stable',
    )).toEqual({
      status: 'refused',
      reason: 'operation_in_flight',
    });
    expect(ports.ledger.readAll()).toHaveLength(1);
  });

  it('returns a receipt that became known instead of closing it', () => {
    const ports = makePorts();
    ports.ledger.append({
      id: 'known-receipt',
      kind: 'rolled_back',
      at: 1,
      from_version: '1.3.0',
      to_version: '1.4.2',
      channel: 'stable',
      trigger: 'manual',
      release_identity: 'stable:1.4.2',
    });

    expect(closeUnresolvedUpdateOperation(
      ports,
      'known-receipt',
      'update',
      '1.3.0',
      'stable',
    )).toEqual({
      status: 'completed',
      operation: 'rollback',
    });
    expect(ports.ledger.readAll()).toHaveLength(1);
  });
});

describe('runRollback', () => {
  it('refuses past a migration with no snapshot', () => {
    const ports = makePorts({ hasSnapshot: () => false });
    const r = runRollback(ports, { releaseIdentity: 'stable:1.4.2', fromVersion: '1.4.2', toVersion: '1.3.0', channel: 'stable', appliedMigration: true });
    expect(r.status).toBe('refused');
    expect(ports.rollbackSwap).not.toHaveBeenCalled();
  });
  it('restores the snapshot BEFORE swapping the binary (skew-safe order)', () => {
    const order: string[] = [];
    const ports = makePorts({
      hasSnapshot: () => true,
      restoreSnapshot: vi.fn(() => { order.push('restore'); }),
      rollbackSwap: vi.fn(() => { order.push('swap'); }),
    });
    const r = runRollback(ports, { releaseIdentity: 'stable:1.4.2', fromVersion: '1.4.2', toVersion: '1.3.0', channel: 'stable', appliedMigration: true });
    expect(r).toMatchObject({
      status: 'rolled-back',
      restored_snapshot: true,
      operationId: expect.any(String),
    });
    expect(order).toEqual(['restore', 'swap']);
  });

  it('a snapshot-restore failure leaves the binary untouched (no skew)', () => {
    const ports = makePorts({
      hasSnapshot: () => true,
      restoreSnapshot: vi.fn(() => { throw new Error('copy failed'); }),
    });
    expect(() => runRollback(ports, { releaseIdentity: 'stable:1.4.2', fromVersion: '1.4.2', toVersion: '1.3.0', channel: 'stable', appliedMigration: true })).toThrow(/copy failed/);
    expect(ports.rollbackSwap).not.toHaveBeenCalled();
    expect(ports.ledger.readAll()).toHaveLength(0); // no rolled_back recorded
  });
  it('plain binary swap for a non-migrating release', () => {
    const ports = makePorts();
    const r = runRollback(ports, { releaseIdentity: 'stable:1.4.2', fromVersion: '1.4.2', toVersion: '1.3.0', channel: 'stable', appliedMigration: false });
    expect(r).toMatchObject({ status: 'rolled-back', restored_snapshot: false });
    expect(ports.restoreSnapshot).not.toHaveBeenCalled();
  });
  it('refused while an apply is in flight (I-6)', () => {
    const ports = makePorts();
    ports.ledger.append({ id: 'x', kind: 'apply_started', at: 1, from_version: '1', to_version: '2', channel: 'stable', trigger: 'auto', release_identity: 'r9' });
    expect(runRollback(ports, { releaseIdentity: 'r9', fromVersion: '2', toVersion: '1', channel: 'stable', appliedMigration: false }).status).toBe('busy');
  });
});

describe('resolveUpdateOperationOutcome', () => {
  it('resolves an exact apply receipt without exposing release details', () => {
    const ports = makePorts();
    ports.ledger.append({
      id: 'apply-receipt',
      kind: 'apply_started',
      at: 1,
      from_version: '1.3.0',
      to_version: '1.4.2',
      channel: 'stable',
      trigger: 'manual',
      release_identity: 'stable:1.4.2',
    });
    ports.ledger.append({
      id: 'staged',
      kind: 'apply_staged',
      at: 2,
      from_version: '1.3.0',
      to_version: '1.4.2',
      channel: 'stable',
      trigger: 'manual',
      release_identity: 'stable:1.4.2',
    });

    expect(resolveUpdateOperationOutcome(
      ports.ledger,
      'apply-receipt',
      '1.3.0',
    )).toEqual({
      status: 'waiting_for_restart',
      operation: 'update',
    });
    expect(resolveUpdateOperationOutcome(
      ports.ledger,
      'apply-receipt',
      '1.4.2',
    )).toEqual({ status: 'completed', operation: 'update' });

    ports.ledger.append({
      id: 'committed',
      kind: 'apply_committed',
      at: 3,
      from_version: '1.3.0',
      to_version: '1.4.2',
      channel: 'stable',
      trigger: 'auto',
      release_identity: 'stable:1.4.2',
    });
    expect(resolveUpdateOperationOutcome(
      ports.ledger,
      'apply-receipt',
      'later-version',
    )).toEqual({ status: 'completed', operation: 'update' });
  });

  it('reports a reverted apply and verifies rollback only after its old binary boots', () => {
    const ports = makePorts();
    const base = {
      at: 1,
      from_version: '1.3.0',
      to_version: '1.4.2',
      channel: 'stable' as const,
      trigger: 'manual' as const,
      release_identity: 'stable:1.4.2',
    };
    ports.ledger.append({
      id: 'failed-apply',
      kind: 'apply_started',
      ...base,
    });
    ports.ledger.append({
      id: 'reverted',
      kind: 'apply_reverted',
      ...base,
    });
    ports.ledger.append({
      id: 'rollback-receipt',
      kind: 'rolled_back',
      ...base,
    });

    expect(resolveUpdateOperationOutcome(
      ports.ledger,
      'failed-apply',
      '1.3.0',
    )).toEqual({ status: 'reverted', operation: 'update' });
    expect(resolveUpdateOperationOutcome(
      ports.ledger,
      'rollback-receipt',
      '1.4.2',
    )).toEqual({
      status: 'waiting_for_restart',
      operation: 'rollback',
    });
    expect(resolveUpdateOperationOutcome(
      ports.ledger,
      'rollback-receipt',
      '1.3.0',
    )).toEqual({ status: 'completed', operation: 'rollback' });
    expect(resolveUpdateOperationOutcome(
      ports.ledger,
      'missing',
      '1.3.0',
    )).toEqual({ status: 'unknown' });
  });
});

describe('evaluatePendingApplyOnBoot', () => {
  const stage = (ports: ApplyOrchestratorPorts, rel = 'stable:1.4.2') => {
    const base = { at: 1, from_version: '1.3.0', to_version: '1.4.2', channel: 'stable' as const, trigger: 'manual' as const, release_identity: rel };
    ports.ledger.append({ id: 'a0', kind: 'apply_started', ...base });
    ports.ledger.append({ id: 'a1', kind: 'apply_staged', ...base });
  };

  it('continue + reset when nothing is in flight', () => {
    const ports = makePorts();
    expect(evaluatePendingApplyOnBoot(ports, { readinessOk: true, currentReleaseIdentity: 'x' }).action).toBe('continue');
  });

  it('commits a healthy boot of the staged release', () => {
    const ports = makePorts();
    stage(ports);
    const d = evaluatePendingApplyOnBoot(ports, { readinessOk: true, currentReleaseIdentity: 'stable:1.4.2' });
    expect(d).toMatchObject({ action: 'commit', releaseIdentity: 'stable:1.4.2' });
    expect(ports.bootFailureCounter.read()).toBe(0);
  });

  it('auto-reverts after N failed boots of the uncommitted binary', () => {
    const ports = makePorts();
    stage(ports);
    let last;
    for (let i = 0; i < BOOT_FAILURE_THRESHOLD; i++) {
      last = evaluatePendingApplyOnBoot(ports, { readinessOk: false, currentReleaseIdentity: 'stable:1.4.2' });
    }
    expect(last).toMatchObject({ action: 'auto-revert', releaseIdentity: 'stable:1.4.2' });
  });

  it('continues (retry) below the threshold', () => {
    const ports = makePorts();
    stage(ports);
    expect(evaluatePendingApplyOnBoot(ports, { readinessOk: false, currentReleaseIdentity: 'stable:1.4.2' }).action).toBe('continue');
  });

  it('treats a started-but-never-staged leftover as a staging abort (not boot-health)', () => {
    const ports = makePorts();
    // only apply_started — crash before the swap; the binary never changed
    ports.ledger.append({ id: 's0', kind: 'apply_started', at: 1, from_version: '1.3.0', to_version: '1.4.2', channel: 'stable', trigger: 'auto', release_identity: 'stable:1.4.2' });
    const d = evaluatePendingApplyOnBoot(ports, { readinessOk: true, currentReleaseIdentity: '1.3.0-id' });
    expect(d).toMatchObject({ action: 'staging-aborted', releaseIdentity: 'stable:1.4.2' });
    // lock released + never counted as a boot failure
    expect(deriveInFlightRelease(ports.ledger)).toBeNull();
    expect(ports.bootFailureCounter.read()).toBe(0);
  });
});
