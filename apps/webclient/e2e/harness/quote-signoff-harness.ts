/** The shipped form in a browser with deterministic RPC responses. Server,
 * public-link and gate semantics are tested by quote-signoff-workflow.test.ts. */
import type { QuoteSignoffPrepareInput, QuoteSignoffAdditionPrepareInput, QuoteSignoffSummary, QuoteSignoffReceipt, QuoteCompletionSummary, QuoteCompletionPrepareInput } from '@recued/contracts';
import { mountQuoteSignoffPanel, type QuoteSignoffConn } from '../../src/reception/quote-signoff-panel.js';
import type { MailComposeDeps } from '../../src/mail/mail-compose-host.js';

const params = new URLSearchParams(location.search);
const serverReference = Date.now() + Number(params.get('server_clock_offset') ?? 0);
const serverStarted = performance.now();
const serverNow = () => serverReference + Math.max(0,Math.floor(performance.now() - serverStarted));
const listClock = () => params.has('legacy_list_clock') ? {} : { server_now: serverNow() };
const previewClock = () => {
  const now = serverNow();
  return params.has('legacy_preview') ? {} : { preview_expires_at: now + 600_000, preview_server_now: now };
};
const signoff: QuoteSignoffSummary = {
  signoff_id: 'a1fecd4e-42ce-42a2-b7e7-731ce51a01b2', quote_id: 'Q1', quote_version: 2, quote_revision: 3,
  quote_label: 'Drawings', customer: 'Morgan', amount: '120.0000', currency: 'GBP', net: '100.0000', vat_amount: '20.0000',
  scope: 'Three drawings.', task_title: 'Draw the plans', invoice_ref: 'INV-101', issued_on: '2026-10-11', due_on: '2026-11-10',
  state: 'draft', availability: 'current', created_at: serverNow(), expires_at: serverNow() + 7 * 86_400_000,
  endpoint_id: null, responded_at: null, released_at: null, task_id: null, invoice_id: null,
};
let listed = params.has('completion') || params.has('waiting');
if (params.has('waiting')) Object.assign(signoff, { state: 'waiting', endpoint_id: 'ep-1' });
if (params.has('completion')) Object.assign(signoff,{ state: 'released',released_at: 1,task_id: `quote_signoff_${signoff.signoff_id}`,invoice_id: `quote_signoff_${signoff.signoff_id}`,
  can_request_completion: true,can_add_work: true,follow_up: { checked_at: 1,task: { availability: 'current',title: signoff.task_title,done: false },
    invoice: { availability: 'current',status: 'open',amount_paid: '0.0000',outstanding: signoff.amount,due_on: signoff.due_on,overdue: false } } });
let completionError = false;
let signoffListError: string | null = null;
let cancelError = false;
let quoteRoster: 'available' | 'error' | 'missing' | 'truncated' = params.has('quotes_error') ? 'error' : 'available';
let publishFailure: 'expired' | 'offline' | null = null;
let resumeFailure = false;
let prepareFailure: 'before' | 'after' | null = null;
let linkStatus: 'current' | 'inactive' | 'unavailable' | undefined;
let deferredMethod: string | undefined;
let deferredKey: string | undefined;
const deferredReads = new Map<string,() => void>();
let savedInput: QuoteSignoffPrepareInput | QuoteSignoffAdditionPrepareInput | undefined;
let completionExpiry = 7;
let addition: QuoteSignoffSummary | undefined;
const completions: QuoteCompletionSummary[] = [];
const secondReceipt = params.has('two_receipts') ? { ...signoff,signoff_id: 'c1fecd4e-42ce-42a2-b7e7-731ce51a01b2',
  quote_id: 'Q2',quote_label: 'Brand book',customer: 'Taylor',scope: 'Second saved agreement for Taylor.' } : undefined;
if (secondReceipt) listed = true;
let receiptMode: 'valid' | 'unsupported' | 'mismatched' | 'invalid_time' = 'valid';

