/** D-178 slice 4b — the on-boot update reconcile (the `commit` half of the
 *  two-phase apply + the boot-health auto-revert + the ledger→audit replay).
 *
 *  The apply path (slice 4) stages a verified binary and asks the supervisor to
 *  restart. The COMMIT happens HERE, on the next boot: if the staged release
 *  booted healthy, we commit it; if it failed boot health enough times, we
 *  auto-revert to `recued.old` (restoring the pre-migration snapshot when the
 *  staged apply migrated) and restart back; a started-but-never-staged leftover
 *  (a crash before the swap) just releases the lock.
 *
 *  Separately, every boot REPLAYS the out-of-SQLite update ledger's terminal
 *  events into the D-120 audit log (I-3) — idempotent on the ledger entry id —
 *  so `update_applied` / `update_rolled_back` survive even a snapshot restore
 *  that rolled the SQLite file (and the audit rows it held) back.
 *
 *  Pure orchestration over injected ports + an audit sink + a best-effort
 *  notify, so the whole decision path is unit-testable without a real restart.
 */

import {
  deriveInFlightEntry,
  evaluatePendingApplyOnBoot,
  reconcileAbandonedUpdateReservations,
  type ApplyOrchestratorPorts,
} from './apply-orchestrator.js';
import { releaseIdentityOf } from './release-check.js';
import { unreplayedEntries, type UpdateLedger, type UpdateLedgerEntry } from './update-ledger.js';
import type { UpdateOwnerAlertSink } from './owner-alert.js';

/** The audit surface the replay needs — a narrow slice of the D-120 store. */
export interface UpdateAuditSink {
  listActivities(limit?: number): Promise<Array<{ activity_id: string }>>;
  logActivity(entry: {
    activity_id: string;
    timestamp: number;
    action: 'update_applied' | 'update_rolled_back';
    target: string;
    detail?: string;
  }): Promise<void>;
}

export interface BootReconcilePorts {
  ports: ApplyOrchestratorPorts;
  /** This booted binary's channel + version → its release identity. */
  channel: 'stable' | 'edge';
  currentVersion: string;
  /** D-120 audit sink for the ledger→audit replay (absent → replay skipped). */
  auditLog?: UpdateAuditSink;
  /** Owner-facing one-way notification. A committed update is surfaced when
   * this healthy boot appends its terminal; a prospective auto-revert is
   * surfaced while SQLite is still open, before lifecycle drains/restarts.
   * Best-effort: a throwing sink is swallowed and can never veto reconciliation. */
  ownerAlert?: UpdateOwnerAlertSink;
  /** Local post-drain report. This is deliberately NOT the owner notification:
   * the database and notification settings store are already closed inside the
   * restart callback, so wiring `notificationBlock.notify` here would look live
   * in tests and fail on the only production path that matters. */
  postDrainLog?: (message: string) => void;
}

export type BootReconcileOutcome =
  | { action: 'commit'; releaseIdentity: string }
  | { action: 'auto-revert'; releaseIdentity: string; reason: string }
  | { action: 'revert-complete'; releaseIdentity: string }
  | { action: 'staging-aborted'; releaseIdentity: string }
  | { action: 'webclient-recovery-failed'; releaseIdentity: string; reason: string }
  | { action: 'manual-rollback-recovered'; releaseIdentity: string; completed: boolean }
  | { action: 'manual-rollback-recovery-failed'; releaseIdentity: string; reason: string }
  | { action: 'continue' }
  | { action: 'not-applicable' };

/** Activity-id prefix so the replay can read back which ledger entries it has
 *  already mirrored (idempotency, I-3) — `update:<ledger-entry-id>`. */
const REPLAY_ID_PREFIX = 'update:';
const SUPERVISOR_REVERT_DETAIL_PREFIX = 'supervisor revert: ';

/** Start a best-effort notification without giving it authority over boot or
 * recovery. The production sink is fire-and-forget; this catch also protects
 * unit/minimal compositions that supply a synchronous callback. */
