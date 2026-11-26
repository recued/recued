/** D-174 / R20 — top-level Approvals deep queue: the "waiting on me" yes/no list.
 *
 *  `#approvals` is ONE unified, transient pending-decisions list — D-157
 *  approval gates + D-158 asks interleaved oldest-first, with NO gate-vs-ask
 *  sections (R20 drops the "Approvals vs Asks" taxonomy; it's one "waiting on
 *  me" concept). Rows clear as they resolve. Runs owns resolved/audit history;
 *  this route renders only pending work and links outward for audit/detail.
 *
 *  The asks sub-state (seed + live `notification.ask`/`ask_closed` refresh +
 *  first-answer-wins submit) is still managed by the proven `asks-panel` mount,
 *  run HEADLESS. Durable Chat plans come from the bootstrap-scoped reconciled
 *  inbox; this route owns one interleaved rendering for all three kinds.
 */

import {
  APPROVAL_CARD_ACTION_ATTR,
  APPROVAL_CARD_STYLES,
  ASK_CARD_OPTION_ATTR,
  CHAT_PLAN_CARD_ACTION_ATTR,
  formatAskAge,
  renderApprovalCard,
  renderAskCard,
  renderChatPlanCard,
  type ApprovalCardDecision,
  type ChatPlanCardDecision,
} from '@recued/ui-shared/approval-card';
import { PRIMITIVE_STYLES } from '@recued/ui-shared/primitives';
import { renderActionLabel } from '@recued/ui-shared/icon-render';
import { APPROVAL_VIEW_NAV_STYLES, createApprovalViewNav } from './review-layout.js';
import { APPROVALS_ROUTE_CHROME_STYLES } from './decisions-workspace-styles.js';
import { canonicalJSONStringify } from '@recued/contracts';
import type {
  ServerApprovalResolveResult,
  ServerApprovalSubscriptionEvent,
  ServerPendingApproval,
  ServerPendingAsk,
} from '@recued/contracts';

import {
  ASKS_PANEL_STYLES,
  mountAsksPanel,
  type AsksListCaller,
  type AsksPanelMount,
  type AsksPanelState,
  type AsksGiveSecretCaller,
  type AsksSubmitAnswerCaller,
} from './asks-panel.js';
import {
  heldAskChatLink,
  pendingChatPlanHref,
  pendingChatPlanResolutionCopy,
  type PendingChatPlan,
  type PendingChatPlanResolution,
  type PendingChatPlansStoreState,
} from './pending-chat-plans-store.js';
import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import type { WebclientReconnectSubscriber } from '../realtime/connection-status.js';
import {
  classifyRpcError,
  humanizeRpcError,
  resolveSurfaceErrorDisplay,
  type SurfaceErrorEntry,
} from '../shell/rpc-error-copy.js';
import { serializeShellRoute } from '../shell/route.js';
import { preapprovalHref, renderPreapprovalAsk } from './preapproval-route.js';
import { localChangesHref } from './local-change-sets-route.js';
import { createAskNoteDrafts } from './ask-note-drafts.js';
import { onServerPauseChange } from '../shell/server-pause-signal.js';
import { decisionSearchTerms, decisionSearchText, decisionTextMatches, type DecisionFilter, type DecisionKind } from './decision-search.js';

// ════════════════════════════════════════════════════════════════
// Style payload + stable attribute hooks
// ════════════════════════════════════════════════════════════════

/** Marker on the injected `<style>` tag — re-bootstrap / concurrent
 *  route instances find it and skip the duplicate injection. */
export const APPROVALS_ROUTE_STYLES_MARKER = 'data-recued-approvals-styles';

/** The route shell wrapper the route owns inside the caller's `root`.
 *  `dispose()` removes this node; the injected `<style>` stays (global,
 *  idempotent, may be shared by a re-mount). */
export const APPROVALS_ROUTE_HOST_ATTR = 'data-recued-approvals-route';

/** Stable hooks for tests + host introspection. */
export const APPROVALS_ROUTE_HEADING_ATTR = 'data-recued-approvals-heading';
export const APPROVALS_ROUTE_SUMMARY_ATTR =
  'data-recued-approvals-summary';
/** The single unified pending-decisions list (R20 — gates + asks, no
 *  per-kind sections). */
export const APPROVALS_ROUTE_LIST_ATTR =
  'data-recued-approvals-list';
export const APPROVALS_ROUTE_LIST_HEADING_ATTR =
  'data-recued-approvals-list-heading';
/** R17 — a uniform per-card hook carrying the row's id (approval_id / ask_id /
 *  plan_id), so a run-scoped `#approvals/<id>` deep link from the Runs detail
 *  can find + highlight the exact card regardless of its kind. */
export const APPROVALS_ROUTE_FOCUS_ATTR = 'data-recued-approvals-focus';
export const APPROVALS_ROUTE_EMPTY_ATTR = 'data-recued-approvals-empty';
export const APPROVALS_ROUTE_LOADING_ATTR = 'data-recued-approvals-loading';
export const APPROVALS_ROUTE_ERROR_ATTR = 'data-recued-approvals-error';
export const APPROVALS_ROUTE_REFRESH_ATTR = 'data-recued-approvals-refresh';
/** Ephemeral post-decision handoff; resolved history still belongs to Chat/Runs. */
export const APPROVALS_ROUTE_PLAN_RESOLUTION_ATTR =
  'data-recued-approvals-plan-resolution';
export const APPROVALS_ROUTE_PLAN_RESOLUTION_LINK_ATTR =
  'data-recued-approvals-plan-resolution-link';
export const APPROVALS_ROUTE_PLAN_RESOLUTION_DISMISS_ATTR =
  'data-recued-approvals-plan-resolution-dismiss';
export const APPROVALS_ROUTE_PLAN_RESOLUTION_ANNOUNCER_ATTR =
  'data-recued-approvals-plan-resolution-announcer';


/** Aggregated CSS payload injected once by `bootstrapApprovalsRoute`.
 *  Order: primitives → shared ask-card/panel → shared approval card →
 *  route chrome. */
export const APPROVALS_ROUTE_STYLES = [
  PRIMITIVE_STYLES,
  ASKS_PANEL_STYLES,
  APPROVAL_CARD_STYLES,
  APPROVAL_VIEW_NAV_STYLES,
  APPROVALS_ROUTE_CHROME_STYLES,
].join('\n');

// ════════════════════════════════════════════════════════════════
// Options + handle
// ════════════════════════════════════════════════════════════════

export type ApprovalQueueState = 'loading' | 'ready' | 'error';

export type ApprovalListCaller = () => Promise<{
  approvals: ReadonlyArray<ServerPendingApproval>;
}>;

export type ApprovalResolveCaller = (args: {
  approval_id: string;
  decision: 'approve' | 'reject' | 'cancel';
  note?: string;
}) => Promise<ServerApprovalResolveResult>;

export type ApprovalSubscribeCaller = () => Promise<{
  approvals: ReadonlyArray<ServerPendingApproval>;
  seq: number;
}>;

export type ApprovalChangedSubscriber = (
  listener: (event: ServerApprovalSubscriptionEvent) => void,
) => () => void;

/** D-174 #4 — soft name-resolution seams for the approval card meta. Both
 *  reuse callers the host already builds (`recipe.list` / `pair.list`);
 *  absent or failed, the card falls back to the raw ids. */
export type ApprovalsRecipeNamesCaller = () => Promise<{
  recipes: ReadonlyArray<{ recipe_id: string; name?: string }>;
}>;
export type ApprovalsPairListCaller = () => Promise<{
  devices: ReadonlyArray<{ instance_id: string; display_name?: string }>;
}>;

export interface BootstrapApprovalsRouteOptions {
  root: HTMLElement;
  document?: Document;
  /** `approval.list` caller seam — pending approval gates. */
  runApprovalList: ApprovalListCaller;
  /** `approval.resolve` caller seam — approve / reject pending gates. */
  runApprovalResolve: ApprovalResolveCaller;
  /** `approval.subscribe` caller seam — opens server push updates. */
  runApprovalSubscribe: ApprovalSubscribeCaller;
  /** Raw pair-WS `approval_changed` listener seam produced by
   *  `approval.subscribe`. */
  onApprovalChanged?: ApprovalChangedSubscriber;
  /** `notification.pending_asks` caller seam — forwarded to the asks panel. */
  runList: AsksListCaller;
  /** `notification.submitAnswer` caller seam — forwarded to the asks panel. */
  runSubmitAnswer: AsksSubmitAnswerCaller;
  /** D-335 slice Z — `notification.giveSecret` caller seam, for a secret ask's card. */
  runGiveSecret?: AsksGiveSecretCaller;
  /** Broadcast subscription seam. Used for asks and generic approval bus
   *  invalidations. */
  subscribe?: BroadcastSubscriber['on'];
  /** Reconnect seam — fires on each transition into `connected`. The route
   *  re-arms its one-shot `approval.subscribe` here so a restarted server
   *  re-registers this client + any stale `liveError` clears, and refreshes
   *  the list to catch what changed while disconnected. */
  reconnect?: WebclientReconnectSubscriber;
  /** D-174 #4 — resolve recipe_id → name for the card meta. */
  recipeNamesCaller?: ApprovalsRecipeNamesCaller;
  /** D-174 #4 — resolve initiator_instance → device name for the card meta. */
  pairListCaller?: ApprovalsPairListCaller;
  /** R17 — the run-scoped focus deep link. When the route is mounted at
   *  `#approvals/<id>` (e.g. from a Runs detail "Approval" link), the card whose
   *  id matches is scrolled into view, focused, and highlighted while it is on
   *  screen. A non-matching / already-resolved id degrades silently to the
   *  whole queue with no highlight or focus change. */
  initialFocusId?: string;
  searchReturnHash?: string;
  initialDecisionKind?: DecisionKind;
  /** Search's readable-text query seeds the native filters. Review navigation
   * stays within this mount so drafts and the original Search return survive. */
  initialDecisionQuery?: string;
  /** Bootstrap-scoped durable Chat approval inbox. It owns all-session
   * recovery plus live-event reconciliation across reconnects. */
  chatPlans?: {
    list(): ReadonlyArray<PendingChatPlan>;
    latestResolution?(): PendingChatPlanResolution | null;
    state?(): PendingChatPlansStoreState;
    refresh?(): Promise<void>;
    whenLoaded?(): Promise<void>;
    recordResolution?(
      plan: PendingChatPlan,
      decision: ChatPlanCardDecision,
    ): void;
    dismissResolution?(plan_id: string): void;
    subscribe(listener: () => void): () => void;
  };
  /** R20 — resolve a chat plan: approve → `chat.plan.approve`, reject →
   *  `chat.plan.cancel` (wire verb unchanged, only the label is "Reject"). The
   *  `chat.plan_resolved` broadcast then drops the plan from the store, which
   *  clears the row. */
  runChatPlanResolve?: (args: {
    plan_id: string;
    decision: ChatPlanCardDecision;
  }) => Promise<unknown>;
  now?: () => number;
}

