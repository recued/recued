/** D-188 — approving while the server is paused (the owner's rulings of 2026-11-08): "you cannot
 *  perform approval during pause … the action after approval won't work or not supposed to
 *  work", then the pause as a lockdown: "schedule/arm/trigger/manual all stopped". While
 *  paused a held run can be declined but not approved, whoever started it, the owner by hand
 *  included; every other ask is answered as ever, since its answer runs nothing now. */
import { describe, expect, it } from 'vitest';

import {
  PAUSED_APPROVAL_REFUSAL,
  askWaitsForResume,
  createPausedAnswerRefusal,
} from '../pause-approval.js';

const HELD = { handler_kind: 'gateway.preflight' };

describe('which asks wait for Resume', () => {
  it('none while the server runs', () => {
    expect(askWaitsForResume({ isPaused: () => false }, HELD)).toBe(false);
  });

  it("paused: every held run's approval, and no other ask", () => {
    const paused = { isPaused: () => true };
    expect(askWaitsForResume(paused, HELD)).toBe(true);
    // A missed schedule's "Run them" is a grant the stopped scheduler fires after Resume;
    // "No — retry" re-sends nothing; a send's outcome only records.
    for (const handler_kind of ['schedule.missed_runs', 'gateway.in_doubt', 'mail.send_outcome', 'reminder.occurrence']) {
      expect(askWaitsForResume(paused, { handler_kind })).toBe(false);
    }
  });
});

describe('the answer the server refuses while paused', () => {
  it('refuses every answer that lets a held run go ahead, in the owner\'s words', async () => {
    const refuse = createPausedAnswerRefusal({ isPaused: () => true });
    for (const option of ['approve', 'allow_session', 'allow_trigger', 'never_ask_operation']) {
      expect(await refuse(HELD, option)).toEqual({ code: 'server_paused', message: PAUSED_APPROVAL_REFUSAL });
    }
  });

  it('…lets every hold be denied', async () => {
    expect(await createPausedAnswerRefusal({ isPaused: () => true })(HELD, 'deny')).toBeUndefined();
  });

  it('…and refuses nothing while the server runs, nor for any other kind of ask', async () => {
    expect(await createPausedAnswerRefusal({ isPaused: () => false })(HELD, 'approve')).toBeUndefined();
    const paused = createPausedAnswerRefusal({ isPaused: () => true });
    expect(await paused({ handler_kind: 'schedule.missed_runs' }, 'run')).toBeUndefined();
    expect(await paused({ handler_kind: 'gateway.in_doubt' }, 'retry')).toBeUndefined();
  });
});
