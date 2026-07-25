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
  type ApplyOrchestratorPorts,
} from './apply-orchestrator.js';
import { releaseIdentityOf } from './release-check.js';
import { unreplayedEntries, type UpdateLedger, type UpdateLedgerEntry } from './update-ledger.js';

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
  /** URGENT operator notify on an auto-revert (best-effort; never throws). */
  notify?: (message: string) => void;
}

export type BootReconcileOutcome =
  | { action: 'commit'; releaseIdentity: string }
  | { action: 'auto-revert'; releaseIdentity: string; reason: string }
  | { action: 'staging-aborted'; releaseIdentity: string }
  | { action: 'continue' }
  | { action: 'not-applicable' };

/** Activity-id prefix so the replay can read back which ledger entries it has
 *  already mirrored (idempotency, I-3) — `update:<ledger-entry-id>`. */
const REPLAY_ID_PREFIX = 'update:';

/** Replay the ledger's terminal apply/rollback events into the audit log,
 *  idempotent on the ledger entry id. Only `apply_committed` / `rolled_back`
 *  surface as user-meaningful version-history rows; the intermediate
 *  (`started` / `staged` / `reverted` / `snapshot_taken`) events stay in the
 *  ledger as the forensic source of truth. Best-effort: an audit write failure
 *  never blocks boot. */
const replayLedgerIntoAudit = async (ledger: UpdateLedger, auditLog: UpdateAuditSink): Promise<void> => {
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
    const action = e.kind === 'apply_committed' ? 'update_applied' : e.kind === 'rolled_back' ? 'update_rolled_back' : null;
    if (!action) continue;
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
 *  counter, URGENT-notify, and request a restart back into the prior binary. */
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
  if (restoreSnapshot) ports.restoreSnapshot();
  ports.rollbackSwap();
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
  // Notify is best-effort and MUST NOT block the restart — a throwing notifier
  // would otherwise leave a fully-reverted install that never restarts.
  try {
    deps.notify?.(`Update to ${staged.to_version} failed boot health and was rolled back (${reason}). Restarting on the prior release.`);
  } catch {
    /* swallow — the revert is done; the restart is what matters */
  }
  ports.requestRestart();
};

/** Run the on-boot reconcile. Returns the decision (also drives the side
 *  effects). The caller invokes this once, after the server has reached a
 *  healthy serving state, so `readinessOk` is true for a normal boot. */
export const runUpdateBootReconcile = async (deps: BootReconcilePorts): Promise<BootReconcileOutcome> => {
  const { ports } = deps;
  const currentReleaseIdentity = releaseIdentityOf(deps.channel, deps.currentVersion);
  const decision = evaluatePendingApplyOnBoot(ports, { readinessOk: true, currentReleaseIdentity });

  let outcome: BootReconcileOutcome;
  switch (decision.action) {
    case 'commit': {
      // The staged release booted healthy — append the commit terminal (the
      // counter was already reset inside `evaluatePendingApplyOnBoot`; the
      // in-flight `apply_started` is still the lock, so read it before the
      // commit resolves it).
      const staged = deriveInFlightEntry(ports.ledger);
      ports.ledger.append({
        id: ports.newEntryId(),
        kind: 'apply_committed',
        at: ports.now(),
        from_version: staged?.from_version ?? '',
        to_version: deps.currentVersion,
        channel: deps.channel,
        trigger: 'auto',
        release_identity: decision.releaseIdentity,
        migration: staged?.migration ?? false,
      });
      outcome = { action: 'commit', releaseIdentity: decision.releaseIdentity };
      break;
    }
    case 'auto-revert': {
      const staged = deriveInFlightEntry(ports.ledger);
      if (staged) performAutoRevert(deps, staged, decision.reason);
      outcome = { action: 'auto-revert', releaseIdentity: decision.releaseIdentity, reason: decision.reason };
      break;
    }
    case 'staging-aborted':
      outcome = { action: 'staging-aborted', releaseIdentity: decision.releaseIdentity };
      break;
    case 'continue':
      outcome = { action: 'continue' };
      break;
  }

  // Replay AFTER the decision so a commit/rollback this boot also mirrors out.
  if (deps.auditLog) await replayLedgerIntoAudit(ports.ledger, deps.auditLog);
  return outcome;
};
