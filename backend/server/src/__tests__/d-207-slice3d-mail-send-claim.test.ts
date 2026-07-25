/** D-207 slice 3d — the outbound send claim: the general no-resend fence.
 *
 *  Through a REAL SQLite database and the REAL store. Slice 1c shipped inert to
 *  production because every door test faked the one store that actually validates;
 *  the fences here ARE the storage boundary, so they are tested there.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  MAIL_SEND_CLAIM_STATUSES,
  MAIL_SENT_RECONCILIATION_MAX_WINDOW_MS,
  mailSentReconciliationQueryFor,
  type MailSentReconciliationResult,
} from '@recued/contracts';
import {
  createMailSendClaimStore,
  MailSendClaimConflictError,
  type MailSendClaimStore,
} from '../storage/mail-send-claim-store.js';

const RID = 'ord:paid-doc:sub_1:delivery';
const NOW = 1_700_000_000_000;

let db: Database.Database;
let claims: MailSendClaimStore;

const claimed = () =>
  claims.claim({
    reconciliation_id: RID,
    sender_slug: 'inbox',
    recipient: 'customer@example.com',
    subject: 'Your research brief',
    proof_kind: 'envelope',
    now: NOW,
  }).claim;

const matched = (): MailSentReconciliationResult => ({
  status: 'matched',
  match: {
    proof_kind: 'envelope',
    source_id: 'src_1',
    provider_message_id: '<abc@mail>',
    sent_at: NOW + 500,
  },
  scanned_candidates: 3,
});

beforeEach(() => {
  db = new Database(':memory:');
  claims = createMailSendClaimStore(db);
});

describe('D-207 slice 3d — the claim is what survives a crash mid-send', () => {
  it('a claim begins `claimed` — there is no way to mint one that already looks sent', () => {
    const claim = claimed();
    expect(claim.status).toBe('claimed');
    expect(claim.provider_message_id).toBeNull();
    expect(claim.sent_at).toBeNull();
    // The window opens when we CLAIMED — strictly before dispatch — so a real send
    // can never fall outside it.
    expect(claim.sent_after).toBe(NOW);
  });

  /** ⛔ `created` vs `existing` IS THE FENCE. A caller that cannot tell a FRESH claim
   *  from a RETRY has no choice but to dispatch in both cases — and dispatching on a
   *  retry is the double-send this substrate exists to prevent. */
  it('distinguishes a FRESH claim from a RETRY — the discriminator is what stops the second send', () => {
    const first = claims.claim({
      reconciliation_id: RID,
      sender_slug: 'inbox',
      recipient: 'customer@example.com',
      subject: 'Your research brief',
      proof_kind: 'envelope',
      now: NOW,
    });
    expect(first.result).toBe('created');

    const second = claims.claim({
      reconciliation_id: RID,
      sender_slug: 'inbox',
      recipient: 'customer@example.com',
      subject: 'Your research brief',
      proof_kind: 'envelope',
      now: NOW,
    });
    expect(second.result).toBe('existing');
    expect(second.claim.revision).toBe(first.claim.revision);
    expect(second.claim.created_at).toBe(first.claim.created_at);
    expect(claims.listByStatus('claimed')).toHaveLength(1);
  });

  /** ⛔ A LOUD CONFLICT, never a silent rebind. Letting a reused id describe a
   *  different message would let ONE send's provider proof settle ANOTHER send's
   *  claim — the same hazard F6 closed for duplicate checkout sessions. */
  it('⛔ REFUSES a reused id that describes a DIFFERENT message', () => {
    claimed();
    expect(() =>
      claims.claim({
        reconciliation_id: RID,
        sender_slug: 'inbox',
        recipient: 'someone-else@example.com',
        subject: 'Your research brief',
        proof_kind: 'envelope',
        now: NOW,
      }),
    ).toThrow(MailSendClaimConflictError);
  });

  it('⛔ REFUSES to settle a send that was never claimed', () => {
    expect(() =>
      claims.settle({
        reconciliation_id: 'never-claimed',
        expected_revision: 0,
        result: matched(),
        now: NOW,
      }),
    ).toThrow(/only reconcilable against the claim written before it/);
  });
});

