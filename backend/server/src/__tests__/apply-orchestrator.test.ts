import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { createUpdateLedger, type UpdateLedger } from '../update/update-ledger.js';
import { createBootFailureCounter } from '../update/boot-failure-counter.js';
import { BOOT_FAILURE_THRESHOLD } from '../update/apply-state-machine.js';
import {
  closeUnresolvedUpdateOperation,
  deriveInFlightRelease,
  evaluatePendingApplyOnBoot,
  reconcileAbandonedUpdateReservations,
  reserveUpdateOperationReceipt,
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

/** ⛔ THE SNAPSHOT + SWAP DO NOT HAPPEN INSIDE `runApply` ANY MORE. They are
 *  handed to `requestRestart`'s `onDrained` callback, because the only moment a
 *  live server is not accepting writes is after its restart drain has closed the
 *  database — a snapshot taken before that excluded every write made in between.
 *  So the default port here does what `compose-lifecycle` does: drain (trivially
 *  ok in a double), then run the callback. `flushCommits` is how a test waits for
 *  that work, exactly as the CLI awaits it (`cli-context/update.ts`). */
const pendingCommits: Promise<unknown>[] = [];
const flushCommits = async (): Promise<void> => {
  await Promise.all(pendingCommits.splice(0));
};

/** Apply, then let the deferred commit finish — the shape a live server produces. */
const applyAndCommit = async (
  ports: ApplyOrchestratorPorts,
  c: ApplyContext,
): Promise<Awaited<ReturnType<typeof runApply>>> => {
  const r = await runApply(ports, c);
  await flushCommits();
  return r;
};

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
    requestRestart: vi.fn((onDrained?: (drainOk: boolean) => void | Promise<void>) => {
      pendingCommits.push(Promise.resolve(onDrained?.(true)));
    }),
    // A unit-test double genuinely holds no database open, so this is the honest
    // default. The refusal it gates, and the fail-closed behaviour when the port
    // is absent entirely, each get their own test below.
    holdsDatabaseOpen: () => false,
    // A supervised server is the normal case; the guard that refuses an
    // un-supervised apply has its own test below.
    supervisorWillRespawn: () => true,
    newEntryId: () => `e${++idSeq}`,
    now: () => 1,
    trustedPubkey: 'PUB',
    stagedPath: join(d, 'recued.new'),
    ...over,
  };
};

