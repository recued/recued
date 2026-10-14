import { RpcError, type QuoteSignoffPrepareInput, type QuoteSignoffAdditionPrepareInput, type QuoteSignoffPublishInput,
  type QuoteSignoffListInput, type QuoteSignoffCancelInput, type QuoteSignoffReceiptInput } from '@recued/contracts';
import { openCompletionResponse } from './quote-completion-rpc-handler.js';
import { QuoteSignoffError } from './quote-signoff-service.js';
import { openApprovalIntentPiiField } from './ports/reception/approval-pii.js';
import { handleReceptionEndpointPreviewDraft, handleReceptionEndpointCreate,
  handleReceptionEndpointEnable, handleReceptionEndpointRevoke, type ReceptionRpcDeps } from './reception-rpc-handler.js';

type Caller = { instance_id?: string | null } | undefined;
const serviceFor = (deps: ReceptionRpcDeps, caller: Caller) => {
  if (!caller?.instance_id) throw new RpcError('unauthorized', 'Customer sign-offs require a paired owner client.', 401);
  if (!deps.getQuoteSignoffService || !deps.getApprovalIntentStore) {
    throw new RpcError('not_configured', 'Customer sign-offs are unavailable on this server.', 503);
  }
  return deps.getQuoteSignoffService();
};
const run = async <T>(body: () => T | Promise<T>): Promise<T> => {
  try { return await body(); } catch (error) {
    if (error instanceof QuoteSignoffError) throw new RpcError(error.code, error.message, error.status);
    throw error;
  }
};
const shape = (input: unknown, keys: string[]): void => {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((key) => !keys.includes(key))) {
    throw new RpcError('quote_signoff_invalid', 'Invalid customer sign-off input.', 400);
  }
};
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/.test(value)) {
    throw new RpcError('quote_signoff_invalid', 'A customer sign-off reference is required.', 400);
  }
  return value;
};
const endpointDraft = (deps: ReceptionRpcDeps, signoffId: string) => {
  const service = deps.getQuoteSignoffService!();
  return { kind: 'approval_link' as const,
    packet_declaration: { packet_kind: 'approval_link_packet' as const,
      source_query_ref: { kind: 'reception_approval_intent' as const, intent_id: signoffId } },
    expires_at: service.get(signoffId).expires_at, metadata: { ...service.approvalConfig(signoffId) } };
};

export const handleSignoffQuotes = (deps: ReceptionRpcDeps, caller: Caller) =>
  run(() => serviceFor(deps, caller).quotes(100));

export const handleSignoffList = (deps: ReceptionRpcDeps, input: QuoteSignoffListInput | void, caller: Caller) => run(async () => {
  const service = serviceFor(deps, caller);
  if (input !== undefined) shape(input, ['limit', 'search', 'state', 'cursor', 'signoff_id']);
  const result = service.list(input ?? {});
  await Promise.all(result.signoffs.map(async (signoff) => {
    if (signoff.state !== 'accepted' || !signoff.endpoint_id) return;
    const anchor = await deps.auditLog.get(`reception-quote-signoff-${signoff.endpoint_id}`);
    signoff.release_review = anchor === null ? 'not_queued'
      : anchor.commit_status === 'awaiting_approval' ? 'waiting'
        : anchor.commit_status === 'running' || anchor.commit_status === 'pending' ? 'running' : 'closed';
  }));
  return result;
});

export const handleSignoffPrepare = (deps: ReceptionRpcDeps, input: QuoteSignoffPrepareInput, caller: Caller) => run(async () => {
  const service = serviceFor(deps, caller);
  shape(input, ['quote_id', 'scope', 'display_name', 'task_title', 'invoice_ref', 'vat_amount', 'issued_on', 'due_on', 'expiry_days']);
  const signoff = service.prepare(input);
  try {
    const draft = endpointDraft(deps, signoff.signoff_id);
    const preview = await handleReceptionEndpointPreviewDraft(deps, draft, { instance_id: caller!.instance_id });
    return { signoff, preview_hash: preview.preview_hash, customer_preview: draft.metadata.context_raw.summary };
  } catch (error) { service.cancel(signoff.signoff_id); throw error; }
});

export const handleSignoffPrepareAddition = (deps: ReceptionRpcDeps, input: QuoteSignoffAdditionPrepareInput, caller: Caller) => run(async () => {
  const service = serviceFor(deps, caller);
  shape(input, ['parent_signoff_id', 'scope', 'amount', 'display_name', 'invoice_ref', 'vat_amount', 'issued_on', 'due_on', 'expiry_days']);
  const signoff = service.prepareAddition({ ...input, parent_signoff_id: id(input.parent_signoff_id) });
  try {
    const draft = endpointDraft(deps, signoff.signoff_id);
    const preview = await handleReceptionEndpointPreviewDraft(deps, draft, { instance_id: caller!.instance_id });
    return { signoff, preview_hash: preview.preview_hash, customer_preview: draft.metadata.context_raw.summary };
  } catch (error) { service.cancel(signoff.signoff_id); throw error; }
});

