import { describe, expect, it } from 'vitest';
import { createApprovalWinnerFixture, WINNER_NOW } from './approval-winner-fixture.js';
import { handleReceptionInboxApprove } from '../reception-inbox-handler.js';

describe('ask-backed inbox approvals commit the winning snapshot', () => {
  it('recovers a batch approval from SQLite with its winning edit and no losing edit audit', async () => {
    const f = await createApprovalWinnerFixture(false, true);
    try {
      f.failCheckpointWrite('after');
      expect((await f.approveInApp({ title: 'Batch winner' })).released).toBe(true);
      expect((await f.ask())?.status).toBe('answered');
      expect((await f.approveInApp({ title: 'Losing edit' })).released).toBe(false);
      expect(f.resumes).toHaveLength(0);
      await f.restart();
      expect(f.resumes.map(c => c.arg_overrides)).toStrictEqual([{ title: 'Batch winner' }]);
      expect((await f.ask())?.status).toBe('handled');
      const approvals = f.activities().filter(row => row.target === 'cp-1');
      expect(approvals).toHaveLength(1); expect(approvals[0]?.detail).toContain('Batch winner');
      expect(approvals[0]?.detail).not.toContain('Losing edit');
    } finally { f.close(); }
  });

  for (const at of ['before', 'after'] as const) {
    it(`recovers the winning edit after a checkpoint write fails ${at} persistence`, async () => {
      const f = await createApprovalWinnerFixture();
      try {
        f.failCheckpointWrite(at);
        expect((await f.approveEdited('Winner')).ok).toBe(true);
        expect((await f.ask())?.status).toBe('answered'); expect(f.resumes).toHaveLength(0);
        expect(await f.plainAnswer('deny')).toBe('closed');
        await f.restart();
        expect(f.resumes.map(c => c.arg_overrides)).toStrictEqual([{ title: 'Winner' }]);
        expect(f.denials).toHaveLength(0); expect((await f.ask())?.status).toBe('handled');
        expect(f.activities().filter(row => row.target === 'cp-1')).toHaveLength(1);
      } finally { f.close(); }
    });
  }

  it('leaves no edit or approval audit when the answer write fails before commit', async () => {
    const f = await createApprovalWinnerFixture();
    try {
      f.failAnswerWrite('before');
      await expect(f.approveEdited('Rejected')).rejects.toThrow('answer write failed before commit');
      expect((await f.ask())?.status).toBe('open');
      expect((await f.checkpoints.get('cp-1'))?.arg_overrides).toBeUndefined();
      expect(f.activities()).toHaveLength(0);
      expect(await f.plainAnswer('deny')).toBe('answered');
      expect(f.denials[0]?.arg_overrides).toBeUndefined(); expect(f.resumes).toHaveLength(0);
    } finally { f.close(); }
  });

  it('recognizes a committed answer after a write error and resumes exactly once', async () => {
    const f = await createApprovalWinnerFixture();
    try {
      f.failAnswerWrite('after'); expect((await f.approveEdited('Winner')).ok).toBe(true);
      expect(f.resumes.map(c => c.arg_overrides)).toStrictEqual([{ title: 'Winner' }]);
      expect(await f.plainAnswer('approve')).toBe('closed');
      expect(f.activities().filter(row => row.target === 'cp-1')).toHaveLength(1);
    } finally { f.close(); }
  });

  it('keeps target changes attached to the winning decision across a restart', async () => {
    const f = await createApprovalWinnerFixture();
    try {
      f.block.beginStopping();
      expect((await f.approveInApp({ connection_name: 'calendar-B' })).released).toBe(true);
      expect((await f.checkpoints.get('cp-1'))?.approved_target?.connection_name).toBe('calendar-A');
      await f.restart();
      expect(f.resumes[0]?.arg_overrides).toStrictEqual({ connection_name: 'calendar-B' });
      expect(f.resumes[0]?.approved_target?.connection_name).toBe('calendar-B');
    } finally { f.close(); }
  });

  it('refuses a paused preparation before mutations and leaves denial usable', async () => {
    const f = await createApprovalWinnerFixture(), gate = f.stallPreparation();
    let approval: ReturnType<typeof f.approveEdited> | undefined;
    try {
      approval = f.approveEdited('Refused'); const rejection = expect(approval).rejects.toThrow('paused');
      await gate.entered; f.setPaused(true); gate.release(); await rejection;
      expect((await f.ask())?.status).toBe('open'); expect((await f.checkpoints.get('cp-1'))?.arg_overrides).toBeUndefined();
      expect(f.activities()).toHaveLength(0); expect(await f.plainAnswer('deny')).toBe('answered');
      expect(f.denials[0]?.arg_overrides).toBeUndefined();
    } finally { gate.release(); await approval?.catch(() => {}); f.close(); }
  });

  it('does not mutate an incomplete required-note decision or an unwired approval path', async () => {
    const required = await createApprovalWinnerFixture(true), unwired = await createApprovalWinnerFixture();
    try {
      expect((await required.approveEdited('Unanswered')).ok).toBe(false);
      expect((await handleReceptionInboxApprove({ ...unwired.inbox, submitPreparedAnswer: undefined },
        { hold_id: 'cp-1', edits: { title: 'Unwired' } }, { instance_id: 'paired-fixture' })).released).toBe(false);
      for (const f of [required, unwired]) {
        expect((await f.ask())?.status).toBe('open'); expect((await f.checkpoints.get('cp-1'))?.arg_overrides).toBeUndefined();
        expect(f.activities()).toHaveLength(0); expect(f.resumes).toHaveLength(0);
      }
    } finally { required.close(); unwired.close(); }
  });

  it('rechecks the public edit deadline after waiting for preparation', async () => {
    const f = await createApprovalWinnerFixture(), gate = f.stallPreparation();
    let approval: ReturnType<typeof f.approveEdited> | undefined;
    try {
      approval = f.approveEdited('Too late'); const rejection = expect(approval).rejects.toThrow('no longer');
      await gate.entered; f.setNow(WINNER_NOW + 25 * 60 * 60_000); gate.release(); await rejection;
      expect((await f.ask())?.status).toBe('open'); expect((await f.checkpoints.get('cp-1'))?.arg_overrides).toBeUndefined();
      expect(f.activities()).toHaveLength(0);
      expect(await f.plainAnswer('approve')).toBe('answered'); expect(f.resumes[0]?.arg_overrides).toBeUndefined();
    } finally { gate.release(); await approval?.catch(() => {}); f.close(); }
  });

  it('fails closed when a persisted prepared patch names another checkpoint', async () => {
    const f = await createApprovalWinnerFixture();
    try {
      f.block.beginStopping(); await f.approveEdited('Winner'); await f.corruptPreparedBinding();
      await f.restart();
      expect((await f.ask())?.status).toBe('answered'); expect(f.resumes).toHaveLength(0);
      expect((await f.checkpoints.get('cp-1'))?.arg_overrides).toBeUndefined();
      expect(f.activities().some(row => row.target === 'a-different-checkpoint')).toBe(false);
    } finally { f.close(); }
  });
});
