/** D-174 P2 — top-level Chat route.
 *
 *  This hosts the existing D-137 chat substrate at `#chat`: server-owned
 *  session state, the pure reducer, and the model-routing badge projection.
 *  It intentionally stays a thin DOM host instead of rewriting the chat engine.
 */

import {
  transparencyStreamSettingsFromPrefs,
  DEFAULT_TRANSPARENCY_STREAM_SETTINGS,
  isChatModelSourceId,
  type AutoRunStatusEntry,
  type ChatMessage,
  type ChatModelHint,
  type ChatModelRoutingLayer,
  type ChatModelSourceId,
  type ChatPlanProposal,
  type ChatSession,
  type ChatSessionSummary,
  type InstancePrefs,
  type ServerRecipeListEntry,
  type TransparencyStreamSettings,
} from '@recued/contracts';
import { PRIMITIVE_STYLES } from '@recued/ui-shared/primitives';
import { RunModal } from '@recued/ui-shared';

import {
  applyPlanResolution,
  beginInFlightTurn,
  buildChatModelSourceOptions,
  matchChatModelSource,
  hydrateThreadFromSnapshot,
  initialChatThreadState,
  isChatThreadEvent,
  projectInFlightActivity,
  projectMessageActivity,
  reduceChatThreadEvent,
  type ChatActivityRow,
  type ChatModelSourceOption,
  type ChatThreadState,
  type PlanApprovalCard,
  type TurnFailureNotice,
} from './index.js';
import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import {
  isAnyAiSourceConfigured,
  type LlmConfigRecord,
} from '../settings/llm-availability.js';
import { serializeShellRoute } from '../shell/route.js';
import {
  classifyRpcError,
  type ClassifiedRpcError,
} from '../shell/rpc-error-copy.js';
import {
  type ComposeContactUpsertCaller,
  type ComposeWorkEntityUpsertCaller,
} from '../compose/compose-route.js';
import {
  openCreateOverlay as openSharedCreateOverlay,
  CREATE_OVERLAY_ATTR,
  CREATE_OVERLAY_CLOSE_ATTR,
  type CreateOverlayHandle,
} from '../compose/create-overlay.js';
import { wireRunPalette, type RunPaletteHandle } from './run-palette.js';

export const CHAT_ROUTE_STYLES_MARKER = 'data-recued-chat-route-styles';
export const CHAT_ROUTE_HOST_ATTR = 'data-recued-chat-route';
export const CHAT_ROUTE_HEADING_ATTR = 'data-recued-chat-route-heading';
export const CHAT_ROUTE_SESSION_LIST_ATTR = 'data-recued-chat-route-session-list';
export const CHAT_ROUTE_SESSION_ROW_ATTR = 'data-recued-chat-route-session-row';
export const CHAT_ROUTE_THREAD_ATTR = 'data-recued-chat-route-thread';
export const CHAT_ROUTE_MESSAGE_ATTR = 'data-recued-chat-route-message';
export const CHAT_ROUTE_INPUT_ATTR = 'data-recued-chat-route-input';
export const CHAT_ROUTE_SEND_ATTR = 'data-recued-chat-route-send';
export const CHAT_ROUTE_NEW_SESSION_ATTR = 'data-recued-chat-route-new-session';
export const CHAT_ROUTE_ERROR_ATTR = 'data-recued-chat-route-error';
export const CHAT_ROUTE_EMPTY_ATTR = 'data-recued-chat-route-empty';
/** UX-review flow-09 — cold-start "no AI model configured" banner. */
export const CHAT_ROUTE_AI_UNAVAILABLE_ATTR =
  'data-recued-chat-route-ai-unavailable';
/** PB7 — per-turn failure notice painted under the failed turn's
 *  message (projected from § B.15 failure-class transparency events). */
export const CHAT_ROUTE_TURN_FAILURE_ATTR =
  'data-recued-chat-route-turn-failure';
/** Activity disclosure — per-turn block of transparency narrative +
 *  tool-dispatch rows (§ B.8.7 read-along narrative; § A.5 tool
 *  provenance). Default expanded, collapsible per turn. */
export const CHAT_ROUTE_ACTIVITY_ATTR = 'data-recued-chat-route-activity';
export const CHAT_ROUTE_ACTIVITY_TOGGLE_ATTR =
  'data-recued-chat-route-activity-toggle';
export const CHAT_ROUTE_ACTIVITY_ROW_ATTR =
  'data-recued-chat-route-activity-row';
/** D-137 P3 § A.11 — interactive plan-approval card painted under the
 *  proposing turn's message. Carries `data-status` (`proposed` /
 *  `approved` / `cancelled`) + `data-plan-id`; the approve / cancel
 *  buttons drive the `chat.plan.approve` / `chat.plan.cancel` rpc. */
export const CHAT_ROUTE_PLAN_CARD_ATTR = 'data-recued-chat-route-plan-card';
export const CHAT_ROUTE_PLAN_APPROVE_ATTR =
  'data-recued-chat-route-plan-approve';
export const CHAT_ROUTE_PLAN_CANCEL_ATTR =
  'data-recued-chat-route-plan-cancel';
/** id the banner carries so the disabled Send button can point its
 *  `aria-describedby` at the reason text (accessible disabled reason). */
export const CHAT_ROUTE_AI_UNAVAILABLE_ID = 'recued-chat-ai-unavailable';
// Shell-frame Step 3 — composer L1 upgrades (§D.L1 chat home).
/** The composer container (toolbar row + input row). */
export const CHAT_ROUTE_COMPOSER_ATTR = 'data-recued-chat-route-composer';
/** The in-composer model picker `<select>` — lists only CONFIGURED
 *  routing layers (Local / Free pool / BYOK); selecting drives
 *  `chat.session.set_model_pref` (active session) or seeds the draft
 *  (lazy, not-yet-created session). */
export const CHAT_ROUTE_MODEL_PICKER_ATTR =
  'data-recued-chat-route-model-picker';
/** Rendered IN PLACE of the picker when no AI source is configured: the
 *  picker IS the "Configure LLM →" link (§D.L1 — fail loud, never send
 *  into nothing). */
export const CHAT_ROUTE_MODEL_CONFIGURE_ATTR =
  'data-recued-chat-route-model-configure';
/** The centered greeting painted above the composer in the empty state
 *  (§D.L1 — EMPTY composer CENTERED + greeting; docks on first send). */
export const CHAT_ROUTE_GREETING_ATTR = 'data-recued-chat-route-greeting';
// Shell-frame Step 4 — the two composer buttons (§D.L1). Below the composer
// in the empty hero (expanded row); collapse into a `+` menu once docked.
/** The actions container (the expanded row, or the `+` menu's list). */
export const CHAT_ROUTE_COMPOSER_ACTIONS_ATTR =
  'data-recued-chat-route-composer-actions';
/** One action button — `data-…-action="create"` / `"run"`. */
export const CHAT_ROUTE_COMPOSER_ACTION_ATTR =
  'data-recued-chat-route-composer-action';
/** The docked `<details>` "+" disclosure that holds the collapsed menu. */
export const CHAT_ROUTE_COMPOSER_MORE_ATTR =
  'data-recued-chat-route-composer-more';
/** The [✎ Create] overlay backdrop (portal-mounted; absorbs #compose). The
 *  overlay itself was extracted to `compose/create-overlay.ts` (shell-frame
 *  Step 5, shared with the §D.L2 drawer "Create" seat); these are re-exported
 *  aliases of its hooks so existing chat-route consumers keep their names. */
export const CHAT_ROUTE_CREATE_OVERLAY_ATTR = CREATE_OVERLAY_ATTR;
/** The Create overlay's Close button. */
export const CHAT_ROUTE_CREATE_CLOSE_ATTR = CREATE_OVERLAY_CLOSE_ATTR;
// The D-181 live-control "running" bubble was lifted OUT of the chat header
// into route-independent shell chrome (`live-control/live-control-bubble.ts`,
// shell-frame Step 2), so the owner controls everything in flight from any
// screen. The chat route is back to a thin DOM host.

