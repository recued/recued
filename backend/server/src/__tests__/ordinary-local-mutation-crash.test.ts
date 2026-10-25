/** Real process death around the shared data/journal transaction, through
 * ordinary recipe approval and direct Chat approval dispatch. */
import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ordinaryLocalFixture } from './ordinary-local-mutations-fixture.js';
import { CRASH_CASE_TIMEOUT_MS, CRASH_WRITER_LIMIT_MS, resourceFixtureDisposers, runCrashWriter } from './preapproval-resources-fixture.js';
import type { CrashState } from './ordinary-local-mutation-crash-writer.js';
import { createSqliteChatPlanStore } from '../storage/chat-plan-store.js';
import { createPreflightResumer } from '../preflight-resumer.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dispose of resourceFixtureDisposers.splice(0).reverse()) await dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const cases = (['records', 'records_batch', 'calendar_update', 'calendar_delete', 'chat_calendar'] as const)
  .flatMap(kind => (['before_commit', 'after_commit'] as const).map(phase => ({ kind, phase })));
it.each(cases)('recovers ordinary $kind $phase without replay', async ({ kind, phase }) => {
  const dir = mkdtempSync(join(tmpdir(), 'recued-ordinary-local-crash-')); dirs.push(dir);
  const output = join(dir, 'state.json');
  const { stopped, signal, trace } = await runCrashWriter(new URL('./ordinary-local-mutation-crash-writer.ts', import.meta.url), dir, { kind, phase, output });
  expect(stopped, `the crash writer was still running after ${CRASH_WRITER_LIMIT_MS / 1000} s and was stopped: a hang, or a machine too loaded to start it`).toBe(false);
  expect(signal, trace.slice(-3000)).toBe('SIGKILL'); expect(existsSync(output), trace.slice(-3000)).toBe(true);
  const state = JSON.parse(readFileSync(output, 'utf8')) as CrashState;
  dirs.push(state.previous.dir); expect(state.stage).toBe('killed'); expect(() => process.kill(state.pid, 0)).toThrow();
  const f = await ordinaryLocalFixture(state.previous); await f.recover();
  if (kind === 'chat_calendar') {
    const plans = createSqliteChatPlanStore(f.db, () => new Uint8Array(32).fill(8), () => f.clock.now);
    const execution = (await plans.listForSession!(state.session_id!))[0]!.execution!;
    expect(execution.status).toBe(phase === 'after_commit' ? 'completed' : 'unknown');
    if (phase === 'after_commit') expect(execution).toMatchObject({ local_receipt: { kind: 'local_calendar' } });
    const proposal = (await plans.get(state.plan_id!))!;
    expect(await plans.findApprovedForDispatch(state.session_id!, 'calendar.update', proposal.args_hash, f.clock.now)).toBeUndefined();
  } else {
    const action = (await f.execution.gatedActionStore!.get(state.action_ref!))!;
    expect(action.status).toBe(phase === 'after_commit' ? 'succeeded' : 'in_doubt');
    const commits = await f.execution.commitStore!.listByRun(state.run_id!);
    expect(commits).toHaveLength(1); expect(commits[0]!.status).toBe(phase === 'after_commit' ? 'succeeded' : 'in_doubt');
    expect(Boolean(commits[0]!.local_receipt)).toBe(phase === 'after_commit');
    const checkpoint = await f.execution.checkpointStore!.get(state.checkpoint_id!);
    if (checkpoint) await createPreflightResumer({ getExecuteDeps: () => f.execution, auditLog: f.execution.auditLog!,
      gatedActionStore: f.execution.gatedActionStore }).resumeRun(checkpoint,
    { recipe_id: checkpoint.recipe_id, gated_step_id: checkpoint.gated_step_id });
  }
  expect(f.db.prepare('SELECT count(*) FROM local_mutation_receipts').pluck().get()).toBe(phase === 'after_commit' ? 1 : 0);
  if (kind.startsWith('records')) {
    expect(f.row('a')!._record.revision).toBe(phase === 'after_commit' ? 1 : 0);
    if (state.reserved) expect(f.row(state.reserved)?.title ?? null).toBe(phase === 'after_commit' ? 'Reserved ordinary crash row' : null);
  } else if (kind === 'calendar_delete') expect(f.calendar.table.get('meeting') === null).toBe(phase === 'after_commit');
  else expect(f.calendar.table.get('meeting')!.event.summary).toBe(phase === 'before_commit' ? 'Original meeting'
    : kind === 'chat_calendar' ? 'Chat reviewed meeting' : 'Reviewed meeting');
  expect(f.row('b')!.title).toBe('b'); expect(f.calendarUpdates).not.toHaveBeenCalled(); expect(f.calendarDeletes).not.toHaveBeenCalled();
  const before = f.db.prepare('SELECT data FROM local_mutation_receipts').pluck().all();
  await f.recover(); expect(f.db.prepare('SELECT data FROM local_mutation_receipts').pluck().all()).toEqual(before);
}, CRASH_CASE_TIMEOUT_MS);
