/** D-234 § 234.4m — the deadline fires.
 *
 *  ⚠ THE PROPERTY UNDER TEST IS NOT "A ROW IS DELETED". It is that a run held on
 *  a peer who never answered ENDS, with a reason its recipe can read. So the
 *  assertions are about what reaches `answers.record` and `resume`, not about the
 *  outbox — an implementation that closed every row and resumed nothing would
 *  pass a row-count test and leave every held run held.
 */
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import { validatePeerAskSpec } from '@recued/contracts';

import {
  PEER_ASK_NO_ANSWERER,
  isPeerAskExpired,
  sweepExpiredPeerAsks,
} from '../peer-ask-timeout-sweeper.js';
import { createPeerAnswerStore } from '../storage/peer-answer-store.js';
import { createPeerAskOutboxStore } from '../storage/peer-ask-outbox-store.js';

const NOW = 1_700_000_000_000;

const harness = (rows: { ref: string; deadline_at?: number }[]) => {
  const db = new Database(':memory:');
  const outbox = createPeerAskOutboxStore(db);
  const answers = createPeerAnswerStore(db);
  for (const r of rows) {
    outbox.open({
      exchange_ref: r.ref,
      run_id: `run_${r.ref}`,
      gated_step_id: 'verdict',
      connection: 'peer-bob',
      label: 'review:contract',
      offered: ['approved', 'rejected'],
      ...(r.deadline_at !== undefined ? { deadline_at: r.deadline_at } : {}),
      created_at: NOW - 10_000,
    });
  }
  // ⚠ THE PARAMETER IS DECLARED, and it has to be. An argless `vi.fn(async () => {})`
  // infers `mock.calls` as a 0-TUPLE, so the `c[0]` read below is a typecheck error
  // (TS2493 + TS2352 on the cast that tries to rescue it) — red on HEAD since
  // § 234.4m. Nothing caught it because `typecheck:tests` is a separate npm script
  // from the vitest suite: the test PASSES and `npm run ci` fails.
  const resume = vi.fn(async (_args: { run_id: string; gated_step_id: string }) => {});
  return { db, outbox, answers, resume, now: () => NOW };
};

describe('§ 234.4m — which asks expire', () => {
  it('⛔ NO DEADLINE, NO EXPIRY — EVER', () => {
    // A row with no deadline is `on_timeout: 'wait'`, which is an author saying
    // "hold indefinitely". Sweeping it would end a run its recipe asked to keep
    // waiting — the one outcome this feature must never produce.
    expect(isPeerAskExpired({}, NOW)).toBe(false);
    expect(isPeerAskExpired({ deadline_at: undefined }, NOW)).toBe(false);
  });

  it('expires at the deadline, not after it', () => {
    expect(isPeerAskExpired({ deadline_at: NOW }, NOW)).toBe(true);
    expect(isPeerAskExpired({ deadline_at: NOW - 1 }, NOW)).toBe(true);
    expect(isPeerAskExpired({ deadline_at: NOW + 1 }, NOW)).toBe(false);
  });

  it('⚠ a deadline of 0 EXPIRES rather than reading as absent', () => {
    // Absurd but expressible, and a truthiness test would silently treat it as
    // "no deadline" — which is the failure direction that keeps a run held.
    expect(isPeerAskExpired({ deadline_at: 0 }, NOW)).toBe(true);
  });

  it('⛔⛔ THE INVARIANT THIS SWEEP RESTS ON: deadline present ⟺ on_timeout stop', () => {
    // There is no `on_timeout` column in the outbox, and that is only sound
    // because the validator refuses both mismatched pairings. If either of these
    // assertions ever fails, this sweep starts ending runs whose author asked it
    // to wait — add the column before relaxing the validator, not after.
    const base = {
      connection: 'peer-bob',
      label: 'review:contract',
      question: 'Approve?',
      options: [{ id: 'yes', label: 'Yes' }],
      via: 'direct' as const,
    };
    expect(validatePeerAskSpec({ ...base, on_timeout: 'wait', deadline_at: NOW } as never))
      .toContain('deadline_without_stop');
    expect(validatePeerAskSpec({ ...base, on_timeout: 'stop' } as never))
      .toContain('stop_without_deadline');
  });
});

