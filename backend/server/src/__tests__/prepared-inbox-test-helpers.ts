import { createPreflightAnswerHandler } from '@recued/gateway';
import type { Answer } from '@recued/notification';
import type { ReceptionInboxDeps } from '../reception-inbox-handler.js';
import { preparedInboxApprovalActivity } from '../reception-inbox-prepared-answer.js';
import { createPreparedInboxRejectionRecorder } from '../reception-inbox-prepared-rejection.js';

/** Acceptance stub for non-concurrent inbox fixtures. Integrated fixtures
 *  deliver the complete snapshot to their real answer handler. Unit spies use
 *  the real gateway consumer with deletion left to the fixture's release.
 *  Concurrency and recovery use a real notification block in separate tests. */
export const testPreparedInboxAnswer = (deps: Pick<ReceptionInboxDeps, 'checkpointStore' | 'auditLog' | 'now'> & {
  submitAnswer?: NonNullable<ReceptionInboxDeps['submitAnswer']>;
  deliver?: (ask_id: string, answer: Answer) => Promise<void>;
  subviewStore?: ReceptionInboxDeps['subviewStore'];
}): NonNullable<ReceptionInboxDeps['submitPreparedAnswer']> => async (ask_id, option, prepare) => {
  const prepared = await prepare();
  const checkpoint = await deps.checkpointStore.get(prepared.checkpoint_id as string);
  if (!checkpoint) throw new Error('Fixture checkpoint missing');
  const answer = { option, answered_at: deps.now(), prepared };
  const audit = preparedInboxApprovalActivity({ ask_id, handler_kind: 'gateway.preflight',
    handler_payload: { checkpoint_id: checkpoint.checkpoint_id }, option, option_label: option, answered_at: answer.answered_at, answered_via: 'ui', prepared });
  if (audit) await deps.auditLog.logActivity(audit);
  if (deps.deliver) {
    await deps.deliver(ask_id, answer);
    return 'answered';
  }
  await createPreflightAnswerHandler({ checkpointStore: { ...deps.checkpointStore, delete: async () => {} },
    ...(deps.subviewStore ? { recordPreparedDenial: createPreparedInboxRejectionRecorder({ subviewStore: deps.subviewStore, auditLog: deps.auditLog }) } : {}),
    resumer: { resumeRun: async () => {
      if (!deps.submitAnswer) throw new Error('Fixture release missing');
      await deps.submitAnswer(ask_id, option);
    }, denyRun: async () => {
      if (!deps.submitAnswer) throw new Error('Fixture release missing');
      await deps.submitAnswer(ask_id, option);
    } },
  })({ checkpoint_id: checkpoint.checkpoint_id, run_id: checkpoint.run_id,
    recipe_id: checkpoint.recipe_id, gated_step_id: checkpoint.gated_step_id }, answer);
  return 'answered';
};
