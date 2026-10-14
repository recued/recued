/** The shipped form in a browser with deterministic RPC responses. Server,
 * public-link and gate semantics are tested by quote-signoff-workflow.test.ts. */
import type { QuoteSignoffPrepareInput, QuoteSignoffSummary, QuoteSignoffReceipt, QuoteCompletionSummary, QuoteCompletionPrepareInput } from '@recued/contracts';
import { mountQuoteSignoffPanel, type QuoteSignoffConn } from '../../src/reception/quote-signoff-panel.js';

const params = new URLSearchParams(location.search);
const signoff: QuoteSignoffSummary = {
  signoff_id: 'a1fecd4e-42ce-42a2-b7e7-731ce51a01b2', quote_id: 'Q1', quote_version: 2, quote_revision: 3,
  quote_label: 'Drawings', customer: 'Morgan', amount: '120.0000', currency: 'GBP', net: '100.0000', vat_amount: '20.0000',
  scope: 'Three drawings.', task_title: 'Draw the plans', invoice_ref: 'INV-101', issued_on: '2026-10-11', due_on: '2026-11-10',
  state: 'draft', availability: 'current', created_at: 1, expires_at: 86_400_001,
  endpoint_id: null, responded_at: null, released_at: null, task_id: null, invoice_id: null,
};
let listed = params.has('completion');
if (listed) Object.assign(signoff,{ state: 'released',released_at: 1,task_id: `quote_signoff_${signoff.signoff_id}`,invoice_id: `quote_signoff_${signoff.signoff_id}`,
  can_request_completion: true,can_add_work: true,follow_up: { checked_at: 1,task: { availability: 'current',title: signoff.task_title,done: false },
    invoice: { availability: 'current',status: 'open',amount_paid: '0.0000',outstanding: signoff.amount,due_on: signoff.due_on,overdue: false } } });
let completionError = false;
const completions: QuoteCompletionSummary[] = [];

