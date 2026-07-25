/** D-181 slice 5 — `deriveHeavyOpErrorCategory` pure-helper tests.
 *
 *  The display-category derivation (§12) maps the structured signals available
 *  at the audit-anchor write — the in-flight registry's control-termination
 *  marker + a run error's preserved stall telemetry (`details.heavy_op`) — to a
 *  `HeavyOpErrorCategory`. Precedence: an owner termination wins over any error
 *  telemetry; ordinary failures carry no category. No message string-matching. */

import { describe, it, expect } from 'vitest';
import { deriveHeavyOpErrorCategory, deriveRunTermination } from '../execution-control.js';

const heavyOpErr = (kill_reason: unknown) => ({
  details: { heavy_op: { kill_reason } },
});

describe('deriveHeavyOpErrorCategory', () => {
  it('maps an owner kill termination to `killed`', () => {
    expect(deriveHeavyOpErrorCategory({ termination: 'killed' })).toBe('killed');
  });

  it('maps a queue cancel termination to `cancelled_before_dispatch`', () => {
    expect(
      deriveHeavyOpErrorCategory({ termination: 'cancelled_before_dispatch' }),
    ).toBe('cancelled_before_dispatch');
  });

  it('maps a `silent_cap` stall telemetry to `timeout`', () => {
    expect(
      deriveHeavyOpErrorCategory({ errors: [heavyOpErr('silent_cap')] }),
    ).toBe('timeout');
  });

  it('maps a `no_progress` stall telemetry to `stalled`', () => {
    expect(
      deriveHeavyOpErrorCategory({ errors: [heavyOpErr('no_progress')] }),
    ).toBe('stalled');
  });

  it('returns undefined for an ordinary failure (no termination, no heavy_op)', () => {
    expect(
      deriveHeavyOpErrorCategory({ errors: [{ details: { code: 'NETWORK_ERROR' } }] }),
    ).toBeUndefined();
  });

  it('returns undefined with no signals at all', () => {
    expect(deriveHeavyOpErrorCategory({})).toBeUndefined();
    expect(deriveHeavyOpErrorCategory({ errors: [] })).toBeUndefined();
  });

  it('an owner termination wins over a stall telemetry on the same run', () => {
    expect(
      deriveHeavyOpErrorCategory({
        termination: 'killed',
        errors: [heavyOpErr('silent_cap')],
      }),
    ).toBe('killed');
  });

  it('ignores a heavy_op with a null / unknown kill_reason', () => {
    expect(deriveHeavyOpErrorCategory({ errors: [heavyOpErr(null)] })).toBeUndefined();
    expect(
      deriveHeavyOpErrorCategory({ errors: [heavyOpErr('oom')] }),
    ).toBeUndefined();
  });

  it('finds the telemetry on a later error when the first carries none', () => {
    expect(
      deriveHeavyOpErrorCategory({
        errors: [{ details: { code: 'NETWORK_ERROR' } }, heavyOpErr('no_progress')],
      }),
    ).toBe('stalled');
  });

  it('tolerates a malformed (non-object) heavy_op without throwing', () => {
    expect(
      deriveHeavyOpErrorCategory({ errors: [{ details: { heavy_op: 'oops' } }] }),
    ).toBeUndefined();
    expect(
      deriveHeavyOpErrorCategory({ errors: [{ details: { heavy_op: null } }] }),
    ).toBeUndefined();
    expect(deriveHeavyOpErrorCategory({ errors: [{}] })).toBeUndefined();
  });
});

const slotCancelledErr = () => ({ details: { slot_cancelled: true } });
const otherErr = () => ({ details: { code: 'NETWORK_ERROR' } });

describe('deriveRunTermination (D-181 §7c — cancel-marker root fix)', () => {
  it('honors a registry kill marker regardless of outcome', () => {
    expect(deriveRunTermination({ killed: true, success: false })).toBe('killed');
    // even on a run that completed before the abort was observed
    expect(deriveRunTermination({ killed: true, success: true })).toBe('killed');
  });

  it('derives cancelled from a failure carrying the slot_cancelled marker (sequential cancel)', () => {
    expect(
      deriveRunTermination({ killed: false, success: false, errors: [slotCancelledErr()] }),
    ).toBe('cancelled_before_dispatch');
  });

  it('does NOT label a failure that carries no slot_cancelled marker (residual-a fix)', () => {
    // a swallowed prefetch cancel + a LATER unrelated failure → labeled by the
    // real error, NOT cancelled.
    expect(
      deriveRunTermination({ killed: false, success: false, errors: [otherErr()] }),
    ).toBeUndefined();
  });

  it('does NOT label a SUCCESS as cancelled (a swallowed cancel left no error)', () => {
    expect(deriveRunTermination({ killed: false, success: true, errors: [] })).toBeUndefined();
  });

  it('kill takes precedence over a slot_cancelled error (kill of a queued call)', () => {
    expect(
      deriveRunTermination({ killed: true, success: false, errors: [slotCancelledErr()] }),
    ).toBe('killed');
  });

  it('finds the slot_cancelled marker on any error in the list', () => {
    expect(
      deriveRunTermination({ killed: false, success: false, errors: [otherErr(), slotCancelledErr()] }),
    ).toBe('cancelled_before_dispatch');
  });

  it('no signals → undefined', () => {
    expect(deriveRunTermination({ killed: false, success: false })).toBeUndefined();
    expect(deriveRunTermination({ killed: false, success: false, errors: [] })).toBeUndefined();
  });
});
