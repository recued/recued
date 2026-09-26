/** D-308 — give the passes D-306's defect made permanent the end they were
 *  issued with, once, and tell the owner.
 *
 *  Before D-306, a kernel step that omitted `current_period_end` handed the
 *  lifecycle the manifest's placeholder `null`, and on a manual tier `null`
 *  means open-ended. Four shipped recipes issue manual passes without naming an
 *  end: the three paid-pass recipes and `enroll-free-student-deeptutor`. So every
 *  pass they issued had no end, whatever the tier's pass length. D-306 stops new
 *  ones; this repairs the ones already issued.
 *
 *  ⛔ A missing end date is NOT proof of the defect. Open-ended access can be
 *  deliberate: a chat or MCP call can write `null`, and an owner can give a
 *  tier a pass length after selling it as lifetime. Ending access the owner
 *  sold as lifetime is worse than leaving a pass open, so this changes a
 *  customer only on the trace one of those four recipes leaves:
 *   - a PAID order for the customer's tier, linked to the customer. Only the
 *     paid-pass recipes link one, and each told the owner the server stamped
 *     "the tier's pass_duration_seconds as the expiry";
 *   - else a DeepTutor student record naming the customer and the tier's class.
 *     Only the enrollment writes one for a free student.
 *  …and only when the tier was not edited since the first of them, so its pass
 *  length is the one that was issued. Every other open-ended customer on a pass
 *  tier is LISTED for the owner, and left as it is.
 *
 *  The end is what the lifecycle would have stamped at the last issue: the
 *  later of the customer's creation and its last order or enrollment, plus the
 *  pass length.
 *  - ⚠ A pass whose end has already passed ends NOW instead, never in the past,
 *    so no one loses access at the moment of the upgrade: the owner's usual grace
 *    runs from this boot, and the owner is told who and when.
 *  - ⚠ A customer who existed BEFORE that first order or enrollment had access
 *    the defect overwrote, and how long it ran is recorded nowhere. They get the
 *    pass's end, the least they are owed, and the owner is told to check them.
 *  The write goes through the lifecycle's own `extendCustomer`, so the grace
 *  comes from the same rule as every other extension. */

import type Database from 'better-sqlite3';
import type { NotificationBlock, NotificationMessage } from '@recued/notification';
import type { AuditLogStore } from '@recued/storage';

import type { RecordsStore } from '../records/store.js';
import type { DataRepairLedger } from '../storage/data-repair-ledger.js';
import { ENROLLMENT_RUN_MS, enrollmentFor, readEnrollments, type Enrollment } from './pass-traces.js';
import {
  SELLER_CUSTOMERS_TABLE,
  SELLER_ORDERS_TABLE,
  SELLER_TIERS_TABLE,
} from '../storage/seller-store.js';
import type { SellerCustomerAccessLifecycle } from './customer-access-lifecycle.js';

/** ⚠ v2: v1 (`27203e5b4`, never released) repaired paid passes only. A server
 *  that booted v1 runs this too, and finds only what v1 left. */
export const PERMANENT_PASS_REPAIR_ID = 'd308-permanent-passes-v2';

/** Why an open-ended customer on a pass tier was left for the owner. */
export type PermanentPassLeftReason =
  | 'no_evidence'
  | 'tier_edited_since_issue';

export interface PermanentPassRepaired {
  readonly customer_id: string;
  /** The email, else the source customer id: what the owner knows them by. */
  readonly label: string;
  readonly tier: string;
  readonly evidence: 'paid_order' | 'enrollment';
  /** When the pass should have ended. */
  readonly due_at: number;
  /** The end it has now: `due_at`, or this boot when that had passed. */
  readonly current_period_end: number;
  readonly grace_until: number | null;
  /** The customer existed before the pass; what that earlier access was owed is unknown. */
  readonly earlier_access: boolean;
}

export interface PermanentPassLeft {
  readonly customer_id: string;
  readonly label: string;
  readonly tier: string;
  /** The package's id: the notice links to its Re-apply tab (D-309). */
  readonly tier_id: string;
  readonly reason: PermanentPassLeftReason;
}

