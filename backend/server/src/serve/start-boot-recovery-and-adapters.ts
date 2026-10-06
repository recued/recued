import { dirname } from 'node:path';
import type { NotificationBlock } from '@recued/notification';
import type { AuditLogStore, CheckpointStore, CommitStore } from '@recued/storage';
import type { Lifecycle } from '../lifecycle/index.js';
import {
  raiseInDoubtForSweptCommits,
  recoverNotificationBlockAtBoot,
  type NotificationBlockBootRecoveryDeps,
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
import type { GatedActionStore } from '../gated-action-store.js';
import type { PreflightBootSweepDeps } from '../preflight-boot-sweep.js';
import type { PreapprovalStorage } from '../storage/preapproval-storage.js';

import type { TornSagaSweepResult } from '@recued/gateway';
import type { PermanentPassRepairBootResult } from '../seller/permanent-pass-repair.js';
import type { WorkEntityTextDatesNoticeResult } from '../work-entity-date-repair-notice.js';
import type { AutoRunSwitchOnNoticeResult } from '../auto-run-switch-on-notice.js';
import type { AutoRunTimerRearmResult } from '../auto-run-timer-rearm.js';
import type { MailAttachmentLinkRepairResult } from '../collections/mail/mail-attachment-link-repair.js';

export interface StartBootRecoveryAndAdaptersOptions {
  readonly lifecycle: Lifecycle | undefined;
  readonly bootSigningIdentity: () => Promise<void>;
  readonly notificationBlock: NotificationBlock | undefined;
  readonly checkpointStore: CheckpointStore | undefined;
  readonly auditLog: AuditLogStore | undefined;
  readonly commitStore: CommitStore | undefined;
  readonly gatedActionStore?: GatedActionStore;
  readonly preapprovalStorage?: Pick<PreapprovalStorage, 'recover'> & Partial<Pick<PreapprovalStorage, 'repository'>>;
  /** D-287 follow-on — one torn-saga disclosure pass, pre-bound by the
   *  composition root (it holds the annotation store and the manifest map this
   *  module has no other reason to know about). Absent ⇒ no sweep, which is
   *  the correct degradation: a server with no notifier had nowhere to
   *  disclose anyway. */
  readonly sagaSweep?: () => Promise<TornSagaSweepResult>;
  /** D-308 — the one-off repair of the passes D-306's defect left
   *  open-ended, pre-bound by the composition root. Absent ⇒ it waits for a
   *  boot that can tell the owner. */
  readonly permanentPassRepair?: () => Promise<PermanentPassRepairBootResult>;
  /** The notice for the dates the work-entity store repaired as it opened
   *  (`WORK_ENTITY_TEXT_DATES_REPAIR_ID`), pre-bound by the composition root.
   *  Absent without a notifier ⇒ it waits for a boot that has one. */
  readonly workEntityTextDatesNotice?: () => Promise<WorkEntityTextDatesNoticeResult>;
  /** D-319 — the one-time notice naming the recipes on a timer the update left
   *  switched off (`AUTO_RUN_SWITCH_ON_NOTICE_ID`), pre-bound by the
   *  composition root. On a boot with no notifier it records nothing and waits
   *  for one that has. */
  readonly autoRunSwitchOnNotice?: () => Promise<AutoRunSwitchOnNoticeResult>;
  /** D-319 — the one-shot repair giving each recipe's auto-run timer back to
   *  the dish it ran as, pre-bound by the composition root. Runs before the
   *  notice, which names what it switched on, and long before the scheduler
   *  builds its roster (`start-post-listener-runtime.ts`). */
  readonly autoRunTimerRearm?: () => AutoRunTimerRearmResult;
  /** The one-off removal of the attachment links two IMAP mailboxes shared
   *  (`MAIL_ATTACHMENT_SHARED_ID_REPAIR_ID`), pre-bound over the db. Runs
   *  before the mailboxes start, so their first sync re-files those
   *  attachments under each mailbox. */
  readonly mailAttachmentLinkRepair?: () => MailAttachmentLinkRepairResult;
  readonly getBatch?: PreflightBootSweepDeps['getBatch'];
  readonly reconcileOpenBatch?: PreflightBootSweepDeps['reconcileOpenBatch'];
  /** Exact peer-delivery journal recovery runs before generic dispatch-claim
   * reconciliation and before answered approvals are replayed. */
  readonly recoverPeerDeliveries?:
    NotificationBlockBootRecoveryDeps['recoverPeerDeliveries'];
  readonly preserveInterruptedDispatch?:
    NotificationBlockBootRecoveryDeps['preserveInterruptedDispatch'];
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
    gatedActionStore,
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

    // D-261 owns its receipt, member and pending commit as one transaction.
    // Run before generic approval replay; never hand its rows to the legacy
    // receipt/commit sweeps. While the vault is locked the pre-approval
    // storage gate stays closed; the normal unlock UI remains available.
    // Other recovery failures must stop boot before any scheduler starts.
    if (options.preapprovalStorage) {
      await options.preapprovalStorage.recover();
    }

    if (notificationBlock && checkpointStore && auditLog) {
      await recoverNotificationBlockAtBoot({
        canPublishReviewedCheckpoint: checkpoint => options.preapprovalStorage?.repository?.canPublishCheckpoint(checkpoint.checkpoint_id) ?? false,
        block: notificationBlock,
        checkpointStore,
        auditLog,
        ...(gatedActionStore !== undefined ? { gatedActionStore } : {}),
        ...(options.getBatch !== undefined ? { getBatch: options.getBatch } : {}),
        ...(options.reconcileOpenBatch !== undefined
          ? { reconcileOpenBatch: options.reconcileOpenBatch }
          : {}),
        ...(options.recoverPeerDeliveries !== undefined
          ? { recoverPeerDeliveries: options.recoverPeerDeliveries }
          : {}),
        ...(options.preserveInterruptedDispatch !== undefined
          ? { preserveInterruptedDispatch: options.preserveInterruptedDispatch }
          : {}),
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

    // D-287 follow-on — torn runs whose ask never reached the owner.
    //
    // ⚠ AFTER the commit sweep, not before. A commit still in flight when the
    // process died reads non-terminal until `sweepPendingToInDoubt` settles it;
    // running first would classify it as neither landed nor uncertain, and the
    // owner would be shown a torn run missing the very write whose fate is
    // unknown. Ordering is the only coupling between the two sweeps.
    //
    // Best-effort: a boot must not fail on a disclosure pass.
    if (options.sagaSweep) {
      try {
        const swept = await options.sagaSweep();
        if (swept.raised > 0 || swept.errored > 0) {
          warn(
            `[saga] boot sweep — ${swept.raised} torn run(s) disclosed, `
              + `${swept.suppressed} already seen, ${swept.errored} unreadable `
              + `(of ${swept.scanned} failed run(s) inspected)`,
          );
        }
      } catch (error) {
        warn(
          '[saga] boot sweep failed: '
            + (error instanceof Error ? error.message : String(error)),
        );
      }
    }

    // D-308 — behind the lock claim too: it writes customers' access. The
    // repair commits all or nothing and is retried by the next boot, and so
    // is a notice that did not reach the history, so neither fails a boot.
    if (options.permanentPassRepair) {
      try {
        const repair = await options.permanentPassRepair();
        if (repair.applied && (repair.repaired > 0 || repair.left > 0)) {
          warn(
            `[seller] D-308 repair — ${repair.repaired} open-ended pass(es) `
              + `given their end, ${repair.left} left for the owner to decide`,
          );
        }
      } catch (error) {
        warn(
          '[seller] D-308 pass repair failed, retrying next boot: '
            + (error instanceof Error ? error.message : String(error)),
        );
      }
    }

    // The dates the work-entity store repaired as it opened: tell the owner
    // once. A notice that did not reach the history is retried next boot.
    if (options.workEntityTextDatesNotice) {
      try {
        const notice = await options.workEntityTextDatesNotice();
        if (notice.noticed) {
          warn(
            `[work-entities] ${notice.fixed} date(s) stored as text converted, `
              + `${notice.cleared} that named no date cleared — the owner was told`,
          );
        }
      } catch (error) {
        warn(
          '[work-entities] text-dates repair notice failed, retrying next boot: '
            + (error instanceof Error ? error.message : String(error)),
        );
      }
    }

    // D-319 — the update stopped every auto-run timer: give each recipe's back
    // to the dish it ran as, once. Before the notice, which names what this
    // switched on, and before the scheduler's first roster, which this boot
    // builds after the listener. All or nothing, so a failure is retried by
    // the next boot.
    if (options.autoRunTimerRearm) {
      try {
        const rearm = options.autoRunTimerRearm();
        if (rearm.applied && rearm.path !== 'nothing') {
          warn(
            `[auto-run] D-319 timers ${rearm.path} — ${rearm.rearmed} switched on, `
              + `${rearm.kept_off} kept off, ${rearm.tripped} still stopped by failures, `
              + `${rearm.left} left as they were`,
          );
        }
      } catch (error) {
        warn(
          '[auto-run] D-319 timer re-arm failed, retrying next boot: '
            + (error instanceof Error ? error.message : String(error)),
        );
      }
    }

    // D-319 — the update stopped every auto-run timer until its recipe is
    // switched on: tell the owner once which recipes are not, and which the
    // re-arm switched on. A notice that did not reach the history is retried
    // next boot.
    if (options.autoRunSwitchOnNotice) {
      try {
        const notice = await options.autoRunSwitchOnNotice();
        if (notice.outcome === 'noticed') {
          warn(
            `[auto-run] ${notice.named} recipe(s) on a timer are not switched on`
              + (notice.switched_on > 0 ? `, ${notice.switched_on} were switched on` : '')
              + ' — the owner was told',
          );
        }
      } catch (error) {
        warn(
          '[auto-run] switch-on notice failed, retrying next boot: '
            + (error instanceof Error ? error.message : String(error)),
        );
      }
    }

    // Behind the lock claim (it deletes links) and before the mailboxes start.
    // It commits all or nothing, so a failure is retried by the next boot.
    if (options.mailAttachmentLinkRepair) {
      try {
        const repair = options.mailAttachmentLinkRepair();
        if (repair.applied && repair.unlinked > 0) {
          warn(
            `[mail] ${repair.unlinked} attachment link(s) two IMAP mailboxes shared `
              + "removed — the next sync files recent emails' attachments under each mailbox",
          );
        }
      } catch (error) {
        warn(
          '[mail] shared attachment link repair failed, retrying next boot: '
            + (error instanceof Error ? error.message : String(error)),
        );
      }
    }
  }

  if (fileStack) {
    await fileStack.startAll();
  }

  await collection.startCollectionAdapters();
};
