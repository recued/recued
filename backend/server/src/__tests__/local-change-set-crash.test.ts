/** Actual writer death on both sides of the shared COMMIT, in each direction. */
import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { LocalChangeSetDecision } from '@recued/contracts';
import { resourceFixture, resourceFixtureDisposers } from './preapproval-resources-fixture.js';
const inputFile = process.env.RECUED_LOCAL_SET_CRASH_INPUT;
const root = resolve(import.meta.dirname,'../../../..'), dirs: string[] = [];
type Fixture = Awaited<ReturnType<typeof resourceFixture>>;
interface State {
  stage: 'armed' | 'killed'; pid: number; direction: 'forward' | 'undo'; phase: 'before_commit' | 'after_commit';
  previous: { dir: string; clock: { now: number }; token: Fixture['token'] };
  decision: LocalChangeSetDecision;
}
afterEach(async () => {
  for (const dispose of resourceFixtureDisposers.splice(0).reverse()) await dispose();
  for (const dir of dirs.splice(0)) rmSync(dir,{ recursive: true,force: true });
});
it.runIf(Boolean(inputFile))('local change set crash writer',async () => {
  const input = JSON.parse(readFileSync(inputFile!,'utf8')) as { direction: State['direction']; phase: State['phase']; output: string };
  const f = await resourceFixture(), service = f.composed.handlers.localChanges!;
  const source = await f.service.prepare(f.request(),f.origin);
  let view = await service.prepare({ proposal_id: source.proposal_id,request_id: randomUUID() },f.origin);
  if (input.direction === 'undo') {
    await service.decide({ change_set_id: view.change_set_id,review_hash: view.review!.review_hash,decision: 'approve' },f.origin);
    view = await service.prepareUndo({ change_set_id: view.change_set_id,request_id: randomUUID() },f.origin);
  }
  const state: State = { stage: 'armed',pid: process.pid,direction: input.direction,phase: input.phase,
    previous: { dir: f.dir,clock: f.clock,token: f.token },
    decision: { change_set_id: view.change_set_id,review_hash: view.review!.review_hash,decision: 'approve' } };
  writeFileSync(input.output,JSON.stringify(state));
  const crash = (): never => {
    writeFileSync(input.output,JSON.stringify({ ...state,stage: 'killed' }));
    process.kill(process.pid,'SIGKILL'); throw new Error('Writer survived SIGKILL');
  };
  if (input.phase === 'before_commit') {
    f.db.function('kill_atomic_before_commit',crash);
    const last = view.review!.changes.at(-1)!.member_id;
    f.db.function('is_last_atomic_member',(member: string) => member === last ? 1 : 0);
    f.db.exec("CREATE TRIGGER kill_atomic_before_commit BEFORE INSERT ON local_change_set_members WHEN is_last_atomic_member(NEW.member_id)=1 BEGIN SELECT kill_atomic_before_commit(); END");
  } else f.changed.mockImplementation(crash);
  await service.decide(state.decision,f.origin); throw new Error('Writer did not reach its crash boundary');
});
const cases = (['forward','undo'] as const).flatMap(direction => (['before_commit','after_commit'] as const).map(phase => ({ direction,phase })));
it.skipIf(Boolean(inputFile)).each(cases)('recovers $direction after process death $phase with no partial data or replay',async ({ direction,phase }) => {
  const dir = mkdtempSync(join(tmpdir(),'recued-local-set-kill-')); dirs.push(dir);
  const input = join(dir,'request.json'), output = join(dir,'state.json');
  writeFileSync(input,JSON.stringify({ direction,phase,output }));
  const child = spawn(process.execPath,[join(root,'node_modules/vitest/vitest.mjs'),'run',resolve(import.meta.filename),
    '--pool=forks','--maxWorkers=1','--project=backend-shared','--teardownTimeout=1000','-t','local change set crash writer'],
  { cwd: root,env: { ...process.env,RECUED_LOCAL_SET_CRASH_INPUT: input },stdio: ['ignore','pipe','pipe'] });
  let trace = ''; child.stdout.on('data',bytes => { trace += String(bytes); }); child.stderr.on('data',bytes => { trace += String(bytes); });
  const timer = setTimeout(() => child.kill('SIGKILL'),60_000);
  const code = await new Promise<number | null>((done,reject) => { child.once('error',reject); child.once('exit',done); });
  clearTimeout(timer); writeFileSync(join(dir,'expected-crash.log'),trace);
  expect(code,trace.slice(-3000)).not.toBe(0); expect(existsSync(output),trace.slice(-3000)).toBe(true);
  const state = JSON.parse(readFileSync(output,'utf8')) as State; dirs.push(state.previous.dir);
  expect(state.stage).toBe('killed'); expect(() => process.kill(state.pid,0)).toThrow();
  const f = await resourceFixture(state.previous), service = f.composed.handlers.localChanges!;
  const result = await service.decide(state.decision,f.origin);
  expect(result.status).toBe(phase === 'after_commit' ? 'completed' : 'unknown');
  expect(result.receipts).toHaveLength(phase === 'after_commit' ? 3 : 0);
  const changed = direction === 'forward' ? phase === 'after_commit' : phase === 'before_commit';
  expect(f.row('a')!.title).toBe(changed ? 'Reviewed a' : 'a');
  expect(f.row('b')!.title).toBe(changed ? 'Reviewed b' : 'b');
  expect(f.calendar.table.get('meeting')!.event.summary).toBe(changed ? 'Reviewed meeting' : 'Original meeting');
  const receipts = direction === 'undo' ? phase === 'after_commit' ? 6 : 3 : phase === 'after_commit' ? 3 : 0;
  expect(f.db.prepare('SELECT count(*) FROM local_mutation_receipts').pluck().get()).toBe(receipts);
  expect(await service.get(state.decision.change_set_id,f.origin)).toEqual(result);
  expect(await service.decide(state.decision,f.origin)).toEqual(result);
  expect(f.changed).not.toHaveBeenCalled(); expect(f.calendarUpdates).not.toHaveBeenCalled();
  const second = await f.reopen();
  expect(await second.composed.handlers.localChanges!.get(state.decision.change_set_id,second.origin)).toEqual(result);
},90_000);
