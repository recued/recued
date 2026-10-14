import { createHash } from 'node:crypto';
import { RpcError, type QuoteCompletionPrepareInput, type QuoteCompletionPublishInput,
  type QuoteCompletionCancelInput, type QuoteCompletionListInput, type QuoteCompletionResponse } from '@recued/contracts';
import { QuoteSignoffError } from './quote-signoff-service.js';
import { openApprovalIntentPiiField } from './ports/reception/approval-pii.js';
import type { ApprovalIntentSummary } from './storage/reception-approval-store.js';
import { handleReceptionEndpointPreviewDraft, handleReceptionEndpointCreate, handleReceptionEndpointEnable,
  handleReceptionEndpointRevoke, type ReceptionRpcDeps } from './reception-rpc-handler.js';

type Caller = { instance_id?: string | null } | undefined;
const serviceFor = (deps: ReceptionRpcDeps, caller: Caller) => {
  if (!caller?.instance_id) throw new RpcError('unauthorized', 'Completion requests require a paired owner client.', 401);
  if (!deps.getQuoteCompletionService || !deps.getApprovalIntentStore) throw new RpcError('not_configured', 'Customer completion requests are unavailable.', 503);
  return deps.getQuoteCompletionService();
};
const run = async <T>(body: () => T | Promise<T>): Promise<T> => {
  try { return await body(); } catch (error) {
    if (error instanceof QuoteSignoffError) throw new RpcError(error.code,error.message,error.status);
    throw error;
  }
};
const shape = (input: unknown, keys: string[]) => {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) {
    throw new RpcError('quote_completion_invalid','Invalid completion request input.',400);
  }
};
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)) {
    throw new RpcError('quote_completion_invalid','A completion request reference is required.',400);
  }
  return value;
};
const draft = (deps: ReceptionRpcDeps, completionId: string) => ({ kind: 'approval_link' as const,
  packet_declaration: { packet_kind: 'approval_link_packet' as const,
    source_query_ref: { kind: 'reception_approval_intent' as const, intent_id: completionId } },
  expires_at: deps.getQuoteCompletionService!().get(completionId).expires_at,
  metadata: { ...deps.getQuoteCompletionService!().approvalConfig(completionId) } });

/** Decode only the captured canonical reply. Never infer a customer decision
 * from processor state; unavailable ciphertext remains explicitly unavailable. */
export const openCompletionResponse = async (deps: ReceptionRpcDeps, entry: {
  completion_id: string; created_at: number; expires_at: number; response: QuoteCompletionResponse;
}, endpoint: string | null, intent: ApprovalIntentSummary | null, capturedAt: number, includeCorrections: boolean, expectedHash: string | null) => {
  if (!intent) return;
  entry.response.decision = 'unavailable';
  if (intent.endpoint_id !== endpoint || intent.intent_id !== endpoint || intent.target_id !== entry.completion_id
    || intent.action_kind !== 'approve_wording') return;
  if (intent.consumed_at === null) { entry.response.decision = entry.response.recorded_at === null ? 'not_recorded' : 'unavailable'; return; }
  if (!Number.isSafeInteger(intent.consumed_at) || intent.consumed_at < entry.created_at
    || intent.consumed_at >= entry.expires_at || intent.consumed_at > capturedAt) return;
  if (entry.response.recorded_at !== null && (expectedHash === null || entry.response.received_at !== intent.consumed_at)) return;
  entry.response.received_at = intent.consumed_at;
  try {
    const key = deps.getApprovalIntentPiiKey?.(); if (!key) return;
    const outcome = await openApprovalIntentPiiField({ key, endpoint_id: intent.endpoint_id, intent_id: intent.intent_id,
      field: 'outcome',ciphertext: intent.consumed_outcome_encrypted });
    if (expectedHash !== null && (outcome === null || createHash('sha256').update(JSON.stringify(outcome)).digest('hex') !== expectedHash)) return;
    if (outcome === 'approve') entry.response.decision = 'accepted';
    else if (outcome?.startsWith('reject:') && outcome.slice(7).trim()) {
      entry.response.decision = 'corrections_requested';
      if (includeCorrections) entry.response.corrections = outcome.slice(7).trim();
    }
  } catch { /* Keep the captured reply unavailable while locked or corrupt. */ }
};

