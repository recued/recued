/** D-169 P2 Slice 3 — `@recued/ui-shared/approval-card` barrel.
 *
 *  The shared D-158 `ask` approval card both the webclient and the bridge
 *  side panel import (I-12 — no per-client copy). Consumed via the
 *  `@recued/ui-shared/approval-card` subpath export (see package.json). */

export {
  renderApprovalCard,
  renderAskCard,
  renderChatPlanCard,
  APPROVAL_CARD_ACTION_ATTR,
  APPROVAL_CARD_ATTR,
  APPROVAL_CARD_CAUTION_ATTR,
  APPROVAL_CARD_ERROR_ATTR,
  APPROVAL_CARD_LINK_ATTR,
  APPROVAL_CARD_STATUS_ATTR,
  APPROVAL_CARD_STYLES,
  ASK_CARD_ATTR,
  ASK_CARD_OPTION_ATTR,
  ASK_CARD_ERROR_ATTR,
  ASK_CARD_STYLES,
  CHAT_PLAN_CARD_ATTR,
  CHAT_PLAN_CARD_ACTION_ATTR,
  CHAT_PLAN_CARD_ERROR_ATTR,
  type ApprovalCardDecision,
  type ApprovalCardHandlers,
  type ApprovalCardLinks,
  type ApprovalCardModel,
  type ApprovalCardOptions,
  type AskCardModel,
  type AskCardOption,
  type AskCardHandlers,
  type ChatPlanCardDecision,
  type ChatPlanCardHandlers,
  type ChatPlanCardModel,
  type ChatPlanCardOptions,
} from './card.js';