export interface PermanentPassRepairSummary {
  readonly repaired: readonly PermanentPassRepaired[];
  readonly left: readonly PermanentPassLeft[];
}

interface CandidateRow {
  readonly customer_id: string;
  readonly email: string | null;
  readonly source_customer_id: string;
  readonly door_id: string;
  readonly customer_created_at: number;
  readonly tier_id: string;
  readonly tier_key: string;
  readonly tier_name: string;
  readonly pass_duration_seconds: number;
  readonly tier_updated_at: number;
  readonly first_paid_at: number | null;
  readonly last_paid_at: number | null;
}

/** Every open, open-ended manual customer on a tier with a pass length, with
 *  the paid orders linked to it FOR THAT TIER (an order snapshots the key it
 *  sold). `pass_duration_seconds > 0` also excludes NULL. */
const candidateSql = `
  SELECT c.customer_id, c.email, c.source_customer_id, c.door_id, c.created_at AS customer_created_at,
         t.tier_id, t.entitlement_key AS tier_key, t.display_name AS tier_name, t.pass_duration_seconds,
         t.updated_at AS tier_updated_at, o.first_paid_at, o.last_paid_at
    FROM ${SELLER_CUSTOMERS_TABLE} c
    JOIN ${SELLER_TIERS_TABLE} t ON t.tier_id = c.tier_id
    LEFT JOIN (
      SELECT customer_id, entitlement_key,
             MIN(paid_at) AS first_paid_at, MAX(paid_at) AS last_paid_at
        FROM ${SELLER_ORDERS_TABLE}
       WHERE customer_id IS NOT NULL AND paid_at IS NOT NULL
       GROUP BY customer_id, entitlement_key
    ) o ON o.customer_id = c.customer_id AND o.entitlement_key = t.entitlement_key
   WHERE c.lifecycle_source = 'manual'
     AND c.current_period_end IS NULL
     AND c.access_state <> 'closed'
     AND t.pass_duration_seconds > 0
   ORDER BY c.created_at, c.customer_id`;

/** The trace one of the four recipes left for this customer, if any: its paid
 *  order, else its enrollment in the tier's class on the customer's own door. */
const evidenceFor = (
  row: CandidateRow,
  enrollments: Map<string, Enrollment[]>,
): { kind: PermanentPassRepaired['evidence']; first_at: number; last_at: number; earlier_access: boolean } | null => {
  if (row.first_paid_at !== null) {
    return {
      kind: 'paid_order',
      first_at: row.first_paid_at,
      last_at: row.last_paid_at!,
      earlier_access: row.customer_created_at < row.first_paid_at,
    };
  }
  const enrollment = enrollmentFor(enrollments, row, row.tier_key);
  if (enrollment === undefined) return null;
  return {
    kind: 'enrollment',
    first_at: enrollment.first_at,
    last_at: enrollment.last_at,
    earlier_access: row.customer_created_at < enrollment.first_at - ENROLLMENT_RUN_MS,
  };
};

export interface PermanentPassRepairDeps {
  readonly db: Database.Database;
  readonly ledger: DataRepairLedger;
  readonly lifecycle: Pick<SellerCustomerAccessLifecycle, 'extendCustomer'>;
  /** Absent ⇒ no enrollment evidence: DeepTutor's free students are listed. */
  readonly records?: Pick<RecordsStore, 'exportNamespace'>;
  readonly now: () => number;
}

/** Runs once: a server whose ledger holds the repair gets `applied: false` and
 *  the recorded summary. The extensions and the ledger row commit together. */