let releasePending: (() => void) | undefined;
let receiptError = false;
const calls: Array<{ method: string; payload: unknown }> = [];
// This transport substitute is deliberately limited to this owner's sign-off RPCs.
const conn = (async (method: string, payload?: unknown) => {
  calls.push({ method, payload: structuredClone(payload) });
  if (params.get('defer') === method || params.get('defer') === method.split('.').at(-1)) {
    await new Promise<void>((resolve) => { releasePending = resolve; });
  }
  if (method === 'reception.signoff.quotes') return { quotes: [
    { id: 'Q1', label: 'Drawings', customer: 'Morgan', amount: '120', currency: 'GBP', revision: 3 },
  ], truncated: false };
  if (method === 'reception.signoff.list') return { signoffs: listed ? [structuredClone(signoff)] : [], truncated: false };
  if (method === 'reception.signoff.prepare') {
    const input = payload as QuoteSignoffPrepareInput;
    Object.assign(signoff, { state: 'draft', scope: input.scope, task_title: input.task_title, invoice_ref: input.invoice_ref }); listed = true;
    return { signoff: structuredClone(signoff), preview_hash: 'b'.repeat(64),
      customer_preview: `Quote Q-1 — Morgan\nRevision 3\n120.0000 GBP total\n\n${input.scope}` };
  }
  if (method === 'reception.signoff.publish') {
    signoff.state = 'waiting'; signoff.endpoint_id = 'ep-1';
    return { signoff: structuredClone(signoff), share_url: 'https://studio.example.test/r/signoff/fixture-token' };
  }
  if (method === 'reception.signoff.cancel') { signoff.state = 'cancelled'; return structuredClone(signoff); }
  if (method.startsWith('reception.signoff.completion.')) {
    if (completionError) throw new Error('Completion unavailable. Try again.');
    if (method.endsWith('.list')) {
      const input = payload as { review_only?: boolean } | undefined;
      return { completions: structuredClone(input?.review_only ? completions.filter(entry => ['accepted','corrections_requested'].includes(entry.state)) : completions) };
    }
    if (method.endsWith('.prepare')) {
      const input = payload as QuoteCompletionPrepareInput;
      const completion: QuoteCompletionSummary = { completion_id: 'b1fecd4e-42ce-42a2-b7e7-731ce51a01b2',signoff_id: signoff.signoff_id,
        root_signoff_id: signoff.signoff_id,business_name: 'Studio',customer: signoff.customer,quote_label: signoff.quote_label,
        agreed_scope: signoff.scope,delivery_summary: input.delivery_summary,
        customer_preview: `Completion for Q-1 — Morgan\n\nAgreed scope:\n${signoff.scope}\n\nDelivered work:\n${input.delivery_summary}`,
        state: 'draft',availability: 'current',created_at: 1,expires_at: 86_400_001,endpoint_id: null,
        response: { decision: 'not_recorded',received_at: null,recorded_at: null },owner_action: null };
      completions.splice(0,completions.length,completion);return { completion: structuredClone(completion),preview_hash: 'c'.repeat(64),customer_preview: completion.customer_preview };
    }
    const completion = completions[0]!;
    if (method.endsWith('.publish')) { completion.state = 'waiting';completion.endpoint_id = 'ep-completion';
      return { completion: structuredClone(completion),share_url: 'https://studio.example.test/r/completion/fixture-token' }; }
    if (method.endsWith('.cancel')) { completion.state = 'cancelled';return structuredClone(completion); }
  }
  if (method === 'reception.signoff.receipt') {
    if (receiptError) throw new Error('Receipt unavailable. Try again.');
    const receipt: QuoteSignoffReceipt = { format: 'recued.customer-signoff-receipt', version: 1,
      captured_at: Date.parse('2026-10-13T22:00:00Z'), selected_signoff_id: signoff.signoff_id, root_signoff_id: signoff.signoff_id,
      requests: [{ signoff_id: signoff.signoff_id, parent_signoff_id: null, revision: 0, business_name: 'Studio', customer: signoff.customer,
        quote_label: signoff.quote_label, quote_reference: 'Q-1', quote_revision: signoff.quote_revision,
        amount: signoff.amount, net: signoff.net, vat_amount: signoff.vat_amount, currency: signoff.currency, scope: signoff.scope,
        customer_preview: `Quote Q-1 — Morgan\nRevision 3\n120.0000 GBP total\n\n${signoff.scope}`,
        offer_text_source: params.has('legacy_receipt') ? 'reconstructed' : 'saved',
        state: signoff.state, prepared_at: signoff.created_at, expires_at: signoff.expires_at,
        response: { decision: signoff.state === 'accepted' ? 'accepted' : 'not_recorded', received_at: null, recorded_at: null }, release: null }] };
    if (completions.length) {
      receipt.version = 2;receipt.completions = completions.map(({ availability: _a,review: _r,endpoint_id: _e,...entry }) => ({ ...structuredClone(entry),response: { decision: entry.response.decision,received_at: entry.response.received_at,recorded_at: entry.response.recorded_at } }));
    }
    // Prove the document renderer projects fields instead of serializing the transport object.
    Object.assign(receipt, { private_notes: 'PRIVATE margin', share_url: 'PRIVATE fixture-token' });
    if (params.has('bad_receipt_version')) Object.assign(receipt, { version: 3 });
    return receipt;
  }
  throw new Error(`Unexpected RPC: ${method}`);
}) as QuoteSignoffConn;

const panel = mountQuoteSignoffPanel({ host: document.getElementById('root')!, conn, document });
export interface QuoteSignoffBrowserFixture {
  calls: typeof calls;
  release(): void;
  dispose(): void;
  setReview(state: NonNullable<QuoteSignoffSummary['release_review']>): void;
  failReceipt(value: boolean): void;
  failCompletion(value: boolean): void;
  completionResponse(decision: QuoteCompletionSummary['response']['decision'],corrections?: string,action?: 'close' | 'reopen'): void;
}
declare global { interface Window { __quoteSignoff: QuoteSignoffBrowserFixture } }
window.__quoteSignoff = { calls, release: () => { releasePending?.(); releasePending = undefined; }, dispose: panel.dispose,
  failCompletion: value => { completionError = value; },
  completionResponse: (decision,corrections,action) => {
    const entry = completions[0]!;entry.state = action === 'close' ? 'closed' : action === 'reopen' ? 'reopened' : decision === 'corrections_requested' ? 'corrections_requested' : 'accepted';
    entry.response = { decision,received_at: 2,recorded_at: 3,...(corrections ? { corrections } : {}) };
    entry.review = action ? 'closed' : 'waiting';entry.owner_action = action ? { action,recorded_at: 4 } : null;panel.update();
  },
  failReceipt: value => { receiptError = value; },
  setReview: (state) => { listed = true; signoff.state = 'accepted'; signoff.endpoint_id = 'ep-1'; signoff.release_review = state; panel.update(); } };
