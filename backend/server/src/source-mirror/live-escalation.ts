/** source_mirror — live escalation for stale / narrow-miss mirror
 *  units (D-192 read resolution).
 *
 *  The family-neutral core of the chat CRM S3 pattern
 *  (`applyCrmLiveEscalation`, now a thin adapter over this): a search
 *  fan-out answered from local mirrors escalates PER UNIT (per bound
 *  connection / per Source) to a live vendor fetch when
 *
 *    - the unit's mirror is STALE (poll is the freshness baseline —
 *      the caller computes the verdict with its family's threshold /
 *      sync-state), or
 *    - a NARROW lookup (identifier-ish query) MISSED the unit entirely
 *      — the caller says whether the base result already contains a
 *      candidate from the unit (`presentInBase`), keeping each family's
 *      matching semantics its own.
 *
 *  For each escalated unit whose live fetch succeeds, its mirror
 *  candidates are REPLACED by the freshly-fetched ones; a failed /
 *  unavailable fetch (`null`) keeps the mirror rows — graceful, never
 *  worse than local. COLD (zero-row) units are covered by STALE: a
 *  never-synced unit is stale by construction.
 *
 *  Fetches run SEQUENTIALLY, one unit at a time — few bound units in
 *  practice, and it keeps the gateway's per-connection rate slot
 *  honest.
 *
 *  Generic over the candidate type: the module never inspects
 *  candidates itself — ownership (`owns`) and projection (`fetchLive`)
 *  are the caller's. The `owns` predicate MUST gate on the unit's true
 *  source identity, not just an id prefix: a candidate from another
 *  source whose id coincidentally matches must never be dropped by the
 *  replace-merge. */

export interface SourceLiveEscalationUnit<C> {
  /** Stable per-unit key (connection name / source id) — reported back
   *  in `escalated` so the caller can restamp its freshness rows. */
  key: string;
  /** The unit's poll-staleness verdict (caller-computed; each family
   *  owns its threshold semantics). */
  stale: boolean;
  /** True when the base candidate set already contains a row from this
   *  unit — a narrow lookup that found nothing on the unit escalates
   *  (`narrowLookup && !presentInBase`). */
  presentInBase: boolean;
  /** Mirror-candidate ownership for the replace-merge drop. Must gate
   *  on the unit's true source identity (see module doc). */
  owns: (candidate: C) => boolean;
  /** Live vendor fetch + the caller's local re-filter + projection.
   *  `null` = failed / un-granted / unavailable → the unit keeps its
   *  mirror candidates. */
  fetchLive: () => Promise<C[] | null>;
}

export interface SourceLiveEscalationResult<C> {
  candidates: C[];
  /** Keys of the units whose live fetch succeeded (mirror candidates
   *  replaced) — the caller restamps their freshness as live-served. */
  escalated: ReadonlySet<string>;
}

/** Apply per-unit live escalation over a mirror-served candidate set.
 *  See the module doc for the decision rule; the merge drops an
 *  escalated-OK unit's mirror candidates and appends its live ones,
 *  leaving every other unit's candidates untouched. */
export const applySourceLiveEscalation = async <C>(
  base: readonly C[],
  units: readonly SourceLiveEscalationUnit<C>[],
  opts: { narrowLookup: boolean },
): Promise<SourceLiveEscalationResult<C>> => {
  const liveByKey = new Map<string, C[]>();
  for (const unit of units) {
    const narrowMiss = opts.narrowLookup && !unit.presentInBase;
    if (!unit.stale && !narrowMiss) continue;
    // Sequential per unit — see module doc.
    // eslint-disable-next-line no-await-in-loop
    const live = await unit.fetchLive();
    if (live === null) continue; // keep the mirror (graceful)
    liveByKey.set(unit.key, live);
  }

  const escalatedUnits = units.filter((u) => liveByKey.has(u.key));
  const candidates = base.filter(
    (c) => !escalatedUnits.some((u) => u.owns(c)),
  );
  for (const live of liveByKey.values()) candidates.push(...live);

  return { candidates, escalated: new Set(liveByKey.keys()) };
};
