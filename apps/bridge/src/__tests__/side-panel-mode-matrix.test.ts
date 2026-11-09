/** What a reviewer SEES at each per-bridge notification mode — the full matrix.
 *
 *  ⛔⛔ WRITTEN BECAUSE THIS WAS ANSWERED WRONG TWICE, IN OPPOSITE DIRECTIONS,
 *  during one conversation about a Chrome Web Store submission. First "the modes
 *  gate OS notifications only, the panel renders regardless"; then, correcting
 *  off a `service-worker-bootstrap.ts` comment about gating "approval-card
 *  rendering", "with approval off the panel shows nothing". Both wrong, and the
 *  second one would have sent the submission down a runbook it did not need —
 *  handing a reviewer the realm's recovery key to flip a toggle.
 *
 *  🔑 THE TRUTH IS NEITHER: the sections stay VISIBLE and the copy NAMES THE
 *  REMEDY. `approval` decides whether rows are ANSWERABLE; `notification` swaps
 *  the notifications body for an opt-in card. "Nothing silently disappears" is
 *  an owner decision recorded at both call sites, and it is the whole reason the
 *  panel is self-explaining rather than blank.
 *
 *  ⚠ SCOPE, STATED HONESTLY. This pins WHICH BRANCH each mode selects. It does
 *  not render, and it therefore proves nothing about the pixels — this repo has
 *  no jsdom, and a fake-document big enough for `views.ts` +
 *  `@recued/ui-shared/approval-card` would make the shim the thing under test.
 *  A real extension against a real server is still the only thing that proves
 *  the rendered result; that check is open on purpose, not forgotten. */

import { describe, expect, it } from 'vitest';

import {
  activeRowsAreControllable,
  approvalsBody,
  bridgeModeFlags,
  notificationsBody,
} from '../side-panel/mode-gates.js';

/** The four mode combinations a paired bridge can be in. `[notification, approval]` */
const MODES: ReadonlyArray<readonly [boolean, boolean]> = [
  [false, false], // a fresh pair — the reviewer's arrival state
  [true, false],
  [false, true],
  [true, true],
];

