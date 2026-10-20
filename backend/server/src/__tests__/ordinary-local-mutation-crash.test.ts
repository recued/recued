/** Real process death around the shared data/journal transaction, through
 * ordinary recipe approval and direct Chat approval dispatch. */
import { afterEach, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ordinaryLocalFixture } from './ordinary-local-mutations-fixture.js';
import { resourceFixtureDisposers, recordStep, calendarStep, recordsManifest } from './preapproval-resources-fixture.js';
import { createSqliteChatPlanStore } from '../storage/chat-plan-store.js';
import { createPreflightResumer } from '../preflight-resumer.js';

type Fixture = Awaited<ReturnType<typeof ordinaryLocalFixture>>;
type Kind = 'records' | 'records_batch' | 'calendar_update' | 'calendar_delete' | 'chat_calendar';
type Phase = 'before_commit' | 'after_commit';
interface CrashState {
  stage: 'armed' | 'killed'; pid: number;
  previous: { dir: string; clock: { now: number }; token: Fixture['token'] };
  action_ref?: string; run_id?: string; checkpoint_id?: string;
  plan_id?: string; session_id?: string; reserved?: string;
}
const inputFile = process.env.RECUED_ORDINARY_LOCAL_CRASH_INPUT;
const root = resolve(import.meta.dirname, '../../../..');
const dirs: string[] = [];
afterEach(async () => {
  for (const dispose of resourceFixtureDisposers.splice(0).reverse()) await dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it.runIf(Boolean(inputFile))('ordinary local mutation crash writer', async () => {
  const input = JSON.parse(readFileSync(inputFile!, 'utf8')) as { kind: Kind; phase: Phase; output: string };
  const f = await ordinaryLocalFixture();
  const state: CrashState = { stage: 'armed', pid: process.pid,
    previous: { dir: f.dir, clock: f.clock, token: f.token } };
  let execute: () => Promise<unknown>;
  if (input.kind === 'chat_calendar') {
    const chat = await f.chat(); state.plan_id = chat.proposal.plan_id; state.session_id = chat.session_id;
    execute = () => chat.dispatch('execution');
  } else {
    const step = input.kind === 'records' ? recordStep('a')
      : input.kind === 'records_batch' ? { id: 'batch', ingredient: recordsManifest.slug, input: { operation: 'batch', args: { ops: [
        { entity: 'note', action: 'update', args: { id: 'a', expected_version: 1, expected_revision: 0, set: { title: 'Reviewed a' } } },
        { entity: 'note', action: 'create', args: { values: { title: 'Reserved ordinary crash row' } } },
      ] } } }
        : input.kind === 'calendar_update' ? calendarStep()
          : { id: 'remove', ingredient: 'calendar-delete', input: { slug: 'local', source_id: 'meeting' } };
    const held = await f.hold([step, recordStep('b')]);
    state.action_ref = held.action.action_ref; state.run_id = held.action.run_id; state.checkpoint_id = held.checkpoint.checkpoint_id;
    if (input.kind === 'records_batch') state.reserved = String(held.checkpoint.resource_review!.resources
      .find(resource => resource.precondition.kind === 'records_absent')!.after!.id);
    execute = held.resume;
  }
  writeFileSync(input.output, JSON.stringify(state));
  const crash = (): never => {
    writeFileSync(input.output, JSON.stringify({ ...state, stage: 'killed' }));
    process.kill(process.pid, 'SIGKILL'); throw new Error('SIGKILL did not stop the writer');
  };
  if (input.phase === 'before_commit') {
    f.db.function('crash_before_ordinary_receipt', crash);
    f.db.exec('CREATE TRIGGER crash_before_ordinary_receipt BEFORE INSERT ON local_mutation_receipts BEGIN SELECT crash_before_ordinary_receipt(); END');
  } else if (input.kind.startsWith('records')) f.changed.mockImplementation(crash);
  else if (input.kind === 'calendar_delete') {
    const remove = f.calendar.table.delete.bind(f.calendar.table);
    vi.spyOn(f.calendar.table, 'delete').mockImplementation((...args) => { remove(...args); return crash(); });
  } else {
    const upsert = f.calendar.table.upsert.bind(f.calendar.table);
    vi.spyOn(f.calendar.table, 'upsert').mockImplementation(value => { upsert(value); return crash(); });
  }
  await execute(); throw new Error('The approved mutation never reached its crash boundary');
});

const cases = (['records', 'records_batch', 'calendar_update', 'calendar_delete', 'chat_calendar'] as const)
  .flatMap(kind => (['before_commit', 'after_commit'] as const).map(phase => ({ kind, phase })));
it.skipIf(Boolean(inputFile)).each(cases)('recovers ordinary $kind $phase without replay', async ({ kind, phase }) => {
  const dir = mkdtempSync(join(tmpdir(), 'recued-ordinary-local-crash-')); dirs.push(dir);
  const input = join(dir, 'input.json'), output = join(dir, 'state.json');
  writeFileSync(input, JSON.stringify({ kind, phase, output }));
  const child = spawn(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', resolve(import.meta.filename),
    '--pool=forks', '--maxWorkers=1', '--project=backend-shared', '--teardownTimeout=1000', '-t', 'ordinary local mutation crash writer'],
  { cwd: root, env: { ...process.env, RECUED_ORDINARY_LOCAL_CRASH_INPUT: input }, stdio: ['ignore', 'pipe', 'pipe'] });
  let trace = ''; child.stdout.on('data', bytes => { trace += String(bytes); }); child.stderr.on('data', bytes => { trace += String(bytes); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
  const code = await new Promise<number | null>((done, reject) => { child.once('error', reject); child.once('exit', done); });
  clearTimeout(timer); writeFileSync(join(dir, 'expected-crash.log'), trace);
  expect(code, trace.slice(-3000)).not.toBe(0); expect(existsSync(output), trace.slice(-3000)).toBe(true);
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
}, 90_000);
