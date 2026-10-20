/** Real process death on either side of the SQLite commit, using the same
 * stores, admission, driver and receipts as the ordinary resource fixtures. */
import { afterEach, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resourceFixture, resourceFixtureDisposers, recordStep, calendarStep, recordsManifest } from './preapproval-resources-fixture.js';

const inputFile = process.env.RECUED_LOCAL_MUTATION_CRASH_INPUT;
const root = resolve(import.meta.dirname, '../../../..');
const dirs: string[] = [];
afterEach(async () => {
  for (const dispose of resourceFixtureDisposers.splice(0).reverse()) await dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
type Kind = 'records' | 'records_batch' | 'records_optional' | 'calendar_update' | 'calendar_delete';
type Phase = 'before_commit' | 'after_commit';
type Fixture = Awaited<ReturnType<typeof resourceFixture>>;
interface CrashState {
  stage: 'armed' | 'killed'; kind: Kind; phase: Phase; pid: number;
  previous: { dir: string; clock: { now: number }; token: Fixture['token'] };
  proposal_id: string; future_ref: string; reserved: string | null;
}

it.runIf(Boolean(inputFile))('local mutation crash writer', async () => {
  const input = JSON.parse(readFileSync(inputFile!, 'utf8')) as { kind: Kind; phase: Phase; output: string };
  const f = await resourceFixture();
  const first = input.kind === 'records' ? recordStep('a')
    : input.kind === 'records_optional' ? { ...recordStep('a'), optional: true }
    : input.kind === 'records_batch' ? { id: 'batch', ingredient: recordsManifest.slug, input: { operation: 'batch', args: { ops: [
      { entity: 'note', action: 'update', args: { id: 'a', expected_version: 1, expected_revision: 0, set: { title: 'Reviewed a' } } },
      { entity: 'note', action: 'create', args: { values: { title: 'Reserved crash row' } } },
    ] } } }
      : input.kind === 'calendar_update' ? calendarStep()
        : { id: 'remove', ingredient: 'calendar-delete', input: { slug: 'local', source_id: 'meeting' } };
  f.save([first, recordStep('b')]);
  const original = await f.service.prepare(f.request(), f.origin);
  const review = await f.storage.repository.review(original.proposal_id, f.responder);
  await f.storage.repository.decide(await f.decision(original.proposal_id), f.responder);
  const state: CrashState = { stage: 'armed', kind: input.kind, phase: input.phase, pid: process.pid,
    previous: { dir: f.dir, clock: f.clock, token: f.token }, proposal_id: original.proposal_id, future_ref: original.future_execution_ref,
    reserved: input.kind === 'records_batch' ? String(review.members[0]!.resource_review!.resources[1]!.after!.id) : null };
  writeFileSync(input.output, JSON.stringify(state));
  const crash = (): never => {
    writeFileSync(input.output, JSON.stringify({ ...state, stage: 'killed' }));
    process.kill(process.pid, 'SIGKILL'); throw new Error('SIGKILL did not stop the crash writer');
  };
  if (input.phase === 'before_commit') {
    f.db.function('crash_before_receipt', crash);
    f.db.exec('CREATE TRIGGER crash_before_receipt BEFORE INSERT ON local_mutation_receipts BEGIN SELECT crash_before_receipt(); END');
  } else if (input.kind.startsWith('records')) f.changed.mockImplementation(crash);
  else if (input.kind === 'calendar_update') {
    const upsert = f.calendar.table.upsert.bind(f.calendar.table);
    vi.spyOn(f.calendar.table, 'upsert').mockImplementation(value => { upsert(value); return crash(); });
  } else {
    const remove = f.calendar.table.delete.bind(f.calendar.table);
    vi.spyOn(f.calendar.table, 'delete').mockImplementation((...args) => { remove(...args); return crash(); });
  }
  await f.run(original.future_execution_ref);
  throw new Error('The mutation never reached its crash boundary');
});

const cases: { kind: Kind; phase: Phase }[] = [
  ...(['records', 'records_batch', 'calendar_update', 'calendar_delete'] as const)
    .flatMap(kind => (['before_commit', 'after_commit'] as const).map(phase => ({ kind, phase }))),
  { kind: 'records_optional', phase: 'after_commit' },
];
it.skipIf(Boolean(inputFile)).each(cases)('recovers $kind after process death $phase without another mutation', async ({ kind, phase }) => {
  const dir = mkdtempSync(join(tmpdir(), 'recued-local-crash-test-')); dirs.push(dir);
  const input = join(dir, 'request.json'), output = join(dir, 'state.json');
  writeFileSync(input, JSON.stringify({ kind, phase, output }));
  // A nested runner supplies Vitest's spies to the shared host fixture. Its
  // worker really dies; the controller's expected failure is kept in a log.
  const child = spawn(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run',
    resolve(import.meta.filename), '--pool=forks', '--maxWorkers=1', '--project=backend-shared', '--teardownTimeout=1000', '-t', 'local mutation crash writer'],
  { cwd: root, env: { ...process.env, RECUED_LOCAL_MUTATION_CRASH_INPUT: input }, stdio: ['ignore', 'pipe', 'pipe'] });
  let trace = '';
  child.stdout.on('data', bytes => { trace += String(bytes); });
  child.stderr.on('data', bytes => { trace += String(bytes); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
  const code = await new Promise<number | null>((done, reject) => { child.once('error', reject); child.once('exit', done); });
  clearTimeout(timer); writeFileSync(join(dir, 'expected-crash.log'), trace);
  expect(code, trace.slice(-3000)).not.toBe(0);
  expect(existsSync(output), trace.slice(-3000)).toBe(true);
  const state = JSON.parse(readFileSync(output, 'utf8')) as CrashState;
  dirs.push(state.previous.dir);
  expect(state.stage).toBe('killed');
  expect(() => process.kill(state.pid, 0)).toThrow();
  const f = await resourceFixture(state.previous);
  const inspection = await f.storage.repository.inspect(state.proposal_id);
  expect(inspection.members[0]!.status).toBe(phase === 'after_commit' ? 'succeeded' : 'in_doubt');
  const completeProgram = kind !== 'records_optional';
  expect(inspection.execution_status).toBe(phase === 'after_commit' && completeProgram ? 'partial' : 'in_doubt');
  expect(Boolean(inspection.members[0]!.local_receipt)).toBe(phase === 'after_commit');
  expect(inspection.recovery?.eligible).toBe(phase === 'after_commit' && completeProgram);
  expect(f.db.prepare('SELECT count(*) FROM local_mutation_receipts').pluck().get()).toBe(phase === 'after_commit' ? 1 : 0);
  if (kind.startsWith('records')) {
    expect(f.row('a')!._record.revision).toBe(phase === 'after_commit' ? 1 : 0);
    if (state.reserved) expect(f.row(state.reserved)?.title ?? null).toBe(phase === 'after_commit' ? 'Reserved crash row' : null);
  } else if (kind === 'calendar_update') {
    expect(f.calendar.table.get('meeting')!.event.summary).toBe(phase === 'after_commit' ? 'Reviewed meeting' : 'Original meeting');
  } else expect(f.calendar.table.get('meeting') === null).toBe(phase === 'after_commit');
  expect(f.row('b')!.title).toBe('b');
  expect(f.calendarUpdates).not.toHaveBeenCalled(); expect(f.calendarDeletes).not.toHaveBeenCalled();
  await expect(f.run(state.future_ref)).rejects.toBeDefined();
  const reopened = await f.reopen();
  expect((await reopened.storage.repository.inspect(state.proposal_id)).members).toEqual(inspection.members);
}, 90_000);
