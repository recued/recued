/** Private invocation frames bridge the engine's logical call and its transport
 * delegates. A future/grant/member id in JSON is never a frame or an approval. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  PAGINATION_MAX_PAGES, RpcError, PreflightRequiredSignal, isPreflightRequiredSignal, parsePreapprovalJson, resolveDeep, normalizeMailSend, preapprovalChildPath,
  type Checkpoint, type ExecutionSource, type NamespaceStores, type RecipeDefinition, type StepMeta,
} from '@recued/contracts';
import type { ExecutionContext, IngredientExecutor, LocalRecipeInvokeCall } from '@recued/engine';
import { canonicalRecipeDefinition } from '@recued/recipes';
import type { CommitGatewayDeps } from '@recued/gateway';
import { mergeManifestStepInput, mergeManifestStepOutput } from '@recued/ingredients';
import type { createPreapprovalService } from './preapproval-service.js';
import type { PreapprovalStorage } from './storage/preapproval-storage.js';
import type { ExecuteResponse } from './types.js';
import type { PreparedFutureExecution, PreparedRecipeSnapshot, PreparedInvocation, PreapprovalExecutionBinding, PreapprovalPollBinding, PreapprovalMemberClaim } from './preapproval-model.js';
import { preapprovalEffectHash, preapprovalHash, preapprovalPathKey } from './preapproval-invocations.js';
import { readReviewedFileSnapshot } from './preapproval-mail.js';
import { createReviewedFileAccess } from './collections/file/file-snapshot.js';
import type { FileReadResponse } from './collections/file/file-read-handler.js';
import { withPreapprovalIo, withPreapprovalOrdinaryGuard, type PreapprovalIoContext } from './preapproval-io-context.js';
import { withContractDispatchReservation } from './contract-dispatch-reservation.js';
import type { ContractOverlayResolver } from './policy-contract-overlay.js';
import { describeAiProviderRequest, readReviewedAiSnapshot } from './preapproval-ai-description.js';
import { triggerEventContext } from './triggers/event-context.js';
import { describeDomCommand, readReviewedDomSnapshot } from './preapproval-dom.js';

type Hooks = NonNullable<ExecutionContext['reviewedExecution']>;
type EngineCall = Parameters<Hooks['invoke']>[0];
interface Run {
  binding: PreapprovalExecutionBinding; plan: PreparedFutureExecution; selected: Set<string>;
  event_context_hash?: string;
  snapshot: PreparedRecipeSnapshot;
  parent_attempt_id: string | null;
  host?: ExecutionHost;
  resumed: boolean;
}
interface AutoRunCandidate {
  binding: PreapprovalPollBinding; plan: PreparedFutureExecution; entered: boolean; qualifying?: boolean; claimed?: object;
}
type ExecutionHost = { run_id: string; recipe: RecipeDefinition; source: ExecutionSource; stores: NamespaceStores;
  dispatchRequiredChild?: IngredientExecutor; contractOverlay?: ContractOverlayResolver };
interface Frame {
  run: Run; call: EngineCall; member: PreparedInvocation; claim: PreapprovalMemberClaim;
  provider_input_hash: string;
  progress: { delegates: number; provider_entered: boolean; file_access?: boolean; use_reservation?: object; dom_commands?: number };
  transport?: { key: string; resolved: boolean };
  gateway_resolved: boolean;
}
const refuse = (message: string): never => { throw new RpcError('preapproval_stale', message, 409); };
const path = (meta: StepMeta | undefined): string => meta?.invocation_path
  ? preapprovalPathKey(meta.invocation_path) : refuse('The execution has no private invocation path.');
const transportKey = (slug: string, input: Record<string, unknown>, meta: StepMeta | undefined): string =>
  preapprovalHash([slug, input, path(meta), meta?.surface_dispatch ?? false, meta?.surface_operation_key ?? null]);

export const createPreapprovalExecutionRuntime = (deps: {
  storage: PreapprovalStorage; service: ReturnType<typeof createPreapprovalService>;
}) => {
  const runs = new WeakMap<object, Run>();
  const candidates = new WeakMap<object, AutoRunCandidate>();
  const frames = new AsyncLocalStorage<Frame | undefined>();
  const ordinaryFrames = new AsyncLocalStorage<{ run: Run; call: EngineCall } | undefined>();
  const notifications = new Map<string, () => Promise<void>>();
  const nestedWaits = new WeakMap<object, { run: Run; path: PreparedInvocation['invocation_path'] }>();
  const repository = deps.storage.repository;
  const validateClaim = (frame: Frame, children = false) => withContractDispatchReservation(frame.progress.use_reservation,
    () => repository.validateClaim(frame.claim, children));
  const get = (handle: object): Run => runs.get(handle) ?? refuse('The execution binding was not issued by this server runtime.');
  const candidate = (handle: object): AutoRunCandidate => candidates.get(handle)
    ?? refuse('The qualification candidate was not issued by this server runtime.');
  const validateHost = (plan: PreparedFutureExecution, host: ExecutionHost, snapshot = plan.recipe_snapshots[0]!): void => {
    if (preapprovalHash(host.source) !== preapprovalHash(plan.origin.source)) refuse('The execution source differs from the reviewed execution.');
    // The engine parser normalizes the legacy sidebar/render alias in place.
    // Use its own definition canonicalizer before and after qualification.
    if (preapprovalHash(canonicalRecipeDefinition(host.recipe)) !== preapprovalHash(canonicalRecipeDefinition(snapshot.definition))) {
      refuse('The running recipe differs from the reviewed execution.');
    }
    if (preapprovalHash(parsePreapprovalJson(host.stores.config)) !== preapprovalHash(snapshot.effective_config)) {
      refuse('The effective configuration differs from the reviewed execution.');
    }
  };
  const flushNotifications = async (): Promise<void> => {
    for (const [id, publish] of notifications) {
      if (repository.canPublishCheckpoint(id)) { await publish(); notifications.delete(id); }
      else if (!repository.canDeferCheckpoint(id)) notifications.delete(id);
    }
  };
  const waitForChild = (run: Run, childRunId: string, invocationPath: PreparedInvocation['invocation_path']): never => {
    const signal = new PreflightRequiredSignal('Waiting for the existing nested recipe to finish.');
    signal.preapproval_nested_wait = Object.freeze({ child_run_id: childRunId });
    nestedWaits.set(signal.preapproval_nested_wait, { run, path: invocationPath });
    throw signal;
  };
  const finishResponse = async (handle: object, result: ExecuteResponse): Promise<void> => {
    const run = get(handle);
    if (run.binding.run_id !== run.binding.root_run_id) {
      if (result.awaiting_approval || result.awaiting_peer) {
        if (run.resumed) await repository.sealResumedNestedHold(run.binding);
      } else await repository.completeNestedRun(run.binding, result, run.resumed);
      return;
    }
    if (!result.awaiting_approval && !result.awaiting_peer) {
      await repository.finishRun(get(handle).binding, result.errors.some(error => error && typeof error === 'object'
        && 'code' in error && error.code === 'ACTION_DELIVERY_UNCERTAIN')
        ? 'in_doubt' : result.success ? 'succeeded' : 'failed');
    }
  };
  const bind = async (binding: PreapprovalExecutionBinding, resumed = false) => {
    const plan = await repository.loadExecution(binding.future_execution_ref);
    const review = await repository.inspectExecution(binding.future_execution_ref);
    const { context, snapshot } = await repository.runSnapshot(binding);
    const trigger = !context && plan.target.kind === 'next_trigger' ? await deps.storage.triggerIngress.read(binding.future_execution_ref) : undefined;
    const handle = Object.freeze({});
    runs.set(handle, { binding, plan, snapshot, resumed, parent_attempt_id: context?.parent_attempt_id ?? null,
      selected: new Set(review.members.map(member => member.member_id)),
      ...(trigger ? { event_context_hash: preapprovalHash(triggerEventContext(trigger.candidate.trigger_id, trigger.event).event) } : {}) });
    return { handle, run_id: binding.run_id, plan: structuredClone(plan), snapshot: structuredClone(snapshot), config: structuredClone(snapshot.effective_config) };
  };
  const bindCandidate = (value: { binding: PreapprovalPollBinding; plan: PreparedFutureExecution }) => {
    const handle = Object.freeze({});
    candidates.set(handle, { ...value, entered: false });
    return { handle, run_id: value.binding.run_id, plan: structuredClone(value.plan), config: structuredClone(value.plan.recipe_snapshots[0]!.effective_config), origin: deps.service.resolveOrigin(value.plan.origin) };
  };

  return {
    maintain: flushNotifications,
    async autoRunCandidate(futureRef: string) {
      if (!deps.storage.isReady()) throw new RpcError('preapproval_unsupported', 'Pre-approval recovery is incomplete.', 503);
      return bindCandidate(await repository.beginAutoRunPoll(futureRef, deps.storage.workers.worker_id));
    },
    async executeCandidate(handle: object, dispatch: () => Promise<ExecuteResponse>): Promise<ExecuteResponse> {
      const poll = candidate(handle);
      if (poll.entered) return refuse('This qualification candidate has already entered the engine.');
      poll.entered = true;
      try {
        const result = await dispatch();
        if (poll.claimed) await finishResponse(poll.claimed, result);
        else if (!result.awaiting_approval && !result.awaiting_peer) repository.finishPoll(poll.binding);
        await flushNotifications();
        return result;
      } catch (error) {
        if (poll.claimed) await repository.finishRun(get(poll.claimed).binding, 'failed');
        else repository.finishPoll(poll.binding);
        throw error;
      }
    },
    assertCandidateEntry(handle: object, host: ExecutionHost): void {
      const poll = candidate(handle);
      if (!poll.entered || poll.claimed || poll.binding.run_id !== host.run_id) return refuse('The qualification candidate is not waiting for its trigger.');
      validateHost(poll.plan, host);
    },
    async qualifyAutoRun(handle: object, host: ExecutionHost) {
      const poll = candidate(handle);
      if (!poll.entered || poll.claimed || poll.qualifying || poll.binding.run_id !== host.run_id) return refuse('The qualification candidate is no longer available.');
      validateHost(poll.plan, host);
      poll.qualifying = true;
      const binding = await repository.claimRun({ future_execution_ref: poll.binding.future_execution_ref, run_id: host.run_id,
        worker_id: deps.storage.workers.worker_id, occurrence_key: `poll:${poll.binding.poll_id}:${poll.binding.fence}`, poll_binding: poll.binding,
        occurrence_sequence: poll.plan.target.qualifying_sequence + 1 });
      const claimed = await bind(binding);
      poll.claimed = claimed.handle;
      return claimed;
    },
    recordDispatchUse(source: ExecutionSource, slug: string, overlay: ContractOverlayResolver): boolean {
      const frame = frames.getStore(); if (!frame) return false;
      if (preapprovalHash(source) !== preapprovalHash(frame.run.plan.origin.source)
        || (frame.transport ? !frame.transport.resolved : !frame.gateway_resolved || slug !== frame.call.slug)) {
        return refuse('The budget reservation has no matching reviewed dispatch.');
      }
      if (!overlay.reserveDispatchUse) return refuse('The contract budget reservation service is unavailable.');
      const reservation = overlay.reserveDispatchUse(source, frame.member.ingredient_slug, frame.call.connection_name || undefined);
      if (reservation) frame.progress.use_reservation = reservation;
      return true;
    },
    /** Called only by the owned activation driver after qualification. The
     * public request schema has no execution-handle field. */
    async claim(input: { future_execution_ref: string; occurrence_key: string; occurrence_sequence: number; payload_hash?: string }) {
      if (!deps.storage.isReady()) throw new RpcError('preapproval_unsupported', 'Pre-approval recovery is incomplete.', 503);
      const binding = await repository.claimRun({ ...input, run_id: randomUUID(), worker_id: deps.storage.workers.worker_id });
      return bind(binding);
    },

    async assertEntry(runId: string, handle?: object, pollHandle?: object): Promise<void> {
      const futureRef = repository.executionForRun(runId);
      const pollId = repository.pollForRun(runId);
      if (!futureRef && pollId) {
        if (!pollHandle || handle) return refuse('This run requires its original qualification continuation.');
        const poll = candidate(pollHandle);
        if (poll.binding.poll_id !== pollId || poll.binding.run_id !== runId) return refuse('This qualification binding belongs to another run.');
        await repository.validatePoll(poll.binding);
        return;
      }
      if (!futureRef && !handle) return;
      if (!handle) return refuse('This run requires its reviewed execution continuation.');
      const run = get(handle);
      if (run.binding.run_id !== runId || run.binding.future_execution_ref !== futureRef) {
        return refuse('The private execution binding belongs to another run.');
      }
      await repository.validateRun(run.binding);
    },

    async nested(handle: object, call: LocalRecipeInvokeCall) {
      const run = get(handle);
      const frame = frames.getStore();
      const ordinary = ordinaryFrames.getStore();
      const active = frame?.run === run ? frame : ordinary?.run === run ? ordinary : null;
      if (!active || !active.call.catalog || !call.invocation_path
        || path(active.call.stepMeta) !== preapprovalPathKey(call.invocation_path)
        || preapprovalHash(call.args) !== preapprovalHash(frame?.run === run ? frame.member.input : active.call.input.args)) {
        return refuse('The nested recipe has no matching reviewed parent invocation.');
      }
      const prefix = preapprovalChildPath(call.invocation_path, 'recipe', 0);
      let snapshot = run.plan.recipe_snapshots.find(item => item.recipe_id === call.recipe_id
        && item.invocation_path.length === prefix.length + 1
        && preapprovalPathKey(item.invocation_path.slice(0, -1)) === preapprovalPathKey(prefix));
      const ordinaryRecipe = !snapshot && ordinary?.run === run
        ? deps.service.ordinaryRecipe(run.plan, call.recipe_id, call.args, prefix) : undefined;
      snapshot ??= ordinaryRecipe?.snapshot;
      if (!snapshot || (frame?.run === run && frame.gateway_resolved)) return refuse('The nested recipe entry was not reviewed or was already dispatched.');
      if (frame?.run === run) {
        await validateClaim(frame);
        const overlay = run.host?.contractOverlay;
        if (overlay) {
          if (!overlay.reserveDispatchUse) return refuse('The contract budget reservation service is unavailable.');
          const reservation = overlay.reserveDispatchUse(run.host!.source, frame.member.ingredient_slug, frame.call.connection_name || undefined);
          if (reservation) frame.progress.use_reservation = reservation;
        } else if (run.plan.origin.mode === 'contract') return refuse('The original contract cannot reserve the nested dispatch.');
        await validateClaim(frame);
      }
      const binding = await repository.bindNestedRun(run.binding, randomUUID(), snapshot.invocation_path,
        frame?.run === run ? frame.claim : null, ordinaryRecipe);
      if (frame?.run === run) frame.gateway_resolved = true;
      return bind(binding);
    },
    nestedReturned(parentHandle: object, handle: object, result: ExecuteResponse): void {
      const child = get(handle);
      if (result.awaiting_approval || result.awaiting_peer) waitForChild(get(parentHandle), child.binding.run_id, child.snapshot.invocation_path.slice(0, -2));
    },
    async publishCheckpoint(handle: object, checkpointId: string, publish: () => Promise<void>): Promise<void> {
      get(handle);
      if (repository.canPublishCheckpoint(checkpointId)) await publish();
      else notifications.set(checkpointId, publish);
    },
    canPublishCheckpoint: (id: string) => repository.canPublishCheckpoint(id),

    writeCheckpoint(handle: object, checkpoint: Checkpoint): Promise<void> {
      const run = get(handle);
      if (checkpoint.preapproval_nested_wait) {
        const wait = nestedWaits.get(checkpoint.preapproval_nested_wait);
        const step = wait?.path.slice(run.snapshot.invocation_path.length).find(segment => segment.kind === 'step');
        if (wait?.run !== run || step?.kind !== 'step' || step.step_id !== checkpoint.gated_step_id
          || step.phase !== (checkpoint.execution_phase ?? 'sequential')) return refuse('The parent wait has no private nested continuation.');
      }
      checkpoint.preapproval_execution_ref = run.binding.future_execution_ref;
      return repository.holdRun(run.binding, checkpoint);
    },
    writeCandidateCheckpoint(handle: object, checkpoint: Checkpoint): Promise<void> {
      const poll = candidate(handle);
      checkpoint.preapproval_candidate_ref = poll.binding.poll_id;
      return repository.holdPoll(poll.binding, checkpoint);
    },

    async resume(checkpoint: Checkpoint) {
      if (!deps.storage.isReady()) throw new RpcError('preapproval_unsupported', 'Pre-approval recovery is incomplete.', 503);
      if (checkpoint.preapproval_candidate_ref || (repository.pollForRun(checkpoint.run_id) && !repository.executionForRun(checkpoint.run_id))) {
        return { ...bindCandidate(await repository.resumePoll(checkpoint, deps.storage.workers.worker_id)), kind: 'candidate' as const };
      }
      const binding = await repository.resumeRun(checkpoint, deps.storage.workers.worker_id);
      return binding ? { ...await bind(binding, true), kind: 'run' as const } : null;
    },
    async resumeReadyParent(checkpointId: string) {
      if (!deps.storage.isReady()) throw new RpcError('preapproval_unsupported', 'Pre-approval recovery is incomplete.', 503);
      const continuation = await repository.claimReadyNestedParent(checkpointId, deps.storage.workers.worker_id);
      return { parent: await bind(continuation.binding, true), checkpoint: continuation.checkpoint };
    },

    resolveOrigin(handle: object) {
      const run = runs.get(handle);
      return run ? deps.service.resolveRecipeOrigin(run.plan.origin, run.snapshot) : deps.service.resolveOrigin(candidate(handle).plan.origin);
    },
    cancelCheckpoint(checkpoint: Checkpoint) { repository.cancelCheckpoint(checkpoint, 'owner_denied_uncovered_call'); },

    async execute(handle: object, dispatch: () => Promise<ExecuteResponse>,
      continueParent: (parent: Awaited<ReturnType<typeof bind>>, checkpoint: Checkpoint) => Promise<ExecuteResponse>): Promise<ExecuteResponse> {
      const run = get(handle);
      await repository.validateRun(run.binding);
      let result: ExecuteResponse;
      try { result = await dispatch(); }
      catch (error) {
        if (run.binding.run_id === run.binding.root_run_id) await repository.finishRun(run.binding, 'failed');
        throw error;
      }
      await finishResponse(handle, result);
      await flushNotifications();
      if (run.resumed && run.binding.run_id !== run.binding.root_run_id && !result.awaiting_approval && !result.awaiting_peer) {
        let parent: Awaited<ReturnType<typeof repository.resumeNestedParent>>;
        try { parent = await repository.resumeNestedParent(run.binding); }
        catch (error) {
          if (error instanceof RpcError && error.code === 'preapproval_already_claimed') return result;
          throw error;
        }
        run.binding = { ...run.binding, fence: parent.binding.fence, worker_id: parent.binding.worker_id };
        await continueParent(await bind(parent.binding, true), parent.checkpoint);
      }
      return result;
    },

    /** Install after the host resolves the actual recipe/config/source. */
    forExecution(handle: object, host: ExecutionHost): {
      reviewedExecution: Hooks;
      reviewedDispatch: NonNullable<CommitGatewayDeps['reviewedDispatch']>;
      preapprovalAddressing: NonNullable<ExecutionContext['preapprovalAddressing']>;
    } {
      const run = get(handle);
      const snapshot = run.snapshot;
      if (run.binding.run_id !== host.run_id) refuse('The private execution binding belongs to another run.');
      validateHost(run.plan, host, snapshot);
      run.host = host;
      if (run.event_context_hash && preapprovalHash(host.stores.context.event) !== run.event_context_hash) {
        refuse('The execution does not carry its durably selected trigger event.');
      }
      const preparation = deps.service.preparation(run.plan.request, run.plan.target, run.plan, 'member');
      const resolveActualInput = (call: EngineCall) => {
        const manifest = preparation.manifest(call.slug);
        if (!manifest) return refuse('The reviewed operation definition disappeared.');
        return call.catalog ? call.input : resolveDeep(mergeManifestStepInput(manifest.input, call.input,
          { trustedSurfaceDispatch: false }), host.stores, { deferVault: true });
      };
      const describeActual = (call: EngineCall, expected: PreparedInvocation): PreparedInvocation => {
        const manifest = preparation.manifest(call.slug);
        if (!manifest) return refuse('The reviewed operation definition disappeared.');
        const input = resolveActualInput(call);
        const description = preparation.describe({ manifest, slug: call.slug,
          input: parsePreapprovalJson(input) as PreparedInvocation['input'], catalog: call.catalog,
          output: mergeManifestStepOutput(manifest.output, call.output), connection_name: call.connection_name,
          origin: run.plan.origin, recipe: snapshot, path: call.stepMeta!.invocation_path! });
        if (description.kind !== 'resolved') return refuse(description.reason);
        const actual = { ...expected, ...description.call.material,
          arguments_hash: preapprovalHash(description.call.material.input) };
        actual.effect_hash = preapprovalEffectHash(actual);
        return actual;
      };
      const current = (): Frame | undefined => {
        const frame = frames.getStore();
        return frame?.run === run ? frame : undefined;
      };
      const ioFor = (frame: Frame): PreapprovalIoContext => {
        const readChild = async (recordId: string, slot: string, index: number): Promise<FileReadResponse> => {
          if (current() !== frame) return refuse('This file read has no private reviewed parent.');
          const childPath = preapprovalChildPath(frame.member.invocation_path, slot, index);
          const child = run.plan.members.find(item => preapprovalPathKey(item.invocation_path) === preapprovalPathKey(childPath));
          if (!child || child.parent_member_id !== frame.member.member_id || !run.selected.has(child.member_id)
            || child.ingredient_slug !== 'data-file-read' || child.input.record_id !== recordId) {
            return refuse('The file is not a selected required read of this operation.');
          }
          const dispatch = host.dispatchRequiredChild;
          if (!dispatch) return refuse('The required child operation gateway is unavailable.');
          const meta: StepMeta = { ...frame.call.stepMeta!, invocation_path: childPath };
          return await hooks.invoke({ slug: 'data-file-read', input: child.input, output: child.output,
            catalog: false, connection_name: '', stepMeta: meta },
          () => dispatch('data-file-read', child.input, child.output, { cache: 'fresh' }, meta)) as FileReadResponse;
        };
        const mailMatches = (instance: string, input: Record<string, unknown>): void => {
          if (current() !== frame || frame.member.ingredient_slug !== 'mail-send') refuse('This send has no private reviewed invocation.');
          const fields = ['to', 'cc', 'bcc', 'subject', 'body_text', 'body_html', 'in_reply_to', 'references',
            'reply_to', 'reconciliation_id', 'attachments'];
          const actual = Object.fromEntries(fields.filter(key => input[key] !== undefined).map(key => [key, input[key]]));
          if (preapprovalHash({ instance, ...actual }) !== preapprovalHash(normalizeMailSend(frame.member.input))) {
            refuse('The provider payload differs from the reviewed message.');
          }
        };
        const io: PreapprovalIoContext = {
          async prepareDomCommand(call, request, index) {
            await io.validateProvider('dom', call);
            const snapshot = readReviewedDomSnapshot(frame.member.dispatch_snapshot);
            if (!snapshot || index !== (frame.progress.dom_commands ?? 0) || !snapshot.commands[index]
              || request.recipe_run_id !== run.binding.run_id || request.step_id !== frame.call.stepMeta?.step_id
              || preapprovalHash(describeDomCommand(request)) !== preapprovalHash(snapshot.commands[index])) {
              return refuse('The browser command differs from the reviewed invocation.');
            }
            frame.progress.dom_commands = index + 1;
            return { binding: structuredClone(snapshot.binding), beforeSend: async () => {
              await io.validateProvider('dom', call);
              frame.progress.provider_entered = true;
            } };
          },
          aiSlot() {
            const snapshot = readReviewedAiSnapshot(frame.member.dispatch_snapshot);
            if (current() !== frame || frame.member.family !== 'ai' || !snapshot) return refuse('The model has no reviewed invocation.');
            return snapshot.slot;
          },
          coversAiFileAsk(input, recordId) {
            if (current() !== frame || frame.member.family !== 'ai'
              || preapprovalHash(input) !== preapprovalHash(frame.call.input)) return false;
            const childPath = preapprovalPathKey(preapprovalChildPath(frame.member.invocation_path, 'ai_input', 0));
            const child = run.plan.members.find(member => preapprovalPathKey(member.invocation_path) === childPath);
            return !!child && child.parent_member_id === frame.member.member_id && run.selected.has(child.member_id)
              && child.ingredient_slug === 'data-file-read' && child.input.record_id === recordId;
          },
          async readAiFile(recordId) {
            if (frame.member.family !== 'ai') return refuse('This read has no reviewed AI parent.');
            return readChild(recordId, 'ai_input', 0);
          },
          async readHttpFile(recordId) {
            if (!frame.call.catalog || !frame.transport || !['http', 'graphql'].includes(frame.member.family)) {
              return refuse('This upload read has no reviewed catalog parent.');
            }
            // The actual one-shot upload declaration permits exactly one file.
            // Its bytes still need their own selected and unused child claim.
            return readChild(recordId, 'http_upload', 0);
          },
          async beforeAiProvider(call, request) {
            await io.validateProvider('ai', call);
            const snapshot = readReviewedAiSnapshot(frame.member.dispatch_snapshot);
            if (!snapshot || preapprovalHash(describeAiProviderRequest(request)) !== preapprovalHash(snapshot.request)) {
              return refuse('The model, provider or prompt differs from the reviewed AI request.');
            }
            frame.progress.provider_entered = true;
          },
          async beforeCliProvider(call) {
            const binding = preparation.manifest(call.slug)?.surfaces?.connector?.executes?.[call.operation_key];
            if (current() !== frame || frame.member.family !== 'cli' || !frame.call.catalog
              || frame.gateway_resolved || frame.member.op_id !== call.operation_id
              || call.slug !== frame.call.slug || path(call.stepMeta) !== path(frame.call.stepMeta)
              || preapprovalHash(call.args) !== preapprovalHash(frame.member.input)
              || !binding || preapprovalHash(call.binding) !== preapprovalHash(binding)) {
              return refuse('The CLI process has no matching unused reviewed invocation.');
            }
            await validateClaim(frame, true);
            const overlay = host.contractOverlay;
            if (overlay) {
              if (!overlay.reserveDispatchUse) return refuse('The contract budget reservation service is unavailable.');
              const reservation = overlay.reserveDispatchUse(host.source, frame.member.ingredient_slug, frame.call.connection_name || undefined);
              if (reservation) frame.progress.use_reservation = reservation;
            } else if (run.plan.origin.mode === 'contract') return refuse('The original contract cannot reserve this dispatch.');
            frame.gateway_resolved = true;
            await validateClaim(frame, true);
            frame.progress.provider_entered = true;
          },
          async validateProvider(family, call, target) {
            if (current() !== frame || (family !== frame.member.family
              && !(family === 'http' && frame.member.family === 'graphql'))
              || (frame.transport ? frame.transport.key !== transportKey(call.slug, call.input, call.stepMeta)
                : call.slug !== frame.call.slug || path(call.stepMeta) !== path(frame.call.stepMeta)
                  || preapprovalHash(call.input) !== frame.provider_input_hash)) {
              return refuse('The provider call has no matching private reviewed invocation.');
            }
            if (target && target.expected !== target.actual) return refuse('The provider resolved a different request destination.');
            await validateClaim(frame, true);
          },
          async beforeProvider(family, call, target) {
            await io.validateProvider(family, call, target);
            frame.progress.provider_entered = true;
          },
          coversMailAttachmentAsks(input) {
            if (current() !== frame || frame.member.ingredient_slug !== 'mail-send'
              || preapprovalHash(input) !== preapprovalHash(frame.call.input)) return false;
            const refs = normalizeMailSend(input).attachments ?? [];
            return refs.length > 0 && refs.length === frame.member.required_child_ids.length
              && frame.member.required_child_ids.every(id => run.selected.has(id));
          },
          validateMail(instance, input) { mailMatches(instance, input as unknown as Record<string, unknown>); },
          async readMailAttachment(recordId, index, _readDeps) {
            if (current() !== frame || frame.member.ingredient_slug !== 'mail-send') refuse('This read has no reviewed parent send.');
            return readChild(recordId, 'attachments', index);
          },
          fileAccess(recordId) {
            const snapshot = readReviewedFileSnapshot(frame.member.dispatch_snapshot);
            if (current() !== frame || frame.member.ingredient_slug !== 'data-file-read'
              || !snapshot || snapshot.file.record_id !== recordId || frame.progress.file_access) {
              return refuse('The bytes have no unused matching file-read claim.');
            }
            frame.progress.file_access = true;
            return createReviewedFileAccess(snapshot.file, async () => {
              await validateClaim(frame);
              frame.progress.provider_entered = true;
            });
          },
          async beforeMailProvider(instance, input) {
            mailMatches(instance, input as unknown as Record<string, unknown>);
            await validateClaim(frame, true);
            frame.progress.provider_entered = true;
          },
        };
        return io;
      };
      const hooks: Hooks = {
        async invoke(call, dispatch) {
          await repository.validateRun(run.binding);
          const key = path(call.stepMeta);
          if (run.resumed) {
            const nested = await repository.nestedInvocation(run.binding, call.stepMeta!.invocation_path!);
            if (nested?.state === 'held') return waitForChild(run, nested.run_id, call.stepMeta!.invocation_path!);
            if (nested?.state === 'running') return refuse('The nested invocation is already running.');
            if (nested?.state === 'completed') {
              const result = nested.result as ExecuteResponse | null;
              if (!result || typeof result.success !== 'boolean' || !Array.isArray(result.errors)) return refuse('The nested result is invalid.');
              if (nested.claim) await repository.settleMember(nested.claim, { status: result.success ? 'succeeded' : 'failed',
                result, message: result.success ? 'Completed.' : 'The nested recipe failed.' });
              if (!result.success) throw new Error('The nested recipe failed.');
              return result;
            }
          }
          const expected = run.plan.members.find(member => preapprovalPathKey(member.invocation_path) === key);
          if (!expected || !run.selected.has(expected.member_id)) {
            const explicitlyUncovered = expected || run.plan.uncovered.some(item => {
              const prefix = item.invocation_path;
              const actual = call.stepMeta!.invocation_path!;
              return (prefix.length === actual.length || (item.subtree && prefix.length < actual.length))
                && preapprovalHash(actual.slice(0, prefix.length)) === preapprovalHash(prefix);
            });
            if (!explicitlyUncovered) refuse('An unexpected operation cannot inherit this execution approval.');
            return ordinaryFrames.run({ run, call }, () => frames.run(undefined, () => withPreapprovalIo(undefined,
              () => withPreapprovalOrdinaryGuard(() => repository.assertRunActive(run.binding), dispatch))));
          }
          const actual = describeActual(call, expected);
          const parent = current();
          const claim = await repository.claimMember(run.binding, actual,
            expected.parent_member_id === null ? null : parent?.claim.attempt_id ?? run.parent_attempt_id);
          const frame: Frame = { run, call, member: actual, claim, provider_input_hash: preapprovalHash(resolveActualInput(call)),
            progress: { delegates: 0, provider_entered: false }, gateway_resolved: false };
          let result: unknown;
          try {
            result = await withPreapprovalOrdinaryGuard(undefined, () => frames.run(frame, () => withPreapprovalIo(ioFor(frame), dispatch)));
            if (actual.family === 'dom' && (!frame.progress.provider_entered
              || frame.progress.dom_commands !== readReviewedDomSnapshot(actual.dispatch_snapshot)?.commands.length)) {
              return refuse('The browser did not dispatch every reviewed command.');
            }
          } catch (error) {
            if (isPreflightRequiredSignal(error) && error.preapproval_nested_wait) throw error;
            const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
            const uncertain = code === 'ACTION_DELIVERY_UNCERTAIN'
              || (code === 'run_killed' && frame.progress.provider_entered)
              || (actual.family === 'cli' && actual.risk !== 'read' && frame.progress.provider_entered)
              || (actual.family === 'ai' && frame.progress.provider_entered);
            const domUncertain = actual.family === 'dom' && frame.progress.provider_entered;
            await repository.settleMember(claim, { status: uncertain || domUncertain ? 'in_doubt' : 'failed', result: null,
              message: error instanceof Error ? error.message : 'The reviewed operation failed.' });
            throw error;
          }
          // A failed durable settlement leaves the claimed member dispatching.
          // Recovery fences it as uncertain; never rewrite that failure as a
          // confirmed provider failure or resend the effect.
          // File receipts retain the immutable byte identity, never another
          // full base64 copy of the content in the execution journal.
          const durableResult = actual.ingredient_slug === 'data-file-read' && result && typeof result === 'object'
            ? Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'bytes_b64')) : result ?? null;
          await repository.settleMember(claim, { status: 'succeeded', result: durableResult, message: 'Completed.' });
          return result;
        },
        async catalogApproved(call) {
          const frame = current();
          if (!frame) return false;
          if (!frame.call.catalog || frame.member.ingredient_slug !== call.slug || frame.member.op_id !== call.operation_id
            || frame.call.connection_name !== call.connection_name || path(call.stepMeta) !== path(frame.call.stepMeta)) {
            return refuse('A different catalog operation cannot use this approval.');
          }
          await validateClaim(frame);
          return true;
        },
        async delegate(call, dispatch) {
          const frame = current();
          if (!frame) return dispatch();
          if (!frame.call.catalog || call.slug !== frame.member.ingredient_slug || call.stepMeta?.surface_dispatch !== true
            || path(call.stepMeta) !== path(frame.call.stepMeta)) return refuse('The transport is not a delegate of this reviewed operation.');
          const manifest = preparation.manifest(frame.member.ingredient_slug);
          const operation = typeof frame.call.input.operation === 'string' ? frame.call.input.operation : '';
          if (call.stepMeta.surface_operation_key !== operation) return refuse('The transport operation changed.');
          const api = manifest?.surfaces?.api?.executes?.[operation];
          const pagination = manifest?.operations?.[operation]?.pagination || (api && 'pagination' in api && api.pagination);
          const max = frame.member.risk === 'read' && pagination ? PAGINATION_MAX_PAGES : 1;
          if (++frame.progress.delegates > max) return refuse('The reviewed operation exceeded its declared transport bound.');
          // Upload bytes are read inside the transport adapter through their
          // selected child calls. The HTTP egress hook requires them to have
          // succeeded before any request leaves this process.
          await validateClaim(frame, !['http', 'graphql'].includes(frame.member.family));
          const delegate: Frame = { ...frame, transport: { key: transportKey(call.slug, call.input, call.stepMeta), resolved: false } };
          return frames.run(delegate, () => withPreapprovalIo(ioFor(delegate), dispatch));
        },
      };
      return { reviewedExecution: hooks,
        preapprovalAddressing: { recipe_path: snapshot.invocation_path, phase: 'sequential', iteration_indices: [] },
        reviewedDispatch: {
          assertRunActive: () => repository.assertRunActive(run.binding),
          async resolve(call) {
            const frame = current();
            if (!frame) return null;
            if (frame.call.catalog) {
              if (!frame.transport || frame.transport.resolved
                || frame.transport.key !== transportKey(call.slug, call.input, call.stepMeta)) {
                return refuse('The transport has no matching private delegate frame.');
              }
              frame.transport.resolved = true;
            } else {
              if (frame.gateway_resolved || call.slug !== frame.call.slug || path(call.stepMeta) !== path(frame.call.stepMeta)
                || preapprovalHash(call.input) !== preapprovalHash(frame.call.input)) return refuse('The operation has no matching private dispatch frame.');
              frame.gateway_resolved = true;
            }
            await validateClaim(frame);
            if (!frame.claim.commit_id) return refuse('The reviewed dispatch has no durable Commit.');
            return { commit_id: frame.claim.commit_id, action_ref: frame.claim.action_ref, idempotency_key: frame.claim.idempotency_key,
              async validate() {
                await validateClaim(frame, frame.call.catalog && !['http', 'graphql'].includes(frame.member.family));
                if (frame.member.ingredient_slug !== 'mail-send' && frame.member.ingredient_slug !== 'data-file-read'
                  && !['mcp', 'http', 'graphql', 'ai', 'dom'].includes(frame.member.family)) {
                  frame.progress.provider_entered = true;
                }
              } };
          },
        },
      };
    },
    finish(handle: object, result: 'succeeded' | 'failed' | 'in_doubt') {
      const run = runs.get(handle);
      if (run) return repository.finishRun(run.binding, result);
      const poll = candidate(handle);
      if (poll.claimed) return repository.finishRun(get(poll.claimed).binding, result);
      repository.finishPoll(poll.binding);
      return Promise.resolve();
    },
  };
};
