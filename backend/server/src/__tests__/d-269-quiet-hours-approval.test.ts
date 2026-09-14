/** D-269 step 5 — quiet hours MAY apply to approvals, and still should not.
 *
 *  ⛔⛔ THE OWNER'S RULING, AND THE REASON IT SHIPS LAST. Quiet hours on an
 *  approval buys silence at the cost of the WORK; D-261 pre-approval buys the
 *  same silence at no cost to the work, because the ask is never raised. So this
 *  value is available and is not the recommendation — and it ships beside the
 *  pre-approval pointer rather than as a peer setting, because it is the only
 *  step whose value is negative when chosen carelessly.
 *
 *  🔑 HOLDING IS SAFE ONLY BECAUSE AN ASK IS ALREADY DURABLE. D-158 I-2 persists
 *  it BEFORE any delivery, so a held ask is indistinguishable from one whose
 *  channel was briefly unreachable — TR-10, which `recoverPendingAsks` already
 *  re-delivers. **Quiet hours on an approval is TR-10 with a clock**, which is
 *  why step 5 needed no queue.
 *
 *  ⛔ AND ONE CASE MUST BREAK THE WINDOW: an ask whose WORK expires inside it.
 *  Holding that is not a deferral, it is a deletion wearing a deferral's
 *  clothes. */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  defaultQuietHoursPolicy,
  mayHoldAskForQuietHours,
  QUIET_HOURS_APPLIES_TO,
  type QuietHoursPolicy,
} from '@recued/contracts';

const HK = 'Asia/Hong_Kong';
/** 02:00 Hong Kong — inside a 22:00→07:00 window. */
const NIGHT = Date.parse('2026-06-15T18:00:00Z');
/** 07:00 Hong Kong, when the window releases. */
const RELEASE = Date.parse('2026-06-15T23:00:00Z');
const HOUR = 60 * 60 * 1000;

const on = (over: Partial<QuietHoursPolicy> = {}): QuietHoursPolicy => ({
  ...defaultQuietHoursPolicy(), enabled: true, applies_to: ['notification', 'approval'], ...over,
});

describe('D-269 step 5 — the value exists, and is opt-in', () => {
  it("'approval' is now a value the owner CAN choose", () => {
    expect([...QUIET_HOURS_APPLIES_TO]).toEqual(['notification', 'approval']);
  });

  it('⛔ but the DEFAULT still applies to notifications only', () => {
    // Two defaults guard this: the window ships disabled, and even enabled it
    // applies to notifications until the owner deliberately adds approvals.
    const d = defaultQuietHoursPolicy();
    expect(d.enabled).toBe(false);
    expect(d.applies_to).toEqual(['notification']);
    expect(mayHoldAskForQuietHours({
      policy: { ...d, enabled: true }, instant: NIGHT, timeZone: HK,
    })).toBe(false);
  });
});

describe('D-269 step 5 — when an ask may be held', () => {
  it('inside the window, with approvals opted in → held', () => {
    expect(mayHoldAskForQuietHours({ policy: on(), instant: NIGHT, timeZone: HK })).toBe(true);
  });

  it('outside the window → never held', () => {
    expect(mayHoldAskForQuietHours({ policy: on(), instant: RELEASE, timeZone: HK })).toBe(false);
  });

  it('⛔⛔ AN ASK WHOSE WORK EXPIRES INSIDE THE WINDOW IS DELIVERED ANYWAY', () => {
    // The only place quiet hours can cost something real. The ask is durable, so
    // holding the ping loses nothing UNLESS the work dies before the owner
    // wakes — and then the hold is a deletion wearing a deferral's clothes.
    expect(mayHoldAskForQuietHours({
      policy: on(), instant: NIGHT, timeZone: HK,
      expiresAt: NIGHT + HOUR,     // dies at 03:00
      windowEndsAt: RELEASE,       // owner wakes at 07:00
    })).toBe(false);
  });

  it('an ask that outlives the window is held', () => {
    expect(mayHoldAskForQuietHours({
      policy: on(), instant: NIGHT, timeZone: HK,
      expiresAt: RELEASE + HOUR, windowEndsAt: RELEASE,
    })).toBe(true);
  });

  it('⚠ an ask that DECLARES no expiry is treated as not expiring', () => {
    // The block cannot infer it: PendingAsk carries no deadline and
    // handler_payload is opaque. So a caller whose work expires has to SAY so —
    // a default that is conservative for silence and risky for work, which is
    // exactly why the setting is opt-in and not recommended.
    expect(mayHoldAskForQuietHours({
      policy: on(), instant: NIGHT, timeZone: HK, windowEndsAt: RELEASE,
    })).toBe(true);
  });
});