export interface ChatRouteConn {
  (method: 'chat.sessions.list'): Promise<{ sessions: ChatSessionSummary[] }>;
  (
    method: 'chat.session.get',
    payload: { session_id: string },
  ): Promise<ChatSession & { messages: ChatMessage[] }>;
  (method: 'chat.session.create'): Promise<{ session_id: string }>;
  (
    method: 'chat.session.create',
    payload: { title?: string },
  ): Promise<{ session_id: string }>;
  (
    method: 'chat.send',
    payload: {
      session_id: string;
      message: string;
      picker_state: ChatSession['picker_state'];
      model_pref: {
        current: ChatModelRoutingLayer;
        model_hint?: ChatModelHint;
        source_id?: ChatModelSourceId;
      };
    },
  ): Promise<{ turn_id: string }>;
  /** Shell-frame Step 3 — persist the active session's routing source (layer
   *  + § A.14 slot hint) when the composer picker changes (broadcasts
   *  `chat.session_changed` field `model_pref`, which the thread reducer
   *  absorbs). */
  (
    method: 'chat.session.set_model_pref',
    payload: {
      session_id: string;
      model_pref: {
        current: ChatModelRoutingLayer;
        model_hint?: ChatModelHint;
        source_id?: ChatModelSourceId;
      };
    },
  ): Promise<{ ok: true }>;
  /** Shell-frame Step 3 — read the per-pair GLOBAL chat-model default as a
   *  `source_id` (D-174 R28 Slice A); the composer picker seeds a draft
   *  (not-yet-created) session from it by exact id ("scope = last-used on this
   *  client, seeded from global default"). `null` when no default is chosen. */
  (method: 'chat.default_model_pref.get'): Promise<{
    source_id: ChatModelSourceId | null;
    updated_at: number;
  }>;
  /** UX-review flow-09 — read the D-079 LLM config so the route can
   *  pre-empt the executor's loud NO_LLM_SOURCE with a cold-start
   *  "set up AI" affordance. Returns the same shape as
   *  `server.getLLMConfig` (`{ config: ServerLLMConfig }`). */
  (method: 'server.getLLMConfig'): Promise<{
    config: Record<string, unknown>;
  }>;
  /** § B.8.9 — per-pair `ui.transparency.*` prefs feeding the activity
   *  disclosure's visibility policy. Soft signal like the LLM config
   *  read: a failure leaves the substrate defaults in place. */
  (method: 'prefs.get'): Promise<{ prefs: InstancePrefs }>;
  /** D-137 P3 § A.11 — resolve a pending write plan. Both return the
   *  post-resolution authoritative `ChatPlanProposal`, which the route
   *  applies optimistically (the `chat.plan_resolved` broadcast also
   *  lands and no-ops on the already-resolved card). `edited_args` is
   *  deliberately not surfaced: the server ignores it today and the
   *  `args_hash` gate binds approvals to exactly the reviewed payload. */
  (
    method: 'chat.plan.approve' | 'chat.plan.cancel',
    payload: { plan_id: string },
  ): Promise<{ plan: ChatPlanProposal }>;
}

const CHAT_ROUTE_CHROME_STYLES = `
[${CHAT_ROUTE_HOST_ATTR}] {
  /* Inherit the shell's light/dark tokens instead of hard-pinning light
     values, which left inner --bg/--surface-sunk elements dark-on-dark
     in dark mode (visual-UX review). */
  max-width: var(--wc-content-max, 1080px);
  margin: 0 auto;
  padding: 16px;
  color: var(--fg);
}
[${CHAT_ROUTE_HOST_ATTR}] .chat-route-header {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 14px;
}
[${CHAT_ROUTE_HOST_ATTR}] .chat-route-title {
  margin: 0;
  font-size: 20px;
  font-weight: 650;
}
[${CHAT_ROUTE_HOST_ATTR}] .chat-route-shell {
  display: grid;
  grid-template-columns: minmax(190px, 260px) minmax(0, 1fr);
  gap: 14px;
}
[${CHAT_ROUTE_SESSION_LIST_ATTR}],
[${CHAT_ROUTE_THREAD_ATTR}] {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
}
[${CHAT_ROUTE_SESSION_LIST_ATTR}] {
  display: grid;
  align-content: start;
  gap: 8px;
  padding: 10px;
}
[${CHAT_ROUTE_SESSION_ROW_ATTR}] {
  width: 100%;
  text-align: left;
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  background: var(--surface-subtle);
  padding: 8px;
  cursor: pointer;
}
[${CHAT_ROUTE_SESSION_ROW_ATTR}][data-active="true"] {
  border-color: var(--accent);
}
[${CHAT_ROUTE_HOST_ATTR}] .chat-session-title {
  display: block;
  font-size: 13px;
  font-weight: 650;
}
[${CHAT_ROUTE_HOST_ATTR}] .chat-session-meta,
[${CHAT_ROUTE_HOST_ATTR}] .chat-route-muted {
  font-size: 12px;
  color: var(--muted);
}
[${CHAT_ROUTE_THREAD_ATTR}] {
  min-height: 420px;
  display: grid;
  grid-template-rows: auto 1fr auto;
}
[${CHAT_ROUTE_HOST_ATTR}] .chat-thread-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  border-bottom: 1px solid var(--border-subtle);
  padding: 10px 12px;
}
[${CHAT_ROUTE_HOST_ATTR}] .chat-thread-title {
  margin: 0;
  font-size: 14px;
  font-weight: 650;
}
[${CHAT_ROUTE_HOST_ATTR}] .chat-thread-messages {
  display: grid;
  align-content: start;
  gap: 10px;
  padding: 12px;
}
[${CHAT_ROUTE_MESSAGE_ATTR}] {
  display: grid;
  gap: 4px;
  max-width: 76ch;
}
[${CHAT_ROUTE_MESSAGE_ATTR}] .chat-message-role {
  font-size: 11px;
  font-weight: 650;
  color: var(--muted);
  text-transform: uppercase;
}
[${CHAT_ROUTE_MESSAGE_ATTR}] .chat-message-content {
  white-space: pre-wrap;
  font-size: 13px;
  line-height: 1.45;
}
[${CHAT_ROUTE_HOST_ATTR}] .chat-composer {
  display: grid;
  grid-template-rows: auto auto;
  gap: 8px;
  border-top: 1px solid var(--border-subtle);
  padding: 10px;
}
[${CHAT_ROUTE_HOST_ATTR}] .chat-composer-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 26px;
}
[${CHAT_ROUTE_HOST_ATTR}] .chat-composer-input-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
}
[${CHAT_ROUTE_HOST_ATTR}] .chat-composer-model {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--muted);
}
[${CHAT_ROUTE_MODEL_PICKER_ATTR}] {
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--fg);
  padding: 3px 6px;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
[${CHAT_ROUTE_MODEL_CONFIGURE_ATTR}] {
  color: var(--accent);
  font-weight: 650;
  font-size: 12px;
  text-decoration: none;
}
[${CHAT_ROUTE_MODEL_CONFIGURE_ATTR}]:hover {
  text-decoration: underline;
}
/* Centered → docked (§D.L1): empty thread centers the greeting + composer;
   the first send drops the composer to the bottom and lets messages fill. */
[${CHAT_ROUTE_THREAD_ATTR}][data-empty="true"] {
  grid-template-rows: 1fr;
}
[${CHAT_ROUTE_HOST_ATTR}] .chat-thread-hero {
  display: grid;
  align-content: center;
  justify-items: center;
  gap: 16px;
  padding: 24px;
}
[${CHAT_ROUTE_HOST_ATTR}] .chat-thread-hero .chat-composer {
  width: 100%;
  max-width: 640px;
  border-top: none;
  padding: 0;
}
[${CHAT_ROUTE_GREETING_ATTR}] {
  font-size: 20px;
  font-weight: 650;
  color: var(--fg);
  text-align: center;
}
[${CHAT_ROUTE_INPUT_ATTR}] {
  min-height: 42px;
  resize: vertical;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px;
  font: inherit;
}
[${CHAT_ROUTE_SEND_ATTR}],
[${CHAT_ROUTE_NEW_SESSION_ATTR}] {
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  padding: 7px 12px;
  cursor: pointer;
}
[${CHAT_ROUTE_SEND_ATTR}] {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
}
[${CHAT_ROUTE_SEND_ATTR}][disabled] {
  opacity: 0.55;
  cursor: default;
}
[${CHAT_ROUTE_ERROR_ATTR}] {
  padding: 10px 12px;
  color: var(--fail);
  font-size: 13px;
}
[${CHAT_ROUTE_EMPTY_ATTR}] {
  padding: 12px;
  color: var(--muted);
  font-size: 13px;
}
[${CHAT_ROUTE_AI_UNAVAILABLE_ATTR}] {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  border-top: 1px solid var(--border-subtle);
  padding: 10px 12px;
  color: var(--muted);
  font-size: 13px;
}
[${CHAT_ROUTE_ACTIVITY_ATTR}] {
  display: grid;
  gap: 2px;
  justify-items: start;
}
[${CHAT_ROUTE_ACTIVITY_TOGGLE_ATTR}] {
  border: none;
  background: none;
  padding: 0;
  font-size: 11px;
  font-weight: 650;
  color: var(--muted);
  cursor: pointer;
}
[${CHAT_ROUTE_ACTIVITY_ROW_ATTR}] {
  font-size: 12px;
  line-height: 1.4;
  color: var(--muted);
}
[${CHAT_ROUTE_ACTIVITY_ROW_ATTR}][data-status="error"] {
  color: var(--fail);
}
[${CHAT_ROUTE_TURN_FAILURE_ATTR}] {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  max-width: 76ch;
  border: 1px solid var(--border-subtle);
  border-left: 3px solid var(--fail);
  border-radius: 6px;
  background: var(--surface-subtle);
  padding: 8px 10px;
  color: var(--fail);
  font-size: 12px;
}
[${CHAT_ROUTE_TURN_FAILURE_ATTR}] a {
  color: var(--accent);
  font-weight: 650;
  text-decoration: none;
}
[${CHAT_ROUTE_TURN_FAILURE_ATTR}] a:hover {
  text-decoration: underline;
}
[${CHAT_ROUTE_PLAN_CARD_ATTR}] {
  display: grid;
  gap: 8px;
  max-width: 76ch;
  border: 1px solid var(--border-subtle);
  border-left: 3px solid var(--accent);
  border-radius: 6px;
  background: var(--surface-subtle);
  padding: 10px 12px;
  font-size: 12px;
}
[${CHAT_ROUTE_PLAN_CARD_ATTR}][data-status="approved"],
[${CHAT_ROUTE_PLAN_CARD_ATTR}][data-status="cancelled"] {
  border-left-color: var(--border);
  color: var(--muted);
}
[${CHAT_ROUTE_PLAN_CARD_ATTR}] .chat-plan-card-header {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
}
[${CHAT_ROUTE_PLAN_CARD_ATTR}] .chat-plan-card-status {
  font-size: 11px;
  font-weight: 650;
  text-transform: uppercase;
}
[${CHAT_ROUTE_PLAN_CARD_ATTR}][data-status="proposed"] .chat-plan-card-status {
  color: var(--accent);
}
[${CHAT_ROUTE_PLAN_CARD_ATTR}] .chat-plan-card-tool {
  font-weight: 650;
}
[${CHAT_ROUTE_PLAN_CARD_ATTR}] .chat-plan-card-tier {
  font-size: 11px;
  color: var(--muted);
}
[${CHAT_ROUTE_PLAN_CARD_ATTR}] .chat-plan-card-hint {
  font-size: 11px;
  color: var(--muted);
}
[${CHAT_ROUTE_PLAN_CARD_ATTR}] .chat-plan-card-args-label {
  font-size: 11px;
  font-weight: 650;
  color: var(--muted);
  text-transform: uppercase;
}
[${CHAT_ROUTE_PLAN_CARD_ATTR}] .chat-plan-card-args {
  margin: 0;
  max-height: 200px;
  overflow: auto;
  border: 1px solid var(--border-subtle);
  border-radius: 4px;
  background: var(--surface-sunk, var(--surface));
  padding: 8px;
  font-size: 11px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
}
[${CHAT_ROUTE_PLAN_CARD_ATTR}] .chat-plan-card-actions {
  display: flex;
  gap: 8px;
}
[${CHAT_ROUTE_PLAN_APPROVE_ATTR}],
[${CHAT_ROUTE_PLAN_CANCEL_ATTR}] {
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  padding: 6px 12px;
  font-size: 12px;
  cursor: pointer;
}
[${CHAT_ROUTE_PLAN_APPROVE_ATTR}] {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
  font-weight: 650;
}
[${CHAT_ROUTE_PLAN_APPROVE_ATTR}][disabled],
[${CHAT_ROUTE_PLAN_CANCEL_ATTR}][disabled] {
  opacity: 0.55;
  cursor: default;
}
[${CHAT_ROUTE_AI_UNAVAILABLE_ATTR}] a {
  color: var(--accent);
  font-weight: 650;
  text-decoration: none;
}
[${CHAT_ROUTE_AI_UNAVAILABLE_ATTR}] a:hover {
  text-decoration: underline;
}
/* Shell-frame Step 4 — the two composer buttons (§D.L1). */
[${CHAT_ROUTE_HOST_ATTR}] .chat-composer-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
[${CHAT_ROUTE_HOST_ATTR}] .chat-thread-hero .chat-composer-actions {
  justify-content: center;
}
[${CHAT_ROUTE_COMPOSER_ACTION_ATTR}] {
  appearance: none;
  min-height: 30px;
  padding: 5px 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  color: var(--fg);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
[${CHAT_ROUTE_COMPOSER_ACTION_ATTR}]:hover {
  border-color: var(--accent);
  color: var(--accent);
}
[${CHAT_ROUTE_COMPOSER_MORE_ATTR}] {
  position: relative;
  margin-left: auto;
}
[${CHAT_ROUTE_COMPOSER_MORE_ATTR}] > summary {
  list-style: none;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--fg);
  font-size: 16px;
  line-height: 1;
}
[${CHAT_ROUTE_COMPOSER_MORE_ATTR}] > summary::-webkit-details-marker {
  display: none;
}
[${CHAT_ROUTE_COMPOSER_MORE_ATTR}] .chat-composer-actions--menu {
  position: absolute;
  right: 0;
  bottom: calc(100% + 6px);
  flex-direction: column;
  min-width: 168px;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  box-shadow: 0 12px 28px rgba(24, 33, 36, .18);
  z-index: 30;
}
[${CHAT_ROUTE_COMPOSER_MORE_ATTR}] .chat-composer-actions--menu [${CHAT_ROUTE_COMPOSER_ACTION_ATTR}] {
  border-radius: 6px;
  justify-content: flex-start;
  text-align: left;
  width: 100%;
}
/* §D.L1 — the [✎ Create] overlay styles live in compose/create-overlay.ts
   (extracted in shell-frame Step 5, shared with the §D.L2 drawer seat). */
@media (max-width: 820px) {
  [${CHAT_ROUTE_HOST_ATTR}] .chat-route-header {
    display: grid;
  }
  [${CHAT_ROUTE_HOST_ATTR}] .chat-route-shell {
    grid-template-columns: 1fr;
  }
}
`;

