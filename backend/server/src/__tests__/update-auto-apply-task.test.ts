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
import type { UpdateMode } from '@recued/contracts';
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

describe('createUpdateAutoApplyTask', () => {
  it('exposes a deterministic core task id', () => {
    const task = createUpdateAutoApplyTask({
      ports: makePorts(),
      resolveForApply: async () => applyable(),
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
      ports,
      resolveForApply,
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

  it('does NOT apply when mode is notify (no fetch, no restart)', async () => {
    const ports = makePorts();
    const resolveForApply = vi.fn(async () => applyable());
    const task = createUpdateAutoApplyTask({
      ports,
      resolveForApply,
      modeStore: modeStore('notify'),
      channel: 'binary',
      random: () => 0.5,
    });
    const r = await task.step(ctxAt(1000), NOT_DUE, 60_000);
    expect(r.status).toBe('complete');
    expect(resolveForApply).not.toHaveBeenCalled();
    expect(ports.requestRestart).not.toHaveBeenCalled();
  });

  it('does NOT apply a major / out-of-cohort release (autoApplyEligible=false)', async () => {
    const ports = makePorts();
    const task = createUpdateAutoApplyTask({
      ports,
      resolveForApply: async () => applyable({ isMajor: true, autoApplyEligible: false }),
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
      ports,
      resolveForApply: async () => applyable(),
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
      ports,
      resolveForApply,
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
      ports: makePorts(),
      resolveForApply: async () => applyable({ channel: 'stable', autoApplyEligible: false }),
      modeStore: modeStore('auto'),
      channel: 'binary',
      random: () => 0.5, // factor 1.0 → exactly base
    });
    const edgeTask = createUpdateAutoApplyTask({
      ports: makePorts(),
      resolveForApply: async () => applyable({ channel: 'edge', autoApplyEligible: false }),
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

  it('treats a resolveForApply throw as silent-retry (reschedules, no restart)', async () => {
    const ports = makePorts();
    const task = createUpdateAutoApplyTask({
      ports,
      resolveForApply: async () => {
        throw new Error('network down');
      },
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