describe('runApply', () => {
  /** ⛔⛔ AN APPLY ENDS BY EXITING FOR A SUPERVISOR TO RESPAWN US. Under `native`
   *  or `dev` there is none, so the server stages the binary, exits, and stays
   *  down. Reported on macOS 2026-08-31: Settings → Updates sat on "Waiting for
   *  server…" forever while Account → Servers said "can't reach your server". The
   *  update itself was fine — it commits on the next healthy boot — but nothing
   *  was going to boot.
   *
   *  🔑 D-188 already gated the webclient Restart button on exactly this, calling
   *  an un-supervised restart "a footgun". Apply does the same handoff and was
   *  never gated. */
  it('⛔ refuses when nothing would restart the server, BEFORE downloading', async () => {
    const ports = makePorts({ supervisorWillRespawn: () => false });
    const r = await runApply(ports, ctx());
    expect(r.status).toBe('deferred');
    expect(r.status === 'deferred' && r.reason).toMatch(/not supervised/);
    // Refused before the ~144 MB download and before any ledger entry, so it
    // costs nothing and leaves no in-flight lock to release.
    expect(ports.download).not.toHaveBeenCalled();
    expect(ports.preserveAndSwap).not.toHaveBeenCalled();
    expect(ports.requestRestart).not.toHaveBeenCalled();
  });

  it('fails CLOSED when the supervisor is unknown', async () => {
    // A caller that never wires the port must not be told an update is safe:
    // absent is un-supervised, not "assume yes".
    const ports = makePorts();
    delete (ports as { supervisorWillRespawn?: unknown }).supervisorWillRespawn;
    const r = await runApply(ports, ctx());
    expect(r.status).toBe('deferred');
    expect(ports.download).not.toHaveBeenCalled();
  });

  it('names what to do, not just what went wrong', async () => {
    const ports = makePorts({ supervisorWillRespawn: () => false });
    const r = await runApply(ports, ctx());
    // The owner is stuck until they change something; the reason must say what.
    expect(r.status === 'deferred' && r.reason).toMatch(/respawning supervisor/);
    expect(r.status === 'deferred' && r.reason).toMatch(/recued update apply/);
  });

  it('⛔ a stale realm cannot apply over a shared executable another realm already replaced', async () => {
    const ports = makePorts({
      installedVersion: () => '1.4.2',
      preserveAndSwap: vi.fn(),
    });
    const result = await runApply(ports, ctx({ fromVersion: '1.3.0', toVersion: '1.4.2' }));
    expect(result).toMatchObject({ status: 'deferred', reason: expect.stringMatching(/shared executable.*restart/i) });
    expect(ports.download).not.toHaveBeenCalled();
    expect(ports.preserveAndSwap).not.toHaveBeenCalled();
    expect(ports.ledger.readAll()).toEqual([]);
  });

  it('not-configured with no trusted key (no download)', async () => {
    const ports = makePorts({ trustedPubkey: '' });
    const r = await runApply(ports, ctx());
    expect(r.status).toBe('not-configured');
    expect(ports.download).not.toHaveBeenCalled();
  });

  it('happy path: download→verify→restart→(drain)→swap, ledger started+staged', async () => {
    const ports = makePorts({ snapshotRef: '/realms/a/update-snapshot.db' });
    const r = await applyAndCommit(ports, ctx());
    expect(r).toMatchObject({
      status: 'restarting',
      operationId: expect.any(String),
    });
    expect(ports.preserveAndSwap).toHaveBeenCalledOnce();
    expect(ports.requestRestart).toHaveBeenCalledOnce();
    const kinds = ports.ledger.readAll().map((e) => e.kind);
    expect(kinds).toEqual(['apply_started', 'apply_staged']);
    expect(ports.ledger.readAll()[0]?.snapshot_ref).toBe('/realms/a/update-snapshot.db');
  });

  // ⛔⛔ THE ORDERING THAT COST DATA. The swap (and the snapshot with it) used to
  // run BEFORE `requestRestart`, and the server kept serving across the whole gap
  // — so a migrating apply snapshotted the database minutes before writers were
  // stopped, and every write in between was silently absent from the rollback
  // target. The commit now runs INSIDE the drain, which is the only quiet moment.
  it('swaps inside the restart drain, not before requesting the restart', async () => {
    const order: string[] = [];
    const ports = makePorts({
      preserveAndSwap: vi.fn(() => order.push('swap')),
      takeSnapshot: vi.fn(async () => { order.push('snapshot'); }),
      requestRestart: vi.fn((onDrained?: (ok: boolean) => void | Promise<void>) => {
        order.push('restart');
        pendingCommits.push(Promise.resolve(onDrained?.(true)));
      }),
    });
    await applyAndCommit(ports, ctx({ migration: true }));
    expect(order).toEqual(['restart', 'snapshot', 'swap']);
  });

  // D-152 § A.16 — best-effort webclient sync, before the restart handoff. It
  // touches no database, so it deliberately does NOT move into the drain: doing
  // so would add a ~30 MB download to the downtime on every webclient release.
  it('calls syncWebclient with the artifact BEFORE the restart', async () => {
    const order: string[] = [];
    const syncWebclient = vi.fn(async () => {
      order.push('sync');
      return 'bundle-replaced' as const;
    });
    const ports = makePorts({
      preserveAndSwap: vi.fn(() => order.push('swap')),
      requestRestart: vi.fn((onDrained?: (ok: boolean) => void | Promise<void>) => {
        order.push('restart');
        pendingCommits.push(Promise.resolve(onDrained?.(true)));
      }),
      syncWebclient,
    });
    const wc = { url: 'https://x/wc', sha256: 'ww', sig: 'wsig' };
    const r = await applyAndCommit(ports, ctx({ webclientArtifact: wc }));
    expect(r.status).toBe('restarting');
    expect(syncWebclient).toHaveBeenCalledWith(wc, expect.objectContaining({
      releaseIdentity: expect.any(String),
      operationId: expect.any(String),
    }));
    expect(order).toEqual(['sync', 'restart', 'swap']);
  });

  // ⛔⛔ THE LEASE HAS TO OUTLIVE THIS FUNCTION, because the swap does. Moving the
  // snapshot + swap into the drain put the only step that writes the binary
  // OUTSIDE the scope meant to exclude other writers: the rpc returned, the lease
  // was released, and the commit ran seconds later holding nothing. The ledger
  // still refuses another APPLY, but `install.sh` reads the LEASE — so an
  // installer run in that gap renames over the same files mid-swap.
  it('still holds the update lease while the deferred commit swaps', async () => {
    const events: string[] = [];
    let heldAtSwap: boolean | null = null;
    let held = false;
    const ports = makePorts({
      acquireUpdateLease: () => {
        held = true;
        events.push('acquire');
        return { release: () => { held = false; events.push('release'); } };
      },
      preserveAndSwap: vi.fn(() => { heldAtSwap = held; events.push('swap'); }),
    });

    const r = await runApply(ports, ctx());
    expect(r.status).toBe('restarting');
    await flushCommits();

    // ⚠ NOT "released after the return" — this double invokes the drain callback
    // synchronously, so the commit can finish before `runApply` resolves and the
    // ORDER OF THOSE TWO IS THE HARNESS'S, not the property's. What production
    // and this both owe is that the swap happens while the lease is held.
    expect(heldAtSwap, 'the swap must happen under the lease').toBe(true);
    // …and released once, after it.
    expect(events).toEqual(['acquire', 'swap', 'release']);
  });

  it('releases the lease immediately on a path that schedules no commit', async () => {
    const events: string[] = [];
    const ports = makePorts({
      acquireUpdateLease: () => {
        events.push('acquire');
        return { release: () => events.push('release') };
      },
      verifyArtifact: vi.fn(() => ({ ok: false, reason: 'sha256 mismatch' })),
    });
    expect((await runApply(ports, ctx())).status).toBe('verify-failed');
    expect(events).toEqual(['acquire', 'release']);
  });

  // ⛔⛔ A DRAIN THAT DID NOT COMPLETE MEANS A WRITER MAY STILL HOLD THE DATABASE,
  // so the commit must change NOTHING — not snapshot it, not swap onto it — and
  // must terminate the operation so the next apply is not wedged behind it.
  it('an incomplete drain stages nothing and terminates the apply as failed', async () => {
    const ports = makePorts({
      requestRestart: vi.fn((onDrained?: (ok: boolean) => void | Promise<void>) => {
        pendingCommits.push(Promise.resolve(onDrained?.(false)));
      }),
    });
    await applyAndCommit(ports, ctx({ migration: true }));
    expect(ports.takeSnapshot).not.toHaveBeenCalled();
    expect(ports.preserveAndSwap).not.toHaveBeenCalled();
    expect(ports.discardStaged).toHaveBeenCalled();
    expect(ports.ledger.readAll().map((e) => e.kind)).toEqual(['apply_started', 'apply_reverted']);
    expect(deriveInFlightRelease(ports.ledger)).toBeNull();
    const terminal = ports.ledger.readAll()[1];
    expect(String(terminal?.detail)).toMatch(/not quiesced at commit time/);
  });

  // ⛔⛔ THE BUNDLE IS PROMOTED BEFORE THE COMMIT, SO EVERY ABORT OWES AN UNDO.
  //
  // The sync stays outside the drain deliberately — a ~30 MB download must not be
  // added to the downtime — but that leaves the new UI live while the binary swap
  // has not happened yet. The abort branches discarded only the staged BINARY, so
  // a failed drain or a failed swap left the next boot running the OLD server
  // behind the NEW UI. The code called that "cosmetic". It is not: `min_supported`
  // exists because that direction breaks — a server predating 26.8.12 does not
  // read the WS bearer from the subprotocol the current client sends and 401s the
  // handshake, so the webclient cannot talk to it at all.
  const promoted = () => vi.fn(async () => 'bundle-replaced' as const);

  it('⛔ RESTORES the promoted bundle when the drain does not complete', async () => {
    const undoWebclient = vi.fn(() => true);
    const ports = makePorts({
      syncWebclient: promoted(),
      undoWebclient,
      requestRestart: vi.fn((onDrained?: (ok: boolean) => void | Promise<void>) => {
        pendingCommits.push(Promise.resolve(onDrained?.(false)));
      }),
    });
    await applyAndCommit(ports, ctx({ webclientArtifact: { url: 'u', sha256: 's', sig: 'g' } }));
    expect(undoWebclient, 'the new UI must not outlive the abort')
      .toHaveBeenCalledWith('bundle-replaced', expect.objectContaining({
        releaseIdentity: expect.any(String),
        operationId: expect.any(String),
      }));
  });

  it('⛔ RESTORES it when the swap itself fails', async () => {
    const undoWebclient = vi.fn(() => true);
    const ports = makePorts({
      syncWebclient: promoted(),
      undoWebclient,
      preserveAndSwap: vi.fn(() => { throw new Error('rename failed'); }),
    });
    await applyAndCommit(ports, ctx({ webclientArtifact: { url: 'u', sha256: 's', sig: 'g' } }));
    expect(undoWebclient).toHaveBeenCalledWith('bundle-replaced', expect.objectContaining({
      releaseIdentity: expect.any(String),
      operationId: expect.any(String),
    }));
  });

  it('and does NOT restore it when the apply commits — the arm that proves the two above', async () => {
    const undoWebclient = vi.fn(() => true);
    const ports = makePorts({ syncWebclient: promoted(), undoWebclient });
    await applyAndCommit(ports, ctx({ webclientArtifact: { url: 'u', sha256: 's', sig: 'g' } }));
    expect(undoWebclient, 'a committed release keeps its own UI').not.toHaveBeenCalled();
  });

  it('⛔⛔ does NOT restore when THIS apply never promoted a bundle', async () => {
    // The hazard a naive fix walks into. `<dir>.old` SURVIVES a successful apply
    // — the sync clears it at the start of the NEXT sync, not at the end of its
    // own — so "restore if a backup exists" would, on an apply that never synced,
    // install the generation BEFORE the running server's UI in front of it. The
    // signal has to be THIS apply's own sync result, not the state of the disk.
    const undoWebclient = vi.fn(() => true);
    const ports = makePorts({
      syncWebclient: vi.fn(async () => 'none' as const), // e.g. no filesystem mutation
      undoWebclient,
      requestRestart: vi.fn((onDrained?: (ok: boolean) => void | Promise<void>) => {
        pendingCommits.push(Promise.resolve(onDrained?.(false)));
      }),
    });
    await applyAndCommit(ports, ctx({ webclientArtifact: { url: 'u', sha256: 's', sig: 'g' } }));
    expect(undoWebclient, 'nothing of ours is parked, so nothing is ours to put back')
      .not.toHaveBeenCalled();
  });

  it('a restore that THROWS terminals the operation with a durable recovery obligation', async () => {
    // The operation lock is released by the terminal ledger entry, while the
    // explicit recovery bit keeps the retained journal actionable before serve.
    const ports = makePorts({
      syncWebclient: promoted(),
      undoWebclient: vi.fn(() => { throw new Error('permission denied'); }),
      requestRestart: vi.fn((onDrained?: (ok: boolean) => void | Promise<void>) => {
        pendingCommits.push(Promise.resolve(onDrained?.(false)));
      }),
    });
    await applyAndCommit(ports, ctx({ webclientArtifact: { url: 'u', sha256: 's', sig: 'g' } }));
    const terminal = ports.ledger.readAll().find((entry) => entry.kind === 'apply_reverted');
    expect(terminal, 'the operation must still be terminated').toMatchObject({
      webclient_recovery_pending: true,
      detail: expect.stringMatching(/webclient recovery remains pending/),
    });
  });

  it('a restore that returns false carries the same pre-open recovery obligation', async () => {
    const ports = makePorts({
      syncWebclient: promoted(),
      undoWebclient: vi.fn(() => false),
      preserveAndSwap: vi.fn(() => { throw new Error('rename failed'); }),
    });
    await applyAndCommit(ports, ctx({ webclientArtifact: { url: 'u', sha256: 's', sig: 'g' } }));
    expect(ports.ledger.readAll().find((entry) => entry.kind === 'apply_reverted'))
      .toMatchObject({ webclient_recovery_pending: true });
  });

  it('does not call syncWebclient when the release carries no webclient artifact', async () => {
    const syncWebclient = vi.fn(async () => 'bundle-replaced' as const);
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
    const r = await applyAndCommit(ports, ctx({ libArtifact: LIB }));
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
    const r = await applyAndCommit(ports, ctx({ libArtifact: null }));
    expect(r.status).toBe('restarting');
    expect(ports.download).toHaveBeenCalledOnce();
    expect(ports.preserveAndSwap).toHaveBeenCalledWith(false);
  });

  it('ignores ctx.libArtifact on an install with no managed sidecar path', async () => {
    // No `stagedLibPath` → nowhere to stage it. Must swap the exe alone rather
    // than download to `undefined` or silently claim a sidecar was applied.
    const ports = makePorts();
    const r = await applyAndCommit(ports, ctx({ libArtifact: LIB }));
    expect(r.status).toBe('restarting');
    expect(ports.download).toHaveBeenCalledOnce();
    expect(ports.preserveAndSwap).toHaveBeenCalledWith(false);
  });

  it('takes a pre-migration snapshot before the swap when migrating', async () => {
    const ports = makePorts();
    const order: string[] = [];
    (ports.takeSnapshot as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push('snapshot'); });
    (ports.preserveAndSwap as ReturnType<typeof vi.fn>).mockImplementation(() => { order.push('swap'); });
    await applyAndCommit(ports, ctx({ migration: true }));
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

  // ⚠ The failure is now reported by the LEDGER, not the return value: the commit
  // runs after `runApply` has answered `restarting`, so the terminal it appends is
  // what says the release was not staged (and what `update.progress` mirrors).
  it('snapshot failure releases the lock (no wedge, no swap)', async () => {
    const ports = makePorts({ takeSnapshot: vi.fn(async () => { throw new Error('disk full'); }) });
    await applyAndCommit(ports, ctx({ migration: true }));
    expect(ports.preserveAndSwap).not.toHaveBeenCalled();
    expect(deriveInFlightRelease(ports.ledger)).toBeNull();
    const terminal = ports.ledger.readAll()[1];
    expect(terminal?.kind).toBe('apply_reverted');
    expect(String(terminal?.detail)).toContain('disk full');
    expect(ports.discardStaged).toHaveBeenCalled();
  });

  it('refuses a concurrent apply while one is in flight (ledger-derived lock)', async () => {
    const ports = makePorts();
    await applyAndCommit(ports, ctx()); // leaves apply_staged (in flight until commit)
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

describe('durable update receipt reservation', () => {
  it('is answerable before apply_started and is not itself an apply lock', () => {
    const ports = makePorts();
    reserveUpdateOperationReceipt(ports, 'receipt-1', 'update', '1.3.0', 'stable', 100);
    expect(resolveUpdateOperationOutcome(ports.ledger, 'receipt-1', '1.3.0')).toEqual({
      status: 'waiting_for_restart',
      operation: 'update',
    });
    expect(deriveInFlightRelease(ports.ledger)).toBeNull();
  });

  it('settles a predecessor process reservation on the next boot', () => {
    const ports = makePorts();
    reserveUpdateOperationReceipt(ports, 'receipt-2', 'update', '1.3.0', 'stable', 100);
    expect(reconcileAbandonedUpdateReservations(ports, 200)).toBe(1);
    expect(reconcileAbandonedUpdateReservations(ports, 200)).toBe(0);
    expect(resolveUpdateOperationOutcome(ports.ledger, 'receipt-2', '1.3.0')).toEqual({
      status: 'reverted',
      operation: 'update',
    });
  });

  it('never settles a reservation owned by the current process', () => {
    const ports = makePorts();
    reserveUpdateOperationReceipt(ports, 'receipt-3', 'update', '1.3.0', 'stable', 100);
    expect(reconcileAbandonedUpdateReservations(ports, 100)).toBe(0);
    expect(ports.ledger.readAll().map((entry) => entry.kind)).toEqual(['operation_reserved']);
  });

  it('settles a predecessor reservation even when the OS reused its PID', () => {
    const ports = makePorts();
    ports.ledger.append({
      id: 'reservation:receipt-reused-pid',
      kind: 'operation_reserved',
      at: 1,
      from_version: '1.3.0',
      to_version: '1.3.0',
      channel: 'stable',
      trigger: 'manual',
      release_identity: 'stable:1.3.0',
      reserved_operation_id: 'receipt-reused-pid',
      reserved_operation: 'update',
      reservation_process_id: 100,
    });

    expect(reconcileAbandonedUpdateReservations(ports, 100)).toBe(1);
    expect(resolveUpdateOperationOutcome(ports.ledger, 'receipt-reused-pid', '1.3.0')).toEqual({
      status: 'reverted',
      operation: 'update',
    });
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
  it('⛔ a stale realm cannot roll back a shared executable owned by a newer disk generation', () => {
    const ports = makePorts({ installedVersion: () => '1.5.0', rollbackSwap: vi.fn() });
    const result = runRollback(ports, {
      releaseIdentity: 'stable:1.4.2',
      fromVersion: '1.3.0',
      toVersion: '1.4.2',
      channel: 'stable',
      appliedMigration: false,
    });
    expect(result).toMatchObject({ status: 'refused', reason: expect.stringMatching(/shared executable.*restart/i) });
    expect(ports.rollbackSwap).not.toHaveBeenCalled();
  });
  it('refuses past a migration with no snapshot', () => {
    const ports = makePorts({ hasSnapshot: () => false });
    const r = runRollback(ports, { releaseIdentity: 'stable:1.4.2', fromVersion: '1.4.2', toVersion: '1.3.0', channel: 'stable', appliedMigration: true });
    expect(r.status).toBe('refused');
    expect(ports.rollbackSwap).not.toHaveBeenCalled();
  });
  it('records a staged-rollout bypass on the entry that OPENS the apply', async () => {
    // `trigger: 'manual'` alone could not tell "took a release meant for them"
    // from "jumped the queue", so the ledger could not answer afterwards which
    // installs opted in early. Written on `apply_started` so the record exists
    // even if the apply then fails.
    const ports = makePorts({ download: vi.fn(async () => { throw new Error('x'); }) });
    await runApply(ports, {
      releaseIdentity: 'stable:2.0.0',
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
      channel: 'stable',
      migration: false,
      artifact: { url: 'u', sha256: 'h' },
      libArtifact: { url: 'lu', sha256: 'lh' },
      trigger: 'manual',
      rolloutBypass: { rolloutPct: 40 },
    } as Parameters<typeof runApply>[1]);
    const started = ports.ledger.readAll().find((r) => r.kind === 'apply_started');
    expect(started?.detail).toMatch(/staged-rollout bypass.*40%/);
  });

  it('an in-cohort apply carries NO bypass note', async () => {
    const ports = makePorts({ download: vi.fn(async () => { throw new Error('x'); }) });
    await runApply(ports, {
      releaseIdentity: 'stable:2.0.0',
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
      channel: 'stable',
      migration: false,
      artifact: { url: 'u', sha256: 'h' },
      libArtifact: { url: 'lu', sha256: 'lh' },
      trigger: 'manual',
    } as Parameters<typeof runApply>[1]);
    const started = ports.ledger.readAll().find((r) => r.kind === 'apply_started');
    expect(started?.detail ?? '').not.toMatch(/staged-rollout bypass/);
  });

  it('⛔ an apply is BUSY when another process holds the update lease', async () => {
    // The lease is the thing that makes the ledger read + `apply_started` append
    // indivisible. Without it two processes both pass the in-flight check and
    // both write the same fixed `.staged` / `.old` paths.
    const ports = makePorts({
      acquireUpdateLease: () => { throw new Error('held'); },
      download: vi.fn(),
    });
    const res = await runApply(ports, {
      releaseIdentity: 'stable:2.0.0',
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
      channel: 'stable',
      migration: false,
      artifact: { url: 'u', sha256: 'h' },
      libArtifact: { url: 'lu', sha256: 'lh' },
      trigger: 'manual',
    } as Parameters<typeof runApply>[1]);
    expect(res.status).toBe('busy');
    // Refused BEFORE the ~144 MB download, not after it.
    expect(ports.download).not.toHaveBeenCalled();
  });

  it('releases the lease when the apply finishes', async () => {
    const release = vi.fn();
    const ports = makePorts({ trustedPubkey: undefined });
    ports.acquireUpdateLease = () => ({ release });
    await runApply(ports, {
      releaseIdentity: 'stable:2.0.0',
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
      channel: 'stable',
      migration: false,
      artifact: { url: 'u', sha256: 'h' },
      libArtifact: { url: 'lu', sha256: 'lh' },
      trigger: 'manual',
    } as Parameters<typeof runApply>[1]);
    // `not-configured` returns before the lease is even taken, so nothing to
    // release — the arm that matters is that a TAKEN lease always comes back.
    const ports2 = makePorts();
    ports2.acquireUpdateLease = () => ({ release });
    ports2.download = vi.fn(async () => { throw new Error('network'); });
    await runApply(ports2, {
      releaseIdentity: 'stable:2.0.0',
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
      channel: 'stable',
      migration: false,
      artifact: { url: 'u', sha256: 'h' },
      libArtifact: { url: 'lu', sha256: 'lh' },
      trigger: 'manual',
    } as Parameters<typeof runApply>[1]);
    expect(release).toHaveBeenCalled();
  });

  it('⛔ REFUSES a rollback nothing would restart', () => {
    // Apply has always had this gate; rollback had none — so an unsupervised
    // server could roll back, exit, and stay down. Worse than for apply: the
    // owner reaches for rollback precisely BECAUSE something is already wrong.
    const ports = makePorts({
      supervisorWillRespawn: () => false,
      rollbackSwap: vi.fn(),
      restoreSnapshot: vi.fn(),
    });
    const res = runRollback(ports, {
      releaseIdentity: 'stable:2.0.0',
      fromVersion: '2.0.0',
      toVersion: '1.0.0',
      channel: 'stable',
      appliedMigration: false,
    });
    expect(res.status).toBe('refused');
    expect(res.status === 'refused' && res.reason).toMatch(/not supervised/);
    expect(res.status === 'refused' && res.reason).toMatch(/recued update rollback/);
    expect(ports.rollbackSwap).not.toHaveBeenCalled();
  });

  it('⛔ sees an apply that starts DURING the lease acquisition', () => {
    // The reported probe: the ledger was read BEFORE the lease was taken and
    // never re-read, so an `apply_started` written while acquiring was invisible
    // and the rollback proceeded regardless. Modelled by writing that entry from
    // inside the acquire — the one moment the old ordering could not see.
    const ports = makePorts({ rollbackSwap: vi.fn(), restoreSnapshot: vi.fn() });
    ports.acquireUpdateLease = () => {
      ports.ledger.append({
        id: 'concurrent', kind: 'apply_started', at: 1,
        from_version: '2.0.0', to_version: '3.0.0', channel: 'stable',
        trigger: 'manual', release_identity: 'stable:3.0.0', migration: false,
      });
      return { release: () => {} };
    };
    const res = runRollback(ports, {
      releaseIdentity: 'stable:2.0.0',
      fromVersion: '2.0.0',
      toVersion: '1.0.0',
      channel: 'stable',
      appliedMigration: false,
    });
    expect(res.status).toBe('busy');
    expect(ports.rollbackSwap).not.toHaveBeenCalled();
  });

  it('⛔ a rollback is BUSY when another process holds the update lease', () => {
    const ports = makePorts({
      acquireUpdateLease: () => { throw new Error('held'); },
      rollbackSwap: vi.fn(),
    });
    const res = runRollback(ports, {
      releaseIdentity: 'stable:2.0.0',
      fromVersion: '2.0.0',
      toVersion: '1.0.0',
      channel: 'stable',
      appliedMigration: false,
    });
    expect(res.status).toBe('busy');
    expect(ports.rollbackSwap).not.toHaveBeenCalled();
  });

  it('⛔ REFUSES a snapshot-restoring rollback while this process holds the db open', () => {
    // The defect this guard exists for: `restoreSnapshot` replaces the database
    // FILE, and with a handle open the process keeps serving the unlinked inode
    // and accepts writes no later reader can see. Reproduced 2026-08-31.
    const ports = makePorts({
      hasSnapshot: () => true,
      holdsDatabaseOpen: () => true,
      restoreSnapshot: vi.fn(),
      rollbackSwap: vi.fn(),
    });
    const res = runRollback(ports, {
      releaseIdentity: 'stable:2.0.0',
      fromVersion: '2.0.0',
      toVersion: '1.0.0',
      channel: 'stable',
      appliedMigration: true,
    });
    expect(res.status).toBe('refused');
    expect(ports.restoreSnapshot).not.toHaveBeenCalled();
    expect(ports.rollbackSwap).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED — an unwired holdsDatabaseOpen port reads as open', () => {
    // A caller that forgets to answer gets the refusal, never the data loss.
    const ports = makePorts({ hasSnapshot: () => true, restoreSnapshot: vi.fn() });
    delete (ports as { holdsDatabaseOpen?: unknown }).holdsDatabaseOpen;
    const res = runRollback(ports, {
      releaseIdentity: 'stable:2.0.0',
      fromVersion: '2.0.0',
      toVersion: '1.0.0',
      channel: 'stable',
      appliedMigration: true,
    });
    expect(res.status).toBe('refused');
    expect(ports.restoreSnapshot).not.toHaveBeenCalled();
  });

  it('a binary-only rollback is STILL allowed with the db open (atomic rename)', () => {
    const ports = makePorts({
      hasSnapshot: () => false,
      holdsDatabaseOpen: () => true,
      rollbackSwap: vi.fn(),
    });
    const res = runRollback(ports, {
      releaseIdentity: 'stable:2.0.0',
      fromVersion: '2.0.0',
      toVersion: '1.0.0',
      channel: 'stable',
      appliedMigration: false,
    });
    expect(res.status).toBe('rolled-back');
    expect(ports.rollbackSwap).toHaveBeenCalled();
  });

  it('restores the snapshot BEFORE swapping the binary (skew-safe order)', () => {
    const order: string[] = [];
    const ports = makePorts({
      hasSnapshot: () => true,
      restoreSnapshot: vi.fn(() => { order.push('restore'); }),
      rollbackSwap: vi.fn(() => { order.push('swap'); }),
      markManualRollbackPhase: vi.fn((_operationId, phase) => { order.push(phase); }),
    });
    const originalAppend = ports.ledger.append.bind(ports.ledger);
    ports.ledger.append = (entry) => {
      if (entry.kind === 'rolled_back') order.push('receipt');
      originalAppend(entry);
    };
    const r = runRollback(ports, { releaseIdentity: 'stable:1.4.2', fromVersion: '1.4.2', toVersion: '1.3.0', channel: 'stable', appliedMigration: true });
    expect(r).toMatchObject({
      status: 'rolled-back',
      restored_snapshot: true,
      operationId: expect.any(String),
    });
    expect(order).toEqual([
      'restore',
      'snapshot-restored',
      'receipt',
      'swap',
      'pair-rolled-back',
    ]);
  });

  it('durably journals a manual rollback before mutation and drops it only after the receipt', () => {
    const order: string[] = [];
    const ports = makePorts({
      beginManualRollbackJournal: vi.fn(() => { order.push('journal'); }),
      rollbackSwap: vi.fn(() => { order.push('swap'); }),
      markManualRollbackPhase: vi.fn((_operationId, phase) => { order.push(phase); }),
      dropManualRollbackJournal: vi.fn(() => { order.push('drop'); }),
    });
    const originalAppend = ports.ledger.append.bind(ports.ledger);
    ports.ledger.append = (entry) => {
      if (entry.kind === 'rolled_back') order.push('receipt');
      originalAppend(entry);
    };
    const result = runRollback(ports, {
      releaseIdentity: 'stable:1.4.2',
      fromVersion: '1.3.0',
      toVersion: '1.4.2',
      channel: 'stable',
      appliedMigration: false,
      operationId: 'manual-receipt',
    });
    expect(result).toMatchObject({ status: 'rolled-back', operationId: 'manual-receipt' });
    expect(order).toEqual(['journal', 'receipt', 'swap', 'pair-rolled-back', 'drop']);
  });

  it('refuses before the binary swap when its write-ahead receipt cannot commit', () => {
    const restart = vi.fn();
    const dropJournal = vi.fn();
    const abortJournal = vi.fn();
    const ports = makePorts({
      beginManualRollbackJournal: vi.fn(),
      rollbackSwap: vi.fn(),
      abortManualRollbackJournal: abortJournal,
      dropManualRollbackJournal: dropJournal,
      requestRestart: restart,
    });
    ports.ledger.append = (entry) => {
      if (entry.kind === 'rolled_back') throw new Error('disk full after physical swap');
    };

    const result = runRollback(ports, {
      releaseIdentity: 'stable:1.4.2',
      fromVersion: '1.3.0',
      toVersion: '1.4.2',
      channel: 'stable',
      appliedMigration: false,
      operationId: 'receipt-recovered-on-boot',
    });

    expect(result).toMatchObject({
      status: 'refused',
      reason: expect.stringMatching(/before swapping the binary/),
    });
    expect(ports.rollbackSwap).not.toHaveBeenCalled();
    expect(abortJournal).toHaveBeenCalledOnce();
    expect(restart).not.toHaveBeenCalled();
    expect(dropJournal).not.toHaveBeenCalled();
  });

  it('requests recovery after a post-commit pair-swap failure', () => {
    const restart = vi.fn();
    const ports = makePorts({
      beginManualRollbackJournal: vi.fn(),
      rollbackSwap: vi.fn(() => { throw new Error('rename failed'); }),
      requestRestart: restart,
    });

    const result = runRollback(ports, {
      releaseIdentity: 'stable:1.4.2',
      fromVersion: '1.3.0',
      toVersion: '1.4.2',
      channel: 'stable',
      appliedMigration: false,
      operationId: 'swap-recovered-on-boot',
    });

    expect(result).toEqual({
      status: 'rolled-back',
      restored_snapshot: false,
      operationId: 'swap-recovered-on-boot',
      recovery_pending: true,
    });
    expect(ports.ledger.readAll()).toContainEqual(expect.objectContaining({
      id: 'swap-recovered-on-boot',
      kind: 'rolled_back',
    }));
    expect(restart).toHaveBeenCalledOnce();
  });

  it('refuses before mutation when the manual rollback journal cannot be made durable', () => {
    const ports = makePorts({
      beginManualRollbackJournal: () => { throw new Error('read-only volume'); },
      rollbackSwap: vi.fn(),
    });
    const result = runRollback(ports, {
      releaseIdentity: 'stable:1.4.2',
      fromVersion: '1.3.0',
      toVersion: '1.4.2',
      channel: 'stable',
      appliedMigration: false,
    });
    expect(result).toMatchObject({ status: 'refused' });
    expect(ports.rollbackSwap).not.toHaveBeenCalled();
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

/** ⛔⛔ EVERY PRODUCTION COMPOSITION ROOT MUST WIRE `supervisorWillRespawn`.
 *
 *  The port is OPTIONAL and fails CLOSED, so a root that forgets it does not
 *  crash — it silently refuses every apply. That already happened: the guard
 *  landed wired only in `compose-listeners.ts`, and `recued update apply` was
 *  refused every time because `cli-context/update.ts` builds its own deps.
 *
 *  ⛔ NOTHING CAUGHT IT. Removing the CLI's line reds nothing in 23,820 tests —
 *  every CLI test stops at a guard before apply (`runningAsPackagedBinary` exits
 *  2 in a test process), so no test reaches `runApply` through the CLI. It was
 *  found by the owner asking how many update paths there are.
 *
 *  🔑 A caller-obligation contract needs a SIBLING SWEEP, not one call site
 *  fixed at a time: the next root added has the same silent failure available to
 *  it. This walks the shipped sources instead of trusting a grep done once. */
describe('the supervisor port is wired at every production composition root', () => {
  const SRC = resolve(import.meta.dirname, '..');

  const shippedFiles = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir)) {
      // `__tests__` and `dev/` never ship; harnesses may omit the port freely.
      if (entry === '__tests__' || entry === 'dev' || entry === 'node_modules') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) shippedFiles(full, out);
      else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
    }
    return out;
  };

  it('no shipped file builds orchestrator deps without it', () => {
    const offenders: string[] = [];
    for (const file of shippedFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      const at = text.indexOf('buildApplyOrchestratorDeps({');
      if (at === -1) continue;
      // The object literal, up to the closing `});` of this call.
      const body = text.slice(at, text.indexOf('});', at));
      if (!body.includes('supervisorWillRespawn')) {
        offenders.push(relative(SRC, file));
      }
    }
    // A failure here means that root refuses every update, silently.
    expect(offenders).toEqual([]);
  });

  it('finds the roots at all — a sweep that matches nothing proves nothing', () => {
    const roots = shippedFiles(SRC)
      .filter((f) => readFileSync(f, 'utf8').includes('buildApplyOrchestratorDeps({'));
    // Positive control: today there are exactly two (the served server and the
    // CLI). If this drops to zero the sweep above is vacuous, not clean.
    expect(roots.length).toBeGreaterThanOrEqual(2);
  });
});
