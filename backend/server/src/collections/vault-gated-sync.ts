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

const reportSyncError = (
  onError: (message: string, err: unknown) => void,
  message: string,
  err: unknown,
): void => {
  try { onError(message, err); }
  catch { /* an observability hook must not wedge vault convergence */ }
};

export interface CollectionSyncController {
  /** Request the provider loops to be running. Concurrent/opposite requests
   *  coalesce; the returned promise resolves only after the latest requested
   *  state has converged across every collection. */
  resume(): Promise<void>;
  /** Request the provider loops to be stopped while keeping collections live. */
  pause(): Promise<void>;
  /** Close transition admission, converge to stopped, and drain admitted work. */
  dispose(): Promise<void>;
}

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
  desiredRunning: () => boolean = () => true,
): Promise<void> => {
  for (const collection of collections) {
    let applied: boolean | undefined;
    do {
      const target = desiredRunning();
      try {
        if (target) await collection.sync.start();
        else await collection.sync.stop();
      } catch (err) {
        reportSyncError(
          onError,
          target ? 'resumeSync start failed' : 'resumeSync stale-start stop failed',
          err,
        );
      }
      applied = target;
    } while (desiredRunning() !== applied);
  }
};

/** Stop the poll loop for every live collection WITHOUT closing it (reads stay)
 *  — the vault→locked edge, so an auto-lock mid-life halts polling before the
 *  next tick can drop a CAS item. Idempotent.
 *
 *  NOTE: this stops FUTURE ticks; a tick already mid-fetch at the lock edge is
 *  not cancelled, so that one in-flight item can still be dropped (a narrow
 *  residual, auto-lock only — the primary locked-boot path never starts a tick).
 *  See internal design notes. */
export const pauseCollectionSync = async (
  collections: Iterable<SyncableCollection>,
  onError: (message: string, err: unknown) => void,
  desiredRunning: () => boolean = () => false,
): Promise<void> => {
  for (const collection of collections) {
    let applied: boolean | undefined;
    do {
      const target = desiredRunning();
      try {
        if (target) await collection.sync.start();
        else await collection.sync.stop();
      } catch (err) {
        reportSyncError(
          onError,
          target ? 'pauseSync stale-stop start failed' : 'pauseSync stop failed',
          err,
        );
      }
      applied = target;
    } while (desiredRunning() !== applied);
  }
};

/** Serialize vault-driven start/stop passes for one collection stack.
 *
 *  `VaultStateBus` listeners are deliberately synchronous, so opposite edges
 *  can arrive while an async provider connect/scan/close is still pending. A
 *  detached pass per edge is not safe: an old resume can reach collection B
 *  after the newer pause already stopped B. It can also overlap start and stop
 *  on one provider, whose idempotence contract does not promise ordering.
 *
 *  This controller owns exactly one pass at a time. Every operation consults
 *  the live desired state after it settles and compensates before moving on;
 *  a revision loop then revisits earlier collections when an edge changed
 *  during the pass. Request waiters resolve only after a stable latest-state
 *  pass, including the narrow promise-finalization race. */
export const createCollectionSyncController = (
  getCollections: () => Iterable<SyncableCollection>,
  onError: (message: string, err: unknown) => void,
): CollectionSyncController => {
  interface Waiter {
    revision: number;
    resolve: () => void;
  }

  let desiredRunning = false;
  let requestedRevision = 0;
  let appliedRevision = 0;
  let active: Promise<void> | undefined;
  let closed = false;
  let disposePromise: Promise<void> | undefined;
  const waiters: Waiter[] = [];

  const resolveAppliedWaiters = (): void => {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index]!;
      if (waiter.revision <= appliedRevision) {
        waiters.splice(index, 1);
        waiter.resolve();
      }
    }
  };

  const ensureRun = (): void => {
    if (active) return;
    let owned!: Promise<void>;
    owned = (async () => {
      while (appliedRevision !== requestedRevision) {
        const revision = requestedRevision;
        const requestedState = desiredRunning;
        try {
          const collections = [...getCollections()];
          if (requestedState) {
            await resumeCollectionSync(collections, onError, () => desiredRunning);
          } else {
            await pauseCollectionSync(collections, onError, () => desiredRunning);
          }
        } catch (err) {
          // Collection helpers contain per-adapter failures. Keep the
          // controller live if a future iterable/refactor throws above them.
          reportSyncError(onError, 'sync reconciliation failed', err);
        }

        // A newer edge means earlier collections may now be stale even though
        // each individual operation compensated. Re-run the complete snapshot
        // before resolving any request waiter.
        if (requestedRevision === revision) {
          appliedRevision = revision;
        }
      }
    })().finally(() => {
      if (active === owned) active = undefined;
      // Resolve only after clearing `active`, so a caller that immediately
      // disposes does not mistake a fully-settled pass for admitted work and
      // issue a redundant compensating pause.
      resolveAppliedWaiters();
      // A request can land after the async loop's final comparison but before
      // this reaction runs. Its waiter must own the follow-on pass rather than
      // observing the already-settled prior promise.
      if (appliedRevision !== requestedRevision) ensureRun();
    });
    active = owned;
  };

  const request = (next: boolean): Promise<void> => {
    if (closed) return disposePromise ?? Promise.resolve();
    desiredRunning = next;
    requestedRevision += 1;
    const revision = requestedRevision;
    const settled = new Promise<void>((resolve) => {
      waiters.push({ revision, resolve });
    });
    ensureRun();
    return settled;
  };

  return {
    resume: () => request(true),
    pause: () => request(false),
    dispose(): Promise<void> {
      if (disposePromise) return disposePromise;
      closed = true;
      // With no admitted transition to drain, the owning stack's subsequent
      // `collection.close()` is the single stop. Avoid an otherwise redundant
      // pause pass (and duplicate provider.close) on every quiet shutdown.
      if (!active && appliedRevision === requestedRevision) {
        desiredRunning = false;
        requestedRevision += 1;
        appliedRevision = requestedRevision;
        resolveAppliedWaiters();
        disposePromise = Promise.resolve();
        return disposePromise;
      }
      desiredRunning = false;
      requestedRevision += 1;
      const revision = requestedRevision;
      disposePromise = new Promise<void>((resolve) => {
        waiters.push({ revision, resolve });
      });
      ensureRun();
      return disposePromise;
    },
  };
};
