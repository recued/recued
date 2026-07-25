/** D-157 server-wiring - awaiting preflight checkpoint boot sweep. */

import type { Checkpoint } from '@recued/contracts';
import type { PreflightNotifier } from '@recued/gateway';
import {
  buildAuditEntry,
  createAuditLogStore,
  createInMemoryCollection,
  type ActivityEntry,
  type AuditEntry,
  type AuditLogStore,
  type CheckpointStore,
} from '@recued/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sweepAwaitingCheckpoints } from '../preflight-boot-sweep.js';

const NOW = Date.parse('2026-05-22T18:00:00.000Z');

const checkpoint = (overrides: Partial<Checkpoint> = {}): Checkpoint => ({
  checkpoint_id: 'checkpoint-1',
  run_id: 'run-1',
  recipe_id: 'recipe-1',
  gated_step_id: 'gated_step',
  step_state: {},
  created_at: NOW,
  ...overrides,
});

const checkpointStore = (
  checkpoints: Checkpoint[],
): CheckpointStore & { list: ReturnType<typeof vi.fn> } => ({
  write: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
  listByRun: vi.fn(),
  list: vi.fn().mockResolvedValue(checkpoints),
  size: vi.fn().mockResolvedValue(checkpoints.length),
}) as unknown as CheckpointStore & { list: ReturnType<typeof vi.fn> };

const auditLog = (): AuditLogStore =>
  createAuditLogStore(
    createInMemoryCollection<AuditEntry>(),
    createInMemoryCollection<ActivityEntry>(),
  );

const anchor = (
  overrides: Partial<AuditEntry> = {},
): AuditEntry => ({
  ...buildAuditEntry({
    recipe_id: 'recipe-1',
    recipe_hash: 'hash-1',
    commit_status: 'awaiting_approval',
    duration_ms: 50,
    errors: [],
    config_snapshot: {},
    trigger_url: null,
    trigger_source: 'manual',
    instance_id: 'server-1',
    run_id: 'run-1',
    now: NOW,
    checkpoint_id: 'checkpoint-1',
  }),
  ...overrides,
});

const append = async (
  log: AuditLogStore,
  entry: AuditEntry,
): Promise<void> => {
  await log.append(entry);
};

