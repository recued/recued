import { customerJobPaymentStatementLines,type CustomerJobPaymentStatement } from './customer-job-payment-statements.js';
import type { CustomerJobPaymentStatementDraftResult } from './customer-job-payment-statements.js';

export const CUSTOMER_ACCOUNT_STATEMENT_REFERENCE_PREFIX = 'qac_';
export const isCustomerAccountStatementReference = (value: unknown): value is `qac_${string}` =>
  typeof value === 'string' && value.startsWith(CUSTOMER_ACCOUNT_STATEMENT_REFERENCE_PREFIX);
export const CUSTOMER_ACCOUNT_MAX_JOBS = 100;
/** An owner-selected grouping. Names never establish account membership. */
export interface CustomerAccount {
  account_id: string;revision: number;customer: string;job_ids: string[];created_at: number;updated_at: number;
}
export interface CustomerAccountInput { account_id: string }
export interface CustomerAccountsListInput { limit?: number;cursor?: string }
export interface CustomerAccountsListResult { accounts: CustomerAccount[];next_cursor?: string }
/** Revision zero creates the supplied new identity. Later edits replace its job selection. */
export interface CustomerAccountSaveInput extends CustomerAccountInput {
  expected_revision: number;customer: string;job_ids: string[];
}
export interface CustomerAccountStatementBalance {
  currency: string;invoiced_total: string;amount_paid: string;amount_credited: string;
  amount_refund_credited: string;amount_refunded: string;outstanding: string;refund_due: string;net_received: string;
}
export interface CustomerAccountStatement {
  format: 'recued.customer-account-statement';version: 1;captured_at: number;statement_hash: string;
  account_id: string;account_revision: number;business_name: string;customer: string;
  balances: CustomerAccountStatementBalance[];jobs: CustomerJobPaymentStatement[];
}
export interface CustomerAccountStatementDraftInput extends CustomerAccountInput {
  expected_statement_hash: string;sender_mail_instance: string;recipient_email: string;
}
export type CustomerAccountStatementDraftResult = CustomerJobPaymentStatementDraftResult;
export const customerAccountStatementLines = (statement: CustomerAccountStatement): string[] => [
  `${statement.business_name} · ${statement.customer}`,
  `Customer account statement · ${statement.jobs.length} linked job${statement.jobs.length === 1 ? '' : 's'}`,
  ...statement.balances.flatMap(balance => [
    '',`Currency: ${balance.currency}`,
    `Total invoiced: ${balance.invoiced_total} ${balance.currency}`,
    `Recorded paid: ${balance.amount_paid} ${balance.currency}`,
    `Recorded invoice credits: ${balance.amount_credited} ${balance.currency}`,
    `Recorded paid invoice credits: ${balance.amount_refund_credited} ${balance.currency}`,
    `Recorded refunds: ${balance.amount_refunded} ${balance.currency}`,
    `Customer still owes: ${balance.outstanding} ${balance.currency}`,
    `Refund still owed to customer: ${balance.refund_due} ${balance.currency}`,
    `Net recorded received: ${balance.net_received} ${balance.currency}`,
  ]),
  ...statement.jobs.flatMap(job => ['',...customerJobPaymentStatementLines(job)]),
  '',`Account snapshot captured ${new Date(statement.captured_at).toISOString()}.`,
  'This statement includes only the jobs explicitly linked to this customer account. Pending offers are excluded.',
  'Currencies are shown separately. Customer balances and refunds owed are not offset against each other.',
  'Amounts reflect the business’s records at capture, not bank or payment provider settlement.',
].map(line => line.replace(/\r\n?/g,'\n'));
