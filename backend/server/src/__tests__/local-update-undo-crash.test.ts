/** Kill an actual writer on either side of COMMIT. No mock throw can establish
 * the durability boundary or prove that a new process refuses a replay. */
import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CRASH_CASE_TIMEOUT_MS, CRASH_WRITER_LIMIT_MS, resourceFixture, resourceFixtureDisposers, runCrashWriter,
} from './preapproval-resources-fixture.js';
import type { CrashState } from './local-update-undo-crash-writer.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dispose of resourceFixtureDisposers.splice(0).reverse()) await dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const cases = (['records', 'batch', 'calendar'] as const)
  .flatMap(kind => (['before_commit', 'after_commit'] as const).map(phase => ({ kind, phase })));
it.each(cases)('recovers $kind undo after process death $phase without replay', async ({ kind, phase }) => {
  const dir = mkdtempSync(join(tmpdir(), 'recued-undo-crash-')); dirs.push(dir);
  const output = join(dir, 'state.json');
  const { stopped, signal, trace } = await runCrashWriter(new URL('./local-update-undo-crash-writer.ts', import.meta.url), dir, { kind, phase, output });
  expect(stopped, `the crash writer was still running after ${CRASH_WRITER_LIMIT_MS / 1000} s and was stopped: a hang, or a machine too loaded to start it`).toBe(false);
  expect(signal, trace.slice(-3000)).toBe('SIGKILL'); expect(existsSync(output), trace.slice(-3000)).toBe(true);
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
