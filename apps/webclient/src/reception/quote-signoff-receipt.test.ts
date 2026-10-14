import { describe, expect, it } from 'vitest';
import type { QuoteSignoffReceipt } from '@recued/contracts';
import { signoffReceiptHtml } from './quote-signoff-receipt.js';

const sample = (): QuoteSignoffReceipt => ({
  format: 'recued.customer-signoff-receipt', version: 1, captured_at: 1_700_000_000_000,
  selected_signoff_id: 'request-1', root_signoff_id: 'request-1', requests: [{
    signoff_id: 'request-1', parent_signoff_id: null, revision: 0, business_name: 'Studio', customer: 'Morgan',
    quote_label: 'Drawings', quote_reference: 'Q-1', quote_revision: 3, scope: 'Three drawings.',
    amount: '120.1234', net: '100.1234', vat_amount: '20.0000', currency: 'GBP',
    customer_preview: 'Quote Q-1 — Morgan\nRevision 3\n120.1234 GBP total\n\nThree drawings.',
    offer_text_source: 'saved', state: 'cancelled', prepared_at: 1_699_000_000_000, expires_at: 1_701_000_000_000,
    response: { decision: 'accepted', received_at: 1_699_001_000_000, recorded_at: 1_699_001_001_000 }, release: null,
  }],
});

describe('shareable sign-off receipt document', () => {
  it('shows the captured offer and separate reply/release facts with exact decimals and UTC times', () => {
    const html = signoffReceiptHtml(sample());
    expect(html).toContain('120.1234 GBP total'); expect(html).toContain('Net 100.1234');
    expect(html).toContain('Cancelled'); expect(html).toContain('Customer accepted');
    expect(html).toContain('Owner release not recorded'); expect(html).toContain(' UTC');
    expect(html).not.toContain('paid'); expect(html).not.toContain('Task:');
  });

  it.each(['<img src=x onerror=alert(1)>', '</pre><script>window.top.location="https://evil.test"</script>',
    '<iframe src="https://evil.test"></iframe>', 'A & B "quotes" \'apostrophes\''])('escapes hostile saved text: %s', payload => {
    const receipt = sample();
    const entry = receipt.requests[0]!;
    entry.customer = payload; entry.business_name = payload; entry.quote_reference = payload;
    entry.customer_preview = payload;
    const html = signoffReceiptHtml(receipt);
    expect(html).not.toContain(payload);
    expect(html).not.toMatch(/<(?:script|img|iframe)\b/);
    expect(html).toContain("default-src 'none'"); expect(html).toContain("base-uri 'none'");
  });

  it('projects only printable fields even when the RPC object carries extra private keys', () => {
    const receipt = sample();
    Object.assign(receipt, { share_url: 'PRIVATE bearer', visitor_email: 'PRIVATE email' });
    Object.assign(receipt.requests[0]!, { note: 'PRIVATE quote notes', plan_json: 'PRIVATE plan' });
    expect(signoffReceiptHtml(receipt)).not.toContain('PRIVATE');
  });

  it.each(['not_recorded', 'unavailable', 'declined'] as const)('does not turn %s into an acceptance', decision => {
    const receipt = sample(); receipt.requests[0]!.response.decision = decision;
    const html = signoffReceiptHtml(receipt); expect(html).not.toContain('Customer accepted');
    expect(html).toContain(decision === 'declined' ? 'Customer declined' : decision === 'unavailable' ? 'Customer reply unavailable' : 'No customer reply recorded');
  });

  it('prints each ancestral owner release separately', () => {
    const receipt = sample(); const original = receipt.requests[0]!;
    original.state = 'released';
    original.release = { recorded_at: receipt.captured_at, invoice_ref: 'INV-101', issued_on: '2023-11-01', due_on: '2023-12-01' };
    receipt.requests.push({ ...original, signoff_id: 'request-2', parent_signoff_id: original.signoff_id,
      revision: 1, amount: '25.0000', customer_preview: 'Added work', release: { ...original.release, invoice_ref: 'INV-102' } });
    receipt.selected_signoff_id = 'request-2';
    const html = signoffReceiptHtml(receipt);
    expect(html).toContain('Original offer'); expect(html).toContain('Added work 1');
    expect(html).toContain('Owner released work and invoice INV-101');
    expect(html).toContain('Owner released work and invoice INV-102');
  });

  it('escapes a malformed revision instead of inserting active document markup', () => {
    const receipt = sample(); const payload = '<style>body{display:none}</style>';
    Object.assign(receipt.requests[0]!, { revision: payload });
    const html = signoffReceiptHtml(receipt);
    expect(html).not.toContain(payload); expect(html).toContain('&lt;style&gt;body{display:none}&lt;/style&gt;');
  });

  it('falls back to the quote label for an empty reference', () => {
    const receipt = sample(); receipt.requests[0]!.quote_reference = '';
    expect(signoffReceiptHtml(receipt)).toContain('Quote Drawings');
  });

  it('marks reconstructed older offer text on the offline copy', () => {
    const receipt = sample(); receipt.requests[0]!.offer_text_source = 'reconstructed';
    expect(signoffReceiptHtml(receipt)).toContain('Offered terms (rebuilt from saved terms)');
  });

  it.each(['accepted', 'rejected'] as const)('does not infer a customer decision from the %s status', state => {
    const receipt = sample(); const entry = receipt.requests[0]!;
    entry.state = state; entry.response.decision = 'unavailable';
    const html = signoffReceiptHtml(receipt);
    expect(html).toContain('Reply processed'); expect(html).toContain('Customer reply unavailable');
    expect(html).not.toContain('Customer accepted'); expect(html).not.toContain('Customer declined');
  });

  it('does not describe a received, pending reply as waiting for the customer', () => {
    const receipt = sample(); const entry = receipt.requests[0]!;
    entry.state = 'waiting'; entry.response.recorded_at = null;
    const html = signoffReceiptHtml(receipt);
    expect(html).toContain('Customer accepted'); expect(html).not.toContain('Waiting for customer');
    expect(html).toContain('Owner release not recorded');
  });
});