export const repairPermanentPasses = (
  deps: PermanentPassRepairDeps,
): { readonly applied: boolean; readonly summary: PermanentPassRepairSummary } => {
  const recorded = deps.ledger.get(PERMANENT_PASS_REPAIR_ID);
  if (recorded !== null) {
    return { applied: false, summary: recorded.summary as PermanentPassRepairSummary };
  }
  const now = deps.now();
  const candidates = deps.db.prepare(candidateSql);
  const enrollments = readEnrollments(deps.records);
  let summary: PermanentPassRepairSummary = { repaired: [], left: [] };
  deps.db.transaction(() => {
    const repaired: PermanentPassRepaired[] = [];
    const left: PermanentPassLeft[] = [];
    for (const row of candidates.all() as CandidateRow[]) {
      const label = row.email ?? row.source_customer_id;
      const evidence = evidenceFor(row, enrollments);
      const reason: PermanentPassLeftReason | null = evidence === null
        ? 'no_evidence'
        : row.tier_updated_at > evidence.first_at ? 'tier_edited_since_issue' : null;
      if (evidence === null || reason !== null) {
        left.push({
          customer_id: row.customer_id, label, tier: row.tier_name, tier_id: row.tier_id, reason: reason!,
        });
        continue;
      }
      const due_at = Math.max(row.customer_created_at, evidence.last_at)
        + row.pass_duration_seconds * 1000;
      const customer = deps.lifecycle.extendCustomer({
        customer_id: row.customer_id,
        current_period_end: Math.max(due_at, now),
        // The package's own rule set this end (D-309), not anyone's hand.
        period_origin: 'package',
      });
      repaired.push({
        customer_id: row.customer_id,
        label,
        tier: row.tier_name,
        evidence: evidence.kind,
        due_at,
        current_period_end: customer.current_period_end!,
        grace_until: customer.grace_until,
        earlier_access: evidence.earlier_access,
      });
    }
    summary = { repaired, left };
    deps.ledger.record({ repair_id: PERMANENT_PASS_REPAIR_ID, applied_at: now, summary });
  })();
  return { applied: true, summary };
};

const LISTED = 25;
const CUSTOMERS_ROUTE = '#settings/seller/customers';
const TIERS_ROUTE = '#settings/seller/tiers';

/** A package's Re-apply tab, as the webclient addresses it. The tab kept the
 *  address `customers` when its label became "Re-apply". */
const reapplyRoute = (tier_id: string): string =>
  `${TIERS_ROUTE}/detail/${encodeURIComponent(tier_id)}/customers`;

/** Where the notice sends the owner.
 *  - Passes it LEFT need a decision, made on a package's Re-apply tab (D-309).
 *    The link goes to that package's tab when they share one, else to the
 *    packages list.
 *  - Passes it only REPAIRED go to Customers, where each end date can be changed.
 *  Pointing the left ones at Customers too would send the owner to a list with
 *  no way to give a pass its package's end date. */
export const permanentPassRepairRoute = (summary: PermanentPassRepairSummary): string => {
  if (summary.left.length === 0) return CUSTOMERS_ROUTE;
  const packages = new Set(summary.left.map((l) => l.tier_id));
  const [only] = packages;
  // A summary recorded before the id was kept has none, so it goes to the list.
  return packages.size === 1 && only !== undefined ? reapplyRoute(only) : TIERS_ROUTE;
};

/** Why each was left, in the owner's words. */
const LEFT_REASON: Readonly<Record<PermanentPassLeftReason, string>> = {
  no_evidence: 'no purchase or enrollment on record',
  tier_edited_since_issue: 'the package changed after they got it',
};

const day = (at: number): string => new Date(at).toISOString().slice(0, 10);

