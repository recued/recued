import { RpcError, type QuoteSignoffReminderGetInput, type QuoteSignoffReminderSetInput,
  type QuoteSignoffReminderListInput, type QuoteSignoffReminderDraftInput } from '@recued/contracts';
import { QuoteSignoffError } from './quote-signoff-service.js';
import type { ReceptionRpcDeps } from './reception-rpc-handler.js';

type Caller = { instance_id?: string | null } | undefined;
const run = async <T>(deps: ReceptionRpcDeps, caller: Caller, input: unknown, keys: string[],
  body: (service: import('./quote-signoff-reminder-service.js').QuoteSignoffReminderService) => Promise<T>): Promise<T> => {
  if (!caller?.instance_id) throw new RpcError('unauthorized', 'Sign-off reminders require a paired owner client.', 401);
  if (!deps.getQuoteSignoffReminderService) throw new RpcError('not_configured', 'Sign-off reminders are unavailable on this server.', 503);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) {
    throw new RpcError('quote_signoff_reminder_invalid', 'Invalid sign-off reminder input.', 400);
  }
  try { return await body(deps.getQuoteSignoffReminderService()); }
  catch (error) { if (error instanceof QuoteSignoffError) throw new RpcError(error.code, error.message, error.status); throw error; }
};
export const handleSignoffReminderGet = (deps: ReceptionRpcDeps, input: QuoteSignoffReminderGetInput, caller: Caller) =>
  run(deps, caller, input, ['signoff_id'], service => service.get(input.signoff_id));
export const handleSignoffReminderSet = (deps: ReceptionRpcDeps, input: QuoteSignoffReminderSetInput, caller: Caller) =>
  run(deps, caller, input, ['signoff_id', 'expected_revision', 'due_at', 'sender_mail_instance', 'recipient_email', 'share_url'], service => service.set(input));
export const handleSignoffReminderList = (deps: ReceptionRpcDeps, input: QuoteSignoffReminderListInput | void, caller: Caller) =>
  run(deps, caller, input ?? {}, ['limit', 'cursor'], service => service.list(input ?? {}));
export const handleSignoffReminderDraft = (deps: ReceptionRpcDeps, input: QuoteSignoffReminderDraftInput, caller: Caller) =>
  run(deps, caller, input, ['signoff_id', 'expected_revision'], service => service.draft(input.signoff_id, input.expected_revision));
