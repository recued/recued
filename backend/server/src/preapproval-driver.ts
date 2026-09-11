/** Owned automation entry. The legacy row stays parked until the repository
 * records the selected occurrence and hands this driver its private run. */
import { RpcError, type Checkpoint, type EventTrigger } from '@recued/contracts';
import type { WarehouseEvent } from '@recued/warehouse-events';
import { handleExecute, resumeReviewedParent, type ExecuteHandlerDeps } from './execute-handler.js';
import type { PreapprovalStorage } from './storage/preapproval-storage.js';
import type { PreapprovalActivations, TriggerOccurrence } from './storage/preapproval-activations.js';
import type { createPreapprovalExecutionRuntime } from './preapproval-execution.js';
import type { ExecuteRequest, ExecuteResponse } from './types.js';
import { triggerEventContext } from './triggers/event-context.js';

export const createPreapprovalDriver = (deps: {
  storage: PreapprovalStorage;
  activations: PreapprovalActivations;
  runtime: ReturnType<typeof createPreapprovalExecutionRuntime>;
  execution: ExecuteHandlerDeps;
  onError?: (futureRef: string, error: unknown) => void;
  pumpOutbox?: () => Promise<void>;
}) => {
  const triggerCandidates = new WeakMap<object, { occurrence: TriggerOccurrence; entered: boolean }>();
  const runReviewedTrigger = async (futureRef: string): Promise<ExecuteResponse | null> => {
    let handle: object | undefined;
    try {
      const { candidate, event } = await deps.storage.triggerIngress.read(futureRef);
      const selected = deps.activations.resolveAutomationActivation('next_trigger', candidate.trigger_id, false);
      if (selected.kind !== 'preapproved' || selected.future_execution_ref !== futureRef || selected.status !== 'active') return null;
      const claimed = await deps.runtime.claim({ future_execution_ref: futureRef, occurrence_key: candidate.event_key,
        occurrence_sequence: selected.selector_sequence + 1, payload_hash: candidate.payload_hash });
      handle = claimed.handle;
      const plan = claimed.plan;
      return await handleExecute(deps.execution, { recipe_id: plan.recipe.recipe_id,
        config: plan.recipe_snapshots[0]!.effective_config, trigger_source: 'event_trigger',
        execution_source: plan.origin.source, ...deps.runtime.resolveOrigin(handle),
        context: triggerEventContext(candidate.trigger_id, event),
      }, { run_id: claimed.run_id, preapproval_run: handle });
    } catch (error) {
      if (handle) await deps.runtime.finish(handle, 'failed');
      if (error instanceof RpcError && ['preapproval_already_claimed', 'preapproval_cancelled',
        'preapproval_expired', 'preapproval_stale', 'preapproval_authority_changed'].includes(error.code)) return null;
      throw error;
    } finally { deps.activations.retire(futureRef); await deps.pumpOutbox?.(); }
  };
  const autoRunActivation = (recipeId: string, enabled: boolean) => {
    if (!deps.storage.isReady()) return { kind: 'disabled' as const };
    deps.storage.repository.expire();
    for (const managed of deps.activations.listManaged()) {
      if (managed.target_kind === 'next_auto_run' && managed.target_key === recipeId) {
        // Retirement can restore the ordinary row, so return disabled for this
        // stale timer; the next roster refresh reads the restored value.
        if (deps.activations.retire(managed.future_execution_ref)) return { kind: 'disabled' as const };
      }
    }
    return deps.activations.resolveAutomationActivation('next_auto_run', recipeId, enabled);
  };
  return {
  triggerEligible(triggerId: string, enabled: boolean): boolean {
    if (!deps.storage.isReady()) return false;
    deps.storage.repository.expire();
    for (const managed of deps.activations.listManaged()) {
      if (managed.target_kind === 'next_trigger' && managed.target_key === triggerId
        && deps.activations.retire(managed.future_execution_ref)) return false;
    }
    const selected = deps.activations.resolveAutomationActivation('next_trigger', triggerId, enabled);
    return selected.kind === 'ordinary' || (selected.kind === 'preapproved' && selected.status === 'active');
  },
  captureTrigger(trigger: EventTrigger, event: WarehouseEvent): object | null {
    if (!deps.storage.isReady()) return null;
    deps.storage.repository.expire();
    const occurrence = deps.activations.captureTrigger(trigger, event, deps.storage.triggerIngress);
    if (!occurrence) return null;
    const handle = Object.freeze({});
    triggerCandidates.set(handle, { occurrence, entered: false });
    return handle;
  },
  async executeTrigger(request: ExecuteRequest, candidate: object): Promise<ExecuteResponse | null> {
    if (!deps.storage.isReady()) return null;
    const entry = triggerCandidates.get(candidate);
    if (!entry || entry.entered) throw new RpcError('preapproval_stale', 'This trigger candidate was not issued by the active driver.', 409);
    entry.entered = true;
    if (entry.occurrence.kind === 'preapproved') return runReviewedTrigger(entry.occurrence.future_execution_ref);
    if (!deps.activations.claimOrdinaryTrigger(entry.occurrence)) return null;
    return handleExecute(deps.execution, request);
  },
  /** A selected event is encrypted before queueing, so queue pressure or a
   * process restart cannot replace it with a later event. The same root CAS
   * arbitrates this recovery sweep against the live dispatcher. */
  async tickTriggers(): Promise<void> {
    if (!deps.storage.isReady()) return;
    deps.storage.repository.expire();
    for (const futureRef of deps.storage.triggerIngress.pending()) {
      try { await runReviewedTrigger(futureRef); }
      catch (error) {
        if (deps.onError) deps.onError(futureRef, error);
        else console.warn('[preapproval] trigger execution failed', futureRef, error);
      }
    }
  },
  resumeAutoRunQualification(checkpoint: Checkpoint) {
    if (checkpoint.execution_phase !== 'trigger' || !checkpoint.auto_run_qualification
      || checkpoint.preapproval_candidate_ref || checkpoint.preapproval_execution_ref) {
      throw new RpcError('preapproval_stale', 'The checkpoint does not retain its ordinary automatic qualification.', 409);
    }
    const poll = deps.activations.ordinaryAutoRunPoll(checkpoint.recipe_id!, checkpoint.auto_run_qualification);
    return { after_auto_run_qualification: poll.qualify, auto_run_qualification: poll.qualification };
  },
  autoRunEligible(recipeId: string, enabled: boolean): boolean {
    const selected = autoRunActivation(recipeId, enabled);
    return selected.kind === 'ordinary' || (selected.kind === 'preapproved' && selected.status === 'active');
  },
  async executeAutoRun(request: ExecuteRequest, enabled: boolean): Promise<ExecuteResponse | null> {
    if (!request.recipe_id) throw new RpcError('preapproval_stale', 'An automatic run requires its installed recipe.', 409);
    const selected = autoRunActivation(request.recipe_id, enabled);
    if (selected.kind === 'disabled' || (selected.kind === 'preapproved' && selected.status !== 'active')) return null;
    if (selected.kind === 'ordinary') {
      const poll = deps.activations.ordinaryAutoRunPoll(request.recipe_id);
      return handleExecute(deps.execution, request, { after_auto_run_qualification: poll.qualify, auto_run_qualification: poll.qualification });
    }
    try {
      const candidate = await deps.runtime.autoRunCandidate(selected.future_execution_ref);
      const plan = candidate.plan;
      return await handleExecute(deps.execution, { recipe_id: plan.recipe.recipe_id,
        config: plan.recipe_snapshots[0]!.effective_config, trigger_source: 'auto_run',
        execution_source: plan.origin.source, ...candidate.origin,
        ...(request.process_id ? { process_id: request.process_id } : {}),
      }, { run_id: candidate.run_id, preapproval_candidate: candidate.handle });
    } finally {
      deps.activations.retire(selected.future_execution_ref);
      await deps.pumpOutbox?.();
    }
  },
  async tickSchedules(now: number): Promise<string[]> {
    if (!deps.storage.isReady()) return [];
    deps.storage.repository.expire();
    await deps.pumpOutbox?.();
    for (const checkpointId of deps.storage.repository.pendingNestedParents()) {
      let resumed: Awaited<ReturnType<typeof deps.runtime.resumeReadyParent>> | undefined;
      try {
        resumed = await deps.runtime.resumeReadyParent(checkpointId);
        await resumeReviewedParent(deps.execution, resumed.parent, resumed.checkpoint);
      } catch (error) {
        if (resumed) await deps.runtime.finish(resumed.parent.handle, 'failed');
        if (!(error instanceof RpcError && error.code === 'preapproval_already_claimed')) {
          if (deps.onError) deps.onError(resumed?.checkpoint.preapproval_execution_ref ?? checkpointId, error);
          else console.warn('[preapproval] parent continuation failed', checkpointId, error);
        }
      } finally {
        if (resumed) deps.activations.retire(resumed.checkpoint.preapproval_execution_ref!);
      }
    }
    // The schedule pump is also the recovery clock for durably received event
    // candidates; a vanished in-memory dispatcher queue is not a new event.
    for (const futureRef of deps.storage.triggerIngress.pending()) {
      try { await runReviewedTrigger(futureRef); }
      catch (error) {
        if (deps.onError) deps.onError(futureRef, error);
        else console.warn('[preapproval] trigger recovery failed', futureRef, error);
      }
    }
    const fired: string[] = [];
    for (const managed of deps.activations.listManaged()) {
      // Retirement also handles a grant revoked or expired between ticks.
      if (deps.activations.retire(managed.future_execution_ref)) continue;
      if (managed.target_kind !== 'one_shot' && managed.target_kind !== 'next_schedule') continue;
      const selected = deps.activations.resolveAutomationActivation(managed.target_kind, managed.target_key, false);
      if (selected.kind !== 'preapproved' || selected.status !== 'active'
        || selected.due_at === null || selected.due_at > now) continue;
      let handle: object | undefined;
      try {
        const claimed = await deps.runtime.claim({ future_execution_ref: selected.future_execution_ref,
          occurrence_key: `due:${selected.due_at}`, occurrence_sequence: selected.selector_sequence + 1 });
        handle = claimed.handle;
        const plan = claimed.plan;
        const origin = deps.runtime.resolveOrigin(claimed.handle);
        // A new future run is always scheduled under the original principal.
        // Physical delivery and the owner's earlier decision supply no source.
        await handleExecute(deps.execution, { recipe_id: plan.recipe.recipe_id,
          config: plan.recipe_snapshots[0]!.effective_config, trigger_source: 'schedule',
          execution_source: plan.origin.source, ...origin,
        }, { run_id: claimed.run_id, preapproval_run: claimed.handle });
        fired.push(managed.target_key);
      } catch (error) {
        if (handle) await deps.runtime.finish(handle, 'failed');
        // A competing worker, cancellation or material drift never falls
        // through to the ordinary scheduler. The durable state explains why.
        if (!(error instanceof RpcError && ['preapproval_already_claimed', 'preapproval_cancelled',
          'preapproval_expired', 'preapproval_stale', 'preapproval_authority_changed'].includes(error.code))) {
          if (deps.onError) deps.onError(managed.future_execution_ref, error);
          else console.warn('[preapproval] scheduled execution failed', managed.future_execution_ref, error);
        }
      } finally { deps.activations.retire(managed.future_execution_ref); }
    }
    await deps.pumpOutbox?.();
    return fired;
  },
  };
};
export type PreapprovalDriver = ReturnType<typeof createPreapprovalDriver>;
