/** D-210 — the answered-ask activity row (the server half).
 *
 *  `buildAnswerActivity` is the projection that makes pruning terminal asks
 *  safe. Its action mapping is a CLAIM about what someone agreed to, so it
 *  is tested directly rather than through the composer. */

import { describe, expect, it } from 'vitest';
import { RESERVE_ACTIONS } from '@recued/storage';
import type { AnswerAuditRecord } from '@recued/notification';

import { buildAnswerActivity } from '../composition/bin/wire-notification-block.js';

const NOW = 1_700_000_000_000;

const record = (over: Partial<AnswerAuditRecord> = {}): AnswerAuditRecord => ({
  ask_id: 'ask-1',
  handler_kind: 'gateway.preflight',
  option: 'approve',
  option_label: 'Approve',
  title: 'Approve scheduling.materialize',
  answered_at: NOW,
  answered_via: 'slack',
  ...over,
});

describe('D-210 — buildAnswerActivity', () => {
  it('carries the decision facts a pruned ask row would otherwise take with it', () => {
    const entry = buildAnswerActivity(record());
    expect(entry.action).toBe('approval_allow');
    expect(entry.target).toBe('ask-1');
    expect(entry.timestamp).toBe(NOW);
    // The channel is the fact nothing downstream can recover — `dispatchAnswer`
    // strips it before the handler runs (I-10).
    expect(entry.detail).toContain('via slack');
    expect(entry.detail).toContain('Approve scheduling.materialize');
    // Both the label the user read and the raw id they submitted.
    expect(entry.detail).toContain("'Approve'");
    expect(entry.detail).toContain('(approve)');
  });

  it('maps approve and allow_session to allow, deny to deny', () => {
    expect(buildAnswerActivity(record({ option: 'approve' })).action).toBe('approval_allow');
    expect(buildAnswerActivity(record({ option: 'allow_session' })).action).toBe(
      'approval_allow',
    );
    expect(buildAnswerActivity(record({ option: 'deny' })).action).toBe('approval_deny');
  });

  it('records an UNKNOWN option as a denial, never as consent', () => {
    // The block audits every ask kind, not just `gateway.preflight`, and a
    // non-preflight ask's options are arbitrary pack strings. Reading an
    // unrecognised option as `approval_allow` would record consent the user
    // never expressed; `approval_deny` is the safe direction for a record of
    // what someone agreed to. The raw option still rides the detail, so a
    // human reader is never misled into seeing a plain refusal.
    const entry = buildAnswerActivity(record({ option: 'reschedule', option_label: 'Pick another time' }));
    expect(entry.action).toBe('approval_deny');
    expect(entry.detail).toContain('(reschedule)');
    expect(entry.detail).toContain("'Pick another time'");
  });

  it('falls back to the handler kind when the ask carried no title', () => {
    const { title: _drop, ...noTitle } = record();
    expect(buildAnswerActivity(noTitle as AnswerAuditRecord).detail).toContain(
      'gateway.preflight',
    );
  });

  it('derives a per-ask activity_id so a replay cannot double-write', () => {
    expect(buildAnswerActivity(record()).activity_id).toBe(
      `notification.answered-${NOW}-ask-1`,
    );
  });

  it('🔑 both actions are RESERVE-CLASS — else the prune is lossy after all', () => {
    // This row is now the ONLY durable record of the decision: the terminal
    // `PendingAsk` is pruned, and the run anchor's `ask_id` back-pointer is
    // overwritten when the answer resumes the run (`append` is
    // `set(run_id, …)`). An evictable record would mean the prune destroyed
    // the decision after all, just later and more quietly.
    expect(RESERVE_ACTIONS.has('approval_allow')).toBe(true);
    expect(RESERVE_ACTIONS.has('approval_deny')).toBe(true);
  });
});
