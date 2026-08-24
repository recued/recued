import type { RuntimeConfigStore } from '@recued/config';
import type { NotificationBlock } from '@recued/notification';

import { isAutoPiiDisabled } from '../auto-pii-apply.js';
import type { BackgroundServiceRegistry } from '../composition/bin/wire-background-services.js';
import type { EvictionCascade } from '../eviction-cascade.js';
import type { BootedServerIdentity } from '../identity/boot.js';
import type { Lifecycle } from '../lifecycle/index.js';
import type { AppContext } from './compose-app-context.js';
import type { CollectionContext } from './compose-collection-context.js';
import type { ListenerServerFacade } from './compose-listeners.js';
import type { StorageContext } from './compose-storage-context.js';
import {
  installShutdown,
  type InstalledShutdown,
} from './install-shutdown.js';
import { logBootBanner } from './log-boot-banner.js';
import { SERVER_VERSION } from '../server-version.js';
import { startDdnsUpdatePoller } from './start-ddns-update-poller.js';
import { startHostnameReconciliationRunner } from './start-hostname-reconciliation-runner.js';
import { startRetentionPruners } from './start-retention-pruners.js';

export type PostHousekeepingTailStorageContext = Pick<
  StorageContext,
  | 'db'
  | 'manifests'
  | 'recipeStore'
  | 'pairing'
  | 'recoveryKeyCheck'
  | 'auditRetention'
  | 's2sPreviewStoreRef'
  | 'correctionEventsStoreRef'
  | 'fileStack'
  // D-157 N.8 — the stale-checkpoint retention sweep's stores.
  | 'checkpointStore'
  | 'auditLog'
  | 'drainAuditWrites'
  // D-240 slice 4 — the two readers the viewback stamp joins: a deferred
  // credential names a SUBMISSION, whose resolved target is a work entity whose
  // `done` is the fact the stamp waits on.
  | 'intakeFormSubmissionStoreRef'
  | 'workEntityStoreRef'
  | 'formResponseStoreRef'
>;

export type PostHousekeepingTailAppContext = Pick<
  AppContext,
  'llmConfig' | 'executionCaseLifecycle' | 'executionCaseArgumentStore'
  | 'executionCaseSourcePruner' | 'sharedStoreRef' | 'chatInboundTokenStoreRef'
  // D-240 slice 4 — the credential store the retention pass owns.
  | 'receptionManageCredentialStoreRef'
>;

export type PostHousekeepingTailCollectionContext = Pick<
  CollectionContext,
  | 'calendarStack'
  | 'serviceStack'
  | 'supervisionStack'
>;

export interface StartPostHousekeepingTailOptions {
  readonly dbPath: string;
  readonly runtimeConfig: RuntimeConfigStore;
  readonly backgroundServices: BackgroundServiceRegistry;
  readonly storage: PostHousekeepingTailStorageContext;
  readonly app: PostHousekeepingTailAppContext;
  readonly collection: PostHousekeepingTailCollectionContext;
  readonly cloudBaseUrl: string;
  readonly getSigningIdentity: () => BootedServerIdentity | undefined;
  readonly lifecycle: Pick<Lifecycle, 'install' | 'markBooted'> | undefined;
  readonly cascade: Pick<EvictionCascade, 'close'> | undefined;
  readonly server: Pick<ListenerServerFacade, 'port' | 'close'>;
  /** Whether the bundled webclient is served (banner: advertise the local
   *  `/webclient/` URL only when it actually serves). */
  readonly webclientServed: boolean;
  /** D-157 N.8 — the notification block's ask-state reads for the
   *  stale-checkpoint sweep (threaded from the execution context;
   *  undefined on db-less boots, where the sweep is skipped anyway). */
  readonly notificationBlock:
    | Pick<NotificationBlock, 'getAsk' | 'cancelAsk' | 'pruneHandledAsks' | 'notify'>
    | undefined;
  /** D-178 slice 4b — on-boot update reconcile (commit / auto-revert +
   *  ledger→audit replay). Invoked AFTER `installShutdown` runs markBooted,
   *  so a staged release that reached a serving state commits. Best-effort
   *  (the thunk swallows its own errors); undefined on a delegated channel. */
  readonly runUpdateBootReconcile?: (() => Promise<void>) | undefined;
  /** D-148 § A.5.6 — threaded to the DDNS poller so a lapsed subscription
   *  records 'grace' through the state machine (never a direct store write —
   *  `persist()` fires the cert stack's snapshot refresh). */
  readonly applyLifecycle?: () => Pick<
    import('../handle/index.js').HandleStateMachine,
    'applyLifecycleUpdate'
  > | undefined;
}

