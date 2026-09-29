/** "Did this email go out?" — the owner's way out of an unresolved send claim.
 *
 *  Before this, a fenced send that never learned its outcome was refused on every
 *  retry with nothing on screen to resolve it (found on a live drive). The ask is
 *  raised through the REAL notification block the server composes (so it sits in
 *  Attention with its two answers), and the answer is dispatched to the handler
 *  that composition registers — the one this file proves settles the claim.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Checkpoint } from '@recued/contracts';
import {
  createAuditLogStore,
  createCheckpointStore,
  createInMemoryCollection,
  type ActivityEntry,
  type AuditEntry,
} from '@recued/storage';

import { composeNotificationBlock } from '../composition/bin/wire-notification-block.js';
import type { EventBus } from '../events/bus.js';
import {
  MAIL_SEND_ATTEMPT_MAX_MS,
  MAIL_SEND_OUTCOME_ASK_KIND,
  raiseMailSendOutcomeAsk,
} from '../mail-send-outcome-ask.js';
import { createAnnotationStore } from '../storage/annotation-store.js';
import { createBlobStore } from '../storage/blob-store.js';
import {
  createMailSendClaimStore,
  type MailSendClaimStore,
} from '../storage/mail-send-claim-store.js';
import { ensureSourceDependencyEntitySchema } from '../storage/source-dependency-entity-store.js';

const RID = 'meeting-secretary.abc123';
const NOW = Date.parse('2026-09-28T10:00:00.000Z');

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

const setup = () => {
  const db = new Database(':memory:');
  cleanups.push(() => db.close());
  ensureSourceDependencyEntitySchema(db);
  const dir = mkdtempSync(join(tmpdir(), 'mail-send-outcome-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const { block } = composeNotificationBlock({
    db,
    auditLog: createAuditLogStore(
      createInMemoryCollection<AuditEntry>(),
      createInMemoryCollection<ActivityEntry>(),
    ),
    checkpointStore: createCheckpointStore(createInMemoryCollection<Checkpoint>()),
    annotationStore: createAnnotationStore({
      db,
      blobs: createBlobStore(join(dir, 'blobs')),
      now: () => NOW,
      newId: () => 'annotation-1',
    }),
    eventBus: {
      cursor: vi.fn(() => 0),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      emit: vi.fn((event) => ({ cursor: 1, ...event })),
      replay: vi.fn(() => []),
      subscriberCount: vi.fn(() => 0),
    } as unknown as EventBus,
    getExecuteDeps: () => undefined,
  });
  const claims = createMailSendClaimStore(db);
  return { block, claims };
};

/** An attempt that ENDED without learning whether it went out. */
const unknownAttempt = (claims: MailSendClaimStore) => {
  const { claim } = claims.claim({
    reconciliation_id: RID,
    sender_slug: 'bench-mail',
    recipient: 'dana@northwind.example',
    subject: 'Minutes — Harbour fit-out',
    proof_kind: 'envelope',
    now: NOW,
  });
  return claims.markUnknown({ reconciliation_id: RID, expected_revision: claim.revision, now: NOW + 1_000 });
};

const retry = (claims: MailSendClaimStore) => claims.claim({
  reconciliation_id: RID,
  sender_slug: 'bench-mail',
  recipient: 'dana@northwind.example',
  subject: 'Minutes — Harbour fit-out',
  proof_kind: 'envelope',
  now: NOW + 60_000,
});

