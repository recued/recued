import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HousekeepingCursor } from '@recued/contracts';
import { createUpdateLedger } from '../update/update-ledger.js';
import { createBootFailureCounter } from '../update/boot-failure-counter.js';
import type { ApplyOrchestratorPorts } from '../update/apply-orchestrator.js';
import type { VerifyArtifactResult } from '../update/binary-apply-executor.js';
import type { ResolveForApplyResult } from '../update/release-check.js';
import type { ReleaseCheckResponse, UpdateMode } from '@recued/contracts';
import type { NotificationMessage } from '@recued/notification';
import type { UpdateModeStore } from '../update/update-mode-store.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';
import {
  createUpdateAutoApplyTask,
  UPDATE_AUTO_APPLY_TASK_ID,
} from '../update/auto-apply-task.js';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'recued-autoapply-'));

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
    now: () => 1000,
    trustedPubkey: 'PUB',
    stagedPath: join(d, 'recued.new'),
    ...over,
  };
};

const applyable = (over: Partial<Extract<ResolveForApplyResult, { status: 'applyable' }>> = {}): ResolveForApplyResult => ({
  status: 'applyable',
  releaseIdentity: 'stable:1.4.2',
  fromVersion: '1.3.0',
  toVersion: '1.4.2',
  channel: 'stable',
  migration: false,
  isMajor: false,
  autoApplyEligible: true,
  artifact: { url: 'https://x/bin', sha256: 'aa', sig: 'ss', size_bytes: 1 } as never,
  // An `applyable` resolution now always carries its native addon — a release
  // without one is refused as `no-artifact` upstream (D-178 item 4).
  libArtifact: { url: 'https://x/lib', sha256: 'bb', sig: 'tt', size_bytes: 1 } as never,
  webclientArtifact: null,
  ...over,
});

const modeStore = (mode: UpdateMode | null): UpdateModeStore => ({
  readUserMode: () => mode,
  setUserMode: vi.fn(),
});

const auditRows: Array<{ action: string; detail: Record<string, unknown> }> = [];
const ctxAt = (now: number): HousekeepingContext =>
  ({
    now: () => now,
    emitAuditRow: (row: { action: string; detail: Record<string, unknown> }) =>
      auditRows.push({ action: row.action, detail: row.detail }),
  }) as unknown as HousekeepingContext;

const NOT_DUE: HousekeepingCursor = { kind: 'complete' };

/** A context whose audit sink is down — isolates the notify report path. */
const throwingAuditCtx = (): HousekeepingContext =>
  ({
    now: () => 1000,
    emitAuditRow: () => {
      throw new Error('audit sink down');
    },
  }) as unknown as HousekeepingContext;

const upToDate = (over: Partial<ReleaseCheckResponse> = {}): ReleaseCheckResponse =>
  ({ status: 'up-to-date', current_version: '1.3.0', channel: 'stable', sequence: 7, ...over }) as ReleaseCheckResponse;

const available = (over: Partial<NonNullable<ReleaseCheckResponse['available']>> = {}): ReleaseCheckResponse =>
  ({
    status: 'update-available',
    current_version: '1.3.0',
    channel: 'stable',
    sequence: 8,
    available: {
      version: '1.4.2',
      migration: false,
      is_major: false,
      below_min_supported: false,
      in_rollout_cohort: true,
      auto_apply_eligible: true,
      notes_url: 'https://x/notes',
      ...over,
    },
  }) as ReleaseCheckResponse;

/** For the apply-path tests: `mode=auto` on a self-applying channel resolves
 *  through `resolveForApply` and must never reach the check. Throwing here
 *  means an accidental re-route shows up as a failure, not as a silent pass. */
const unusedCheck = async (): Promise<ReleaseCheckResponse> => {
  throw new Error('runCheck must not be called on the auto+apply path');
};

