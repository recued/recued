/** Explicit owner conversions. Bytes and subprocesses stay on the ordinary
 * executor path; this module keeps only a bounded, temporary text result. */
import { createHash, randomUUID } from 'node:crypto';
import { FILE_PREVIEW_MAX_BYTES, FILE_PREVIEW_TEXT_CHARACTERS, RpcError,
  type FilePreviewConverter, type FilePreviewConversionAvailability, type FilePreviewConversionRequest,
  type FilePreviewConversionResult, type RunAnchorStatus } from '@recued/contracts';
import { documentReadRecipe } from './document-read-recipe.js';
import { PREVIEW_CONVERSION_RECIPE_PREFIX, registerPreviewConversionInput } from './file-preview-conversion-guard.js';
import type { PreviewSelection } from './file-preview.js';
import { registerResumedRunFinisher, takeResumedRunFinisher } from './resumed-run-finishers.js';
import { executeResponseAuditRunId, type ExecuteRequest, type ExecuteResponse } from './types.js';
import type { WsClient } from './ws-server.js';

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_JOBS = 16;
const RESULT_TTL = 15 * 60 * 1000;
const HOLD_TTL = 24 * 60 * 60 * 1000;
const FAILED = 'The file could not be converted. Check the document reader in Packs, or download the original file.';
const CHANGED = 'The file or document reader changed. Close the preview and select the file again.';
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
export interface PreviewReader { converter: FilePreviewConverter; fingerprint: string }
export interface FilePreviewConversionDeps {
  readers(): PreviewReader[];
  execute(request: Pick<ExecuteRequest, 'recipe' | 'config'>, client: WsClient): Promise<ExecuteResponse>;
  runStatus?(run: string): Promise<RunAnchorStatus | undefined>;
  now?: () => number;
}
interface Job {
  owner: string;
  requests: Set<string>;
  key: string;
  record_id: string;
  revision: string;
  reader: PreviewReader;
  at: number;
  terminalAt?: number;
  sourceHash?: string;
  timer?: ReturnType<typeof setTimeout>;
  disposeInput?: () => void;
  result: FilePreviewConversionResult;
}

/** Restrict the offer to work documents, rather than trying an installed CLI
 * against executables, archives or arbitrary binary uploads. */
export const canConvertPreview = (file: PreviewSelection): boolean => {
  if (file.download_unavailable_reason || (!file.export_as && file.size !== undefined && file.size > FILE_PREVIEW_MAX_BYTES)) return false;
  const name = file.export_as?.filename ?? file.filename;
  const mime = (file.export_as?.mime_type ?? file.mime_type ?? '').toLowerCase().split(';')[0]!;
  return /\.(?:pdf|docx?|xlsx?|pptx?|od[tps]|rtf|epub|html?|png|jpe?g|tiff?|bmp)$/iu.test(name)
    || /^(?:application\/(?:pdf|msword|rtf|epub\+zip|vnd\.(?:openxmlformats-officedocument\.|ms-(?:excel|powerpoint)|oasis\.opendocument\.))|image\/(?:png|jpeg|tiff|bmp)|text\/(?:html|rtf))/u.test(mime);
};

