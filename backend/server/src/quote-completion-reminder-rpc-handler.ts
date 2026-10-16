import { RpcError, type QuoteCompletionReminderGetInput, type QuoteCompletionReminderSetInput,
  type QuoteCompletionReminderListInput, type QuoteCompletionReminderDraftInput } from '@recued/contracts';
import { QuoteSignoffError } from './quote-signoff-service.js';
import type { ReceptionRpcDeps } from './reception-rpc-handler.js';

type Caller = { instance_id?: string | null } | undefined;
const run = async <T>(deps: ReceptionRpcDeps, caller: Caller, input: unknown, keys: string[],
  body: (service: import('./quote-completion-reminder-service.js').QuoteCompletionReminderService) => Promise<T>): Promise<T> => {
  if (!caller?.instance_id) throw new RpcError('unauthorized', 'Completion reminders require a paired owner client.', 401);
  if (!deps.getQuoteCompletionReminderService) throw new RpcError('not_configured', 'Completion reminders are unavailable on this server.', 503);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) {
    throw new RpcError('quote_completion_reminder_invalid', 'Invalid completion reminder input.', 400);
  }
  try { return await body(deps.getQuoteCompletionReminderService()); }
  catch (error) { if (error instanceof QuoteSignoffError) throw new RpcError(error.code, error.message, error.status); throw error; }
};
export const handleCompletionReminderGet = (deps: ReceptionRpcDeps, input: QuoteCompletionReminderGetInput, caller: Caller) =>
  run(deps, caller, input, ['completion_id'], service => service.get(input.completion_id));
export const handleCompletionReminderSet = (deps: ReceptionRpcDeps, input: QuoteCompletionReminderSetInput, caller: Caller) =>
  run(deps, caller, input, ['completion_id', 'expected_revision', 'due_at', 'sender_mail_instance', 'recipient_email', 'share_url'], service => service.set(input));
export const handleCompletionReminderList = (deps: ReceptionRpcDeps, input: QuoteCompletionReminderListInput | void, caller: Caller) =>
  run(deps, caller, input === undefined ? {} : input, ['limit', 'cursor'], service => service.list(input === undefined ? {} : input));
export const handleCompletionReminderDraft = (deps: ReceptionRpcDeps, input: QuoteCompletionReminderDraftInput, caller: Caller) =>
  run(deps, caller, input, ['completion_id', 'expected_revision'], service => service.draft(input.completion_id, input.expected_revision));
