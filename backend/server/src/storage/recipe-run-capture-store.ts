/** Bounded, encrypted, process-local captures. Restart/expiry drops private data;
 * only the owner's explicit regression-suite import reaches durable storage. */
import { randomUUID } from 'node:crypto';
import { RpcError, RECIPE_RUN_CAPTURE_LIMITS as LIMIT, parseRecipeRegressionCases,
  type RecipeRunCaptureRequest, type RecipeRunCaptureSummary, type RecipeRunCaptureRead,
  type RecipeRunCaptureImport, type RecipeRunCaptureResult, type RecipeRegressionSave,
  type RecipeRegressionRead } from '@recued/contracts';
import { buildRecipeRunCaptureDraft, copyRecipeCaptureJson, capturedRecipeDigest,
  type RecipeRunCaptureInput, type ExecutionResult } from '@recued/engine';
import type { PreapprovalCodec } from './preapproval-codec.js';
import type { RecipeRegressionStore } from './recipe-regression-store.js';
import type { InternalExecuteOverrides } from '../types.js';
interface Entry {
  actor: string; summary: RecipeRunCaptureSummary; encrypted: string;
  expiry?: ReturnType<typeof setTimeout>; importing?: boolean;
  pending?: { id: string; digest: string; encrypted: string };
}
const unavailable = (message: string): never => { throw new RpcError('not_found',message,404); };
export const createRecipeRunCaptureStore = (codec: PreapprovalCodec,suites: RecipeRegressionStore,now = Date.now) => {
  const entries = new Map<string,Entry>(); let active = 0;
  const purge = (): void => { for (const [id,entry] of entries) if (entry.summary.expires_at <= now()) { clearTimeout(entry.expiry); entries.delete(id); } };
  const check = (owner: () => void): void => { owner(); codec.assertUnlocked(); };
  const current = (id: string,actor: string,owner: () => void): Entry => {
    check(owner); purge(); const entry = entries.get(id);
    if (!entry || entry.actor !== actor) return unavailable('The capture expired, was removed, or belongs to another paired client.');
    return entry;
  };
  const live = (entry: Entry,owner: () => void): void => {
    check(owner); if (entries.get(entry.summary.capture_id) !== entry || entry.summary.expires_at <= now()) unavailable('The capture expired or was removed.');
  };
  const retain = (entry: Entry,encrypted: string,pending?: Entry['pending']): void => {
    let retained = Buffer.byteLength(encrypted) + Buffer.byteLength(pending?.encrypted ?? '');
    for (const other of entries.values()) if (other !== entry) retained += Buffer.byteLength(other.encrypted) + Buffer.byteLength(other.pending?.encrypted ?? '');
    if (retained > LIMIT.retained_bytes) throw new RpcError('capture_limit','Temporary capture storage is full. Remove unused captures first.',409);
    entry.encrypted = encrypted; entry.pending = pending;
  };
  const summary = (entry: Entry): RecipeRunCaptureSummary => structuredClone(entry.summary);
  const read = async (id: string,actor: string,owner: () => void): Promise<RecipeRunCaptureRead> => {
    const entry = current(id,actor,owner);
    if (entry.summary.state !== 'ready') return { capture: summary(entry),draft: null };
    const encrypted = entry.encrypted, draft = await codec.open(encrypted); live(entry,owner);
    if (entry.encrypted !== encrypted || entry.summary.state !== 'ready') throw new RpcError('capture_conflict','Capture changed while loading.',409);
    // Only this module writes the authenticated envelope.
    return { capture: summary(entry),draft: draft as RecipeRunCaptureRead['draft'] };
  };
  return {
    codec,
    prepare(request: RecipeRunCaptureRequest,actor: string,owner: () => void): RecipeRunCaptureSummary {
      check(owner); purge(); if (entries.size >= LIMIT.entries) throw new RpcError('capture_limit','Keep at most 32 temporary captures.',409);
      const encrypted = codec.sealSync(copyRecipeCaptureJson(request)); check(owner);
      const created_at = now(), entry: Entry = { actor,encrypted: '',summary: { capture_id: randomUUID(),recipe_id: request.recipe_id,
        created_at,expires_at: created_at + LIMIT.ttl_ms,state: 'prepared' } };
      retain(entry,encrypted); entries.set(entry.summary.capture_id,entry);
      entry.expiry = setTimeout(() => { if (entries.get(entry.summary.capture_id) === entry) entries.delete(entry.summary.capture_id); },LIMIT.ttl_ms); entry.expiry.unref();
      return summary(entry);
    },
    list(recipeId: string,actor: string,owner: () => void) {
      check(owner); purge(); return { captures: [...entries.values()].filter(entry => entry.actor === actor && entry.summary.recipe_id === recipeId)
        .map(summary).sort((a,b) => b.created_at - a.created_at) };
    },
    read,
    remove(id: string,actor: string,owner: () => void): { deleted: true } {
      const entry = current(id,actor,owner);
      if (entry.summary.state === 'running') throw new RpcError('capture_conflict','Wait for the run to finish before removing its capture.',409);
      clearTimeout(entry.expiry); entries.delete(id); return { deleted: true };
    },
    async run(id: string,actor: string,owner: () => void,
      execute: (request: RecipeRunCaptureRequest,observer: NonNullable<InternalExecuteOverrides['regression_capture']>) => Promise<RecipeRunCaptureResult['execution']>): Promise<RecipeRunCaptureResult> {
      const entry = current(id,actor,owner);
      if (entry.summary.state !== 'prepared') throw new RpcError('capture_started','This capture already started. Reload captured runs to recover it; starting it again is refused.',409);
      if (active >= LIMIT.active) throw new RpcError('capture_limit','Wait for a captured run to finish; at most two can run at once.',409);
      entry.summary.state = 'running'; active++;
      let input: RecipeRunCaptureInput | undefined, observed: ExecutionResult | undefined, reason = '';
      const stopRecording = (error: unknown): void => { input = undefined; observed = undefined; reason = error instanceof Error ? error.message : 'Capture unavailable.'; };
      const observe = (copy: () => void): void => { if (reason) return; try { live(entry,owner); copy(); } catch (error) { stopRecording(error); } };
      // Drop recording copies promptly on lock, revocation or expiry while the
      // ordinary recipe continues under its own existing execution controls.
      const recordingWatch = setInterval(() => { try { live(entry,owner); } catch (error) { stopRecording(error); } },100); recordingWatch.unref();
      try {
        const opened = await codec.open(entry.encrypted); live(entry,owner);
        const request = opened as RecipeRunCaptureRequest;
        // Forget the prepared settings as soon as dispatch owns the request.
        entry.encrypted = '';
        const execution = await execute(request,{
          input: value => observe(() => { input = copyRecipeCaptureJson(value); }),
          result: value => observe(() => { observed = copyRecipeCaptureJson({ ...value,output: { render: [],sidebar: [] } }); }),
        });
        entry.summary.run_id = execution.run_id;
        entry.summary.run_outcome = execution.awaiting_approval ? 'held' : execution.awaiting_peer ? 'waiting'
          : execution.run_terminated ? 'terminated' : observed?.trigger_skipped ? 'skipped' : execution.success ? 'passed' : 'failed';

        if (execution.awaiting_approval || execution.awaiting_peer || execution.run_terminated) reason = 'Held, skipped and terminated runs are incomplete; their capture cannot be imported.';
        if (!reason && input && observed) {
          const abort = new AbortController();
          const timeout = setTimeout(() => abort.abort(new Error('Capture replay exceeded 10 seconds.')),10_000); timeout.unref();
          const watch = setInterval(() => { try { live(entry,owner); } catch (error) { abort.abort(error); } },100); watch.unref();
          try {
            const draft = await buildRecipeRunCaptureDraft(id,input,observed,abort.signal); live(entry,owner);
            const encrypted = await codec.seal(draft); live(entry,owner); retain(entry,encrypted); entry.summary.state = 'ready';
          } catch (error) { reason = error instanceof Error ? error.message : 'Capture replay failed.'; }
          finally { clearTimeout(timeout); clearInterval(watch); }
        }
        if (entry.summary.state !== 'ready') { entry.encrypted = ''; entry.summary.state = 'unavailable'; entry.summary.reason = reason || 'The recipe did not reach the capture boundary.'; }
        return { execution,capture: summary(entry) };
      } catch (error) {
        entry.encrypted = ''; entry.summary.state = 'unavailable'; entry.summary.reason = 'The run did not return a capture. It may have run; check Logs before starting another run.';
        throw error;
      } finally { clearInterval(recordingWatch); active--; input = undefined; observed = undefined; }
    },
    async import(request: RecipeRunCaptureImport,actor: string,owner: () => void): Promise<RecipeRegressionRead> {
      request = copyRecipeCaptureJson(request); const entry = current(request.capture_id,actor,owner), intent = capturedRecipeDigest(request);
      if (entry.importing) throw new RpcError('capture_conflict','Wait for this captured-case import to finish.',409);
      entry.importing = true;
      try {
      const checked = (): void => live(entry,owner);
      if (entry.pending?.id === request.request_id) {
        if (entry.pending.digest !== intent) throw new RpcError('capture_conflict','That import request ID already names different test edits.',409);
        const pending = entry.pending, saved = await codec.open(pending.encrypted); checked();
        if (entry.pending !== pending) throw new RpcError('capture_conflict','Another import changed while loading.',409);
        return await suites.save(saved as RecipeRegressionSave,checked);
      }
      const opened = await read(request.capture_id,actor,owner); checked();
      if (!opened.draft || opened.draft.recipe_digest !== request.recipe_digest || request.reviewed !== true) throw new RpcError('capture_conflict','Load and review this exact capture before importing.',409);
      const latest = await suites.read(entry.summary.recipe_id,undefined,checked); checked();
      if (latest.head_revision !== request.expected_revision) throw new RpcError('conflict','Saved tests changed. Reload before importing the capture.',409);
      const test = parseRecipeRegressionCases([request.case])[0]!;
      if (test.id !== request.capture_id) throw new RpcError('bad_request','Keep the captured case ID when editing the test.',400);
      if (latest.version?.suite.cases.some(item => item.id === test.id)) throw new RpcError('capture_conflict','This capture is already in the latest suite. Edit it in Saved recipe tests.',409);
      const saved: RecipeRegressionSave = { recipe_id: entry.summary.recipe_id,expected_revision: request.expected_revision,request_id: request.request_id,
        suite: { title: latest.version?.suite.title ?? 'Captured recipe tests',baseline: latest.version?.suite.baseline ?? opened.draft.recipe,
          cases: [...latest.version?.suite.cases ?? [],test] } };
      // Validate through the existing store, including byte/case limits. Retain
      // the exact pending write so a lost reply retries the same CAS operation.
      const encrypted = await codec.seal(saved); checked();
      retain(entry,entry.encrypted,{ id: request.request_id,digest: intent,encrypted });
      return await suites.save(saved,checked);
      } finally { entry.importing = false; }
    },
  };
};
export type RecipeRunCaptureStore = ReturnType<typeof createRecipeRunCaptureStore>;
