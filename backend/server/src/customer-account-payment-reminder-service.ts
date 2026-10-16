import { isCustomerJobArchived } from './storage/customer-job-archive-store.js';
import type Database from 'better-sqlite3';
import { customerAccountPaymentReminderLines,type CustomerAccountStatement,type CustomerAccountPaymentReminder,
  type CustomerAccountPaymentReminderSetInput,type CustomerAccountPaymentReminderListInput,type CustomerAccountPaymentReminderTarget } from '@recued/contracts';
import type { CustomerAccountStatementService } from './customer-account-statement-service.js';
import { createCustomerReminderService,type CustomerReminderRequest,type CustomerReminderState } from './customer-reminder-service.js';
import { assertNoUncertainInvoiceReminders } from './customer-payment-reminder-coordination.js';
import { QuoteSignoffError } from './quote-signoff-service.js';
import type { PreapprovalCodec } from './storage/preapproval-codec.js';

interface Request extends CustomerReminderRequest { account_id: string;statement: CustomerAccountStatement | null;job_count: number }
export const createCustomerAccountPaymentReminderService = (deps: {
  db: Database.Database;accounts: CustomerAccountStatementService;codec: PreapprovalCodec;now: () => number;
}) => {
  deps.db.exec(`CREATE TABLE IF NOT EXISTS customer_account_payment_reminder_invoices (
    reference TEXT NOT NULL,signoff_id TEXT NOT NULL,PRIMARY KEY(reference,signoff_id)
  ); CREATE INDEX IF NOT EXISTS customer_account_payment_reminder_invoices_signoff
    ON customer_account_payment_reminder_invoices(signoff_id);`);
  const core = (request: Request) => request.statement ? customerAccountPaymentReminderLines(request.statement).join('\n') : '';
  const invoiceIds = (request: Request) => request.statement?.jobs.flatMap(job => job.invoices.map(invoice => invoice.signoff_id)) ?? [];
  const service = createCustomerReminderService({ ...deps,kind: 'account_payment',
    requests: { capture: async id => {
      const captured = await deps.accounts.captureForReminder({ account_id: id });
      return (): Request => {
        captured.assertCurrent();let statement: CustomerAccountStatement | null = null;
        try { statement = captured.read(); }
        catch (error) { if (!(error instanceof QuoteSignoffError)) throw error; }
        return { account_id: id,customer: captured.account.customer,quote_label: 'Customer account',
          expires_at: Number.MAX_SAFE_INTEGER,endpoint_id: null,state: 'account',availability: statement ? 'current' : 'unavailable',
          job_count: captured.account.job_ids.length,statement };
      };
    } },
    identify: request => request.account_id,
    current: request => Boolean(request.statement && request.statement.balances.some(balance => balance.outstanding !== '0.0000')
      && request.statement.balances.every(balance => balance.refund_due === '0.0000')
      && request.statement.jobs.every(job => job.outstanding === '0.0000' || !isCustomerJobArchived(deps.db,job.job_id))),
    fingerprint: request => request.statement?.statement_hash ?? null,invoiceLine: core,
    notificationText: request => `${request.customer} — review the account payment follow-up in Reception → Customer jobs → Customer accounts.`,
    message: request => ({ subject: `Account payment reminder: ${request.customer}`,
      body: `Hello ${request.customer},\n\nOur records show unpaid invoices on your account.\n\n${core(request)}\n\nThank you.` }),
    assertReady: (request,reference) => assertNoUncertainInvoiceReminders(deps.db,invoiceIds(request),reference),
    reserveDraft: (request,reference) => {
      const reserve = deps.db.prepare('INSERT OR IGNORE INTO customer_account_payment_reminder_invoices (reference,signoff_id) VALUES (?,?)');
      for (const job of request.statement?.jobs ?? []) for (const invoice of job.invoices) {
        if (invoice.outstanding !== '0.0000') reserve.run(reference,invoice.signoff_id);
      }
    },
  });
  const reminder = ({ request_id,has_saved_link: _link,draft_stale,...state }: CustomerReminderState): CustomerAccountPaymentReminder =>
    ({ account_id: request_id,...state,draft_stale: draft_stale ?? false });
  const account = (request: Request): CustomerAccountPaymentReminderTarget => ({ account_id: request.account_id,customer: request.customer,
    job_count: request.job_count,balances: request.statement?.balances.filter(balance => balance.outstanding !== '0.0000')
      .map(({ currency,outstanding }) => ({ currency,outstanding })) ?? [] });
  const facade = { guardSend: service.guardSend,draft: service.draft,
    get: async (id: string) => reminder(await service.get(id)),
    set: async ({ account_id,...settings }: CustomerAccountPaymentReminderSetInput) => reminder(await service.set({ ...settings,request_id: account_id })),
    list: async (input: CustomerAccountPaymentReminderListInput = {}) => {
      const { reminders,...page } = await service.list(input);
      return { ...page,reminders: reminders.map(item => ({ account: account(item.request),reminder: reminder(item.reminder) })) };
    },
  };
  return Object.assign(facade,{ sweep: (notify: Parameters<typeof service.sweep>[0],isQuiet?: Parameters<typeof service.sweep>[1]) =>
    service.sweep(notify,isQuiet,async id => { const state = await facade.get(id);return { ...state,has_saved_link: false,request_id: state.account_id }; }) });
};
export type CustomerAccountPaymentReminderService = ReturnType<typeof createCustomerAccountPaymentReminderService>;
