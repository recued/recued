/** Actual writer death on both sides of the shared COMMIT, in each direction. */
import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CRASH_CASE_TIMEOUT_MS, CRASH_WRITER_LIMIT_MS, resourceFixture, resourceFixtureDisposers, runCrashWriter } from './preapproval-resources-fixture.js';
import type { State } from './local-change-set-crash-writer.js';
const dirs: string[] = [];
afterEach(async () => {
  for (const dispose of resourceFixtureDisposers.splice(0).reverse()) await dispose();
  for (const dir of dirs.splice(0)) rmSync(dir,{ recursive: true,force: true });
});
const cases = (['forward','undo'] as const).flatMap(direction => (['before_commit','after_commit'] as const).map(phase => ({ direction,phase })));
it.each(cases)('recovers $direction after process death $phase with no partial data or replay',async ({ direction,phase }) => {
  const dir = mkdtempSync(join(tmpdir(),'recued-local-set-kill-')); dirs.push(dir);
  const output = join(dir,'state.json');
  const { stopped,signal,trace } = await runCrashWriter(new URL('./local-change-set-crash-writer.ts',import.meta.url),dir,{ direction,phase,output });
  expect(stopped,`the crash writer was still running after ${CRASH_WRITER_LIMIT_MS / 1000} s and was stopped: a hang, or a machine too loaded to start it`).toBe(false);
  expect(signal,trace.slice(-3000)).toBe('SIGKILL'); expect(existsSync(output),trace.slice(-3000)).toBe(true);
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
},CRASH_CASE_TIMEOUT_MS);
