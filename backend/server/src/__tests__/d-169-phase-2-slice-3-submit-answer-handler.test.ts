/** D-169 P2 Slice 3 — `notification.submitAnswer` handler tests.
 *
 *  Pure-handler tests for the approval-card submit funnel: it forwards a
 *  well-formed (ask_id, option_id) into the injected block thunk, no-ops
 *  gracefully when the dep is absent (partially-composed boot) or the
 *  payload is malformed, and always resolves `{ ok: true }` (the rpc
 *  acknowledges receipt; the block hides the answer outcome, D-158 I-10).
 *  The WS / rpc transport is exercised by the bridge SW harness test. */

import { describe, expect, it, vi } from 'vitest';

import { handleSubmitAnswer, type HistoryDeps } from '../history-handler.js';

describe('D-169 P2 Slice 3 — handleSubmitAnswer', () => {
  it('forwards a well-formed answer into the block thunk', async () => {
    const submitAnswer = vi.fn(async () => {});
    const deps: HistoryDeps = { submitAnswer };
    const out = await handleSubmitAnswer(deps, {
      ask_id: 'ask-1',
      option_id: 'yes',
    });
    expect(out).toEqual({ ok: true });
    expect(submitAnswer).toHaveBeenCalledTimes(1);
    expect(submitAnswer).toHaveBeenCalledWith('ask-1', 'yes');
  });

  it('D-234 § 234.4e — forwards a written reason, and OMITS the argument without one', async () => {
    // ⛔ ARITY IS THE ASSERTION. Passing `undefined` explicitly would satisfy any
    // "note is not forwarded" check written as a value comparison while still
    // calling a 2-arg dep with 3 arguments — which is exactly the regression that
    // reddened the case above.
    const submitAnswer = vi.fn(async () => {});
    const deps: HistoryDeps = { submitAnswer };

    await handleSubmitAnswer(deps, { ask_id: 'ask-1', option_id: 'no', note: 'too firm' });
    expect(submitAnswer).toHaveBeenLastCalledWith('ask-1', 'no', 'too firm');

    // A blank note is the third spelling of absent (the textarea was rendered
    // and left empty), and must not travel as an empty string.
    await handleSubmitAnswer(deps, { ask_id: 'ask-1', option_id: 'no', note: '' });
    expect(submitAnswer).toHaveBeenLastCalledWith('ask-1', 'no');
    expect(submitAnswer.mock.calls.at(-1)).toHaveLength(2);
  });

  it('no-ops + resolves { ok: true } when the submitAnswer dep is absent', async () => {
    // Partially-composed boot (no notification block): the rpc must still
    // resolve, matching the read handlers' graceful-absent `[]` posture.
    const out = await handleSubmitAnswer({}, { ask_id: 'ask-1', option_id: 'yes' });
    expect(out).toEqual({ ok: true });
  });

  it('guards malformed / empty ids — never reaches the block', async () => {
    const submitAnswer = vi.fn(async () => {});
    const deps: HistoryDeps = { submitAnswer };
    // Empty strings + non-string payloads (a malformed wire frame) must not
    // reach the ask store with a bad key; each is a silent { ok: true } no-op.
    const bad: unknown[] = [
      { ask_id: '', option_id: 'yes' },
      { ask_id: 'ask-1', option_id: '' },
      { ask_id: 42, option_id: 'yes' },
      { ask_id: 'ask-1', option_id: null },
      { ask_id: undefined, option_id: undefined },
      // Non-object `req` shapes (Codex Slice-3 LOW-1): a malformed wire frame
      // whose args aren't an object must no-op, not throw on the `.ask_id`
      // read. `null` / `undefined` would throw without the `args != null`
      // guard; a primitive reads `.ask_id` as undefined.
      null,
      undefined,
      42,
      'not-an-object',
    ];
    for (const req of bad) {
      const out = await handleSubmitAnswer(
        deps,
        req as unknown as { ask_id: string; option_id: string },
      );
      expect(out).toEqual({ ok: true });
    }
    expect(submitAnswer).not.toHaveBeenCalled();
  });

  it('propagates a block-thunk rejection (the rpc layer surfaces it)', async () => {
    // The wire thunk over `block.submitAnswer` should not normally reject
    // (the block swallows handler failures), but if the thunk itself throws
    // — e.g. a store write error — the handler does not swallow it: the rpc
    // surfaces the error so the client's card can re-enable + retry.
    const submitAnswer = vi.fn(async () => {
      throw new Error('store write failed');
    });
    await expect(
      handleSubmitAnswer({ submitAnswer }, { ask_id: 'ask-1', option_id: 'yes' }),
    ).rejects.toThrow('store write failed');
  });
});
