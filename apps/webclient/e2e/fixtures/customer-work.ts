import type { CustomerJob, QuoteSignoffSummary, CustomerPaymentHistory, CustomerPaymentReceipt, CustomerJobPaymentStatement, CustomerAccountStatement } from '@recued/contracts';
/** Installed before the real full-app bootstrap. Only deterministic local RPC
 * responses are replaced; production navigation, focus and components run. */
export const installCustomerWorkFixture = () => {
    type Reply = {
        result?: unknown;
        error?: {
            code: string;
            message: string;
        };
    };
    const fixture = window as Window & {
        __receptionFixture?: (method: string, args: unknown) => Promise<Reply | undefined>;
        __customerUxCalls?: Array<{
            method: string;
            args: unknown;
        }>;
        __customerUxHold?: string;
        __customerUxRelease?: () => void;
    };
    const calls: Array<{
        method: string;
        args: unknown;
    }> = [];
    fixture.__customerUxCalls = calls;
    const NOW = Date.parse('2026-10-16T12:00:00Z');
    const hash = 'a'.repeat(64);
    const count = Number(new URLSearchParams(location.search).get('jobs') ?? 6);
    const offer = (n: number): QuoteSignoffSummary => ({
        signoff_id: 'offer-' + n, quote_id: 'Q' + n, quote_label: 'Drawings ' + n, quote_reference: 'Q-' + n, quote_version: 2, quote_revision: 1,
        customer: 'Morgan Studio', amount: '120.0000', net: '100.0000', vat_amount: '20.0000', currency: 'GBP', scope: 'Three drawings.', task_title: 'Deliver drawings',
        invoice_ref: 'INV-' + n, issued_on: '2026-10-01', due_on: '2026-10-10', state: 'released', availability: 'current', created_at: NOW - 86400000, expires_at: NOW + 604800000,
        responded_at: NOW - 80000000, released_at: NOW - 70000000, endpoint_id: 'ep-' + n, task_id: 'task-' + n, invoice_id: 'invoice-' + n, can_request_completion: true,
        follow_up: { checked_at: NOW, task: { availability: 'current', title: 'Deliver drawings', done: false }, invoice: { availability: 'current', status: 'open', amount_paid: '20.1234', outstanding: '99.8766', due_on: '2026-10-10', overdue: true } },
    });
    const jobs: CustomerJob[] = Array.from({ length: count }, (_, i) => {
        const invoice = offer(i + 1);
        return {
            job_id: 'job-' + (i + 1), created_at: NOW - i, customer: invoice.customer, quote_label: invoice.quote_label, quote_reference: invoice.quote_reference, currency: 'GBP',
            agreed_scope: invoice.scope, agreed_total: '120.0000', offer: invoice, agreement: invoice, invoices: [invoice], work: 'in_progress',
            payment: { status: 'part_paid', amount_paid: '20.1234', outstanding: '99.8766', has_unpaid_balance: true, overdue: true }, completion: null, completion_matches_agreement: false,
            offer_reply: 'received', waiting_customer: false, needs_owner_review: i === 1, corrections: false, needs_attention: false, can_request_completion: true,
        };
    });
    if (jobs[0])
        jobs[0].invoices.push({ ...offer(100), quote_id: 'Q1', amount: '15.1234', net: '15.1234', vat_amount: '0.0000', follow_up: { checked_at: NOW, task: { availability: 'current', title: 'Deliver drawings', done: false }, invoice: { availability: 'current', status: 'open', amount_paid: '0.0000', outstanding: '15.1234', due_on: '2026-10-10', overdue: true } } });
    const payment = { payment_id: 'P1', amount: '20.1234', received_on: '2026-10-11', method: 'bank transfer', reference: 'PAY-1' };
    const selected = (id: string) => jobs.flatMap(j => j.invoices).find(i => i.signoff_id === id)!;
    const history = (id: string): CustomerPaymentHistory => { const i = selected(id); return { signoff_id: id, invoice_id: i.invoice_id!, invoice_ref: i.invoice_ref, business_name: 'Studio', customer: i.customer, quote_label: i.quote_label, quote_reference: i.quote_reference, currency: i.currency, total: i.amount, captured_at: NOW, invoice: i.follow_up!.invoice, payments: [payment], consistency: 'matched', snapshot_hash: hash }; };
    const statement = (job: CustomerJob): CustomerJobPaymentStatement => ({ format: 'recued.customer-job-payment-statement', version: 2, captured_at: NOW, statement_hash: hash, job_id: job.job_id, business_name: 'Studio', customer: job.customer, quote_label: job.quote_label, quote_reference: job.quote_reference, currency: 'GBP', invoiced_total: '120.0000', amount_paid: '20.1234', outstanding: '99.8766', invoices: [{ signoff_id: job.offer.signoff_id, invoice_id: job.offer.invoice_id!, invoice_ref: job.offer.invoice_ref, revision: 0, issued_on: '2026-10-01', due_on: '2026-10-10', total: '120.0000', amount_paid: '20.1234', outstanding: '99.8766', payments: [payment] }] });
    const accounts = Array.from({ length: 8 }, (_, i) => ({ account_id: 'account-' + i, revision: 1, customer: i === 0 ? 'Morgan Studio' : 'Customer ' + i, job_ids: jobs.slice(0, 2).map(j => j.job_id), created_at: NOW, updated_at: NOW }));
    fixture.__receptionFixture = async (method, raw) => {
        const args = (raw ?? {}) as Record<string, any>; // Test transport payload; each response below matches its production contract.
        if (!method.startsWith('reception.'))
            return;
        calls.push({ method, args: structuredClone(args) });
        if(new URLSearchParams(location.search).get('customer_fail')===method)return {error:{code:'UNAVAILABLE',message:'Follow-ups unavailable.'}};
        if (fixture.__customerUxHold === method) {
            fixture.__customerUxHold = undefined;
            await new Promise<void>(resolve => { fixture.__customerUxRelease = resolve; });
        }
        try {
            let result: unknown;
            if (method === 'reception.jobs.list') {
                const matches = jobs.filter(j => (!args.search || (j.customer + j.quote_label).toLowerCase().includes(args.search.toLowerCase())) && (!args.filter || args.filter === 'all' || args.filter === 'owner_review' && j.needs_owner_review || args.filter === 'overdue' && j.payment.overdue));
                const start = Number(args.cursor ?? 0);
                result = { captured_at: NOW, jobs: matches.slice(start, start + 50), ...(start + 50 < matches.length ? { next_cursor: String(start + 50) } : {}) };
            }
            else if (method === 'reception.jobs.closeout.get') {
                const job = jobs.find(j => j.job_id === args.job_id) ?? null;
                result = { job_id: args.job_id, captured_at: NOW, job, archive: { job_id: args.job_id, revision: 0, archived_at: null, updated_at: null }, can_archive: false, blockers: ['Finish the open task.', 'Review the unpaid invoice.'], snapshot_hash: hash, reminders: { saved_schedules: 0, uncertain_sends: 1 }, events: [], has_older_events: false };
            }
            else if (method === 'reception.jobs.timeline') {
                result = { job_id: args.job_id, captured_at: NOW, snapshot_hash: hash, job: jobs.find(j => j.job_id === args.job_id), events: Array.from({ length: 50 }, (_, i) => ({ event_id: 'event-' + i, category: 'agreements', kind: 'offer_prepared', title: 'Quote prepared', recorded_at: NOW - i, business_date: null, signoff_id: 'offer-1', details: [] })), total_events: 50, matching_events: 50, billing_available: true, issues: [], notes: [], schedules: [] };
            }
            else if (method === 'reception.accounts.list')
                result = { accounts };
            else if (method === 'reception.accounts.get')
                result = accounts.find(a => a.account_id === args.account_id);
            else if (method === 'reception.accounts.statement') {
                const account = accounts.find(a => a.account_id === args.account_id)!;
                result = { format: 'recued.customer-account-statement', version: 1, captured_at: NOW, statement_hash: hash, account_id: account.account_id, account_revision: 1, business_name: 'Studio', customer: account.customer, jobs: jobs.slice(0, 2).map(statement), balances: [{ currency: 'GBP', invoiced_total: '240.0000', amount_paid: '40.2468', amount_credited: '0.0000', amount_refund_credited: '0.0000', amount_refunded: '0.0000', net_received: '40.2468', outstanding: '199.7532', refund_due: '0.0000' }] } satisfies CustomerAccountStatement;
            }
            else if (method === 'reception.jobs.payment.statement')
                result = statement(jobs.find(j => j.job_id === args.job_id)!);
            else if (method === 'reception.signoff.payment.history')
                result = history(args.signoff_id);
            else if (method === 'reception.signoff.payment.receipt') {
                const h = history(args.signoff_id);
                result = { format: 'recued.customer-payment-receipt', version: 1, captured_at: NOW, receipt_hash: hash, signoff_id: h.signoff_id, invoice_id: h.invoice_id, invoice_ref: h.invoice_ref, business_name: h.business_name, customer: h.customer, quote_label: h.quote_label, quote_reference: h.quote_reference, currency: h.currency, total: h.total, payment, amount_paid: '20.1234', outstanding: '99.8766', due_on: '2026-10-10' } satisfies CustomerPaymentReceipt;
            }
            else if (method.endsWith('.reminders.list'))
                result = { reminders: [] };
            else if (method === 'reception.signoff.invoice.credit.history')
                result = { credits: [] };
            else if (method === 'reception.signoff.refund.history')
                result = { actions: [] };
            else if (method.endsWith('.correction.history'))
                result = { corrections: [] };
            else if (method === 'reception.accounts.contact.get')
                result = { account_id: args.account_id, revision: 0, contact: {} };
            else if (method === 'reception.signoff.quotes')
                result = { quotes: [], truncated: false };
            else if (method === 'reception.signoff.list')
                result = { signoffs: jobs.flatMap(j => j.invoices).filter(i => !args.signoff_id || i.signoff_id === args.signoff_id), truncated: false };
            else if (method === 'reception.signoff.completion.list')
                result = { completions: [] };
            else if (method === 'reception.inbox.list')
                result = { items: [] };
            else
                return;
            return { result };
        }
        catch (error) {
            return { error: { code: 'FIXTURE', message: String(error) } };
        }
    };
};
