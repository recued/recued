import type { Conn,ServerRpcRegistry,QuotePaymentReminderTarget,QuoteSignoffSummary } from '@recued/contracts';
import { mountCustomerReminders,type CustomerReminderOptions,type CustomerReminderRequest } from './customer-reminders.js';

export type QuotePaymentReminderConn = Conn<Pick<ServerRpcRegistry,
  'reception.signoff.payment.reminders.get' | 'reception.signoff.payment.reminders.set'
  | 'reception.signoff.payment.reminders.list' | 'reception.signoff.payment.reminders.draft'>>;
export type QuotePaymentReminderOptions = CustomerReminderOptions;
const request = (invoice: QuotePaymentReminderTarget): CustomerReminderRequest => ({
  request_id: invoice.signoff_id,customer: invoice.customer,quote_label: invoice.quote_label,quote_reference: invoice.invoice_ref,
  ...(invoice.invoice.availability === 'current'
    ? { detail: `${invoice.invoice.outstanding} ${invoice.currency} recorded outstanding · due ${invoice.invoice.due_on}` } : {}),
});
export const mountQuotePaymentReminders = (opts: QuotePaymentReminderOptions & {
  host: HTMLElement;document: Document;conn: QuotePaymentReminderConn;
}) => {
  const mounted = mountCustomerReminders({ ...opts,kind: 'payment',api: {
    get: async ({ request_id }) => { const reminder = await opts.conn('reception.signoff.payment.reminders.get',{ signoff_id: request_id });
      return { ...reminder,...(reminder.account_follow_up ? { notice: 'An account follow-up is handling this invoice. Pause that follow-up, or resolve its unknown email outcome in Mail, before using invoice reminders.' } : {}) }; },
    set: ({ request_id,share_url: _link,...settings }) => opts.conn('reception.signoff.payment.reminders.set',{ ...settings,signoff_id: request_id }),
    draft: ({ request_id,expected_revision }) => opts.conn('reception.signoff.payment.reminders.draft',{ signoff_id: request_id,expected_revision }),
    list: async input => { const { reminders,...page } = await opts.conn('reception.signoff.payment.reminders.list',input);
      return { ...page,reminders: reminders.map(({ invoice,reminder }) => ({ request: request(invoice),reminder })) }; },
  } });
  return { ...mounted,open: (invoice: QuoteSignoffSummary,onClosed?: () => void) => mounted.open(request({
    ...invoice,invoice: invoice.follow_up?.invoice ?? { availability: 'unavailable' },
  }),onClosed) };
};