describe('§ 234.4m — what the sweep does', () => {
  it('✅ records a readable non-answer and RESUMES the held run', async () => {
    const h = harness([{ ref: 'ref_late', deadline_at: NOW - 1 }]);
    const r = await sweepExpiredPeerAsks({ ...h, log: () => {} });

    expect(r).toMatchObject({ examined: 1, expired: 1, resumed: 1, alreadyAnswered: 0, failed: 0 });
    // ⛔ THE RESUME IS THE POINT. Recording without resuming leaves the run held
    // until something else happens to re-run it, which for a timeout may be never.
    expect(h.resume).toHaveBeenCalledWith({ run_id: 'run_ref_late', gated_step_id: 'verdict' });

    const recorded = h.answers.get('ref_late');
    expect(recorded).toMatchObject({
      answered: false,
      unanswered_because: 'timed_out',
      peer_contract_id: PEER_ASK_NO_ANSWERER,
    });
    // The recipe reads this — a timeout must be distinguishable from a refusal.
    expect(recorded?.option).toBeUndefined();
    expect(h.outbox.get('ref_late')).toBeNull();
  });

  it('⛔ LEAVES AN UNEXPIRED ASK COMPLETELY ALONE', async () => {
    const h = harness([{ ref: 'ref_future', deadline_at: NOW + 60_000 }]);
    const r = await sweepExpiredPeerAsks({ ...h, log: () => {} });

    expect(r).toMatchObject({ examined: 1, expired: 0, resumed: 0 });
    expect(h.resume).not.toHaveBeenCalled();
    expect(h.answers.get('ref_future')).toBeNull();
    expect(h.outbox.get('ref_future')).not.toBeNull();
  });

  it('⛔ AND A DEADLINE-LESS ASK, WHICH IS THE ONE THAT MUST NEVER BE TOUCHED', async () => {
    const h = harness([{ ref: 'ref_forever' }]);
    const r = await sweepExpiredPeerAsks({ ...h, log: () => {} });

    expect(r).toMatchObject({ expired: 0 });
    expect(h.resume).not.toHaveBeenCalled();
    expect(h.answers.get('ref_forever')).toBeNull();
    expect(h.outbox.get('ref_forever')).not.toBeNull();
  });

  it('⛔⛔ LOSES THE RACE TO A REAL ANSWER — and does NOT resume behind it', async () => {
    // The peer answered a moment before the tick. `record` is first-write-wins,
    // so the sweep must find the run already moving and keep its hands off: a
    // second resume would re-run a step the answer path is already re-running.
    const h = harness([{ ref: 'ref_raced', deadline_at: NOW - 1 }]);
    h.answers.record({
      exchange_ref: 'ref_raced',
      peer_contract_id: 'ctr_bob',
      answered: true,
      option: 'approved',
      at: NOW - 2,
    });

    const r = await sweepExpiredPeerAsks({ ...h, log: () => {} });

    expect(r).toMatchObject({ expired: 1, alreadyAnswered: 1, resumed: 0 });
    expect(h.resume).not.toHaveBeenCalled();
    // ⛔ THE REAL ANSWER SURVIVES INTACT. If the timeout overwrote it, a peer's
    // approval would silently become a timeout and the run would take the wrong
    // branch while every row looked plausible.
    expect(h.answers.get('ref_raced')).toMatchObject({ answered: true, option: 'approved' });
  });

  it('⛔ ONE UNRESUMABLE HOLD DOES NOT STRAND THE ROWS BEHIND IT', async () => {
    const h = harness([
      { ref: 'ref_a', deadline_at: NOW - 1 },
      { ref: 'ref_b', deadline_at: NOW - 1 },
    ]);
    h.resume.mockImplementationOnce(async () => { throw new Error('executeDeps not published'); });

    const r = await sweepExpiredPeerAsks({ ...h, log: () => {} });

    expect(r).toMatchObject({ expired: 2, resumed: 1, failed: 1 });
    // ⚠ THE NON-ANSWER IS DURABLE EITHER WAY — the failed run finds it whenever
    // it next resumes, exactly as it would find a real answer.
    expect(h.answers.get('ref_a')).toMatchObject({ unanswered_because: 'timed_out' });
    expect(h.answers.get('ref_b')).toMatchObject({ unanswered_because: 'timed_out' });
  });

  it('sweeps the expired and skips the live in the same pass', async () => {
    const h = harness([
      { ref: 'ref_1', deadline_at: NOW - 1 },
      { ref: 'ref_2' },
      { ref: 'ref_3', deadline_at: NOW + 5_000 },
      { ref: 'ref_4', deadline_at: NOW },
    ]);
    const r = await sweepExpiredPeerAsks({ ...h, log: () => {} });

    expect(r).toMatchObject({ examined: 4, expired: 2, resumed: 2 });
    expect(h.resume.mock.calls.map((c) => c[0].run_id).sort())
      .toEqual(['run_ref_1', 'run_ref_4']);
  });

  it('names the timeout in the activity log, distinguishably from an answer', async () => {
    // `peer_ask_answered` and `peer_ask_timed_out` are different events, and an
    // owner reading their trail must be able to tell "they said no" from "nobody
    // said anything" without opening the run.
    const h = harness([{ ref: 'ref_logged', deadline_at: NOW - 1 }]);
    const rows: { action: string; target: string; detail: string }[] = [];
    await sweepExpiredPeerAsks({ ...h, logActivity: (row) => rows.push(row), log: () => {} });

    expect(rows.map((x) => x.action)).toEqual(['peer_ask_timed_out']);
    expect(rows[0]!.target).toBe('peer-bob/review:contract');
    expect(JSON.parse(rows[0]!.detail)).toMatchObject({
      exchange_ref: 'ref_logged',
      deadline_at: NOW - 1,
    });
  });
});
