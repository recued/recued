/** D-240 slice 4 — stamp a deferred viewback credential once its record ends.
 *
 *  `until_resolved` mints a credential with no anchor: the request has not
 *  finished, so there is nothing to count a grace from. The credential therefore
 *  starts at its §D10 ceiling and this sweep shortens it to
 *  `completed_at + grace` once the record's durable target reports `done`.
 *
 *  ## ⚠ A SWEEP, AND I ARGUED AGAINST ONE IN SLICE 3b
 *
 *  The slice-3b commit said the stamper would be "an event hook, not a sweeper"
 *  because a polled boolean makes "not resolved yet" and "nobody scanned"
 *  indistinguishable. That critique is right about a boolean used as the SOURCE
 *  OF TRUTH. It does not apply here, for two reasons:
 *
 *    - The source of truth is the work entity's `done`, read FORWARD from the
 *      credential (credential → record → resolved target → entity). An event
 *      hook would need the REVERSE join — entity → submission — and no index for
 *      it exists; adding one to carry a precision improvement nobody can observe
 *      is the wrong trade.
 *    - Both designs fail the same way (a missed transition never stamps) and
 *      both are caught by the same backstop (`ceiling_at`). The event hook's
 *      failure is a lost event with no retry; the sweep's is one late pass.
 *
 *  🔑 AND THE PRECISION BUYS NOTHING. Stamping late means the credential expires
 *  at `completed_at + grace + (up to one interval)`. Against a grace measured in
 *  WEEKS, an hourly interval is noise. A design that is materially simpler and
 *  wrong by an unobservable margin beats one that is more responsive and needs a
 *  new index.
 *
 *  Spec: D-240 § D7 / D8 / D10. */

import type {
  ReceptionDeferredCredential,
  ReceptionManageCredentialStore,
} from './storage/reception-manage-credential-store.js';

/** What a record's durable target reports. `null` ⇒ no target yet, or the target
 *  is a kind this sweep cannot read — either way, keep waiting. */
export interface ReceptionRecordCompletion {
  readonly done: boolean;
  /** ⛔ SUBSTRATE-STAMPED, per §D8: the recipe says THAT the work ended and HOW,
   *  the substrate says WHEN. A recipe-supplied timestamp would let a re-run move
   *  a live credential's expiry, or stamp it dead on arrival. Absent on a `done`
   *  entity that never recorded one ⇒ the sweep uses `now`, which is the honest
   *  reading of "it is done and we noticed at this moment". */
  readonly completed_at?: number;
}

export interface ReceptionLookupExpirySweepDeps {
  readonly credentialStore: ReceptionManageCredentialStore;
  /** Forward lookup: the credential's record → its durable target's completion.
   *  Injected rather than reached for, so this sweep does not depend on the
   *  work-entity subsystem's shape. */
  readonly readCompletion: (input: {
    readonly endpoint_id: string;
    readonly record_id: string;
  }) => ReceptionRecordCompletion | null;
  readonly now: () => number;
  /** Bounded per pass. A server with thousands of open requests must not spend
   *  an unbounded tick on them; the next pass continues, and the backstop means
   *  a permanently-starved row is still collected. */
  readonly batchLimit?: number;
}

export const RECEPTION_LOOKUP_SWEEP_DEFAULT_BATCH = 200;

export interface ReceptionLookupSweepResult {
  readonly scanned: number;
  readonly stamped: number;
}

/** One pass. Pure of scheduling — the caller owns the cadence.
 *
 *  ⛔ NEVER THROWS OUT. A single unreadable record must not abort the pass and
 *  leave every credential behind it unstamped; the reader's failure is that
 *  record's problem, and the rest of the batch is unaffected. */
export const runReceptionLookupExpirySweep = (
  deps: ReceptionLookupExpirySweepDeps,
): ReceptionLookupSweepResult => {
  const limit = deps.batchLimit ?? RECEPTION_LOOKUP_SWEEP_DEFAULT_BATCH;
  const deferred: ReadonlyArray<ReceptionDeferredCredential> =
    deps.credentialStore.listDeferred(limit, deps.now());
  const now = deps.now();
  let stamped = 0;

  for (const credential of deferred) {
    let completion: ReceptionRecordCompletion | null = null;
    try {
      completion = deps.readCompletion({
        endpoint_id: credential.endpoint_id,
        record_id: credential.record_id,
      });
    } catch (error) {
      console.warn(
        `[visitor-lookup] completion read failed for record '${credential.record_id}': `
        + (error instanceof Error ? error.message : String(error)),
      );
      continue;
    }
    // Not resolved yet is the COMMON case and is silent — a request open for
    // three weeks would otherwise log on every pass for three weeks.
    if (completion === null || completion.done !== true) continue;

    // §D8 — `completed_at` when the entity recorded one, else the moment we
    // observed it. ⚠ Never a value the recipe supplied.
    const endedAt =
      typeof completion.completed_at === 'number' && Number.isFinite(completion.completed_at)
        ? completion.completed_at
        : now;
    // The store clamps to the ceiling; computing it here too would be a second
    // answer to one question. Left to the store deliberately.
    if (deps.credentialStore.resolveDeferred({
      credential_id: credential.credential_id,
      expires_at: endedAt + credential.grace_ms,
    })) {
      stamped += 1;
    }
  }

  return { scanned: deferred.length, stamped };
};