const signalOwnerAlert = (
  ownerAlert: UpdateOwnerAlertSink | undefined,
  alert: Parameters<UpdateOwnerAlertSink>[0],
): void => {
  try { ownerAlert?.(alert); } catch { /* reach must never become authority */ }
};

/** An `apply_reverted` is normally a pre-boot staging failure and stays only in
 * the forensic ledger. The outer supervisor is the exception: it restored a
 * release that could not launch at all, so its explicitly-labelled terminal is
 * a user-meaningful rollback and the first healthy boot must surface it. */
const isSupervisorRevert = (entry: UpdateLedgerEntry): boolean =>
  entry.kind === 'apply_reverted'
  && entry.trigger === 'revert'
  && (
    entry.recovery_source === 'outer-supervisor'
    // Additive compatibility: a terminal may have been written by the previous
    // binary immediately before this newly-updated binary first reads it.
    || (
      entry.recovery_source === undefined
      && entry.detail?.startsWith(SUPERVISOR_REVERT_DETAIL_PREFIX) === true
    )
  );

/** Replay the ledger's terminal apply/rollback events into the audit log,
 *  idempotent on the ledger entry id. `apply_committed`, `rolled_back`, and the
 *  explicitly-labelled outer-supervisor `apply_reverted` terminal surface as
 *  user-meaningful version-history rows; other intermediate/reverted events
 *  stay only in the forensic ledger. An unreplayed supervisor terminal also
 *  raises its one-way owner alert here, on the first healthy boot after the
 *  previous binary was restored. A committed apply is deliberately not
 *  announced from historical replay: after a later rollback restores an older
 *  SQLite snapshot, its old audit row can be absent even though that release is
 *  no longer live. The commit branch announces only the terminal it appends on
 *  this healthy boot. Best-effort: an audit write failure never blocks boot. */
const replayLedgerIntoAudit = async (
  ledger: UpdateLedger,
  auditLog: UpdateAuditSink,
  ownerAlert?: UpdateOwnerAlertSink,
): Promise<void> => {
  let seen: ReadonlySet<string>;
  try {
    const activities = await auditLog.listActivities();
    seen = new Set(
      activities
        .filter((a) => a.activity_id.startsWith(REPLAY_ID_PREFIX))
        .map((a) => a.activity_id.slice(REPLAY_ID_PREFIX.length)),
    );
  } catch {
    return; // can't read prior replay state → skip rather than risk duplicates
  }
  const fresh = unreplayedEntries(ledger, seen);
  for (const e of fresh) {
    const supervisorRevert = isSupervisorRevert(e);
    const action = e.kind === 'apply_committed'
      ? 'update_applied'
      : e.kind === 'rolled_back' || supervisorRevert
        ? 'update_rolled_back'
        : null;
    if (!action) continue;
    if (supervisorRevert) {
      const reason = e.detail?.startsWith(SUPERVISOR_REVERT_DETAIL_PREFIX)
        ? e.detail.slice(SUPERVISOR_REVERT_DETAIL_PREFIX.length)
        : e.detail ?? 'the outer supervisor restored the previous release';
      signalOwnerAlert(ownerAlert, {
        kind: 'supervisor-revert-complete',
        release_identity: e.release_identity,
        from_version: e.from_version,
        to_version: e.to_version,
        reason,
      });
    }
    // `target` carries the release identity (`<channel>:<version>`); the full
    // version-range + channel + trigger attribution rides in a JSON `detail`
    // (the ActivityEntry shape has no dedicated fields — same convention as the
    // other adapters that JSON-encode detail) so the D-120 update history is
    // structurally complete, not just the target id.
    const detail = JSON.stringify({
      from_version: e.from_version,
      to_version: e.to_version,
      channel: e.channel,
      trigger: e.trigger,
      ...(e.migration !== undefined ? { migration: e.migration } : {}),
      ...(e.detail ? { note: e.detail } : {}),
    });
    try {
      await auditLog.logActivity({
        activity_id: `${REPLAY_ID_PREFIX}${e.id}`,
        timestamp: e.at,
        action,
        target: e.release_identity,
        detail,
      });
    } catch {
      /* best-effort; the ledger entry stays unreplayed for the next boot */
    }
  }
};

