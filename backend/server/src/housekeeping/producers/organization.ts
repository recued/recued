/** D-131 A.16 — `organization` enrichment producer.
 *
 *  Third Shape B (derived-entity) housekeeping producer in Phase A;
 *  second deterministic Shape B. `policy: 'independent'` (NOT
 *  `members_list`): no cascade-watched member array — the producer
 *  rebuilds the row contents from scratch each cycle. This is the
 *  simplest Shape B variant: no `members_scope`, no cascade-trim
 *  concerns, no AI surface, no force-layer threading, no AI-output
 *  validation.
 *
 *  Standalone `HousekeepingTaskInstance` (matches `workingGroupTask` /
 *  `topicClusterTask` / `confidenceDriftSignalTask` precedent — Shape B
 *  aggregates across the whole contact corpus rather than per-record).
 *
 *  Algorithm:
 *
 *    1. **Contact scan.** Walk the singleton `contacts` table for rows
 *       with `last_interaction` within `CONTACT_LOOKBACK_MS`, capped at
 *       `MAX_CONTACTS_SCANNED`. Newest-first by `last_interaction`.
 *
 *    2. **Per-contact domain extraction.** Parse the email's domain;
 *       skip rows without `@`. Skip rows whose domain is in
 *       `FREE_MAIL_DOMAINS` — gmail / yahoo / etc. aren't the
 *       organisations the user works with; the `company` producer (A.10)
 *       already covers per-contact `domain_category: 'free_mail'`.
 *
 *    3. **Group by domain.** Map<domain, contactList>. All contacts
 *       sharing a business domain fold into one organisation.
 *
 *    4. **Filter by membership.** Drop groups with fewer than
 *       `MIN_CONTACTS_PER_ORG = 2` contacts — a single contact at a
 *       domain isn't an "organisation" the user interacts with; it's
 *       just a contact. The `company` producer surfaces single-contact
 *       company info on `data.contact.<email>`.
 *
 *    5. **Cap.** Hold the top `MAX_ORGS = 50` orgs by contact count desc
 *       with `last_interaction` desc tiebreak. Higher than `MAX_GROUPS`
 *       on `working_group` (30) since orgs are coarser-grained — fewer
 *       expected per pair, but each one is more informative.
 *
 *    6. **Stable id.** `derived_entity_id =
 *       organization_<sha1-prefix(domain)>`. Stable across runs for the
 *       same domain; upserts replace the row in place as new contacts
 *       at that domain accrete.
 *
 *    7. **Sweep stale.** Delete every existing row of the topic whose
 *       id wasn't refreshed this cycle (domain dropped out of corpus
 *       entirely, or contact count dropped below `MIN_CONTACTS_PER_ORG`).
 *
 *  Pre-launch zero-installs semantics: the producer is the single
 *  source of truth for `organization` rows. The `independent` policy
 *  means cascade engine never touches these rows on contact-source-
 *  delete — manual sweep is the only orphan-cleanup mechanism. */

import { createHash } from 'node:crypto';

import {
  ENRICHMENT_REGISTRY,
  computeHousekeepingMetaTags,
  type EnrichmentTopic,
  type HousekeepingCursor,
  type HousekeepingStepResult,
  type OrganizationValue,
} from '@recued/contracts';

import type {
  HousekeepingContext,
  HousekeepingTaskInstance,
} from '../registry.js';
import { domainToCompanyName, extractDomain } from './company.js';
import { FREE_MAIL_DOMAINS } from './_free-mail-domains.js';
import { contactName } from './_contact-names.js';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

/** How far back the contact scan reaches by `last_interaction`. 180d
 *  matches a typical "active org" cadence — quarterly business contact
 *  is still active; year-old single emails aren't. Wider than the
 *  90d look-back on `topic_cluster` / `working_group` because the
 *  contacts-table interaction time is a coarser, longer-tailed signal
 *  than per-message / per-event observation. */
