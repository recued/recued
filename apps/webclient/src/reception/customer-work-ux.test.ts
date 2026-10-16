import { describe, it, expect } from 'vitest';
import { customerWorkReturnHash, parseLogsRunAddress, parseShellRoute, serializeLogsRunAddress } from '../shell/route.js';
import { customerInvoiceRecordAddress, parseRecordsRecordAddress } from '../data/records-navigation.js';
import { setCustomerReviewLink } from './customer-review-link.js';
import { customerFinancialDocumentHtml, type CustomerFinancialDocument } from './customer-financial-document.js';
describe('Customer workflow address boundaries', () => {
    it.each(['#reception/jobs/job%2Fa/billing', '#reception/accounts', '#reception/signoffs/request%2Fa'])('preserves the exact run and valid return %s', returnToReception => {
        const hash = serializeLogsRunAddress({ runId: 'run/a #1', returnToReception });
        expect(parseLogsRunAddress(parseShellRoute(hash))).toEqual({ runId: 'run/a #1', returnToReception });
    });
    it.each(['https://example.test/', '#mail', '#reception/endpoints/private', '#reception/jobs/x/billing/extra', '#reception/accounts/x'])('rejects an unrelated return %s', hash => {
        expect(customerWorkReturnHash(hash)).toBeUndefined();
        expect(serializeLogsRunAddress({ runId: 'exact', returnToReception: hash })).toBe('#logs/exact');
    });
    it('fails malformed return tails rather than selecting a partial customer route', () => {
        expect(parseLogsRunAddress(parseShellRoute('#logs/exact/return/reception/jobs/x/extra'))).toBeNull();
    });
    it('uses the authoritative run only and does not offer a generic Runs handoff', () => {
        const attrs = new Map<string, string>();
        const link = { hidden: true, setAttribute: (k: string, v: string) => attrs.set(k, v), removeAttribute: (k: string) => attrs.delete(k) } as unknown as HTMLElement;
        const doc = { defaultView: { location: { hash: '#reception/jobs/job-1/billing' } } } as Document;
        setCustomerReviewLink(doc, link, 'saved-anchor', '#reception/accounts');
        expect(attrs.get('href')).toBe('#logs/saved-anchor/return/reception/jobs/job-1/billing');
        expect(link.hidden).toBe(false);
        setCustomerReviewLink(doc, link, undefined, '#reception/accounts');
        expect(link.hidden).toBe(true);
        expect(attrs.has('href')).toBe(false);
    });
    it('qualifies exact invoice records by owner and kind', () => {
        const hash = customerInvoiceRecordAddress('invoice/a');
        expect(parseRecordsRecordAddress(parseShellRoute(hash))).toEqual({ owner: { publisher: 'recued-core', pack_slug: 'invoice-book' }, entity: 'invoice', id: 'invoice/a' });
        expect(parseRecordsRecordAddress(parseShellRoute('#data/records/recued-core/invoice-book/invoice'))).toBeNull();
    });
});
describe('Compact financial copies', () => {
    it('retains exact decimal strings, separate refund obligations and safe canonical detail', () => {
        const model: CustomerFinancialDocument = { identity: 'Morgan <script>alert(1)</script>', balances: [{ currency: 'GBP', fields: [['Customer still owes', '99.8766'], ['Refund still owed', '5.0000']] }], invoices: [{ invoice: 'INV-1', job: 'Drawing', due: '2026-10-31', total: '120.0000', paid: '20.1234', outstanding: '99.8766', currency: 'GBP' }], lines: ['Every canonical line <img src=x>', '20.1234 GBP paid'] };
        const html = customerFinancialDocumentHtml(model);
        expect(html).toContain('<table>');
        expect(html).toContain('<dl>');
        expect(html).toContain('<details open>');
        for (const exact of ['99.8766', '5.0000', '120.0000', '20.1234'])
            expect(html).toContain(exact);
        expect(html).toContain('Refund still owed');
        expect(html).toContain('Every canonical line &lt;img');
        expect(html).not.toContain('<script>');
        expect(html).not.toContain('<img');
        expect(html).not.toContain('href=');
    });
});