/** Perform the auto-revert mechanics: restore the pre-migration snapshot (when
 *  the staged apply migrated + a snapshot exists), swap `recued.old` back, append
 *  a `rolled_back` terminal (releases the in-flight lock), reset the boot-failure
 *  counter, report the exact local result, and request a restart back into the
 *  prior binary. The owner-facing alert starts before this function is called,
 *  while the notification block's SQLite-backed settings are still readable. */
const performAutoRevert = (
  deps: BootReconcilePorts,
  staged: UpdateLedgerEntry,
  reason: string,
): void => {
  const { ports } = deps;
  // Restore FIRST (the failure-prone disk step); if it throws, the binary is
  // untouched so we stay consistent rather than running an old binary on a
  // migrated DB. The binary swap (atomic rename) goes last.
  const restoreSnapshot = (staged.migration ?? false) && ports.hasSnapshot();
  // ⛔⛔ DEFERRED PAST THE DRAIN, NOT DONE HERE. This runs from the post-LISTENER
  // boot tail, i.e. with the server already serving and the database OPEN.
  // `restoreSnapshot` replaces the database FILE, and doing that under a live
  // handle leaves the process reading an unlinked inode and accepting writes that
  // no later reader can see (reproduced 2026-08-31).
  //
  // Auto-revert cannot be made a manual, stopped-server operation the way the
  // owner-driven rollback can — it exists precisely to rescue a server nobody is
  // watching. But it ALWAYS restarts, and the restart drain's `close_db` step is
  // exactly the window where the file can be replaced safely. So everything that
  // touches disk moves into the post-drain callback, in the SAME order: restore
  // first (the failure-prone copy), binary swap last, so a failed restore still
  // leaves a consistent install. Same shape as archive-runtime's staged-restore
  // commit, for the same reason.
  //
  // ⚠ `drainOk === false` means some writer may still hold the database — fail
  // closed and change nothing. The staged entry stays unterminated, so the next
  // boot reconciles it again rather than the revert being silently lost.
  // ⛔⛔ NOTHING IS RECORDED UNTIL THE DISK WORK ACTUALLY HAPPENS. The first cut
  // of this deferral appended `rolled_back`, reset the boot-failure counter and
  // sent a SUCCESS notification here — before the post-drain callback ran. On an
  // incomplete drain that produced a ledger reading
  //
  //     [apply_started, apply_staged, rolled_back]
  //
  // for a revert that never touched the disk. And `rolled_back` is TERMINAL, so
  // the comment claiming "the next boot will reconcile again" was false: the
  // entry closed the operation, `evaluatePendingApplyOnBoot` saw nothing in
  // flight, and the failed revert was never retried. Reported with exactly that
  // reproduction (first=auto-revert, second=continue).
  //
  // ⇒ The terminal, the counter reset and the exact-result log all move INSIDE
  // the callback and all depend on `drainOk`. On a failed drain the staged entry
  // stays UNTERMINATED, which is what actually makes the next boot reconcile it.
  const performDiskRevert = (drainOk: boolean): void => {
    if (!drainOk) {
      console.error(
        '[update] auto-revert ABANDONED: the restart drain did not complete, so the database '
        + 'may still be open. Nothing was changed and NOTHING WAS RECORDED — the staged apply '
        + 'stays in flight so the next boot reconciles it again.',
      );
      try {
        deps.postDrainLog?.(
          `Update to ${staged.to_version} failed boot health, but the automatic rollback could `
          + 'not complete safely (the restart drain did not finish). The server is still on the '
          + 'new release; it will try again on the next boot.',
        );
      } catch { /* best effort */ }
      return;
    }
    // ⛔⛔ CLAIM THE MUTEX, DO NOT MERELY RUN INSIDE THE WINDOW IT PROTECTS.
    // This mutates the same set `recued update apply` does — the database, the
    // binary and its addon — and took nothing, so an owner-run apply or a CLI
    // revert could rename over it. The one thing that made it look safe was the
    // drain: a server mid-restart is not serving, so the CLI's `liveServerHolding`
    // check finds no server and proceeds. That is exactly backwards — the drain
    // is what REMOVES the other actuator's reason to stay away.
    //
    // ⚠ ANY FAILURE TO ACQUIRE ABANDONS, and abandoning here is already a
    // well-defined state: the `!drainOk` arm above changes nothing and records
    // nothing, precisely so the staged entry stays in flight and the next boot
    // reconciles it again. A held lease gets the same treatment for the same
    // reason — the process holding it is very likely fixing this install.
    let lease: { release: () => void } | undefined;
    if (ports.acquireUpdateLease) {
      try {
        lease = ports.acquireUpdateLease('auto-revert');
      } catch (err) {
        const holder = (err as { holder?: { pid: number; operation: string } }).holder;
        console.error(
          '[update] auto-revert ABANDONED: '
          + (holder
            ? `another update holds this install (pid ${holder.pid}, ${holder.operation})`
            : 'the host-wide update lease could not be taken')
          + '. Nothing was changed and NOTHING WAS RECORDED — the staged apply stays in flight '
          + 'so the next boot reconciles it again.',
        );
        try {
          deps.postDrainLog?.(
            `Update to ${staged.to_version} failed boot health, but the automatic rollback could `
            + 'not start because another update is running on this install. The server is still '
            + 'on the new release; it will try again on the next boot.',
          );
        } catch { /* best effort */ }
        return;
      }
    }
    try {
      performRevertUnderLease();
    } finally {
      lease?.release();
    }
  };

  /** The disk work itself, with the lease held for all of it. */
  const performRevertUnderLease = (): void => {
    // Restore first, swap last — a failed copy must leave the binary untouched.
    if (restoreSnapshot) ports.restoreSnapshot();
    ports.rollbackSwap();
    ports.clearWebclientApplyJournal?.();
    ports.ledger.append({
      id: ports.newEntryId(),
      kind: 'rolled_back',
      at: ports.now(),
      from_version: staged.from_version,
      to_version: staged.to_version,
      channel: staged.channel,
      trigger: 'revert',
      release_identity: staged.release_identity,
      migration: staged.migration ?? false,
      detail: `auto-revert: ${reason}${restoreSnapshot ? ' (snapshot restored)' : ''}`,
    });
    ports.bootFailureCounter.reset();
    try {
      deps.postDrainLog?.(
        `Update to ${staged.to_version} failed boot health and was rolled back (${reason}). `
        + 'Restarting on the prior release.',
      );
    } catch { /* swallow — the revert is done; the restart is what matters */ }
  };
  // The precise post-drain result can only be logged here. The owner-facing
  // notification was started before this request so a closed SQLite handle
  // cannot make a correctly-wired notification block inert.
  ports.requestRestart(performDiskRevert);
};