export const CONTACT_LOOKBACK_MS = 180 * 24 * 60 * 60 * 1000;

/** Hard cap on contacts folded into one cycle. Contact volume per pair
 *  rarely exceeds a few thousand active rows / 180d; the cap is
 *  defensive. Newest-first sort means a corpus over the cap loses the
 *  oldest contacts — acceptable for organisation-level aggregation. */
export const MAX_CONTACTS_SCANNED = 5000;

/** Minimum contacts per org before it emits. n=2 is the floor for
 *  "organisation": a single contact at a domain is captured by the
 *  `company` producer's per-contact row already; the org surface is
 *  about clusters. */
export const MIN_CONTACTS_PER_ORG = 2;

/** Cap on emitted orgs per cycle. Higher than `MAX_GROUPS` on
 *  `working_group` (30) since orgs are coarser-grained — fewer expected
 *  per pair, no LLM-budget pressure (deterministic), and the warehouse
 *  explorer can comfortably render a 50-row org list. */
export const MAX_ORGS = 50;

/** Hash prefix length on the `derived_entity_id`. 12 hex chars matches
 *  `topic_cluster` / `working_group` for symmetric-looking ids in the
 *  warehouse explorer. */
export const ID_HASH_PREFIX_LEN = 12;

/** Per-cycle token estimate for the Run-Now cost preview. Deterministic
 *  — pure SQL aggregation + arithmetic. Zero token spend; idle-eligible
 *  by virtue of `is_ai_surface: false` + `default_trust_state: 'auto'`
 *  resolution from the registry. */
export const TOKEN_ESTIMATE_PER_CYCLE = 0;

/** Authored-by stamp for organization rows. Keeps Memory feed
 *  attribution clean alongside the other Shape A / Shape B housekeeping
 *  producers. */
export const ORGANIZATION_AUTHORED_BY = 'system.housekeeping.organization';

/** Topic key for this producer's emitted rows. */
export const ORGANIZATION_TOPIC: EnrichmentTopic = 'organization';

// ────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────

/** Compose the stable `derived_entity_id` for an organisation. Hashes
 *  the domain — same domain across runs hashes to the same id, so
 *  re-runs upsert in place rather than churning ids. */
export const deriveDerivedEntityId = (domain: string): string => {
  const digest = createHash('sha1').update(domain).digest('hex');
  return `organization_${digest.slice(0, ID_HASH_PREFIX_LEN)}`;
};

/** A scanned contact boiled down to the fields the producer actually
 *  consumes. Reduces SQL row narrowing + JS object retention to a
 *  single shape. */
interface ScannedContact {
  email: string;
  domain: string;
  first_seen: number;
  last_interaction: number;
}

/** A candidate organisation prior to emit — collects contacts sharing
 *  the same business domain; min-contacts + cap filters apply downstream. */
export interface CandidateOrg {
  domain: string;
  contacts: string[];
  first_seen_at: number;
  last_interaction_at: number;
}

/** Walk the `contacts` table for rows within the look-back window.
 *  Newest-first by `last_interaction`, capped at the per-cycle limit.
 *  Skips contacts with non-business domains (free-mail providers) at
 *  the SQL boundary — keeps the candidate pool focused. */
