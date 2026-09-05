import type { RuntimeConfigStore } from '@recued/config';
import type { NotificationBlock } from '@recued/notification';
import type { AuditLogStore, CheckpointStore } from '@recued/storage';
import type { AuditRetention } from '../audit-retention.js';
import type { BackgroundServiceRegistry } from '../composition/bin/wire-background-services.js';
import { composeRetentionPruners } from '../composition/bin/wire-retention-pruners.js';
import type { S2SPreviewStore } from '../s2s-preview/store.js';
import type { CorrectionEventsStore } from '../storage/correction-events-store.js';
import type {
  ExecutionCaseLifecycle,
} from '../chat-execution-case-tools.js';
import type {
  ExecutionCaseArgumentStore,
} from '../storage/execution-case-argument-store.js';
import type {
  ExecutionCaseCompiler,
} from '../execution-case-compiler.js';
import type { SharedStore } from '../storage/shared-store.js';
import type { ChatInboundTokenStore } from '../storage/chat-inbound-token-store.js';
import type {
  ReceptionManageCredentialStore,
} from '../storage/reception-manage-credential-store.js';
import type {
  ReceptionLookupExpirySweepDeps,
} from '../reception-lookup-expiry-sweep.js';
import type { GatedActionStore } from '../gated-action-store.js';

export interface StartRetentionPrunersOptions {
  readonly backgroundServices: BackgroundServiceRegistry;
  readonly runtimeConfig: RuntimeConfigStore;
  readonly auditRetention: AuditRetention | undefined;
  readonly s2sPreviewStore: S2SPreviewStore | undefined;
  readonly correctionEventsStore: CorrectionEventsStore | undefined;
  readonly mcpRecipeCallbackStore?:
    | Pick<SharedStore, 'list' | 'read' | 'compareAndSet'>
    | undefined;
  readonly mcpRecipeCallbackTokenStore?:
    | Pick<ChatInboundTokenStore, 'getTokenById' | 'drainAuthorityChanges'>
    | undefined;
  /** D-219 — the capture-only argument buffer's age sweep. */
  readonly executionCaseArgumentStore?:
    | Pick<ExecutionCaseArgumentStore, 'pruneOlderThan'>
    | undefined;
  /** D-219 — the source-corpus retention sweep. */
  readonly executionCaseSourcePruner?:
    | Pick<ExecutionCaseCompiler, 'pruneSourcesOlderThan'>
    | undefined;
  /** D-157 N.8 — the stale-checkpoint sweep's stores + the notification
   *  block's ask-state reads. Any absent piece degrades per
   *  `composeRetentionPruners` (missing store skips the registration;
   *  missing block skips prompt bookkeeping only). */
  readonly checkpointStore: CheckpointStore | undefined;
  readonly auditLog: AuditLogStore | undefined;
  readonly gatedActionStore?: GatedActionStore | undefined;
  readonly executionCaseLifecycle: ExecutionCaseLifecycle | undefined;
  readonly notificationBlock:
    | Pick<
        NotificationBlock,
        'getAsk' | 'listUnresolvedAsks' | 'cancelAsk' | 'pruneHandledAsks' | 'notify'
      >
    | undefined;
  /** D-240 slice 4 — the reception credential store (stamp + the purge that
   *  D-210 shipped without a caller) and the record-completion reader the stamp
   *  needs. Absent ⇒ both passes skip, per `composeRetentionPruners`. */
  readonly receptionCredentialStore?: ReceptionManageCredentialStore | undefined;
  readonly receptionRecordCompletion?:
    | ReceptionLookupExpirySweepDeps['readCompletion']
    | undefined;
}

export const startRetentionPruners = (
  options: StartRetentionPrunersOptions,
): void => {
  composeRetentionPruners(options);
};