export const startPostHousekeepingTail = (
  options: StartPostHousekeepingTailOptions,
): InstalledShutdown => {
  const { storage } = options;

  startRetentionPruners({
    backgroundServices: options.backgroundServices,
    runtimeConfig: options.runtimeConfig,
    auditRetention: storage.auditRetention,
    s2sPreviewStore: storage.s2sPreviewStoreRef,
    correctionEventsStore: storage.correctionEventsStoreRef,
    mcpRecipeCallbackStore: options.app.sharedStoreRef,
    mcpRecipeCallbackTokenStore: options.app.chatInboundTokenStoreRef,
    checkpointStore: storage.checkpointStore,
    auditLog: storage.auditLog,
    executionCaseLifecycle: options.app.executionCaseLifecycle,
    // D-219 — bound the capture-only argument buffer. Absent (db-less /
    // chat-less boot) ⇒ no sweep, because nothing captured either.
    ...(options.app.executionCaseArgumentStore
      ? { executionCaseArgumentStore: options.app.executionCaseArgumentStore }
      : {}),
    // D-219 — bound the source corpus 9a made grow on ~87% of turns.
    ...(options.app.executionCaseSourcePruner
      ? { executionCaseSourcePruner: options.app.executionCaseSourcePruner }
      : {}),
    notificationBlock: options.notificationBlock,
    // D-240 slice 4 — the reception credential retention pass.
    //
    // ⛔⛔ THIS THREAD IS THE POINT OF THE SLICE, NOT PLUMBING. `purge` has had
    // NO caller since D-210 Appendix B shipped it, so
    // `reception_manage_credentials` has been append-only — and slice 2's
    // `ceiling_at` backstop was resting on a collector that never ran. A
    // registration nobody supplies deps to would have repeated the same mistake
    // one layer up, which is why the reader is built HERE from the two stores
    // that already exist rather than left as an unfilled option.
    ...(options.app.receptionManageCredentialStoreRef
      ? { receptionCredentialStore: options.app.receptionManageCredentialStoreRef }
      : {}),
    ...(storage.intakeFormSubmissionStoreRef && storage.workEntityStoreRef
      ? {
          receptionRecordCompletion: ({ record_id }: { record_id: string }) => {
            const submission = storage.intakeFormSubmissionStoreRef!.findById(record_id);
            // No row, or nothing materialized yet ⇒ keep waiting. Both are the
            // ordinary open-request state, not a fault.
            if (submission === null) return null;
            const targetId = submission.resolved_target_id;
            if (typeof targetId !== 'string' || targetId.length === 0) return null;
            // § D7 — every destination that can REPORT completion, which the
            // config validator now also enforces at write time
            // (`visitor_lookup_target_has_no_completion`). The two must agree:
            // a kind accepted there and unreadable here would leave the
            // credential alive to its ceiling, silently.
            switch (submission.resolved_target_kind) {
              case 'task': {
                const task = storage.workEntityStoreRef!.readTask(targetId);
                if (task === null) return null;
                return {
                  done: task.done === true,
                  ...(typeof task.completed_at === 'number'
                    ? { completed_at: task.completed_at }
                    : {}),
                };
              }
              case 'booking': {
                // ⚠ `cancelled` and `no_show` are ENDINGS too. A viewback that
                // stayed live to the ceiling because the booking was cancelled
                // would outlive the thing it reports on by months.
                const booking = storage.workEntityStoreRef!.readBooking(targetId);
                if (booking === null) return null;
                const ended = booking.lifecycle_state === 'completed'
                  || booking.lifecycle_state === 'cancelled'
                  || booking.lifecycle_state === 'no_show';
                return {
                  done: ended,
                  ...(typeof booking.state_changed_at === 'number'
                    ? { completed_at: booking.state_changed_at }
                    : {}),
                };
              }
              case 'form_response': {
                if (storage.formResponseStoreRef === undefined) return null;
                const response = storage.formResponseStoreRef.findById(targetId);
                if (response === null || response === undefined) return null;
                const ended = response.lifecycle_state === 'accepted'
                  || response.lifecycle_state === 'declined'
                  || response.lifecycle_state === 'no_show';
                return {
                  done: ended,
                  ...(typeof response.updated_at === 'number'
                    ? { completed_at: response.updated_at }
                    : {}),
                };
              }
              default:
                // `note` / `calendar` / `contact` never finish — refused at
                // config write, so reaching here means a config stored before
                // that refusal existed. Keep waiting; the ceiling collects it.
                return null;
            }
          },
        }
      : {}),
  });

  startDdnsUpdatePoller({
    db: storage.db,
    backgroundServices: options.backgroundServices,
    cloudBaseUrl: options.cloudBaseUrl,
    getSigningIdentity: options.getSigningIdentity,
    ...(options.applyLifecycle ? { applyLifecycle: options.applyLifecycle } : {}),
  });

  startHostnameReconciliationRunner({
    db: storage.db,
    backgroundServices: options.backgroundServices,
  });

  logBootBanner({
    version: SERVER_VERSION,
    port: options.server.port,
    webclientServed: options.webclientServed,
    dbPath: options.dbPath,
    recipeCount: storage.recipeStore.size(),
    llmConfig: options.app.llmConfig,
    pairingCode: storage.pairing?.getCode(),
    notEnrolled: storage.recoveryKeyCheck
      ? !storage.recoveryKeyCheck.exists()
      : false,
    // Read through the seam's own predicate so the banner can never disagree
    // with what the dispatch path actually does.
    autoPiiDisabled: isAutoPiiDisabled(),
  });

  const shutdown = installShutdown({
    lifecycle: options.lifecycle,
    backgroundServices: options.backgroundServices,
    fileStack: storage.fileStack,
    calendarStack: options.collection.calendarStack,
    serviceStack: options.collection.serviceStack,
    supervisionStack: options.collection.supervisionStack,
    cascade: options.cascade,
    server: options.server,
    drainAuditWrites: storage.drainAuditWrites,
    db: storage.db,
  });

  // D-178 slice 4b — run the on-boot update reconcile AFTER markBooted (above):
  // the server is serving, so a staged release that reached here booted healthy
  // → commit. An auto-revert path requests a restart of its own. The operation
  // remains best-effort, but belongs to the emitter drain: it can write update
  // sidecars and audit state, so shutdown must not close persistence underneath it.
  if (options.runUpdateBootReconcile) {
    let reconcileDone: Promise<void>;
    try {
      reconcileDone = Promise.resolve(options.runUpdateBootReconcile()).catch(
        () => undefined,
      );
    } catch {
      // Preserve the best-effort contract even for a malformed injected thunk
      // that throws synchronously rather than returning a rejected promise.
      reconcileDone = Promise.resolve();
    }
    options.backgroundServices.register({
      name: 'update-boot-reconcile',
      kind: 'emitter',
      stop: () => reconcileDone,
    });
  }

  return shutdown;
};
