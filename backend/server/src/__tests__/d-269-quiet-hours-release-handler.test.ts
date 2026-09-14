/** D-269 REV 20 — what the release edge actually does, now that it can be run.
 *
 *  ⛔⛔ THIS FILE EXISTS BECAUSE A MUTATION PASSED. No-opping the entire release
 *  callback — the held-ask re-delivery AND the card — left 150 tests green. The
 *  body was an inline closure inside the boot path, so reaching it meant booting
 *  a server, and nothing did. **Step 5's whole promise — an approval held
 *  overnight arrives when the window lifts — was unverified.** */

import { describe, expect, it } from 'vitest';
import type { QuietHoursDigest } from '@recued/contracts';
import { buildQuietHoursReleaseHandler } from '../quiet-hours-release-handler.js';

const digest = (): QuietHoursDigest => ({
  from: Date.parse('2026-06-15T22:00:00Z'),
  to: Date.parse('2026-06-16T08:00:00Z'),
  still_ahead: [{ kind: 'task', id: 't-1', title: 'file the return', anchor_at: Date.parse('2026-06-16T10:00:00Z') }],
  already_passed: 1,
});

const spy = () => {
  const calls: string[] = [];
  const handler = buildQuietHoursReleaseHandler({
    recoverPendingAsks: async () => { calls.push('recover'); },
    notify: async (m) => { calls.push(`notify:${m.title}`); },
    timeZone: 'UTC',
  });
  return { calls, handler };
};

describe('D-269 — the release edge re-delivers held asks AND sends the card', () => {
  it('⛔⛔ BOTH happen — neither is the other one', async () => {
    const { calls, handler } = spy();
    handler(digest());
    await Promise.resolve(); await Promise.resolve();
    expect(calls).toContain('recover');
    expect(calls).toContain('notify:While you were away');
  });

  it('⛔ RE-DELIVERY FIRST — the order is a promise to the reader', async () => {
    // An owner who reads the digest and opens their prompts must find them
    // already there. Reversed, the card points at prompts not yet re-sent.
    const { calls, handler } = spy();
    handler(digest());
    await Promise.resolve(); await Promise.resolve();
    expect(calls.indexOf('recover')).toBeLessThan(calls.indexOf('notify:While you were away'));
  });

  /** ⛔⛔ WHAT THE TWO `.catch()` CALLS ACTUALLY BUY, which my first pass got
   *  wrong. They do NOT stop the card being sent (the two statements are
   *  independent, so the card goes out either way) and they do NOT stop a
   *  synchronous throw (`notify` is async — it returns a REJECTED PROMISE
   *  rather than throwing). What they stop is an **unhandled rejection**, which
   *  on a modern Node default terminates the process running the housekeeping
   *  cycle. ⇒ The probe has to be an unhandled-rejection listener; a
   *  `not.toThrow()` passes with the catch removed, and did. */
  const withoutUnhandled = async (run: () => void): Promise<unknown[]> => {
    const seen: unknown[] = [];
    const onRejection = (reason: unknown): void => { seen.push(reason); };
    process.on('unhandledRejection', onRejection);
    try {
      run();
      // Two macrotask turns: a rejection is reported after the microtask queue
      // drains, not on the next `await`.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    return seen;
  };

  it('⛔ a re-delivery failure is SWALLOWED, not left unhandled', async () => {
    const calls: string[] = [];
    const seen = await withoutUnhandled(() => {
      buildQuietHoursReleaseHandler({
        recoverPendingAsks: async () => { throw new Error('channel down'); },
        notify: async (m) => { calls.push(m.title); },
      })(digest());
    });
    expect(seen).toEqual([]);
    // …and the card still goes out, because the two are independent.
    expect(calls).toEqual(['While you were away']);
  });

  it('⛔ and a card that cannot be delivered is swallowed too', async () => {
    // Housekeeping runs this; an unhandled rejection here takes the cycle — and
    // on a default Node, the process — with it.
    const seen = await withoutUnhandled(() => {
      buildQuietHoursReleaseHandler({
        recoverPendingAsks: async () => {},
        notify: async () => { throw new Error('no channel'); },
      })(digest());
    });
    expect(seen).toEqual([]);
  });

  it('⚠ the card carries the digest, not a generic "you have messages"', async () => {
    const bodies: string[] = [];
    buildQuietHoursReleaseHandler({
      recoverPendingAsks: async () => {},
      notify: async (m) => { bodies.push(m.text); },
      timeZone: 'UTC',
    })(digest());
    await Promise.resolve(); await Promise.resolve();
    expect(bodies[0]).toContain('file the return');
  });
});
