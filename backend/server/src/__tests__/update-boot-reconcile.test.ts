import { describe, expect, it, vi } from 'vitest';
import { runUpdateBootReconcile, type UpdateAuditSink } from '../update/boot-reconcile.js';
import type { ApplyOrchestratorPorts } from '../update/apply-orchestrator.js';
import type { UpdateLedgerEntry } from '../update/update-ledger.js';

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
  requestRestart: vi.fn(),
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

  it('commits a staged release that booted healthy + replays update_applied', async () => {
    const led = memLedger([
      entry({ kind: 'apply_started', id: 'a' }),
      entry({ kind: 'apply_staged', id: 'b' }),
    ]);
    const { rows, sink } = memAudit();
    const p = ports({ ledger: led });
    const out = await runUpdateBootReconcile({ ports: p, channel: 'stable', currentVersion: '1.4.0', auditLog: sink });
    expect(out).toMatchObject({ action: 'commit', releaseIdentity: 'stable:1.4.0' });
    expect(led.rows.some((r) => r.kind === 'apply_committed')).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'update_applied', target: 'stable:1.4.0' });
  });

  it('auto-reverts a staged release that failed boot health (binary swap + rolled_back + restart)', async () => {
    const led = memLedger([
      entry({ kind: 'apply_started', id: 'a', migration: true }),
      entry({ kind: 'apply_staged', id: 'b', migration: true }),
    ]);
    const { rows, sink } = memAudit();
    // Counter already at the threshold-minus-one for this release; this boot
    // reports a DIFFERENT current identity (the staged binary didn't take) →
    // increment trips auto-revert.
    const p = ports({ ledger: led, bootFailureCounter: memCounter({ count: 2, release: 'stable:1.4.0' }) });
    const out = await runUpdateBootReconcile({ ports: p, channel: 'stable', currentVersion: '1.3.0', auditLog: sink });
    expect(out.action).toBe('auto-revert');
    expect(p.restoreSnapshot).toHaveBeenCalledOnce(); // migration + snapshot present
    expect(p.rollbackSwap).toHaveBeenCalledOnce();
    expect(p.requestRestart).toHaveBeenCalledOnce();
    expect(led.rows.some((r) => r.kind === 'rolled_back')).toBe(true);
    expect(rows[0]).toMatchObject({ action: 'update_rolled_back' });
  });

  it('treats a started-but-never-staged leftover as staging-aborted (no replay row)', async () => {
    const led = memLedger([entry({ kind: 'apply_started', id: 'a' })]);
    const { rows, sink } = memAudit();
    const p = ports({ ledger: led });
    const out = await runUpdateBootReconcile({ ports: p, channel: 'stable', currentVersion: '1.4.0', auditLog: sink });
    expect(out.action).toBe('staging-aborted');
    expect(led.rows.some((r) => r.kind === 'apply_reverted')).toBe(true);
    expect(rows).toHaveLength(0); // apply_reverted is not a user-facing replay row
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
    await runUpdateBootReconcile({ ports: p, channel: 'stable', currentVersion: '1.4.0', auditLog: sink });
    // The pre-seeded 'done' entry is not duplicated; only the fresh commit row
    // from THIS boot is appended.
    expect(rows.filter((r) => r.activity_id === 'update:done')).toHaveLength(1);
  });
});
