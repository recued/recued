/** D-139 P4 — the three projections `_record-projected-task.ts` dispatches.
 *
 *  Each turns a record + its engagements into one kernel's input. All three
 *  read `engagement_edges`, which `(target_kind, target_id, edge_type)`
 *  indexes, and two also read the counterpart CRM record's `meta` snapshot.
 *
 *  ⛔ ONLY `target_kind='data.contact'` CONTACT EDGES CARRY AN EMAIL. A
 *  Salesforce platform-id contact edge is `target_kind='connection.api'` and
 *  holds a vendor id awaiting the deferred id→email lookup. Joining on it
 *  would match nothing while looking like it should — the same shape as the
 *  three write-key/read-key asymmetries this producer family already had. */

import type Database from 'better-sqlite3';

import type { EngagementRow } from '@recued/contracts';

import type { AccountBreadthRow } from './account-engagement-breadth.js';
import type { ChampionDealRow } from './champion-deal-count.js';

export const canonicalEmail = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
};

/** The domain half of an email, or null. */
export const emailDomain = (email: string | null): string | null => {
  if (email === null) return null;
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  return email.slice(at + 1);
};

/** ── account_engagement_breadth ──────────────────────────────────
 *  Pair each of the account's engagements with the contact it involves.
 *  One engagement may carry several contact edges (a mail to three people);
 *  the kernel counts DISTINCT contacts, so emitting one row per (engagement,
 *  contact) pair is what lets it see all three. An engagement with no
 *  resolvable contact still emits, with `contact_email: null` — the kernel
 *  uses those for recency without counting them toward breadth. */
export const projectAccountBreadthRows = (
  db: Database.Database,
  engagements: ReadonlyArray<EngagementRow>,
): AccountBreadthRow[] => {
  if (engagements.length === 0) return [];
  const stmt = db.prepare(
    `SELECT target_id FROM engagement_edges
      WHERE connection_id = ? AND engagement_target_id = ?
        AND edge_type = 'contact' AND target_kind = 'data.contact'
        AND deleted_at IS NULL`,
  );
  const out: AccountBreadthRow[] = [];
  for (const row of engagements) {
    const emails = (stmt.all(row.connection_id, row.target_id) as Array<{ target_id: string }>)
      .map((e) => canonicalEmail(e.target_id))
      .filter((e): e is string => e !== null);
    if (emails.length === 0) {
      out.push({ row, contact_email: null });
      continue;
    }
    for (const contact_email of emails) out.push({ row, contact_email });
  }
  return out;
};

/** ── champion_deal_count ─────────────────────────────────────────
 *  The DISTINCT deals this contact has engaged on, each with its closed
 *  status.
 *
 *  🔑 `close_state` is a VENDOR-NEUTRAL derived tri-state that BOTH the
 *  HubSpot deal reconciler and the Salesforce opportunity reconciler
 *  materialise (`deriveCloseState` → `'won' | 'lost' | 'open'`). The kernel's
 *  header still describes reading Salesforce's raw `IsWon` / `IsClosed`; that
 *  is stale — there is one field, and this projection is vendor-agnostic
 *  because of it.
 *
 *  A deal whose record has not been reconciled yet has no meta to read and
 *  yields `'unknown'` — distinct from `'open'`, which is a fact about the
 *  deal rather than about our knowledge of it. */
export const projectChampionDealRows = (
  db: Database.Database,
  contact_email: string,
): ChampionDealRow[] => {
  const rows = db
    .prepare(
      `SELECT DISTINCT d.target_id AS deal_id
         FROM engagement_edges c
         JOIN engagement_edges d
           ON d.connection_id = c.connection_id
          AND d.engagement_target_id = c.engagement_target_id
          AND d.edge_type = 'deal' AND d.target_kind = 'connection.api'
          AND d.deleted_at IS NULL
        WHERE c.edge_type = 'contact' AND c.target_kind = 'data.contact'
          AND c.target_id = ? AND c.deleted_at IS NULL`,
    )
    .all(contact_email) as Array<{ deal_id: string }>;

  const metaStmt = db.prepare(
    `SELECT MAX(meta) AS meta_json, MAX(ingested_at) AS at
       FROM data_enrichment
      WHERE target_id = ? AND meta IS NOT NULL`,
  );

  const out: ChampionDealRow[] = [];
  for (const { deal_id } of rows) {
    const found = metaStmt.get(deal_id) as { meta_json: string | null; at: number | null } | undefined;
    let status: ChampionDealRow['status'] = 'unknown';
    if (found?.meta_json) {
      try {
        const close = (JSON.parse(found.meta_json) as { close_state?: unknown }).close_state;

        if (close === 'won' || close === 'lost' || close === 'open') status = close;
      } catch { /* unparseable meta ⇒ unknown, never a guess */ }
    }
    out.push({ deal_id, status, vendor_modified_at: found?.at ?? 0 });
  }
  return out;
};

/** ── multi_account_contact ───────────────────────────────────────
 *  The domains of the CRM accounts this contact is affiliated with, read
 *  from each account record's canonical `meta.domain` (both the HubSpot
 *  company reconciler and the Salesforce account reconciler project it under
 *  that one key). Reached through the contact's engagements' account edges —
 *  the same fan-out the deal walk uses. */
export const projectCrmCompanyDomains = (
  db: Database.Database,
  contact_email: string,
): { domains: string[]; latest_modified_at: number } => {
  const rows = db
    .prepare(
      `SELECT DISTINCT a.target_id AS account_id
         FROM engagement_edges c
         JOIN engagement_edges a
           ON a.connection_id = c.connection_id
          AND a.engagement_target_id = c.engagement_target_id
          AND a.edge_type = 'account' AND a.target_kind = 'connection.api'
          AND a.deleted_at IS NULL
        WHERE c.edge_type = 'contact' AND c.target_kind = 'data.contact'
          AND c.target_id = ? AND c.deleted_at IS NULL`,
    )
    .all(contact_email) as Array<{ account_id: string }>;

  const metaStmt = db.prepare(
    `SELECT MAX(meta) AS meta_json, MAX(ingested_at) AS at
       FROM data_enrichment
      WHERE target_id = ? AND meta IS NOT NULL`,
  );

  const domains: string[] = [];
  let latest_modified_at = 0;
  for (const { account_id } of rows) {
    const found = metaStmt.get(account_id) as { meta_json: string | null; at: number | null } | undefined;
    if (typeof found?.at === 'number' && found.at > latest_modified_at) latest_modified_at = found.at;
    if (!found?.meta_json) continue;
    try {
      const domain = (JSON.parse(found.meta_json) as { domain?: unknown }).domain;
      const canonical = typeof domain === 'string' ? domain.trim().toLowerCase() : '';
      if (canonical.length > 0) domains.push(canonical);

    } catch { /* unparseable meta contributes no domain */ }
  }
  return { domains, latest_modified_at };
};

/** The contact record's own email, from its platform-reference meta snapshot.
 *  Every contact reconciler projects `meta.email`; without it the contact
 *  cannot be joined to anything and the caller must skip rather than compute
 *  over an empty edge set (which would read as a confident negative). */
export const contactEmailFromMeta = (meta_json: string | null): string | null => {
  if (meta_json === null) return null;
  try {
    return canonicalEmail((JSON.parse(meta_json) as { email?: unknown }).email);
  } catch {
    return null;
  }
};
