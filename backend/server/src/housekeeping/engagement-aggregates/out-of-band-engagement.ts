/** D-139 P4 — `out_of_band_engagement` deterministic producer.
 *
 *  Deal-scoped visibility-gap signal. Surfaces outbound rep mails
 *  to deal contacts that did NOT land as a CRM email engagement —
 *  "your real work isn't visible to the system."
 *
 *  Matching strategy per § A.9.2b:
 *    - Mail-to-CRM-engagement matching prefers the RFC822
 *      `Message-ID` header. This producer matches independently — it
 *      indexes the supplied CRM rows by `meta.message_id`
 *      (`buildCrmMessageIdIndex`) and compares against the supplied
 *      mail rows' Message-IDs; it does NOT read `engagement_edges`.
 *      (D-184 Decision 2 moved mail-twin resolution to read time — the
 *      ingest no longer pre-binds a `target_kind='data.mail'` edge —
 *      but this producer never depended on that edge.)
 *    - Fallback: `(from + to + sent_at + subject_hash)` quadruple
 *      against CRM email engagement rows whose meta carries the
 *      same canonical from/to + a sent_at within `MATCH_TOLERANCE_MS`
 *      AND the producer-computed `subject_hash`. `dedupe_confidence:
 *      'probable'` — counted as "matched" so we don't flag mail
 *      that's almost certainly the CRM row, just not stamped.
 *    - Grace window: `OUT_OF_BAND_GRACE_MINUTES = 30` after CRM
 *      engagement landing — mail < 30 min old not yet flagged
 *      (CRM logging is async). Implemented as
 *      `now - mail.event_at >= grace`.
 *
 *  Confidence gate per § A.9.2b:
 *    - Alert ONLY when contact has clear primary-deal signal:
 *      single-deal contact OR primary-deal activity in last 14d.
 *    - The producer reports `out_of_band_count` regardless (so
 *      recipes have access to the raw count); but
 *      `confidence_gate_passed` toggles whether recipes should
 *      escalate. Below threshold → recipes silent on the row.
 *
 *  Pass-4 evidence-quality consumption defaults baked in:
 *    - mail filter: `direction='outbound'`; rep-typed authorship
 *      (caller is responsible for mail-side typing — producer
 *      assumes the supplied `mail_rows` already match this).
 *    - dedupe_acceptance: `'exact_only'` — matches by Message-ID
 *      are exact + collapse; quadruple-fallback matches surface
 *      as 'probable' confidence + count as out-of-band (the
 *      probable match isn't strong enough to assume "the CRM
 *      has it").
 *
 *  Spec: `docs/d-139-spec.md` § A.9.2b + § P4 acceptance. */

import {
  type CoverageMetadata,
  type EngagementRow,
  type OutOfBandEngagementValue,
} from '@recued/contracts';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

/** Grace window: mail < 30 min old isn't flagged as out-of-band
 *  yet — CRM logging is async and the row may still be in flight.
 *  Per § A.9.2b. */
export const OUT_OF_BAND_GRACE_MINUTES = 30;
export const OUT_OF_BAND_GRACE_MS = OUT_OF_BAND_GRACE_MINUTES * 60 * 1000;

/** Recent window: 90d of mail considered for out-of-band detection.
 *  Mirrors the velocity / inbound-outbound 90d window so cross-topic
 *  recipes share the same horizon. */
export const OUT_OF_BAND_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/** Quadruple-fallback `sent_at` tolerance: ±5 min. CRM email logging
 *  often re-stamps the timestamp on ingest (HubSpot's `hs_timestamp`
 *  vs the actual send time can drift); this tolerance absorbs the
 *  drift without false-merging unrelated emails. */
export const OUT_OF_BAND_MATCH_TOLERANCE_MS = 5 * 60 * 1000;

/** Recency threshold for primary-deal activity confidence: 14d.
 *  Mail counts toward the gate when the contact has primary-deal
 *  activity within this window. */
export const OUT_OF_BAND_PRIMARY_DEAL_RECENCY_MS = 14 * 24 * 60 * 60 * 1000;

// ────────────────────────────────────────────────────────────────
// Producer-supplied evidence shapes
// ────────────────────────────────────────────────────────────────

/** Minimal mail-row shape the producer needs. Substrate-side
 *  callers project this from `data.mail` rows (or from the
 *  HubSpot mail-twin matcher's source rows) before feeding the
 *  producer. */
