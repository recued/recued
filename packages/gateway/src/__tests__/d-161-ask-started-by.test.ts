/** D-161 Part B (display) — the approval ask names WHO STARTED a door-origin run.
 *
 *  ⛔ **The taint layer is why these holds exist, and the ask never said so.**
 *  An outside-origin run cannot ride a standing grant — that is the guarantee
 *  `reception-recipe-runner.ts` states, and it is the reason a stranger's form
 *  submission reaches the owner as an approval at all. Yet the body opened
 *  *"Recipe r wants to run x on y (step s)"* whether the owner typed the
 *  request at a paired device or an anonymous visitor posted a public form.
 *  Nothing else on the ask recovers the difference: the operation, the target
 *  and the argument values are identical in both cases.
 *
 *  ⚠ The ABSENCE is load-bearing too. The owner's own runs are the
 *  overwhelming majority, and a "Started by: you" on every ask is noise a
 *  reader learns to skip — which costs exactly the one ask that needed it.
 *
 *  Spec: D-161 § N.7 / A.5; the public page is
 *  `recued-docs/content/concepts/untrusted-input.md`.
 */

import { describe, it, expect } from 'vitest';
import type { Checkpoint, PreflightCheckpointContext } from '@recued/contracts';
import {
  buildPreflightAsk,
  type PreflightAskContext,
} from '../preflight-reconciliation.js';

const NOW = Date.parse('2026-09-11T12:00:00.000Z');

const checkpoint = (
  preflight_context?: PreflightCheckpointContext,
): Checkpoint => ({
  checkpoint_id: 'checkpoint-1',
  run_id: 'run-1',
  recipe_id: 'intake-then-email',
  gated_step_id: 'send',
  step_state: {},
  created_at: NOW,
  ...(preflight_context !== undefined ? { preflight_context } : {}),
});

const context: PreflightAskContext = {
  recipe_id: 'intake-then-email',
  gated_step_id: 'send',
  tool_slug: 'mail.send',
  connection_name: 'work-mail',
  risk_tier: 'write',
};

const bodyFor = (preflight_context?: PreflightCheckpointContext): string =>
  buildPreflightAsk({ checkpoint: checkpoint(preflight_context), context })
    .message.text;

/** The `Started by:` line, or undefined — read off the rendered body the way a
 *  reader's eye would, so the assertions below cannot pass on a line that is
 *  present but indented into the argument payload. */
const startedByLine = (text: string): string | undefined =>
  text.split('\n').find((line) => line.trimStart().startsWith('Started by:'));

describe('D-161 — the ask says who started a door-origin run', () => {
  it('names an anonymous visitor who came through a public door', () => {
    expect(bodyFor({ origin_actor: 'anonymous' })).toContain(
      'Started by: someone outside this server, through a public door.',
    );
  });

  it('names a delegated outside AI', () => {
    expect(bodyFor({ origin_actor: 'contracted_user' })).toContain(
      'Started by: an outside AI, through a door you opened.',
    );
  });

  it("says nothing on the owner's own run", () => {
    // The host writes `origin_actor` ONLY for a door dispatch, so the owner's
    // own run reaches here with the field absent. No line, no noise.
    expect(startedByLine(bodyFor())).toBeUndefined();
    expect(bodyFor()).not.toContain('Started by');
  });

  it('says nothing for an actor it does not recognise', () => {
    // ⛔ THE WIDENED-STRING CONTRACT, OBSERVED FROM THE RENDER SIDE.
    // `origin_actor` is typed `string` rather than `Actor` so that a value
    // written by a newer binary can never make `isCheckpoint` reject the
    // checkpoint — a rejected checkpoint is a pending approval the owner
    // LOSES. That only holds if the renderer completes it by staying silent
    // instead of printing a bare enum member at someone deciding whether to
    // approve a real action.
    expect(startedByLine(bodyFor({ origin_actor: 'some_future_actor' })))
      .toBeUndefined();
    expect(bodyFor({ origin_actor: 'some_future_actor' }))
      .not.toContain('some_future_actor');
  });

  it('emits the line FLUSH-LEFT, never indented', () => {
    // ⛔ THE INDENT IS THE CONTRACT. `projectGeneratedApprovalAsk` reads an
    // indented `key: value` line as an operation ARGUMENT — so an indented
    // `Started by:` would be filed among the values the agent actually sent,
    // in a disclosure the reviewer may never open. Asserting `toContain`
    // alone cannot see the difference; this can.
    const line = startedByLine(bodyFor({ origin_actor: 'anonymous' }));
    expect(line).toBeDefined();
    expect(line).toBe(line!.trimStart());
    expect(line).not.toMatch(/^\s/);
  });

  it('leaves the opening sentence untouched, so the card still projects', () => {
    // ⛔ THE REGRESSION THIS GUARDS. The card's whole projection is gated on
    // line 0 matching `^Recipe (.+?) wants to run …`. Had the new sentence
    // been PREPENDED rather than inserted after it, every generated approval
    // in the queue and the Bridge panel would silently fall back to raw text
    // — no summary, no highlights, no Technical details — and the ask would
    // still "contain" the words this suite looks for.
    const first = bodyFor({ origin_actor: 'anonymous' }).split('\n')[0]!;
    expect(first).toMatch(
      /^Recipe (.+?) wants to run (.+?)(?: on (.+?))? \(step (.+?)\)\.$/,
    );
  });

  it('keeps the question last, after the new line', () => {
    // The owner answers buttons attached to the closing question; a line that
    // landed after it would put evidence below the thing it qualifies.
    const text = bodyFor({ origin_actor: 'anonymous' });
    expect(text.indexOf('Started by:')).toBeLessThan(text.indexOf('Approve?'));
    expect(text.trimEnd().endsWith('Approve?')).toBe(true);
  });
});