describe('createUpdateAutoApplyTask', () => {
  it('exposes a deterministic core task id', () => {
    const task = createUpdateAutoApplyTask({
      apply: { ports: makePorts(), resolveForApply: async () => applyable() },
      runCheck: unusedCheck,
      modeStore: modeStore('auto'),
      channel: 'binary',
      random: () => 0.5,
    });
    expect(task.meta.id).toBe(UPDATE_AUTO_APPLY_TASK_ID);
    expect(task.meta.kind).toBe('core');
  });

  it('applies an eligible release under mode=auto (restart requested)', async () => {
    const ports = makePorts();
    const resolveForApply = vi.fn(async () => applyable());
    const task = createUpdateAutoApplyTask({
      apply: { ports, resolveForApply },
      runCheck: unusedCheck,
      modeStore: modeStore('auto'),
      channel: 'binary',
      random: () => 0.5,
    });
    const r = await task.step(ctxAt(1000), NOT_DUE, 60_000);
    expect(r.status).toBe('complete');
    expect(resolveForApply).toHaveBeenCalledOnce();
    expect(ports.requestRestart).toHaveBeenCalledOnce();
    // next due scheduled in the future
    expect((r.cursor as { last_seen_at: number }).last_seen_at).toBeGreaterThan(1000);
  });

  it('does NOT apply when mode is notify — but DOES check', async () => {
    // The old shape of this test also asserted "no fetch". That clause was the
    // defect, not the contract: `notify` is the mode named for a notification,
    // and it was reaching the network only when a browser had the Updates card
    // open. The intent the name carries — notify never APPLIES — is unchanged.
    const ports = makePorts();
    const resolveForApply = vi.fn(async () => applyable());
    const runCheck = vi.fn(async () => upToDate());
    const task = createUpdateAutoApplyTask({
      apply: { ports, resolveForApply },
      runCheck,
      modeStore: modeStore('notify'),
      channel: 'binary',
      random: () => 0.5,
    });
    const r = await task.step(ctxAt(1000), NOT_DUE, 60_000);
    expect(r.status).toBe('complete');
    expect(runCheck).toHaveBeenCalledOnce();
    expect(resolveForApply).not.toHaveBeenCalled();
    expect(ports.requestRestart).not.toHaveBeenCalled();
  });

  it('does NOT apply a major / out-of-cohort release (autoApplyEligible=false)', async () => {
    const ports = makePorts();
    const task = createUpdateAutoApplyTask({
      apply: { ports, resolveForApply: async () => applyable({ isMajor: true, autoApplyEligible: false }) },
      runCheck: unusedCheck,
      modeStore: modeStore('auto'),
      channel: 'binary',
      random: () => 0.5,
    });
    const r = await task.step(ctxAt(1000), NOT_DUE, 60_000);
    expect(r.status).toBe('complete');
    expect(ports.requestRestart).not.toHaveBeenCalled();
  });

  it('defers when the engine is not quiesced (busy)', async () => {
    auditRows.length = 0;
    const ports = makePorts({ isQuiesced: () => false });
    const task = createUpdateAutoApplyTask({
      apply: { ports, resolveForApply: async () => applyable() },
      runCheck: unusedCheck,
      modeStore: modeStore('auto'),
      channel: 'binary',
      random: () => 0.5,
    });
    const r = await task.step(ctxAt(1000), NOT_DUE, 60_000);
    expect(r.status).toBe('complete');
    expect(ports.requestRestart).not.toHaveBeenCalled();
    expect(ports.download).not.toHaveBeenCalled();
    expect(auditRows.at(-1)?.detail.result).toBe('deferred');
  });

  it('cadence-gates: a not-yet-due cursor short-circuits without fetching', async () => {
    const ports = makePorts();
    const resolveForApply = vi.fn(async () => applyable());
    const task = createUpdateAutoApplyTask({
      apply: { ports, resolveForApply },
      runCheck: unusedCheck,
      modeStore: modeStore('auto'),
      channel: 'binary',
      random: () => 0.5,
    });
    const future: HousekeepingCursor = { kind: 'time', last_seen_at: 5000 };
    const r = await task.step(ctxAt(1000), future, 60_000);
    expect(r.status).toBe('complete');
    expect(r.cursor).toBe(future);
    expect(resolveForApply).not.toHaveBeenCalled();
  });

  it('reschedules on the edge cadence (~6h) for an edge release vs stable (~24h)', async () => {
    const base = 1_000_000;
    const stableTask = createUpdateAutoApplyTask({
      apply: {
        ports: makePorts(),
        resolveForApply: async () => applyable({ channel: 'stable', autoApplyEligible: false }),
      },
      runCheck: unusedCheck,
      modeStore: modeStore('auto'),
      channel: 'binary',
      random: () => 0.5, // factor 1.0 → exactly base
    });
    const edgeTask = createUpdateAutoApplyTask({
      apply: {
        ports: makePorts(),
        resolveForApply: async () => applyable({ channel: 'edge', autoApplyEligible: false }),
      },
      runCheck: unusedCheck,
      modeStore: modeStore('auto'),
      channel: 'binary',
      random: () => 0.5,
    });
    const sr = await stableTask.step(ctxAt(base), NOT_DUE, 60_000);
    const er = await edgeTask.step(ctxAt(base), NOT_DUE, 60_000);
    const stableDue = (sr.cursor as { last_seen_at: number }).last_seen_at - base;
    const edgeDue = (er.cursor as { last_seen_at: number }).last_seen_at - base;
    expect(stableDue).toBe(24 * 60 * 60 * 1000);
    expect(edgeDue).toBe(6 * 60 * 60 * 1000);
  });

  // ── The check half (D-178 — `notify` is a mode that has to actually look) ──

  it('mode=off makes NO network call at all — not even the check', async () => {
    // The guard that has to hold for "the check is disableable" to be true.
    const runCheck = vi.fn(async () => available());
    const resolveForApply = vi.fn(async () => applyable());
    const task = createUpdateAutoApplyTask({
      apply: { ports: makePorts(), resolveForApply },
      runCheck,
      modeStore: modeStore('off'),
      channel: 'binary',
      random: () => 0.5,
    });
    const r = await task.step(ctxAt(1000), NOT_DUE, 60_000);
    expect(r.status).toBe('complete');
    expect(runCheck).not.toHaveBeenCalled();
    expect(resolveForApply).not.toHaveBeenCalled();
    // Still reschedules — an `off` server keeps a cursor so flipping back to
    // `notify` doesn't stampede the feed with an immediately-due check.
    expect((r.cursor as { last_seen_at: number }).last_seen_at).toBeGreaterThan(1000);
  });

  it('checks on a DELEGATED channel, which has no apply half at all', async () => {
    // The regression this slice exists for: `docker-baked` / `source` build no
    // apply deps, and the whole task used to be gated on them — so the two
    // channels that DEFAULT to `notify` registered nothing and never looked.
    const runCheck = vi.fn(async () => available());
    const task = createUpdateAutoApplyTask({
      runCheck,
      modeStore: modeStore(null), // → channel default, which is `notify` here
      channel: 'docker-baked',
      random: () => 0.5,
    });
    const r = await task.step(ctxAt(1000), NOT_DUE, 60_000);
    expect(r.status).toBe('complete');
    expect(runCheck).toHaveBeenCalledOnce();
  });

  it('an auto-mode server with no apply capability checks instead of throwing', async () => {
    // `RECUED_SELF_UPDATE=auto` forced onto a delegated channel. The mode says
    // apply; the channel has no way to. Checking is the honest fallback.
    const runCheck = vi.fn(async () => available());
    const task = createUpdateAutoApplyTask({
      runCheck,
      modeStore: modeStore('auto'),
      channel: 'source',
      random: () => 0.5,
    });
    const r = await task.step(ctxAt(1000), NOT_DUE, 60_000);
    expect(r.status).toBe('complete');
    expect(runCheck).toHaveBeenCalledOnce();
  });

  it('records an available release ONCE per version, then stays quiet', async () => {
    auditRows.length = 0;
    let reported: string | null = null;
    const task = createUpdateAutoApplyTask({
      runCheck: async () => available(),
      readLastReported: () => reported,
      writeLastReported: (v) => {
        reported = v;
      },
      modeStore: modeStore('notify'),
      channel: 'docker-baked',
      random: () => 0.5,
    });
    await task.step(ctxAt(1000), NOT_DUE, 60_000);
    await task.step(ctxAt(2000), NOT_DUE, 60_000);
    await task.step(ctxAt(3000), NOT_DUE, 60_000);
    const rows = auditRows.filter((r) => r.action === 'update_available');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail.to_version).toBe('1.4.2');
    expect(reported).toBe('1.4.2');
  });

  it('records again when a NEWER version supersedes the reported one', async () => {
    auditRows.length = 0;
    let reported: string | null = '1.4.2';
    let version = '1.4.2';
    const task = createUpdateAutoApplyTask({
      runCheck: async () => available({ version }),
      readLastReported: () => reported,
      writeLastReported: (v) => {
        reported = v;
      },
      modeStore: modeStore('notify'),
      channel: 'docker-baked',
      random: () => 0.5,
    });
    await task.step(ctxAt(1000), NOT_DUE, 60_000);
    expect(auditRows.filter((r) => r.action === 'update_available')).toHaveLength(0);
    version = '1.5.0';
    await task.step(ctxAt(2000), NOT_DUE, 60_000);
    const rows = auditRows.filter((r) => r.action === 'update_available');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail.to_version).toBe('1.5.0');
    expect(reported).toBe('1.5.0');
  });

  it('does NOT advance the reported marker when NOTHING told the owner', async () => {
    // The marker means "the owner has been told". If the audit row is the only
    // report path and it fails, nothing told them — marking it told would lose
    // the release silently, and that is the one direction the next cycle cannot
    // recover.
    let reported: string | null = null;
    const task = createUpdateAutoApplyTask({
      runCheck: async () => available(),
      readLastReported: () => reported,
      writeLastReported: (v) => {
        reported = v;
      },
      modeStore: modeStore('notify'),
      channel: 'docker-baked',
      random: () => 0.5,
    });
    const r = await task.step(throwingAuditCtx(), NOT_DUE, 60_000);
    expect(r.status).toBe('complete');
    expect(reported).toBeNull();
  });

  it('DOES advance the marker when the notify landed but the audit row did not', async () => {
    // The two report paths are not fallbacks for each other. A person was told;
    // re-telling them because a sink was down is the wrong failure.
    let reported: string | null = null;
    const notifyOwner = vi.fn(async () => {});
    const task = createUpdateAutoApplyTask({
      runCheck: async () => available(),
      readLastReported: () => reported,
      writeLastReported: (v) => {
        reported = v;
      },
      notifyOwner,
      modeStore: modeStore('notify'),
      channel: 'docker-baked',
      random: () => 0.5,
    });
    await task.step(throwingAuditCtx(), NOT_DUE, 60_000);
    expect(notifyOwner).toHaveBeenCalledOnce();
    expect(reported).toBe('1.4.2');
  });

  it('notifies the owner ONCE per version, in step with the marker', async () => {
    auditRows.length = 0;
    let reported: string | null = null;
    // ⚠ Typed arg, not `vi.fn(async () => {})` — an untyped mock infers an EMPTY
    // arg tuple, so `.mock.calls[0][0]` is a type error and, worse, asserting on
    // the message would have been unreachable.
    const notifyOwner = vi.fn(async (_message: NotificationMessage) => {});
    const task = createUpdateAutoApplyTask({
      runCheck: async () => available(),
      readLastReported: () => reported,
      writeLastReported: (v) => {
        reported = v;
      },
      notifyOwner,
      modeStore: modeStore('notify'),
      channel: 'docker-baked',
      random: () => 0.5,
    });
    await task.step(ctxAt(1000), NOT_DUE, 60_000);
    await task.step(ctxAt(2000), NOT_DUE, 60_000);
    expect(notifyOwner).toHaveBeenCalledOnce();
    expect(notifyOwner.mock.calls[0]?.[0]).toMatchObject({ title: 'Update available' });
  });

  it('a notify that throws does not stop the cycle or lose the audit row', async () => {
    auditRows.length = 0;
    let reported: string | null = null;
    const task = createUpdateAutoApplyTask({
      runCheck: async () => available(),
      readLastReported: () => reported,
      writeLastReported: (v) => {
        reported = v;
      },
      notifyOwner: async () => {
        throw new Error('transport exploded');
      },
      modeStore: modeStore('notify'),
      channel: 'docker-baked',
      random: () => 0.5,
    });
    const r = await task.step(ctxAt(1000), NOT_DUE, 60_000);
    expect(r.status).toBe('complete');
    // the audit row landed, so the owner WAS told by the surviving path
    expect(auditRows.filter((x) => x.action === 'update_available')).toHaveLength(1);
    expect(reported).toBe('1.4.2');
  });

  it('never notifies on a check that found nothing', async () => {
    const notifyOwner = vi.fn(async () => {});
    const task = createUpdateAutoApplyTask({
      runCheck: async () => upToDate(),
      notifyOwner,
      modeStore: modeStore('notify'),
      channel: 'docker-baked',
      random: () => 0.5,
    });
    await task.step(ctxAt(1000), NOT_DUE, 60_000);
    expect(notifyOwner).not.toHaveBeenCalled();
  });

  it('does not record a check that found nothing (up-to-date / not-configured)', async () => {
    auditRows.length = 0;
    const write = vi.fn();
    const mk = (res: ReleaseCheckResponse) =>
      createUpdateAutoApplyTask({
        runCheck: async () => res,
        readLastReported: () => null,
        writeLastReported: write,
        modeStore: modeStore('notify'),
        channel: 'docker-baked',
        random: () => 0.5,
      });
    await mk(upToDate()).step(ctxAt(1000), NOT_DUE, 60_000);
    await mk(upToDate({ status: 'not-configured' })).step(ctxAt(1000), NOT_DUE, 60_000);
    expect(auditRows.filter((r) => r.action === 'update_available')).toHaveLength(0);
    expect(write).not.toHaveBeenCalled();
  });

  it('treats a runCheck throw as silent-retry on the daily base', async () => {
    const task = createUpdateAutoApplyTask({
      runCheck: async () => {
        throw new Error('feed unreachable');
      },
      modeStore: modeStore('notify'),
      channel: 'docker-baked',
      random: () => 0.5,
    });
    const r = await task.step(ctxAt(1000), NOT_DUE, 60_000);
    expect(r.status).toBe('complete');
    expect((r.cursor as { last_seen_at: number }).last_seen_at - 1000).toBe(24 * 60 * 60 * 1000);
  });

  it('reschedules a CHECK on the edge cadence when the release channel is edge', async () => {
    const base = 1_000_000;
    const stable = createUpdateAutoApplyTask({
      runCheck: async () => upToDate({ channel: 'stable' }),
      modeStore: modeStore('notify'),
      channel: 'docker-baked',
      random: () => 0.5,
    });
    const edge = createUpdateAutoApplyTask({
      runCheck: async () => upToDate({ channel: 'edge' }),
      modeStore: modeStore('notify'),
      channel: 'docker-baked',
      random: () => 0.5,
    });
    const sr = await stable.step(ctxAt(base), NOT_DUE, 60_000);
    const er = await edge.step(ctxAt(base), NOT_DUE, 60_000);
    expect((sr.cursor as { last_seen_at: number }).last_seen_at - base).toBe(24 * 60 * 60 * 1000);
    expect((er.cursor as { last_seen_at: number }).last_seen_at - base).toBe(6 * 60 * 60 * 1000);
  });

  it('treats a resolveForApply throw as silent-retry (reschedules, no restart)', async () => {
    const ports = makePorts();
    const task = createUpdateAutoApplyTask({
      apply: {
        ports,
        resolveForApply: async () => {
          throw new Error('network down');
        },
      },
      runCheck: unusedCheck,
      modeStore: modeStore('auto'),
      channel: 'binary',
      random: () => 0.5,
    });
    const r = await task.step(ctxAt(1000), NOT_DUE, 60_000);
    expect(r.status).toBe('complete');
    expect(ports.requestRestart).not.toHaveBeenCalled();
    expect((r.cursor as { last_seen_at: number }).last_seen_at).toBeGreaterThan(1000);
  });
});