export const handleSignoffPublish = (deps: ReceptionRpcDeps, input: QuoteSignoffPublishInput, caller: Caller) => run(async () => {
  const service = serviceFor(deps, caller);
  shape(input, ['signoff_id', 'preview_hash', 'remember_link_for_reminders']);
  if (input.remember_link_for_reminders !== undefined && typeof input.remember_link_for_reminders !== 'boolean') {
    throw new RpcError('quote_signoff_invalid', 'Choose whether to save the link for follow-up emails.', 400);
  }
  if (input.remember_link_for_reminders && !deps.getQuoteSignoffReminderService) {
    throw new RpcError('not_configured', 'Sign-off reminders are unavailable on this server.', 503);
  }
  const signoffId = id(input.signoff_id);
  if (typeof input.preview_hash !== 'string' || !/^[a-f0-9]{64}$/.test(input.preview_hash)) {
    throw new RpcError('quote_signoff_invalid', 'Preview this request before publishing its link.', 400);
  }
  service.reservePublish(signoffId);
  let endpointId: string | undefined;
  try {
    const owner = { instance_id: caller!.instance_id };
    const created = await handleReceptionEndpointCreate(deps, { ...endpointDraft(deps, signoffId), preview_hash: input.preview_hash }, owner);
    endpointId = created.endpoint_id;
    service.attachEndpoint(signoffId, endpointId);
    await handleReceptionEndpointEnable(deps, { endpoint_id: endpointId }, owner);
    // Cancel/supersession during the async enable still closes the visitor and
    // release paths; do not return an obsolete link as ready to share.
    if (service.checkLink(signoffId, endpointId) !== null) throw new QuoteSignoffError('quote_signoff_superseded', 'This request changed while publishing. Preview a new one.');
    if (input.remember_link_for_reminders) deps.getQuoteSignoffReminderService!().rememberLink(signoffId, created.share_url_once);
    return { signoff: service.get(signoffId), share_url: created.share_url_once };
  } catch (error) {
    if (endpointId) {
      await handleReceptionEndpointRevoke(deps, { endpoint_id: endpointId }, { instance_id: caller!.instance_id })
        .catch(() => { /* The service binding remains unavailable on a failed publish. */ });
    }
    service.resetPublish(signoffId);
    throw error;
  }
});

export const handleSignoffCancel = (deps: ReceptionRpcDeps, input: QuoteSignoffCancelInput, caller: Caller) => run(() => {
  const service = serviceFor(deps, caller); shape(input, ['signoff_id']);
  return service.cancel(id(input.signoff_id));
});

export const handleSignoffReceipt = (deps: ReceptionRpcDeps, input: QuoteSignoffReceiptInput, caller: Caller) => run(async () => {
  const service = serviceFor(deps, caller);
  shape(input, ['signoff_id']);
  const store = deps.getApprovalIntentStore!();
  const completionService = deps.getQuoteCompletionService?.();
  const read = (endpoint: string | null) => endpoint === null ? null : store.findByEndpoint(endpoint);
  const { receipt, responses, completionSnapshot } = service.receipt(id(input.signoff_id),read,
    completionService ? ids => completionService.receipt(ids,read) : undefined);
  let key: Uint8Array | undefined;
  for (const [index, binding] of responses.entries()) {
    const entry = receipt.requests[index]!; const intent = binding.snapshot;
    if (intent === null) continue;
    if (intent.endpoint_id !== binding.endpoint_id || intent.intent_id !== binding.endpoint_id
      || intent.target_id !== entry.signoff_id || intent.action_kind !== 'approve_wording') {
      entry.response.decision = 'unavailable'; continue;
    }
    if (intent.consumed_at === null) continue;
    entry.response.decision = 'unavailable';
    if (!Number.isSafeInteger(intent.consumed_at) || intent.consumed_at < 0 || intent.consumed_at > receipt.captured_at) continue;
    entry.response.received_at = intent.consumed_at;
    try {
      key ??= deps.getApprovalIntentPiiKey?.();
      if (!key) continue;
      const outcome = await openApprovalIntentPiiField({ key, endpoint_id: intent.endpoint_id,
        intent_id: intent.intent_id, field: 'outcome', ciphertext: intent.consumed_outcome_encrypted });
      if (outcome === 'approve') entry.response.decision = 'accepted';
      else if (outcome === 'reject' || outcome?.startsWith('reject:')) entry.response.decision = 'declined';
    } catch { /* Locked/corrupt replies stay unavailable; never infer from current state. */ }
  }
  if (completionSnapshot && completionSnapshot.entries.length) {
    for (const [index,entry] of completionSnapshot.entries.entries()) {
      const binding = completionSnapshot.responses[index]!;
      await openCompletionResponse(deps,entry,binding.endpoint_id,binding.snapshot,receipt.captured_at,false,binding.expected_hash);
    }
    receipt.version = 2; receipt.completions = completionSnapshot.entries;
  }
  return receipt;
});