describe('the per-bridge mode matrix — what a reviewer sees', () => {
  it('a fresh pair is both-off, and null is both-off rather than unknown', () => {
    // ⛔ FAIL-CLOSED IS THE POINT. `null` means "not a recognised paired
    // bridge"; treating it as unknown-and-therefore-permissive would render an
    // interactive approval card the server never authorised.
    expect(bridgeModeFlags(null)).toEqual({ notification: false, approval: false });
    expect(bridgeModeFlags(undefined)).toEqual({ notification: false, approval: false });
    expect(bridgeModeFlags({ notification: false, approval: false }))
      .toEqual({ notification: false, approval: false });
    expect(bridgeModeFlags({ notification: true, approval: true }))
      .toEqual({ notification: true, approval: true });
  });

  describe('approvals — the section a listing screenshot shows', () => {
    it('⛔ WITH A PENDING ASK AND approval OFF, THE ROW STILL RENDERS — read-only', () => {
      // This is the claim that was wrong in both directions. The ask is
      // VISIBLE; it is simply not answerable.
      expect(approvalsBody({ error: null, itemCount: 1, loading: false, canAnswer: false }))
        .toBe('read-only');
    });

    it('with approval ON the same ask becomes answerable', () => {
      expect(approvalsBody({ error: null, itemCount: 1, loading: false, canAnswer: true }))
        .toBe('interactive');
    });

    it('interactive requires BOTH an item and the handler', () => {
      // Neither alone is enough: no item → nothing to answer; no handler → the
      // bridge does not hold `bridge_mode.approval`.
      expect(approvalsBody({ error: null, itemCount: 0, loading: false, canAnswer: true }))
        .toBe('empty');
      expect(approvalsBody({ error: null, itemCount: 1, loading: false, canAnswer: false }))
        .toBe('read-only');
    });

    it('2026-11-04 — empty with the mode ON says nothing waits, never to turn on what is on', () => {
      // Approvals lead the panel now, so the empty state is the first thing an
      // owner reads when nothing waits; it used to tell them to enable the mode
      // this bridge already holds.
      expect(approvalsBody({ error: null, itemCount: 0, loading: false, canAnswer: true })).toBe('empty');
    });

    it('empty-with-mode-off names the remedy rather than showing a blank', () => {
      // The copy at the call site is "No pending approvals. Enable Approval mode
      // in Settings → Notifications to opt in." — which is why a reviewer with
      // the mode off is not left guessing, and why the review notes matter less
      // than the second wrong answer implied.
      expect(approvalsBody({ error: null, itemCount: 0, loading: false, canAnswer: false }))
        .toBe('empty-opt-in');
    });

    it('distinguishes loading from empty, so "nothing yet" is not read as "none"', () => {
      expect(approvalsBody({ error: null, itemCount: 0, loading: true, canAnswer: false }))
        .toBe('loading');
      expect(approvalsBody({ error: null, itemCount: 0, loading: true, canAnswer: true }))
        .toBe('loading');
    });

    it('an error out-ranks everything here — approvals are never withheld silently', () => {
      for (const [, approval] of MODES) {
        expect(approvalsBody({
          error: 'boom', itemCount: 3, loading: false, canAnswer: approval,
        })).toBe('error');
      }
    });
  });

  describe('notifications — visible when off, not hidden', () => {
    it('⛔ OFF IS A VISIBLE OPT-IN CARD, NOT A MISSING SECTION', () => {
      expect(notificationsBody({ enabled: false, error: null, itemCount: 0, loading: false }))
        .toBe('off');
      // Items present makes no difference: while off, live items are suppressed.
      expect(notificationsBody({ enabled: false, error: null, itemCount: 5, loading: false }))
        .toBe('off');
    });

    it('⛔ THE MODE OUT-RANKS AN ERROR — an error must not leak past the gate', () => {
      // Letting a load error through while off would surface exactly the traffic
      // the mode exists to withhold, and would read as a broken extension.
      expect(notificationsBody({ enabled: false, error: 'boom', itemCount: 0, loading: false }))
        .toBe('off');
    });

    it('undefined renders normally — the renderer default, not a third state', () => {
      // The mount always passes the flag explicitly and it is `false` until the
      // self-scoped fetch lands, so this default is only ever seen by a direct
      // caller. It must not be confused with `false`.
      expect(notificationsBody({ enabled: undefined, error: null, itemCount: 2, loading: false }))
        .toBe('items');
      expect(notificationsBody({ enabled: undefined, error: null, itemCount: 0, loading: false }))
        .toBe('empty');
    });

    it('with the mode ON it behaves like any other list section', () => {
      expect(notificationsBody({ enabled: true, error: null, itemCount: 2, loading: false }))
        .toBe('items');
      expect(notificationsBody({ enabled: true, error: null, itemCount: 0, loading: true }))
        .toBe('loading');
      expect(notificationsBody({ enabled: true, error: null, itemCount: 0, loading: false }))
        .toBe('empty');
      expect(notificationsBody({ enabled: true, error: 'boom', itemCount: 0, loading: false }))
        .toBe('error');
    });
  });

  describe('active executions — the same gate, the same fallback', () => {
    it('controls follow bridge_mode.approval, and its absence is a read-only mirror', () => {
      expect(activeRowsAreControllable({ canControl: true })).toBe(true);
      expect(activeRowsAreControllable({ canControl: false })).toBe(false);
    });
  });

  describe('the whole matrix, as a reviewer would meet it', () => {
    it.each(MODES)(
      'notification=%s approval=%s selects one coherent pair of bodies',
      (notification, approval) => {
        const flags = bridgeModeFlags({ notification, approval });
        const notifications = notificationsBody({
          enabled: flags.notification, error: null, itemCount: 3, loading: false,
        });
        const approvals = approvalsBody({
          error: null, itemCount: 1, loading: false, canAnswer: flags.approval,
        });

        expect(notifications).toBe(notification ? 'items' : 'off');
        expect(approvals).toBe(approval ? 'interactive' : 'read-only');
        // 🔑 THE HEADLINE: in NO combination does a section vanish or read
        // empty while content exists. Both axes always land on a body that
        // shows something — which is what makes the panel self-explaining, and
        // what the two earlier wrong answers each missed from opposite sides.
        expect(['off', 'items']).toContain(notifications);
        expect(['read-only', 'interactive']).toContain(approvals);
      },
    );
  });
});