export interface ApprovalsRoute {
  asksPanel(): AsksPanelMount;
  getApprovals(): ReadonlyArray<ServerPendingApproval>;
  getApprovalState(): ApprovalQueueState;
  getApprovalError(): string | null;
  refreshApprovals(): Promise<void>;
  resolveApproval(
    approval_id: string,
    decision: ApprovalCardDecision,
  ): Promise<void>;
  whenLoaded(): Promise<void>;
  getRecoveryContextFreshness(): 'current' | 'unavailable';
  /** Re-read every queue and re-arm the live approval snapshot. */
  retryRecoveryContext(): Promise<void>;
  hasInFlightWork(): boolean;
  /** Contextual opt-in for the shell's route-leave guard. */
  inFlightWorkPrompt(): string | null;
  dispose(): void;
}

interface ApprovalState {
  phase: ApprovalQueueState;
  approvals: ReadonlyArray<ServerPendingApproval>;
  listError: SurfaceErrorEntry | null;
  liveError: SurfaceErrorEntry | null;
  seq: number | null;
}

interface AskSnapshot {
  phase: AsksPanelState;
  asks: ReadonlyArray<ServerPendingAsk>;
  listError: string | null;
}

/** One row in the unified pending-decisions list. `sortAt` is the server
 * proposal/create time for every durable kind, so ordering survives reloads. */
type DecisionRow =
  | { kind: 'gate'; sortAt: number; id: string; approval: ServerPendingApproval }
  | { kind: 'ask'; sortAt: number; id: string; ask: ServerPendingAsk }
  | { kind: 'plan'; sortAt: number; id: string; plan: PendingChatPlan };

const PENDING_QUEUE_MEDIA = '(min-width: 1280px) and (hover: hover) and (pointer: fine)';
const PENDING_QUEUE_KEY_ATTR = 'data-recued-approvals-queue-key';
const PENDING_REVIEW_ID = 'recued-approvals-pending-review';
const DECISION_KIND_LABEL = { gate: 'Action', ask: 'Question', plan: 'Chat plan' } as const;

const clearChildren = (node: HTMLElement): void => {
  while (node.firstChild) node.removeChild(node.firstChild);
};

const plural = (n: number, word: string): string =>
  n === 1 ? word : `${word}s`;

const recipeHref = (recipe_id: string): string =>
  serializeShellRoute('recipes', recipe_id);

// These legacy gates do not carry an execution anchor. Name the fallback as
// history and scope it to this recipe; never present it as an exact-run link.
const runHref = (recipeId: string): string | undefined => recipeId.trim().length === 0
  ? undefined : serializeShellRoute('logs', 'recipe', recipeId);

const connectionHref = (): string => '#connections';

// ════════════════════════════════════════════════════════════════
// bootstrapApprovalsRoute
// ════════════════════════════════════════════════════════════════

