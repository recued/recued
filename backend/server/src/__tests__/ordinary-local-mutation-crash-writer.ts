/** The writer process of `ordinary-local-mutation-crash.test.ts`: it resumes an ordinary approval,
 * or dispatches an approved Chat change, and kills itself on one side of the commit. */
import { vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { ordinaryLocalFixture } from './ordinary-local-mutations-fixture.js';
import { crashWriterMain, recordStep, calendarStep, recordsManifest } from './preapproval-resources-fixture.js';

type Fixture = Awaited<ReturnType<typeof ordinaryLocalFixture>>;
export type Kind = 'records' | 'records_batch' | 'calendar_update' | 'calendar_delete' | 'chat_calendar';
export type Phase = 'before_commit' | 'after_commit';
export interface CrashState {
  stage: 'armed' | 'killed'; pid: number;
  previous: { dir: string; clock: { now: number }; token: Fixture['token'] };
  action_ref?: string; run_id?: string; checkpoint_id?: string;
  plan_id?: string; session_id?: string; reserved?: string;
}

await crashWriterMain<{ kind: Kind; phase: Phase; output: string }>(import.meta.url, async input => {
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
