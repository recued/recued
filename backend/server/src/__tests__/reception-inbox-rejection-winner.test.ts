import { describe, expect, it } from 'vitest';
import { handleReceptionInboxReject } from '../reception-inbox-handler.js';
import { createApprovalWinnerFixture, WINNER_NOW } from './approval-winner-fixture.js';

type Fixture = Awaited<ReturnType<typeof createApprovalWinnerFixture>>;
const rejections = (f: Fixture) => f.activities().filter(row => row.action === 'reception.inbox.rejected' as string);

describe('inbox rejection follows the accepted denial', () => {
  it('does not dismiss or audit a reject that loses while reading a hold', async () => {
    const f = await createApprovalWinnerFixture(), gate = f.stallLookup();
    const rejection = f.rejectInApp('Losing reason'); const failure = expect(rejection).rejects.toMatchObject({ code: 'hold_not_found' });
    try {
      await gate.entered; expect((await f.approveInApp({ title: 'Winner' })).released).toBe(true);
      gate.release(); await failure;
      expect(f.resumes.map(cp => cp.arg_overrides)).toEqual([{ title: 'Winner' }]);
      expect(f.denials).toHaveLength(0); expect(f.subview.list(10)).toHaveLength(0); expect(rejections(f)).toHaveLength(0);
      expect(f.broadcasts).not.toContainEqual({ kind: 'reception_inbox', op: 'rejected', hold_id: 'cp-1' });
    } finally { gate.release(); await rejection.catch(() => {}); f.close(); }
  });

  it('keeps the first reject reason and refuses a queued reject while denial remains usable during pause', async () => {
    const f = await createApprovalWinnerFixture(), gate = f.stallPreparation(); f.setPaused(true);
    const winner = f.rejectInApp('Winning reason'); let loser: ReturnType<typeof f.rejectInApp> | undefined;
    try {
      await gate.entered; loser = f.rejectInApp('Losing reason'); const failure = expect(loser).rejects.toMatchObject({ code: 'hold_not_found' });
      gate.release(); expect((await winner).status).toBe('dismissed'); await failure;
      expect(f.denials).toHaveLength(1); expect(f.resumes).toHaveLength(0);
      expect(f.subview.list(10)).toEqual([expect.objectContaining({ reason: 'Winning reason', door_contract_id: 'door-1' })]);
      expect(rejections(f)).toEqual([expect.objectContaining({ detail: 'rejected: Winning reason' })]);
    } finally { gate.release(); await Promise.allSettled([winner, loser]); f.close(); }
  });

  it('leaves history untouched when the answer write fails and allows a subsequent approval', async () => {
    const f = await createApprovalWinnerFixture();
    try {
      f.failAnswerWrite('before'); await expect(f.rejectInApp('Unaccepted')).rejects.toThrow('answer write failed before commit');
      expect((await f.ask())?.status).toBe('open'); expect(f.subview.list(10)).toHaveLength(0); expect(f.activities()).toHaveLength(0);
      expect((await f.approveInApp({ title: 'Allowed later' })).released).toBe(true);
      expect(f.denials).toHaveLength(0); expect(rejections(f)).toHaveLength(0);
    } finally { f.close(); }
  });

  it('recognizes an answer committed before a write error without duplicating rejection history', async () => {
    const f = await createApprovalWinnerFixture();
    try {
      f.failAnswerWrite('after'); expect((await f.rejectInApp('Committed')).status).toBe('dismissed');
      expect(f.denials).toHaveLength(1); expect((await f.ask())?.status).toBe('handled');
      await f.restart(); expect(f.denials).toHaveLength(1); expect(f.subview.list(10)).toHaveLength(1); expect(rejections(f)).toHaveLength(1);
    } finally { f.close(); }
  });

  it('recovers accepted rejection history and its original timestamp after shutdown', async () => {
    const f = await createApprovalWinnerFixture();
    try {
      f.block.beginStopping(); expect((await f.rejectInApp('Saved denial')).status).toBe('dismissed');
      expect(f.subview.list(10)).toHaveLength(0); expect(f.denials).toHaveLength(0);
      f.setNow(WINNER_NOW + 60_000); await f.restart();
      expect(f.denials).toHaveLength(1); expect((await f.ask())?.status).toBe('handled');
      expect(f.subview.list(10)).toEqual([expect.objectContaining({ reason: 'Saved denial', dismissed_at: WINNER_NOW })]);
      expect(rejections(f)).toEqual([expect.objectContaining({ timestamp: WINNER_NOW, detail: 'rejected: Saved denial' })]);
    } finally { f.close(); }
  });

  for (const at of ['before-subview', 'after-audit'] as const) {
    it(`retries a history projection failure ${at} using the durable denial`, async () => {
      const f = await createApprovalWinnerFixture();
      try {
        f.failRejectionProjection(at); expect((await f.rejectInApp('Saved reason')).status).toBe('dismissed');
        expect((await f.ask())?.status).toBe('answered'); expect(f.denials).toHaveLength(0);
        expect(await f.plainAnswer('approve')).toBe('closed');
        await f.restart(); await f.restart();
        expect(f.denials).toHaveLength(1); expect(f.resumes).toHaveLength(0);
        expect(f.subview.list(10)).toHaveLength(1); expect(rejections(f)).toHaveLength(1);
        expect(rejections(f)[0]?.detail).toBe('rejected: Saved reason'); expect((await f.ask())?.status).toBe('handled');
      } finally { f.close(); }
    });
  }

  it('re-enters a batch denial after a projection failure without losing its rejection record', async () => {
    const f = await createApprovalWinnerFixture(false, true);
    try {
      f.failRejectionProjection('after-audit'); await f.rejectInApp('Batch rejection');
      expect((await f.ask())?.status).toBe('answered'); expect(f.denials).toHaveLength(0);
      await f.restart(); expect(f.denials).toHaveLength(1); expect(rejections(f)).toHaveLength(1);
      expect(f.subview.list(10)[0]?.reason).toBe('Batch rejection'); expect((await f.ask())?.status).toBe('handled');
    } finally { f.close(); }
  });

  it('does not invent rejection history for an incomplete response or an unwired decision adapter', async () => {
    const required = await createApprovalWinnerFixture(true), unwired = await createApprovalWinnerFixture();
    try {
      await expect(required.rejectInApp('Missing note')).rejects.toMatchObject({ code: 'decision_not_recorded' });
      await expect(handleReceptionInboxReject({ ...unwired.inbox, submitPreparedAnswer: undefined }, { hold_id: 'cp-1' },
        { instance_id: 'paired-fixture' })).rejects.toMatchObject({ code: 'decision_not_recorded' });
      for (const f of [required, unwired]) {
        expect((await f.ask())?.status).toBe('open'); expect(f.subview.list(10)).toHaveLength(0); expect(f.activities()).toHaveLength(0);
      }
    } finally { required.close(); unwired.close(); }
  });

  it('fails closed on a corrupted persisted checkpoint binding', async () => {
    const f = await createApprovalWinnerFixture();
    try {
      f.block.beginStopping(); await f.rejectInApp('Bound to this hold'); await f.corruptPreparedBinding(); await f.restart();
      expect((await f.ask())?.status).toBe('answered'); expect(f.subview.list(10)).toHaveLength(0); expect(rejections(f)).toHaveLength(0);
      expect(f.denials).toHaveLength(0); expect(await f.checkpoints.get('cp-1')).not.toBeNull();
    } finally { f.close(); }
  });
});
