/** D-250 § D5.3 — MILESTONES ARE A CATEGORY, NOT A METRIC.
 *
 *  ⛔ THEY DO NOT FIT `MetricDefinition`, WHICH IS WHY THEY GET THEIR OWN REGISTRY. A
 *  milestone has no direction (nothing to rank), no denominator (no arithmetic at all),
 *  and no reading (it is earned or it is not). Forcing five of them into the metric
 *  registry would mean five entries carrying a meaningless `direction: 'higher'` and a
 *  `publishable: false` that restates what the whole category already is — a shape whose
 *  every field needs an exception is the wrong shape.
 *
 *  ⛔⛔ `first_pack_published` WAS REMOVED 2026-08-25, and the reason is worth keeping:
 *  **there is no server-side call site and there cannot be one.** Publishing a pack goes
 *  from the webclient/CLI to a Supabase edge function; the server only ever INSTALLS. A
 *  grep for any publish path through the server finds only `metric.publish` — this
 *  decision's own method. A badge that can never light up is worse than an absent one:
 *  § D5.1 made these an achievements surface, and an unearnable achievement reads as a
 *  personal failure. ⇒ restore it only if publishing ever becomes a server act.
 *
 *  ⚠ NONE OF THEM IS PUBLISHABLE, AND THAT IS STRUCTURAL (amendment 17). Never reaching
 *  the cloud is what puts milestones outside § B3's retention, outside seasons and
 *  outside the board key entirely — no `season_id`, no row, no submission. It is a
 *  property of the category, so it is not a per-entry field.
 *
 *  ⚠ AND THE STORE IS NOT REGENERABLE. A milestone lives only in `metric_artifact`;
 *  lose it after the audit rows evict and nothing can recompute *"first pack
 *  published"*. Disclose that on the surface (amendment 14); do not build recovery.
 */

/** Where a milestone's detection lives — the field that says whether it is BUILT.
 *
 *  🔑 IT IS ON THE ENTRY BECAUSE THE ANSWER DIFFERS PER MILESTONE AND THE DIFFERENCE IS
 *  NOT COSMETIC. An `audit_window` milestone is decidable from rows the metrics task
 *  already reads. A `call_site` one is NOT derivable from the audit log at all — a
 *  lifetime count cannot be reconstructed once the log has evicted oldest-first, and a
 *  pairing or a publish is an event on another surface entirely. Marking them keeps
 *  "not built yet" visible instead of leaving a silently-never-earned badge. */
export type MilestoneSource = 'audit_window' | 'call_site';

export interface MilestoneDefinition {
  readonly milestone_id: string;
  /** Bumped when the DETECTION changes, same rule as `metric_version`: bump when the
   *  answer moves for identical input. ⚠ A bump does NOT re-earn an already-earned
   *  milestone — `earnMilestone` is first-write-wins by design. */
  readonly version: number;
  readonly logic: readonly string[];
  readonly source: MilestoneSource;
  readonly label: string;
  /** What the owner reads on the badge. */
  readonly description: string;
}

export const MILESTONE_REGISTRY: Readonly<Record<string, MilestoneDefinition>> = {
  first_zero_approval_day: {
    milestone_id: 'first_zero_approval_day',
    version: 2,
    logic: [
      'v1: the first COMPLETE UTC day with zero approval_allow/approval_deny activities.',
      // ⛔ v1 CREDITED AN IDLE SERVER. Zero answered decisions is trivially true when
      // nothing ran, so a server doing nothing earned "Hands off" on its second day and
      // grew a streak forever. v2 requires the day to contain work.
      'v2: the first COMPLETE UTC day with at least one run STARTED and zero '
        + 'approval_allow/approval_deny activities.',
    ],
    source: 'audit_window',
    label: 'Hands off',
    description: 'A whole day where Recued worked and nothing needed your decision.',
  },
  first_unattended_week: {
    milestone_id: 'first_unattended_week',
    version: 1,
    logic: [
      'v1: seven consecutive complete UTC days with zero attended runs AND at least one '
        + 'unattended run — an idle server does not earn it.',
    ],
    source: 'audit_window',
    label: 'Full week on autopilot',
    description: 'Seven days running itself, with nothing you had to start.',
  },
  first_peer_paired: {
    milestone_id: 'first_peer_paired',
    version: 2,
    logic: [
      'v1: the first completed peer pairing.',
      'v2: the first `peer_ask_answered` activity — a peer ANSWERED, which is a working '
        + 'two-way relationship rather than a config edit.',
    ],
    // ⛔ RECLASSIFIED 2026-08-25: this was `call_site` on the assumption that pairing is
    // an event the metrics task cannot see. It is not — there is no server-side "pairing"
    // moment at all; a peer is a CONFIGURED CONNECTION, so a config edit would have been
    // the wrong thing to celebrate anyway. `peer_ask_answered` IS an audit activity, and
    // it marks the better fact: someone else's server answered you.
    source: 'audit_window',
    label: 'First peer',
    description: 'Another server answered you.',
  },
  first_recipe_100_runs: {
    milestone_id: 'first_recipe_100_runs',
    version: 2,
    logic: [
      'v1: the first recipe to reach 100 runs.',
      'v2: the first recipe whose ACCUMULATED run counter reaches 100 — each complete '
        + 'day adds that day’s runs, so the total survives audit eviction.',
    ],
    // ⛔ RECLASSIFIED 2026-08-25. Still true that a GROUP BY over the log would silently
    // measure "runs still retained" and the badge would UN-EARN itself as the log rolled.
    // But the fix is not a hot-path hook: the daily walk ADDS each complete day's runs to
    // a durable per-recipe counter, so the total accumulates forward and never re-reads
    // history. Derivable from rows the task already sees ⇒ `audit_window`.
    // ⚠ A missed day undercounts, never overcounts — the badge arrives slightly late
    // rather than wrongly, which is the right direction for an achievement.
    source: 'audit_window',
    label: 'Century',
    description: 'One of your recipes has run 100 times.',
  },
};

/** Milestones this build can actually detect. ⚠ The complement is not a TODO list to be
 *  quietly ignored — a `call_site` milestone renders as unearned forever until its hook
 *  exists, which is indistinguishable from "you have not done it yet". */
export const AUDIT_DERIVABLE_MILESTONES = Object.values(MILESTONE_REGISTRY)
  .filter((m) => m.source === 'audit_window')
  .map((m) => m.milestone_id);

export const assertMilestoneRegistryConsistent = (): void => {
  for (const m of Object.values(MILESTONE_REGISTRY)) {
    if (m.logic.length !== m.version) {
      throw new Error(
        `milestone '${m.milestone_id}' is at v${m.version} but carries ${m.logic.length} `
          + `logic line(s) — a version bump owes a line saying what moved`,
      );
    }
  }
};
