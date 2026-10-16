import { RpcError, type CustomerAccountPaymentReminderInput, type CustomerAccountPaymentReminderSetInput,
  type CustomerAccountPaymentReminderListInput, type CustomerAccountPaymentReminderDraftInput } from '@recued/contracts';
import { QuoteSignoffError } from './quote-signoff-service.js';
import type { ReceptionRpcDeps } from './reception-rpc-handler.js';

type Caller = { instance_id?: string | null } | undefined;
const run = async <T>(deps: ReceptionRpcDeps, caller: Caller, input: unknown, keys: string[],
  body: (service: import('./customer-account-payment-reminder-service.js').CustomerAccountPaymentReminderService) => Promise<T>): Promise<T> => {
  if (!caller?.instance_id) throw new RpcError('unauthorized', 'Account payment reminders require a paired owner client.', 401);
  if (!deps.getCustomerAccountPaymentReminderService) throw new RpcError('not_configured', 'Account payment reminders are unavailable on this server.', 503);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) {
    throw new RpcError('customer_account_payment_reminder_invalid', 'Invalid payment reminder input.', 400);
  }
  try { return await body(deps.getCustomerAccountPaymentReminderService()); }
  catch (error) { if (error instanceof QuoteSignoffError) throw new RpcError(error.code, error.message, error.status); throw error; }
};
export const handleAccountPaymentReminderGet = (deps: ReceptionRpcDeps, input: CustomerAccountPaymentReminderInput, caller: Caller) =>
  run(deps, caller, input, ['account_id'], service => service.get(input.account_id));
export const handleAccountPaymentReminderSet = (deps: ReceptionRpcDeps, input: CustomerAccountPaymentReminderSetInput, caller: Caller) =>
  run(deps, caller, input, ['account_id', 'expected_revision', 'due_at', 'sender_mail_instance', 'recipient_email'], service => service.set(input));
export const handleAccountPaymentReminderList = (deps: ReceptionRpcDeps, input: CustomerAccountPaymentReminderListInput | void, caller: Caller) =>
  run(deps, caller, input === undefined ? {} : input, ['limit', 'cursor'], service => service.list(input === undefined ? {} : input));
export const handleAccountPaymentReminderDraft = (deps: ReceptionRpcDeps, input: CustomerAccountPaymentReminderDraftInput, caller: Caller) =>
  run(deps, caller, input, ['account_id', 'expected_revision'], service => service.draft(input.account_id, input.expected_revision));