export interface OutOfBandMailRow {
  /** Unique mail identifier — `Message-ID` header preferred, falls
   *  back to a synthetic id (mail-row primary key). Match key. */
  message_id: string | null;
  /** Canonical sender email (lowercased + trimmed). */
  from_email: string;
  /** Canonical recipient emails (lowercased + trimmed). At least
   *  one entry; producer matches against the FIRST entry for
   *  quadruple-fallback. */
  to_emails: ReadonlyArray<string>;
  /** Subject hash — caller-computed canonical hash so producer is
   *  pure-compute. Substrate uses the same hash function on the
   *  CRM side via the engagement row's meta. */
  subject_hash: string;
  /** Send time — Mail Date: header. Unix-ms. */
  sent_at: number;
  /** Mail's vendor_modified_at (or warehouse ingestion time) for
   *  cursor advancement. Unix-ms. */
  vendor_modified_at: number;
}

/** Per-contact deal-association confidence signal. Caller computes
 *  this from CRM contact records + the deal's edge fan-out. */
export interface OutOfBandContactConfidence {
  /** Canonical contact email (lowercased + trimmed). */
  email: string;
  /** Number of distinct deals the contact is associated with at
   *  the CRM-record level. `1` → single-deal contact (high
   *  confidence). `> 1` → multi-deal (gate-pass requires recent
   *  primary-deal activity). */
  deal_count: number;
  /** Unix-ms of the contact's most-recent qualifying engagement
   *  on THIS deal (the deal whose enrichment is being computed).
   *  Used for the 14d primary-deal-activity gate. `0` when
   *  contact has no recorded activity on this deal. */
  primary_deal_last_activity_at: number;
}

// ────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────

/** Index CRM email engagement rows by Message-ID for O(1) match.
 *  Codex P1 #2 fold — only outbound CRM rows are indexed; an inbound
 *  CRM row carrying the same Message-ID must not suppress an
 *  outbound visibility-gap alert. */
export const buildCrmMessageIdIndex = (
  rows: ReadonlyArray<EngagementRow>,
): ReadonlyMap<string, EngagementRow> => {
  const idx = new Map<string, EngagementRow>();
  for (const row of rows) {
    if (row.entity !== 'email' && row.entity !== 'email_message') continue;
    if (row.direction !== 'outbound') continue;
    const message_id = (row.meta as { message_id?: unknown } | undefined)?.message_id;
    if (typeof message_id === 'string' && message_id.length > 0) {
      idx.set(message_id, row);
    }
  }
  return idx;
};

/** True when a CRM row matches the mail by quadruple fallback
 *  (`from + first-recipient + sent_at±tolerance + subject_hash`).
 *
 *  Codex P1 #2 fold — outbound visibility-gap producer compares
 *  outbound mail against outbound CRM rows; an inbound CRM email
 *  carrying the same Message-ID (e.g. threaded reply with matching
 *  subject_hash on a re-stamped envelope) must NOT suppress the
 *  alert. CRM-side direction must agree with the mail alert path. */
export const matchesCrmQuadruple = (
  mail: OutOfBandMailRow,
  crmRow: EngagementRow,
): boolean => {
  if (crmRow.entity !== 'email' && crmRow.entity !== 'email_message') return false;
  if (crmRow.direction !== 'outbound') return false;
  const meta = crmRow.meta as {
    from_email?: unknown;
    to_emails?: unknown;
    subject_hash?: unknown;
    timestamp?: unknown;
  } | undefined;
  if (!meta) return false;
  if (typeof meta.from_email !== 'string' || meta.from_email !== mail.from_email) return false;
  // First-recipient match — mail-to-CRM ingest is conservative
  // (HubSpot logs the to-list verbatim; first recipient is the
  // primary). Empty mail to-list excludes from match.
  if (mail.to_emails.length === 0) return false;
  const crm_to = Array.isArray(meta.to_emails) ? meta.to_emails : [];
  if (crm_to.length === 0) return false;
  if (typeof crm_to[0] !== 'string' || crm_to[0] !== mail.to_emails[0]) return false;
  if (typeof meta.subject_hash !== 'string' || meta.subject_hash !== mail.subject_hash) return false;
  // Use crmRow.event_at as the canonical sent_at (mapped from
  // hs_email_sent_on for HubSpot, MessageDate for Salesforce);
  // fall back to meta.timestamp when event_at is null (failed
  // sends carry vendor_modified_at semantics).
  const crm_sent_at = crmRow.event_at ?? (typeof meta.timestamp === 'number' ? meta.timestamp : null);
  if (crm_sent_at === null) return false;
  if (Math.abs(crm_sent_at - mail.sent_at) > OUT_OF_BAND_MATCH_TOLERANCE_MS) return false;
  return true;
};

/** Confidence gate: contact passes when single-deal OR primary-deal
 *  activity in last 14d. Empty / unknown confidence → fail-closed
 *  (recipes silent rather than alert noise). */
