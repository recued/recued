export type {
  ApprovalProvider, TrustStateStore, SessionStore, PendingQueue, ManifestLookup,
} from './types.js';
export { createTrustStateStore } from './trust-store.js';
export { createSessionStore } from './session-store.js';
export { createPendingQueue } from './pending-queue.js';
export {
  withApprovals,
  ApprovalDeniedError, ApprovalTimeoutError, ApprovalCancelledError,
  type ExecutionMode, type WithApprovalsOptions,
} from './with-approvals.js';

// D-113 — executor ↔ gossip bus bridge.
export {
  createApprovalBus,
  type ApprovalBus,
  type ApprovalBusDeps,
} from './gossip/bus.js';

// D-113 — chat adapter contract + coordination helpers.
export {
  shouldUpdateChannel,
  appendSlackHandle,
  appendTelegramHandle,
  markChannelUpdateDone,
  resolvedSummary,
  actorLine,
  type ApprovalChatAdapter,
  type ChatChannel,
  type ChatHandle,
  type ShouldUpdateDeps,
} from './gossip/chat-adapter.js';

// D-113 — Multi-surface approval channels + gossip protocol.
export {
  createLocalState,
  mergeRemote,
  pickEffective,
  scanForTimeouts,
  adoptWorkerDispatch,
  applyTimeoutPolicy,
  computeEffectiveDecision,
  extractContribution,
  type LocalApprovalState,
  type RemoteContribution,
  type MergeResult,
  type MergeDeps,
} from './gossip/data-plane.js';
export {
  visiblePendings,
  createRecentResolvedTracker,
  type RecentResolvedEntry,
  type RecentResolvedTracker,
} from './gossip/view-plane.js';
export {
  gossipActive,
  encryptRecord,
  decryptRecord,
  encryptContribution,
  decryptComposite,
  type GossipActiveContext,
  type ApprovalDEK,
} from './gossip/heartbeat.js';
