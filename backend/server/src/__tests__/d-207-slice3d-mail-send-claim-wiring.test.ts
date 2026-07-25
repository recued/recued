/** D-207 slice 3d — `mail-send` writes the claim BEFORE it dispatches.
 *
 *  ## The ordering IS the fence
 *
 *  A claim written AFTER a successful send would be worthless: the case it exists for
 *  is precisely the one where we never get to "after". A crash — or a network timeout
 *  — between the decision to send and the provider's acknowledgement leaves us unable
 *  to know whether the message went out, and the claim is the only thing that survives
 *  to be asked about later.
 *
 *  ⚠ The subtlest case, and the one this suite exists for: a `provider.send` that
 *  THROWS does not mean the mail did not go. An SMTP timeout after the server accepted
 *  the message is an error to us and a delivered mail to the customer. So the claim
 *  must SURVIVE the throw — withdrawing it would let a retry double-send, which is the
 *  exact bug the substrate exists to prevent.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { createBlobStore } from '../storage/blob-store.js';
import { createMailCollection } from '../collections/mail/mail-collection.js';
import { createMailSendClaimStore } from '../storage/mail-send-claim-store.js';

const RID = 'ord:paid-doc:sub_1:delivery';

let db: Database.Database;
let blobsDir: string;

const stubProvider = (send: ReturnType<typeof vi.fn>) =>
  ({
    kind: 'imap',
    sendCapable: true,
    accountEmail: 'owner@example.com',
    send,
    initialScan: async () => {},
    poll: async () => {},
    stop: async () => {},
  }) as never;

const mailWith = (send: ReturnType<typeof vi.fn>) =>
  createMailCollection({
    db,
    blobs: createBlobStore(blobsDir),
    gate: { addUsed: () => {}, getUsed: () => 0 } as never,
    bus: createWarehouseEventBus(),
    slug: 'inbox',
    provider: stubProvider(send),
    config: () => ({ backfill_days: 30, retention_days: 365, quota_bytes: 1024 * 1024 }),
  });

const okSend = () =>
  vi.fn(async () => ({
    source_id: 'src_1',
    message_id: '<abc@mail>',
    sent_at: 1_700_000_000_500,
    thread_id: 't1',
  }));

const args = (overrides: Record<string, unknown> = {}) => ({
  to: ['customer@example.com'],
  subject: 'Your research brief',
  body_text: 'Attached.',
  reconciliation_id: RID,
  ...overrides,
});

beforeEach(() => {
  db = new Database(':memory:');
  blobsDir = mkdtempSync(join(tmpdir(), 'd207-3d-'));
});

afterEach(() => {
  rmSync(blobsDir, { recursive: true, force: true });
});

describe('D-207 slice 3d — the claim is written BEFORE the provider is called', () => {
  /** 🔴 THE LOAD-BEARING CASE. The send blows up, and the claim is STILL THERE — which
   *  is the only reason a later reconcile can ask "did that actually go out?" rather
   *  than blindly re-sending a document a customer may already be holding. */
  it('⛔ a send that THROWS leaves the claim standing — a throw is not proof of non-delivery', async () => {
    const send = vi.fn(async () => {
      throw new Error('smtp timeout');
    });
    const mail = mailWith(send);

    await expect(mail.send(args() as never)).rejects.toThrow(/smtp timeout/);

    const claims = createMailSendClaimStore(db);
    const claim = claims.get(RID);

    // NON-VACUITY: the claim genuinely exists, and it is not settled — so a machine
    // must not re-send from it, and a reconciler still has something to ask about.
    expect(claim).not.toBeNull();
    expect(claim?.status).toBe('claimed');
    expect(claim?.recipient).toBe('customer@example.com');
    expect(claim?.subject).toBe('Your research brief');
    expect(claim?.provider_message_id).toBeNull();
  });

  it('the claim exists BEFORE the provider is reached — proven by ordering, not by outcome', async () => {
    const seen: string[] = [];
    const send = vi.fn(async () => {
      // The provider can already see its own claim: it was durable before we got here.
      seen.push(createMailSendClaimStore(db).get(RID) === null ? 'absent' : 'present');
      return {
        source_id: 'src_1',
        message_id: '<abc@mail>',
        sent_at: 1_700_000_000_500,
      };
    });

    await mailWith(send).send(args() as never);
    expect(seen).toEqual(['present']);
  });

  it('a provider ack moves the claim to `sent` — not to a settled state, because an ack can be lost', async () => {
    const send = okSend();
    await mailWith(send).send(args() as never);

    const claim = createMailSendClaimStore(db).get(RID);
    expect(claim?.status).toBe('sent');
    expect(claim?.provider_message_id).toBe('<abc@mail>');
    expect(claim?.sent_at).toBe(1_700_000_000_500);
  });

  it('no reconciliation_id ⇒ no claim — an ordinary send does not pay for a fence it did not ask for', async () => {
    const send = okSend();
    await mailWith(send).send({ ...args(), reconciliation_id: undefined } as never);

    expect(createMailSendClaimStore(db).listByStatus('claimed')).toHaveLength(0);
    expect(createMailSendClaimStore(db).listByStatus('sent')).toHaveLength(0);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('D-207 slice 3d — 🔴 THE DOUBLE-SEND: a pre-existing claim NEVER dispatches again', () => {
  /** 🔴 THIS WAS A REAL HOLE IN THE FIRST CUT OF THIS WIRING, and it is worth naming
   *  because it is the bug the whole substrate exists to prevent, sitting INSIDE the
   *  substrate. The code short-circuited only on `reconciled` — so a retry against a
   *  claim at `sent` (the provider ACKNOWLEDGED; the mail went out) sailed straight
   *  past and sent it a second time.
   *
   *  `created` is the ONLY state in which nobody has yet attempted this message. Every
   *  other state is a reason not to dispatch. */
  it('⛔ NEVER re-dispatches a claim at `sent` — the provider already acknowledged it', async () => {
    const first = okSend();
    await mailWith(first).send(args() as never);
    expect(createMailSendClaimStore(db).get(RID)?.status).toBe('sent');

    const second = okSend();
    const result = await mailWith(second).send(args() as never);

    expect(second).not.toHaveBeenCalled();
    expect(result.already_sent).toBe(true);
    expect(result.message_id).toBe('<abc@mail>');
  });

  /** The genuinely unknown case. We tried; we never learned the outcome. Re-sending
   *  might double-send (the timeout may have been an ACCEPTED message); not re-sending
   *  might never send. Neither is safe to GUESS — so we refuse and name the op that
   *  can actually answer it. */
  it('⛔ REFUSES to retry an unresolved `claimed` — it points at reconcile instead of guessing', async () => {
    const failing = vi.fn(async () => {
      throw new Error('smtp timeout');
    });
    await expect(mailWith(failing).send(args() as never)).rejects.toThrow(/smtp timeout/);
    expect(createMailSendClaimStore(db).get(RID)?.status).toBe('claimed');

    const retry = okSend();
    await expect(mailWith(retry).send(args() as never)).rejects.toMatchObject({
      code: 'MAIL_SEND_CLAIM_UNRESOLVED',
    });
    expect(retry).not.toHaveBeenCalled();
  });

  it('⛔ REFUSES to retry an `ambiguous` claim — that one needs a human, not a reconcile', async () => {
    const send = okSend();
    await mailWith(send).send(args() as never);

    const claims = createMailSendClaimStore(db);
    const sent = claims.get(RID);
    claims.settle({
      reconciliation_id: RID,
      expected_revision: sent!.revision,
      result: { status: 'ambiguous', reason: 'duplicate_header', scanned_candidates: 2 },
      now: 1_700_000_001_000,
    });

    const retry = okSend();
    await expect(mailWith(retry).send(args() as never)).rejects.toMatchObject({
      code: 'MAIL_SEND_CLAIM_UNRESOLVED',
    });
    expect(retry).not.toHaveBeenCalled();
  });
});

describe('D-207 slice 3d — a reconciled claim makes mail-send IDEMPOTENT', () => {
  /** The message is PROVEN sent by provider source truth. Re-sending it is the one
   *  thing this substrate exists to prevent — so the provider is never reached. */
  it('⛔ NEVER dispatches again once the claim is reconciled', async () => {
    const first = okSend();
    await mailWith(first).send(args() as never);

    // Provider source truth settles it.
    const claims = createMailSendClaimStore(db);
    const sent = claims.get(RID);
    claims.settle({
      reconciliation_id: RID,
      expected_revision: sent!.revision,
      result: {
        status: 'matched',
        match: {
          proof_kind: 'envelope',
          source_id: 'src_1',
          provider_message_id: '<abc@mail>',
          sent_at: 1_700_000_000_500,
        },
        scanned_candidates: 1,
      },
      now: 1_700_000_001_000,
    });

    const second = okSend();
    const result = await mailWith(second).send(args() as never);

    expect(second).not.toHaveBeenCalled();
    expect(result.already_sent).toBe(true);
    expect(result.message_id).toBe('<abc@mail>');
  });
});

describe('D-207 slice 3d — refuse rather than under-prove', () => {
  /** ⛔ The reconciliation query matches ONE recipient envelope. A fan-out send cannot
   *  be proven by it. Claiming on `to[0]` and later calling the result "reconciled"
   *  would silently downgrade what we assert to have proven — the declared-but-not-
   *  backed failure, on a fence whose whole job is to be believed. */
  it.each([
    ['two `to` recipients', { to: ['a@x.com', 'b@x.com'] }],
    ['a cc alongside the to', { to: ['a@x.com'], cc: ['b@x.com'] }],
    ['a bcc alongside the to', { to: ['a@x.com'], bcc: ['b@x.com'] }],
  ])('⛔ REFUSES a reconciliation_id on %s', async (_label, recipients) => {
    const send = okSend();

    await expect(
      mailWith(send).send(args(recipients) as never),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });

    // Refused BEFORE dispatch, and no half-formed claim left behind.
    expect(send).not.toHaveBeenCalled();
    expect(createMailSendClaimStore(db).get(RID)).toBeNull();
  });
});
