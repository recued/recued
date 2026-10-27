/** Housekeeping — what a restart's `pause_scheduler` step needs from `stop()`.
 *
 *  The stop used to wait for every admitted cycle; a cycle's budget is only
 *  checked between records, and the MCP drift probe spends up to 10 s per
 *  connection, one after another — so the drain step ran out. These pin that
 *  `stop()` returns within `STOP_GRACE_MS` while a step never finishes, that
 *  the step is handed an `AbortSignal` that fires, that no further task (and no
 *  Run-now queued before the stop) starts, that a step cut short is not booked
 *  as an error, and that the drift probe and the enrichment harness honour the
 *  signal between their own items. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollectionRecord, HousekeepingStepResult } from '@recued/contracts';

import { createHousekeepingConfigStore } from '../housekeeping/config-store.js';
import { createHousekeepingStateStore } from '../housekeeping/state-store.js';
import { createHousekeepingScheduler } from '../housekeeping/scheduler.js';
import type { HousekeepingContext, HousekeepingTaskInstance } from '../housekeeping/registry.js';
import type { EngineBusySignal } from '../housekeeping/engine-busy-signal.js';
import {
  buildMcpToolsDriftProbeTask,
  runMcpToolsDriftProbe,
} from '../housekeeping/tasks/mcp-tools-drift-probe.js';
import { buildEnrichmentProducerTask } from '../housekeeping/enrichment-producer.js';
import type { SourceCollectionWalker, SourceRecord } from '../housekeeping/source-walkers.js';
import { createEnrichmentStore, type EnrichmentStore } from '../storage/enrichment-store.js';
import { STOP_GRACE_MS } from '../lifecycle/settle-within.js';

const NOW = 1_700_000_000_000;

let dir: string;
let db: Database.Database;
let enrichment: EnrichmentStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'housekeeping-restart-stop-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  enrichment = createEnrichmentStore(db);
});

afterEach(() => {
  vi.useRealTimers();
  enrichment.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const busy: EngineBusySignal = {
  isExecuting: () => false,
  isDraining: () => false,
  isBusy: () => false,
  lastIdleTransitionAt: () => null,
  poll: () => undefined,
};

const ctx = (): HousekeepingContext => ({
  db,
  bus: { emit: () => undefined, subscribe: () => () => undefined, dispose: () => undefined } as never,
  enrichmentStore: enrichment,
  recipeStore: {} as never,
  now: () => NOW,
  emitAuditRow: () => undefined,
});

const task = (
  id: string,
  step: HousekeepingTaskInstance['step'],
): HousekeepingTaskInstance => ({ meta: { id, description: id, interruptible: true, kind: 'core' }, step });

const done = async (): Promise<HousekeepingStepResult> => ({ status: 'complete', cursor: { kind: 'complete' } });

const scheduler = (registry: HousekeepingTaskInstance[]) => {
  const config = createHousekeepingConfigStore(db);
  const state = createHousekeepingStateStore(db);
  config.write({ preset: 'balanced' }, NOW);
  return {
    state,
    sched: createHousekeepingScheduler({ ctx: ctx(), config, state, busy, registry: () => registry }),
  };
};

describe('housekeeping stop() during a restart drain', () => {
  it('returns within the grace while a step never finishes, aborts it, and starts no further task', async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    const stepped: string[] = [];
    const { sched } = scheduler([
      task('a', (_ctx, _cursor, _budget, signal) => {
        stepped.push('a');
        seen = signal;
        return new Promise<HousekeepingStepResult>(() => {});
      }),
      task('b', async () => { stepped.push('b'); return done(); }),
    ]);
    void sched.runOnce();
    await vi.advanceTimersByTimeAsync(0);
    expect(stepped).toEqual(['a']);
    expect(seen?.aborted).toBe(false);

    let stopped = false;
    const stopping = sched.stop().then(() => { stopped = true; });
    expect(seen?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS - 1);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(stopped).toBe(true);
    expect(stepped).toEqual(['a']);
  });

  it('a step that throws once the stop aborts it is not booked as an error, and the next task never starts', async () => {
    const stepped: string[] = [];
    let entered!: () => void;
    const inStep = new Promise<void>((resolve) => { entered = resolve; });
    const { sched, state } = scheduler([
      task('a', (_ctx, _cursor, _budget, signal) => new Promise<HousekeepingStepResult>((_resolve, reject) => {
        stepped.push('a');
        entered();
        signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      })),
      task('b', async () => { stepped.push('b'); return done(); }),
    ]);
    const cycle = sched.runOnce();
    await inStep;
    await sched.stop();
    const result = await cycle;

    expect(stepped).toEqual(['a']);
    expect(result.tasks_errored).toBe(0);
    expect(result.per_task).toEqual([expect.objectContaining({ task_id: 'a', status: 'yield' })]);
    // Nothing persisted for the interrupted step: its cursor is where it was.
    expect(state.get('a')).toBeNull();
  });

  it('a Run-now asked before the stop never starts; one asked after it runs', async () => {
    let release!: () => void;
    const first = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const { sched } = scheduler([
      task('a', async () => {
        calls += 1;
        if (calls === 1) await first;
        return done();
      }),
    ]);
    const running = sched.runOnce();
    const queued = sched.runOnce();
    await new Promise((resolve) => { setImmediate(resolve); });
    await sched.stop();
    release();
    await running;
    expect((await queued).tasks_stepped).toBe(0);
    expect(calls).toBe(1);

    // A pause or a maintenance window never restarts the idle loop, so the
    // owner's Run-now must still work after a stop.
    expect((await sched.runOnce()).tasks_stepped).toBe(1);
    expect(calls).toBe(2);
  });
});

describe('MCP drift probe and the stop signal', () => {
  it('stops waiting for the probe in flight and probes no further connection; nothing counts as failed', async () => {
    const controller = new AbortController();
    const probed: string[] = [];
    let probeSignal: AbortSignal | undefined;
    const sweeping = runMcpToolsDriftProbe({
      listConnections: () => [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
      installedPackSlugFor: async () => 'pack',
      probe: (args, opts) => {
        probed.push(args.name);
        probeSignal = opts?.signal;
        // A 10 s probe that never answers.
        return new Promise<unknown>(() => {});
      },
    }, controller.signal);
    await new Promise((resolve) => { setImmediate(resolve); });
    expect(probed).toEqual(['a']);
    // The wiring is handed the signal, so it can cancel the request too.
    expect(probeSignal).toBe(controller.signal);

    controller.abort();
    const result = await sweeping;
    expect(result).toEqual({ probed: 0, skipped_no_pack: 0, failed: 0, interrupted: true });
    expect(probed).toEqual(['a']);
  });

  it('a step cut short yields rather than completes, so the next cycle sweeps again', async () => {
    const controller = new AbortController();
    controller.abort();
    const probe = vi.fn(async () => undefined);
    const step = buildMcpToolsDriftProbeTask({
      deps: { listConnections: () => [{ name: 'a' }], installedPackSlugFor: async () => 'pack', probe },
    });
    const result = await step.step(ctx(), { kind: 'complete' }, 60_000, controller.signal);
    expect(result.status).toBe('yield');
    expect(probe).not.toHaveBeenCalled();
    // The permitting case: no stop, the sweep completes.
    expect((await step.step(ctx(), { kind: 'complete' }, 60_000)).status).toBe('complete');
    expect(probe).toHaveBeenCalledOnce();
  });
});

describe('enrichment producer harness and the stop signal', () => {
  const record = (id: string): SourceRecord => ({
    target_id: id,
    data: {
      record_id: id, received_at: NOW, modified_at: NOW, hot_fields: {}, size_bytes: 1, source_id: id,
    } as CollectionRecord,
    cursor_token: id,
  });
  const walker = (records: SourceRecord[]): SourceCollectionWalker => ({
    *walkAfter(cursor_token: string, batch_size: number) {
      let yielded = 0;
      for (const r of records) {
        if (r.cursor_token <= cursor_token) continue;
        if (yielded >= batch_size) return;
        yield r;
        yielded += 1;
      }
    },
    hashOf: (r) => `v1:${r.target_id}`,
    fetchOne: (id) => records.find((r) => r.target_id === id) ?? null,
  });

  it('yields at the next record once the signal fires, with its cursor, starting no further record', async () => {
    const controller = new AbortController();
    const produced: string[] = [];
    const producerTask = buildEnrichmentProducerTask({
      producer: {
        topic: 'thread_signals',
        source_scope: 'mail',
        scope_read_declaration: [{ collection: 'data.mail', sample_field_paths: ['subject', 'thread_id'] }],
        estimate_per_record_tokens: () => 0,
        async produce(_ctx, rec) {
          produced.push(rec.target_id);
          // The server begins stopping while this record is being produced.
          controller.abort();
          return {
            value: { thread_id: rec.target_id, message_count: 1, participant_count: 1, span_days: 0, has_unread: false },
          };
        },
      },
      walker: walker(['a', 'b', 'c'].map(record)),
    });

    const result = await producerTask.step(ctx(), { kind: 'complete' }, 60_000, controller.signal);
    expect(produced).toEqual(['a']);
    expect(result.status).toBe('yield');
    if (result.status === 'yield') {
      expect(result.reason).toBe('budget_exhausted');
      expect((result.cursor as { max_target_id_seen?: string }).max_target_id_seen).toBe('a');
    }
  });
});
