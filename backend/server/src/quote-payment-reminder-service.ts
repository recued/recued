import { accountReminderOwnsInvoice } from './customer-payment-reminder-coordination.js';
import type Database from 'better-sqlite3';
import type { QuotePaymentReminder,QuotePaymentReminderSetInput,QuotePaymentReminderTarget } from '@recued/contracts';
import type { QuoteSignoffService } from './quote-signoff-service.js';
import type { PreapprovalCodec } from './storage/preapproval-codec.js';
import { createCustomerReminderService,type CustomerReminderState } from './customer-reminder-service.js';

export const createQuotePaymentReminderService = (deps: {
  db: Database.Database;signoffs: QuoteSignoffService;codec: PreapprovalCodec;now: () => number;
}) => {
  type Request = ReturnType<QuoteSignoffService['paymentReminderSnapshot']>;
  // A queue page checks each invoice independently. Cover its retained change
  // count without scanning every invoice in the pack for every reminder.
  deps.db.exec(`CREATE INDEX IF NOT EXISTS core_record_outbox_invoice_identity_idx
    ON core_record_outbox(publisher,pack_slug,pk) WHERE kind='invoice'`);
  const invoiceLine = (request: Request) => {
    const invoice = request.follow_up?.invoice;
    if (invoice?.availability !== 'current') return '';
    return `Invoice ${request.invoice_ref}: ${invoice.outstanding} ${request.currency} recorded outstanding; due ${invoice.due_on}.`;
  };
  const service = createCustomerReminderService({ ...deps,kind: 'payment',
    requests: { get: deps.signoffs.paymentReminderSnapshot },identify: request => request.signoff_id,
    current: request => !accountReminderOwnsInvoice(deps.db,request.signoff_id) && request.state === 'released' && request.invoice_id !== null
      && request.follow_up?.invoice.availability === 'current' && request.follow_up.invoice.status === 'open'
      && (!request.follow_up.invoice.refund_due || request.follow_up.invoice.refund_due==='0.0000')
      && request.invoice_fingerprint !== null,
    fingerprint: request => request.invoice_fingerprint,invoiceLine,
    notificationText: request => `${request.customer} — ${request.invoice_ref}. Review the follow-up in Reception → Customer jobs.`,
    message: request => ({
      subject: `Payment reminder: ${request.invoice_ref}`,
      body: `Hello ${request.customer},\n\nOur records show an outstanding balance for ${request.quote_reference ?? request.quote_label}.\n\n${invoiceLine(request)}\n\nIf you have already paid, please let us know so we can check our records.\n\nThank you.`,
    }),
  });
  const reminder = ({ request_id,has_saved_link: _link,draft_stale,...state }: CustomerReminderState): QuotePaymentReminder =>
    ({ signoff_id: request_id,...state,draft_stale: draft_stale ?? false });
  const invoice = (request: Request): QuotePaymentReminderTarget => ({
    signoff_id: request.signoff_id,invoice_id: request.invoice_id,customer: request.customer,quote_label: request.quote_label,
    ...(request.quote_reference ? { quote_reference: request.quote_reference } : {}),
    invoice_ref: request.invoice_ref,currency: request.currency,amount: request.amount,
    invoice: request.follow_up?.invoice ?? { availability: 'unavailable' },
  });
  const facade = { guardSend: service.guardSend,draft: service.draft,
    get: async (id: string) => ({ ...reminder(await service.get(id)),account_follow_up: accountReminderOwnsInvoice(deps.db,id) }),
    set: async ({ signoff_id,...settings }: QuotePaymentReminderSetInput) => reminder(await service.set({ ...settings,request_id: signoff_id })),
    list: async (input: Parameters<typeof service.list>[0] = {}) => { const { reminders,...page } = await service.list(input);
      return { ...page,reminders: reminders.map(item => ({ invoice: invoice(item.request),reminder: reminder(item.reminder) })) }; },
  };
  return Object.assign(facade,{ sweep: (notify: Parameters<typeof service.sweep>[0],isQuiet?: Parameters<typeof service.sweep>[1]) =>
    service.sweep(notify,isQuiet,async id => { const state = await facade.get(id);return { ...state,has_saved_link: false,request_id: state.signoff_id }; }) });
};
export type QuotePaymentReminderService = ReturnType<typeof createQuotePaymentReminderService>;
