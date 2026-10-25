/** The writer process of `local-change-set-crash.test.ts`: it decides a local change set, forward
 * or as its undo, and kills itself on one side of the shared COMMIT. */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { LocalChangeSetDecision } from '@recued/contracts';
import { crashWriterMain, resourceFixture } from './preapproval-resources-fixture.js';
type Fixture = Awaited<ReturnType<typeof resourceFixture>>;
export interface State {
  stage: 'armed' | 'killed'; pid: number; direction: 'forward' | 'undo'; phase: 'before_commit' | 'after_commit';
  previous: { dir: string; clock: { now: number }; token: Fixture['token'] };
  decision: LocalChangeSetDecision;
}
await crashWriterMain<{ direction: State['direction']; phase: State['phase']; output: string }>(import.meta.url,async input => {
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