export const scanRecentContacts = (
  ctx: HousekeepingContext,
  now: number,
  limit: number = MAX_CONTACTS_SCANNED,
): ScannedContact[] => {
  // Tolerate missing contacts table — warehouse may not yet have
  // initialised in fresh-pair / first-boot scenarios. The producer
  // returns zero candidates; sweep cleans up any rows from prior runs.
  const tableExists = ctx.db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='contacts'`,
    )
    .get() as { name: string } | undefined;
  if (!tableExists) return [];

  const earliest = now - CONTACT_LOOKBACK_MS;
  const rows = ctx.db
    .prepare(
      `SELECT email, first_seen, last_interaction FROM contacts
        WHERE last_interaction >= ?
        ORDER BY last_interaction DESC
        LIMIT ?`,
    )
    .all(earliest, limit) as Array<{
      email: string;
      first_seen: number;
      last_interaction: number;
    }>;

  const scanned: ScannedContact[] = [];
  for (const row of rows) {
    const domain = extractDomain(row.email);
    if (domain === '') continue;
    if (FREE_MAIL_DOMAINS.has(domain)) continue;
    scanned.push({
      email: row.email,
      domain,
      first_seen: row.first_seen,
      last_interaction: row.last_interaction,
    });
  }
  return scanned;
};

/** Group contacts by business domain into candidate organisations.
 *  Newest-by-last-interaction events flow in first (`scanRecentContacts`
 *  already sorted desc), so per-org `last_interaction_at` is the first
 *  contact seen for the domain. Tracks oldest `first_seen_at` across
 *  contacts so org age can be derived without a separate field. */
export const groupContactsByDomain = (
  contacts: ReadonlyArray<ScannedContact>,
): CandidateOrg[] => {
  const orgs = new Map<string, CandidateOrg>();
  for (const contact of contacts) {
    const existing = orgs.get(contact.domain);
    if (existing) {
      existing.contacts.push(contact.email);
      if (contact.last_interaction > existing.last_interaction_at) {
        existing.last_interaction_at = contact.last_interaction;
      }
      if (contact.first_seen < existing.first_seen_at) {
        existing.first_seen_at = contact.first_seen;
      }
    } else {
      orgs.set(contact.domain, {
        domain: contact.domain,
        contacts: [contact.email],
        first_seen_at: contact.first_seen,
        last_interaction_at: contact.last_interaction,
      });
    }
  }
  return Array.from(orgs.values());
};

/** Filter candidate orgs by `MIN_CONTACTS_PER_ORG` + cap at `MAX_ORGS`.
 *  Sorted by contact count desc with `last_interaction_at` desc
 *  tiebreak so the most-active large orgs win the cap. */
export const filterAndCapOrgs = (
  orgs: ReadonlyArray<CandidateOrg>,
  minContacts: number = MIN_CONTACTS_PER_ORG,
  cap: number = MAX_ORGS,
): CandidateOrg[] => {
  const surviving = orgs.filter((o) => o.contacts.length >= minContacts);
  surviving.sort((a, b) => {
    if (b.contacts.length !== a.contacts.length) {
      return b.contacts.length - a.contacts.length;
    }
    return b.last_interaction_at - a.last_interaction_at;
  });
  return surviving.slice(0, cap);
};

/** Build an `OrganizationValue` + the stable `derived_entity_id` from a
 *  finalised candidate org. Contacts deduplicated + sorted for
 *  deterministic JSON output. */
export const assembleOrg = (
  candidate: CandidateOrg,
  now: number,
  resolveName?: (email: string) => string | undefined,
): { value: OrganizationValue; derived_entity_id: string } => {
  const contacts = Array.from(new Set(candidate.contacts)).sort();
  // Bench harvest (P1 v8) — the bench's v7 retirement experiment
  // falsified "trivially composable from raw": the consuming agent
  // declines to synthesize canonical member names from bare emails.
  // Denormalize `{ entity, name }` pairs at producer time instead;
  // entries exist only for contacts the directory NAMES.
  const contacts_resolved =
    resolveName === undefined
      ? []
      : contacts.flatMap((entity) => {
          const name = resolveName(entity);
          return name === undefined ? [] : [{ entity, name }];
        });
  const value: OrganizationValue = {
    domain: candidate.domain,
    organization_name: domainToCompanyName(candidate.domain),
    contacts,
    ...(contacts_resolved.length > 0 ? { contacts_resolved } : {}),
    contact_count: contacts.length,
    last_interaction_at: candidate.last_interaction_at,
    first_seen_at: candidate.first_seen_at,
    computed_at: now,
  };
  return {
    value,
    derived_entity_id: deriveDerivedEntityId(candidate.domain),
  };
};

/** Sweep stale rows: list every existing organization row, deleteById
 *  any whose id wasn't refreshed this cycle. Pre-launch zero-installs
 *  semantics — eager pruning keeps the warehouse explorer free of
 *  decayed orgs (domains where every contact dropped out of the
 *  look-back window or below `MIN_CONTACTS_PER_ORG`). */
export const sweepStaleOrgs = (
  ctx: HousekeepingContext,
  freshIds: ReadonlySet<string>,
): { deleted: number } => {
  const existing = ctx.enrichmentStore.list({
    topic: ORGANIZATION_TOPIC,
    fresh_only: false,
    limit: 1000,
  });
  let deleted = 0;
  for (const row of existing) {
    if (freshIds.has(row._id)) continue;
    if (ctx.enrichmentStore.deleteById(row._id)) deleted += 1;
  }
  return { deleted };
};

// ────────────────────────────────────────────────────────────────
// Step
// ────────────────────────────────────────────────────────────────

/** One-shot scan-and-emit cycle. Exported for direct test access
 *  without the task wrapper. Returns `{ produced }` for caller-side
 *  assertions on cycle output. */
export const runOrganizationCycle = (
  ctx: HousekeepingContext,
): { produced: number } => {
  const now = ctx.now();
  const contacts = scanRecentContacts(ctx, now);
  if (contacts.length === 0) {
    sweepStaleOrgs(ctx, new Set());
    return { produced: 0 };
  }

  const candidates = groupContactsByDomain(contacts);
  const orgs = filterAndCapOrgs(candidates);
  if (orgs.length === 0) {
    sweepStaleOrgs(ctx, new Set());
    return { produced: 0 };
  }

  const freshIds = new Set<string>();
  let produced = 0;
  for (const candidate of orgs) {
    const { value, derived_entity_id } = assembleOrg(candidate, now, (email) =>
      contactName(ctx, email),
    );
    ctx.enrichmentStore.upsert({
      topic: ORGANIZATION_TOPIC,
      derived_entity_id,
      value,
      authored_by: ORGANIZATION_AUTHORED_BY,
      event_at: now,
    });
    freshIds.add(derived_entity_id);
    produced += 1;
  }

  sweepStaleOrgs(ctx, freshIds);
  return { produced };
};

// ────────────────────────────────────────────────────────────────
// Task instance
// ────────────────────────────────────────────────────────────────

export const organizationTask: HousekeepingTaskInstance = {
  meta: {
    id: 'enrichment.organization',
    description:
      'Cluster contacts by business email domain; one row per inferred organisation.',
    interruptible: true,
    kind: 'enrichment',
    tags: computeHousekeepingMetaTags({
      def: ENRICHMENT_REGISTRY.organization,
      isAiSurface: false,
    }),
  },
  topic: ORGANIZATION_TOPIC,
  is_ai_surface: false,

  async step(
    ctx: HousekeepingContext,
    _cursor: HousekeepingCursor,
    _budget_ms: number,
  ): Promise<HousekeepingStepResult> {
    runOrganizationCycle(ctx);
    return { status: 'complete', cursor: { kind: 'complete' } };
  },
};

/** Per-cycle token estimate for the Run-Now cost preview. Exposed
 *  separately from the task instance so the rpc handler that builds
 *  the preview can call it without instantiating a step. Always 0
 *  (deterministic). */
export const organizationTokenEstimate = (): number => TOKEN_ESTIMATE_PER_CYCLE;

/** Scope-of-read declaration surfaced in the Run-Now scope dialog +
 *  detail drawer. Mirrors the shape the harness validates for Shape A
 *  producers. */
export const organizationScopeReadDeclaration = [
  {
    collection: 'data.contact',
    sample_field_paths: ['email', 'first_seen', 'last_interaction'],
  },
] as const;
