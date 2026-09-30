import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runUpdateBootReconcile, type UpdateAuditSink } from '../update/boot-reconcile.js';
import type { ApplyOrchestratorPorts } from '../update/apply-orchestrator.js';
import type { UpdateLedgerEntry } from '../update/update-ledger.js';
import { UpdateLeaseHeldError } from '../update/update-lease.js';

const memLedger = (seed: UpdateLedgerEntry[] = []) => {
  const rows = [...seed];
  return {
    rows,
    append: (e: UpdateLedgerEntry) => rows.push(e),
    readAll: () => rows.slice(),
    tail: (n: number) => rows.slice(-n),
  };
};

// A release-aware in-memory boot-failure counter (mirrors the file-backed one).
const memCounter = (seed?: { count: number; release: string }) => {
  let state = seed ? { count: seed.count, release: seed.release } : { count: 0, release: '' };
  return {
    read: (rel?: string) => (rel !== undefined && state.release !== rel ? 0 : state.count),
    increment: (rel: string) => {
      state = state.release === rel ? { count: state.count + 1, release: rel } : { count: 1, release: rel };
      return state.count;
    },
    reset: () => { state = { count: 0, release: '' }; },
  };
};

const entry = (over: Partial<UpdateLedgerEntry> & Pick<UpdateLedgerEntry, 'kind'>): UpdateLedgerEntry => ({
  id: `id-${over.kind}-${over.release_identity ?? 'x'}`,
  at: 1,
  from_version: '1.3.0',
  to_version: '1.4.0',
  channel: 'stable',
  trigger: 'manual',
  release_identity: 'stable:1.4.0',
  ...over,
});

const ports = (over: Partial<ApplyOrchestratorPorts> = {}): ApplyOrchestratorPorts => ({
  ledger: memLedger(),
  bootFailureCounter: memCounter(),
  download: async () => {},
  verifyArtifact: () => ({ ok: true }),
  preserveAndSwap: () => {},
  rollbackSwap: vi.fn(),
  discardStaged: vi.fn(),
  takeSnapshot: async () => {},
  restoreSnapshot: vi.fn(),
  hasPreviousBinary: () => true,
  hasSnapshot: () => true,
  isQuiesced: () => true,
  // ⛔ MODELS A REAL RESTART: the production wiring runs the drain and then calls
  // back, and the auto-revert's disk work now lives in that callback because it
  // is the only window where the database is closed. A double that swallows the
  // callback would assert a revert that never happened.
  requestRestart: vi.fn((onDrained?: (ok: boolean) => void | Promise<void>) => {
    void onDrained?.(true);
  }),
  newEntryId: (() => { let n = 0; return () => `gen-${n++}`; })(),
  now: () => 99,
  trustedPubkey: 'pk',
  stagedPath: '/tmp/s',
  ...over,
});

const memAudit = () => {
  const rows: Array<{ activity_id: string; action: string; target: string; detail?: string }> = [];
  const sink: UpdateAuditSink = {
    listActivities: async () => rows.map((r) => ({ activity_id: r.activity_id })),
    logActivity: async (e) => { rows.push(e); },
  };
  return { rows, sink };
};