let releasePending: (() => void) | undefined;
let receiptError = false;
const calls: Array<{ method: string; payload: unknown }> = [];
// This transport substitute is deliberately limited to this owner's sign-off RPCs.
const conn = (async (method: string, payload?: unknown) => {
  calls.push({ method, payload: structuredClone(payload) });
  if (method.endsWith('.reminders.list')) return {reminders: []};
  if (method.endsWith('.resume') && resumeFailure) throw new Error('Fixture resume unavailable. Try again.');
  if (deferredMethod === method || params.get('defer') === method || params.get('defer') === method.split('.').at(-1)) {
    const key = deferredKey; deferredMethod = undefined; deferredKey = undefined;
    await new Promise<void>((resolve) => { if (key) deferredReads.set(key,resolve); else releasePending = resolve; });
  }
  if (['reception.signoff.cancel','reception.signoff.completion.cancel'].includes(method) && cancelError) throw new Error('Fixture cancellation unavailable. Try again.');
  if (['reception.signoff.publish','reception.signoff.completion.publish'].includes(method) && publishFailure) {
    throw Object.assign(new Error(publishFailure === 'expired' ? 'reception.endpoint.create: preview_hash expired (10-min TTL) — re-run preview_draft' : 'Fixture publish unavailable.'),
      {code:publishFailure === 'expired' ? 'preview_hash_expired' : 'connection_failed'});
  }
  if (['reception.signoff.prepare','reception.signoff.prepare_addition','reception.signoff.completion.prepare'].includes(method) && prepareFailure) {
    if (prepareFailure === 'after') { if (method.includes('.completion.')) completions.forEach(entry => { entry.state = 'superseded'; }); else (addition ?? signoff).state = 'superseded'; }
    throw new Error('Fixture preview unavailable. Try again.');
  }
  if (method === 'reception.signoff.link.check') {
    if (linkStatus === 'unavailable') throw new Error('Link check unavailable');
    const input = payload as {kind: string};
    return {current: linkStatus ? linkStatus === 'current' : input.kind === 'completion' ? completions[0]?.state === 'waiting' && completions[0].response.decision === 'not_recorded' : (addition ?? signoff).state === 'waiting'};
  }
  if (method === 'reception.signoff.resume') {
    const saved = (payload as {signoff_id: string}).signoff_id === addition?.signoff_id ? addition! : signoff;
    return {signoff: structuredClone(saved),display_name: savedInput?.display_name ?? 'Studio',expiry_days: savedInput?.expiry_days ?? 7,
      ...(saved.addition ? {parent: structuredClone(signoff)} : {}),preview_hash: 'e'.repeat(64),customer_preview: `Saved preview for Morgan\n\n${saved.scope}`,...previewClock()};
  }
  if (method === 'reception.signoff.quotes') {
    if (quoteRoster === 'error') throw new Error('Fixture quote roster unavailable.');
    return {quotes:quoteRoster === 'available' ? [{id:'Q1',label:'Drawings',customer:'Morgan',amount:'120',currency:'GBP',revision:3},
      ...(params.has('two_quotes') ? [{id:'Q2',label:'Brand book',customer:'Taylor',amount:'900',currency:'GBP',revision:1}] : [])] : [],truncated:quoteRoster === 'truncated'};
  }
  if (method === 'reception.signoff.list') {
    if (signoffListError) throw new Error(signoffListError);
    const query = payload as { state?: string; signoff_id?: string; search?: string };
    const rows = listed ? [signoff,...(addition ? [addition] : []),...(secondReceipt ? [secondReceipt] : [])] : [];
    return { signoffs: structuredClone(rows.filter(entry => (!query.state || entry.state === query.state)
      && (!query.signoff_id || entry.signoff_id === query.signoff_id)
      && (!query.search || [entry.customer,entry.quote_label,entry.invoice_ref].join(' ').toLowerCase().includes(query.search.toLowerCase())))),truncated: false,...listClock() };
  }
  if (method === 'reception.signoff.prepare') {
    const input = payload as QuoteSignoffPrepareInput; const createdAt = serverNow(); savedInput = structuredClone(input);
    Object.assign(signoff, { state: 'draft', scope: input.scope, task_title: input.task_title, invoice_ref: input.invoice_ref, created_at:createdAt, expires_at:createdAt+(input.expiry_days ?? 7)*86_400_000 }); listed = true;
    return { signoff: structuredClone(signoff), preview_hash: 'b'.repeat(64),...previewClock(),
      customer_preview: `Quote Q-1 — Morgan\nRevision 3\n120.0000 GBP total\n\n${input.scope}` };
  }
  if (method === 'reception.signoff.prepare_addition') {
    const input = payload as QuoteSignoffAdditionPrepareInput; const createdAt = serverNow(); savedInput = structuredClone(input);
    addition = { ...signoff, signoff_id: 'c1fecd4e-42ce-42a2-b7e7-731ce51a01b2', state: 'draft', amount: input.amount,
      scope: input.scope, invoice_ref: input.invoice_ref, endpoint_id: null, responded_at: null, released_at: null, created_at:createdAt, expires_at:createdAt+(input.expiry_days ?? 7)*86_400_000,
      addition: { root_signoff_id: signoff.signoff_id, parent_signoff_id: input.parent_signoff_id, revision: 1,
        base_scope: signoff.scope, base_amount: signoff.amount, total_amount: '150.0000' } };
    return { signoff: structuredClone(addition), preview_hash: 'd'.repeat(64),...previewClock(),
      customer_preview: `Added work for Morgan\nPreviously agreed: 120.0000 GBP\nNew agreed total: 150.0000 GBP\n\n${input.scope}` };
  }
  if (method === 'reception.signoff.publish') {
    const selected = addition?.signoff_id === (payload as { signoff_id: string }).signoff_id ? addition : signoff;
    selected.state = 'waiting'; selected.endpoint_id = 'ep-1';
    return { signoff: structuredClone(selected), share_url: 'https://studio.example.test/r/signoff/fixture-token' };
  }
  if (method === 'reception.signoff.cancel') { signoff.state = 'cancelled'; return structuredClone(signoff); }
  if (method.startsWith('reception.signoff.completion.')) {
    if (completionError) throw new Error('Completion unavailable. Try again.');
    if (method.endsWith('.list')) {
      const input = payload as { review_only?: boolean } | undefined;
      return { completions: structuredClone(input?.review_only ? completions.filter(entry => ['accepted','corrections_requested'].includes(entry.state) && entry.review === 'waiting') : completions),...listClock() };
    }
    if (method.endsWith('.resume')) { const completion = completions.find(entry => entry.completion_id === (payload as {completion_id: string}).completion_id)!;
      return {completion:structuredClone(completion),expiry_days:completionExpiry,preview_hash:'f'.repeat(64),customer_preview:completion.customer_preview,...previewClock()}; }
    if (method.endsWith('.prepare')) {
      const input = payload as QuoteCompletionPrepareInput; const createdAt = serverNow(); completionExpiry = input.expiry_days ?? 7;
      const completion: QuoteCompletionSummary = { completion_id: 'b1fecd4e-42ce-42a2-b7e7-731ce51a01b2',signoff_id: signoff.signoff_id,
        root_signoff_id: signoff.signoff_id,business_name: 'Studio',customer: signoff.customer,quote_label: signoff.quote_label,
        agreed_scope: signoff.scope,delivery_summary: input.delivery_summary,
        customer_preview: `Completion for Q-1 — Morgan\n\nAgreed scope:\n${signoff.scope}\n\nDelivered work:\n${input.delivery_summary}`,
        state: 'draft',availability: 'current',created_at:createdAt,expires_at:createdAt+completionExpiry*86_400_000,endpoint_id: null,
        response: { decision: 'not_recorded',received_at: null,recorded_at: null },owner_action: null };
      completions.splice(0,completions.length,completion);return { completion: structuredClone(completion),preview_hash: 'c'.repeat(64),customer_preview: completion.customer_preview,...previewClock() };
    }
    const completion = completions[0]!;
    if (method.endsWith('.publish')) { completion.state = 'waiting';completion.endpoint_id = 'ep-completion';
      return { completion: structuredClone(completion),share_url: 'https://studio.example.test/r/completion/fixture-token' }; }
    if (method.endsWith('.cancel')) { completion.state = 'cancelled';return structuredClone(completion); }
  }
  if (method === 'reception.signoff.receipt') {
    if (receiptError) throw new Error('Receipt unavailable. Try again.');
    const saved = secondReceipt && (payload as {signoff_id: string}).signoff_id === secondReceipt.signoff_id ? secondReceipt : signoff;
    const receipt: QuoteSignoffReceipt = { format: 'recued.customer-signoff-receipt', version: 1,
      captured_at: Date.parse('2026-10-13T22:00:00Z'), selected_signoff_id: saved.signoff_id, root_signoff_id: saved.signoff_id,
      requests: [{ signoff_id: saved.signoff_id, parent_signoff_id: null, revision: 0, business_name: 'Studio', customer: saved.customer,
        quote_label: saved.quote_label, quote_reference: 'Q-1', quote_revision: saved.quote_revision,
        amount: saved.amount, net: saved.net, vat_amount: saved.vat_amount, currency: saved.currency, scope: saved.scope,
        customer_preview: `Quote Q-1 — ${saved.customer}\nRevision 3\n120.0000 GBP total\n\n${saved.scope}`,
        offer_text_source: params.has('legacy_receipt') ? 'reconstructed' : 'saved',
        state: saved.state, prepared_at: saved.created_at, expires_at: saved.expires_at,
        response: { decision: saved.state === 'accepted' ? 'accepted' : 'not_recorded', received_at: null, recorded_at: null }, release: null }] };
    const receiptCompletions = completions.filter(entry => entry.signoff_id === saved.signoff_id);
    if (receiptCompletions.length) {
      receipt.version = 2;receipt.completions = receiptCompletions.map(({ availability: _a,review: _r,endpoint_id: _e,...entry }) => ({ ...structuredClone(entry),response: { decision: entry.response.decision,received_at: entry.response.received_at,recorded_at: entry.response.recorded_at } }));
    }
    // Prove the document renderer projects fields instead of serializing the transport object.
    Object.assign(receipt, { private_notes: 'PRIVATE margin', share_url: 'PRIVATE fixture-token' });
    if (receiptMode === 'mismatched') receipt.selected_signoff_id = 'wrong-request';
    if (receiptMode === 'invalid_time') receipt.requests[0]!.prepared_at = NaN;
    if (receiptMode === 'unsupported' || params.has('bad_receipt_version')) Object.assign(receipt, { version: 3 });
    return receipt;
  }
  throw new Error(`Unexpected RPC: ${method}`);
}) as QuoteSignoffConn;

