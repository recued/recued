/** D-250 § D7 — the wire shape behind `metric.read`.
 *
 *  ⛔⛔ THE DISPLAY METADATA TRAVELS WITH THE VALUE, RATHER THAN BEING LOOKED UP CLIENT-
 *  SIDE FROM `METRIC_REGISTRY`. Both sides import contracts, so sending `label` /
 *  `direction` / `shape` looks redundant — but **`app.recued.com` and a self-hosted
 *  server version INDEPENDENTLY.** A webclient newer or older than the server it is
 *  paired to would otherwise render its own registry's label and direction against the
 *  server's number, and a `direction` mismatch silently inverts what "better" means.
 *  Sending it means the client renders WHAT THE SERVER COMPUTED, which is also what
 *  § D3.1a's per-row `metric_version` exists to make visible.
 */

import type { MetricDirection, MetricReading, MetricShape } from './metric-registry.js';

export interface MetricReadEntry {
  readonly metric_id: string;
  readonly metric_version: number;
  readonly reading: MetricReading;
  readonly label: string;
  /** ⚠ OPTIONAL ON THE WIRE, deliberately: a client newer than the server it is paired
   *  to must render the row without one rather than fabricate a meaning for a number the
   *  old server computed. */
  readonly description?: string;
  readonly shape: MetricShape;
  readonly direction: MetricDirection;
  /** § D2 — a count is internal. The publish surface must not offer it. */
  readonly publishable: boolean;
  /** ⚠ LOCAL ONLY — these NEVER leave the server. They are on this wire because the pair
   *  rpc IS local, and § D7's publish dialog exists to show *"here are your daily tokens,
   *  here are your daily ops, here is the ratio, and the ratio is the only thing that
   *  leaves"*. ⛔ Anything building a SUBMISSION payload must drop them. */
  readonly numerator?: number;
  readonly denominator?: number;
}

export interface MetricArtifactEntry {
  readonly key: string;
  readonly kind: 'record' | 'once' | 'counter';
  readonly value: number;
  readonly updated_at: number;
}

export interface MetricMilestoneEntry {
  readonly milestone_id: string;
  readonly label: string;
  readonly description: string;
  /** Null when unearned. */
  readonly earned_at: number | null;
  /** ⛔ `call_site` MEANS THIS BUILD CANNOT DETECT IT YET, and the UI must say so.
   *  An undetectable milestone renders identically to an unearned one — the owner would
   *  read "you have not done this" when the truth is "we are not looking". */
  readonly detectable: boolean;
}

/** D-250 § D4 — one publish grant. ⚠ `withdrawing` is a REAL state the owner sees, not
 *  an internal flag: § C4's withdrawal rides the daily batch until the cloud acks it, so
 *  between the revoke and the ack the honest answer is "leaving", not "gone". */
export interface MetricPublicationEntry {
  readonly tag: string;
  readonly metric_id: string;
  readonly season_id: string;
  readonly state: 'active' | 'withdrawing';
  readonly granted_at: number;
}

export interface MetricReadOutput {
  /** Null when no cycle has computed yet. ⛔ NOT an empty list of zeros — "nothing has
   *  run" and "everything measured zero" are different facts. */
  readonly snapshot: {
    readonly computed_at: number;
    readonly window: { readonly from: number; readonly to: number };
    readonly metrics: readonly MetricReadEntry[];
    /** ⚠ LOCAL ONLY (§ D2). Coverage boundaries the dashboard shows because an absent
     *  reading is otherwise ambiguous — unclassified trigger sources, unknown risk
     *  tiers, whether a streak broke because the SERVER WAS OFF. */
    readonly diagnostics?: Readonly<Record<string, unknown>>;
  } | null;
  readonly artifacts: readonly MetricArtifactEntry[];
  readonly milestones: readonly MetricMilestoneEntry[];
  /** § D4 — what this server has opted into publishing. Empty is the default and the
   *  normal state: computing is automatic, publishing never is. */
  readonly publications: readonly MetricPublicationEntry[];
}

/** Why a submission sent nothing.
 *
 *  ⛔⛔ `sent: false` ALONE IS A UNIFORM SIGNAL THAT NAMES NO GUILTY MEMBER. Four
 *  unrelated states collapsed into it — a server with no signing identity, one with no
 *  reserved handle, one publishing nothing measurable, and one whose POST was refused —
 *  and the owner-facing surface could only ever say "nothing happened". Three of those
 *  are the normal default and one is a fault; a person cannot act on the difference
 *  without being told which.
 *
 *  ⚠ NOT AN ERROR CHANNEL. Every value except `send_failed` describes a server that is
 *  working correctly and has simply not opted into something — § D4's whole point is
 *  that publishing is never automatic. */
export type MetricSubmitSkipReason =
  /** No booted signing identity, so nothing can be signed. */
  | 'no_identity'
  /** An identity, but no reserved publisher handle — nothing to publish AS. */
  | 'no_handle'
  /** § D4 — the owner has granted no publication. The default state. */
  | 'no_publications'
  /** Publications exist, but no metric they name has a measured value this window.
   *  ⛔ DISTINCT FROM `no_publications`: § B3's retention keeps yesterday's number, so
   *  saying nothing is the honest outcome and the owner's board entry is untouched. */
  | 'nothing_measured'
  /** The cloud refused the batch or was unreachable. ⚠ THE ONLY FAULT IN THIS UNION —
   *  and § C4's withdrawals keep riding the next batch, so it is also recoverable. */
  | 'send_failed';
