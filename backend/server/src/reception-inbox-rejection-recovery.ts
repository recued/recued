import { randomUUID } from 'node:crypto';
import { PREPARED_PREFLIGHT_DENIAL_KIND } from '@recued/gateway';
import type { AuditEntry } from '@recued/storage';
import type { Checkpoint } from '@recued/contracts';
import type { ReceptionInboxDeps } from './reception-inbox-handler.js';
import { runAsklessCheckpointDecision } from './checkpoint-decisions.js';
import { createPreparedInboxRejectionRecorder } from './reception-inbox-prepared-rejection.js';
import type { InboxRejectionHistory, PendingInboxRejection } from './storage/reception-inbox-rejection-journal.js';

const provesDenial = (entry: PendingInboxRejection, anchor: AuditEntry | null): boolean =>
  anchor?.run_id === entry.run_id && anchor.recipe_id === entry.recipe_id && anchor.commit_status === 'failed'
  && (anchor.errors ?? []).some(error => error.code === 'RECIPE_POLICY_DENIED'
    && error.error_id.startsWith('preflight-deny-') && error.source?.step_id === entry.gated_step_id
    && error.details?.denied_by === 'owner' && error.details?.checkpoint_id === entry.hold_id);

/** A prepared record is not a decision. Only the exact durable owner-denial
 *  marker accepts it. Recovery projects accepted history and repairs cleanup;
 *  it never executes a prepared but unaccepted denial. */
export const createInboxRejectionRecovery = (deps: Pick<ReceptionInboxDeps,
  'checkpointStore' | 'auditLog' | 'subviewStore' | 'releaseWithoutAsk' | 'now' | 'broadcast'>) => {
  const journal = deps.subviewStore.rejectionJournal;
  const release = deps.releaseWithoutAsk;
  if (!journal || !release) return undefined;
  const record = createPreparedInboxRejectionRecorder(deps);

  const accepted = async (entry: PendingInboxRejection): Promise<PendingInboxRejection | null> => {
    const current = await journal.get(entry.hold_id);
    if (!current || current.attempt_id !== entry.attempt_id) return null;
    const anchor = await deps.auditLog.get(current.run_id);
    if (current.phase === 'accepted') {
      if (anchor !== null && !provesDenial(current, anchor)) throw new Error('Accepted inbox denial conflicts with its run');
      return current;
    }
    if (anchor === null) throw new Error('Inbox rejection has no readable run anchor');
    if (!provesDenial(current, anchor)) { await journal.remove(current); return null; }
    try { await journal.accept(current); }
    catch (error) {
      const saved = await journal.get(current.hold_id);
      if (saved?.attempt_id !== current.attempt_id || saved.phase !== 'accepted') throw error;
    }
    return { ...current, phase: 'accepted' };
  };

  const finish = async (entry: PendingInboxRejection, retryCleanup: boolean): Promise<void> => {
    const checkpoint = await deps.checkpointStore.get(entry.hold_id);
    if (checkpoint && (checkpoint.run_id !== entry.run_id || checkpoint.recipe_id !== entry.recipe_id
      || checkpoint.gated_step_id !== entry.gated_step_id)) throw new Error('Inbox rejection checkpoint changed owner');
    let cleanupError: unknown;
    if (checkpoint && retryCleanup) {
      if (!provesDenial(entry, await deps.auditLog.get(entry.run_id))) {
        throw new Error('Inbox denial anchor is unavailable for checkpoint cleanup');
      }
      try { await release(checkpoint, { kind: 'deny' }); } catch (error) { cleanupError = error; }
    }
    await record({ option: 'deny', answered_at: entry.rejected_at, prepared: {
      kind: PREPARED_PREFLIGHT_DENIAL_KIND, checkpoint_id: entry.hold_id, inbox_rejection: entry.history,
    } });
    if (cleanupError !== undefined) throw cleanupError;
    if (await deps.checkpointStore.get(entry.hold_id) === null) await journal.remove(entry);
  };

  const retry = async (holdId: string): Promise<boolean> => {
    const pending = await journal.get(holdId);
    if (!pending) return false;
    const entry = await accepted(pending);
    if (!entry) return false;
    try { await finish(entry, true); } catch { /* Accepted denial remains recoverable. */ }
    return true;
  };

  let inflight: Promise<{ recovered: number; discarded: number; failed: number }> | undefined;
  return {
    retry,
    async reject(checkpoint: Checkpoint, history: InboxRejectionHistory): Promise<void> {
      if (!checkpoint.recipe_id || !checkpoint.gated_step_id) throw new Error('Inbox rejection requires a recipe checkpoint');
      const entry: PendingInboxRejection = { attempt_id: randomUUID(), hold_id: checkpoint.checkpoint_id,
        run_id: checkpoint.run_id, recipe_id: checkpoint.recipe_id, gated_step_id: checkpoint.gated_step_id,
        rejected_at: deps.now(), phase: 'prepared', history: JSON.parse(JSON.stringify(history)) as InboxRejectionHistory };
      try { await journal.prepare(entry); }
      catch (error) {
        const saved = await journal.get(entry.hold_id);
        if (JSON.stringify(saved) !== JSON.stringify(entry)) throw error;
      }
      let releaseError: unknown;
      try { await release(checkpoint, { kind: 'deny' }); } catch (error) { releaseError = error; }
      // Read the durable outcome even if the adapter reported an error after committing.
      const anchor = await deps.auditLog.get(entry.run_id);
      if (!provesDenial(entry, anchor)) {
        if (anchor !== null) await journal.remove(entry);
        throw releaseError ?? new Error('The held operation was not denied');
      }
      try {
        const committed = await accepted(entry);
        if (committed) await finish(committed, false);
      } catch { /* The denial is durable; the journal carries history/cleanup recovery. */ }
    },
    recover(): Promise<{ recovered: number; discarded: number; failed: number }> {
      if (inflight) return inflight;
      inflight = (async () => {
        const result = { recovered: 0, discarded: 0, failed: 0 };
        for (const pending of await journal.list()) {
          try {
            await runAsklessCheckpointDecision(deps, pending.hold_id, async () => {
              const entry = await accepted(pending);
              if (!entry) { result.discarded++; return; }
              await finish(entry, true); result.recovered++;
              deps.broadcast({ kind: 'reception_inbox', op: 'rejected', hold_id: entry.hold_id });
            });
          } catch { result.failed++; }
        }
        return result;
      })().finally(() => { inflight = undefined; });
      return inflight;
    },
  };
};
