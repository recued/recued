import { RpcError, type QuotePaymentReminderGetInput, type QuotePaymentReminderSetInput,
  type QuotePaymentReminderListInput, type QuotePaymentReminderDraftInput } from '@recued/contracts';
import { QuoteSignoffError } from './quote-signoff-service.js';
import type { ReceptionRpcDeps } from './reception-rpc-handler.js';

type Caller = { instance_id?: string | null } | undefined;
const run = async <T>(deps: ReceptionRpcDeps, caller: Caller, input: unknown, keys: string[],
  body: (service: import('./quote-payment-reminder-service.js').QuotePaymentReminderService) => Promise<T>): Promise<T> => {
  if (!caller?.instance_id) throw new RpcError('unauthorized', 'Payment reminders require a paired owner client.', 401);
  if (!deps.getQuotePaymentReminderService) throw new RpcError('not_configured', 'Payment reminders are unavailable on this server.', 503);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) {
    throw new RpcError('quote_payment_reminder_invalid', 'Invalid payment reminder input.', 400);
  }
  try { return await body(deps.getQuotePaymentReminderService()); }
  catch (error) { if (error instanceof QuoteSignoffError) throw new RpcError(error.code, error.message, error.status); throw error; }
};
export const handlePaymentReminderGet = (deps: ReceptionRpcDeps, input: QuotePaymentReminderGetInput, caller: Caller) =>
  run(deps, caller, input, ['signoff_id'], service => service.get(input.signoff_id));
export const handlePaymentReminderSet = (deps: ReceptionRpcDeps, input: QuotePaymentReminderSetInput, caller: Caller) =>
  run(deps, caller, input, ['signoff_id', 'expected_revision', 'due_at', 'sender_mail_instance', 'recipient_email'], service => service.set(input));
export const handlePaymentReminderList = (deps: ReceptionRpcDeps, input: QuotePaymentReminderListInput | void, caller: Caller) =>
  run(deps, caller, input === undefined ? {} : input, ['limit', 'cursor'], service => service.list(input === undefined ? {} : input));
export const handlePaymentReminderDraft = (deps: ReceptionRpcDeps, input: QuotePaymentReminderDraftInput, caller: Caller) =>
  run(deps, caller, input, ['signoff_id', 'expected_revision'], service => service.draft(input.signoff_id, input.expected_revision));
