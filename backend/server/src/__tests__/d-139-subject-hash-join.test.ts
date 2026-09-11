/** D-139 § A.9.2b — the mail ↔ CRM subject join key.
 *
 *  ## What was broken
 *
 *  `out_of_band_engagement`'s quadruple fallback matches a local mail against
 *  a CRM email engagement on `(from_email, first recipient, sent_at
 *  ±tolerance, subject_hash)`. `matchesCrmQuadruple` reads `meta.subject_hash`
 *  — and until this change NOTHING WROTE THAT FIELD. A whole-repo sweep found
 *  `subject_hash` in exactly three places: the kernel, the kernel's own tests,
 *  and the decisions-log describing the intent.
 *
 *  So the matcher returned false on every real row, and its unit tests passed
 *  because each HAND-BUILT the meta containing the field the substrate never
 *  produced. The consequence was not a dead feature but a wrong one: with the
 *  fallback permanently false, every mail the Message-ID path missed would be
 *  counted as a CRM visibility gap — telling the owner their CRM is missing
 *  work that is actually in it.
 *
 *  ## What these assertions are for
 *
 *  ⛔ The join is only a join if BOTH sides compute the same key. That is the
 *  property the unit tests of either side individually cannot see, and it is
 *  the one asserted here: the two vendor reconcilers and the mail side all go
 *  through `engagementSubjectHash`, and a row projected by a reconciler
 *  actually satisfies `matchesCrmQuadruple` against the mail it came from. */

import { describe, expect, it } from 'vitest';

import { engagementSubjectHash, type EngagementRow } from '@recued/contracts';
import { projectEmailEngagementRow } from '../data/hubspot/email-engagement-reconciler.js';
import { projectEmailMessageEngagementRow } from '../data/salesforce/email-message-engagement-reconciler.js';
import {
  buildCrmMessageIdIndex,
  matchesCrmQuadruple,
  type OutOfBandMailRow,
} from '../housekeeping/engagement-aggregates/out-of-band-engagement.js';

const SENT_AT = 1_714_867_200_000;