const listed = <T>(items: readonly T[], line: (item: T) => string): string =>
  items.slice(0, LISTED).map((item) => `\n• ${line(item)}`).join('')
    + (items.length > LISTED ? `\n• …and ${items.length - LISTED} more` : '');

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The owner's notice, or null when the repair found nothing. */
export const permanentPassRepairNotice = (
  summary: PermanentPassRepairSummary,
  publicBaseUrl: string | null,
): NotificationMessage | null => {
  const { repaired, left } = summary;
  if (repaired.length === 0 && left.length === 0) return null;
  const parts: string[] = [];
  if (repaired.length > 0) {
    const sources = [
      ...(repaired.some((r) => r.evidence === 'paid_order') ? ['passes sold through the paid-pass recipes'] : []),
      ...(repaired.some((r) => r.evidence === 'enrollment') ? ['free DeepTutor enrollments'] : []),
    ];
    parts.push(
      `Before this update, ${sources.length === 2 ? `${sources[0]}, and ${sources[1]},` : sources[0]} `
        + 'were issued with no end date, so they never expired. Each now ends when its pass length '
        + 'says, counted from when it was issued. A pass that should already have ended ends now, '
        + 'and your usual grace period applies before access stops.'
        + listed(repaired, (r) => `${r.label}, ${r.tier}: ends ${day(r.current_period_end)}`
          + (r.grace_until === null ? '' : `, access until ${day(r.grace_until)}`)
          + (r.earlier_access
            ? '. They had access before this pass, and when that was due to end isn’t recorded, so check it'
            : '')),
    );
  }
  if (left.length > 0) {
    const one = left.length === 1;
    parts.push(
      `${plural(left.length, 'customer has', 'customers have')} no end date on a package that `
        + `normally ends. Recued can’t tell what end date ${one ? 'it' : 'each'} should have, so it left `
        + `${one ? 'it' : 'them'} as ${one ? 'it is' : 'they are'}.`
        + listed(left, (l) => `${l.label}, ${l.tier}: ${LEFT_REASON[l.reason]}`),
      `To give ${one ? 'it' : 'any of them'} the package’s end date, open the package under Settings → `
        + 'Seller → Tiers, then its Re-apply tab. Choose “Only the ones I pick” and tick '
        + `${one ? 'it' : 'them'}. Untick “Its permissions” unless you want those reset too. Preview `
        + 'shows each new end date before anything changes.',
    );
  }
  if (repaired.length > 0) parts.push('To change anyone’s end date, open Settings → Seller → Customers.');
  return {
    title: repaired.length > 0
      ? `${plural(repaired.length, 'pass', 'passes')} had no end date, and now ${repaired.length === 1 ? 'has' : 'have'} one`
      : `${plural(left.length, 'customer has', 'customers have')} no end date on a package that normally ends`,
    text: parts.join('\n\n'),
    ...(publicBaseUrl === null ? {} : { link_url: `${publicBaseUrl}/${permanentPassRepairRoute(summary)}` }),
  };
};

export interface PermanentPassRepairBootDeps extends PermanentPassRepairDeps {
  readonly auditLog: Pick<AuditLogStore, 'logActivity'>;
  readonly notifier: Pick<NotificationBlock, 'notify'>;
  readonly publicBaseUrl: string | null;
}

export interface PermanentPassRepairBootResult {
  readonly applied: boolean;
  readonly repaired: number;
  readonly left: number;
  readonly noticed: boolean;
}

/** The boot pass: repair (once), then make sure the owner has been told.
 *
 *  The notice follows the saved-view alerts' order: the history row first,
 *  under a fixed id so a retry overwrites rather than duplicates; then the
 *  ledger's `noticed_at`; then the live push, which is best-effort. A crash
 *  before `noticed_at` re-delivers at the next boot; one after it has the
 *  notice in the history already. */
export const runPermanentPassRepairAtBoot = async (
  deps: PermanentPassRepairBootDeps,
): Promise<PermanentPassRepairBootResult> => {
  const { applied, summary } = repairPermanentPasses(deps);
  const result = { applied, repaired: summary.repaired.length, left: summary.left.length };
  const record = deps.ledger.get(PERMANENT_PASS_REPAIR_ID);
  if (record === null || record.noticed_at !== null) return { ...result, noticed: false };
  const message = permanentPassRepairNotice(summary, deps.publicBaseUrl);
  if (message === null) {
    deps.ledger.markNoticed(PERMANENT_PASS_REPAIR_ID, deps.now());
    return { ...result, noticed: false };
  }
  const persisted_activity_id = `data-repair:${PERMANENT_PASS_REPAIR_ID}`;
  const route = permanentPassRepairRoute(summary);
  await deps.auditLog.logActivity({
    activity_id: persisted_activity_id,
    timestamp: record.applied_at,
    action: 'notification_fired',
    target: PERMANENT_PASS_REPAIR_ID,
    detail: JSON.stringify({ ...message, link_url: message.link_url ?? route }),
  });
  deps.ledger.markNoticed(PERMANENT_PASS_REPAIR_ID, deps.now());
  await deps.notifier
    .notify(message, undefined, { persisted_activity_id, ui_link_url: route })
    .catch(() => undefined);
  return { ...result, noticed: true };
};
