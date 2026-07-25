import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUpdateLedger, type UpdateLedger } from '../update/update-ledger.js';
import { createBootFailureCounter } from '../update/boot-failure-counter.js';
import { BOOT_FAILURE_THRESHOLD } from '../update/apply-state-machine.js';
import {
  deriveInFlightRelease,
  evaluatePendingApplyOnBoot,
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
    expect(r.status).toBe('restarting');
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
    expect(r).toMatchObject({ status: 'rolled-back', restored_snapshot: true });
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
