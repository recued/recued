import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { RECEIVABLE_AGING_BUCKETS,type CustomerReceivablesAging,type CustomerReceivablesAgingInput,
  type CustomerReceivableInvoice,type CustomerReceivablesCurrency,type ReceivableAgingBucket } from '@recued/contracts';
import { QuoteSignoffError,type QuoteSignoffService } from './quote-signoff-service.js';
import type { PreapprovalCodec } from './storage/preapproval-codec.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value,(key,v) => ['captured_at','checked_at'].includes(key) ? undefined : v)).digest('hex');
const invalid = (): never => { throw new QuoteSignoffError('customer_receivables_invalid','Choose an aging view, currency and page size from 1 to 100.',400); };
const stale = (): never => { throw new QuoteSignoffError('customer_receivables_stale','Receivables or the reporting day changed. Refresh aging and start from the first page.'); };
const unavailable = (): never => { throw new QuoteSignoffError('customer_receivables_unavailable','Receivables could not be read completely. Review the saved jobs and billing records.'); };
const money = (value: string): bigint => {
  if (typeof value !== 'string' || !/^\d+\.\d{4}$/.test(value) || value.length > 32) return unavailable();
  return BigInt(value.replace('.',''));
};
const decimal = (value: bigint) => `${value/10_000n}.${String(value%10_000n).padStart(4,'0')}`;
const day = (value: string): number => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return unavailable();
  const n = Date.parse(value+'T00:00:00Z');
  if (!Number.isFinite(n) || new Date(n).toISOString().slice(0,10) !== value) return unavailable();
  return n/86_400_000;
};
const bucketFor = (days: number): ReceivableAgingBucket => days === 0 ? 'current' : days <= 30 ? '1_30' : days <= 60 ? '31_60' : days <= 90 ? '61_90' : '91_plus';

/** Current recorded receivables, read in one synchronous SQLite snapshot.
 * Business calendar dates determine age; elapsed hours and task status do not. */