const notifier = (
  askImpl: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue({ ask_id: 'ask-new' }),
): PreflightNotifier & { ask: ReturnType<typeof vi.fn> } => ({
  ask: askImpl,
  registerAskHandler: vi.fn(),
}) as unknown as PreflightNotifier & { ask: ReturnType<typeof vi.fn> };

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe('sweepAwaitingCheckpoints', () => {
  it('re-raises notification.ask and pins the new ask_id', async () => {
    const log = auditLog();
    await append(log, anchor());
    const notes = notifier();

    const result = await sweepAwaitingCheckpoints({
      checkpointStore: checkpointStore([checkpoint()]),
      auditLog: log,
      notifier: notes,
    });

    expect(result).toEqual({
      inspected: 1,
      alreadyPaired: 0,
      raised: 1,
      failed: 0,
      orphaned: 0,
      terminal: 0,
      // D-210 Phase C — holds left ask-less on purpose because the owner's
      // fanout mode is 'notify'. Zero here: no mode resolver is wired, so
      // the sweep re-raises everything ask-less exactly as before.
      leftPassive: 0,
    });
    expect(notes.ask).toHaveBeenCalledTimes(1);
    expect(notes.ask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Approval required',
        text: expect.stringContaining('recipe-1'),
      }),
      expect.any(Array),
      expect.objectContaining({
        kind: 'gateway.preflight',
        payload: expect.objectContaining({
          checkpoint_id: 'checkpoint-1',
          run_id: 'run-1',
        }),
      }),
    );
    expect(await log.get('run-1')).toMatchObject({
      commit_status: 'awaiting_approval',
      checkpoint_id: 'checkpoint-1',
      ask_id: 'ask-new',
    });
  });

  it('skips anchors that already have ask_id set', async () => {
    const log = auditLog();
    await append(log, anchor({ ask_id: 'ask-existing' }));
    const notes = notifier();

    const result = await sweepAwaitingCheckpoints({
      checkpointStore: checkpointStore([checkpoint()]),
      auditLog: log,
      notifier: notes,
    });

    expect(result.alreadyPaired).toBe(1);
    expect(result.raised).toBe(0);
    expect(notes.ask).not.toHaveBeenCalled();
  });

  it('skips terminal rows and counts them', async () => {
    const log = auditLog();
    await append(log, anchor({ commit_status: 'failed' }));
    const notes = notifier();

    const result = await sweepAwaitingCheckpoints({
      checkpointStore: checkpointStore([checkpoint()]),
      auditLog: log,
      notifier: notes,
    });

    expect(result.terminal).toBe(1);
    expect(result.raised).toBe(0);
    expect(notes.ask).not.toHaveBeenCalled();
  });

  it('counts orphaned checkpoints when no audit row exists', async () => {
    const log = auditLog();
    const notes = notifier();

    const result = await sweepAwaitingCheckpoints({
      checkpointStore: checkpointStore([checkpoint()]),
      auditLog: log,
      notifier: notes,
    });

    expect(result.orphaned).toBe(1);
    expect(result.raised).toBe(0);
    expect(notes.ask).not.toHaveBeenCalled();
  });

  it('continues after a per-row raise failure', async () => {
    const log = auditLog();
    await append(log, anchor({
      run_id: 'run-fail',
      checkpoint_id: 'checkpoint-fail',
    }));
    await append(log, anchor({
      run_id: 'run-ok',
      checkpoint_id: 'checkpoint-ok',
    }));
    const checkpoints = [
      checkpoint({ run_id: 'run-fail', checkpoint_id: 'checkpoint-fail' }),
      checkpoint({ run_id: 'run-ok', checkpoint_id: 'checkpoint-ok' }),
    ];
    const notes = notifier(
      vi.fn()
        .mockRejectedValueOnce(new Error('ask store down'))
        .mockResolvedValueOnce({ ask_id: 'ask-ok' }),
    );

    const result = await sweepAwaitingCheckpoints({
      checkpointStore: checkpointStore(checkpoints),
      auditLog: log,
      notifier: notes,
    });

    expect(result.inspected).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.raised).toBe(1);
    expect(notes.ask).toHaveBeenCalledTimes(2);
    expect(await log.get('run-fail')).not.toHaveProperty('ask_id');
    expect(await log.get('run-ok')).toMatchObject({ ask_id: 'ask-ok' });
  });

  it('counts audit pin failures and continues the sweep', async () => {
    const log = auditLog();
    await append(log, anchor({
      run_id: 'run-pin-fail',
      checkpoint_id: 'checkpoint-pin-fail',
    }));
    await append(log, anchor({
      run_id: 'run-after',
      checkpoint_id: 'checkpoint-after',
    }));
    vi.spyOn(log, 'append')
      .mockRejectedValueOnce(new Error('append down'))
      .mockImplementation(async (entry) => {
        await auditLog().append(entry);
      });
    const notes = notifier(
      vi.fn()
        .mockResolvedValueOnce({ ask_id: 'ask-orphaned' })
        .mockResolvedValueOnce({ ask_id: 'ask-after' }),
    );

    const result = await sweepAwaitingCheckpoints({
      checkpointStore: checkpointStore([
        checkpoint({
          run_id: 'run-pin-fail',
          checkpoint_id: 'checkpoint-pin-fail',
        }),
        checkpoint({ run_id: 'run-after', checkpoint_id: 'checkpoint-after' }),
      ]),
      auditLog: log,
      notifier: notes,
    });

    expect(result.failed).toBe(1);
    expect(result.raised).toBe(1);
    expect(notes.ask).toHaveBeenCalledTimes(2);
  });
});
