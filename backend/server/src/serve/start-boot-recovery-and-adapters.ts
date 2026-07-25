import { dirname } from 'node:path';
import type { NotificationBlock } from '@recued/notification';
import type { AuditLogStore, CheckpointStore, CommitStore } from '@recued/storage';
import type { Lifecycle } from '../lifecycle/index.js';
import {
  raiseInDoubtForSweptCommits,
  recoverNotificationBlockAtBoot,
} from '../composition/bin/wire-notification-block.js';
import { createPassportAuditEmitter } from '../passport/index.js';
import { commitRestoreProvenanceAtBoot } from '../archive/restore-provenance.js';
import type { BootedServerIdentity } from '../identity/boot.js';
import type { FileStack } from '../collections/file/compose.js';
import type { CollectionContext } from './compose-collection-context.js';

import type { ReceptionInboxFanoutMode } from '@recued/contracts';

export interface StartBootRecoveryAndAdaptersOptions {
  readonly lifecycle: Lifecycle | undefined;
  readonly bootSigningIdentity: () => Promise<void>;
  readonly notificationBlock: NotificationBlock | undefined;
  readonly checkpointStore: CheckpointStore | undefined;
  readonly auditLog: AuditLogStore | undefined;
  readonly commitStore: CommitStore | undefined;
  readonly fileStack: FileStack | undefined;
  readonly collection: Pick<CollectionContext, 'startCollectionAdapters'>;
  /** Absolute server db path. `dirname(dbPath)` is the data dir holding the
   *  restore-provenance marker the post-restart hook commits + clears (M5 S1).
   *  Absent on a db-less harness ⇒ the hook is skipped. */
  readonly dbPath?: string;
  /** Live signing-identity getter, read AFTER `bootSigningIdentity()` to
   *  record the restore's new publisher_id. Absent ⇒ the provenance hook is
   *  skipped. */
  readonly getSigningIdentity?: () => BootedServerIdentity | undefined;
  /** D-210 Phase C — the owner's inbox device-fanout mode. Threaded into
   *  the awaiting-checkpoint sweep so a notify-mode reception hold, which
   *  is ask-less BY DESIGN, is not re-raised as an actionable card on
   *  every boot. Absent ⇒ the sweep re-raises everything ask-less, as it
   *  did before Phase C. */
  readonly resolveInboxFanoutMode?: () => ReceptionInboxFanoutMode;
  readonly warn?: (message: string) => void;
}

export const startBootRecoveryAndAdapters = async (
  options: StartBootRecoveryAndAdaptersOptions,
): Promise<void> => {
  const {
    lifecycle,
    bootSigningIdentity,
    notificationBlock,
    checkpointStore,
    auditLog,
    commitStore,
    fileStack,
    collection,
    dbPath,
    getSigningIdentity,
    warn = (message) => console.warn(message),
  } = options;

  if (lifecycle) {
    // Identity and recovery writes stay behind the lifecycle lock claim.
    await bootSigningIdentity();

    // M5 S1 — if a restore staged a provenance marker, record the old→new
    // identity lineage into the (now-restored) audit ledger, then clear it.
    // Runs right after the signing identity is up (its fingerprint is the new
    // publisher_id) + on the restored db. Best-effort: a no-op when no marker
    // is present, and it never throws (provenance is an informational receipt,
    // not boot-critical). Skipped on a db-less / identity-less harness.
    const booted = getSigningIdentity?.();
    if (dbPath && auditLog && booted) {
      await commitRestoreProvenanceAtBoot({
        dataPath: dirname(dbPath),
        serverIdentity: () => booted.identity.serverIdentityKey(),
        audit: createPassportAuditEmitter(auditLog),
        warn,
      });
    }

    if (notificationBlock && checkpointStore && auditLog) {
      await recoverNotificationBlockAtBoot({
        block: notificationBlock,
        checkpointStore,
        auditLog,
        ...(options.resolveInboxFanoutMode !== undefined
          ? { resolveInboxFanoutMode: options.resolveInboxFanoutMode }
          : {}),
      });
    }

    if (commitStore) {
      const sweptCommits = await commitStore.sweepPendingToInDoubt();
      if (sweptCommits.length > 0) {
        warn(
          `[commits] crash recovery — ${sweptCommits.length} non-terminal `
            + 'commit(s) from a prior run marked in_doubt',
        );
      }
      if (notificationBlock) {
        await raiseInDoubtForSweptCommits({
          block: notificationBlock,
          sweptCommits,
        });
      }
    }
  }

  if (fileStack) {
    await fileStack.startAll();
  }

  await collection.startCollectionAdapters();
};
