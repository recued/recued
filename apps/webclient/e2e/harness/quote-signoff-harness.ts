/** The shipped form in a browser with deterministic RPC responses. Server,
 * public-link and gate semantics are tested by quote-signoff-workflow.test.ts. */
import type { QuoteSignoffPrepareInput, QuoteSignoffSummary } from '@recued/contracts';
import { mountQuoteSignoffPanel, type QuoteSignoffConn } from '../../src/reception/quote-signoff-panel.js';

const params = new URLSearchParams(location.search);
const signoff: QuoteSignoffSummary = {
  signoff_id: 'a1fecd4e-42ce-42a2-b7e7-731ce51a01b2', quote_id: 'Q1', quote_version: 2, quote_revision: 3,
  quote_label: 'Drawings', customer: 'Morgan', amount: '120.0000', currency: 'GBP', net: '100.0000', vat_amount: '20.0000',
  scope: 'Three drawings.', task_title: 'Draw the plans', invoice_ref: 'INV-101', issued_on: '2026-10-11', due_on: '2026-11-10',
  state: 'draft', availability: 'current', created_at: 1, expires_at: 86_400_001,
  endpoint_id: null, responded_at: null, released_at: null, task_id: null, invoice_id: null,
};
let listed = false;
let releasePending: (() => void) | undefined;
const calls: Array<{ method: string; payload: unknown }> = [];
// This transport substitute is deliberately limited to the five owner RPCs.
const conn = (async (method: string, payload?: unknown) => {
  calls.push({ method, payload: structuredClone(payload) });
  if (params.get('defer') === method.split('.').at(-1)) {
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
  throw new Error(`Unexpected RPC: ${method}`);
}) as QuoteSignoffConn;

const panel = mountQuoteSignoffPanel({ host: document.getElementById('root')!, conn, document });
export interface QuoteSignoffBrowserFixture {
  calls: typeof calls;
  release(): void;
  dispose(): void;
  setReview(state: NonNullable<QuoteSignoffSummary['release_review']>): void;
}
declare global { interface Window { __quoteSignoff: QuoteSignoffBrowserFixture } }
window.__quoteSignoff = { calls, release: () => { releasePending?.(); releasePending = undefined; }, dispose: panel.dispose,
  setReview: (state) => { listed = true; signoff.state = 'accepted'; signoff.endpoint_id = 'ep-1'; signoff.release_review = state; panel.update(); } };