export const handleCompletionPrepare = (deps: ReceptionRpcDeps, input: QuoteCompletionPrepareInput, caller: Caller) => run(async () => {
  const service = serviceFor(deps,caller); shape(input,['signoff_id','delivery_summary','expiry_days']);
  const completion = service.prepare(input);
  try {
    const preview = await handleReceptionEndpointPreviewDraft(deps,draft(deps,completion.completion_id),{ instance_id: caller!.instance_id });
    return { completion,preview_hash: preview.preview_hash,customer_preview: completion.customer_preview };
  } catch (error) { service.cancel(completion.completion_id); throw error; }
});
export const handleCompletionPublish = (deps: ReceptionRpcDeps, input: QuoteCompletionPublishInput, caller: Caller) => run(async () => {
  const service = serviceFor(deps,caller); shape(input,['completion_id','preview_hash']);
  const completionId = id(input.completion_id);
  if (typeof input.preview_hash !== 'string' || !/^[a-f0-9]{64}$/.test(input.preview_hash)) throw new RpcError('quote_completion_invalid','Preview completion before publishing its link.',400);
  service.reservePublish(completionId);
  let endpoint: string | undefined;
  try {
    const owner = { instance_id: caller!.instance_id };
    const created = await handleReceptionEndpointCreate(deps,{ ...draft(deps,completionId),preview_hash: input.preview_hash },owner);
    endpoint = created.endpoint_id; service.attachEndpoint(completionId,endpoint);
    await handleReceptionEndpointEnable(deps,{ endpoint_id: endpoint },owner);
    if (service.checkLink(completionId,endpoint) !== null) throw new QuoteSignoffError('quote_completion_superseded','The work changed while publishing. Preview a new completion request.');
    return { completion: service.get(completionId),share_url: created.share_url_once };
  } catch (error) {
    if (endpoint) await handleReceptionEndpointRevoke(deps,{ endpoint_id: endpoint },{ instance_id: caller!.instance_id }).catch(() => {});
    service.resetPublish(completionId); throw error;
  }
});
export const handleCompletionCancel = (deps: ReceptionRpcDeps, input: QuoteCompletionCancelInput, caller: Caller) => run(() => {
  const service = serviceFor(deps,caller); shape(input,['completion_id']); return service.cancel(id(input.completion_id));
});
export const handleCompletionList = (deps: ReceptionRpcDeps, input: QuoteCompletionListInput | void, caller: Caller) => run(async () => {
  const service = serviceFor(deps,caller);
  if (input !== undefined) shape(input,['signoff_id','review_only','limit','cursor']);
  const capturedAt = (deps.now ?? Date.now)();
  const { result,responses } = service.list(input ?? {},endpoint => endpoint === null ? null : deps.getApprovalIntentStore!().findByEndpoint(endpoint));
  for (const [index,entry] of result.completions.entries()) {
    const binding = responses[index]!;
    await openCompletionResponse(deps,entry,entry.endpoint_id,binding.snapshot,capturedAt,true,binding.expected_hash);
    if (entry.state !== 'accepted' && entry.state !== 'corrections_requested') continue;
    const anchor = entry.endpoint_id ? await deps.auditLog.get(`reception-quote-completion-${entry.endpoint_id}`) : null;
    entry.review = anchor === null ? 'not_queued' : anchor.commit_status === 'awaiting_approval' ? 'waiting'
      : anchor.commit_status === 'running' || anchor.commit_status === 'pending' ? 'running' : 'closed';
  }
  // Closed or declined runs stay in history, rather than asking for a second review.
  if (input?.review_only) result.completions = result.completions.filter(entry => entry.review !== 'closed');
  return result;
});
