/** Vault-gated collection sync — the shared pause/resume of live provider poll
 *  loops on the vault lock/unlock edges, factored out of the mail + calendar
 *  stacks (they had verbatim copies).
 *
 *  Both stacks defer a live collection's `sync.start()` while the vault is
 *  LOCKED: polling while sealed would fetch mail/events whose CAS-backed parts
 *  (attachments / >64 KB bodies) fail-close on the locked blob store WHILE the
 *  sync cursor advances past them → silent, permanent loss (the D-117
 *  locked-window gap). They then resume on the vault→unlocked edge. This is the
 *  collection-side parity of `vault-gated-executors.ts`. */

import type { CollectionSyncAdapter } from './types.js';

type SyncableCollection = { sync: Pick<CollectionSyncAdapter, 'start' | 'stop'> };

/** Should a live collection's poll loop be DEFERRED because the vault is locked?
 *  True iff a predicate is wired AND it reports locked. Absent predicate
 *  (dbless / harness — no vault to seal) ⇒ never deferred (sync always starts,
 *  the prior behaviour). */
export const syncDeferredWhileLocked = (isVaultUnlocked?: () => boolean): boolean =>
  isVaultUnlocked !== undefined && !isVaultUnlocked();

/** Start the poll loop for every live collection — the vault→unlocked edge.
 *  Idempotent (`sync.start()` no-ops an already-running loop). Per-collection
 *  errors are logged and swallowed, never thrown: callers drive this from the
 *  `vaultStateBus` edge, which runs inside `KeyManager.transition()`. */
export const resumeCollectionSync = async (
  collections: Iterable<SyncableCollection>,
  onError: (message: string, err: unknown) => void,
): Promise<void> => {
  for (const collection of collections) {
    try {
      await collection.sync.start();
    } catch (err) {
      onError('resumeSync start failed', err);
    }
  }
};

/** Stop the poll loop for every live collection WITHOUT closing it (reads stay)
 *  — the vault→locked edge, so an auto-lock mid-life halts polling before the
 *  next tick can drop a CAS item. Idempotent.
 *
 *  NOTE: this stops FUTURE ticks; a tick already mid-fetch at the lock edge is
 *  not cancelled, so that one in-flight item can still be dropped (a narrow
 *  residual, auto-lock only — the primary locked-boot path never starts a tick).
 *  See `handovers/handover_vault_lock_execution_gaps.md`. */
export const pauseCollectionSync = async (
  collections: Iterable<SyncableCollection>,
  onError: (message: string, err: unknown) => void,
): Promise<void> => {
  for (const collection of collections) {
    try {
      await collection.sync.stop();
    } catch (err) {
      onError('pauseSync stop failed', err);
    }
  }
};
