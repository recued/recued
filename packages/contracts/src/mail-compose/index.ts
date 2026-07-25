/** D-145 PA7 — mail-compose substrate barrel. */

export type {
  MailComposeMode,
  MailComposeValues,
  MailComposeDialogState,
  MailComposeState,
  MailReplyContext,
  MailSenderSourceOption,
  MailComposeAiAction,
} from './types.js';
export {
  MAIL_COMPOSE_MODES,
  EMPTY_MAIL_COMPOSE_VALUES,
  MAIL_COMPOSE_AI_ACTIONS,
} from './types.js';

export {
  initialMailComposeState,
  openCreateComposeTransition,
  openReplyComposeTransition,
  setComposeValuesTransition,
  setComposeErrorsTransition,
  setComposeSubmittingTransition,
  setComposeSubmitErrorTransition,
  closeComposeTransition,
  forceCloseComposeTransition,
  composeDialog,
} from './state.js';

export { addReReplyPrefix, deriveReplyValues } from './reply-context.js';

export type {
  ComposeDispatchResult,
  ComposeMailSendPayload,
  ComposeDispatchHooks,
} from './dispatch.js';
export { composeStateToSendPayload } from './dispatch.js';