describe('"Did this email go out?"', () => {
  it('is asked in Attention with the message and its two answers', async () => {
    const { block, claims } = setup();
    unknownAttempt(claims);

    expect(await raiseMailSendOutcomeAsk({
      notifier: block, claims, reconciliation_id: RID, now: NOW + 2_000,
    })).toBe(true);

    const open = await block.listOpenAsks();
    expect(open).toHaveLength(1);
    const ask = open[0]!;
    expect(ask.handler_kind).toBe(MAIL_SEND_OUTCOME_ASK_KIND);
    expect(ask.message.title).toBe('Did this email go out?');
    expect(ask.message.text).toContain('“Minutes — Harbour fit-out”');
    expect(ask.message.text).toContain('dana@northwind.example');
    expect(ask.options.map((o) => o.label)).toEqual([
      'It went out',
      'It did not — send it next time',
    ]);
  });

  it('is asked once per claim, however many retries run into it', async () => {
    const { block, claims } = setup();
    unknownAttempt(claims);
    for (let i = 0; i < 3; i += 1) {
      await raiseMailSendOutcomeAsk({ notifier: block, claims, reconciliation_id: RID, now: NOW + 2_000 });
    }
    expect(await block.listOpenAsks()).toHaveLength(1);
  });

  it('"It did not" lets the next run send it; the answer itself sends nothing', async () => {
    const { block, claims } = setup();
    unknownAttempt(claims);
    await raiseMailSendOutcomeAsk({ notifier: block, claims, reconciliation_id: RID, now: NOW + 2_000 });
    // NON-VACUITY: before the answer, a retry is refused.
    expect(retry(claims).result).toBe('existing');

    const ask = (await block.listOpenAsks())[0]!;
    await block.submitAnswer({ ask_id: ask.ask_id, option: 'not_sent', via: 'ui' });

    expect(claims.get(RID)?.status).toBe('released');
    expect(retry(claims)).toMatchObject({ result: 'created', claim: { status: 'claimed' } });
  });

  it('"It went out" makes a retry report it as already sent', async () => {
    const { block, claims } = setup();
    unknownAttempt(claims);
    await raiseMailSendOutcomeAsk({ notifier: block, claims, reconciliation_id: RID, now: NOW + 2_000 });
    const ask = (await block.listOpenAsks())[0]!;
    await block.submitAnswer({ ask_id: ask.ask_id, option: 'went_out', via: 'ui' });

    expect(claims.get(RID)?.status).toBe('confirmed');
    expect(retry(claims)).toMatchObject({ result: 'existing', claim: { status: 'confirmed' } });
  });

  it('an answer that arrives after the provider proved it changes nothing', async () => {
    const { block, claims } = setup();
    const unknown = unknownAttempt(claims);
    await raiseMailSendOutcomeAsk({ notifier: block, claims, reconciliation_id: RID, now: NOW + 2_000 });
    claims.settle({
      reconciliation_id: RID,
      expected_revision: unknown.revision,
      result: {
        status: 'matched',
        match: { proof_kind: 'envelope', source_id: 's', provider_message_id: '<m@x>', sent_at: NOW + 500 },
        scanned_candidates: 1,
      },
      now: NOW + 3_000,
    });

    const ask = (await block.listOpenAsks())[0]!;
    await block.submitAnswer({ ask_id: ask.ask_id, option: 'not_sent', via: 'ui' });
    expect(claims.get(RID)?.status).toBe('reconciled');
  });

  it('is not asked about an attempt still in flight — only once it has been gone too long', async () => {
    const { block, claims } = setup();
    claims.claim({
      reconciliation_id: RID,
      sender_slug: 'bench-mail',
      recipient: 'dana@northwind.example',
      subject: 'Minutes — Harbour fit-out',
      proof_kind: 'envelope',
      now: NOW,
    });
    expect(await raiseMailSendOutcomeAsk({
      notifier: block, claims, reconciliation_id: RID, now: NOW + 60_000,
    })).toBe(false);
    expect(await block.listOpenAsks()).toHaveLength(0);

    // A `claimed` older than any send can take was left behind by a crash.
    expect(await raiseMailSendOutcomeAsk({
      notifier: block, claims, reconciliation_id: RID, now: NOW + MAIL_SEND_ATTEMPT_MAX_MS + 1,
    })).toBe(true);
    expect(await block.listOpenAsks()).toHaveLength(1);
  });

  it('is not asked about a send that went out, or one that provably never left', async () => {
    const { block, claims } = setup();
    const { claim } = claims.claim({
      reconciliation_id: RID,
      sender_slug: 'bench-mail',
      recipient: 'dana@northwind.example',
      subject: 'Minutes — Harbour fit-out',
      proof_kind: 'envelope',
      now: NOW,
    });
    claims.markNotSent({ reconciliation_id: RID, expected_revision: claim.revision, now: NOW + 1 });
    expect(await raiseMailSendOutcomeAsk({
      notifier: block, claims, reconciliation_id: RID, now: NOW + 2_000,
    })).toBe(false);
    expect(await block.listOpenAsks()).toHaveLength(0);
  });
});
