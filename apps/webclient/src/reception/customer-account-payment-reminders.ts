import { readCustomerAccountContactDefaults,type CustomerAccountContactDefaultsReadConn } from './customer-account-contact-defaults.js';
import type { Conn,ServerRpcRegistry,CustomerAccount,CustomerAccountPaymentReminderTarget } from '@recued/contracts';
import { mountCustomerReminders,type CustomerReminderOptions,type CustomerReminderRequest } from './customer-reminders.js';

export type CustomerAccountPaymentReminderConn = CustomerAccountContactDefaultsReadConn & Conn<Pick<ServerRpcRegistry,
  'reception.accounts.payment.reminders.get' | 'reception.accounts.payment.reminders.set'
  | 'reception.accounts.payment.reminders.list' | 'reception.accounts.payment.reminders.draft'>>;
const request = (account: CustomerAccountPaymentReminderTarget): CustomerReminderRequest => ({
  request_id: account.account_id,customer: account.customer,quote_label: 'Customer account',
  detail: `${account.job_count} linked jobs · ${account.balances.map(balance => `${balance.outstanding} ${balance.currency} recorded outstanding`).join(' · ')}`,
});
export const mountCustomerAccountPaymentReminders = (opts: CustomerReminderOptions & {
  host: HTMLElement;document: Document;conn: CustomerAccountPaymentReminderConn;onChanged?: () => void;
}) => {
  const mounted = mountCustomerReminders({ ...opts,kind: 'account_payment',
    contactDefaults: id => readCustomerAccountContactDefaults(opts.conn,id),api: {
    get: ({ request_id }) => opts.conn('reception.accounts.payment.reminders.get',{ account_id: request_id }),
    set: async ({ request_id,share_url: _link,...settings }) => {
      const result = await opts.conn('reception.accounts.payment.reminders.set',{ ...settings,account_id: request_id });opts.onChanged?.();return result;
    },
    draft: ({ request_id,expected_revision }) => opts.conn('reception.accounts.payment.reminders.draft',{ account_id: request_id,expected_revision }),
    list: async input => { const { reminders,...page } = await opts.conn('reception.accounts.payment.reminders.list',input);
      return { ...page,reminders: reminders.map(({ account,reminder }) => ({ request: request(account),reminder })) };
    },
  } });
  return { ...mounted,open: (account: CustomerAccount,onClosed?: () => void) => mounted.open(request({
    account_id: account.account_id,customer: account.customer,job_count: account.job_ids.length,balances: [],
  }),onClosed) };
};