describe('runUpdateBootReconcile', () => {
  it('continues on an empty ledger (no in-flight) and resets the counter', async () => {
    const p = ports();
    const out = await runUpdateBootReconcile({ ports: p, channel: 'stable', currentVersion: '1.4.0' });
    expect(out.action).toBe('continue');
  });

  it('repairs a manual rollback receipt lost after the physical swap', async () => {
    const led = memLedger();
    const dropManualRollbackJournal = vi.fn();
    const p = ports({
      ledger: led,
      inspectManualRollbackJournal: () => ({
        disk: 'rolled-back',
        database: 'not-applicable',
        journal: {
          schema: 2,
          realm_id: '/realms/a.db',
          operation_id: 'rollback-receipt',
          release_identity: 'stable:1.4.0',
          from_version: '1.3.0',
          to_version: '1.4.0',
          channel: 'stable',
          migration: false,
          restored_snapshot: false,
          previous_sha256: 'a'.repeat(64),
          current_sha256: 'b'.repeat(64),
        },
      }),
      dropManualRollbackJournal,
    });
    const out = await runUpdateBootReconcile({
      ports: p,
      channel: 'stable',
      currentVersion: '1.3.0',
    });
    expect(out).toEqual({
      action: 'manual-rollback-recovered',
      releaseIdentity: 'stable:1.4.0',
      completed: true,
    });
    expect(led.rows).toContainEqual(expect.objectContaining({
      id: 'rollback-receipt',
      kind: 'rolled_back',
    }));
    expect(dropManualRollbackJournal).toHaveBeenCalledOnce();
  });

  it('leaves an unrecognized manual rollback generation journal intact', async () => {
    const dropManualRollbackJournal = vi.fn();
    const ownerAlert = vi.fn();
    const p = ports({
      inspectManualRollbackJournal: () => ({
        disk: 'unknown',
        database: 'not-applicable',
        journal: {
          schema: 2,
          realm_id: '/realms/a.db',
          operation_id: 'rollback-receipt',
          release_identity: 'stable:1.4.0',
          from_version: '1.3.0',
          to_version: '1.4.0',
          channel: 'stable',
          migration: false,
          restored_snapshot: false,
          previous_sha256: 'a'.repeat(64),
          current_sha256: 'b'.repeat(64),
        },
      }),
      dropManualRollbackJournal,
    });
    const out = await runUpdateBootReconcile({
      ports: p,
      channel: 'stable',
      currentVersion: '9.9.9',
      ownerAlert,
    });
    expect(out.action).toBe('manual-rollback-recovery-failed');
    expect(ownerAlert).toHaveBeenCalledOnce();
    expect(ownerAlert).toHaveBeenCalledWith({
      kind: 'manual-rollback-recovery-failed',
      release_identity: 'stable:1.4.0',
      reason: 'the live binary matches neither generation recorded by the durable manual rollback journal',
    });
    expect(dropManualRollbackJournal).not.toHaveBeenCalled();
    expect(p.ledger.readAll()).toHaveLength(0);
  });

  it('retains an unchanged migration rollback journal when snapshot restoration is ambiguous', async () => {
    const dropManualRollbackJournal = vi.fn();
    const p = ports({
      inspectManualRollbackJournal: () => ({
        disk: 'unchanged',
        database: 'unproven',
        journal: {
          schema: 2,
          realm_id: '/realms/a.db',
          operation_id: 'rollback-op',
          release_identity: 'stable:1.4.0',
          from_version: '1.3.0',
          to_version: '1.4.0',
          channel: 'stable',
          migration: true,
          restored_snapshot: true,
          previous_sha256: 'a'.repeat(64),
          current_sha256: 'b'.repeat(64),
        },
      }),
      dropManualRollbackJournal,
    });
    const out = await runUpdateBootReconcile({
      ports: p,
      channel: 'stable',
      currentVersion: '1.4.0',
    });
    expect(out).toEqual({
      action: 'manual-rollback-recovery-failed',
      releaseIdentity: 'stable:1.4.0',
      reason: expect.stringMatching(/cannot prove whether its database snapshot was restored/),
    });
    expect(dropManualRollbackJournal).not.toHaveBeenCalled();
    expect(p.ledger.readAll()).toHaveLength(0);
  });

  it('commits a staged release that booted healthy + replays update_applied', async () => {
    const led = memLedger([
      entry({ kind: 'apply_started', id: 'a' }),
      entry({ kind: 'apply_staged', id: 'b' }),
    ]);
    const { rows, sink } = memAudit();
    const p = ports({ ledger: led });
    const ownerAlert = vi.fn();
    const deps = {
      ports: p,
      channel: 'stable' as const,
      currentVersion: '1.4.0',
      auditLog: sink,
      ownerAlert,
    };
    const out = await runUpdateBootReconcile(deps);
    expect(out).toMatchObject({ action: 'commit', releaseIdentity: 'stable:1.4.0' });
    expect(led.rows.some((r) => r.kind === 'apply_committed')).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'update_applied', target: 'stable:1.4.0' });
    expect(ownerAlert).toHaveBeenCalledWith({
      kind: 'update-applied',
      release_identity: 'stable:1.4.0',
      from_version: '1.3.0',
      to_version: '1.4.0',
      channel: 'stable',
      trigger: 'manual',
    });

    await runUpdateBootReconcile(deps);
    expect(ownerAlert, 'the commit terminal prevents another success alert').toHaveBeenCalledOnce();
  });

  it('auto-reverts a staged release that failed boot health (binary swap + rolled_back + restart)', async () => {
    const led = memLedger([
      entry({ kind: 'apply_started', id: 'a', migration: true }),
      entry({ kind: 'apply_staged', id: 'b', migration: true }),
    ]);
    const { rows, sink } = memAudit();
    const order: string[] = [];
    const ownerAlert = vi.fn(() => { order.push('alert'); });
    const requestRestart = vi.fn((onDrained?: (ok: boolean) => void | Promise<void>) => {
      order.push('restart');
      void onDrained?.(true);
    });
    // Counter already at the threshold-minus-one for this release; this boot
    // reports a DIFFERENT current identity (the staged binary didn't take) →
    // increment trips auto-revert.
    const p = ports({
      ledger: led,
      bootFailureCounter: memCounter({ count: 2, release: 'stable:1.4.0' }),
      requestRestart,
    });
    const out = await runUpdateBootReconcile({
      ports: p,
      channel: 'stable',
      currentVersion: '1.3.0',
      auditLog: sink,
      ownerAlert,
    });
    expect(out.action).toBe('auto-revert');
    expect(ownerAlert).toHaveBeenCalledWith({
      kind: 'auto-revert-starting',
      release_identity: 'stable:1.4.0',
      from_version: '1.3.0',
      to_version: '1.4.0',
      reason: 'boot health failed 3 times',
    });
    expect(order, 'notification must begin before lifecycle closes SQLite').toEqual(['alert', 'restart']);
    expect(p.restoreSnapshot).toHaveBeenCalledOnce(); // migration + snapshot present
    expect(p.rollbackSwap).toHaveBeenCalledOnce();
    expect(p.requestRestart).toHaveBeenCalledOnce();
    expect(led.rows.some((r) => r.kind === 'rolled_back')).toBe(true);
    expect(rows[0]).toMatchObject({ action: 'update_rolled_back' });
  });

  it('⛔ repairs only the terminal when the supervisor journal proves the disk already reverted', async () => {
    const led = memLedger([
      entry({ kind: 'apply_started', id: 'a' }),
      entry({ kind: 'apply_staged', id: 'b' }),
    ]);
    const dropRevertJournal = vi.fn();
    const ownerAlert = vi.fn();
    const { rows, sink } = memAudit();
    const p = ports({
      ledger: led,
      revertJournalMatchesCurrent: () => true,
      dropRevertJournal,
    });
    const out = await runUpdateBootReconcile({
      ports: p,
      channel: 'stable',
      currentVersion: '1.3.0',
      auditLog: sink,
      ownerAlert,
    });
    expect(out).toMatchObject({ action: 'revert-complete' });
    expect(p.rollbackSwap, 'a second swap would roll back two generations').not.toHaveBeenCalled();
    expect(led.rows.at(-1)?.kind).toBe('apply_reverted');
    expect(led.rows.at(-1)?.recovery_source).toBe('outer-supervisor');
    expect(dropRevertJournal).toHaveBeenCalledOnce();
    expect(ownerAlert).toHaveBeenCalledWith({
      kind: 'supervisor-revert-complete',
      release_identity: 'stable:1.4.0',
      from_version: '1.3.0',
      to_version: '1.4.0',
      reason: 'the previous binary was already live; repaired its missing recovery receipt',
    });
    expect(rows).toContainEqual(expect.objectContaining({
      action: 'update_rolled_back',
      target: 'stable:1.4.0',
    }));
  });

  it('classifies a typed outer-supervisor terminal independently of its human detail', async () => {
    const led = memLedger([
      entry({ kind: 'apply_started', id: 'a' }),
      entry({ kind: 'apply_staged', id: 'b' }),
      entry({
        kind: 'apply_reverted',
        id: 'typed-outer-revert',
        trigger: 'revert',
        recovery_source: 'outer-supervisor',
        detail: 'launcher restored a verified fallback after exit 126',
      }),
    ]);
    const ownerAlert = vi.fn();
    const { rows, sink } = memAudit();

    await expect(runUpdateBootReconcile({
      ports: ports({ ledger: led }),
      channel: 'stable',
      currentVersion: '1.3.0',
      auditLog: sink,
      ownerAlert,
    })).resolves.toEqual({ action: 'continue' });

    expect(ownerAlert).toHaveBeenCalledWith({
      kind: 'supervisor-revert-complete',
      release_identity: 'stable:1.4.0',
      from_version: '1.3.0',
      to_version: '1.4.0',
      reason: 'launcher restored a verified fallback after exit 126',
    });
    expect(rows).toContainEqual(expect.objectContaining({
      activity_id: 'update:typed-outer-revert',
      action: 'update_rolled_back',
    }));
  });

  it('recognizes and announces a legacy outer-supervisor terminal once', async () => {
    const led = memLedger([
      entry({ kind: 'apply_started', id: 'a' }),
      entry({ kind: 'apply_staged', id: 'b' }),
      entry({
        kind: 'apply_reverted',
        id: 'outer-revert',
        trigger: 'revert',
        // Pre-feature binaries carried the origin only in prose. Keep this
        // fixture field-less to pin additive cross-version recovery.
        detail: 'supervisor revert: boot health failed 3 times (payload exited 126, never started)',
      }),
    ]);
    const ownerAlert = vi.fn();
    const { rows, sink } = memAudit();
    const p = ports({ ledger: led });
    const deps = {
      ports: p,
      channel: 'stable' as const,
      currentVersion: '1.3.0',
      auditLog: sink,
      ownerAlert,
    };

    await expect(runUpdateBootReconcile(deps)).resolves.toEqual({ action: 'continue' });
    expect(ownerAlert).toHaveBeenCalledWith({
      kind: 'supervisor-revert-complete',
      release_identity: 'stable:1.4.0',
      from_version: '1.3.0',
      to_version: '1.4.0',
      reason: 'boot health failed 3 times (payload exited 126, never started)',
    });
    expect(rows).toContainEqual(expect.objectContaining({
      activity_id: 'update:outer-revert',
      action: 'update_rolled_back',
    }));

    await runUpdateBootReconcile(deps);
    expect(ownerAlert, 'the audit replay id deduplicates a completed event').toHaveBeenCalledOnce();
  });

  it('treats a started-but-never-staged leftover as staging-aborted (no replay row)', async () => {
    // ⚠ THE BOOTED BINARY MUST BE THE OLD ONE FOR THIS TO BE "crashed before the
    // swap". This fixture used `currentVersion: '1.4.0'` — the TARGET's version —
    // which describes a binary that IS the staged release, i.e. a swap that
    // completed. It passed only because boot inferred the outcome from the ledger
    // and never looked at the disk. `1.3.0` is what a crash-before-swap actually
    // leaves running.
    const led = memLedger([entry({ kind: 'apply_started', id: 'a' })]);
    const { rows, sink } = memAudit();
    const recoverAbortedWebclient = vi.fn(() => true);
    const p = ports({ ledger: led, recoverAbortedWebclient });
    const ownerAlert = vi.fn();
    const out = await runUpdateBootReconcile({
      ports: p,
      channel: 'stable',
      currentVersion: '1.3.0',
      auditLog: sink,
      ownerAlert,
    });
    expect(out.action).toBe('staging-aborted');
    expect(led.rows.some((r) => r.kind === 'apply_reverted')).toBe(true);
    expect(rows).toHaveLength(0); // apply_reverted is not a user-facing replay row
    expect(ownerAlert, 'an ordinary pre-swap abort is not an owner-facing outcome').not.toHaveBeenCalled();
    expect(recoverAbortedWebclient).toHaveBeenCalledWith({
      releaseIdentity: 'stable:1.4.0',
      operationId: 'a',
    });
  });

  it('leaves the apply open when its pre-swap webclient journal cannot be recovered', async () => {
    const led = memLedger([entry({ kind: 'apply_started', id: 'a' })]);
    const p = ports({ ledger: led, recoverAbortedWebclient: () => false });
    const ownerAlert = vi.fn();
    const out = await runUpdateBootReconcile({
      ports: p,
      channel: 'stable',
      currentVersion: '1.3.0',
      ownerAlert,
    });
    expect(out).toMatchObject({ action: 'webclient-recovery-failed' });
    expect(ownerAlert).toHaveBeenCalledWith({
      kind: 'webclient-recovery-failed',
      release_identity: 'stable:1.4.0',
      reason: 'the durable webclient apply journal was malformed, belonged to another operation, or could not be restored',
    });
    expect(p.discardStaged).not.toHaveBeenCalled();
    expect(led.rows).toHaveLength(1);
  });

  it('does not let a throwing owner notification veto automatic rollback', async () => {
    const led = memLedger([
      entry({ kind: 'apply_started', id: 'a' }),
      entry({ kind: 'apply_staged', id: 'b' }),
    ]);
    const p = ports({
      ledger: led,
      bootFailureCounter: memCounter({ count: 2, release: 'stable:1.4.0' }),
    });

    await expect(runUpdateBootReconcile({
      ports: p,
      channel: 'stable',
      currentVersion: '1.3.0',
      ownerAlert: () => { throw new Error('notification transport is down'); },
    })).resolves.toMatchObject({ action: 'auto-revert' });

    expect(p.requestRestart).toHaveBeenCalledOnce();
    expect(p.rollbackSwap).toHaveBeenCalledOnce();
    expect(led.rows.at(-1)?.kind).toBe('rolled_back');
  });

  it('⛔ a swap whose ledger write was LOST is reconciled from the disk, not undone', async () => {
    // The reported reproduction: the swap completes, the `apply_staged` append
    // fails (ENOSPC, read-only volume, a kill between the two), and only
    // `apply_started` survives. Boot used to read that as "crashed before
    // swapping", discard the staged binary and write `apply_reverted` — for an
    // apply that had succeeded and was, at that moment, the binary doing the
    // reading.
    //
    // The running binary cannot be wrong about which binary it is, so it is the
    // authority here: identity matches the target ⇒ the swap happened.
    const led = memLedger([entry({ kind: 'apply_started', id: 'a' })]);
    const p = ports({ ledger: led });
    const out = await runUpdateBootReconcile({
      ports: p, channel: 'stable', currentVersion: '1.4.0',   // IS the target
    });
    expect(out.action, 'a completed apply must commit, not revert').toBe('commit');
    expect(p.discardStaged, 'nothing may be discarded').not.toHaveBeenCalled();
    expect(led.rows.some((r) => r.kind === 'apply_reverted')).toBe(false);
    // The lost entry is written back, so the ledger stops disagreeing with disk.
    const staged = led.rows.find((r) => r.kind === 'apply_staged');
    expect(staged?.detail).toMatch(/reconciled from disk/);
  });

  it('keeps an unresolved receipt closure out of applied/rolled-back audit history', async () => {
    const led = memLedger([
      entry({
        kind: 'operation_closed',
        id: 'closure',
        closed_operation_id: 'lost-receipt',
        closed_operation: 'update',
        detail: 'owner closed an unresolved operation receipt without asserting its outcome',
      }),
    ]);
    const { rows, sink } = memAudit();
    const p = ports({ ledger: led });

    expect(await runUpdateBootReconcile({
      ports: p,
      channel: 'stable',
      currentVersion: '1.4.0',
      auditLog: sink,
    })).toEqual({ action: 'continue' });
    expect(rows).toHaveLength(0);
    expect(led.rows).toHaveLength(1);
  });

  it('replays idempotently — a committed entry already in audit is not re-emitted', async () => {
    const committed = entry({ kind: 'apply_committed', id: 'done' });
    const led = memLedger([
      entry({ kind: 'apply_started', id: 'a' }),
      entry({ kind: 'apply_staged', id: 'b' }),
      committed,
    ]);
    const { rows, sink } = memAudit();
    rows.push({ activity_id: 'update:done', action: 'update_applied', target: 'stable:1.4.0' });
    const p = ports({ ledger: led });
    const ownerAlert = vi.fn();
    await runUpdateBootReconcile({
      ports: p,
      channel: 'stable',
      currentVersion: '1.4.0',
      auditLog: sink,
      ownerAlert,
    });
    // The pre-seeded terminal was already surfaced, so neither its audit row nor
    // its owner notification is duplicated.
    expect(rows.filter((r) => r.activity_id === 'update:done')).toHaveLength(1);
    expect(ownerAlert).not.toHaveBeenCalled();
  });

  it('replays an unaudited historical commit without announcing it as a new success', async () => {
    const committed = entry({ kind: 'apply_committed', id: 'historical-commit' });
    const led = memLedger([
      entry({ kind: 'apply_started', id: 'a' }),
      entry({ kind: 'apply_staged', id: 'b' }),
      committed,
    ]);
    const { rows, sink } = memAudit();
    const ownerAlert = vi.fn();

    await runUpdateBootReconcile({
      ports: ports({ ledger: led }),
      channel: 'stable',
      currentVersion: '1.4.0',
      auditLog: sink,
      ownerAlert,
    });

    expect(rows).toContainEqual(expect.objectContaining({
      activity_id: 'update:historical-commit',
      action: 'update_applied',
    }));
    expect(ownerAlert).not.toHaveBeenCalled();
  });
});

