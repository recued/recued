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

describe('FN-2 — the decision is joinable to what it decided about', () => {
  // The defect this pins: `target` is the `ask_id`, and `AskStore.pruneHandled`
  // deletes that row once the ask goes terminal, while the run anchor's
  // back-pointer is overwritten on resume. Reserve-class kept the DECISION and
  // nothing kept what it was ABOUT.
  const preflightPayload = {
    checkpoint_id: 'cp-9',
    run_id: 'run-42',
    recipe_id: 'recued-core.book-appointment',
    gated_step_id: 'send_confirmation',
    tool_slug: 'mail-send',
    risk_tier: 'write',
  };

  it('lifts run / recipe / step / operation off a recipe-bound preflight hold', () => {
    const entry = buildAnswerActivity(record({ handler_payload: preflightPayload }));
    expect(entry.run_id).toBe('run-42');
    expect(entry.recipe_id).toBe('recued-core.book-appointment');
    expect(entry.step_id).toBe('send_confirmation');
    expect(entry.operation_id).toBe('mail-send');
    // ⛔ The pre-existing contract is untouched — `target` still names the ask.
    // Repointing it at the run would have silently broken every existing reader.
    expect(entry.target).toBe('ask-1');
    expect(entry.action).toBe('approval_allow');
  });

  it('uses raw_op_id for a recipe-LESS raw-op door hold', () => {
    // D-182 §8: a raw-op hold has no recipe and no step. The checkpoint guard
    // enforces the partition, so the absent fields are absent — not guessed.
    const entry = buildAnswerActivity(record({
      handler_payload: { run_id: 'run-7', checkpoint_id: 'cp-1', raw_op_id: 'core.mail.send' },
    }));
    expect(entry.run_id).toBe('run-7');
    expect(entry.operation_id).toBe('core.mail.send');
    expect(entry.recipe_id).toBeUndefined();
    expect(entry.step_id).toBeUndefined();
  });

  it('⛔ never writes a non-string into a join key, and a pack ask stays clean', () => {
    // `handler_payload` is `Record<string, unknown>` by contract and any pack
    // may register any ask kind. A wrong join key in a reserve-class ledger is
    // worse than an absent one, so a non-string is ignored rather than coerced.
    const entry = buildAnswerActivity(record({
      handler_kind: 'somepack.confirm',
      handler_payload: { run_id: 42, recipe_id: '', tool_slug: null, other: 'x' },
    }));
    expect(entry.run_id).toBeUndefined();
    expect(entry.recipe_id).toBeUndefined();
    expect(entry.operation_id).toBeUndefined();
  });

  it('🔑 an ask with NO payload yields exactly the pre-FN-2 entry', () => {
    // The control. Without it the assertions above could pass while the
    // ordinary path silently changed shape.
    const before = buildAnswerActivity(record());
    expect(before.run_id).toBeUndefined();
    expect(before.recipe_id).toBeUndefined();
    expect(before.step_id).toBeUndefined();
    expect(before.operation_id).toBeUndefined();
    expect(Object.keys(before).sort()).toEqual(
      ['action', 'activity_id', 'detail', 'target', 'timestamp'].sort(),
    );
  });
});