describe('D-207 slice 3d — ⛔ NOTHING authorizes a resend, including not_found', () => {
  /** 🔴 THE INVARIANT THAT WAS EARNING ITS KEEP.
   *
   *  "Absent from the Sent folder" is NOT "not sent" — the provider may not have
   *  indexed it, the window can miss it, IMAP lags. Treating `not_found` as proof of
   *  non-delivery double-sends a customer their document. So it changes NOTHING, and
   *  the claim stays exactly where a machine must not re-send it from. */
  it.each([
    ['not_found', { status: 'not_found', scanned_candidates: 0 } as const],
    [
      'unavailable',
      { status: 'unavailable', reason: 'provider_error', scanned_candidates: 0 } as const,
    ],
  ])('%s changes NOTHING — no status move, no revision churn', (_label, result) => {
    const claim = claimed();
    const after = claims.settle({
      reconciliation_id: RID,
      expected_revision: claim.revision,
      result,
      now: NOW + 1_000,
    });

    expect(after.status).toBe('claimed');
    expect(after.revision).toBe(claim.revision);
    expect(after.provider_message_id).toBeNull();
  });

  it('a `matched` is the ONLY thing that reconciles — and it pins the provider evidence', () => {
    const claim = claimed();
    const after = claims.settle({
      reconciliation_id: RID,
      expected_revision: claim.revision,
      result: matched(),
      now: NOW + 1_000,
    });

    expect(after.status).toBe('reconciled');
    expect(after.provider_message_id).toBe('<abc@mail>');
    expect(after.sent_at).toBe(NOW + 500);
  });

  it('an `ambiguous` is an OWNER decision — never an automatic resend', () => {
    const claim = claimed();
    const after = claims.settle({
      reconciliation_id: RID,
      expected_revision: claim.revision,
      result: { status: 'ambiguous', reason: 'duplicate_header', scanned_candidates: 2 },
      now: NOW + 1_000,
    });

    expect(after.status).toBe('ambiguous');
    expect(after.ambiguity_reason).toBe('duplicate_header');
  });

  /** D-200: "later repeated ambiguity does not churn revisions". A settled claim has
   *  provider source truth behind it; nothing re-stamps it. */
  it('⛔ a SETTLED claim never moves again — no churn, no re-stamp', () => {
    const claim = claimed();
    const reconciled = claims.settle({
      reconciliation_id: RID,
      expected_revision: claim.revision,
      result: matched(),
      now: NOW + 1_000,
    });

    const again = claims.settle({
      reconciliation_id: RID,
      expected_revision: reconciled.revision,
      result: { status: 'ambiguous', reason: 'multiple_messages', scanned_candidates: 9 },
      now: NOW + 2_000,
    });

    expect(again.status).toBe('reconciled');
    expect(again.revision).toBe(reconciled.revision);
    expect(again.ambiguity_reason).toBeNull();
  });

  /** A late provider ack is WEAKER evidence than provider source truth, and must not
   *  overwrite it. */
  it('⛔ a late provider ack cannot overwrite a reconciled claim', () => {
    const claim = claimed();
    const reconciled = claims.settle({
      reconciliation_id: RID,
      expected_revision: claim.revision,
      result: matched(),
      now: NOW + 1_000,
    });

    const acked = claims.markSent({
      reconciliation_id: RID,
      expected_revision: reconciled.revision,
      provider_message_id: '<late@mail>',
      sent_at: NOW + 3_000,
      now: NOW + 3_000,
    });

    expect(acked.status).toBe('reconciled');
    expect(acked.provider_message_id).toBe('<abc@mail>');
  });

  it('⛔ the store has no way to DELETE a claim or return it to unclaimed', () => {
    // The fence is the absent method. A claim that could be withdrawn is a claim that
    // authorizes a resend, which is the one thing this substrate must never do.
    expect(Object.keys(claims).sort()).toEqual([
      'claim',
      'get',
      'listByStatus',
      'markSent',
      'settle',
    ]);
  });
});