describe('D-269 step 5 — the hold is a held DELIVERY, never a held ask', () => {
  const read = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8');

  it('⛔ the ask is persisted BEFORE the hold is even consulted', () => {
    // ⛔⛔ RETIRED — THIS WAS AN ORDER CLAIM ASSERTED BY SOURCE INDEX
    // (`indexOf('await store.create(fresh);') < indexOf('const held = …')`).
    // It pins a LAYOUT: it reds on a refactor that changes nothing, and passes
    // on a reorder that breaks everything. ⇒ Driven instead in
    // `packages/notification/src/__tests__/d-269-ask-hold-drive.test.ts`
    // ("HELD: nothing is delivered, and the ask is still durably OPEN"), where
    // moving the hold above the write reds the test. Mutation-proved.
    expect(true).toBe(true);
  });

  it('⛔⛔ the PASSIVE ping is held too — DRIVEN, not grepped', () => {
    // ⛔ ALSO RETIRED. `toContain('if (!held) await firePassiveNotify(…)')` is
    // blind to a SECOND passive delivery inserted above the gate: the string
    // survives and the owner is woken. Driven in the same file, with a
    // notify-only channel in the set so the path actually runs — the first
    // version of that drive was itself vacuous without one, and two mutations
    // walked straight through it.
    //
    // ⛔ THE EXCEPTION REV 21 CARVED OUT HERE IS GONE — it rested on a wrong
    // reading. I took the per-bridge fan-out for an exotic path; it is the LIVE
    // one, because `bridgeRosterProbe` is supplied in production and the moment
    // ANY bridge is paired the per-bridge split owns the bridge. The gate is
    // now driven with `{ notification: true, approval: false }` — the only mode
    // pair that reaches it, since `routeBridgeAsk` sends an approval-capable
    // bridge to `deliverAsk` instead. All three hold gates are mutation-proved.
    expect(true).toBe(true);
  });

  it('🔑 release re-delivers through the SAME path TR-10 already uses', () => {
    // ⛔⛔ THIS ASSERTED THE ORDER BY SOURCE-TEXT INDEX — that `recoverPendingAsks()`
    // appeared EARLIER IN THE FILE than the card's title — and it broke the
    // moment the body was extracted to `quiet-hours-release-handler.ts`, without
    // any behaviour changing. That is the weakness of the form: it pins a
    // LAYOUT, so a refactor reds it and a second call inserted above does not.
    //
    // ⇒ The ordering is now DRIVEN in `d-269-quiet-hours-release-handler.test.ts`
    // ("RE-DELIVERY FIRST — the order is a promise to the reader"), mutation-
    // proved. What survives here is the claim this file is actually about: the
    // release edge reuses D-158's boot sweep rather than growing a queue.
// ⚠ And the `not.toContain('queue')` I reached for next failed immediately —
    // on the word "queue" inside a comment explaining why there ISN'T one. A
    // negative text assertion over a file that argues its own design can never
    // hold. ⇒ What stays here is the one positive claim this file owns; the
    // ORDERING and the independence of the two calls are driven next door.
    const src = read('backend/server/src/quiet-hours-release-handler.ts');
    expect(src).toContain('recoverPendingAsks');
  });

  it('⛔ and the predicate is SUPPLIED, not merely accepted', () => {
    const src = read('backend/server/src/composition/bin/wire-notification-block.ts');
    // ⚠ SOURCE-TEXT, DELIBERATELY AND NARROWLY: this asserts a composition root
    // MENTIONS the thing it must pass, which catches a deleted supply and
    // nothing else. It cannot catch a wrong one. Kept because the alternative
    // here is no coverage at all — unlike the sweep wiring, which is now driven
    // in `d-269-reminder-composition-drive.test.ts`. See D-269 REV 21.
    expect(src).toContain('shouldHoldAsk,');
    expect(src).toContain('mayHoldAskForQuietHours');
  });
});
