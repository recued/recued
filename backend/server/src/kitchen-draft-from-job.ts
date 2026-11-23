/** D-402 slice A5 — an AI app's draft request: the job it kept for its draft, made into a recipe and
 *  kept in the owner's Kitchen as Recued's.
 *
 *  The app ends its job with `recued_endJob` and `draft` (its labels: where its values came from),
 *  which checks the labels against the job's record at once and keeps the job for a day. It then
 *  calls this op with the job id. The op is a write, as `kitchen-draft-import` is, so the owner is
 *  asked once, and that ask is the notice that a draft is waiting. It takes no recipe source: Recued
 *  compiles from its own record (§3.3). The draft is kept under `recued:job:<token>`, which no app's
 *  Kitchen calls reach, so the app cannot change it before the owner reviews it (slice A3). */

import {
  KITCHEN_DRAFT_FROM_JOB_OP, KITCHEN_DRAFT_FROM_JOB_SLUG, kitchenCompiledOrigin, kitchenDraftPath, RpcError,
  type KitchenDraftFromJobReceipt, type KitchenDraftMadeFrom, type StepMeta,
} from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';
import { browserFlows as processBrowserFlows, type BrowserFlowRecorder } from './bridges/browser-flow-record.js';
import { checkBrowserJobLabels } from './bridges/browser-job-labels.js';
import { browserJobs as processBrowserJobs, browserJobSession, type BrowserJobRegistry } from './bridges/browser-job-registry.js';
import type { KitchenDraftStore } from './kitchen-draft-store.js';
import type { OpAdmissionGate } from './op-admission-gate.js';
import { compilePlanDraft } from './request-recipe.js';

/** The op's MCP tool, as an app calls it. */
export const KITCHEN_DRAFT_FROM_JOB_TOOL = `recued_ingredient_${KITCHEN_DRAFT_FROM_JOB_SLUG}`;
/** What a job whose plan holds nothing a recipe can repeat answers. `recued_endJob` says it before
 *  the owner is ever asked. */
export const NO_ACTIONS_JOB_ISSUE = 'Nothing in this job worked in a web page that a recipe can repeat.';

export const createKitchenDraftFromJob = (deps: {
  kitchenDrafts: Pick<KitchenDraftStore, 'createCompiled'>;
  gate: Pick<OpAdmissionGate, 'isOpGranted' | 'isFrozenByPause'>;
  jobs?: Pick<BrowserJobRegistry, 'keptFor' | 'activeFor' | 'release'>;
  flows?: Pick<BrowserFlowRecorder, 'stepsFor' | 'callsFor' | 'planFor' | 'forget' | 'keep'>;
  auditLog?: AuditLogStore;
  /** D-402 slice D2 — the owner's zone, for a typed day relative to the run's day. */
  timeZone?: () => string | undefined;
  /** D-402 slice H2 — the paired browsers when the draft is made (`listBrowsers`). */
  browsers?: () => ReadonlyArray<{ bridge_id: string; browser_id: string; name: string }> | undefined;
}) => async (raw: unknown, meta: StepMeta | undefined): Promise<KitchenDraftFromJobReceipt> => {
  const source = meta?.execution_source;
  // Only an AI app has a job: its token and agent id own it.
  if (!source || source.channel !== 'mcp' || !deps.gate.isOpGranted(source, KITCHEN_DRAFT_FROM_JOB_OP)) {
    throw new RpcError('op_not_granted', 'Making a recipe from a job is not granted to this caller.', 403);
  }
  if (deps.gate.isFrozenByPause(source)) throw new RpcError('op_not_granted', 'Recued is paused.', 403);
  if (!source.mcp_token_id) throw new RpcError('unauthorized', 'An authenticated MCP token is required.', 401);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).some((key) => key !== 'job_id')) {
    throw new RpcError('bad_request', 'Provide only job_id.', 400);
  }
  const job_id = (raw as { job_id?: unknown }).job_id;
  if (typeof job_id !== 'string' || !/^[\w-]{1,128}$/u.test(job_id)) throw new RpcError('bad_request', 'Provide the job_id recued_startJob returned.', 400);
  const owner = { mcp_token_id: source.mcp_token_id, agent_id: source.agent_id };
  const jobs = deps.jobs ?? processBrowserJobs;
  const flows = deps.flows ?? processBrowserFlows;
  const kept = jobs.keptFor(job_id, owner);
  if (kept === undefined) {
    throw jobs.activeFor(owner) === job_id
      ? new RpcError('conflict', 'This job is still going: end it with recued_endJob and draft, then ask for the draft.', 409)
      : new RpcError('not_found', 'No job of yours is kept for a draft under this id: a job kept for its draft waits a day.', 404);
  }
  const session = browserJobSession(job_id);
  const steps = flows.stepsFor(session, () => true);
  const calls = flows.callsFor(session, () => true);
  if (calls.length === 0) throw new RpcError('not_found', 'Recued no longer holds what this job did.', 404);
  const made_from: KitchenDraftMadeFrom = { kind: 'ai_app_job', job_id };
  const compiled = compilePlanDraft({ calls: flows.planFor(session, () => true), by: 'app', made_from,
    kitchenDrafts: deps.kitchenDrafts,
    origin: kitchenCompiledOrigin(made_from, source.mcp_token_id),
    // What the app said, as the owner reads it in Kitchen; the labels held when the job was kept.
    notes: checkBrowserJobLabels(kept.labels, { steps, calls }).notes,
    ...(kept.labels.title !== undefined ? { title: kept.labels.title } : {}),
    // Slice B2b — the values the app's answer gave, read out of the pages that showed them.
    ...(kept.labels.answer.length > 0 ? { answer: kept.labels.answer } : {}),
    // Slice D (§5.1) — the inputs it named, checked when the job ended: those values are asked for at
    // each run, by the app's names; any other typed value is fixed.
    inputs: kept.labels.inputs,
    // Slice E1 (§6) — where it used judgement: a value got so is asked of its page at each run.
    judgements: kept.labels.judgements,
    ...((): { time_zone?: string } => { const zone = deps.timeZone?.(); return zone !== undefined ? { time_zone: zone } : {}; })(),
    // Slice H2 — each browser setting holds the lasting id of the browser it ran in.
    ...((): { browsers?: ReadonlyArray<{ bridge_id: string; browser_id: string; name: string }> } => {
      const browsers = deps.browsers?.(); return browsers !== undefined ? { browsers } : {};
    })() });
  if (!compiled.ok) {
    throw new RpcError('conflict', compiled.reason === 'no_actions' ? NO_ACTIONS_JOB_ISSUE
      : `Recued could not make a valid recipe of this job: ${compiled.issues.join(' ')}`, 409);
  }
  jobs.release(job_id);
  flows.keep(session, undefined);
  flows.forget(session, () => true);
  const { draft } = compiled;
  await deps.auditLog?.logActivity({ activity_id: `kitchen-from-job-${draft.draft_id}`, timestamp: draft.created_at,
    action: 'kitchen_draft_imported', target: draft.draft_id,
    detail: JSON.stringify({ kind: draft.kind, source_hash: draft.source_hash, made_from,
      origin: kitchenCompiledOrigin(made_from, source.mcp_token_id), installed: false }) }).catch(() => {});
  return { draft_id: draft.draft_id, title: draft.title, kitchen_path: kitchenDraftPath(draft.draft_id),
    notes: draft.notes ?? [], installed: false };
};