describe('engagementSubjectHash — the canonical key', () => {
  it('is stable and hex', () => {
    const a = engagementSubjectHash('Q4 planning');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(engagementSubjectHash('Q4 planning')).toBe(a);
  });

  it('normalises case and surrounding / internal whitespace', () => {
    const base = engagementSubjectHash('Q4 planning');
    expect(engagementSubjectHash('  Q4 Planning  ')).toBe(base);
    expect(engagementSubjectHash('Q4    planning')).toBe(base);
    expect(engagementSubjectHash('Q4\tplanning')).toBe(base);
  });

  it('does NOT strip Re:/Fwd: — over-matching would suppress a real alert', () => {
    // ⛔ Deliberate. The same message logged into a CRM and received in a
    // mailbox carries the SAME prefix, so stripping buys nothing on the
    // matching case, while collapsing "Re: Q4 plans" into "Q4 plans" would
    // make two different messages match — and a false match SUPPRESSES a
    // visibility-gap alert. Under-matching is recoverable via Message-ID;
    // over-matching is silent.
    expect(engagementSubjectHash('Re: Q4 planning'))
      .not.toBe(engagementSubjectHash('Q4 planning'));
  });

  it('an absent or empty subject is null, not the hash of ""', () => {
    // Otherwise every subject-less row would match every other subject-less
    // row, which is the same over-matching failure by another route.
    expect(engagementSubjectHash(null)).toBeNull();
    expect(engagementSubjectHash(undefined)).toBeNull();
    expect(engagementSubjectHash('')).toBeNull();
    expect(engagementSubjectHash('   ')).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// The join itself — a reconciler-shaped row against a mail-shaped row.
// ────────────────────────────────────────────────────────────────

const mail = (over: Partial<OutOfBandMailRow> = {}): OutOfBandMailRow => ({
  message_id: 'mid-local',
  from_email: 'rep@recued.com',
  to_emails: ['buyer@acme.com'],
  subject_hash: engagementSubjectHash('Q4 planning')!,
  sent_at: SENT_AT,
  vendor_modified_at: SENT_AT,
  ...over,
});

/** A CRM row carrying the meta a reconciler NOW projects. The subject_hash
 *  is computed by the same exported function the reconcilers call — not
 *  hand-written — so this fixture cannot drift from production the way the
 *  original ones did. */
const crmRow = (subject: string, over: Partial<EngagementRow> = {}): EngagementRow => ({
  connection_id: 'acme-hubspot',
  target_id: 'hubspot_email_1',
  vendor: 'hubspot',
  entity: 'email',
  meta: {
    from_email: 'rep@recued.com',
    to_emails: ['buyer@acme.com'],
    subject: subject,
    subject_hash: engagementSubjectHash(subject),
    timestamp: SENT_AT,
  },
  mirror_blob_hash: null,
  authorship: 'user',
  direction: 'outbound',
  dedupe_confidence: 'none',
  lifecycle_state: 'completed',
  event_at: SENT_AT,
  vendor_created_at: SENT_AT,
  vendor_modified_at: SENT_AT,
  ingested_at: SENT_AT,
  body_state: 'none',
  ...over,
});

describe('D-139 § A.9.2b — the quadruple fallback actually joins now', () => {
  it('a reconciler-projected row matches the mail it came from', () => {
    expect(matchesCrmQuadruple(mail(), crmRow('Q4 planning'))).toBe(true);
  });

  it('matches across trivial subject formatting differences', () => {
    // The CRM stored the subject with different casing/spacing than the
    // mailbox did. Same message; the canonical key absorbs it.
    expect(matchesCrmQuadruple(mail(), crmRow('  q4   PLANNING '))).toBe(true);
  });

  it('a genuinely different subject does NOT match', () => {
    expect(matchesCrmQuadruple(mail(), crmRow('Renewal terms'))).toBe(false);
  });

  it('⛔ REGRESSION GUARD: a row with NO subject_hash cannot match', () => {
    // This is the shape every real CRM row had before this change, and the
    // reason the fallback was dead. If a future edit drops the projection,
    // this goes red rather than the producer quietly over-reporting.
    const noHash = crmRow('Q4 planning');
    delete (noHash.meta as Record<string, unknown>).subject_hash;
    expect(matchesCrmQuadruple(mail(), noHash)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// ⛔ THE ASSERTION THAT ACTUALLY COVERS THE FIX.
//
// Everything above still builds its CRM meta in the test file — better than a
// hand-written literal, because it calls the shared function, but it STILL
// does not prove a reconciler projects the field. That gap is precisely what
// let the fallback sit dead behind eight green unit tests. So these drive the
// REAL projection functions and read the meta they produce.
// ────────────────────────────────────────────────────────────────

describe('D-139 § A.9.2b — the reconcilers actually project subject_hash', () => {
  const SUBJECT = 'Q4 planning';

  it('HubSpot: projectEmailEngagementRow stamps the canonical key', () => {
    const row = projectEmailEngagementRow('acme-hubspot', {
      id: '47291',
      properties: {
        hs_email_subject: SUBJECT,
        hs_email_direction: 'EMAIL',
        hs_email_status: 'SENT',
        hs_email_from_email: 'rep@recued.com',
        hs_email_to_email: 'buyer@acme.com',
        hs_timestamp: String(SENT_AT),
        hs_email_internet_message_id: 'mid-crm',
      },
    } as never, { now: SENT_AT });

    const meta = row.meta as { subject_hash?: unknown };
    expect(meta.subject_hash, 'HubSpot row carries no subject_hash — the fallback is dead again')
      .toBe(engagementSubjectHash(SUBJECT));
  });

  it('Salesforce: projectEmailMessageEngagementRow stamps the SAME key', () => {
    const row = projectEmailMessageEngagementRow('acme-sf', {
      Id: 'EM1',
      Subject: SUBJECT,
      FromAddress: 'rep@recued.com',
      ToAddress: 'buyer@acme.com',
      MessageDate: new Date(SENT_AT).toISOString(),
      CreatedDate: new Date(SENT_AT).toISOString(),
      LastModifiedDate: new Date(SENT_AT).toISOString(),
    } as never, { now: SENT_AT, authorship: {} as never });

    const meta = row.meta as { subject_hash?: unknown };
    // 🔑 Byte-identical to HubSpot's. The matcher is vendor-agnostic, so a
    // per-vendor key would mean the fallback works on one CRM and not the
    // other — the kind of asymmetry that reads as "flaky matching".
    expect(meta.subject_hash).toBe(engagementSubjectHash(SUBJECT));
  });

  it('a HubSpot row with no subject carries no hash, and cannot match', () => {
    const row = projectEmailEngagementRow('acme-hubspot', {
      id: '47292',
      properties: {
        hs_email_direction: 'EMAIL', hs_email_status: 'SENT',
        hs_email_from_email: 'rep@recued.com', hs_email_to_email: 'buyer@acme.com',
        hs_timestamp: String(SENT_AT),
      },
    } as never, { now: SENT_AT });

    expect((row.meta as { subject_hash?: unknown }).subject_hash).toBeUndefined();
    expect(matchesCrmQuadruple(mail(), row)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// The OTHER join in the same producer, and the same asymmetry.
// ────────────────────────────────────────────────────────────────

describe('D-139 § A.9.2b — Message-ID matches across the two spellings', () => {
  it('a bracketed CRM header indexes to the same key as a stripped mail id', () => {
    // ⛔ CRM ingest stores the header VERBATIM (`<abc@host>` for most
    // providers); `data.mail` stores `rfc_message_id` already stripped by
    // `normalizeRfcMessageId`. Indexing the raw string against a stripped one
    // means the exact-match path never fires for any bracketing provider —
    // and every one of those mails then falls through to the fallback, or,
    // before the fallback had a key at all, straight to "out of band".
    const row = crmRow('Q4 planning', {
      meta: {
        from_email: 'rep@recued.com',
        to_emails: ['buyer@acme.com'],
        subject_hash: engagementSubjectHash('Q4 planning'),
        timestamp: SENT_AT,
        message_id: '<abc@host>',
      },
    });
    const idx = buildCrmMessageIdIndex([row]);
    expect(idx.has('abc@host'), 'bracketed CRM id did not normalise').toBe(true);
  });

  it('an unbracketed CRM header still indexes unchanged', () => {
    const row = crmRow('Q4 planning', {
      meta: {
        from_email: 'rep@recued.com', to_emails: ['buyer@acme.com'],
        subject_hash: engagementSubjectHash('Q4 planning'),
        timestamp: SENT_AT, message_id: 'abc@host',
      },
    });
    expect(buildCrmMessageIdIndex([row]).has('abc@host')).toBe(true);
  });

  it('an inbound CRM row is never indexed — it must not suppress an outbound gap', () => {
    const row = crmRow('Q4 planning', {
      direction: 'inbound',
      meta: { message_id: '<abc@host>' },
    });
    expect(buildCrmMessageIdIndex([row]).size).toBe(0);
  });
});
