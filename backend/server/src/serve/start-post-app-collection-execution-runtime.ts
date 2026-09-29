import {
  composeCollectionContext,
  type CollectionContext,
  type ComposeCollectionContextOptions,
} from './compose-collection-context.js';
import {
  composeExecutionContext,
  type ComposeExecutionContextOptions,
  type ExecutionContext,
} from './compose-execution-context.js';
import {
  startPostExecutionBootstrapMaintenanceRuntime,
  type PostExecutionBootstrapMaintenanceRuntimeResult,
  type StartPostExecutionBootstrapMaintenanceRuntimeOptions,
} from './start-post-execution-bootstrap-maintenance-runtime.js';
import { attemptPeerAskDelivery } from '../execute-handler.js';
import {
  journalOwnsInterruptedPeerDispatch,
  recoverPeerAskDeliveries,
} from '../peer-ask-delivery-recovery.js';
import { createPeerAnswerStore } from '../storage/peer-answer-store.js';

type CollectionContextKey = 'collection';
type RecoveryRuntimeKeys =
  | 'collection'
  | 'notificationBlock'
  | 'getBatch'
  | 'reconcileOpenBatch';
type PreListenerRuntimeKeys =
  | 'collection'
  | 'execution'
  | 'executorConfig'
  | 'executeDeps';

export interface StartPostAppCollectionExecutionRuntimeOptions {
  readonly collection: ComposeCollectionContextOptions;
  readonly execution: Omit<ComposeExecutionContextOptions, 'collection'>;
  readonly postExecution: Omit<
    StartPostExecutionBootstrapMaintenanceRuntimeOptions,
    'bootstrapCascade' | 'runtime'
  > & {
    readonly bootstrapCascade: Omit<
      StartPostExecutionBootstrapMaintenanceRuntimeOptions['bootstrapCascade'],
      CollectionContextKey
    >;
    readonly runtime: Omit<
      StartPostExecutionBootstrapMaintenanceRuntimeOptions['runtime'],
      'lifecycle' | 'recovery' | 'preListener'
    > & {
      readonly lifecycle: Omit<
        StartPostExecutionBootstrapMaintenanceRuntimeOptions['runtime']['lifecycle'],
        CollectionContextKey
      >;
      readonly recovery: Omit<
        StartPostExecutionBootstrapMaintenanceRuntimeOptions['runtime']['recovery'],
        RecoveryRuntimeKeys
      >;
      readonly preListener: Omit<
        StartPostExecutionBootstrapMaintenanceRuntimeOptions['runtime']['preListener'],
        PreListenerRuntimeKeys
      >;
    };
  };
}

export interface PostAppCollectionExecutionRuntimeResult {
  readonly collection: CollectionContext;
  readonly execution: ExecutionContext;
  readonly postExecution: PostExecutionBootstrapMaintenanceRuntimeResult;
}

export const startPostAppCollectionExecutionRuntime = async (
  options: StartPostAppCollectionExecutionRuntimeOptions,
): Promise<PostAppCollectionExecutionRuntimeResult> => {
  const collection = composeCollectionContext(options.collection);

  const execution = await composeExecutionContext({
    ...options.execution,
    collection,
  });

  // Supervision feature — late-bind the cli executor onto the daemon supervisor
  // now that execution is composed (collection built it with an unbound
  // resolver). Done before any boot step runs `startCollectionAdapters`, so the
  // boot reconcile's launches resolve a live executor.
  if (execution.executeDeps.cliInvocationExecutor) {
    collection.supervisionStack?.bindExecutor(execution.executeDeps.cliInvocationExecutor);
  }

  const peerOutbox = execution.executeDeps.peerAskOutbox;
  const peerAuditLog = execution.executeDeps.auditLog;
  const peerCheckpoints = execution.executeDeps.checkpointStore;
  const peerDb = execution.executeDeps.db;
  const peerDeliveryBoot = peerOutbox !== undefined
    && peerAuditLog !== undefined
    && peerCheckpoints !== undefined
    && peerDb !== undefined
    ? {
        recoverPeerDeliveries: async (): Promise<void> => {
          await recoverPeerAskDeliveries({
            canPublishReviewedCheckpoint: checkpoint => execution.executeDeps.preapprovalRuntime?.canPublishCheckpoint(checkpoint.checkpoint_id) ?? false,
            outbox: peerOutbox,
            auditLog: peerAuditLog,
            checkpoints: peerCheckpoints,
            answers: createPeerAnswerStore(peerDb),
            ...(execution.executeDeps.gatedActionStore !== undefined
              ? { gatedActions: execution.executeDeps.gatedActionStore }
              : {}),
            deliver: (row, anchor) =>
              attemptPeerAskDelivery(execution.executeDeps, row, anchor),
            // The lifecycle lock is held and live traffic has not started, so
            // a staged row without its exact awaiting-peer anchor cannot still
            // be racing the append. Retire it rather than leave an immortal P2.
            retireUnanchoredStaged: true,
          });
        },
        preserveInterruptedDispatch: (
          record: Parameters<typeof journalOwnsInterruptedPeerDispatch>[0],
        ) => journalOwnsInterruptedPeerDispatch(record, {
          outbox: peerOutbox,
          auditLog: peerAuditLog,
          checkpoints: peerCheckpoints,
        }),
      }
    : undefined;

  const postExecution = await startPostExecutionBootstrapMaintenanceRuntime({
    ...options.postExecution,
    publishScheduleDeps: options.execution.lateBound.publishScheduleDeps,
    bootstrapCascade: {
      ...options.postExecution.bootstrapCascade,
      collection,
    },
    runtime: {
      ...options.postExecution.runtime,
      lifecycle: {
        ...options.postExecution.runtime.lifecycle,
        collection,
        // D-178 P1 restart-drain follow-up — feed the in-flight registry's
        // active-run count into the lifecycle drain so a restart awaits the
        // engine work the cron tick is blind to (owner / MCP / chat /
        // reactive / scheduled). Composed here because the execution context
        // (and its registry) lands before the lifecycle is wired.
        getActiveRunCount: () =>
          execution.executeDeps.inFlightRegistry?.activeRunCount() ?? 0,
      },
      recovery: {
        ...options.postExecution.runtime.recovery,
        notificationBlock: execution.notificationBlock,
        ...(peerDeliveryBoot ?? {}),
        ...(execution.getBatch !== undefined
          ? { getBatch: execution.getBatch }
          : {}),
        ...(execution.reconcileOpenBatch !== undefined
          ? { reconcileOpenBatch: execution.reconcileOpenBatch }
          : {}),
        // D-287 follow-on — torn-saga disclosure, pre-bound by the execution
        // composer (see `sagaSweep` there).
        ...(execution.sagaSweep !== undefined
          ? { sagaSweep: execution.sagaSweep }
          : {}),
        // D-308 — pre-bound by the execution composer (see `permanentPassRepair`).
        ...(execution.permanentPassRepair !== undefined
          ? { permanentPassRepair: execution.permanentPassRepair }
          : {}),
        ...(execution.workEntityTextDatesNotice !== undefined
          ? { workEntityTextDatesNotice: execution.workEntityTextDatesNotice }
          : {}),
        collection,
      },
      preListener: {
        ...options.postExecution.runtime.preListener,
        collection,
        execution,
        executorConfig: execution.executorConfig,
        executeDeps: execution.executeDeps,
      },
    },
  });

  return {
    collection,
    execution,
    postExecution,
  };
};
