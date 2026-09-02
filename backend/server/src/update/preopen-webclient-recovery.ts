/** Restore a webclient promotion that outlived a pre-swap apply crash before any
 * server module can load and retain those promoted bytes.
 *
 * Normal boot reconciliation already settles the ledger entry, but it runs after
 * the listener composition has loaded the bundle. This leaf performs only the
 * disk half early; the ordinary boot path remains the single ledger authority. */
import { existsSync } from 'node:fs';
import { deriveInFlightApply } from './apply-orchestrator.js';
import type { UpdateLedger } from './update-ledger.js';
import {
  clearWebclientApplyJournal,
  readWebclientApplyJournal,
  recoverAbortedWebclientSync,
  webclientApplyJournalPath,
} from './webclient-sync.js';

export type PreopenWebclientRecoveryOutcome =
  | { action: 'none' }
  | { action: 'recovered'; releaseIdentity: string }
  | { action: 'refused'; releaseIdentity: string; reason: string };

export const recoverAbortedWebclientBeforeServe = (input: {
  ledger: UpdateLedger;
  currentVersion: string;
  targetDir: string | undefined;
}): PreopenWebclientRecoveryOutcome => {
  if (!input.targetDir || !existsSync(webclientApplyJournalPath(input.targetDir))) {
    return { action: 'none' };
  }

  const inFlight = deriveInFlightApply(input.ledger);
  const journal = readWebclientApplyJournal(input.targetDir);
  if (!journal) {
    return {
      action: 'refused',
      releaseIdentity: inFlight?.entry.release_identity ?? 'unknown',
      reason: 'the pre-swap webclient journal is malformed',
    };
  }

  // Bind the journal to its exact opening row. A terminal is keyed by release
  // identity rather than operation id, so it is considered only after this
  // operation's start and before any later retry can be mistaken for its owner.
  const entries = input.ledger.readAll();
  const startIndex = entries.findIndex((entry) =>
    entry.kind === 'apply_started'
    && entry.id === journal.operationId
    && entry.release_identity === journal.releaseIdentity);
  const started = startIndex < 0 ? null : entries[startIndex]!;
  if (!started) {
    return {
      action: 'refused',
      releaseIdentity: journal.releaseIdentity,
      reason: 'the pre-swap webclient journal has no matching apply_started entry',
    };
  }

  // The target executable itself is running. Its UI is either the promoted
  // bundle or the older, compatibility-safe bundle left by a failed sync. Boot
  // reconciliation owns the commit and journal cleanup; undoing here would put
  // the old server's UI in front of the new server just before serve composition.
  if (input.currentVersion === started.to_version) return { action: 'none' };
  if (input.currentVersion !== started.from_version) {
    return {
      action: 'refused',
      releaseIdentity: journal.releaseIdentity,
      reason: `the webclient journal belongs to ${started.from_version}->${started.to_version}, but ${input.currentVersion} is running`,
    };
  }

  const journalIsOpen = inFlight?.entry.id === journal.operationId
    && inFlight.entry.release_identity === journal.releaseIdentity;
  if (journalIsOpen && inFlight.staged) return { action: 'none' };

  const terminal = entries.slice(startIndex + 1).find((entry) =>
    entry.release_identity === journal.releaseIdentity
    && (entry.kind === 'apply_committed' || entry.kind === 'apply_reverted'));

  if (!journalIsOpen) {
    if (terminal?.kind !== 'apply_reverted') {
      return {
        action: 'refused',
        releaseIdentity: journal.releaseIdentity,
        reason: 'the webclient journal is neither owned by an open apply nor a reverted apply',
      };
    }
    if (terminal.webclient_recovery_pending !== true) {
      // The inline compensation reported success and only its journal unlink was
      // lost. Do not repeat the physical undo: with three generations present,
      // that would roll the UI back twice.
      const cleared = clearWebclientApplyJournal(input.targetDir, journal);
      return cleared
        ? { action: 'recovered', releaseIdentity: journal.releaseIdentity }
        : {
            action: 'refused',
            releaseIdentity: journal.releaseIdentity,
            reason: 'the restored webclient journal could not be cleared',
          };
    }
  }

  const recovered = recoverAbortedWebclientSync(input.targetDir, journal);
  return recovered
    ? { action: 'recovered', releaseIdentity: journal.releaseIdentity }
    : {
        action: 'refused',
        releaseIdentity: journal.releaseIdentity,
        reason: 'the pre-swap webclient journal is malformed, belongs to another operation, or could not be restored',
      };
};