export const CHAT_ROUTE_STYLES = [
  PRIMITIVE_STYLES,
  CHAT_ROUTE_CHROME_STYLES,
].join('\n');

export interface BootstrapChatRouteOptions {
  root: HTMLElement;
  document?: Document;
  conn: ChatRouteConn;
  subscribe?: BroadcastSubscriber['on'];
  /** Shell-frame Step 4 — the [✎ Create] composer button. Its overlay
   *  reuses the compose route; these are its upsert callers. The Create
   *  button renders only when at least one is wired. */
  contactUpsertCaller?: ComposeContactUpsertCaller;
  workEntityUpsertCaller?: ComposeWorkEntityUpsertCaller;
  /** Shell-frame Step 4c — the [▶ Run a recipe] palette. The button renders
   *  only when `recipeListCaller` is wired; each per-action caller degrades
   *  individually (a missing `recipeExecuteCaller` → the Run modal shows
   *  "not available"; a missing `autoRunUpdateCaller` → the arm toggle is
   *  disabled). */
  recipeListCaller?: () => Promise<{
    recipes: ReadonlyArray<ServerRecipeListEntry>;
  }>;
  recipeExecuteCaller?: RunModal.RunModalExecuteCaller;
  schedulesListCaller?: RunModal.RunModalSchedulesListCaller;
  schedulesCreateCaller?: RunModal.RunModalSchedulesCreateCaller;
  schedulesUpdateCaller?: RunModal.RunModalSchedulesUpdateCaller;
  schedulesDeleteCaller?: RunModal.RunModalSchedulesDeleteCaller;
  autoRunListCaller?: () => Promise<{ entries: AutoRunStatusEntry[] }>;
  autoRunUpdateCaller?: (args: {
    recipe_id: string;
    enabled: boolean;
  }) => Promise<unknown>;
}

export interface ChatRoute {
  getSessions(): ReadonlyArray<ChatSessionSummary>;
  getThread(): ChatThreadState;
  refresh(): Promise<void>;
  openSession(sessionId: string): Promise<void>;
  createSession(title?: string): Promise<void>;
  sendMessage(message: string): Promise<void>;
  dispose(): void;
}

interface ChatRouteState {
  phase: 'loading' | 'ready' | 'error';
  sessions: ReadonlyArray<ChatSessionSummary>;
  activeSessionId: string | null;
  thread: ChatThreadState;
  error: ClassifiedRpcError | null;
  sending: boolean;
  /** Ack-before-run send serialization — the turn the composer is
   *  locked on. The `chat.send` ack resolves at the server's COMMIT
   *  POINT (user message durable, model-bound body still running), so
   *  `sending` must hold until the sent turn actually SETTLES: its
   *  `chat.message_complete` lands (`completed_turn_ids`) or its
   *  failure paints (`turn_failures` — incl. the post-accept
   *  `engine.turn_failed` signal). Order-agnostic: under an
   *  ack-after-run server the turn is already completed when the ack
   *  returns and the lock settles immediately. */
  pending_turn_id: string | null;
  /** UX-review flow-09 — tri-state AI-availability signal. `null` while
   *  the LLM config is still loading (or its read failed); the cold-start
   *  affordance shows ONLY on an explicit `false`, so a slow config read
   *  never flashes the banner — the distinction the model-routing badge's
   *  `pending` state cannot make. */
  aiAvailable: boolean | null;
  /** § B.8.9 — resolved transparency-stream visibility policy for the
   *  activity disclosure. Substrate defaults until the `prefs.get`
   *  read lands (or forever, when it fails — soft signal); the route
   *  re-reads on every mount, so a Settings change applies on the next
   *  navigation back to the chat. */
  transparency: TransparencyStreamSettings;
  /** Shell-frame Step 3 — the CONFIGURED model sources (slots by role + the
   *  free pool), projected from `server.getLLMConfig` at mount. `null` until
   *  the read lands (or forever if it fails — soft signal); drives the
   *  picker's options. */
  modelSources: ChatModelSourceOption[] | null;
  /** Shell-frame Step 3 — the per-pair global chat-model default as a
   *  `source_id` (`chat.default_model_pref.get`, D-174 R28 Slice A). Seeds the
   *  draft picker for a not-yet-created session — selected by EXACT id match,
   *  no layer fallback. `null` while loading / on read failure / no default
   *  chosen. */
  defaultSourceId: ChatModelSourceId | null;
  /** Shell-frame Step 3 — the picker's selected source id for a DRAFT (lazy,
   *  no active session) thread. Seeded from `defaultSourceId`; persists across
   *  "New chat" within this mount (the in-memory "last-used on this client"
   *  scope — a durable field would expand the closed-list local store). */
  draftSourceId: ChatModelSourceOption['id'] | null;
}


const formatRelative = (ms: number): string =>
  Number.isFinite(ms) ? new Date(ms).toLocaleString() : 'unknown';

/** Shell-frame Step 3 — lazy-session title from the first words of the
 *  opening message, so chat history holds readable "first-words" labels.
 *  (A session is minted only on first send, so there is no untitled junk to
 *  derive from.) */