describe('D-207 slice 3d — the recipe names an id; the SERVER names everything else', () => {
  /** ⛔ THE FENCE IS THE ABSENT FIELD. The query the provider is asked is DERIVED from
   *  the row the server wrote before dispatch. A recipe that could supply the
   *  recipient, subject or window could forge a `matched` — and a forged `matched`
   *  marks a document delivered that was never sent. */
  it('derives the whole provider query from the claim', () => {
    const claim = claimed();
    const query = mailSentReconciliationQueryFor(claim, NOW + 60_000);

    expect(query).toEqual({
      proof_kind: 'envelope',
      reconciliation_id: RID,
      recipient: 'customer@example.com',
      subject: 'Your research brief',
      sent_after: NOW,
      sent_before: NOW + 60_000,
    });
  });

  it('bounds the window — a caller cannot widen it to trawl for a match', () => {
    const claim = claimed();
    const query = mailSentReconciliationQueryFor(claim, NOW + 10 * MAIL_SENT_RECONCILIATION_MAX_WINDOW_MS);
    expect(query?.sent_before).toBe(NOW + MAIL_SENT_RECONCILIATION_MAX_WINDOW_MS);
  });

  /** An `attachment` proof with no pinned bytes is not a WEAKER proof — it is a broken
   *  one. Falling back to an envelope-only question would silently downgrade what the
   *  reconciler claims to have proven, which is the "declared but not backed" failure. */
  it('⛔ REFUSES to downgrade a broken attachment proof into an envelope question', () => {
    const broken = {
      ...claimed(),
      proof_kind: 'attachment' as const,
      attachment_sha256: null,
    };
    expect(mailSentReconciliationQueryFor(broken, NOW + 1_000)).toBeNull();
  });

  it('carries the byte proof when the claim pinned one', () => {
    const withAttachment = claims.claim({
      reconciliation_id: 'ord:x:delivery',
      sender_slug: 'inbox',
      recipient: 'customer@example.com',
      subject: 'Your brief',
      proof_kind: 'attachment',
      attachment_sha256: 'a'.repeat(64),
      attachment_size_bytes: 4_096,
      attachment_filename: 'brief.pdf',
      attachment_mime_type: 'application/pdf',
      now: NOW,
    }).claim;
    const query = mailSentReconciliationQueryFor(withAttachment, NOW + 1_000);
    expect(query).toMatchObject({
      proof_kind: 'attachment',
      attachment_sha256: 'a'.repeat(64),
      attachment_size_bytes: 4_096,
    });
  });
});

describe('D-207 slice 3d — the schema converges rather than rotting', () => {
  /** ⛔ A SQL CHECK generated from a TS const is real EXACTLY ONCE, at creation:
   *  `CREATE TABLE IF NOT EXISTS` skips an existing table and SQLite cannot ALTER a
   *  CHECK. This is the class that made slice 1c inert in production. The test pins
   *  the INVARIANT — the live table admits every member the const declares — not a
   *  literal typed next to the thing it guards. */
  it('the materialized CHECK admits every status the const declares', () => {
    const sql = (
      db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`)
        .get('mail_send_claims') as { sql: string }
    ).sql;

    for (const status of MAIL_SEND_CLAIM_STATUSES) {
      expect(sql).toContain(`'${status}'`);
    }
  });

  it('converges a table whose CHECK predates a widened const', () => {
    const stale = new Database(':memory:');
    // A live server's table, compiled from an OLDER, narrower const.
    stale.exec(`
      CREATE TABLE mail_send_claims (
        reconciliation_id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('claimed')),
        sender_slug TEXT NOT NULL,
        recipient TEXT NOT NULL, subject TEXT NOT NULL, sent_after INTEGER NOT NULL,
        proof_kind TEXT NOT NULL CHECK (proof_kind IN ('envelope','attachment')),
        attachment_sha256 TEXT, attachment_size_bytes INTEGER,
        attachment_filename TEXT, attachment_mime_type TEXT,
        provider_message_id TEXT, sent_at INTEGER, ambiguity_reason TEXT,
        revision INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      )`);

    // NON-VACUITY: the stale table genuinely cannot hold a reconciled claim yet.
    expect(() =>
      stale
        .prepare(
          `INSERT INTO mail_send_claims VALUES
             ('r','reconciled','inbox','a@b','s',1,'envelope',NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,1,1)`,
        )
        .run(),
    ).toThrow();

    const converged = createMailSendClaimStore(stale);
    const { claim } = converged.claim({
      reconciliation_id: 'r2',
      sender_slug: 'inbox',
      recipient: 'a@b',
      subject: 's',
      proof_kind: 'envelope',
      now: NOW,
    });
    // The widened member is now genuinely writable on the LIVE table.
    expect(
      converged.settle({
        reconciliation_id: 'r2',
        expected_revision: claim.revision,
        result: matched(),
        now: NOW,
      }).status,
    ).toBe('reconciled');
  });
});