export const passesConfidenceGate = (
  confidence: OutOfBandContactConfidence | undefined,
  now: number,
): boolean => {
  if (!confidence) return false;
  if (confidence.deal_count === 1) return true;
  if (confidence.primary_deal_last_activity_at > 0) {
    return now - confidence.primary_deal_last_activity_at <= OUT_OF_BAND_PRIMARY_DEAL_RECENCY_MS;
  }
  return false;
};

// ────────────────────────────────────────────────────────────────
// Producer entry point
// ────────────────────────────────────────────────────────────────

export interface OutOfBandEngagementProducerInput {
  /** Mail rows from `data.mail` already filtered to outbound rep
   *  mail to a deal contact in the recent (90d) window. */
  mail_rows: ReadonlyArray<OutOfBandMailRow>;
  /** CRM email engagement rows scoped to the deal — both
   *  HubSpot `hubspot.email` + Salesforce `salesforce.email_message`. */
  crm_email_rows: ReadonlyArray<EngagementRow>;
  /** Per-contact confidence map (lookup by canonical email).
   *  Producer reads `contact_confidence.get(mail.to_emails[0])` for
   *  the gate; absent → fail-closed. */
  contact_confidence: ReadonlyMap<string, OutOfBandContactConfidence>;
  /** Caller-supplied coverage signals; pass through unchanged. */
  coverage: CoverageMetadata;
  /** Wall-clock now() in unix-ms UTC. */
  now: number;
}

export interface OutOfBandEngagementProducerOutput {
  value: OutOfBandEngagementValue;
  coverage: CoverageMetadata;
}

export const computeOutOfBandEngagement = (
  input: OutOfBandEngagementProducerInput,
): OutOfBandEngagementProducerOutput => {
  const messageIdIndex = buildCrmMessageIdIndex(input.crm_email_rows);
  const recent_cutoff = input.now - OUT_OF_BAND_WINDOW_MS;

  let out_of_band_count = 0;
  let latest_unmatched_at = 0;
  let cursor_at = 0;

  // Codex P1 #5 fold — cursor_at folds across BOTH source surfaces
  // per the registry's "max source vendor_modified_at (mail or
  // CRM)" contract. Pre-fold the loop only updated cursor inside
  // the mail walk so CRM-only updates couldn't advance it.
  for (const crmRow of input.crm_email_rows) {
    if (crmRow.vendor_modified_at > cursor_at) cursor_at = crmRow.vendor_modified_at;
  }

  for (const mail of input.mail_rows) {
    if (mail.vendor_modified_at > cursor_at) cursor_at = mail.vendor_modified_at;
    // Window cutoff — only the 90d horizon counts.
    if (mail.sent_at < recent_cutoff) continue;
    // Grace window — mail < 30 min old isn't yet flagged.
    if (input.now - mail.sent_at < OUT_OF_BAND_GRACE_MS) continue;

    // Match attempt 1 — Message-ID exact match.
    if (mail.message_id && messageIdIndex.has(mail.message_id)) continue;

    // Match attempt 2 — quadruple fallback against any CRM email row.
    let matchedQuadruple = false;
    for (const crmRow of input.crm_email_rows) {
      if (matchesCrmQuadruple(mail, crmRow)) {
        matchedQuadruple = true;
        break;
      }
    }
    if (matchedQuadruple) continue;

    // Codex P1 #1 fold — confidence gate filters BEFORE counting.
    // Pre-fold below-threshold mails inflated `out_of_band_count`
    // even though the registry contract said "below threshold →
    // mails don't count toward out_of_band_count" — the count
    // shape is "alert-able out-of-band mails," not raw unmatched.
    // Confidence gate uses the FIRST recipient as the primary
    // deal contact; multi-recipient mail still surfaces but
    // gates on the primary's confidence.
    const primary_to = mail.to_emails[0] ?? '';
    const conf = input.contact_confidence.get(primary_to);
    if (!passesConfidenceGate(conf, input.now)) continue;

    // Out-of-band, alert-able — count + track the latest unmatched.
    out_of_band_count += 1;
    if (mail.sent_at > latest_unmatched_at) {
      latest_unmatched_at = mail.sent_at;
    }
  }

  // `confidence_gate_passed` is a derived field — true iff at least
  // one alert-able mail landed in the count (since every counted
  // mail passed the gate by construction).
  const confidence_gate_passed = out_of_band_count > 0;

  const value: OutOfBandEngagementValue = {
    out_of_band_count,
    latest_unmatched_at,
    confidence_gate_passed,
    cursor_at,
  };

  return { value, coverage: input.coverage };
};