const deriveSessionTitle = (message: string): string => {
  const oneLine = message.trim().replace(/\s+/g, ' ');
  if (oneLine.length <= 48) return oneLine;
  return `${oneLine.slice(0, 47).trimEnd()}…`;
};

const sessionTitle = (
  session: Pick<ChatSessionSummary | ChatSession, 'id' | 'title'> | null,
): string => {
  if (session === null) return 'No chat selected';
  return session.title ?? `Chat ${session.id}`;
};

const messageRoleLabel = (role: ChatMessage['role']): string => {
  if (role === 'user') return 'You';
  if (role === 'assistant') return 'Assistant';
  if (role === 'tool') return 'Tool';
  return 'System';
};


/** § A.11 — read-only args rendering for the approval card. The wire
 *  args are JSON by construction; the fallbacks keep a quirky payload
 *  from blanking the review surface (Mary must see SOMETHING before
 *  approving). */
const formatPlanArgs = (args: unknown): string => {
  if (args === undefined || args === null) return '(none)';
  try {
    const text = JSON.stringify(args, null, 2);
    return text === undefined ? String(args) : text;
  } catch {
    return String(args);
  }
};

const planStatusLabel = (status: PlanApprovalCard['status']): string => {
  if (status === 'proposed') return 'Needs your approval';
  if (status === 'approved') return 'Approved';
  return 'Cancelled';
};

/** § A.11 — approved-state mechanism hint. TRUE since cross-turn
 *  consumption landed (`findApprovedForDispatch`): the agent's
 *  re-issue on the next turn consumes the approval and dispatches.
 *  Deliberately clock-free — an approval that sits past the server's
 *  consumption TTL simply re-proposes a fresh card, which is
 *  self-explanatory in context. Cancelled gets no hint (terminal and
 *  self-evident); proposed state speaks through the buttons. */
const PLAN_APPROVED_HINT = 'Runs when you continue the conversation.';

