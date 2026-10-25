/** The writer process of `local-mutation-crash.test.ts`: it approves a run over the shared resource
 * fixture and kills itself on one side of the SQLite commit. */
import { vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { crashWriterMain, resourceFixture, recordStep, calendarStep, recordsManifest } from './preapproval-resources-fixture.js';

export type Kind = 'records' | 'records_batch' | 'records_optional' | 'calendar_update' | 'calendar_delete';
export type Phase = 'before_commit' | 'after_commit';
type Fixture = Awaited<ReturnType<typeof resourceFixture>>;
export interface CrashState {
  stage: 'armed' | 'killed'; kind: Kind; phase: Phase; pid: number;
  previous: { dir: string; clock: { now: number }; token: Fixture['token'] };
  proposal_id: string; future_ref: string; reserved: string | null;
}

await crashWriterMain<{ kind: Kind; phase: Phase; output: string }>(import.meta.url, async input => {
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
