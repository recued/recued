/** Real process death on either side of the SQLite commit, using the same
 * stores, admission, driver and receipts as the ordinary resource fixtures. */
import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CRASH_CASE_TIMEOUT_MS, CRASH_WRITER_LIMIT_MS, resourceFixture, resourceFixtureDisposers, runCrashWriter,
} from './preapproval-resources-fixture.js';
import type { CrashState, Kind, Phase } from './local-mutation-crash-writer.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dispose of resourceFixtureDisposers.splice(0).reverse()) await dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const cases: { kind: Kind; phase: Phase }[] = [
  ...(['records', 'records_batch', 'calendar_update', 'calendar_delete'] as const)
    .flatMap(kind => (['before_commit', 'after_commit'] as const).map(phase => ({ kind, phase }))),
  { kind: 'records_optional', phase: 'after_commit' },
];
it.each(cases)('recovers $kind after process death $phase without another mutation', async ({ kind, phase }) => {
  const dir = mkdtempSync(join(tmpdir(), 'recued-local-crash-test-')); dirs.push(dir);
  const output = join(dir, 'state.json');
  // The writer is a process of its own and really dies; what it printed is kept in a log.
  const { stopped, signal, trace } = await runCrashWriter(new URL('./local-mutation-crash-writer.ts', import.meta.url), dir, { kind, phase, output });
  expect(stopped, `the crash writer was still running after ${CRASH_WRITER_LIMIT_MS / 1000} s and was stopped: a hang, or a machine too loaded to start it`).toBe(false);
  expect(signal, trace.slice(-3000)).toBe('SIGKILL');
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
}, CRASH_CASE_TIMEOUT_MS);