// Only the preview opt-in is exercised here. Mail composition has its own lane.
const reminders = params.has('reminders') ? {mail:{listMailInstances:async()=>({instances:[]}),
  runExecute:async()=>{throw new Error('Mail send is not supported by this fixture.');}} as MailComposeDeps} : undefined;
let panel = mountQuoteSignoffPanel({ host: document.getElementById('root')!, conn, document,reminders });
export interface QuoteSignoffBrowserFixture {
  calls: typeof calls;
  release(key?: string): void;
  remount(): void;
  prepareFailure(mode: 'before' | 'after' | null): void;
  failPublish(mode: 'expired' | 'offline' | null): void;
  failResume(value: boolean): void;
  quoteResponse(decision: 'accepted' | 'declined' | 'unavailable',reason?: string,pending?: boolean): void;
  setQuoteRoster(mode: 'available' | 'error' | 'missing' | 'truncated'): void;
  linkStatus(mode: 'current' | 'inactive' | 'unavailable' | undefined): void;
  deferNext(method: string, key?: string): void;
  update(): void;
  dispose(): void;
  setReview(state: NonNullable<QuoteSignoffSummary['release_review']>): void;
  failReceipt(value: boolean): void;
  failSignoffList(message: string | null): void;
  failCancel(value: boolean): void;
  receiptMode(value: 'valid' | 'unsupported' | 'mismatched' | 'invalid_time'): void;
  failCompletion(value: boolean): void;
  setCompletionReview(value: NonNullable<QuoteCompletionSummary['review']>): void;
  completionResponse(decision: QuoteCompletionSummary['response']['decision'],corrections?: string,action?: 'close' | 'reopen',pending?: boolean): void;
}
declare global { interface Window { __quoteSignoff: QuoteSignoffBrowserFixture } }
window.__quoteSignoff = { calls, release: key => {
  if (key) { deferredReads.get(key)?.(); deferredReads.delete(key); }
  else { releasePending?.(); releasePending = undefined; }
}, dispose: () => panel.dispose(),
  remount: () => { panel.dispose(); panel = mountQuoteSignoffPanel({host:document.getElementById('root')!,conn,document,reminders}); },
  prepareFailure: mode => {prepareFailure = mode;},linkStatus: mode => {linkStatus = mode;},deferNext: (method,key) => {deferredMethod = method;deferredKey = key;},update: () => panel.update(),
  failPublish: mode => { publishFailure = mode; }, setQuoteRoster: mode => { quoteRoster = mode; },
  failResume: value => {resumeFailure=value;},
  quoteResponse: (decision,reason,pending) => {
    listed=true;signoff.state=pending?'waiting':decision==='accepted'?'accepted':'rejected';signoff.endpoint_id='ep-1';
    signoff.response={decision,received_at:Date.now(),recorded_at:pending?null:Date.now(),...(reason?{reason}:{})};panel.update();
  },
  failCompletion: value => { completionError = value; },
  setCompletionReview: value => { completions[0]!.review = value; panel.update(); },
  completionResponse: (decision,corrections,action,pending) => {
    const entry = completions[0]!;entry.state = pending ? 'waiting' : action === 'close' ? 'closed' : action === 'reopen' ? 'reopened' : decision === 'corrections_requested' ? 'corrections_requested' : 'accepted';
    entry.response = { decision,received_at: Date.now(),recorded_at: pending ? null : Date.now(),...(corrections ? { corrections } : {}) };
    entry.review = action ? 'closed' : pending ? 'not_queued' : 'waiting';entry.owner_action = action ? { action,recorded_at: 4 } : null;panel.update();
  },
  failReceipt: value => { receiptError = value; }, receiptMode: value => { receiptMode = value; },
  failSignoffList: message => { signoffListError = message; },failCancel: value => { cancelError = value; },
  setReview: (state) => { listed = true; signoff.state = 'accepted'; signoff.endpoint_id = 'ep-1'; signoff.release_review = state; panel.update(); } };
