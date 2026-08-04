/** Zero-AI business relationship context for one exact contact email.
 *
 * This is deliberately a metadata-only projection. It reports counts, coarse
 * lifecycle buckets, and source coverage; it never carries mail/calendar body
 * content, work-item titles, deal names, or company names. A consumer may use
 * positive evidence immediately, while a zero paired with non-complete coverage
 * must remain "unknown" rather than being presented as "never happened". */

import type { ContactCompanySource } from './contact.js';

export const CONTACT_BUSINESS_CONTEXT_COVERAGE = [
  'complete',
  'partial',
  'not_configured',
  'unavailable',
] as const;
export type ContactBusinessContextCoverage =
  (typeof CONTACT_BUSINESS_CONTEXT_COVERAGE)[number];

export const CONTACT_BUSINESS_CONTEXT_LEVELS = [
  'none',
  'known',
  'historical',
  'active',
] as const;
export type ContactBusinessContextLevel =
  (typeof CONTACT_BUSINESS_CONTEXT_LEVELS)[number];

export const CONTACT_BUSINESS_RELATIONSHIP_FAMILIES = [
  'deals',
  'tasks',
  'calendar',
  'bookings',
  'projects',
] as const;
export type ContactBusinessRelationshipFamily =
  (typeof CONTACT_BUSINESS_RELATIONSHIP_FAMILIES)[number];

/** One relationship family. `observed_count` is the complete number only when
 * coverage is `complete`; otherwise it is a lower bound backed by local rows. */
export interface ContactBusinessRelationshipSummary {
  active_count: number;
  historical_count: number;
  observed_count: number;
  coverage: ContactBusinessContextCoverage;
}

export interface ContactBusinessIdentitySummary {
  /** Contact/company truth is a locally observed projection, not a complete
   * external address book. Negative booleans must be read with this coverage. */
  coverage: ContactBusinessContextCoverage;
  /** Exact email resolved through the contact merge/alias graph. */
  resolved: boolean;
  /** Contact evidence predates the caller's `known_before_at` cutoff. This
   * avoids the current inbound message making every new sender look pre-known
   * while `as_of` remains the fresh relationship-evaluation clock. */
  known_before: boolean;
  /** User/contact-book/CRM-backed identity, rather than only a warehouse-derived
   * mail/calendar row. A confirmed or automatic platform link also qualifies. */
  authoritative: boolean;
  company_known: boolean;
  /** At least one OTHER live contact shares the exact normalized projected
   * company. This is stronger than raw email-domain equality. */
  same_company: boolean;
  same_company_contact_count: number;
  company_source?: ContactCompanySource;
}

export interface ContactBusinessContextResult {
  /** Current evaluation clock used for active/historical relationship state. */
  as_of: number;
  /** Source-event cutoff used only for the `identity.known_before` fact. */
  known_before_at: number;
  identity: ContactBusinessIdentitySummary;
  deals: ContactBusinessRelationshipSummary;
  tasks: ContactBusinessRelationshipSummary;
  calendar: ContactBusinessRelationshipSummary;
  bookings: ContactBusinessRelationshipSummary;
  projects: ContactBusinessRelationshipSummary;
  /** Mutually-exclusive strongest POSITIVE local-evidence tier. `none` means no
   * positive evidence was found; it does not claim global absence when any
   * family coverage is incomplete. Recipes score only this tier, so correlated
   * contact/company/deal/task/project facts contribute at most one vote. */
  level: ContactBusinessContextLevel;
  active_families: ContactBusinessRelationshipFamily[];
  historical_families: ContactBusinessRelationshipFamily[];
}
