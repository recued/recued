import { RpcError, type QuoteSignoffPrepareInput, type QuoteSignoffAdditionPrepareInput, type QuoteSignoffPublishInput,
  type QuoteSignoffListInput, type QuoteSignoffCancelInput } from '@recued/contracts';
import { QuoteSignoffError } from './quote-signoff-service.js';
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
  if (input !== undefined) shape(input, ['limit']);
  const limit = input?.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RpcError('quote_signoff_invalid', 'Limit must be 1–100.', 400);
  const result = service.list(limit);
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
  shape(input, ['signoff_id', 'preview_hash']);
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
