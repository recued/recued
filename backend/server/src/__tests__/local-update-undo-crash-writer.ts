/** The writer process of `local-update-undo-crash.test.ts`: it applies a reviewed change, then
 * decides its undo and kills itself on one side of COMMIT. */
import { expect, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import type { LocalUpdateUndoDecision, RecipeDefinition } from '@recued/contracts';
import { crashWriterMain, resourceFixture, recordStep, calendarStep, recordsManifest } from './preapproval-resources-fixture.js';

export type Kind = 'records' | 'batch' | 'calendar';
export type Phase = 'before_commit' | 'after_commit';
type Fixture = Awaited<ReturnType<typeof resourceFixture>>;
export interface CrashState {
  stage: 'armed' | 'killed'; kind: Kind; phase: Phase; pid: number;
  previous: { dir: string; clock: { now: number }; token: Fixture['token'] };
  decision: LocalUpdateUndoDecision; original_receipt_id: string;
}

await crashWriterMain<{ kind: Kind; phase: Phase; output: string }>(import.meta.url, async input => {
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
