/** Stopping a collection's outbound work instead of waiting for it.
 *
 *  A collection stop runs inside the lifecycle drain (`pause_collections`),
 *  whose steps have 5 s each, and the process exits right after the drain: work
 *  still waiting on a mail or calendar server when the step runs out dies
 *  regardless, and the overrun makes an update refuse to swap versions. So a
 *  stop aborts the calls it has in flight (`AbortSignal` into the fetcher, a
 *  socket destroyed) and each provider loop checks the signal between messages
 *  and pages.
 *
 *  ⛔ A stopped loop THROWS; it never breaks out and returns. Every loop here
 *  stores its cursor (a history id, a delta link, a sync token, an ETag, a UID
 *  cursor) or certifies a walk complete once it reaches its end normally, so a
 *  loop that returned early would record as read everything it never reached.
 *  Thrown, the cursor stays where it was and the next start reads the same
 *  range again; every write that range replays is an idempotent upsert. */

/** The reason a stop aborts with, and what a stopped loop throws. */
export class CollectionStoppedError extends Error {
  readonly code = 'COLLECTION_STOPPED';

  constructor(message = 'the collection was stopped') {
    super(message);
    this.name = 'CollectionStoppedError';
  }
}

/** Throw when `signal` has been aborted. Called between messages and pages,
 *  and right before a cursor write: see the header for why it throws. */
export const throwIfStopped = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) throw new CollectionStoppedError();
};
