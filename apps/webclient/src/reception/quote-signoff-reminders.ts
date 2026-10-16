import type { Conn,ServerRpcRegistry } from '@recued/contracts';
import { mountCustomerReminders,type CustomerReminderOptions } from './customer-reminders.js';

export type QuoteSignoffReminderConn = Conn<Pick<ServerRpcRegistry,
  'reception.signoff.reminders.get' | 'reception.signoff.reminders.set'
  | 'reception.signoff.reminders.list' | 'reception.signoff.reminders.draft'>>;
export type QuoteSignoffReminderOptions = CustomerReminderOptions;
export const mountQuoteSignoffReminders = (opts: QuoteSignoffReminderOptions & {
  host: HTMLElement;document: Document;conn: QuoteSignoffReminderConn;
}) => { const mounted = mountCustomerReminders({ ...opts,kind: 'offer',api: {
  get: ({ request_id }) => opts.conn('reception.signoff.reminders.get',{ signoff_id: request_id }),
  set: ({ request_id,...settings }) => opts.conn('reception.signoff.reminders.set',{ ...settings,signoff_id: request_id }),
  draft: ({ request_id,expected_revision }) => opts.conn('reception.signoff.reminders.draft',{ signoff_id: request_id,expected_revision }),
  list: async input => { const { reminders,...page } = await opts.conn('reception.signoff.reminders.list',input);
    return { ...page,reminders: reminders.map(({ signoff,reminder }) => ({ request: { ...signoff,request_id: signoff.signoff_id },reminder })) }; },
} });
  return { ...mounted,open: (request: import('@recued/contracts').QuoteSignoffSummary) => mounted.open({ ...request,request_id: request.signoff_id }) };
};
