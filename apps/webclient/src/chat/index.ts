/** D-137 P1.4 — Webclient chat surface barrel.
 *
 *  Per D-148 § A.4 the webclient is display + HID; this module wires:
 *    - state reducer over the chat-thread broadcast event kinds
 *    - model-routing badge projection per § A.14
 *
 *  The actual UI renderer lives in the user's framework of choice
 *  (React / Svelte / vanilla DOM) and consumes these pure projections.
 *  This barrel surface is the typed substrate; no DOM, no rpc client.
 *  Webclient rpc-client wiring uses the existing
 *  `apps/webclient/src/realtime/ws-client.ts` envelope sender.
 */

export {
  initialChatThreadState,
  hydrateThreadFromSnapshot,
  prependOlderMessages,
  appendNewerMessages,
  beginInFlightTurn,
  reduceChatThreadEvent,
  isChatThreadEvent,
  applyPlanResolution,
  type ChatThreadState,
  type ChatThreadSnapshot,
  type InFlightTurn,
  type InFlightToolCall,
  type TurnFailureNotice,
  type PlanApprovalCard,
  type PlanExecutionReceipt,
} from './state.js';

export {
  buildModelRoutingBadge,
  buildChatModelSourceOptions,
  matchChatModelSource,
  CHAT_MODEL_ROUTING_LAYER_OPTIONS,
  type ChatModelSourceOption,
  type ModelRoutingBadge,
  type ModelRoutingBadgeKind,
  type ResolvedModelRoutingBadge,
  type PendingModelRoutingBadge,
} from './model-routing.js';

export {
  projectInFlightActivity,
  projectMessageActivity,
  projectTransparencyNote,
  type ChatActivityRow,
} from './activity.js';

export {
  buildCarriedBriefModel,
  CARRIED_BRIEF_FIELD_LABELS,
  type CarriedBriefRenderModel,
  type CarriedBriefRow,
} from './carried-brief.js';
