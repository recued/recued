import { customerInvoiceRecordAddress } from '../data/records-navigation.js';
import { customerJobPaymentStatementLines, customerAccountStatementLines, customerAccountPaymentReceiptLines, customerPaymentReceiptLines, type CustomerJobPaymentStatement, type CustomerAccountStatement, type CustomerAccountPaymentReceipt, type CustomerPaymentReceipt } from '@recued/contracts';
export interface CustomerFinancialDocument {
    amountLabel?: string;
    identity: string;
    balances: Array<{
        currency: string;
        fields: Array<[
            string,
            string
        ]>;
    }>;
    invoices: Array<{
        recordId?: string;
        invoice: string;
        job: string;
        due: string;
        total: string;
        paid: string;
        outstanding: string;
        currency: string;
    }>;
    lines: string[];
}
const jobInvoices = (job: CustomerJobPaymentStatement) => job.invoices.map(i => ({ recordId: i.invoice_id, invoice: i.invoice_ref, job: job.quote_label, due: i.due_on, total: i.total, paid: i.amount_paid, outstanding: i.outstanding, currency: job.currency }));
export const jobStatementDocument = (job: CustomerJobPaymentStatement): CustomerFinancialDocument => ({
    identity: `${job.business_name} · ${job.customer} · ${job.quote_label}`,
    balances: [{ currency: job.currency, fields: [['Total invoiced', job.invoiced_total], ['Recorded paid', job.amount_paid], ['Customer still owes', job.outstanding], ...(job.refund_due !== undefined ? [['Refund still owed', job.refund_due] as [
                        string,
                        string
                    ]] : [])] }],
    invoices: jobInvoices(job), lines: customerJobPaymentStatementLines(job),
});
export const accountStatementDocument = (account: CustomerAccountStatement): CustomerFinancialDocument => ({
    identity: `${account.business_name} · ${account.customer} · ${account.jobs.length} linked jobs`,
    balances: account.balances.map(b => ({ currency: b.currency, fields: [['Total invoiced', b.invoiced_total], ['Recorded paid', b.amount_paid], ['Invoice credits', b.amount_credited], ['Customer still owes', b.outstanding], ['Refund still owed', b.refund_due]] })),
    invoices: account.jobs.flatMap(jobInvoices), lines: customerAccountStatementLines(account),
});
export const accountPaymentDocument = (copy: CustomerAccountPaymentReceipt): CustomerFinancialDocument => ({
    amountLabel:'Allocation',
    identity: `${copy.payment.business_name} · ${copy.payment.customer} · Received ${copy.payment.received_on}`,
    balances: [{ currency: copy.payment.currency, fields: [['Originally recorded payment', copy.payment.amount], ['Current recorded allocations', copy.current_allocated]] }],
    invoices: copy.allocations.map(a => ({ recordId: a.invoice_id, invoice: a.invoice_ref, job: a.job_id, due: '—', total: a.amount, paid: a.current_paid, outstanding: a.current_outstanding, currency: copy.payment.currency })),
    lines: customerAccountPaymentReceiptLines(copy),
});
export const paymentReceiptDocument = (copy: CustomerPaymentReceipt): CustomerFinancialDocument => ({
    identity: `${copy.business_name} · ${copy.customer} · ${copy.invoice_ref}`,
    balances: [{ currency: copy.currency, fields: [['Recorded payment', copy.payment.amount], ['Received on', copy.payment.received_on], ['Recorded paid', copy.amount_paid], ['Customer still owes', copy.outstanding], ...(copy.refund_due !== undefined ? [['Refund still owed', copy.refund_due] as [
                        string,
                        string
                    ]] : [])] }],
    invoices: [], lines: customerPaymentReceiptLines(copy),
});
export const CUSTOMER_FINANCIAL_DOCUMENT_STYLES = `
[data-customer-financial-document]{display:grid;gap:18px;min-width:0;overflow-wrap:anywhere}
[data-customer-financial-document] .financial-balances{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:12px}
[data-customer-financial-document] .financial-balance{border:1px solid var(--border,#ddd);border-radius:10px;padding:16px;min-width:0}
[data-customer-financial-document] h4{margin:0 0 12px}[data-customer-financial-document] dl{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;margin:0}
[data-customer-financial-document] dd{margin:0;font-variant-numeric:tabular-nums}
[data-customer-financial-document] .financial-table{overflow-x:auto;max-width:100%;min-width:0}
[data-customer-financial-document] table{width:100%;min-width:720px;border-collapse:collapse;text-align:left;font-size:14px}
[data-customer-financial-document] th,[data-customer-financial-document] td{padding:10px;border-bottom:1px solid var(--border,#ddd);vertical-align:top}
[data-customer-financial-document] th{white-space:nowrap}[data-customer-financial-document] caption{text-align:left;margin-bottom:8px}
[data-customer-financial-document] td:not(:last-child){white-space:nowrap;font-variant-numeric:tabular-nums}
[data-customer-financial-document] td:last-child{min-width:120px;overflow-wrap:break-word}
.financial-ledger-hint{font-size:13px;color:var(--fg-muted)}@media(min-width:760px){.financial-ledger-hint{display:none}}
[data-customer-financial-document] summary{cursor:pointer;font-weight:600}[data-customer-financial-document] p{margin:8px 0;white-space:pre-wrap}
@media print{[data-customer-financial-document] .financial-table{overflow:visible}[data-customer-financial-document] details{break-before:auto}}
`;
/** Summary and ledger are projections of the same exact, customer-visible copy. */
export const renderCustomerFinancialDocument = (doc: Document, host: HTMLElement, model: CustomerFinancialDocument, expandHistory = false) => {
    const add = (tag: string, text: string, parent: HTMLElement) => { const node = doc.createElement(tag); node.textContent = text; parent.appendChild(node); return node; };
    const root = add('div', '', host);
    root.setAttribute('data-customer-financial-document', '');
    add('p', model.identity, root);
    const cards = add('div', '', root);
    cards.className = 'financial-balances';
    for (const balance of model.balances) {
        const card = add('section', '', cards);
        card.className = 'financial-balance';
        add('h4', balance.currency, card);
        const dl = add('dl', '', card);
        for (const [label, value] of balance.fields) {
            add('dt', label, dl);
            add('dd', value, dl);
        }
    }
    if (model.invoices.length) {
        const hint=add('p','Scroll horizontally to see all invoice columns.',root);hint.className='financial-ledger-hint';
        const wrap = add('div', '', root);
        wrap.className = 'financial-table';
        wrap.tabIndex = 0;
        wrap.setAttribute('aria-label', 'Invoice ledger; scroll horizontally for all columns');
        const table = add('table', '', wrap);
        add('caption', 'Invoice ledger', table);
        const thead = add('thead', '', table);
        const head = add('tr', '', thead);
        for (const label of ['Invoice','Outstanding','Currency',model.amountLabel ?? 'Total','Paid','Due','Job']) {
            const th = add('th', label, head);
            th.setAttribute('scope', 'col');
        }
        const body = add('tbody', '', table);
        for (const i of model.invoices) {
            const row = add('tr', '', body);
            const cell = add('td', '', row);
            if (i.recordId) {
                const link = add('a', i.invoice, cell);
                link.setAttribute('href', customerInvoiceRecordAddress(i.recordId));
            }
            else
                cell.textContent = i.invoice;
            for (const value of [i.outstanding,i.currency,i.total,i.paid,i.due,i.job])
                add('td', value, row);
        }
    }
    const details = add('details', '', root) as HTMLDetailsElement;
    details.open = expandHistory;
    add('summary', 'Full statement and transaction history', details);
    for (const line of model.lines)
        add('p', line, details);
    return root;
};
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export const customerFinancialDocumentHtml = (model: CustomerFinancialDocument): string => `<div data-customer-financial-document><p>${escape(model.identity)}</p><div class="financial-balances">${model.balances.map(b => `<section class="financial-balance"><h4>${escape(b.currency)}</h4><dl>${b.fields.map(([k, v]) => `<dt>${escape(k)}</dt><dd>${escape(v)}</dd>`).join('')}</dl></section>`).join('')}</div>${model.invoices.length ? `<div class="financial-table"><table><caption>Invoice ledger</caption><thead><tr>${['Invoice','Outstanding','Currency',model.amountLabel ?? 'Total','Paid','Due','Job'].map(t => `<th scope="col">${escape(t)}</th>`).join('')}</tr></thead><tbody>${model.invoices.map(i => `<tr>${[i.invoice,i.outstanding,i.currency,i.total,i.paid,i.due,i.job].map(v => `<td>${escape(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : ''}<details open><summary>Full statement and transaction history</summary>${model.lines.map(l => `<p>${escape(l)}</p>`).join('')}</details></div>`;