export const createCustomerReceivablesAgingService = (deps: {
  db: Database.Database;signoffs: QuoteSignoffService;codec: Pick<PreapprovalCodec,'assertUnlocked'>;now: () => number;timeZone: () => string;
}) => ({
  get(input: CustomerReceivablesAgingInput = {}): CustomerReceivablesAging {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['search','currency','bucket','limit','cursor'].includes(key))) invalid();
    const size = input.limit === undefined ? 50 : input.limit;const bucket = input.bucket === undefined ? 'all' : input.bucket;
    if (!Number.isSafeInteger(size) || size < 1 || size > 100 || !['all','needs_review',...RECEIVABLE_AGING_BUCKETS].includes(bucket)
      || input.search !== undefined && (typeof input.search !== 'string' || input.search.length > 200 || input.search.includes('\0'))
      || input.currency !== undefined && (typeof input.currency !== 'string' || !/^[A-Z]{3}$/.test(input.currency))) invalid();
    const search = (input.search ?? '').trim().normalize('NFKC').toLowerCase();const query = hash({ search,currency: input.currency,bucket });
    let cursor: { snapshot: string;after: string } | undefined;
    if (input.cursor !== undefined) {
      try {
        if (typeof input.cursor !== 'string' || input.cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) throw new Error();
        const value: unknown = JSON.parse(Buffer.from(input.cursor,'base64url').toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'after,query,snapshot,v'
          || !('v' in value) || value.v !== 1 || !('query' in value) || value.query !== query
          || !('snapshot' in value) || typeof value.snapshot !== 'string' || !/^[a-f0-9]{64}$/.test(value.snapshot)
          || !('after' in value) || typeof value.after !== 'string' || !/^[a-f0-9-]{36}$/.test(value.after)) throw new Error();
        cursor = { snapshot: value.snapshot,after: value.after };
      } catch { invalid(); }
    }
    deps.codec.assertUnlocked();
    return deps.db.transaction((): CustomerReceivablesAging => {
      const captured_at = deps.now();if (!Number.isSafeInteger(captured_at) || captured_at < 0) return unavailable();
      const time_zone = deps.timeZone();
      const parts = new Intl.DateTimeFormat('en-US',{ timeZone: time_zone,year: 'numeric',month: '2-digit',day: '2-digit' }).formatToParts(captured_at);
      const as_of = ['year','month','day'].map(kind => parts.find(part => part.type === kind)!.value).join('-');const today = day(as_of);
      const source = deps.signoffs.customerJobsSnapshot(() => null,() => null);
      const evaluated_invoices = source.jobs.reduce((n,job) => n+job.invoices.length,0);
      if (evaluated_invoices > 5000) throw new QuoteSignoffError('customer_receivables_limit','There are over 5,000 released job invoices. Review their billing history in Records.');
      const evidence: unknown[] = [];const rows: CustomerReceivableInvoice[] = [];const seen = new Set<string>();
      const liabilities: Array<{ currency: string;customer: string;quote_label: string;quote_reference?: string;invoice_ref: string;amount: bigint }> = [];
      for (const job of source.jobs) for (const invoice of job.invoices) {
        if (seen.has(invoice.signoff_id)) return unavailable();seen.add(invoice.signoff_id);
        const identity = { job_id: job.job_id,signoff_id: invoice.signoff_id,invoice_id: invoice.invoice_id!,invoice_ref: invoice.invoice_ref,
          customer: invoice.customer,quote_label: invoice.quote_label,quote_reference: invoice.quote_reference,currency: invoice.currency };
        const review = (issue: string) => rows.push({ ...identity,availability: 'needs_review',bucket: 'needs_review',issue,due_on: null,days_overdue: null,outstanding: null,refund_due: null });
        if (!job.agreement_available) { evidence.push([identity,'agreement_unavailable']);review('The released agreement chain needs review. This invoice is excluded from totals.');continue; }
        try {
          const history = deps.signoffs.paymentHistorySnapshot(invoice.signoff_id);evidence.push([identity,history.snapshot_hash ?? history]);
          if (history.consistency !== 'matched' || !history.snapshot_hash || history.invoice.availability !== 'current' || history.invoice.status === 'carried_forward') {
            review('The invoice or its payment, credit and refund records need review. This balance is excluded from totals.');continue;
          }
          const balance = history.invoice;const age = Math.max(0,today-day(balance.due_on));
          const amount = money(balance.outstanding);const refund = money(balance.refund_due ?? '0.0000');
          if (refund > 0n) liabilities.push({ ...identity,amount: refund });
          if (amount > 0n) rows.push({ ...identity,availability: 'current',due_on: balance.due_on,days_overdue: age,bucket: bucketFor(age),outstanding: decimal(amount),refund_due: decimal(refund) });
        } catch (error) {
          if (!(error instanceof QuoteSignoffError)) throw error;
          evidence.push([identity,error.code]);review(error.code === 'customer_payment_limit' ? error.message : 'The complete billing record or due date needs review. This balance is excluded from totals.');
        }
      }
      const currencies = [...new Set(source.jobs.flatMap(job => job.invoices.map(invoice => invoice.currency)))].sort();
      const matches = (row: { currency: string;customer: string;quote_label: string;quote_reference?: string;invoice_ref: string }) =>
        (!input.currency || row.currency === input.currency) && (!search || [row.customer,row.quote_label,row.quote_reference ?? '',row.invoice_ref].join('\n').normalize('NFKC').toLowerCase().includes(search));
      const selected = rows.filter(matches);const refunds = liabilities.filter(matches);const review_count = selected.filter(row => row.availability === 'needs_review').length;
      const balances: CustomerReceivablesCurrency[] = [...new Set([...selected.map(row => row.currency),...refunds.map(row => row.currency)])].sort().map(currency => {
        const verified = selected.filter(row => row.currency === currency && row.availability === 'current');
        const buckets = RECEIVABLE_AGING_BUCKETS.map(bucket => { const group = verified.filter(row => row.bucket === bucket);
          return { bucket,amount: decimal(group.reduce((n,row) => n+money(row.outstanding!),0n)),invoice_count: group.length }; });
        const liability = refunds.filter(row => row.currency === currency);
        return { currency,outstanding: decimal(verified.reduce((n,row) => n+money(row.outstanding!),0n)),overdue: decimal(buckets.filter(item => item.bucket !== 'current').reduce((n,row) => n+money(row.amount),0n)),
          invoice_count: verified.length,buckets,refund_due: decimal(liability.reduce((n,row) => n+row.amount,0n)),refund_invoice_count: liability.length };
      });
      rows.sort((a,b) => (a.due_on ?? '9999-99-99').localeCompare(b.due_on ?? '9999-99-99') || a.signoff_id.localeCompare(b.signoff_id));
      const matching = rows.filter(row => matches(row) && (bucket === 'all' || row.bucket === bucket));
      const snapshot_hash = hash({ as_of,time_zone,evidence,rows });if (cursor && cursor.snapshot !== snapshot_hash) stale();
      const start = cursor ? matching.findIndex(row => row.signoff_id === cursor!.after)+1 : 0;if (cursor && start === 0) invalid();
      const page = matching.slice(start,start+size);const last = page.at(-1);deps.codec.assertUnlocked();
      return { format: 'recued.customer-receivables-aging',version: 1,captured_at,as_of,time_zone,snapshot_hash,balances,currencies,rows: page,
        matching_rows: matching.length,review_count,complete: review_count === 0,evaluated_invoices,
        notes: ['Includes all released Customer jobs invoices, including archived jobs and released added work. Other Invoice Book invoices stay in Records.',
          'Current means due today or later. Overdue age uses calendar dates in the server time zone.',
          'These are current recorded balances at capture, not a historical statement or a bank reconciliation.',
          'Totals follow the customer/quote/invoice search and currency before the aging filter or paging. Currencies are never added together.',
          'Needs-review invoices have unknown balances and are excluded from totals. Refunds owed are shown separately and never reduce receivables.'],
        ...(start+size < matching.length && last ? { next_cursor: Buffer.from(JSON.stringify({ v: 1,query,snapshot: snapshot_hash,after: last.signoff_id })).toString('base64url') } : {}) };
    })();
  },
});
export type CustomerReceivablesAgingService = ReturnType<typeof createCustomerReceivablesAgingService>;
