/** D-167 — deterministic per-session alias slot ordering across a restart.
 *
 * The property under test is the one the owner named: `pii.Person1` must not
 * mean Alice before a restart and Danny after it. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { deriveSubDEK } from '@recued/crypto';
import { piiEgress } from '@recued/gateway';
import {
  aliasIdentifierField,
  cloneLedger,
  commitLedger,
  createLedger,
  reserveAliasSlotOrdering,
} from '@recued/transforms';
import type { ExecutionSource } from '@recued/contracts';

import { createChatPiiSlotOrderingSeeder } from '../chat-pii-slot-ordering.js';
import {
  createChatStore,
  ensureChatSchema,
  type ChatStore,
  type RetainedAliasCandidate,
} from '../storage/chat-store.js';

const SIG = {
  server_kind: 'recued' as const,
  version: '1.0.0',
  instance_id: 'd167-slots',
};
const picker = { display_name: 'Self', signature: SIG };
const model = { provider: 'test', model_id: 'test/model' };
const SESSION = 'sess-slots';

const ownerSource = (session_id: string): ExecutionSource => ({
  channel: 'chat',
  actor: 'user_self',
  chat_session_id: session_id,
  user_id: 'local',
});

const ALICE = 'Alice Smith';
const DANNY = 'Danny Peterson';

describe('D-167 alias slot ordering — the ledger survives a restart', () => {
  let db: Database.Database;
  let store: ChatStore;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureChatSchema(db);
    store = createChatStore(db, () => deriveSubDEK(new Uint8Array(32).fill(5), 'chat'));
    store.createSession({ id: SESSION, now: 1_000 });
  });

  afterEach(() => db.close());

  const append = async (input: {
    id: string;
    role?: 'user' | 'assistant';
    content: string;
    ts: number;
    candidates: readonly RetainedAliasCandidate[];
  }): Promise<void> => {
    await store.appendMessage({
      id: input.id,
      session_id: SESSION,
      role: input.role ?? 'user',
      content: input.content,
      target_server: 'self',
      picker_at_send: picker,
      model_used: model,
      execution_source: ownerSource(SESSION),
      ts: input.ts,
      retained_alias_candidates: input.candidates,
      // Explicit: a user row on owner chat defaults to `pending`, and the
      // harvest skips pending rows (they are still being written). A finalized
      // fixture keeps these assertions about ORDERING, not about the lifecycle.
      source_lifecycle: 'finalized',
    });
  };

  const seedTwoPeople = async (): Promise<void> => {
    await append({
      id: 'm1',
      content: `note about ${ALICE}`,
      ts: 1_100,
      candidates: [{ value: ALICE, kind: 'name' }],
    });
    await append({
      id: 'm2',
      content: `note about ${DANNY}`,
      ts: 1_200,
      candidates: [{ value: DANNY, kind: 'name' }],
    });
  };

  const seeder = () => createChatPiiSlotOrderingSeeder({ store });

  it('gives the same person the same number after a restart, whatever the new packet contains', async () => {
    await seedTwoPeople();

    // ── epoch 1: the live turn saw Alice first, then Danny.
    const first = createLedger(SESSION);
    await seeder()(first, SESSION);
    const aliceAlias = aliasIdentifierField(first, 'name', ALICE);
    const dannyAlias = aliasIdentifierField(first, 'name', DANNY);
    expect(aliceAlias).toBe('pii.Person1');
    expect(dannyAlias).toBe('pii.Person2');

    // ── restart: a brand-new RAM ledger, and this turn's packet mentions only
    //    Danny (the three-message tail moved on). Pre-fix this made him Person1.
    const afterRestart = createLedger(SESSION);
    await seeder()(afterRestart, SESSION);
    expect(aliasIdentifierField(afterRestart, 'name', DANNY)).toBe('pii.Person2');
    // Alice's slot stayed reserved rather than being handed to the next arrival.
    expect(aliasIdentifierField(afterRestart, 'name', ALICE)).toBe('pii.Person1');
  });

  it('⚠ KNOWN LIMIT — reserves STRUCTURED candidates only, so a prose-only identifier is not order-stable', async () => {
    // ⛔ This test pins a GAP, not a guarantee. The seeder reserves from
    // `row.candidates`; the reharvest contributor allocates from those PLUS
    // `extractDeterministicCandidates(row.content)`. So an email that exists
    // only in prose is allocated with no reservation, and its number comes from
    // whichever packet ran first after the restart — exactly what the
    // crash-rebuild rule (D-213 §3.7) forbids.
    //
    // It is asserted rather than merely written down so the gap cannot widen
    // silently, and so CLOSING it trips this test and forces a deliberate
    // update. The fix is to derive both sides from ONE function — two call
    // sites over one rule is how they drifted.
    await append({
      id: 'p1',
      content: `ping bob@acme.com about ${ALICE}`,
      ts: 1_100,
      candidates: [{ value: ALICE, kind: 'name' }],
    });

    const ledger = createLedger(SESSION);
    await seeder()(ledger, SESSION);

    // The structured candidate IS reserved — that half works.
    expect(ledger.slotReservations.has(`name::${ALICE}`)).toBe(true);
    // The prose-only email is NOT — nothing fixes its number to the durable row.
    expect(ledger.slotReservations.has('email::bob@acme.com')).toBe(false);

    // Consequence, made concrete: two restarts whose first packet differs give
    // the same prose-only address two different numbers.
    const restartA = createLedger(SESSION);
    await seeder()(restartA, SESSION);
    aliasIdentifierField(restartA, 'email', 'zoe@acme.com');
    const bobAfterA = aliasIdentifierField(restartA, 'email', 'bob@acme.com');

    const restartB = createLedger(SESSION);
    await seeder()(restartB, SESSION);
    const bobAfterB = aliasIdentifierField(restartB, 'email', 'bob@acme.com');

    expect(bobAfterA).not.toBe(bobAfterB);
  });

  it('does not hand a reserved slot to an unreserved newcomer', async () => {
    await seedTwoPeople();
    const ledger = createLedger(SESSION);
    await seeder()(ledger, SESSION);

    // Eve is not in any durable row yet, so she has no reservation. She must
    // land ABOVE both reserved slots, not in the unused Person1.
    expect(aliasIdentifierField(ledger, 'name', 'Eve Nowak')).toBe('pii.Person3');
    expect(aliasIdentifierField(ledger, 'name', ALICE)).toBe('pii.Person1');
    expect(aliasIdentifierField(ledger, 'name', DANNY)).toBe('pii.Person2');
  });

  it('keeps a newcomer stable once her own row makes her seedable', async () => {
    await seedTwoPeople();
    const live = createLedger(SESSION);
    await seeder()(live, SESSION);
    const eve = aliasIdentifierField(live, 'name', 'Eve Nowak');
    expect(eve).toBe('pii.Person3');

    // Her turn is now durable, appended after the other two.
    await append({
      id: 'm3',
      role: 'assistant',
      content: 'Eve Nowak joined',
      ts: 1_300,
      candidates: [{ value: 'Eve Nowak', kind: 'name' }],
    });
    const nextEpoch = createLedger(SESSION);
    await seeder()(nextEpoch, SESSION);
    expect(aliasIdentifierField(nextEpoch, 'name', 'Eve Nowak')).toBe(eve);
  });

  it('reserves the email composite halves, not just the top-level kind', async () => {
    await append({
      id: 'e1',
      content: 'mail from alice@acme.test',
      ts: 1_100,
      candidates: [{ value: 'alice@acme.test', kind: 'email' }],
    });
    await append({
      id: 'e2',
      content: 'mail from danny@globex.test',
      ts: 1_200,
      candidates: [{ value: 'danny@globex.test', kind: 'email' }],
    });

    const first = createLedger(SESSION);
    await seeder()(first, SESSION);
    const dannyFirst = aliasIdentifierField(first, 'email', 'danny@globex.test');

    // Post-restart with only Danny's mail present: the composite must be the
    // same surface, which only holds if `email_local` AND the shared `domain`
    // namespace were both reserved.
    const afterRestart = createLedger(SESSION);
    await seeder()(afterRestart, SESSION);
    expect(aliasIdentifierField(afterRestart, 'email', 'danny@globex.test'))
      .toBe(dannyFirst);
    expect(dannyFirst).toContain('@');
  });

  it('is idempotent, and a later epoch never renumbers an already-allocated value', async () => {
    await seedTwoPeople();
    const ledger = createLedger(SESSION);
    // Allocate BEFORE seeding — the harness order a fail-open retry produces.
    expect(aliasIdentifierField(ledger, 'name', DANNY)).toBe('pii.Person1');
    await seeder()(ledger, SESSION);
    // Danny keeps the number he already has; the seed must not reassign it.
    expect(aliasIdentifierField(ledger, 'name', DANNY)).toBe('pii.Person1');
    // Alice's reservation (slot 1) was skipped as taken, so she gets a free one.
    expect(aliasIdentifierField(ledger, 'name', ALICE)).not.toBe('pii.Person1');

    const before = new Map(ledger.slotReservations);
    await seeder()(ledger, SESSION);
    expect(new Map(ledger.slotReservations)).toEqual(before);
  });

  it('fails open when the harvest throws, leaving today behaviour', async () => {
    const throwing = createChatPiiSlotOrderingSeeder({
      store: {
        harvestPiiSources: vi.fn(async () => {
          throw new Error('vault locked');
        }),
      } as never,
    });
    const ledger = createLedger(SESSION);
    await expect(throwing(ledger, SESSION)).resolves.toBeUndefined();
    expect(ledger.slotReservations.size).toBe(0);
    expect(aliasIdentifierField(ledger, 'name', DANNY)).toBe('pii.Person1');
  });

  it('survives the staged-clone → commit round trip', async () => {
    await seedTwoPeople();
    const live = createLedger(SESSION);
    await seeder()(live, SESSION);
    expect(live.slotReservations.size).toBeGreaterThan(0);

    // A staged request consumes Danny's slot; the live ledger must not change
    // until commit, and must carry the consumption afterwards.
    const staged = cloneLedger(live);
    expect(aliasIdentifierField(staged, 'name', DANNY)).toBe('pii.Person2');
    expect(live.byKindRealValue.size).toBe(0);
    expect(live.reservedSlotKeys.has('name::2')).toBe(true);

    commitLedger(live, staged);
    expect(live.reservedSlotKeys.has('name::2')).toBe(false);
    expect(live.slotReservations.size).toBeGreaterThan(0);
    expect(aliasIdentifierField(live, 'name', DANNY)).toBe('pii.Person2');
  });

  it('is a reservation, not an allocation — an unmentioned value gets no restore power', async () => {
    await seedTwoPeople();
    const ledger = createLedger(SESSION);
    await seeder()(ledger, SESSION);
    // P1: nothing is allocated by seeding, so there is no forward or reverse row
    // and no alias the model could be handed for Alice.
    expect(ledger.byKindRealValue.size).toBe(0);
    expect(ledger.byKindBaseAlias.size).toBe(0);
    const authority = piiEgress.deriveRequestRestoreAuthority(
      ledger,
      'nothing here mentions pii.Person1',
    );
    expect(
      piiEgress.restoreForDisplayWithAuthority(authority, 'pii.Person1'),
    ).toBe('pii.Person1');
  });

  it('reserves nothing for a session with no durable rows', async () => {
    const ledger = createLedger(SESSION);
    await seeder()(ledger, SESSION);
    expect(ledger.slotReservations.size).toBe(0);
    expect(aliasIdentifierField(ledger, 'name', ALICE)).toBe('pii.Person1');
  });

  it('ignores an ordering install once a ledger already carries one', () => {
    const ledger = createLedger(SESSION);
    reserveAliasSlotOrdering(ledger, [{ kind: 'name', value: ALICE }]);
    reserveAliasSlotOrdering(ledger, [{ kind: 'name', value: DANNY }]);
    expect(ledger.slotReservations.get(`name::${ALICE}`)).toBe(1);
    expect(ledger.slotReservations.has(`name::${DANNY}`)).toBe(false);
  });
});
