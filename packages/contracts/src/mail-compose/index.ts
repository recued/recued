/** D-145 PA7 — mail-compose substrate barrel. */

export type {
  MailComposeMode,
  MailComposeValues,
  MailComposeDialogState,
  MailComposeState,
  MailReplyContext,
  MailSenderSourceOption,
  MailComposeAiAction,
  MailComposeRewriteAction,
  MailComposeAttachment,
} from './types.js';
export {
  MAIL_COMPOSE_MODES,
  EMPTY_MAIL_COMPOSE_VALUES,
  MAIL_COMPOSE_AI_ACTIONS,
  MAIL_COMPOSE_REWRITE_ACTIONS,
  MAIL_COMPOSE_MAX_ATTACHMENTS,
} from './types.js';

export {
  initialMailComposeState,
  openCreateComposeTransition,
  openReplyComposeTransition,
  setComposeValuesTransition,
  addComposeAttachmentsTransition,
  removeComposeAttachmentTransition,
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

export type { ComposeRewriteRecipeInput } from './assist.js';
export {
  composeRewriteRecipeConfig,
  REWRITE_COMPOSED_MAIL_RECIPE_ID,
} from './assist.js';
export {
  composeStateToSendPayload,
  composePayloadToSendRecipeConfig,
  SEND_COMPOSED_MAIL_RECIPE_ID,
} from './dispatch.js';
