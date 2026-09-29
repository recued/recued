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
import { IngredientError } from '@recued/ingredients';

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
    // `unknown`, not `claimed`: the attempt has ENDED (so the owner may be asked),
    // it just never learned how.
    expect(claim).not.toBeNull();
    expect(claim?.status).toBe('unknown');
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
   *  might never send. Neither is safe to GUESS — so we refuse, and the owner is the
   *  one asked (`mail-send-outcome-ask.ts`). */
  it('⛔ REFUSES to retry an `unknown` outcome — and says the owner has been asked', async () => {
    const failing = vi.fn(async () => {
      throw new Error('smtp timeout');
    });
    await expect(mailWith(failing).send(args() as never)).rejects.toThrow(/smtp timeout/);
    expect(createMailSendClaimStore(db).get(RID)?.status).toBe('unknown');

    const retry = okSend();
    const refused = await mailWith(retry).send(args() as never).then(
      () => { throw new Error('expected a refusal'); },
      (err: unknown) => err as { code?: string; message?: string },
    );
    expect(refused.code).toBe('MAIL_SEND_CLAIM_UNRESOLVED');
    expect(refused.message).toContain('customer@example.com');
    expect(refused.message).toContain('asked you whether it went out');
    expect(retry).not.toHaveBeenCalled();
  });

  /** A claim still `claimed` and fresh is an attempt IN FLIGHT (or one that crashed
   *  moments ago). Nobody should be asked about it yet — and the refusal must not
   *  pretend they were. */
  it('a retry that meets an attempt still in flight says so, and claims no question was asked', async () => {
    const claims = createMailSendClaimStore(db);
    claims.claim({
      reconciliation_id: RID,
      sender_slug: 'inbox',
      recipient: 'customer@example.com',
      subject: 'Your research brief',
      proof_kind: 'envelope',
      now: Date.now(),
    });

    const retry = okSend();
    const refused = await mailWith(retry).send(args() as never).then(
      () => { throw new Error('expected a refusal'); },
      (err: unknown) => err as { code?: string; message?: string },
    );
    expect(refused.code).toBe('MAIL_SEND_CLAIM_UNRESOLVED');
    expect(refused.message).toContain('started moments ago');
    expect(refused.message).not.toContain('asked you');
    expect(retry).not.toHaveBeenCalled();
  });

  /** 🔴 FOUND LIVE: a send that never got off the machine (the transport could not
   *  even be built) left its claim unresolved, and every retry of that exact message
   *  was refused — forever. A provider that PROVES the message never reached it
   *  (`details.not_sent`) ends the claim `not_sent`, and the retry simply sends. */
  it('a send the provider PROVES never left ends `not_sent` — and the retry sends it', async () => {
    const neverLeft = vi.fn(async () => {
      throw new IngredientError('MAIL_SEND_NETWORK_FAILED', 'SMTP submission could not start: require is not defined', {
        kind: 'imap', slug: 'inbox', not_sent: true,
      });
    });
    await expect(mailWith(neverLeft).send(args() as never)).rejects.toMatchObject({
      code: 'MAIL_SEND_NETWORK_FAILED',
    });
    expect(createMailSendClaimStore(db).get(RID)?.status).toBe('not_sent');

    const retry = okSend();
    const result = await mailWith(retry).send(args() as never);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(result.already_sent).toBeUndefined();
    const claim = createMailSendClaimStore(db).get(RID);
    expect(claim?.status).toBe('sent');
    expect(claim?.provider_message_id).toBe('<abc@mail>');
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
