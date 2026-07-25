/** D-139 P4 — `multi_account_contact` deterministic producer.
 *
 *  Contact-scoped (perspective) — the contact's professional mail
 *  domain ≠ CRM company affiliation domain. Likely job-change /
 *  reactivation lead.
 *
 *  Pass-4 evidence-quality consumption defaults baked in: the
 *  signal is itself a stable-truth-flavored snapshot (modeled as
 *  `time_bound` per D-136 substrate), so per-event filtering
 *  doesn't apply — caller projects the contact's canonical mail
 *  domain + CRM company affiliation domains and the producer is
 *  pure compute on those.
 *
 *  Free-mail exclusion list — generic personal-mail providers
 *  NEVER count as "professional" mail domains. A contact emailing
 *  from `gmail.com` doesn't indicate a job change; we'd need a
 *  professional domain to flag the mismatch. The exclusion list
 *  closed at v1; add domains via PR + benchmark fixture coverage.
 *
 *  Algorithm:
 *    1. Parse the contact's mail domain from `mail_evidence`
 *       (caller-supplied). If domain matches a free-mail provider
 *       OR is empty → return `is_multi_account = false` with
 *       `mail_domain = null`.
 *    2. Compare canonical (lowercased + trimmed) mail domain
 *       against each CRM company domain.
 *    3. Empty CRM-domain set → `is_multi_account = false`
 *       (insufficient signal).
 *    4. Match found → `is_multi_account = false` (the contact's
 *       mail domain matches a CRM affiliation; no job change).
 *    5. No match → `is_multi_account = true`.
 *
 *  Spec: D-139 § A.9.2b + § P4 acceptance. */

import {
  type CoverageMetadata,
  type MultiAccountContactValue,
} from '@recued/contracts';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

/** Closed list of free-mail provider domains. A contact emailing
 *  from any of these is treated as having no professional mail
 *  domain — mismatch detection requires a professional domain.
 *  Lowercase, no leading dot. */
export const MULTI_ACCOUNT_FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'yahoo.co.uk',
  'aol.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'protonmail.com',
  'pm.me',
  'proton.me',
  'fastmail.com',
  'gmx.com',
  'gmx.de',
  'gmx.net',
  'mail.com',
  'zoho.com',
  'tutanota.com',
  'duck.com',
  'qq.com',
  '163.com',
  '126.com',
]);

// ────────────────────────────────────────────────────────────────
// Producer-supplied evidence shapes
// ────────────────────────────────────────────────────────────────

/** Producer input. Caller projects from `data.mail` rows + CRM
 *  contact records. */
export interface MultiAccountContactInput {
  /** Contact's most-recent mail-from-them domain (substrate-side
   *  resolved by walking `data.mail` rows where `from_email` is
   *  the contact's canonical email; pick the latest mail's
   *  domain). `null` when the contact has no mail-from-them in
   *  `data.mail`. */
  mail_from_domain: string | null;
  /** CRM company-affiliation domains (lowercased + trimmed)
   *  pulled from the contact's primary affiliation across vendors:
   *    HubSpot: associatedcompanyid → company.domain
   *    Salesforce: AccountId → Account.Website (parsed for host)
   *  Empty when no affiliated company has a domain set. */
  crm_company_domains: ReadonlyArray<string>;
  /** Contact's CRM record vendor_modified_at(s) folded for
   *  cursor advancement. */
  crm_vendor_modified_at: number;
  /** Mail evidence vendor_modified_at — the latest `data.mail`
   *  row's `vendor_modified_at` from the walk that resolved
   *  `mail_from_domain`. `0` when the contact has no mail
   *  evidence. Codex P1 #6 fold — registry's `aggregates_from`
   *  includes `mail` so cursor must fold both source surfaces
   *  per the spec contract "max source vendor_modified_at folded";
   *  pre-fold the producer ignored mail-side ingestion progress. */
  mail_vendor_modified_at: number;
  /** Caller-supplied coverage signals; pass through unchanged. */
  coverage: CoverageMetadata;
  /** Wall-clock now() in unix-ms UTC. */
  now: number;
}

export interface MultiAccountContactProducerOutput {
  value: MultiAccountContactValue;
  coverage: CoverageMetadata;
}

// ────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────

/** Canonicalise a domain — lowercased, trimmed, leading `www.`
 *  stripped. Empty / nullish → empty string. */
export const canonicaliseDomain = (raw: string | null | undefined): string => {
  if (typeof raw !== 'string') return '';
  let v = raw.trim().toLowerCase();
  if (v.startsWith('www.')) v = v.slice(4);
  return v;
};

/** True when the domain is a generic free-mail provider per the
 *  closed exclusion list. */
export const isFreeMailDomain = (domain: string): boolean =>
  MULTI_ACCOUNT_FREE_MAIL_DOMAINS.has(domain);

// ────────────────────────────────────────────────────────────────
// Producer entry point
// ────────────────────────────────────────────────────────────────

export const computeMultiAccountContact = (
  input: MultiAccountContactInput,
): MultiAccountContactProducerOutput => {
  const mail_domain_raw = canonicaliseDomain(input.mail_from_domain);
  const mail_domain = mail_domain_raw.length > 0 && !isFreeMailDomain(mail_domain_raw)
    ? mail_domain_raw
    : null;

  const crm_company_domains = input.crm_company_domains
    .map(canonicaliseDomain)
    .filter((d) => d.length > 0);

  let is_multi_account = false;

  if (mail_domain !== null && crm_company_domains.length > 0) {
    // Multi-account when no CRM-affiliated domain matches the
    // contact's professional mail domain.
    is_multi_account = !crm_company_domains.some((d) => d === mail_domain);
  }

  // Cursor — fold across both source surfaces (CRM contact record
  // + mail evidence) per Codex P1 #6 fold. Both contribute to the
  // signal: CRM record changes shift the affiliation-domain set;
  // mail-side evidence shifts the mail_from_domain. The cursor
  // must reflect the latest source change so cascade detects new
  // mail evidence as well as new CRM record updates.
  const cursor_at = Math.max(input.crm_vendor_modified_at, input.mail_vendor_modified_at);

  const value: MultiAccountContactValue = {
    is_multi_account,
    mail_domain,
    crm_company_domains,
    cursor_at,
  };

  return { value, coverage: input.coverage };
};