export const bootstrapChatRoute = (
  opts: BootstrapChatRouteOptions,
): ChatRoute => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'bootstrapChatRoute: no document available - pass `opts.document` for non-browser environments',
    );
  }

  if (doc.head.querySelector(`style[${CHAT_ROUTE_STYLES_MARKER}]`) === null) {
    const style = doc.createElement('style');
    style.setAttribute(CHAT_ROUTE_STYLES_MARKER, '');
    style.textContent = CHAT_ROUTE_STYLES;
    doc.head.appendChild(style);
  }

  let disposed = false;
  let state: ChatRouteState = {
    phase: 'loading',
    sessions: [],
    activeSessionId: null,
    thread: initialChatThreadState(),
    error: null,
    sending: false,
    pending_turn_id: null,
    aiAvailable: null,
    transparency: DEFAULT_TRANSPARENCY_STREAM_SETTINGS,
    modelSources: null,
    defaultSourceId: null,
    draftSourceId: null,
  };

  // Shell-frame Step 3 — the composer's typed-but-unsent text, held in the
  // closure (NOT route state) so a re-render driven by a picker change or an
  // inbound broadcast re-applies it to the rebuilt textarea instead of
  // blanking mid-compose. Cleared on a successful send + on a context switch
  // (open another session / start a new chat).
  let composerDraft = '';

  // Ack-before-run — release the composer lock once the pending turn
  // settles (completed OR failure-painted). Pure over the route state;
  // applied after every thread update that could settle it.
  const settlePendingSend = (next: ChatRouteState): ChatRouteState => {
    if (next.pending_turn_id === null) return next;
    const settled =
      next.thread.completed_turn_ids.includes(next.pending_turn_id) ||
      next.thread.turn_failures.some(
        (f) => f.turn_id === next.pending_turn_id,
      );
    if (!settled) return next;
    return { ...next, sending: false, pending_turn_id: null };
  };

  const routeRoot = doc.createElement('div');
  routeRoot.setAttribute(CHAT_ROUTE_HOST_ATTR, '');

  const clearChildren = (node: HTMLElement): void => {
    while (node.firstChild) node.removeChild(node.firstChild);
  };

  // Activity disclosure — per-turn collapse memory (§ B.8.7 default
  // visible + collapse-all per turn). View-local like scroll position:
  // keyed by the rendered row's id (turn_id while in-flight, message id
  // after the swap — a collapse during streaming re-expands on the
  // authoritative row), survives re-renders, dies with the tab.
  const collapsedActivity = new Set<string>();

  const renderActivity = (
    host: HTMLElement,
    rows: ReadonlyArray<ChatActivityRow>,
    key: string,
  ): void => {
    if (rows.length === 0) return;
    const block = doc.createElement('div');
    block.setAttribute(CHAT_ROUTE_ACTIVITY_ATTR, '');
    const expanded = !collapsedActivity.has(key);
    const toggle = doc.createElement('button');
    toggle.type = 'button';
    toggle.setAttribute(CHAT_ROUTE_ACTIVITY_TOGGLE_ATTR, '');
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    toggle.textContent = `${expanded ? '▾' : '▸'} Activity (${rows.length})`;
    toggle.addEventListener('click', () => {
      if (collapsedActivity.has(key)) {
        collapsedActivity.delete(key);
      } else {
        collapsedActivity.add(key);
      }
      render();
    });
    block.appendChild(toggle);
    if (expanded) {
      for (const row of rows) {
        const line = doc.createElement('div');
        line.setAttribute(CHAT_ROUTE_ACTIVITY_ROW_ATTR, '');
        if (row.kind === 'tool') line.setAttribute('data-status', row.status);
        line.textContent = row.text;
        block.appendChild(line);
      }
    }
    host.appendChild(block);
  };

  const renderMessage = (
    host: HTMLElement,
    message: ChatMessage | { role: 'assistant'; content: string; id: string },
    activity: ReadonlyArray<ChatActivityRow> = [],
  ): void => {
    const row = doc.createElement('article');
    row.setAttribute(CHAT_ROUTE_MESSAGE_ATTR, '');
    row.setAttribute('data-role', message.role);
    const role = doc.createElement('span');
    role.className = 'chat-message-role';
    role.textContent = messageRoleLabel(message.role);
    row.appendChild(role);
    // Activity sits between the role label and the content on BOTH the
    // in-flight scaffold and the completed row (§ B.8.7 "between the
    // user message and the AI response") so the tool rows hold their
    // place through the message_complete swap.
    renderActivity(row, activity, message.id);
    const content = doc.createElement('div');
    content.className = 'chat-message-content';
    content.textContent = message.content;
    row.appendChild(content);
    host.appendChild(row);
  };

  // § A.11 — per-plan busy guard. View-local like `collapsedActivity`:
  // an in-flight approve / cancel rpc disables the card's buttons
  // through re-renders; dies with the tab.
  const pendingPlanActions = new Set<string>();

  // § A.11 — drive the approve / cancel rpc and apply the returned
  // authoritative plan optimistically. The `chat.plan_resolved`
  // broadcast also lands (multi-client fan-out) and no-ops on the
  // already-resolved card. An rpc failure (plan unknown after a server
  // restart — the store is in-memory — or already resolved from
  // another device) surfaces through the route's error line; the
  // broadcast path keeps the card itself truthful.
  const resolvePlan = async (
    plan_id: string,
    action: 'approve' | 'cancel',
  ): Promise<void> => {
    if (pendingPlanActions.has(plan_id)) return;
    pendingPlanActions.add(plan_id);
    render();
    try {
      const { plan } = await opts.conn(
        action === 'approve' ? 'chat.plan.approve' : 'chat.plan.cancel',
        { plan_id },
      );
      if (disposed) return;
      state = {
        ...state,
        thread: applyPlanResolution(state.thread, plan),
        error: null,
      };
    } catch (err) {
      if (disposed) return;
      state = { ...state, error: classifyRpcError(err) };
    } finally {
      pendingPlanActions.delete(plan_id);
      if (!disposed) render();
    }
  };

  // § A.11 — the plan-approval card: status + tool + tier + read-only
  // args, with Approve / Cancel while proposed. Painted under the
  // proposing turn's message (or its in-flight scaffold), like the
  // PB7 failure notice — the turn completes while the plan pends.
  const renderPlanCard = (host: HTMLElement, card: PlanApprovalCard): void => {
    const el = doc.createElement('div');
    el.setAttribute(CHAT_ROUTE_PLAN_CARD_ATTR, '');
    el.setAttribute('data-status', card.status);
    el.setAttribute('data-plan-id', card.plan_id);
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', `Plan approval: ${card.tool}`);

    const header = doc.createElement('div');
    header.className = 'chat-plan-card-header';
    const status = doc.createElement('span');
    status.className = 'chat-plan-card-status';
    status.textContent = planStatusLabel(card.status);
    header.appendChild(status);
    const tool = doc.createElement('span');
    tool.className = 'chat-plan-card-tool';
    tool.textContent = card.tool;
    header.appendChild(tool);
    const tier = doc.createElement('span');
    tier.className = 'chat-plan-card-tier';
    tier.textContent = `Tier ${card.tier}`;
    header.appendChild(tier);
    el.appendChild(header);

    if (card.status === 'approved') {
      const hint = doc.createElement('div');
      hint.className = 'chat-plan-card-hint';
      hint.textContent = PLAN_APPROVED_HINT;
      el.appendChild(hint);
    }

    const argsLabel = doc.createElement('span');
    argsLabel.className = 'chat-plan-card-args-label';
    argsLabel.textContent = 'Arguments';
    el.appendChild(argsLabel);
    const argsPre = doc.createElement('pre');
    argsPre.className = 'chat-plan-card-args';
    argsPre.textContent = formatPlanArgs(card.args);
    el.appendChild(argsPre);

    if (card.status === 'proposed') {
      const actions = doc.createElement('div');
      actions.className = 'chat-plan-card-actions';
      const busy = pendingPlanActions.has(card.plan_id);
      const approve = doc.createElement('button');
      approve.type = 'button';
      approve.setAttribute(CHAT_ROUTE_PLAN_APPROVE_ATTR, '');
      approve.textContent = busy ? 'Working...' : 'Approve';
      approve.disabled = busy;
      approve.addEventListener('click', () => {
        void resolvePlan(card.plan_id, 'approve');
      });
      actions.appendChild(approve);
      const cancel = doc.createElement('button');
      cancel.type = 'button';
      cancel.setAttribute(CHAT_ROUTE_PLAN_CANCEL_ATTR, '');
      cancel.textContent = 'Cancel';
      cancel.disabled = busy;
      cancel.addEventListener('click', () => {
        void resolvePlan(card.plan_id, 'cancel');
      });
      actions.appendChild(cancel);
      el.appendChild(actions);
    }
    host.appendChild(el);
  };

  // PB7 — failure notice painted directly under the failed turn's
  // message (or under the in-flight scaffold while the turn is open).
  // The copy comes from the contracts template registry via the
  // reducer's projection; `settings_link` mirrors the flow-09 banner's
  // Settings affordance for the no-source class.
  const renderTurnFailure = (
    host: HTMLElement,
    failure: TurnFailureNotice,
  ): void => {
    const notice = doc.createElement('div');
    notice.setAttribute(CHAT_ROUTE_TURN_FAILURE_ATTR, '');
    notice.setAttribute('role', 'status');
    const text = doc.createElement('span');
    text.textContent = failure.text;
    notice.appendChild(text);
    if (failure.settings_link) {
      const link = doc.createElement('a');
      link.setAttribute('href', serializeShellRoute('settings', 'ai-models'));
      link.textContent = 'Set up AI / Models →';
      notice.appendChild(link);
    }
    host.appendChild(notice);
  };

  // Shell-frame Step 3 — the model source the composer picker shows. An active
  // session matches its persisted routing (`{ layer, model_hint }`) to a
  // source; a DRAFT uses the fallback chain (§D.L1: explicit pick → global
  // default → first configured source, so the picker never shows an option the
  // send would not apply). `null` only while config + default are loading.
  const pickerSelectedSource = (): ChatModelSourceOption | null => {
    const sources = state.modelSources;
    if (sources === null || sources.length === 0) return null;
    if (state.thread.session !== null) {
      return matchChatModelSource(sources, state.thread.session.model_routing);
    }
    // DRAFT: an explicit pick, else the global default selected by EXACT
    // source id (D-174 R28 Slice A — no lossy layer fallback). NO blind
    // `sources[0]` fallback — `null` (default source not among the configured
    // options) → the picker shows a "choose a model" placeholder and a send
    // keeps the inherited default (fail-closed, never a silent upgrade).
    const fromDraft =
      state.draftSourceId !== null
        ? sources.find((s) => s.id === state.draftSourceId)
        : undefined;
    const fromDefault =
      state.defaultSourceId !== null
        ? sources.find((s) => s.id === state.defaultSourceId)
        : undefined;
    return fromDraft ?? fromDefault ?? null;
  };

  // Shell-frame Step 3 — the in-composer model picker (§D.L1). No source
  // configured → the picker IS the "Configure LLM →" link (fail loud, never
  // send into nothing). Otherwise a <select> over the CONFIGURED sources
  // (slots by role + free pool), each label carrying its provider — the
  // routed model is surfaced before a turn (§ A.14). No "(local)" badge:
  // there is no local-AI in the UI, only slot_1 / slot_2 / free_pool.
  const buildModelPicker = (): HTMLElement => {
    const slot = doc.createElement('div');
    slot.className = 'chat-composer-model';
    if (state.aiAvailable === false) {
      const link = doc.createElement('a');
      link.setAttribute(CHAT_ROUTE_MODEL_CONFIGURE_ATTR, '');
      link.setAttribute('href', serializeShellRoute('settings', 'ai-models'));
      link.textContent = 'Configure LLM →';
      slot.appendChild(link);
      return slot;
    }
    const sources = state.modelSources;
    if (sources === null || sources.length === 0) {
      // Config still loading (aiAvailable null) — a neutral placeholder
      // rather than a synthesized option set (D-148 § A.4).
      const muted = doc.createElement('span');
      muted.textContent = 'Model…';
      slot.appendChild(muted);
      return slot;
    }
    const selected = pickerSelectedSource();
    const select = doc.createElement('select');
    select.setAttribute(CHAT_ROUTE_MODEL_PICKER_ATTR, '');
    select.setAttribute('aria-label', 'Model');
    // When the current/default routing matches no configured source (e.g. a
    // stale persisted default whose slot is no longer configured), show a
    // leading placeholder so NO slot looks auto-selected — the user must choose, and a
    // send without choosing keeps the inherited (fail-closed) default.
    if (selected === null) {
      const placeholder = doc.createElement('option');
      (placeholder as { value: string }).value = '';
      placeholder.textContent = 'Choose a model';
      placeholder.setAttribute('disabled', '');
      placeholder.setAttribute('selected', '');
      select.appendChild(placeholder);
    }
    for (const opt of sources) {
      const optionEl = doc.createElement('option');
      (optionEl as { value: string }).value = opt.id;
      optionEl.textContent = opt.label;
      if (selected !== null && opt.id === selected.id) {
        optionEl.setAttribute('selected', '');
      }
      select.appendChild(optionEl);
    }
    (select as { value: string }).value = selected?.id ?? '';
    select.addEventListener('change', () => {
      const value = (select as { value: string }).value;
      // Ignore the placeholder ('') — only a real source selection persists.
      if (value.length > 0) void selectModelSource(value);
    });
    slot.appendChild(select);
    return slot;
  };

  // UX-review flow-09 — cold-start nudge element, rendered only on an
  // explicit `aiAvailable === false`; placed into whichever thread layout is
  // active (centered hero when empty, docked otherwise).
  const buildAiNotice = (): HTMLElement => {
    const aiNotice = doc.createElement('div');
    aiNotice.setAttribute(CHAT_ROUTE_AI_UNAVAILABLE_ATTR, '');
    aiNotice.setAttribute('id', CHAT_ROUTE_AI_UNAVAILABLE_ID);
    const noticeText = doc.createElement('span');
    noticeText.textContent =
      'No AI model is set up yet — add a key first to start chatting. ';
    aiNotice.appendChild(noticeText);
    const settingsLink = doc.createElement('a');
    settingsLink.setAttribute(
      'href',
      serializeShellRoute('settings', 'ai-models'),
    );
    settingsLink.textContent = 'Set up AI / Models →';
    aiNotice.appendChild(settingsLink);
    return aiNotice;
  };

  // ── Shell-frame Step 4 — the [✎ Create] overlay (§D.L1) ──
  interface ComposerAction {
    id: string;
    label: string;
    title: string;
    run: () => void;
  }

  // The [✎ Create] overlay is the shared `compose/create-overlay.ts` opener
  // (Step 5) — the SAME modal the §D.L2 drawer "Create" seat opens. The chat
  // route just holds the open handle so its `dispose()` can tear an open
  // capture down, and re-points its caller seam at the shared opener.
  let createOverlay: CreateOverlayHandle | null = null;

  const closeCreateOverlay = (): void => {
    if (createOverlay === null) return;
    const open = createOverlay;
    createOverlay = null;
    open.close();
  };

  const openCreateOverlay = (): void => {
    if (createOverlay !== null) return;
    // Portal to body so a chat re-render (which clears routeRoot) can't wipe an
    // open capture; the shared opener returns null when no write path is wired.
    createOverlay = openSharedCreateOverlay({
      document: doc,
      portal: (doc as { body?: HTMLElement }).body ?? routeRoot,
      ...(opts.contactUpsertCaller !== undefined
        ? { contactUpsertCaller: opts.contactUpsertCaller }
        : {}),
      ...(opts.workEntityUpsertCaller !== undefined
        ? { workEntityUpsertCaller: opts.workEntityUpsertCaller }
        : {}),
      // Keep the local handle in sync when the overlay closes itself (Close /
      // Escape / backdrop), so a later open mints a fresh one.
      onClose: () => {
        createOverlay = null;
      },
    });
  };

  // ── Shell-frame Step 4c — the [▶ Run a recipe] palette (§D.L1) ──
  let runPalette: RunPaletteHandle | null = null;

  const closeRunPalette = (): void => {
    if (runPalette === null) return;
    const open = runPalette;
    runPalette = null;
    open.destroy();
  };

  const openRunPalette = (): void => {
    if (runPalette !== null) return;
    const recipeList = opts.recipeListCaller;
    if (recipeList === undefined) return;
    runPalette = wireRunPalette({
      document: doc,
      recipeList,
      automationHref: (recipeId) => serializeShellRoute('automation', recipeId),
      ...(opts.recipeExecuteCaller !== undefined
        ? { execute: opts.recipeExecuteCaller }
        : {}),
      ...(opts.schedulesListCaller !== undefined
        ? { schedulesList: opts.schedulesListCaller }
        : {}),
      ...(opts.schedulesCreateCaller !== undefined
        ? { schedulesCreate: opts.schedulesCreateCaller }
        : {}),
      ...(opts.schedulesUpdateCaller !== undefined
        ? { schedulesUpdate: opts.schedulesUpdateCaller }
        : {}),
      ...(opts.schedulesDeleteCaller !== undefined
        ? { schedulesDelete: opts.schedulesDeleteCaller }
        : {}),
      ...(opts.autoRunListCaller !== undefined
        ? { autoRunList: opts.autoRunListCaller }
        : {}),
      ...(opts.autoRunUpdateCaller !== undefined
        ? { autoRunUpdate: opts.autoRunUpdateCaller }
        : {}),
      onClose: () => {
        runPalette = null;
      },
    });
    const portal = (doc as { body?: HTMLElement }).body ?? routeRoot;
    portal.appendChild(runPalette.element);
  };

  /** §D.L1 — the composer action list: [▶ Run a recipe] · [✎ Create]. Each
   *  appears only when its callers are wired. */
  const composerActions = (): ComposerAction[] => {
    const actions: ComposerAction[] = [];
    if (opts.recipeListCaller !== undefined) {
      actions.push({
        id: 'run',
        label: '▶ Run a recipe',
        title: 'Run, schedule, or arm a recipe',
        run: openRunPalette,
      });
    }
    if (
      opts.contactUpsertCaller !== undefined
      || opts.workEntityUpsertCaller !== undefined
    ) {
      actions.push({
        id: 'create',
        label: '✎ Create',
        title: 'Capture a contact, task, note, or commitment',
        run: openCreateOverlay,
      });
    }
    return actions;
  };

  const makeActionButton = (action: ComposerAction): HTMLElement => {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'chat-composer-action';
    button.setAttribute(CHAT_ROUTE_COMPOSER_ACTION_ATTR, action.id);
    button.setAttribute('title', action.title);
    button.textContent = action.label;
    button.addEventListener('click', () => {
      action.run();
    });
    return button;
  };

  /** The button chrome — an expanded row (empty hero) or a `+` disclosure
   *  menu (docked). null when no action is wired (nothing to show). */
  const buildComposerActions = (collapsed: boolean): HTMLElement | null => {
    const actions = composerActions();
    if (actions.length === 0) return null;
    if (collapsed) {
      const details = doc.createElement('details');
      details.className = 'chat-composer-more';
      details.setAttribute(CHAT_ROUTE_COMPOSER_MORE_ATTR, '');
      const summary = doc.createElement('summary');
      summary.setAttribute('aria-label', 'More actions');
      summary.textContent = '+';
      details.appendChild(summary);
      const menu = doc.createElement('div');
      menu.className = 'chat-composer-actions chat-composer-actions--menu';
      menu.setAttribute(CHAT_ROUTE_COMPOSER_ACTIONS_ATTR, '');
      for (const action of actions) {
        const button = makeActionButton(action);
        button.addEventListener('click', () => {
          (details as { open?: boolean }).open = false;
        });
        menu.appendChild(button);
      }
      details.appendChild(menu);
      return details;
    }
    const row = doc.createElement('div');
    row.className = 'chat-composer-actions';
    row.setAttribute(CHAT_ROUTE_COMPOSER_ACTIONS_ATTR, '');
    for (const action of actions) row.appendChild(makeActionButton(action));
    return row;
  };

  // Shell-frame Step 3 — the composer: a toolbar row (model picker) above the
  // input row (textarea + Send). Send stays ENABLED in the draft state (the
  // first send mints the session lazily); only the in-flight + AI-unavailable
  // reasons disable it now (the no-session reason is gone). Step 4 — when
  // `collapsed` (docked), the toolbar also carries the `+` actions menu.
  const buildComposer = (collapsed: boolean): HTMLElement => {
    const composer = doc.createElement('div');
    composer.className = 'chat-composer';
    composer.setAttribute(CHAT_ROUTE_COMPOSER_ATTR, '');

    const toolbar = doc.createElement('div');
    toolbar.className = 'chat-composer-toolbar';
    toolbar.appendChild(buildModelPicker());
    // Docked — collapse the composer buttons into a `+` menu in the toolbar.
    if (collapsed) {
      const more = buildComposerActions(true);
      if (more !== null) toolbar.appendChild(more);
    }
    composer.appendChild(toolbar);

    const inputRow = doc.createElement('div');
    inputRow.className = 'chat-composer-input-row';
    const input = doc.createElement('textarea');
    input.setAttribute(CHAT_ROUTE_INPUT_ATTR, '');
    input.setAttribute('placeholder', 'Ask Recued...');
    (input as { value: string }).value = composerDraft;
    input.addEventListener('input', () => {
      composerDraft = (input as { value?: string }).value ?? '';
    });
    const send = doc.createElement('button');
    send.type = 'button';
    send.setAttribute(CHAT_ROUTE_SEND_ATTR, '');
    send.textContent = state.sending ? 'Sending...' : 'Send';
    const aiUnavailable = state.aiAvailable === false;
    if (state.sending || aiUnavailable) {
      send.disabled = true;
    }
    if (aiUnavailable) {
      // Accessible disabled reason: tooltip for sighted users + an
      // aria-describedby pointing at the visible banner for AT.
      send.setAttribute(
        'title',
        'No AI model is configured. Set up AI / Models to start chatting.',
      );
      send.setAttribute('aria-describedby', CHAT_ROUTE_AI_UNAVAILABLE_ID);
    }
    send.addEventListener('click', () => {
      void sendMessage(composerDraft);
    });
    inputRow.appendChild(input);
    inputRow.appendChild(send);
    composer.appendChild(inputRow);
    return composer;
  };

  const render = (): void => {
    if (disposed) return;
    clearChildren(routeRoot);

    const header = doc.createElement('header');
    header.className = 'chat-route-header';
    const heading = doc.createElement('h1');
    heading.className = 'chat-route-title';
    heading.setAttribute(CHAT_ROUTE_HEADING_ATTR, '');
    heading.textContent = 'Chat';
    header.appendChild(heading);
    routeRoot.appendChild(header);

    // Chat errors are user-facing — a send / plan action or the initial load —
    // so they always show inline, humanized (Tier 1: no raw method / ms / code
    // leaks; the global offline banner is additive). Only a teardown/abort race
    // is suppressed. A connection-caused one carries a calm style hint.
    if (state.error !== null && !state.error.suppressible) {
      const error = doc.createElement('div');
      error.setAttribute(CHAT_ROUTE_ERROR_ATTR, '');
      if (state.error.connectionCaused) error.setAttribute('data-connection', 'true');
      error.textContent = state.error.copy;
      routeRoot.appendChild(error);
    }

    const shell = doc.createElement('div');
    shell.className = 'chat-route-shell';

    const sessions = doc.createElement('aside');
    sessions.setAttribute(CHAT_ROUTE_SESSION_LIST_ATTR, '');
    const newButton = doc.createElement('button');
    newButton.type = 'button';
    newButton.setAttribute(CHAT_ROUTE_NEW_SESSION_ATTR, '');
    newButton.textContent = 'New chat';
    newButton.addEventListener('click', () => {
      startNewChat();
    });
    sessions.appendChild(newButton);
    if (state.phase === 'loading') {
      const loading = doc.createElement('div');
      loading.className = 'chat-route-muted';
      loading.textContent = 'Loading chats...';
      sessions.appendChild(loading);
    } else if (state.sessions.length === 0) {
      const empty = doc.createElement('div');
      empty.className = 'chat-route-muted';
      empty.textContent = 'No saved chats yet.';
      sessions.appendChild(empty);
    } else {
      for (const session of state.sessions) {
        const row = doc.createElement('button');
        row.type = 'button';
        row.setAttribute(CHAT_ROUTE_SESSION_ROW_ATTR, session.id);
        row.setAttribute(
          'data-active',
          session.id === state.activeSessionId ? 'true' : 'false',
        );
        const title = doc.createElement('span');
        title.className = 'chat-session-title';
        title.textContent = sessionTitle(session);
        row.appendChild(title);
        const meta = doc.createElement('span');
        meta.className = 'chat-session-meta';
        meta.textContent =
          `${session.message_count} messages - ${formatRelative(session.last_active_at)}`;
        row.appendChild(meta);
        row.addEventListener('click', () => {
          void openSession(session.id);
        });
        sessions.appendChild(row);
      }
    }
    shell.appendChild(sessions);

    const thread = doc.createElement('section');
    thread.setAttribute(CHAT_ROUTE_THREAD_ATTR, '');
    // Centered → docked (§D.L1): an empty thread (no messages, no in-flight
    // turn) centers a greeting + composer; the first send docks the composer
    // to the bottom and lets the conversation fill above.
    const isEmpty =
      state.thread.messages.length === 0 && state.thread.inflight === null;
    thread.setAttribute('data-empty', isEmpty ? 'true' : 'false');

    const aiNotice = state.aiAvailable === false ? buildAiNotice() : null;

    if (isEmpty) {
      const hero = doc.createElement('div');
      hero.className = 'chat-thread-hero';
      const greeting = doc.createElement('div');
      greeting.className = 'chat-thread-greeting';
      greeting.setAttribute(CHAT_ROUTE_GREETING_ATTR, '');
      greeting.textContent = 'What can Recued help you with?';
      hero.appendChild(greeting);
      if (aiNotice !== null) hero.appendChild(aiNotice);
      // Empty hero — composer centered, the buttons expanded below it.
      hero.appendChild(buildComposer(false));
      const actions = buildComposerActions(false);
      if (actions !== null) hero.appendChild(actions);
      thread.appendChild(hero);
    } else {
      // Docked layout — session-title header (the model picker moved into the
      // composer per §D.L1, so the header no longer carries a routing badge).
      const threadHeader = doc.createElement('header');
      threadHeader.className = 'chat-thread-header';
      const threadTitle = doc.createElement('h2');
      threadTitle.className = 'chat-thread-title';
      threadTitle.textContent = sessionTitle(state.thread.session);
      threadHeader.appendChild(threadTitle);
      thread.appendChild(threadHeader);

      const messages = doc.createElement('div');
      messages.className = 'chat-thread-messages';
      const failuresByMessageId = new Map<string, TurnFailureNotice>();
      const failuresByTurnId = new Map<string, TurnFailureNotice>();
      for (const failure of state.thread.turn_failures) {
        if (failure.message_id !== undefined) {
          failuresByMessageId.set(failure.message_id, failure);
        }
        failuresByTurnId.set(failure.turn_id, failure);
      }
      // § A.11 — cards anchor to their persisted message once stamped;
      // un-stamped cards paint under the matching in-flight scaffold
      // (same anchoring + stale-scaffold dedup discipline as the PB7
      // failure notice). A turn can hold several cards — render all,
      // in proposal order. `paintedPlanIds` makes rendering TOTAL:
      // any card neither anchor claims (a resolution materialized on
      // a client that never saw the proposal; a proposal replayed
      // after its turn completed — no stamping pass can reach either,
      // since `ChatMessage` carries no turn linkage) tail-paints
      // after the thread instead of sitting invisible in state
      // (codex review MEDIUM fold).
      const paintedPlanIds = new Set<string>();
      const cardsByMessageId = new Map<string, PlanApprovalCard[]>();
      for (const card of state.thread.plan_cards) {
        if (card.message_id === undefined) continue;
        const list = cardsByMessageId.get(card.message_id);
        if (list === undefined) cardsByMessageId.set(card.message_id, [card]);
        else list.push(card);
      }
      for (const message of state.thread.messages) {
        renderMessage(messages, message, projectMessageActivity(message));
        for (const card of cardsByMessageId.get(message.id) ?? []) {
          renderPlanCard(messages, card);
          paintedPlanIds.add(card.plan_id);
        }
        const failure = failuresByMessageId.get(message.id);
        if (failure !== undefined) renderTurnFailure(messages, failure);
      }
      if (state.thread.inflight !== null) {
        renderMessage(
          messages,
          {
            id: state.thread.inflight.turn_id,
            role: 'assistant',
            content: state.thread.inflight.assistant_content,
          },
          projectInFlightActivity(state.thread.inflight, state.transparency),
        );
        for (const card of state.thread.plan_cards) {
          if (
            card.message_id === undefined &&
            card.turn_id === state.thread.inflight.turn_id
          ) {
            renderPlanCard(messages, card);
            paintedPlanIds.add(card.plan_id);
          }
        }
        // A notice already stamped with a message_id painted above
        // under its completed message — production's ack-after-run
        // ordering can leave a stale scaffold for that same turn, and
        // painting here too would duplicate the notice.
        const failure = failuresByTurnId.get(state.thread.inflight.turn_id);
        if (failure !== undefined && failure.message_id === undefined) {
          renderTurnFailure(messages, failure);
        }
      }
      for (const card of state.thread.plan_cards) {
        if (!paintedPlanIds.has(card.plan_id)) {
          renderPlanCard(messages, card);
        }
      }
      thread.appendChild(messages);
      // UX-review flow-09 — cold-start nudge, docked above the composer.
      if (aiNotice !== null) thread.appendChild(aiNotice);
      // Docked — composer at the bottom; buttons collapse into its `+` menu.
      thread.appendChild(buildComposer(true));
    }
    shell.appendChild(thread);

    routeRoot.appendChild(shell);
  };

  const loadSessions = async (): Promise<void> => {
    state = { ...state, phase: 'loading', error: null };
    render();
    try {
      const { sessions } = await opts.conn('chat.sessions.list');
      if (disposed) return;
      state = { ...state, phase: 'ready', sessions, error: null };
      render();
    } catch (err) {
      if (disposed) return;
      state = { ...state, phase: 'error', error: classifyRpcError(err) };
      render();
    }
  };

  // UX-review flow-09 — fetch the D-079 LLM config once at boot and project
  // it to a tri-state `aiAvailable`. A read failure leaves the signal `null`
  // (no banner): this is a soft cold-start nudge, not a readiness guarantee.
  //
  // Granularity note (codex P1): `server.getLLMConfig` returns the LIVE
  // manager config, whereas the chat turn executor runs against the
  // boot-frozen `llmConfig` snapshot (`wire-llm-substrate.ts`: "write-once at
  // boot ... frozen thereafter"; `setLLMConfig` mutates the manager with no
  // orchestrator refresh). So a key saved mid-session clears this banner
  // BEFORE a server restart makes that key usable for a turn. That window is
  // exactly the runtime gap the executor's loud NO_LLM_SOURCE failure
  // backstops — and it is no worse than the pre-affordance default (composer
  // always enabled). The proper closure is a live-config refresh in the chat
  // orchestrator (out of scope for this client-side affordance; tracked as a
  // backend follow-up).
  const loadAiAvailability = async (): Promise<void> => {
    try {
      const { config } = await opts.conn('server.getLLMConfig');
      if (disposed) return;
      const available = isAnyAiSourceConfigured(config);
      // Shell-frame Step 3 — project the SAME config to the slot-based source
      // list the composer picker renders (so picker + Send-gate read one
      // source of truth).
      const modelSources = buildChatModelSourceOptions(
        config as LlmConfigRecord,
      );
      state = { ...state, aiAvailable: available, modelSources };
      render();
    } catch {
      /* soft signal — leave `aiAvailable` / `modelSources` as-is */
    }
  };

  // Shell-frame Step 3 — read the per-pair global chat-model default `source_id`
  // once at mount; it seeds the composer picker for a DRAFT (not-yet-created)
  // session ("scope = last-used on this client, seeded from global default").
  // Soft signal: a read failure / no-default leaves `defaultSourceId` null (the
  // draft picker then falls back to the first configured source).
  const loadDefaultModelPref = async (): Promise<void> => {
    try {
      const { source_id } = await opts.conn('chat.default_model_pref.get');
      if (disposed) return;
      state = {
        ...state,
        defaultSourceId: isChatModelSourceId(source_id) ? source_id : null,
      };
      render();
    } catch {
      /* soft signal — leave `defaultSourceId` null */
    }
  };

  // § B.8.9 — resolve the per-pair transparency visibility policy once
  // at mount. Soft signal like the LLM-config read: a failed `prefs.get`
  // (older server, offline boot, test conn without the method) leaves
  // the substrate defaults in place rather than blanking the stream.
  const loadTransparencySettings = async (): Promise<void> => {
    try {
      const { prefs } = await opts.conn('prefs.get');
      if (disposed) return;
      state = {
        ...state,
        transparency: transparencyStreamSettingsFromPrefs(prefs),
      };
      render();
    } catch {
      /* soft signal — substrate defaults stay in effect */
    }
  };

  const openSession = async (sessionId: string): Promise<void> => {
    try {
      const snapshot = await opts.conn('chat.session.get', { session_id: sessionId });
      if (disposed) return;
      // Switching threads abandons any typed-but-unsent draft.
      composerDraft = '';
      state = {
        ...state,
        activeSessionId: sessionId,
        thread: hydrateThreadFromSnapshot(initialChatThreadState(), snapshot),
        error: null,
        // A pending turn belongs to the session being left — its events
        // are session-gated and would never settle this lock.
        sending: false,
        pending_turn_id: null,
      };
      render();
    } catch (err) {
      if (disposed) return;
      state = { ...state, error: classifyRpcError(err) };
      render();
    }
  };

  // Shell-frame Step 3 — "New chat" enters the lazy DRAFT state (NO rpc); the
  // session is minted on the first send, so the history holds only real
  // sessions (fixes the eager-create junk). A no-op ONLY when already in a
  // BLANK draft — "New chat while blank → no-op" (§D.L1); a draft with typed
  // text resets to blank.
  const startNewChat = (): void => {
    if (
      state.thread.session === null
      && state.activeSessionId === null
      && composerDraft.trim().length === 0
    ) {
      return;
    }
    composerDraft = '';
    state = {
      ...state,
      activeSessionId: null,
      thread: initialChatThreadState(),
      error: null,
      sending: false,
      pending_turn_id: null,
    };
    render();
  };

  // Shell-frame Step 3 — composer model picker. An active session persists its
  // source (layer + § A.14 slot hint) via `set_model_pref` (which broadcasts
  // `chat.session_changed` so every paired client re-renders); a DRAFT (no
  // session yet) just remembers the pick — the in-mount "last-used" — and the
  // session inherits it on first send.
  const selectModelSource = async (sourceId: string): Promise<void> => {
    const source =
      state.modelSources?.find((s) => s.id === sourceId) ?? null;
    if (source === null) return;
    const session = state.thread.session;
    if (session === null) {
      if (state.draftSourceId === source.id) return;
      state = { ...state, draftSourceId: source.id };
      render();
      return;
    }
    if (
      session.model_routing.current === source.layer
      && (session.model_routing.model_hint ?? undefined)
        === (source.model_hint ?? undefined)
      // D-191 Phase 6 — also compare the EXACT picked slot: two slots can share
      // a layer + speed (same-speed local+remote), so without this a switch
      // between them would be skipped as a no-op and the pin would never update.
      && (session.model_routing.source_id ?? undefined) === source.id
    ) {
      return;
    }
    try {
      await opts.conn('chat.session.set_model_pref', {
        session_id: session.id,
        model_pref: {
          current: source.layer,
          ...(source.model_hint ? { model_hint: source.model_hint } : {}),
          source_id: source.id,
        },
      });
      if (disposed) return;
      // The thread may have CHANGED during the await (the user opened another
      // session / started a draft) — only apply the optimistic reflect if it
      // is still the same session; otherwise the `model_pref` broadcast
      // reconciles the correct thread.
      if (state.thread.session?.id !== session.id) return;
      // Optimistic local reflect — the broadcast also lands and reduces
      // idempotently. Match the reducer: REPLACE model_routing wholesale (the
      // server drops any prior provider/model_id on a set).
      state = {
        ...state,
        thread: {
          ...state.thread,
          session: {
            ...state.thread.session,
            model_routing: {
              current: source.layer,
              ...(source.model_hint ? { model_hint: source.model_hint } : {}),
              source_id: source.id,
              overridden: true,
            },
          },
        },
      };
      render();
    } catch (err) {
      if (disposed) return;
      state = { ...state, error: classifyRpcError(err) };
      render();
    }
  };

  // Shell-frame Step 3 — lazy session creation: mint + open the session on
  // the first send (titled from the first words), applying the draft model
  // layer if the user diverged from the inherited default before sending.
  // Returns the created session, or null when create/open failed (the error
  // is surfaced) or the route was disposed.
  const ensureSessionForDraft = async (
    firstMessage: string,
  ): Promise<ChatSession | null> => {
    // Capture the draft picker's selected source BEFORE creating — the session
    // is still null here, so `pickerSelectedSource` resolves the draft fallback
    // chain (explicit pick → global default → first configured source).
    const draftSource = pickerSelectedSource();
    try {
      const { session_id } = await opts.conn('chat.session.create', {
        title: deriveSessionTitle(firstMessage),
      });
      if (disposed) return null;
      const snapshot = await opts.conn('chat.session.get', {
        session_id,
      });
      if (disposed) return null;
      let thread = hydrateThreadFromSnapshot(initialChatThreadState(), snapshot);
      // Apply the SOURCE the draft picker displayed (layer + § A.14 slot hint)
      // so the new session routes to what the user saw; skip the rpc when it
      // already matches the inherited default (the session just inherits it).
      if (thread.session !== null && draftSource !== null) {
        const inherited = thread.session.model_routing;
        const diverges =
          inherited.current !== draftSource.layer
          || (inherited.model_hint ?? undefined)
            !== (draftSource.model_hint ?? undefined)
          // D-191 Phase 6 — a same-speed slot switch diverges only by slot key.
          || (inherited.source_id ?? undefined) !== draftSource.id;
        if (diverges) {
          await opts.conn('chat.session.set_model_pref', {
            session_id,
            model_pref: {
              current: draftSource.layer,
              ...(draftSource.model_hint
                ? { model_hint: draftSource.model_hint }
                : {}),
              source_id: draftSource.id,
            },
          });
          if (disposed) return null;
          thread = {
            ...thread,
            session: {
              ...thread.session,
              // Match the reducer — REPLACE model_routing wholesale.
              model_routing: {
                current: draftSource.layer,
                ...(draftSource.model_hint
                  ? { model_hint: draftSource.model_hint }
                  : {}),
                source_id: draftSource.id,
                overridden: true,
              },
            },
          };
        }
      }
      state = {
        ...state,
        activeSessionId: session_id,
        thread,
        error: null,
        // PRESERVE the send lock `sendMessage` set before calling us (do NOT
        // reset `sending`) — clearing it here would re-open the double-send
        // window. A fresh session has no pending turn.
        pending_turn_id: null,
      };
      render();
      // Refresh the sidebar to include the new session (don't block the send).
      void loadSessions();
      return thread.session;
    } catch (err) {
      if (disposed) return null;
      state = { ...state, error: classifyRpcError(err) };
      render();
      return null;
    }
  };

  const createSession = async (title?: string): Promise<void> => {
    try {
      const { session_id } = title !== undefined
        ? await opts.conn('chat.session.create', { title })
        : await opts.conn('chat.session.create');
      if (disposed) return;
      await loadSessions();
      await openSession(session_id);
    } catch (err) {
      if (disposed) return;
      state = { ...state, error: classifyRpcError(err) };
      render();
    }
  };

  const sendMessage = async (message: string): Promise<void> => {
    const trimmed = message.trim();
    if (trimmed.length === 0 || state.sending) return;

    // Lock the composer IMMEDIATELY — BEFORE the (awaited) lazy session
    // create — so a second click / Enter during create can't mint a second
    // session and dispatch a second turn (the draft Send is otherwise enabled).
    state = { ...state, sending: true, error: null };
    render();

    // Lazy session — a DRAFT thread (no active session) mints + opens its
    // session HERE, on the first send, before the turn is dispatched. A blank
    // input never reaches this point, so no empty session is ever created.
    let session = state.thread.session;
    if (session === null) {
      session = await ensureSessionForDraft(trimmed);
      if (session === null) {
        // Create/open failed (the error is surfaced) or disposed — release the
        // lock so the user can retry (`ensureSessionForDraft` PRESERVES the
        // lock on success, so the send path inherits it).
        if (!disposed && state.sending) {
          state = { ...state, sending: false };
          render();
        }
        return;
      }
    }
    try {
      // D-193 — the browser's current IANA timezone. The server threads it
      // into the chat prompt's current-time anchor so the model resolves
      // "remind me at 3pm" in the USER's zone, not the server's (matters
      // when the server is a VPS in another region). Absent ⇒ server-local.
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const { turn_id } = await opts.conn('chat.send', {
        session_id: session.id,
        message: trimmed,
        picker_state: session.picker_state,
        model_pref: {
          current: session.model_routing.current,
          ...(session.model_routing.model_hint
            ? { model_hint: session.model_routing.model_hint }
            : {}),
          // D-191 Phase 6 — carry the picked slot so the turn pins it.
          ...(session.model_routing.source_id
            ? { source_id: session.model_routing.source_id }
            : {}),
        },
        ...(timeZone ? { time_zone: timeZone } : {}),
      });
      if (disposed) return;
      // Accepted (the user message is durable) — clear the unsent draft, but
      // ONLY if it is still the text we sent. The textarea stays enabled while
      // sending, so text typed during the pending send must survive the ack.
      if (composerDraft === message) composerDraft = '';
      // Ack-before-run — the ack means ACCEPTED, not finished: keep the
      // composer locked on this turn until it settles (immediately,
      // under an ack-after-run server whose completion already reduced).
      state = settlePendingSend({
        ...state,
        pending_turn_id: turn_id,
        thread: beginInFlightTurn(state.thread, turn_id),
      });
      render();
    } catch (err) {
      if (disposed) return;
      state = { ...state, sending: false, error: classifyRpcError(err) };
      render();
    }
  };

  const unsubscribers: Array<() => void> = [];
  if (opts.subscribe !== undefined) {
    for (const kind of [
      'chat.token_streamed',
      'chat.tool_call_started',
      'chat.tool_call_completed',
      'chat.plan_proposed',
      'chat.plan_resolved',
      'chat.transparency',
      'chat.message_complete',
      'chat.session_changed',
      'chat.default_model_pref_changed',
    ] as const) {
      unsubscribers.push(
        opts.subscribe(kind, (event) => {
          if (!isChatThreadEvent(event)) return;
          let nextState = state;
          let changed = false;
          // Shell-frame Step 3 — keep the draft-picker seed in sync with the
          // per-pair global default `source_id` (D-174 R28 Slice A). The event
          // ALSO carries a transient `{layer, model_hint}` snapshot that
          // `reduceChatThreadEvent` (below) reduces into an inherited open
          // session's badge — that path is untouched.
          const evt = event as {
            kind?: string;
            source_id?: unknown;
          };
          if (evt.kind === 'chat.default_model_pref_changed') {
            nextState = {
              ...nextState,
              defaultSourceId: isChatModelSourceId(evt.source_id)
                ? evt.source_id
                : null,
            };
            changed = true;
          }
          const next = reduceChatThreadEvent(nextState.thread, event);
          if (next !== nextState.thread) {
            nextState = settlePendingSend({ ...nextState, thread: next });
            changed = true;
          }
          if (!changed) return;
          state = nextState;
          render();
        }),
      );
    }
  }

  opts.root.appendChild(routeRoot);
  render();
  void loadSessions();
  void loadAiAvailability();
  void loadDefaultModelPref();
  void loadTransparencySettings();

  return {
    getSessions: () => state.sessions,
    getThread: () => state.thread,
    refresh: () => loadSessions(),
    openSession: (sessionId) => openSession(sessionId),
    createSession: (title) => createSession(title),
    sendMessage: (message) => sendMessage(message),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      // The Create overlay + Run palette are portaled to body — detach them.
      closeCreateOverlay();
      closeRunPalette();
      for (const unsub of unsubscribers) {
        try {
          unsub();
        } catch {
          /* ignore subscriber teardown failures */
        }
      }
      unsubscribers.length = 0;
      try {
        opts.root.removeChild(routeRoot);
      } catch {
        routeRoot.remove();
      }
    },
  };
};