/** Run the on-boot reconcile. Returns the decision (also drives the side
 *  effects). The caller invokes this once, after the server has reached a
 *  healthy serving state, so `readinessOk` is true for a normal boot. */
export const runUpdateBootReconcile = async (deps: BootReconcilePorts): Promise<BootReconcileOutcome> => {
  const { ports } = deps;
  // A predecessor can die after durably reserving an RPC receipt but before the
  // manifest read yields or `apply_started` is appended. Settle only that dead
  // process's reservations; current-PID reservations may be resolving now.
  reconcileAbandonedUpdateReservations(ports);
  let manualRecoveryOutcome: BootReconcileOutcome | null = null;
  const manualRecovery = ports.inspectManualRollbackJournal?.() ?? null;
  if (manualRecovery) {
    const { journal } = manualRecovery;
    const alreadyRecorded = ports.ledger.readAll().some((entry) =>
      entry.id === journal.operation_id);
    const ambiguousSnapshotRestore = journal.restored_snapshot && manualRecovery.disk === 'unchanged';
    if (!alreadyRecorded && (manualRecovery.disk === 'unknown' || ambiguousSnapshotRestore)) {
      const outcome: BootReconcileOutcome = {
        action: 'manual-rollback-recovery-failed',
        releaseIdentity: journal.release_identity,
        reason: ambiguousSnapshotRestore
          ? 'the live binary is unchanged but the durable manual rollback journal cannot prove whether its database snapshot was restored'
          : 'the live binary matches neither generation recorded by the durable manual rollback journal',
      };
      signalOwnerAlert(deps.ownerAlert, {
        kind: 'manual-rollback-recovery-failed',
        release_identity: outcome.releaseIdentity,
        reason: outcome.reason,
      });
      if (deps.auditLog) {
        await replayLedgerIntoAudit(ports.ledger, deps.auditLog, deps.ownerAlert);
      }
      return outcome;
    }
    if (!alreadyRecorded) {
      ports.ledger.append({
        id: journal.operation_id,
        kind: manualRecovery.disk === 'rolled-back' ? 'rolled_back' : 'operation_refused',
        at: ports.now(),
        from_version: journal.from_version,
        to_version: journal.to_version,
        channel: journal.channel,
        trigger: 'manual',
        release_identity: journal.release_identity,
        migration: journal.migration,
        ...(manualRecovery.disk === 'rolled-back'
          ? {
              detail: `recovered the manual rollback receipt after process death${journal.restored_snapshot ? ' (snapshot restored)' : ''}`,
            }
          : {
              reserved_operation_id: journal.operation_id,
              reserved_operation: 'rollback' as const,
              detail: 'the process died before the manual rollback changed the live binary',
            }),
      });
    }
    ports.dropManualRollbackJournal?.();
    manualRecoveryOutcome = {
      action: 'manual-rollback-recovered',
      releaseIdentity: journal.release_identity,
      completed: manualRecovery.disk === 'rolled-back' || alreadyRecorded,
    };
  }
  const currentReleaseIdentity = releaseIdentityOf(deps.channel, deps.currentVersion);
  const decision = evaluatePendingApplyOnBoot(ports, {
    readinessOk: true,
    currentReleaseIdentity,
    currentVersion: deps.currentVersion,
  });

  let outcome: BootReconcileOutcome;
  switch (decision.action) {
    case 'commit': {
      // The staged release booted healthy — append the commit terminal (the
      // counter was already reset inside `evaluatePendingApplyOnBoot`; the
      // in-flight `apply_started` is still the lock, so read it before the
      // commit resolves it).
      const staged = deriveInFlightEntry(ports.ledger);
      const committed: UpdateLedgerEntry = {
        id: ports.newEntryId(),
        kind: 'apply_committed',
        at: ports.now(),
        from_version: staged?.from_version ?? '',
        to_version: deps.currentVersion,
        channel: deps.channel,
        // ⛔⛔ INHERIT THE TRIGGER, DO NOT INVENT ONE. This hardcoded `'auto'`,
        // and the audit replay reads the TERMINAL entry's trigger — intermediate
        // entries are forensic only — so every manual update an owner performed
        // from the CLI or from Settings appeared in their own version history as
        // an automatic one. The staged `apply_started` is right here and knows
        // what actually happened.
        trigger: staged?.trigger ?? 'auto',
        release_identity: decision.releaseIdentity,
        migration: staged?.migration ?? false,
        // And carry the staged-rollout bypass with it. Recording the bypass on an
        // entry the replay ignores meant the audited half of "explicit, confirmed,
        // AUDITED" never reached the row an owner actually reads.
        ...(staged?.detail !== undefined ? { detail: staged.detail } : {}),
      };
      ports.ledger.append(committed);
      // Announce only the terminal this healthy boot just made true. Audit
      // replay can revisit old commits after a rollback restores an older
      // SQLite snapshot; announcing those would misdescribe historical success
      // as the current outcome. The durable terminal resolves the in-flight
      // operation, so later boots do not enter this branch again.
      signalOwnerAlert(deps.ownerAlert, {
        kind: 'update-applied',
        release_identity: committed.release_identity,
        from_version: committed.from_version,
        to_version: committed.to_version,
        channel: committed.channel,
        trigger: committed.trigger,
      });
      // ⛔⛔ THE OPERATION IS ONLY NOW OVER, so this is where the parked
      // generation goes. The swap kept it deliberately: until this boot proved
      // the release starts, an auto-revert could still consume `recued.old` and
      // the aside was the only thing that could put a rollback target back.
      // Dropping it here is what keeps exactly one generation rather than two.
      try { ports.dropApplyAside?.(); } catch { /* best-effort — a leftover is swept by the next apply */ }
      try { ports.clearWebclientApplyJournal?.(); } catch { /* recovery can retry cleanup on the next boot */ }
      outcome = { action: 'commit', releaseIdentity: decision.releaseIdentity };
      break;
    }
    case 'auto-revert': {
      const staged = deriveInFlightEntry(ports.ledger);
      if (staged) {
        // ⛔ BEFORE requestRestart. Its drain closes SQLite before invoking the
        // disk callback, and the notification block reads settings from that
        // database. Starting the alert afterwards would be production-dead even
        // though an injected unit notifier worked.
        signalOwnerAlert(deps.ownerAlert, {
          kind: 'auto-revert-starting',
          release_identity: staged.release_identity,
          from_version: staged.from_version,
          to_version: staged.to_version,
          reason: decision.reason,
        });
        performAutoRevert(deps, staged, decision.reason);
      }
      outcome = { action: 'auto-revert', releaseIdentity: decision.releaseIdentity, reason: decision.reason };
      break;
    }
    case 'revert-complete': {
      const staged = deriveInFlightEntry(ports.ledger);
      if (staged) {
        ports.ledger.append({
          id: ports.newEntryId(),
          kind: 'apply_reverted',
          at: ports.now(),
          from_version: staged.from_version,
          to_version: staged.to_version,
          channel: staged.channel,
          trigger: 'revert',
          release_identity: staged.release_identity,
          migration: staged.migration ?? false,
          recovery_source: 'outer-supervisor',
          detail: `${SUPERVISOR_REVERT_DETAIL_PREFIX}the previous binary was already live; repaired its missing recovery receipt`,
        });
      }
      try { ports.dropRevertJournal?.(); } catch { /* best-effort cleanup */ }
      try { ports.clearWebclientApplyJournal?.(); } catch { /* best-effort cleanup */ }
      outcome = { action: 'revert-complete', releaseIdentity: decision.releaseIdentity };
      break;
    }
    case 'staging-aborted':
      outcome = { action: 'staging-aborted', releaseIdentity: decision.releaseIdentity };
      break;
    case 'webclient-recovery-failed':
      console.error(`[update] ${decision.reason}; leaving the apply in flight for recovery on the next boot`);
      outcome = {
        action: 'webclient-recovery-failed',
        releaseIdentity: decision.releaseIdentity,
        reason: decision.reason,
      };
      signalOwnerAlert(deps.ownerAlert, {
        kind: 'webclient-recovery-failed',
        release_identity: outcome.releaseIdentity,
        reason: outcome.reason,
      });
      break;
    case 'continue':
      outcome = manualRecoveryOutcome ?? { action: 'continue' };
      break;
  }

  // Replay AFTER the decision so a commit/rollback this boot also mirrors out.
  if (deps.auditLog) {
    await replayLedgerIntoAudit(ports.ledger, deps.auditLog, deps.ownerAlert);
  }
  return outcome;
};