describe('production boot-reconcile composition', () => {
  const source = readFileSync(
    resolve(import.meta.dirname, '../serve/compose-listeners.ts'),
    'utf8',
  );

  it('binds update owner alerts to the production notification block and forwards the port', () => {
    expect(source).toMatch(
      // The link is resolved when an alert fires, from the server's public address.
      /createUpdateOwnerAlertSink\(\s*execution\.notificationBlock,\s*\(\) => buildUpdatesSurfaceLink\(storage\.publicAddress\.baseUrl\('root'\)\)/,
    );
    expect(source).toMatch(
      /runUpdateBootReconcileImpl\(\{[\s\S]*ownerAlert: updateOwnerAlert/,
    );
  });

  it('surfaces a retained manual-rollback recovery failure to the operator', () => {
    // The orchestrator returns this outcome rather than throwing so the realm can
    // still boot. That makes inspecting the union member a caller obligation;
    // awaiting and discarding it turns a serious ambiguous-disk state silent.
    expect(source).toMatch(
      /const outcome = await runUpdateBootReconcileImpl[\s\S]*outcome\.action === 'manual-rollback-recovery-failed'[\s\S]*journal was retained/,
    );
  });
});

/** ⛔⛔ THE PARKED GENERATION IS DROPPED AT THE COMMIT, NOT AT THE SWAP.
 *
 *  `preserveAndSwap` parks the generation behind `recued.old` so a failed apply
 *  does not cost the rollback target. Dropping it when the RENAME succeeded
 *  covered a failed swap and not a failed BOOT — and the apply is two-phase, so
 *  it commits here. Between the two, an auto-revert consumes `recued.old` and the
 *  aside is the only thing that can put a rollback target back. */
describe('the boot-time commit ends the operation', () => {
  it('⛔ drops the parked generation once the release has proven it starts', () => {
    const dropApplyAside = vi.fn();
    const led = memLedger([
      entry({ kind: 'apply_started', id: 'a' }),
      entry({ kind: 'apply_staged', id: 'b' }),
    ]);
    const p = ports({ ledger: led, dropApplyAside });
    return runUpdateBootReconcile({ ports: p, channel: 'stable', currentVersion: '1.4.0' })
      .then((out) => {
        expect(out.action).toBe('commit');
        expect(dropApplyAside, 'exactly one generation is kept after a commit').toHaveBeenCalledOnce();
      });
  });

  it('and does NOT drop it on an auto-revert — that is when it is needed', () => {
    // The arm that proves the drop is bound to the COMMIT. A revert consumes
    // `recued.old`; the aside is what `rollbackSwap` promotes into its place.
    const dropApplyAside = vi.fn();
    const led = memLedger([
      entry({ kind: 'apply_started', id: 'a' }),
      entry({ kind: 'apply_staged', id: 'b' }),
    ]);
    const p = ports({
      ledger: led,
      dropApplyAside,
      bootFailureCounter: memCounter({ count: 2, release: 'stable:1.4.0' }),
    });
    return runUpdateBootReconcile({ ports: p, channel: 'stable', currentVersion: '1.3.0' })
      .then((out) => {
        expect(out.action).toBe('auto-revert');
        expect(dropApplyAside).not.toHaveBeenCalled();
      });
  });

  it('a throwing drop does not cost the commit', () => {
    // Best-effort: a leftover aside is swept by the next apply's own stash, and
    // failing the commit over it would wedge the release that just booted fine.
    const led = memLedger([
      entry({ kind: 'apply_started', id: 'a' }),
      entry({ kind: 'apply_staged', id: 'b' }),
    ]);
    const p = ports({ ledger: led, dropApplyAside: vi.fn(() => { throw new Error('EACCES'); }) });
    return runUpdateBootReconcile({ ports: p, channel: 'stable', currentVersion: '1.4.0' })
      .then((out) => {
        expect(out.action).toBe('commit');
        expect(led.rows.map((r) => r.kind)).toContain('apply_committed');
      });
  });
});

describe('auto-revert × an incomplete drain', () => {
  it('⛔ changes NOTHING when the drain did not complete', async () => {
    // drainOk=false means a writer may still hold the database. Restoring the
    // snapshot then would replace the file under a live handle — the defect this
    // deferral exists to prevent — so the revert is abandoned. The `rolled_back`
    // ledger entry is still written (the DECISION stands); what is skipped is the
    // disk work that cannot be done safely.
    const led = memLedger([
      entry({ kind: 'apply_started', id: 'a', migration: true }),
      entry({ kind: 'apply_staged', id: 'b', migration: true }),
    ]);
    const p = ports({
      ledger: led,
      bootFailureCounter: memCounter({ count: 2, release: 'stable:1.4.0' }),
      requestRestart: vi.fn((onDrained?: (ok: boolean) => void | Promise<void>) => {
        void onDrained?.(false);
      }),
    });
    const out = await runUpdateBootReconcile({ ports: p, channel: 'stable', currentVersion: '1.3.0' });
    expect(out.action).toBe('auto-revert');
    expect(p.restoreSnapshot).not.toHaveBeenCalled();
    expect(p.rollbackSwap).not.toHaveBeenCalled();
    expect(p.requestRestart).toHaveBeenCalledOnce();

    // ⛔⛔ AND NOTHING MAY BE RECORDED. This is the half the first version of
    // this arm missed: it checked the disk calls and not the ledger, so a revert
    // that wrote `rolled_back` for work it never did passed cleanly.
    expect(
      led.rows.map((r) => r.kind),
      'a revert that did not happen must not be recorded as having happened',
    ).toEqual(['apply_started', 'apply_staged']);
  });

  it('⛔ ABANDONS when another process holds the host-wide update lease', async () => {
    // ⛔⛔ THE AUTO-REVERT TOOK NOTHING while mutating the same set
    // `recued update apply` does — database, binary, addon. What made it LOOK
    // safe is the drain: a server mid-restart is not serving, so the CLI's
    // live-server check finds nobody and proceeds. That is backwards — the drain
    // is what removes the other actuator's reason to stay away.
    const led = memLedger([
      entry({ kind: 'apply_started', id: 'a', migration: true }),
      entry({ kind: 'apply_staged', id: 'b', migration: true }),
    ]);
    const p = ports({
      ledger: led,
      bootFailureCounter: memCounter({ count: 2, release: 'stable:1.4.0' }),
      acquireUpdateLease: vi.fn(() => {
        throw new UpdateLeaseHeldError({ pid: 4242, operation: 'apply', at: 0, token: 't' });
      }),
    });
    const out = await runUpdateBootReconcile({ ports: p, channel: 'stable', currentVersion: '1.3.0' });
    expect(out.action).toBe('auto-revert');
    expect(p.restoreSnapshot, 'the holder owns the database').not.toHaveBeenCalled();
    expect(p.rollbackSwap, 'and the binary pair').not.toHaveBeenCalled();
    // Same rule as the incomplete drain: recording a revert that did not happen
    // is what makes it un-retryable, because `rolled_back` is terminal.
    expect(
      led.rows.map((r) => r.kind),
      'nothing may be recorded, so the next boot reconciles it again',
    ).toEqual(['apply_started', 'apply_staged']);
  });

  it('takes the lease for the disk work and RELEASES it afterwards', async () => {
    // The arm that proves the one above is not passing because the revert is
    // broken outright — and that a held lease is not leaked onto the next actor.
    const release = vi.fn();
    const led = memLedger([
      entry({ kind: 'apply_started', id: 'a', migration: true }),
      entry({ kind: 'apply_staged', id: 'b', migration: true }),
    ]);
    const acquire = vi.fn((_operation: string) => ({ release }));
    const p = ports({
      ledger: led,
      bootFailureCounter: memCounter({ count: 2, release: 'stable:1.4.0' }),
      acquireUpdateLease: acquire,
    });
    await runUpdateBootReconcile({ ports: p, channel: 'stable', currentVersion: '1.3.0' });
    expect(acquire, 'the revert must claim the mutex it mutates under').toHaveBeenCalledOnce();
    expect(p.rollbackSwap).toHaveBeenCalledOnce();
    expect(led.rows.map((r) => r.kind)).toContain('rolled_back');
    expect(release, 'a lease held past the revert blocks every later update').toHaveBeenCalledOnce();
  });

  it('⛔ and the next boot RECONCILES IT AGAIN — the staged apply is still in flight', async () => {
    // The reported reproduction was first=auto-revert, second=continue: because
    // `rolled_back` is TERMINAL, recording it early closed the operation and the
    // failed revert was never retried. The claim "the next boot will reconcile
    // again" was false. This asserts it is now true.
    const led = memLedger([
      entry({ kind: 'apply_started', id: 'a', migration: true }),
      entry({ kind: 'apply_staged', id: 'b', migration: true }),
    ]);
    const p = ports({
      ledger: led,
      bootFailureCounter: memCounter({ count: 2, release: 'stable:1.4.0' }),
      requestRestart: vi.fn((onDrained?: (ok: boolean) => void | Promise<void>) => {
        void onDrained?.(false);
      }),
    });
    const first = await runUpdateBootReconcile({ ports: p, channel: 'stable', currentVersion: '1.3.0' });
    const second = await runUpdateBootReconcile({ ports: p, channel: 'stable', currentVersion: '1.3.0' });
    expect(first.action).toBe('auto-revert');
    expect(second.action, 'the failed revert must be retried, not forgotten').toBe('auto-revert');
  });
});

describe('the committed entry tells the truth about who asked', () => {
  /** ⛔ The boot commit hardcoded `trigger: 'auto'`, and the audit replay reads
   *  the TERMINAL entry's trigger — intermediate entries are forensic only. So
   *  every manual update an owner performed, from the CLI or from Settings,
   *  appeared in their own version history as an automatic one. The staged entry
   *  was in scope the whole time. */
  it('a MANUAL apply commits as manual, not auto', async () => {
    const led = memLedger([
      entry({ kind: 'apply_started', id: 'a', trigger: 'manual' }),
      entry({ kind: 'apply_staged', id: 'b', trigger: 'manual' }),
    ]);
    const p = ports({ ledger: led });
    const out = await runUpdateBootReconcile({
      ports: p, channel: 'stable', currentVersion: '1.4.0',
    });
    expect(out.action).toBe('commit');
    const committed = led.rows.find((r) => r.kind === 'apply_committed');
    expect(committed?.trigger, 'the owner asked for this one').toBe('manual');
  });

  it('an AUTO apply still commits as auto', async () => {
    const led = memLedger([
      entry({ kind: 'apply_started', id: 'a', trigger: 'auto' }),
      entry({ kind: 'apply_staged', id: 'b', trigger: 'auto' }),
    ]);
    const p = ports({ ledger: led });
    await runUpdateBootReconcile({ ports: p, channel: 'stable', currentVersion: '1.4.0' });
    expect(led.rows.find((r) => r.kind === 'apply_committed')?.trigger).toBe('auto');
  });

  it('the staged-rollout bypass reaches the row an owner reads', async () => {
    const led = memLedger([
      entry({
        kind: 'apply_started', id: 'a', trigger: 'manual',
        detail: 'staged-rollout bypass: install is outside the 40% cohort',
      }),
      entry({ kind: 'apply_staged', id: 'b', trigger: 'manual' }),
    ]);
    const p = ports({ ledger: led });
    await runUpdateBootReconcile({ ports: p, channel: 'stable', currentVersion: '1.4.0' });
    expect(led.rows.find((r) => r.kind === 'apply_committed')?.detail)
      .toMatch(/staged-rollout bypass.*40%/);
  });
});