export const bootstrapApprovalsRoute = (
  opts: BootstrapApprovalsRouteOptions,
): ApprovalsRoute => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'bootstrapApprovalsRoute: no document available - pass `opts.document` for non-browser environments',
    );
  }
  const now = opts.now ?? Date.now;

  if (
    doc.head.querySelector(`style[${APPROVALS_ROUTE_STYLES_MARKER}]`) === null
  ) {
    const style = doc.createElement('style');
    style.setAttribute(APPROVALS_ROUTE_STYLES_MARKER, '');
    style.textContent = APPROVALS_ROUTE_STYLES;
    doc.head.appendChild(style);
  }

  let disposed = false;
  let approvalLoadGeneration = 0;
  let pendingApprovalLoad: Promise<void> = Promise.resolve();
  let pendingApprovalSubscribe: Promise<void> = Promise.resolve();
  let refreshingQueue = false;
  let pendingQueueRefresh: Promise<void> = Promise.resolve();
  const resolving = new Set<string>();
  const resolveErrors = new Map<string, string>();
  // Ask answers use host-owned progress/error state too. The shared card has
  // an immediate local guard, while these maps keep the exact option owned if
  // a live queue event rebuilds the unified list before the RPC settles.
  const resolvingAsks = new Map<string, string>();
  const askResolveErrors = new Map<string, string>();
  const resolvingSecrets = new Map<string, boolean>();
  const secretErrors = new Map<string, { context: string; message: string }>();
  // R20 — host-owned armed flag for a destructive gate's confirm step. Lives
  // here (not in the card closure) so a confirm-in-progress survives the route's
  // benign re-renders (a background bus event shouldn't yank it away). Safety is
  // the explicit two-step: resolving needs a deliberate Confirm click — there is
  // NO auto-confirm — and a pending gate is immutable, so the armed decision
  // stays bound to exactly the reviewed operation. Cleared on resolve success +
  // (defensively) when the gate leaves the pending set.
  const armedDestructive = new Set<string>();
  // R20 — chat-plan resolve in-flight + last-error, per plan_id (same shape as
  // the gate's resolving / resolveErrors).
  const resolvingPlans = new Set<string>();
  const planResolveErrors = new Map<string, string>();
  const unsubscribers: Array<() => void> = [];
  // D-174 #4 — id→name maps for the card meta (soft; empty until loaded).
  let recipeNameById = new Map<string, string>();
  let deviceLabelById = new Map<string, string>();

  let approvalState: ApprovalState = {
    phase: 'loading',
    approvals: [],
    listError: null,
    liveError: null,
    seq: null,
  };
  let askSnapshot: AskSnapshot = {
    phase: 'loading',
    asks: [],
    listError: null,
  };

  const routeRoot = doc.createElement('div');
  routeRoot.setAttribute(APPROVALS_ROUTE_HOST_ATTR, '');
  const askNoteDrafts = createAskNoteDrafts(doc, routeRoot);

  const header = doc.createElement('header');
  header.className = 'approvals-header';

  const heading = doc.createElement('h1');
  heading.className = 'approvals-title';
  heading.setAttribute(APPROVALS_ROUTE_HEADING_ATTR, '');
  heading.textContent = 'Approvals';
  header.appendChild(heading);
  if (opts.searchReturnHash) {
    const back = doc.createElement('a'); back.className = 'approvals-refresh'; back.href = opts.searchReturnHash;
    back.textContent = 'Back to search'; header.appendChild(back);
  }
  const viewNav = createApprovalViewNav(doc, 'pending');

  const refreshButton = doc.createElement('button');
  refreshButton.type = 'button';
  refreshButton.className = 'approvals-refresh';
  refreshButton.setAttribute(APPROVALS_ROUTE_REFRESH_ATTR, '');
  refreshButton.innerHTML = renderActionLabel('refresh', 'Refresh');
  header.appendChild(refreshButton);
  routeRoot.appendChild(header);
  routeRoot.appendChild(viewNav);
  const searchLanding = doc.createElement('p');
  searchLanding.hidden = true; searchLanding.tabIndex = -1;
  searchLanding.setAttribute('data-decision-search-landing', ''); searchLanding.setAttribute('role', 'status');
  if (opts.searchReturnHash) routeRoot.appendChild(searchLanding);

  let decisionFilter: DecisionFilter = 'all', decisionQuery = (opts.initialDecisionQuery ?? '').slice(0, 512);
  type RenderedDecision = {
    id: string; kind: DecisionKind; card: HTMLElement; text: string; title: string; sortAt: number;
  };
  const decisionKey = (row: { id: string; kind: DecisionKind }): string => `${row.kind}:${row.id}`;
  let renderedCards: RenderedDecision[] = [];
  const reviewingSearch = opts.searchReturnHash !== undefined && opts.initialDecisionKind !== undefined;
  const desktopBreakpoint = opts.searchReturnHash === undefined
    ? doc.defaultView?.matchMedia?.(PENDING_QUEUE_MEDIA)
    : undefined;
  let desktopSelection: string | null = null;
  let reviewedKey = opts.initialFocusId && opts.initialDecisionKind
    ? decisionKey({ id: opts.initialFocusId, kind: opts.initialDecisionKind }) : null;
  let arrivalReviewed = false;
  let pendingSearchLabels = Number(!!opts.recipeNamesCaller) + Number(!!opts.pairListCaller);
  const filters = doc.createElement('section'); filters.className = 'approvals-filters'; filters.setAttribute('aria-label', 'Filter pending decisions');
  const searchRow = doc.createElement('div'); searchRow.className = 'approvals-search-row';
  const searchLabel = doc.createElement('label'); searchLabel.className = 'approvals-search-label'; searchLabel.textContent = 'Search pending decisions';
  const searchInput = doc.createElement('input'); searchInput.type = 'search'; searchInput.value = decisionQuery; searchInput.maxLength = 512;
  searchInput.autocomplete = 'off'; searchInput.placeholder = 'Recipe, tool, or request text'; searchInput.className = 'approvals-search-input';
  searchInput.setAttribute('aria-label', 'Search pending decisions'); searchLabel.appendChild(searchInput); searchRow.appendChild(searchLabel);
  const clearFilters = doc.createElement('button'); clearFilters.type = 'button'; clearFilters.className = 'approvals-filter-button';
  clearFilters.textContent = 'Clear filters'; clearFilters.hidden = true; searchRow.appendChild(clearFilters);
  const typeFilters = doc.createElement('div'); typeFilters.className = 'approvals-type-filters';
  typeFilters.setAttribute('role', 'group'); typeFilters.setAttribute('aria-label', 'Decision type');
  const filterLabels = { all: 'All', gate: 'Actions', ask: 'Questions', plan: 'Chat plans' } as const;
  const filterButtons = new Map<DecisionFilter, HTMLButtonElement>();
  for (const kind of ['all', 'gate', 'ask', 'plan'] as const) {
    const button = doc.createElement('button'); button.type = 'button'; button.className = 'approvals-filter-button';
    button.setAttribute('data-recued-approvals-filter', kind);
    filterButtons.set(kind, button); typeFilters.appendChild(button);
  }
  filters.appendChild(searchRow); filters.appendChild(typeFilters); routeRoot.appendChild(filters);

  const reviewNavigation = doc.createElement('section'); reviewNavigation.className = 'approvals-review-navigation';
  reviewNavigation.setAttribute('aria-label', 'Matching decision navigation');
  const reviewCount = doc.createElement('p'); reviewCount.className = 'approvals-review-count'; reviewCount.tabIndex = -1;
  reviewCount.setAttribute('role', 'status'); reviewCount.setAttribute('aria-live', 'polite'); reviewCount.setAttribute('aria-atomic', 'true');
  const previousDecision = doc.createElement('button'); previousDecision.type = 'button'; previousDecision.className = 'approvals-filter-button';
  previousDecision.textContent = 'Previous matching decision';
  const nextDecision = doc.createElement('button'); nextDecision.type = 'button'; nextDecision.className = 'approvals-filter-button';
  nextDecision.textContent = 'Next matching decision';
  reviewNavigation.append(reviewCount, previousDecision, nextDecision);
  if (reviewingSearch) routeRoot.appendChild(reviewNavigation);

  const summary = doc.createElement('p');
  summary.className = 'approvals-summary';
  summary.setAttribute(APPROVALS_ROUTE_SUMMARY_ATTR, '');
  summary.setAttribute('role', 'status');
  routeRoot.appendChild(summary);

  // Persistent live region: mutating a node that is already mounted is
  // reliably announced; rebuilding a role=status node with every render is
  // not, and would also repeat the same outcome during snapshot refreshes.
  const planResolutionAnnouncer = doc.createElement('div');
  planResolutionAnnouncer.className = 'approvals-plan-resolution-announcer';
  planResolutionAnnouncer.setAttribute(
    APPROVALS_ROUTE_PLAN_RESOLUTION_ANNOUNCER_ATTR,
    '',
  );
  planResolutionAnnouncer.setAttribute('role', 'status');
  planResolutionAnnouncer.setAttribute('aria-live', 'polite');
  planResolutionAnnouncer.setAttribute('aria-atomic', 'true');
  routeRoot.appendChild(planResolutionAnnouncer);

  const planResolution = doc.createElement('div');
  planResolution.className = 'approvals-plan-resolution';
  planResolution.setAttribute(APPROVALS_ROUTE_PLAN_RESOLUTION_ATTR, '');
  planResolution.hidden = true;
  routeRoot.appendChild(planResolution);

  // ONE unified list (R20) — gate + ask cards interleaved oldest-first.
  const listHeadingId = 'recued-approvals-list-heading';
  const listHeading = doc.createElement('h2');
  listHeading.className = 'approvals-list-heading';
  listHeading.setAttribute(APPROVALS_ROUTE_LIST_HEADING_ATTR, '');
  listHeading.setAttribute('id', listHeadingId);
  listHeading.textContent = 'Pending decisions';
  routeRoot.appendChild(listHeading);

  const list = doc.createElement('div');
  list.className = 'approvals-list';
  list.setAttribute(APPROVALS_ROUTE_LIST_ATTR, '');
  list.setAttribute('role', 'list');
  list.setAttribute('aria-labelledby', listHeadingId);
  const workspace = doc.createElement('div');
  workspace.className = 'approvals-workspace';
  const queue = doc.createElement('div');
  queue.className = 'approvals-queue';
  queue.hidden = true;
  queue.setAttribute('role', 'tablist');
  queue.setAttribute('aria-label', 'Pending decision queue');
  queue.setAttribute('aria-orientation', 'vertical');
  const reviewPane = doc.createElement('div');
  reviewPane.className = 'approvals-review-pane';
  reviewPane.id = PENDING_REVIEW_ID;
  reviewPane.appendChild(list);
  workspace.appendChild(queue);
  workspace.appendChild(reviewPane);
  routeRoot.appendChild(workspace);

  const empty = doc.createElement('p');
  empty.className = 'approvals-empty';
  empty.setAttribute(APPROVALS_ROUTE_EMPTY_ATTR, '');
  empty.textContent = 'All clear.';
  empty.hidden = true;
  routeRoot.appendChild(empty);
  const filterEmpty = doc.createElement('p'); filterEmpty.className = 'approvals-filter-empty'; filterEmpty.hidden = true;
  filterEmpty.setAttribute('data-recued-approvals-filter-empty', ''); routeRoot.appendChild(filterEmpty);

  opts.root.appendChild(routeRoot);

  // The asks panel runs HEADLESS — it owns ask IO (seed + bus refresh +
  // submit) but renders nothing; this route renders the ask cards itself,
  // interleaved with gates. Its (empty) host stays detached from the shell.
  const detachedAsksHost = doc.createElement('div');

  const chatPlanList = (): ReadonlyArray<PendingChatPlan> =>
    opts.chatPlans?.list() ?? [];

  const latestPlanResolution = (): PendingChatPlanResolution | null =>
    opts.chatPlans?.latestResolution?.() ?? null;

  let planResolutionPrimaryAction: HTMLElement | null = null;
  let announcedPlanResolutionKey: string | null = null;
  const renderPlanResolution = (): void => {
    const resolution = latestPlanResolution();
    clearChildren(planResolution);
    planResolutionPrimaryAction = null;
    planResolution.hidden = resolution === null;
    if (resolution === null) return;
    planResolution.setAttribute('data-outcome', resolution.outcome);

    const copy = pendingChatPlanResolutionCopy(resolution);
    const announcementKey = `${resolution.plan_id}:${resolution.outcome}`;
    if (announcedPlanResolutionKey !== announcementKey) {
      announcedPlanResolutionKey = announcementKey;
      planResolutionAnnouncer.textContent = `${copy.title}. ${copy.detail}`;
    }
    const copyHost = doc.createElement('div');
    copyHost.className = 'approvals-plan-resolution-copy';

    const title = doc.createElement('span');
    title.className = 'approvals-plan-resolution-title';
    title.textContent = copy.title;
    copyHost.appendChild(title);

    const detail = doc.createElement('span');
    detail.className = 'approvals-plan-resolution-detail';
    detail.textContent = copy.detail;
    copyHost.appendChild(detail);
    planResolution.appendChild(copyHost);

    const actions = doc.createElement('div');
    actions.className = 'approvals-plan-resolution-actions';

    const chatLink = doc.createElement('a');
    chatLink.className = 'approvals-plan-resolution-link';
    chatLink.setAttribute('href', pendingChatPlanHref(resolution));
    chatLink.setAttribute(APPROVALS_ROUTE_PLAN_RESOLUTION_LINK_ATTR, '');
    chatLink.textContent = copy.linkLabel;
    actions.appendChild(chatLink);
    planResolutionPrimaryAction = chatLink;

    const dismiss = doc.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'approvals-plan-resolution-dismiss';
    dismiss.setAttribute(APPROVALS_ROUTE_PLAN_RESOLUTION_DISMISS_ATTR, '');
    dismiss.innerHTML = renderActionLabel('close', 'Dismiss');
    dismiss.addEventListener('click', () => {
      if (opts.chatPlans?.dismissResolution === undefined) return;
      opts.chatPlans.dismissResolution(resolution.plan_id);
      heading.setAttribute('tabindex', '-1');
      const focusableHeading = heading as unknown as {
        focus?: (options?: FocusOptions) => void;
      };
      focusableHeading.focus?.({ preventScroll: true });
    });
    actions.appendChild(dismiss);
    planResolution.appendChild(actions);
  };

  const focusPlanResolutionHandoff = (planId: string): void => {
    if (reviewingSearch) return;
    if (latestPlanResolution()?.plan_id !== planId) return;
    if (desktopBreakpoint?.matches) {
      const active = doc.activeElement;
      // The receipt can take focus once the queue reaches its heading.
      if (!queue.hidden || (active && active !== heading && active !== doc.body)) return;
    }
    const focusable = planResolutionPrimaryAction as unknown as {
      focus?: (options?: FocusOptions) => void;
    } | null;
    focusable?.focus?.({ preventScroll: true });
  };

  const mergedRows = (): DecisionRow[] => {
    const rows: DecisionRow[] = [
      ...approvalState.approvals.map(
        (approval): DecisionRow => ({
          kind: 'gate',
          sortAt: approval.created_at,
          id: approval.approval_id,
          approval,
        }),
      ),
      ...askSnapshot.asks.map(
        (ask): DecisionRow => ({
          kind: 'ask',
          sortAt: ask.created_at,
          id: ask.ask_id,
          ask,
        }),
      ),
      ...chatPlanList().map(
        (plan): DecisionRow => ({
          kind: 'plan',
          sortAt: plan.proposed_at,
          id: plan.plan_id,
          plan,
        }),
      ),
    ];
    // ⛔ OLDEST-FIRST. This is a WORK QUEUE, not a feed: the decision that has
    // been waiting longest is the one to make next, and it was rendering at the
    // BOTTOM of the list — the further behind you fell, the harder the oldest
    // item was to find. Applies to all three row kinds on purpose; a gate, an
    // ask and a chat plan are all just "something waiting on you", and ordering
    // them by kind-specific rules would make the queue unreadable.
    //
    // ⚠ THIS SORT IS THE AUTHORITATIVE ONE FOR `#approvals`. `asks-panel` also
    // sorts its own `state.asks` (for its non-headless render + the attention
    // popover), but this route takes that list and re-sorts it into the unified
    // set — so changing the panel alone would have moved nothing here. Both are
    // correct for their own surface; neither is redundant.
    //
    // Stable id tiebreak so equal-timestamp rows don't churn.
    return rows.sort((a, b) =>
      a.sortAt !== b.sortAt ? a.sortAt - b.sortAt : a.id.localeCompare(b.id),
    );
  };

  // Card renderers disable the pressed button before invoking their async
  // callback. Browsers then move focus off that button, so retain its row and
  // exact gate/plan action until settlement. A busy repaint may be unable to
  // focus the disabled replacement; the final failure repaint can.
  type DecisionActionTarget = { attr: string; value: string };
  let actionFocusOwner: {
    rowId: string;
    kind: DecisionKind;
    action: DecisionActionTarget | null;
  } | null = null;
  let requestedApprovalActionFocus: {
    rowId: string;
    action: string;
  } | null = null;
  const runDecisionAction = async (
    kind: DecisionKind,
    id: string,
    decisionAction: DecisionActionTarget | null,
    action: () => Promise<void>,
  ): Promise<void> => {
    const owner = { rowId: id, kind, action: decisionAction };
    actionFocusOwner = owner;
    try {
      await action();
    } finally {
      if (actionFocusOwner === owner) actionFocusOwner = null;
      if (!disposed) renderChrome();
    }
  };

  const renderGateCard = (approval: ServerPendingApproval): HTMLElement => {
    const stale = now() >= approval.timeout_at;
    // D-174 #4 — fold resolved display names onto the model (ids stay
    // authoritative; the card prefers the name when present).
    const recipeName = recipeNameById.get(approval.recipe_id);
    const deviceLabel = deviceLabelById.get(approval.initiator_instance);
    const cardModel = {
      ...approval,
      ...(recipeName !== undefined ? { recipe_name: recipeName } : {}),
      ...(deviceLabel !== undefined ? { initiator_label: deviceLabel } : {}),
    };
    return renderApprovalCard(
      doc,
      cardModel,
      {
        onResolve: (decision) =>
          runDecisionAction(
            'gate',
            approval.approval_id,
            {
              attr: APPROVAL_CARD_ACTION_ATTR,
              value:
                approval.risk_tier === 'destructive'
                  && armedDestructive.has(approval.approval_id)
                  && decision === 'approve'
                  ? 'confirm'
                  : decision,
            },
            () => resolveApprovalFromCard(approval.approval_id, decision),
          ),
        // R20 — destructive gates arm a confirm step instead of resolving on
        // the first Approve click. Arm/disarm flip the host-owned flag + re-
        // render so the danger Confirm appears / disappears.
        onArm: () => {
          requestedApprovalActionFocus = {
            rowId: approval.approval_id,
            action: 'confirm',
          };
          armedDestructive.add(approval.approval_id);
          renderDecisions();
        },
        onDisarm: () => {
          requestedApprovalActionFocus = {
            rowId: approval.approval_id,
            action: 'arm',
          };
          armedDestructive.delete(approval.approval_id);
          renderDecisions();
        },
      },
      {
        links: {
          recipeHref: recipeHref(approval.recipe_id),
          connectionHref: connectionHref(),
          runHref: runHref(approval.recipe_id),
          runLabel: 'Recipe run history',
        },
        armed: armedDestructive.has(approval.approval_id),
        disabled: stale,
        busy: resolving.has(approval.approval_id),
        busyAction:
          actionFocusOwner?.rowId === approval.approval_id
            ? actionFocusOwner.action?.value
            : undefined,
        disabledReason: stale
          ? 'That took too long. Load the list again.'
          : resolving.has(approval.approval_id)
            ? 'Resolving...'
            : undefined,
        errorMessage: resolveErrors.get(approval.approval_id) ?? null,
      },
    );
  };

  const submitAskFromCard = async (
    askId: string,
    optionId: string,
    note?: string,
  ): Promise<void> => {
    if (resolvingAsks.has(askId)) return;
    resolvingAsks.set(askId, optionId);
    askResolveErrors.delete(askId);
    renderDecisions();
    try {
      await panel.submitAnswer(askId, optionId, note);
    } catch (err) {
      askResolveErrors.set(askId, 'Recued could not send that. Try again.');
      throw err;
    } finally {
      resolvingAsks.delete(askId);
      renderDecisions();
    }
  };

  const renderAskRow = (ask: ServerPendingAsk): HTMLElement => {
    const preapproval = renderPreapprovalAsk(doc, ask);
    if (preapproval) return preapproval;
    const previousCard = askNoteDrafts.cardFor(ask.ask_id);
    const context = ask.secret_prompt ? canonicalJSONStringify(ask) : null;
    const secretError = secretErrors.get(ask.ask_id);
    const card = renderAskCard(
      doc,
      ask,
      {
        // D-234 § 234.4e — the note travels the same path the option does; a
        // route that forwards one and drops the other submits a decision whose
        // reason was typed and thrown away, with nothing reporting it.
        onAnswer: (optionId, note) =>
          runDecisionAction(
            'ask',
            ask.ask_id,
            { attr: ASK_CARD_OPTION_ATTR, value: optionId },
            () => submitAskFromCard(ask.ask_id, optionId, note),
          ),
        // D-335 slice Z — the secret a browser step waits for, in the card's own field.
        ...(opts.runGiveSecret !== undefined ? { onSecret: async (value: string, remember: boolean) => {
          if (disposed || !routeRoot.contains(card) || resolvingSecrets.has(ask.ask_id) || resolvingAsks.has(ask.ask_id)) return false;
          resolvingSecrets.set(ask.ask_id, remember); secretErrors.delete(ask.ask_id);
          renderChrome();
          const rememberError = (message: string): void => {
            if (!disposed && context !== null && askSnapshot.asks.some(current => current.ask_id === ask.ask_id && canonicalJSONStringify(current) === context)) {
              secretErrors.set(ask.ask_id, { context, message });
            }
          };
          try {
            const { given } = await opts.runGiveSecret!({ ask_id: ask.ask_id, value, remember });
            if (!given) rememberError('The step was no longer waiting for it, so it was not given.');
            return given;
          } catch (error) {
            rememberError('Recued could not give it. Try again.');
            throw error;
          } finally {
            resolvingSecrets.delete(ask.ask_id);
            // The connected form settles itself. A replacement never inherits
            // its value, but still needs the pending state and current error.
            if (!disposed && !routeRoot.contains(card)) renderDecisions();
            else if (!disposed) renderChrome();
          }
        } } : {}),
      },
      {
        ...(previousCard !== undefined ? { previousCard } : {}),
        busy: resolvingAsks.has(ask.ask_id),
        busyOptionId: resolvingAsks.get(ask.ask_id),
        secretBusy: resolvingSecrets.has(ask.ask_id),
        secretRemember: resolvingSecrets.get(ask.ask_id) === true,
        secretError: secretError?.context === context ? secretError.message : null,
        errorMessage: askResolveErrors.get(ask.ask_id) ?? null,
        // The full page has room to say what "Allow this session" lets happen;
        // the top-bar popover does not show it (owner, 2026-10-19).
        showSessionGrantTerms: true,
        // D-336 slice N — a held chat write's card in Chat, where it is changed.
        ...heldAskChatLink(ask),
      },
    );
    return card;
  };

  const renderPlanCard = (plan: PendingChatPlan): HTMLElement => {
    const ownedAction = actionFocusOwner?.rowId === plan.plan_id
      ? actionFocusOwner.action?.value
      : undefined;
    return renderChatPlanCard(
      doc,
      {
        plan_id: plan.plan_id,
        ...(plan.retry_of_plan_id !== undefined
          ? { retry_of_plan_id: plan.retry_of_plan_id }
          : {}),
        tool: plan.tool,
        tier: plan.tier,
        ...(plan.resource_review ? { resource_review: plan.resource_review } : {}),
        args: plan.args,
        payload_available: plan.payload_available,
      },
      {
        onResolve: (decision) =>
          runDecisionAction(
            'plan',
            plan.plan_id,
            { attr: CHAT_PLAN_CARD_ACTION_ATTR, value: decision },
            () => resolvePlanFromCard(plan.plan_id, decision),
          ),
      },
      {
        chatHref: pendingChatPlanHref(plan),
        busy: resolvingPlans.has(plan.plan_id),
        busyAction:
          ownedAction === 'approve' || ownedAction === 'reject'
            ? ownedAction
            : undefined,
        errorMessage: planResolveErrors.get(plan.plan_id) ?? null,
      },
    );
  };

  // R17 — run-scoped focus deep link (`#approvals/<id>`) state.
  const focusId = opts.initialFocusId;
  let focusApplied = false;

  /** Move to the focus-target card ONCE. It can be absent on the first loading
   *  render, so this no-ops until the card appears. Later benign repaints
   *  preserve that card owner in `renderDecisions`. */
  const applyFocus = (): void => {
    if (focusId === undefined || focusApplied) return;
    const target = (Array.from(list.children) as HTMLElement[]).find(
      (el) => el.getAttribute?.(APPROVALS_ROUTE_FOCUS_ATTR) === focusId
        && (opts.initialDecisionKind === undefined || renderedCards.some(row => row.id === focusId && row.kind === opts.initialDecisionKind && row.card === el)),
    );
    if (target === undefined || target.hidden) return;
    focusApplied = true;
    arrivalReviewed = true;
    if (typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'center' });
    }
    target.focus?.({ preventScroll: true });
  };

  const focusDecisionSuccessor = (key: string | null): void => {
    const target = renderedCards.find(row => !row.card.hidden && decisionKey(row) === key);
    if (target) {
      if (reviewingSearch) { reviewedKey = key; arrivalReviewed = true; }
      if (desktopBreakpoint?.matches && desktopSelection !== key) {
        desktopSelection = key;
        renderDesktopQueue();
      }
      target.card.setAttribute('tabindex', '-1');
      if (reviewingSearch || desktopBreakpoint?.matches) target.card.scrollIntoView?.({ block: 'nearest' });
      target.card.focus?.({ preventScroll: true });
      return;
    }
    const fallback = reviewingSearch ? reviewCount : heading;
    fallback.setAttribute('tabindex', '-1');
    if (reviewingSearch) fallback.scrollIntoView?.({ block: 'nearest' });
    fallback.focus?.({ preventScroll: true });
  };

  let renderedDecisionKeys: string[] = [];

  const nearestDecisionKey = (key: string, currentKeys: readonly string[]): string | undefined => {
    const index = renderedDecisionKeys.indexOf(key);
    return renderedDecisionKeys.slice(index + 1).find(candidate => currentKeys.includes(candidate))
      ?? renderedDecisionKeys.slice(0, index).reverse().find(candidate => currentKeys.includes(candidate));
  };

  const queueButton = (key: string | null): HTMLElement | undefined =>
    (Array.from(queue.children) as HTMLElement[]).find(button => button.getAttribute(PENDING_QUEUE_KEY_ATTR) === key);

  const revealReviewTop = (): void => {
    const contentTop = opts.root.getBoundingClientRect?.().top ?? 0;
    if (reviewPane.getBoundingClientRect().top < contentTop) {
      reviewPane.scrollIntoView?.({ block: 'start' });
    }
  };

  const selectQueueDecision = (key: string): void => {
    if (disposed || !desktopBreakpoint?.matches || !visibleDecisionKeys().includes(key)) return;
    focusApplied = true;
    if (desktopSelection !== key) {
      desktopSelection = key;
      renderDesktopQueue();
      revealReviewTop();
    }
    const button = queueButton(key);
    button?.focus({ preventScroll: true });
    button?.scrollIntoView?.({ block: 'nearest' });
  };

  const renderDesktopQueue = (): void => {
    if (!desktopBreakpoint?.matches) {
      if (queue.hidden) return;
      queue.hidden = true;
      workspace.removeAttribute('data-approvals-queue-layout');
      reviewPane.removeAttribute('role');
      reviewPane.removeAttribute('aria-labelledby');
      reviewPane.removeAttribute('tabindex');
      return;
    }
    const matching = renderedCards.filter(row => !row.card.hidden);
    const keys = matching.map(decisionKey);
    const requested = !focusApplied && focusId !== undefined
      ? matching.find(row => row.id === focusId && (!opts.initialDecisionKind || opts.initialDecisionKind === row.kind))
      : undefined;
    if (requested) desktopSelection = decisionKey(requested);
    if (!desktopSelection || !keys.includes(desktopSelection)) {
      desktopSelection = (desktopSelection ? nearestDecisionKey(desktopSelection, keys) : undefined) ?? keys[0] ?? null;
    }

    const focusedTab = (doc.activeElement as HTMLElement | null)?.getAttribute?.(PENDING_QUEUE_KEY_ATTR) ?? null;
    const scrollTop = queue.scrollTop;
    clearChildren(queue);
    queue.hidden = desktopSelection === null;
    if (desktopSelection === null) {
      workspace.removeAttribute('data-approvals-queue-layout');
      reviewPane.removeAttribute('role');
      reviewPane.removeAttribute('aria-labelledby');
      reviewPane.removeAttribute('tabindex');
      if (focusedTab !== null) focusDecisionSuccessor(null);
      return;
    }
    workspace.setAttribute('data-approvals-queue-layout', '');
    reviewPane.setAttribute('role', 'tabpanel');
    reviewPane.tabIndex = 0;
    const timestamp = now();
    for (const row of matching) {
      const key = decisionKey(row);
      const selected = key === desktopSelection;
      if (selected) row.card.setAttribute('data-approvals-queue-selected', '');
      else row.card.removeAttribute('data-approvals-queue-selected');
      const button = doc.createElement('button');
      button.type = 'button';
      button.id = `recued-approvals-queue-${encodeURIComponent(key)}`;
      button.setAttribute(PENDING_QUEUE_KEY_ATTR, key);
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-controls', PENDING_REVIEW_ID);
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      const title = doc.createElement('span');
      title.className = 'approvals-queue-title';
      title.textContent = row.title;
      const meta = doc.createElement('span');
      meta.className = 'approvals-queue-meta';
      const age = formatAskAge(row.sortAt, timestamp);
      meta.textContent = age ? `${DECISION_KIND_LABEL[row.kind]} · ${age}` : DECISION_KIND_LABEL[row.kind];
      button.appendChild(title);
      button.appendChild(meta);
      button.addEventListener('click', () => selectQueueDecision(key));
      queue.appendChild(button);
      if (selected) reviewPane.setAttribute('aria-labelledby', button.id);
    }
    queue.scrollTop = scrollTop;
    if (focusedTab !== null) (queueButton(focusedTab) ?? queueButton(desktopSelection))?.focus({ preventScroll: true });
  };

  const onQueueKeyDown = (event: KeyboardEvent): void => {
    const rows = visibleDecisionKeys();
    const index = rows.indexOf(desktopSelection ?? '');
    const key = event.key === 'ArrowDown' ? rows[index + 1]
      : event.key === 'ArrowUp' ? rows[index - 1]
      : event.key === 'Home' ? rows[0]
      : event.key === 'End' ? rows.at(-1) : undefined;
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (key) selectQueueDecision(key);
  };
  const onDesktopBreakpointChange = (): void => {
    if (disposed) return;
    const active = doc.activeElement as HTMLElement | null;
    const wasQueueTab = active?.getAttribute?.(PENDING_QUEUE_KEY_ATTR) ?? null;
    const focusedRow = active ? decisionCardContaining(active) : undefined;
    if (desktopBreakpoint?.matches && focusedRow) desktopSelection = decisionKey(focusedRow);
    renderDesktopQueue();
    if (!desktopBreakpoint?.matches && wasQueueTab !== null) focusDecisionSuccessor(wasQueueTab);
  };
  queue.addEventListener('keydown', onQueueKeyDown);
  desktopBreakpoint?.addEventListener?.('change', onDesktopBreakpointChange);

  const containsElement = (
    root: HTMLElement,
    target: HTMLElement,
  ): boolean => {
    if (root === target) return true;
    return (Array.from(root.children) as HTMLElement[]).some(
      (child) => containsElement(child, target),
    );
  };

  const decisionCardContaining = (target: HTMLElement): RenderedDecision | undefined =>
    renderedCards.find(row => containsElement(row.card, target));

  const findDescendantByAttr = (
    root: HTMLElement,
    attr: string,
    value: string,
  ): HTMLElement | undefined => {
    if (root.getAttribute?.(attr) === value) return root;
    for (const child of Array.from(root.children) as HTMLElement[]) {
      const match = findDescendantByAttr(child, attr, value);
      if (match !== undefined) return match;
    }
    return undefined;
  };

  const restoreDecisionActionFocus = (
    target: ({ rowId: string; kind: DecisionKind } & DecisionActionTarget) | null,
  ): void => {
    if (target === null) return;
    const row = renderedCards.find(candidate => !candidate.card.hidden && candidate.id === target.rowId && candidate.kind === target.kind);
    if (!row || (desktopBreakpoint?.matches && decisionKey(row) !== desktopSelection)) return;
    findDescendantByAttr(
      row.card,
      target.attr,
      target.value,
    )?.focus?.({ preventScroll: true });
  };

  /** Preserve the focused card across a benign repaint. When its decision was
   *  completed locally or on another device, hand focus to the next surviving
   *  card in the prior queue order, then the previous one, then the heading.
   *  Keeping this at the unified renderer covers gates, asks, and Chat plans. */
  const reconcileDecisionFocus = (
    focusedKey: string | null,
  ): void => {
    const currentKeys = visibleDecisionKeys();
    const successor = (key: string): string | null => nearestDecisionKey(key, currentKeys)
      ?? (reviewingSearch || desktopBreakpoint?.matches ? currentKeys[0] ?? null : null);
    if (reviewingSearch && reviewedKey && !currentKeys.includes(reviewedKey) && renderedDecisionKeys.includes(reviewedKey)) {
      reviewedKey = successor(reviewedKey);
    }
    if (focusedKey !== null) {
      const replacement = renderedCards.find(row => !row.card.hidden && decisionKey(row) === focusedKey);
      if (replacement) replacement.card.focus?.({ preventScroll: true });
      else if (renderedDecisionKeys.includes(focusedKey)) focusDecisionSuccessor(successor(focusedKey));
    }
    renderedDecisionKeys = currentKeys;
  };

  /** Re-paint the whole unified list + the summary / empty chrome. Called on
   *  every gate OR ask state transition — both kinds live in one list. */
  const renderDecisions = (): void => {
    if (disposed) return;
    const noteFocus = askNoteDrafts.capture(askSnapshot.asks);
    const activeElement = doc.activeElement as HTMLElement | null | undefined;
    const filterOwnsFocus = activeElement === searchInput || activeElement === clearFilters
      || [...filterButtons.values()].some(button => button === activeElement)
      || activeElement?.getAttribute?.(PENDING_QUEUE_KEY_ATTR) != null
      || (reviewingSearch && activeElement !== null && activeElement !== undefined
        && containsElement(routeRoot, activeElement) && !decisionCardContaining(activeElement));
    const focusedRow = activeElement ? decisionCardContaining(activeElement) : undefined;
    const pendingOwner = actionFocusOwner && { id: actionFocusOwner.rowId, kind: actionFocusOwner.kind };
    const ownsSelectedDecision = pendingOwner && (!desktopBreakpoint?.matches || decisionKey(pendingOwner) === desktopSelection);
    const focusOwner = focusedRow ?? (!filterOwnsFocus && ownsSelectedDecision ? pendingOwner : null);
    const focusedCardId = focusOwner?.id ?? null;
    const focusedKey = focusOwner ? decisionKey(focusOwner) : null;
    const focusedApprovalAction = activeElement?.closest?.(
      `[${APPROVAL_CARD_ACTION_ATTR}]`,
    );
    const focusedApprovalActionId = activeElement?.getAttribute?.(
      APPROVAL_CARD_ACTION_ATTR,
    ) ?? focusedApprovalAction?.getAttribute?.(APPROVAL_CARD_ACTION_ATTR)
      ?? null;
    const focusedPlanAction = activeElement?.closest?.(
      `[${CHAT_PLAN_CARD_ACTION_ATTR}]`,
    );
    const focusedPlanActionId = activeElement?.getAttribute?.(
      CHAT_PLAN_CARD_ACTION_ATTR,
    ) ?? focusedPlanAction?.getAttribute?.(CHAT_PLAN_CARD_ACTION_ATTR)
      ?? null;
    const decisionActionFocus = filterOwnsFocus ? null : requestedApprovalActionFocus !== null
      ? {
          rowId: requestedApprovalActionFocus.rowId,
          kind: 'gate' as const,
          attr: APPROVAL_CARD_ACTION_ATTR,
          value: requestedApprovalActionFocus.action,
        }
      : focusedCardId !== null && focusedApprovalActionId !== null
        ? {
            rowId: focusedCardId,
            kind: focusOwner!.kind,
            attr: APPROVAL_CARD_ACTION_ATTR,
            value: focusedApprovalActionId,
          }
        : focusedCardId !== null && focusedPlanActionId !== null
          ? {
              rowId: focusedCardId,
              kind: focusOwner!.kind,
              attr: CHAT_PLAN_CARD_ACTION_ATTR,
              value: focusedPlanActionId,
            }
          : actionFocusOwner !== null
              && focusedCardId === actionFocusOwner.rowId
              && focusOwner?.kind === actionFocusOwner.kind
              && actionFocusOwner.action !== null
            ? { rowId: actionFocusOwner.rowId, kind: actionFocusOwner.kind, ...actionFocusOwner.action }
            : null;
    requestedApprovalActionFocus = null;
    for (const [id, error] of secretErrors) {
      const current = askSnapshot.asks.find(ask => ask.ask_id === id);
      if (!current || canonicalJSONStringify(current) !== error.context) secretErrors.delete(id);
    }
    const decisionRows = mergedRows();
    renderedCards = [];
    const nextNodes: HTMLElement[] = [];
    renderPlanResolution();

    // Defensive — drop armed flags for gates no longer pending (e.g. resolved
    // on another paired device). A still-pending armed gate is KEPT: a benign
    // re-render must not disarm a confirm-in-progress.
    for (const id of [...armedDestructive]) {
      if (!approvalState.approvals.some((a) => a.approval_id === id)) {
        armedDestructive.delete(id);
      }
    }

    const approvalCount = approvalState.approvals.length;
    const askCount = askSnapshot.asks.length;
    const planCount = chatPlanList().length;
    const total = approvalCount + askCount + planCount;

    // Tier 2 — connection-caused load/subscribe failures defer to the global
    // offline banner (keep the rows already shown; one calm line only when
    // there are none). A real error shows inline, humanized. Gate + ask load
    // errors share the one list now, but each keeps its own data-presence
    // gate: the gate connection error defers only when GATES are still shown
    // (an ask load can't keep gate rows on screen, and vice-versa).
    const errorDisplay = resolveSurfaceErrorDisplay(
      [approvalState.listError, approvalState.liveError],
      { hasData: approvalState.approvals.length > 0 },
    );
    if (errorDisplay !== null) {
      const err = doc.createElement('div');
      err.className = 'approvals-error';
      err.setAttribute(
        APPROVALS_ROUTE_ERROR_ATTR,
        errorDisplay.connectionCaused ? 'connection' : 'error',
      );
      err.setAttribute(
        'role',
        errorDisplay.connectionCaused ? 'status' : 'alert',
      );
      err.textContent = errorDisplay.text;
      nextNodes.push(err);
    }
    const chatPlanState = opts.chatPlans?.state?.();
    const chatPlanErrorDisplay = resolveSurfaceErrorDisplay(
      [
        chatPlanState?.error == null
          ? null
          : {
              error: classifyRpcError(chatPlanState.error),
              label: "Recued could not reload the Chat approvals",
            },
      ],
      { hasData: planCount > 0 },
    );
    if (chatPlanErrorDisplay !== null) {
      const planErr = doc.createElement('div');
      planErr.className = 'approvals-error';
      planErr.setAttribute(
        APPROVALS_ROUTE_ERROR_ATTR,
        chatPlanErrorDisplay.connectionCaused ? 'connection' : 'error',
      );
      planErr.setAttribute(
        'role',
        chatPlanErrorDisplay.connectionCaused ? 'status' : 'alert',
      );
      planErr.textContent = chatPlanErrorDisplay.text;
      nextNodes.push(planErr);
    }
    if (askSnapshot.listError !== null) {
      const askErr = doc.createElement('div');
      askErr.className = 'approvals-error';
      askErr.setAttribute(APPROVALS_ROUTE_ERROR_ATTR, 'error');
      askErr.setAttribute('role', 'alert');
      askErr.textContent = `Recued could not load the questions: ${askSnapshot.listError}`;
      nextNodes.push(askErr);
    }

    const stillLoading =
      total === 0
      && (
        approvalState.phase === 'loading'
        || askSnapshot.phase === 'loading'
        || chatPlanState?.phase === 'loading'
      );
    if (stillLoading) {
      const loading = doc.createElement('div');
      loading.className = 'approvals-loading';
      loading.setAttribute(APPROVALS_ROUTE_LOADING_ATTR, '');
      loading.textContent = 'Loading what is waiting for you…';
      nextNodes.push(loading);
      askNoteDrafts.render(list, nextNodes);
      renderDesktopQueue();
      reconcileDecisionFocus(focusedKey);
      renderChrome();
      return;
    }

    for (const row of decisionRows) {
      const card =
        row.kind === 'gate'
          ? renderGateCard(row.approval)
          : row.kind === 'ask'
            ? renderAskRow(row.ask)
            : renderPlanCard(row.plan);
      // R17 — uniform focus hook + highlight for the run-scoped deep link. The
      // attr is set on EVERY card (so `applyFocus` can find the target); the
      // highlight flag only on the match (re-applied each paint while it lives).
      card.setAttribute(APPROVALS_ROUTE_FOCUS_ATTR, row.id);
      card.setAttribute('role', 'listitem');
      const cardTitle = (Array.from(card.children) as HTMLElement[]).find(
        (child) =>
          child.className === 'rx-ask-card-title'
          || child.className === 'rx-approval-card-title',
      );
      if (cardTitle !== undefined) {
        cardTitle.setAttribute('role', 'heading');
        cardTitle.setAttribute('aria-level', '3');
      }
      if (focusId !== undefined && row.id === focusId && (!opts.initialDecisionKind || opts.initialDecisionKind === row.kind)) {
        card.setAttribute('data-focused', 'true');
        card.setAttribute('tabindex', '-1');
      } else if (focusedKey === decisionKey(row)) {
        card.setAttribute('tabindex', '-1');
      }
      renderedCards.push({
        id: row.id, kind: row.kind, card, text: decisionSearchText(card),
        title: cardTitle?.textContent?.trim() || card.getAttribute('aria-label') || DECISION_KIND_LABEL[row.kind],
        sortAt: row.sortAt,
      });
      nextNodes.push(card);
    }
    askNoteDrafts.render(list, nextNodes);
    applyFilters();
    renderDesktopQueue();
    const noteFocusRestored = askNoteDrafts.restore(noteFocus);
    reconcileDecisionFocus(noteFocusRestored ? null : focusedKey);
    applyFocus();
    restoreDecisionActionFocus(decisionActionFocus);
    renderChrome();
  };

  const visibleDecisionKeys = (): string[] => renderedCards.filter(entry => !entry.card.hidden).map(decisionKey);
  const filtersActive = (): boolean => decisionFilter !== 'all' || decisionSearchTerms(decisionQuery).length > 0;
  const applyFilters = (): number => {
    const terms = decisionSearchTerms(decisionQuery); let shown = 0;
    for (const entry of renderedCards) {
      entry.card.hidden = decisionFilter !== 'all' && entry.kind !== decisionFilter || !decisionTextMatches(entry.text, terms);
      if (!entry.card.hidden) shown++;
    }
    return shown;
  };
  const changeFilters = (owner: HTMLElement): void => {
    if (disposed) return;
    // Explicit navigation supersedes a deep link still waiting for its read.
    focusApplied = true; owner.focus?.({ preventScroll: true });
    arrivalReviewed = true;
    applyFilters();
    renderDesktopQueue();
    renderedDecisionKeys = visibleDecisionKeys();
    if (reviewedKey && !renderedDecisionKeys.includes(reviewedKey)) reviewedKey = null;
    renderChrome();
  };
  const onSearchInput = (): void => { decisionQuery = searchInput.value.slice(0, 512); changeFilters(searchInput); };
  const onClearFilters = (): void => { decisionFilter = 'all'; decisionQuery = ''; searchInput.value = ''; changeFilters(searchInput); };
  const onSearchKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && !event.isComposing && filtersActive()) { event.preventDefault(); event.stopPropagation(); onClearFilters(); }
  };
  for (const [kind, button] of filterButtons) button.addEventListener('click', () => { decisionFilter = kind; changeFilters(button); });
  searchInput.addEventListener('input', onSearchInput); searchInput.addEventListener('keydown', onSearchKeydown); clearFilters.addEventListener('click', onClearFilters);

  const reviewBusy = (): boolean => refreshingQueue || actionFocusOwner !== null
    || resolving.size > 0 || resolvingAsks.size > 0 || resolvingPlans.size > 0 || resolvingSecrets.size > 0;
  const moveReview = (direction: -1 | 1): void => {
    if (disposed || !reviewingSearch || reviewBusy()) return;
    const keys = visibleDecisionKeys(), index = keys.indexOf(reviewedKey ?? '');
    const target = keys[index + direction];
    if (!target) return;
    focusApplied = true;
    focusDecisionSuccessor(target);
    renderChrome();
  };
  const onPreviousDecision = (): void => moveReview(-1);
  const onNextDecision = (): void => moveReview(1);
  const onDecisionFocus = (event: Event): void => {
    if (!reviewingSearch || disposed || !event.target) return;
    const row = decisionCardContaining(event.target as HTMLElement);
    if (!row || row.card.hidden || reviewedKey === decisionKey(row)) return;
    reviewedKey = decisionKey(row); arrivalReviewed = true; focusApplied = true;
    renderChrome();
  };
  previousDecision.addEventListener('click', onPreviousDecision);
  nextDecision.addEventListener('click', onNextDecision);
  routeRoot.addEventListener('focusin', onDecisionFocus);

  const renderChrome = (): void => {
    if (disposed) return;
    const approvalCount = approvalState.approvals.length;
    const askCount = askSnapshot.asks.length;
    const planCount = chatPlanList().length;
    const total = approvalCount + askCount + planCount;
    const chatPlanState = opts.chatPlans?.state?.();
    const loading =
      total === 0
      && (
        approvalState.phase === 'loading'
        || askSnapshot.phase === 'loading'
        || chatPlanState?.phase === 'loading'
      );
    const verified =
      approvalState.phase === 'ready'
      && askSnapshot.phase === 'ready'
      && (chatPlanState?.phase ?? 'ready') === 'ready'
      && approvalState.listError === null
      && approvalState.liveError === null
      && askSnapshot.listError === null
      && (chatPlanState?.error ?? null) === null;
    const counts = { all: total, gate: approvalCount, ask: askCount, plan: planCount };
    const current = { all: verified, gate: approvalState.phase === 'ready' && approvalState.listError === null && approvalState.liveError === null,
      ask: askSnapshot.phase === 'ready' && askSnapshot.listError === null, plan: (chatPlanState?.phase ?? 'ready') === 'ready' && (chatPlanState?.error ?? null) === null };
    if (opts.searchReturnHash && opts.initialDecisionKind && focusId) {
      const found = renderedCards.find(row => row.id === focusId && row.kind === opts.initialDecisionKind);
      searchLanding.hidden = arrivalReviewed || !!found && !found.card.hidden;
      const checked = current[opts.initialDecisionKind] && (!found || pendingSearchLabels === 0);
      searchLanding.textContent = !checked ? 'This decision has not been confirmed yet. Refresh to check it again.'
        : found ? 'This decision no longer matches these filters. Use Next matching decision or return to search.'
        : 'This decision is no longer pending. Use Next matching decision or return to search to check the remaining decisions.';
      if (!searchLanding.hidden && checked && !focusApplied) { focusApplied = true; searchLanding.focus({ preventScroll: true }); }
    }
    for (const [kind, button] of filterButtons) {
      button.textContent = `${filterLabels[kind]} (${counts[kind]}${current[kind] ? '' : ' loaded'})`;
      button.setAttribute('aria-pressed', String(decisionFilter === kind));
    }
    clearFilters.hidden = !filtersActive();
    const shown = applyFilters();
    if (reviewingSearch) {
      const keys = visibleDecisionKeys(), index = keys.indexOf(reviewedKey ?? '');
      reviewCount.textContent = `${shown} matching ${plural(shown, 'decision')} remaining${current[decisionFilter] ? '' : ' among loaded decisions'}.${index < 0 ? '' : ` Reviewing ${index + 1} of ${shown}.`}`;
      previousDecision.setAttribute('aria-disabled', String(reviewBusy() || index <= 0));
      nextDecision.setAttribute('aria-disabled', String(reviewBusy() || shown === 0 || index >= shown - 1));
      for (const row of renderedCards) {
        if (!row.card.hidden && decisionKey(row) === reviewedKey) { row.card.setAttribute('data-focused', 'true'); row.card.setAttribute('tabindex', '-1'); }
        else row.card.removeAttribute('data-focused');
      }
    }
    filterEmpty.hidden = !filtersActive() || total === 0 || shown > 0;
    filterEmpty.textContent = verified ? 'No pending decisions match these filters.'
      : 'No matches among the loaded decisions. The queue has not been fully checked.';

    const refreshBusy = refreshingQueue || loading;
    refreshButton.innerHTML = renderActionLabel('refresh', refreshingQueue
      ? 'Refreshing…'
      : loading
        ? 'Checking…'
        : 'Refresh');
    if (refreshBusy) {
      refreshButton.setAttribute('aria-disabled', 'true');
      refreshButton.setAttribute('aria-busy', 'true');
    } else {
      refreshButton.removeAttribute('aria-disabled');
      refreshButton.removeAttribute('aria-busy');
    }

    summary.textContent =
      total === 0
        ? loading
          ? 'Checking what is waiting for you…'
          : verified
          ? 'Nothing is waiting for you.'
          : "Recued could not check what is waiting for you."
        : filtersActive() ? `Showing ${shown} of ${total}${verified ? '' : ' loaded'} pending ${plural(total, 'decision')}.`
        : `${total} pending ${plural(total, 'decision')} waiting on you.`;

    const allClear =
      verified
      && total === 0
      && latestPlanResolution() === null;
    empty.hidden = !allClear;
    // When all-clear the dashed "All clear." panel is the whole message —
    // drop the redundant "No pending decisions." summary line above it.
    summary.hidden = (verified && total === 0) || loading;
  };

  const doRefreshApprovals = (): Promise<void> => {
    const gen = ++approvalLoadGeneration;
    pendingApprovalLoad = (async () => {
      try {
        const res = await opts.runApprovalList();
        if (disposed || gen !== approvalLoadGeneration) return;
        approvalState = {
          ...approvalState,
          phase: 'ready',
          approvals: [...res.approvals],
          listError: null,
        };
        renderDecisions();
      } catch (err) {
        if (disposed || gen !== approvalLoadGeneration) return;
        approvalState = {
          ...approvalState,
          phase: 'error',
          listError: { error: classifyRpcError(err), label: "Recued could not load the approval rules" },
        };
        renderDecisions();
      }
    })();
    return pendingApprovalLoad;
  };

  const onApprovalChanged = (event: ServerApprovalSubscriptionEvent): void => {
    if (approvalState.seq !== null && event.seq <= approvalState.seq) return;
    approvalState = { ...approvalState, seq: event.seq };
    void doRefreshApprovals();
  };

  // Bumped per `startApprovalSubscription` call so a slow in-flight subscribe
  // (e.g. the mount-time one) can't clobber the baseline a newer reconnect
  // re-subscribe established.
  let approvalSubscribeGeneration = 0;
  const startApprovalSubscription = (
    params?: { resetSeqBaseline?: boolean },
  ): void => {
    const gen = (approvalSubscribeGeneration += 1);
    pendingApprovalSubscribe = (async () => {
      try {
        const res = await opts.runApprovalSubscribe();
        if (disposed || gen !== approvalSubscribeGeneration) return;
        approvalState = {
          ...approvalState,
          // Normally `Math.max` guards against a slow subscribe response
          // regressing the seq below an event that already advanced it. But on
          // a RECONNECT the server may have RESTARTED — its seq epoch resets to
          // 0, and `Math.max` against the pre-restart high-water would strand
          // us above every post-restart event, dropping them all as stale (the
          // exact bug reconnect re-subscribe is meant to fix). So adopt the
          // snapshot's seq as the new epoch baseline; the generation guard
          // above keeps a stale in-flight subscribe from undoing it.
          seq: params?.resetSeqBaseline === true
            ? res.seq
            : Math.max(approvalState.seq ?? 0, res.seq),
          liveError: null,
          ...(approvalState.phase === 'loading'
            ? {
                phase: 'ready' as const,
                approvals: [...res.approvals],
                listError: null,
              }
            : {}),
        };
        renderDecisions();
      } catch (err) {
        if (disposed || gen !== approvalSubscribeGeneration) return;
        approvalState = {
          ...approvalState,
          liveError: { error: classifyRpcError(err), label: 'Approvals are not updating live' },
        };
        renderDecisions();
      }
    })();
  };

  const resolveApprovalFromCard = async (
    approval_id: string,
    decision: ApprovalCardDecision,
  ): Promise<void> => {
    if (resolving.has(approval_id)) return;
    resolving.add(approval_id);
    resolveErrors.delete(approval_id);
    renderDecisions();
    try {
      await opts.runApprovalResolve({ approval_id, decision });
      // Resolved — drop the row + its (now-stale) armed flag. On failure we
      // keep it armed so the Confirm + inline error stay up for a retry.
      armedDestructive.delete(approval_id);
      approvalState = {
        ...approvalState,
        phase: 'ready',
        approvals: approvalState.approvals.filter(
          (approval) => approval.approval_id !== approval_id,
        ),
        listError: null,
      };
      renderDecisions();
      await doRefreshApprovals();
    } catch (err) {
      resolveErrors.set(approval_id, humanizeRpcError(err));
      throw err;
    } finally {
      resolving.delete(approval_id);
      renderDecisions();
    }
  };

  const resolvePlanFromCard = async (
    plan_id: string,
    decision: ChatPlanCardDecision,
  ): Promise<void> => {
    if (opts.runChatPlanResolve === undefined) return;
    if (resolvingPlans.has(plan_id)) return;
    resolvingPlans.add(plan_id);
    planResolveErrors.delete(plan_id);
    renderDecisions();
    try {
      const plan = chatPlanList().find(
        (candidate) => candidate.plan_id === plan_id,
      );
      await opts.runChatPlanResolve({ plan_id, decision });
      if (plan !== undefined) {
        // The RPC is authoritative. Apply its handoff immediately so a missed
        // broadcast cannot jump from a disabled card straight to "All clear."
        opts.chatPlans?.recordResolution?.(plan, decision);
      }
      // Keep the guard while the authoritative snapshot catches up. This also
      // clears the row when the resolving broadcast was missed during a
      // transport drop.
      await opts.chatPlans?.refresh?.();
      focusPlanResolutionHandoff(plan_id);
    } catch (err) {
      // FAILURE — re-enable for a retry + surface the error inline.
      resolvingPlans.delete(plan_id);
      planResolveErrors.set(plan_id, humanizeRpcError(err));
      renderDecisions();
      // A paired client may have won the decision while this stale action was
      // in flight. Reconcile once so a missed terminal broadcast replaces the
      // obsolete error/card with the neutral no-longer-pending handoff.
      await opts.chatPlans?.refresh?.();
      focusPlanResolutionHandoff(plan_id);
      throw err;
    }
  };

  const panel = mountAsksPanel({
    host: detachedAsksHost,
    document: doc,
    headless: true,
    runList: opts.runList,
    runSubmitAnswer: opts.runSubmitAnswer,
    ...(opts.subscribe !== undefined ? { subscribe: opts.subscribe } : {}),
    loadingCopy: null,
    emptyCopy: null,
    onChange: (next) => {
      askSnapshot = next;
      const liveAskIds = new Set(next.asks.map((ask) => ask.ask_id));
      for (const id of [...askResolveErrors.keys()]) {
        if (!liveAskIds.has(id)) askResolveErrors.delete(id);
      }
      renderDecisions();
    },
  });

  if (opts.onApprovalChanged !== undefined) {
    unsubscribers.push(opts.onApprovalChanged(onApprovalChanged));
  }
  // D-188 — an approval the owner's pause holds back reads so (`ServerPendingAsk.paused`):
  // when the pause turns on or off, read the asks again.
  unsubscribers.push(onServerPauseChange(() => {
    if (disposed) return;
    void panel.refresh();
  }));
  if (opts.subscribe !== undefined) {
    unsubscribers.push(
      opts.subscribe('approval', () => {
        if (disposed) return;
        void doRefreshApprovals();
      }),
    );
  }
  // Re-render for both snapshot-state and live-map changes. Also prune
  // in-flight/error state after authoritative reconciliation removes a row.
  if (opts.chatPlans !== undefined) {
    unsubscribers.push(
      opts.chatPlans.subscribe(() => {
        if (disposed) return;
        const live = new Set(chatPlanList().map((p) => p.plan_id));
        for (const id of [...resolvingPlans]) {
          if (!live.has(id)) resolvingPlans.delete(id);
        }
        for (const id of [...planResolveErrors.keys()]) {
          if (!live.has(id)) planResolveErrors.delete(id);
        }
        renderDecisions();
      }),
    );
  }
  // D-174 #4 — load id→name maps once; soft (absent caller / error → ids).
  const loadRecipeNames = async (): Promise<void> => {
    if (opts.recipeNamesCaller === undefined) return;
    try {
      const { recipes } = await opts.recipeNamesCaller();
      if (disposed) return;
      const next = new Map<string, string>();
      for (const r of recipes) {
        if (typeof r.name === 'string' && r.name.length > 0) next.set(r.recipe_id, r.name);
      }
      recipeNameById = next;
    } catch {
      // Soft enhancement — keep showing the raw recipe id.
    } finally {
      pendingSearchLabels--;
      renderDecisions();
    }
  };
  const loadDeviceLabels = async (): Promise<void> => {
    if (opts.pairListCaller === undefined) return;
    try {
      const { devices } = await opts.pairListCaller();
      if (disposed) return;
      const next = new Map<string, string>();
      for (const d of devices) {
        if (typeof d.display_name === 'string' && d.display_name.length > 0) {
          next.set(d.instance_id, d.display_name);
        }
      }
      deviceLabelById = next;
    } catch {
      // Soft enhancement — keep showing the raw instance id.
    } finally {
      pendingSearchLabels--;
      renderDecisions();
    }
  };

  renderDecisions();
  startApprovalSubscription();
  void doRefreshApprovals();
  // A bootstrap store may have loaded long before this route was opened.
  // Reconcile on a later mount so missed events or a newly unlocked Chat vault
  // can restore exact review details without requiring a page reload.
  if (opts.chatPlans?.state?.().phase !== 'loading') {
    void opts.chatPlans?.refresh?.();
  }
  void loadRecipeNames();
  void loadDeviceLabels();

  // Re-arm the one-shot `approval.subscribe` on every reconnect. The
  // mount-time call above covers the first connect (it queues + drains) and
  // the mounted-while-already-connected case (route navigation); this covers
  // a later drop+reconnect — where a restarted server kept no subscription
  // record + a failed boot-time subscribe left a stale `liveError`.
  if (opts.reconnect !== undefined) {
    unsubscribers.push(
      opts.reconnect(() => {
        if (disposed) return;
        // resetSeqBaseline: a restarted server's seq epoch starts over, so
        // adopt the re-subscribe snapshot's seq instead of the stale
        // pre-restart high-water (else every post-restart event is dropped).
        startApprovalSubscription({ resetSeqBaseline: true });
        void doRefreshApprovals();
      }),
    );
  }

  const refreshQueue = (): Promise<void> => {
    if (refreshingQueue || disposed) return pendingQueueRefresh;
    refreshingQueue = true;
    renderChrome();
    pendingQueueRefresh = (async () => {
      try {
        startApprovalSubscription({ resetSeqBaseline: true });
        await Promise.all([
          doRefreshApprovals(),
          pendingApprovalSubscribe,
          panel.refresh(),
          opts.chatPlans?.refresh?.() ?? Promise.resolve(),
        ]);
      } finally {
        refreshingQueue = false;
        if (!disposed) renderChrome();
      }
    })();
    return pendingQueueRefresh;
  };
  const onRefreshClick = (): void => {
    if (refreshButton.getAttribute('aria-disabled') === 'true') return;
    void refreshQueue();
  };
  refreshButton.addEventListener('click', onRefreshClick);

  return {
    asksPanel: () => panel,
    getApprovals: () => approvalState.approvals,
    getApprovalState: () => approvalState.phase,
    getApprovalError: () =>
      (approvalState.listError ?? approvalState.liveError)?.error.copy ?? null,
    refreshApprovals: () => doRefreshApprovals(),
    resolveApproval: (approval_id, decision) =>
      resolveApprovalFromCard(approval_id, decision),
    whenLoaded: async () => {
      await Promise.all([
        pendingApprovalLoad,
        pendingApprovalSubscribe,
        panel.whenLoaded(),
        opts.chatPlans?.whenLoaded?.() ?? Promise.resolve(),
      ]);
    },
    getRecoveryContextFreshness: () =>
      approvalState.listError === null
      && approvalState.liveError === null
      && panel.getListError() === null
      && (opts.chatPlans?.state?.().error ?? null) === null
        ? 'current'
        : 'unavailable',
    retryRecoveryContext: () => refreshQueue(),
    hasInFlightWork: () => refreshingQueue
      || resolvingSecrets.size > 0
      || resolving.size > 0
      || resolvingAsks.size > 0
      || resolvingPlans.size > 0
      || panel.hasInFlightWork(),
    inFlightWorkPrompt: () => resolvingSecrets.size > 0
      ? 'A sign-in value is still being given. Leave Approvals anyway?'
      : refreshingQueue
      || resolving.size > 0
      || resolvingAsks.size > 0
      || resolvingPlans.size > 0
      || panel.hasInFlightWork()
        ? 'Something is still happening here. Leave anyway?'
        : null,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      resolvingSecrets.clear(); secretErrors.clear();
      askNoteDrafts.dispose();
      renderedCards = [];
      searchInput.removeEventListener('input', onSearchInput); searchInput.removeEventListener('keydown', onSearchKeydown); clearFilters.removeEventListener('click', onClearFilters);
      previousDecision.removeEventListener('click', onPreviousDecision); nextDecision.removeEventListener('click', onNextDecision);
      routeRoot.removeEventListener('focusin', onDecisionFocus);
      queue.removeEventListener('keydown', onQueueKeyDown);
      desktopBreakpoint?.removeEventListener?.('change', onDesktopBreakpointChange);
      refreshButton.removeEventListener('click', onRefreshClick);
      for (const unsub of unsubscribers) {
        try {
          unsub();
        } catch {
          // Subscriber teardown is best effort; DOM and panel teardown continue.
        }
      }
      unsubscribers.length = 0;
      panel.dispose();
      try {
        opts.root.removeChild(routeRoot);
      } catch {
        // A detached / fake host can throw on removeChild. The panel is
        // already disposed and the caller owns the root.
      }
    },
  };
};
