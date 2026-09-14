/** D-268 — the reporter's episode logic and notice text.
 *
 *  ⛔ THE SEQUENCE TEST IS THE POINT. A test that fails once and asserts one
 *  notification cannot see the dedup, and the dedup is the only part of this
 *  design that can page an owner 288 times in a day. Every block below drives a
 *  RUN SEQUENCE through the same counter the production callers keep. */

import { describe, expect, it } from 'vitest';

import {
  automationRuleLink,
  decideAutomationFailure,
  describeAutomationFailureNotice,
  type AutomationUnitRef,
} from '../automation-failure-reporter.js';

const THRESHOLD = 5;

const unit: AutomationUnitRef = {
  kind: 'schedule',
  id: 'sch-1',
  recipe_id: 'recued-core/renewal-notice',
  name: 'Renewal notice',
};

/** Drives a sequence of outcomes through the counter exactly as a caller does:
 *  a success resets to zero, a failure asks the reporter and persists the
 *  returned count. Returns every notice that would have been delivered. */
const driveSequence = (
  outcomes: ReadonlyArray<{ ok: true } | { ok: false; code?: string; total_refusal?: boolean }>,
): { notices: string[]; disarms: number; finalCount: number } => {
  let consecutive = 0;
  let disarmed = false;
  const notices: string[] = [];
  let disarms = 0;
  for (const outcome of outcomes) {
    if (disarmed) continue; // a disarmed unit does not fire again
    if (outcome.ok) { consecutive = 0; continue; }
    const report = decideAutomationFailure({
      unit,
      ...(outcome.code !== undefined ? { code: outcome.code } : {}),
      ...(outcome.total_refusal !== undefined ? { total_refusal: outcome.total_refusal } : {}),
      reason: 'A token refresh failed.',
      prior_consecutive_failures: consecutive,
      threshold: THRESHOLD,
    });
    if (report.not_a_failure) continue;
    consecutive = report.consecutive_failures;
    if (report.notice) notices.push(report.notice.title ?? '');
    if (report.disarm) { disarmed = true; disarms += 1; }
  }
  return { notices, disarms, finalCount: consecutive };
};

describe('D-268 episode logic', () => {
  it('⛔ fail → fail → fail → success → fail sends exactly TWO notices', () => {
    // Transient code, so nothing disarms inside five. The second episode opens
    // only because the success closed the first.
    const result = driveSequence([
      { ok: false, code: 'NETWORK_ERROR' },
      { ok: false, code: 'NETWORK_ERROR' },
      { ok: false, code: 'NETWORK_ERROR' },
      { ok: true },
      { ok: false, code: 'NETWORK_ERROR' },
    ]);
    expect(result.notices).toEqual(['Renewal notice failed', 'Renewal notice failed']);
    expect(result.disarms).toBe(0);
    expect(result.finalCount).toBe(1);
  });

  it('a five-minute rule failing all day sends ONE notice, then the stop', () => {
    const outcomes = Array.from({ length: 50 }, () => ({ ok: false as const, code: 'NETWORK_ERROR' }));
    const result = driveSequence(outcomes);
    expect(result.notices).toEqual(['Renewal notice failed', 'Renewal notice has stopped']);
    expect(result.disarms).toBe(1);
  });

  it('recovery is silent — a success sends nothing', () => {
    const result = driveSequence([{ ok: true }, { ok: true }]);
    expect(result.notices).toEqual([]);
  });

  it('a fault that will not heal sends ONE notice and it is the stopped one', () => {
    const result = driveSequence([{ ok: false, code: 'TOKEN_REFRESH_FAILED' }]);
    expect(result.notices).toEqual(['Renewal notice has stopped']);
    expect(result.disarms).toBe(1);
  });

  it('total refusal runs to the breaker, so the first one only warns', () => {
    const result = driveSequence([{ ok: false, total_refusal: true }]);
    expect(result.notices).toEqual(['Renewal notice failed']);
    expect(result.disarms).toBe(0);
  });
});

describe('D-268 a non-failure changes nothing', () => {
  it('⛔ a tripped guard does not increment, does not notify and does not disarm — BECAUSE it is `conditional`', () => {
    const report = decideAutomationFailure({
      unit,
      code: 'RECIPE_GUARD_TRIGGERED',
      reason: 'A guard stopped the run.',
      prior_consecutive_failures: 4,
      threshold: THRESHOLD,
    });
    // Named cause, not a bare absence: this must pass because the code is
    // classified `conditional`, never because the reporter happened to skip it.
    expect(report.not_a_failure).toBe(true);
    expect(report.consecutive_failures).toBe(4);
    expect(report.disarm).toBe(false);
    expect(report.notice).toBeUndefined();
  });

  it('positive control — the same counter at 4 DOES disarm on a real failure', () => {
    const report = decideAutomationFailure({
      unit,
      code: 'NETWORK_ERROR',
      reason: 'The network failed.',
      prior_consecutive_failures: 4,
      threshold: THRESHOLD,
    });
    expect(report.disarm).toBe(true);
    expect(report.consecutive_failures).toBe(5);
  });
});

describe('D-268 the notice', () => {
  it('carries a deep link to the recipe, not to a section token the backend cannot know', () => {
    expect(automationRuleLink(unit)).toBe('#automation/recued-core%2Frenewal-notice');
  });

  it('names the threshold while it is still running, and the count once stopped', () => {
    const failing = describeAutomationFailureNotice({
      unit, reason: 'Boom.', consecutive_failures: 1, stopped: false, threshold: 5,
    });
    expect(failing.text).toContain('fails 5 times');
    const stopped = describeAutomationFailureNotice({
      unit, reason: 'Boom.', consecutive_failures: 5, stopped: true, threshold: 5,
    });
    expect(stopped.text).toContain('after 5 failures');
    expect(stopped.text).toContain('re-arm');
  });

  it('says "after one failure", not "after 1 failures"', () => {
    const stopped = describeAutomationFailureNotice({
      unit, reason: 'Boom.', consecutive_failures: 1, stopped: true, threshold: 5,
    });
    expect(stopped.text).toContain('after one failure');
  });

  it('trims a long provider message rather than shipping a document to a phone', () => {
    const notice = describeAutomationFailureNotice({
      unit, reason: 'x'.repeat(1000), consecutive_failures: 1, stopped: false, threshold: 5,
    });
    expect(notice.text.length).toBeLessThan(400);
    expect(notice.text).toContain('…');
  });

  it('falls back to the recipe id when the caller could not resolve a name', () => {
    const notice = describeAutomationFailureNotice({
      unit: { kind: 'trigger', id: 't-1', recipe_id: 'pub/thing' },
      reason: 'Boom.', consecutive_failures: 1, stopped: false, threshold: 5,
    });
    expect(notice.title).toBe('pub/thing failed');
  });
});