export const createFilePreviewConversions = (
  deps: FilePreviewConversionDeps,
  select: (id: string) => PreviewSelection,
) => {
  const jobs = new Map<string, Job>();
  const now = deps.now ?? Date.now;
  const remove = (id: string, job: Job) => {
    if (job.timer) clearTimeout(job.timer);
    if (job.result.run_id) takeResumedRunFinisher(job.result.run_id);
    job.disposeInput?.(); jobs.delete(id);
  };
  const expire = (job: Job, ttl: number) => {
    if (job.timer) clearTimeout(job.timer);
    if (jobs.get(job.result.conversion_id) !== job) return;
    job.timer = setTimeout(() => remove(job.result.conversion_id, job), ttl);
    job.timer.unref();
  };
  const prune = () => {
    for (const [id, job] of jobs) {
      const active = job.result.state === 'awaiting_approval' || job.result.state === 'running';
      if (now() - job.at > (active ? HOLD_TTL : RESULT_TTL)) remove(id, job);
    }
  };
  const availability = (file: PreviewSelection): FilePreviewConversionAvailability | undefined => {
    if (!canConvertPreview(file)) return undefined;
    try {
      const readers = deps.readers().map(reader => reader.converter);
      return { readers, ...(readers.length ? {} : { unavailable_reason: 'Add MarkItDown or Docling from Packs to convert this file to text.' }) };
    } catch {
      return { readers: [], unavailable_reason: 'Document readers could not be checked. Try Check readers again.' };
    }
  };
  const fail = (job: Job, message: string) => {
    job.result = { conversion_id: job.result.conversion_id, record_id: job.record_id, selection_revision: job.revision, converter: job.reader.converter,
      state: 'failed', message, ...(job.result.run_id ? { run_id: job.result.run_id } : {}) };
    job.at = now(); job.disposeInput?.(); expire(job, RESULT_TTL);
    if (job.result.run_id) takeResumedRunFinisher(job.result.run_id);
  };
  const current = (job: Job): boolean => {
    if (jobs.get(job.result.conversion_id) !== job) return false;
    try {
      const file = select(job.record_id);
      return file.selection_revision === job.revision && canConvertPreview(file)
        && deps.readers().some(reader => reader.converter === job.reader.converter && reader.fingerprint === job.reader.fingerprint);
    } catch { return false; }
  };
  const finish = (job: Job, response: ExecuteResponse) => {
    const run = executeResponseAuditRunId(response);
    if (run) job.result.run_id = run;
    if (!current(job)) { fail(job, CHANGED); return; }
    if (response.awaiting_approval) {
      if (!job.result.run_id) { fail(job, 'The conversion approval could not be tracked. Check Approvals before trying again.'); return; }
      job.result.state = 'awaiting_approval'; job.result.message = 'Waiting for your approval. Approve the conversion in Approvals to continue.';
      registerResumedRunFinisher(job.result.run_id, { tool_name: 'file.preview', finish: async resumed => {
        finish(job, resumed);
        // A paired preview owns this temporary text, not a chat or MCP caller.
        return { ok: true, result: { status: job.result.state, hint: 'Return to the file preview to see the conversion.' } };
      } });
      return;
    }
    if (!response.success) { fail(job, FAILED); return; }
    if (!job.sourceHash) { fail(job, 'The converted source could not be verified. Download the file, or try conversion again.'); return; }
    const payload = object(response.output.render[0]?.data);
    if (typeof payload?.bytes_b64 !== 'string' || payload.bytes_b64.length > Math.ceil(MAX_OUTPUT_BYTES / 3) * 4) { fail(job, FAILED); return; }
    const bytes = Buffer.from(payload.bytes_b64, 'base64');
    if (bytes.toString('base64') !== payload.bytes_b64 || bytes.length > MAX_OUTPUT_BYTES || (typeof payload.size_bytes === 'number' && bytes.length !== payload.size_bytes)) { fail(job, FAILED); return; }
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail(job, FAILED); return; }
    if (text.includes('\0')) { fail(job, FAILED); return; }
    let visible = text.slice(0, FILE_PREVIEW_TEXT_CHARACTERS);
    if (/[\uD800-\uDBFF]$/u.test(visible)) visible = visible.slice(0, -1);
    job.result = { conversion_id: job.result.conversion_id, record_id: job.record_id, selection_revision: job.revision, converter: job.reader.converter, state: 'ready',
      ...(job.result.run_id ? { run_id: job.result.run_id } : {}), text: visible, truncated: visible.length < text.length, source_content_hash: job.sourceHash,
      message: text.trim() ? 'Converted document text. Images, layout and other content may be omitted.'
        : 'The reader returned no text. Download the original file to view its complete contents.' };
    job.at = now(); job.disposeInput?.(); expire(job, RESULT_TTL);
  };
  const call = async (raw: FilePreviewConversionRequest, client: WsClient): Promise<FilePreviewConversionResult> => {
    const args = object(raw);
    if (!client.instance_id || client.client_kind === 'bridge') throw new RpcError('unauthorized', 'Conversion requires the paired web app.', 401);
    prune();
    if (args?.action === 'status') {
      if (typeof args.conversion_id !== 'string' || !/^[a-f0-9-]{36}$/u.test(args.conversion_id)) throw new RpcError('bad_request', 'Choose a conversion.', 400);
      const job = jobs.get(args.conversion_id);
      if (!job || job.owner !== client.instance_id) throw new RpcError('not_found', 'This temporary conversion is no longer available. Convert the file again.', 404);
      if (!current(job)) fail(job, CHANGED);
      if (['running', 'awaiting_approval'].includes(job.result.state) && job.result.run_id && deps.runStatus) {
        const state = await deps.runStatus(job.result.run_id);
        if (['running', 'awaiting_approval'].includes(job.result.state) && state) {
          if (state === 'awaiting_approval') {
            job.result.state = 'awaiting_approval';
            job.result.message = 'Waiting for your approval. Approve the conversion in Approvals to continue.';
          } else if (['pending', 'running', 'awaiting_peer'].includes(state)) {
            job.result.state = 'running'; job.result.message = 'Converting the file to text…';
          } else if (state !== 'succeeded' || (job.terminalAt !== undefined && now() - job.terminalAt > 3000)) {
            takeResumedRunFinisher(job.result.run_id);
            fail(job, state === 'cancelled' ? 'Conversion was cancelled or was not approved. You can download the original file.'
              : 'The conversion ended without a usable preview. Check Activity before trying again.');
          } else {
            // The anchor commits before the resumer delivers its finisher.
            // Let that delivery finish before reporting a lost result.
            job.terminalAt ??= now();
          }
        }
      }
      return { ...job.result };
    }
    if (args?.action !== 'start' || typeof args.record_id !== 'string' || !args.record_id || args.record_id.length > 12000
      || typeof args.selection_revision !== 'string' || !/^[a-f0-9]{64}$/u.test(args.selection_revision)
      || typeof args.request_id !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/u.test(args.request_id)
      || !['markitdown', 'docling'].includes(String(args.converter))) throw new RpcError('bad_request', 'Choose a file and document reader to convert.', 400);
    const file = select(args.record_id);
    if (file.selection_revision !== args.selection_revision) throw new RpcError('file_selection_changed', CHANGED, 409);
    if (!canConvertPreview(file)) throw new RpcError('bad_request', 'This file cannot be converted for preview. Download it to open it.', 400);
    let reader: PreviewReader | undefined;
    try { reader = deps.readers().find(reader => reader.converter === args.converter); }
    catch { throw new RpcError('not_configured', 'Document readers could not be checked. Try again in a moment.', 503); }
    if (!reader) throw new RpcError('not_configured', 'This document reader is unavailable. Add or enable it in Packs.', 503);
    const request = createHash('sha256').update(JSON.stringify([args.record_id, args.selection_revision, args.converter, reader.fingerprint])).digest('hex');
    for (const job of jobs.values()) {
      if (job.owner !== client.instance_id) continue;
      if (job.requests.has(args.request_id)) {
        if (job.record_id !== args.record_id || job.revision !== args.selection_revision || job.reader.fingerprint !== reader.fingerprint
          || job.reader.converter !== reader.converter) throw new RpcError('conflict', 'This conversion request was already used for a different file or reader. Close the preview and try again.', 409);
        return { ...job.result };
      }
      if (['running', 'awaiting_approval'].includes(job.result.state) && job.key === request) {
        if (job.requests.size >= 16) throw new RpcError('busy', 'This conversion is already open in several views. Follow the current conversion in Activity.', 429);
        job.requests.add(args.request_id); return { ...job.result };
      }
    }
    if (jobs.size >= MAX_JOBS) {
      const completed = [...jobs].find(([, job]) => job.result.state === 'ready' || job.result.state === 'failed');
      if (completed) remove(completed[0], completed[1]);
    }
    if (jobs.size >= MAX_JOBS) throw new RpcError('busy', 'Too many temporary conversions are open. Try again after a conversion finishes.', 429);
    const id = randomUUID();
    const job: Job = { owner: client.instance_id, requests: new Set([args.request_id]), key: request, record_id: args.record_id, revision: args.selection_revision,
      ...(/^file:[0-9a-f]{32}$/u.test(args.record_id) && file.content_hash ? { sourceHash: file.content_hash } : {}),
      reader, at: now(), result: { conversion_id: id, record_id: args.record_id, selection_revision: args.selection_revision, converter: reader.converter, state: 'running', message: 'Converting the file to text…' } };
    jobs.set(id, job);
    const recipeId = PREVIEW_CONVERSION_RECIPE_PREFIX + id;
    job.disposeInput = registerPreviewConversionInput(recipeId, record => {
      if (record !== job.record_id || !current(job)) throw new Error(CHANGED);
      return FILE_PREVIEW_MAX_BYTES;
    }, hash => { job.sourceHash = hash; });
    expire(job, HOLD_TTL);
    const base = documentReadRecipe(reader.converter);
    try {
      finish(job, await deps.execute({ recipe: { ...base, recipe_id: recipeId,
        metadata: { ...base.metadata, name: `Preview ${file.export_as?.filename ?? file.filename}`, description: 'Create a temporary text preview of one selected file.' } },
        config: { source: file.content_hash && /^file:[0-9a-f]{32}$/u.test(args.record_id)
          ? { backing: 'cas', record_id: args.record_id, content_sha256: file.content_hash } : args.record_id } }, client));
    } catch { fail(job, current(job) ? FAILED : CHANGED); }
    return { ...job.result };
  };
  return { availability, call };
};
