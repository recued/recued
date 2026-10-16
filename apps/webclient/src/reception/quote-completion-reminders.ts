import type { Conn,ServerRpcRegistry } from '@recued/contracts';
import { mountCustomerReminders,type CustomerReminderOptions } from './customer-reminders.js';

export type QuoteCompletionReminderConn = Conn<Pick<ServerRpcRegistry,
  'reception.signoff.completion.reminders.get' | 'reception.signoff.completion.reminders.set'
  | 'reception.signoff.completion.reminders.list' | 'reception.signoff.completion.reminders.draft'>>;
export type QuoteCompletionReminderOptions = CustomerReminderOptions;
export const mountQuoteCompletionReminders = (opts: QuoteCompletionReminderOptions & {
  host: HTMLElement;document: Document;conn: QuoteCompletionReminderConn;
}) => { const mounted = mountCustomerReminders({ ...opts,kind: 'completion',api: {
  get: ({ request_id }) => opts.conn('reception.signoff.completion.reminders.get',{ completion_id: request_id }),
  set: ({ request_id,...settings }) => opts.conn('reception.signoff.completion.reminders.set',{ ...settings,completion_id: request_id }),
  draft: ({ request_id,expected_revision }) => opts.conn('reception.signoff.completion.reminders.draft',{ completion_id: request_id,expected_revision }),
  list: async input => { const { reminders,...page } = await opts.conn('reception.signoff.completion.reminders.list',input);
    return { ...page,reminders: reminders.map(({ completion,reminder }) => ({ request: { ...completion,request_id: completion.completion_id },reminder })) }; },
} });
  return { ...mounted,open: (request: import('@recued/contracts').QuoteCompletionSummary, onClosed?: () => void) =>
    mounted.open({ ...request,request_id: request.completion_id }, onClosed) };
};
