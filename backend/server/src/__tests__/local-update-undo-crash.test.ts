/** Kill an actual writer on either side of COMMIT. No mock throw can establish
 * the durability boundary or prove that a new process refuses a replay. */
import { afterEach, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { LocalUpdateUndoDecision, RecipeDefinition } from '@recued/contracts';
import {
  CRASH_CASE_TIMEOUT_MS, CRASH_WRITER_LIMIT_MS, resourceFixture, resourceFixtureDisposers, recordStep, calendarStep, recordsManifest,
} from './preapproval-resources-fixture.js';

const inputFile = process.env.RECUED_UPDATE_UNDO_CRASH_INPUT;
const root = resolve(import.meta.dirname, '../../../..');
const dirs: string[] = [];
afterEach(async () => {
  for (const dispose of resourceFixtureDisposers.splice(0).reverse()) await dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
type Kind = 'records' | 'batch' | 'calendar';
type Phase = 'before_commit' | 'after_commit';
type Fixture = Awaited<ReturnType<typeof resourceFixture>>;
interface CrashState {
  stage: 'armed' | 'killed'; kind: Kind; phase: Phase; pid: number;
  previous: { dir: string; clock: { now: number }; token: Fixture['token'] };
  decision: LocalUpdateUndoDecision; original_receipt_id: string;
}

it.runIf(Boolean(inputFile))('local update undo crash writer', async () => {
  const input = JSON.parse(readFileSync(inputFile!, 'utf8')) as { kind: Kind; phase: Phase; output: string };
  const f = await resourceFixture();
  const batch: RecipeDefinition['steps'][number] = { id: 'updates', ingredient: recordsManifest.slug,
    input: { operation: 'batch', args: { ops: ['a', 'b'].map(id => ({ entity: 'note', action: 'update',
      args: { id, expected_version: 1, expected_revision: 0, set: { title: 'Changed ' + id } } })) } } };
  f.save([input.kind === 'records' ? recordStep('a') : input.kind === 'calendar' ? calendarStep() : batch]);
  const prepared = await f.service.prepare(f.request(), f.origin);
  await f.storage.repository.decide(await f.decision(prepared.proposal_id), f.responder);
  expect(await f.run(prepared.future_execution_ref)).toMatchObject({ success: true });
  const original_receipt_id = (await f.storage.repository.inspect(prepared.proposal_id)).members[0]!.local_receipt!.receipt_id;
  const review = await f.composed.handlers.localUndo!.review(original_receipt_id, f.origin);
  const state: CrashState = { stage: 'armed', kind: input.kind, phase: input.phase, pid: process.pid,
    previous: { dir: f.dir, clock: f.clock, token: f.token }, original_receipt_id,
    decision: { undo_id: review.undo_id, review_hash: review.review_hash, decision: 'approve' } };
  writeFileSync(input.output, JSON.stringify(state));
  const crash = (): never => {
    writeFileSync(input.output, JSON.stringify({ ...state, stage: 'killed' }));
    process.kill(process.pid, 'SIGKILL'); throw new Error('The writer survived SIGKILL');
  };
  if (input.phase === 'before_commit') {
    f.db.function('kill_undo_before_commit', crash);
    f.db.exec("CREATE TRIGGER kill_undo BEFORE INSERT ON local_update_undo_links BEGIN SELECT kill_undo_before_commit(); END");
  } else if (input.kind !== 'calendar') f.changed.mockImplementation(crash);
  else {
    const upsert = f.calendar.table.upsert.bind(f.calendar.table);
    vi.spyOn(f.calendar.table, 'upsert').mockImplementation(value => { upsert(value); return crash(); });
  }
  await f.composed.handlers.localUndo!.decide(state.decision, f.origin);
  throw new Error('Undo did not reach its crash boundary');
});

const cases = (['records', 'batch', 'calendar'] as const)
  .flatMap(kind => (['before_commit', 'after_commit'] as const).map(phase => ({ kind, phase })));
it.skipIf(Boolean(inputFile)).each(cases)('recovers $kind undo after process death $phase without replay', async ({ kind, phase }) => {
  const dir = mkdtempSync(join(tmpdir(), 'recued-undo-crash-')); dirs.push(dir);
  const input = join(dir, 'request.json'), output = join(dir, 'state.json');
  writeFileSync(input, JSON.stringify({ kind, phase, output }));
  const child = spawn(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run',
    resolve(import.meta.filename), '--pool=forks', '--maxWorkers=1', '--project=backend-shared',
    '--teardownTimeout=1000', `--testTimeout=${CRASH_WRITER_LIMIT_MS}`, '-t', 'local update undo crash writer'],
  { cwd: root, env: { ...process.env, RECUED_UPDATE_UNDO_CRASH_INPUT: input }, stdio: ['ignore', 'pipe', 'pipe'] });
  let trace = ''; child.stdout.on('data', bytes => { trace += String(bytes); }); child.stderr.on('data', bytes => { trace += String(bytes); });
  let stopped = false;
  const timer = setTimeout(() => { stopped = true; child.kill('SIGKILL'); }, CRASH_WRITER_LIMIT_MS);
  const code = await new Promise<number | null>((done, reject) => { child.once('error', reject); child.once('exit', done); });
  clearTimeout(timer); writeFileSync(join(dir, 'expected-crash.log'), trace);
  expect(stopped, `the crash writer was still running after ${CRASH_WRITER_LIMIT_MS / 1000} s and was stopped: a hang, or a machine too loaded to start it`).toBe(false);
  expect(code, trace.slice(-3000)).not.toBe(0); expect(existsSync(output), trace.slice(-3000)).toBe(true);
  const state = JSON.parse(readFileSync(output, 'utf8')) as CrashState; dirs.push(state.previous.dir);
  expect(state.stage).toBe('killed'); expect(() => process.kill(state.pid, 0)).toThrow();
  const f = await resourceFixture(state.previous);
  const result = await f.composed.handlers.localUndo!.decide(state.decision, f.origin);
  expect(result.status).toBe(phase === 'after_commit' ? 'completed' : 'unknown');
  expect(Boolean(result.local_receipt)).toBe(phase === 'after_commit');
  expect(f.db.prepare('SELECT count(*) FROM local_mutation_receipts').pluck().get()).toBe(phase === 'after_commit' ? 2 : 1);
  if (kind === 'calendar') expect(f.calendar.table.get('meeting')!.event.summary).toBe(phase === 'after_commit' ? 'Original meeting' : 'Reviewed meeting');
  else {
    expect(f.row('a')!._record.revision).toBe(phase === 'after_commit' ? 2 : 1);
    expect(f.row('a')!.title).toBe(phase === 'after_commit' ? 'a' : kind === 'batch' ? 'Changed a' : 'Reviewed a');
    if (kind === 'batch') expect(f.row('b')).toMatchObject({ title: phase === 'after_commit' ? 'b' : 'Changed b',
      _record: { revision: phase === 'after_commit' ? 2 : 1 } });
  }
  expect(f.calendarUpdates).not.toHaveBeenCalled(); expect(f.changed).not.toHaveBeenCalled();
  expect(await f.composed.handlers.localUndo!.decide(state.decision, f.origin)).toEqual(result);
  const second = await f.reopen();
  expect(await second.composed.handlers.localUndo!.decide(state.decision, second.origin)).toEqual(result);
}, CRASH_CASE_TIMEOUT_MS);
