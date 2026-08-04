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
import { replayKeyfileEventsIntoAudit } from '../keys/keyfile-event-replay.js';
import { sweepArchiveScratch } from '../archive/archive-scratch.js';
import { sweepAtomicWriteTemps } from '../durable-fs.js';
import { sweepSnapshotStaging } from '../open-database.js';
import {
  reclaimInboundScratch,
  totalInboundScratchReclaimed,
} from '../upload/inbound-scratch.js';
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
   *  restore-provenance marker the post-restart hook commits + clears (M5 S1),
   *  and the blob scratch the boot sweep reclaims. Absent on a db-less harness
   *  ⇒ both hooks are skipped. */
  readonly dbPath?: string;
  /** Canonical config file path, when one exists. Restore journal config stages
   *  are written beside it, so hard-exit atomic-write temps in a separate
   *  config directory need the same post-lock sweep as the data directory. */
  readonly configPath?: string | null;
  /** Live signing-identity getter, read AFTER `bootSigningIdentity()` to
   *  record the restore's new publisher_id. Absent ⇒ the provenance hook is
   *  skipped. */
  readonly getSigningIdentity?: () => BootedServerIdentity | undefined;
  /** Upload-session lookup, so the boot reclaim can tell a stranded upload
   *  scratch file from a session that is durably resumable across a restart.
   *  Absent ⇒ the upload tree is skipped and only the two single-request
   *  trees (reception drops, messenger media) are reclaimed. */
  readonly uploadSessions?: Pick<
    import('../storage/upload-session-store.js').UploadSessionStore,
    'get'
  >;
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
    configPath,
    getSigningIdentity,
    uploadSessions,
    warn = (message) => console.warn(message),
  } = options;

  if (lifecycle) {
    // Identity and recovery writes stay behind the lifecycle lock claim.
    await bootSigningIdentity();

    // Reclaim any decrypted blob scratch a hard kill stranded in the data dir.
    // Export and restore both unlink theirs in a `finally`, which SIGKILL and
    // power loss skip, and the CAS orphan sweep cannot see these (it only walks
    // the shard dirs). Here rather than earlier in boot because the lock claim
    // is what proves no export or restore of ours is holding one open.
    if (dbPath) {
      // Inbound media lands in the clear for the length of an upload, a drop
      // or a messenger download, and each unlinks in a `finally` that a
      // SIGKILL skips. Same reasoning as the archive scratch above; an upload
      // session is deliberately resumable across a restart, so only files no
      // session row owns are reclaimed.
      const inbound = reclaimInboundScratch(dirname(dbPath), {
        ...(uploadSessions ? { uploadSessions } : {}),
      });
      const inboundTotal = totalInboundScratchReclaimed(inbound);
      if (inboundTotal > 0) {
        warn(`[inbound] reclaimed ${inboundTotal} stranded scratch file(s)`);
      }
      // A kill between a shared atomic writer's temp and rename strands a 0600
      // file holding the whole document — keyfiles, bundle/journal state,
      // provenance, or staged config. Sweep the data directory and a distinct
      // config directory only after the lifecycle lock proves no writer in this
      // process is active.
      for (const dir of new Set([
        dirname(dbPath),
        ...(configPath ? [dirname(configPath)] : []),
      ])) {
        sweepAtomicWriteTemps(dir);
      }
      // `VACUUM INTO` staging left by a kill mid-snapshot — a full copy of the
      // realm each, and nothing else looks for them.
      sweepSnapshotStaging(dirname(dbPath));
      const swept = sweepArchiveScratch(dirname(dbPath));
      if (swept > 0) {
        warn(`[archive] reclaimed ${swept} stranded plaintext scratch file(s)`);
      }
    }

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

      // D-212 follow-on — `rotate-passphrase` and `recover-keyfile` change how
      // the realm's keys are protected with the server STOPPED, so neither can
      // write an audit row when it happens. Each appends to `keyfile-events.log`
      // beside the database; this mirrors what is not already recorded into the
      // activity log, idempotent on the ledger entry id. Here rather than
      // earlier because the row is high-assurance and `bootSigningIdentity()`
      // above is what makes the signing wrapper able to sign it.
      //
      // ⚠ Deliberately NOT gated on the ledger existing: `replayKeyfileEvents-
      // IntoAudit` is a no-op on a missing file, and a caller-side existence
      // check would be a second place for the filename to live.
      await replayKeyfileEventsIntoAudit({
        dataPath: dirname(dbPath),
        auditLog,
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
