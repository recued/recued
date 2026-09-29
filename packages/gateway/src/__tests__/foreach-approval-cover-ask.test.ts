/** A held `foreach` step: ONE approval runs every remaining item, so the ask
 *  says how many and lists them (found live: approving "send the minutes to
 *  Dana" mailed the whole list, and the ask named Dana alone).
 *
 *  These assert the BODY and TITLE — what a person reads — for the three shapes
 *  a cover arrives in: listed, count-only (an upper bound), and malformed
 *  (read back from a checkpoint; it must degrade, never lose the hold). */

import { describe, expect, it } from 'vitest';
import type { Checkpoint } from '@recued/contracts';
import {
  buildPreflightAsk,
  type PreflightAskContext,
} from '../preflight-reconciliation.js';

const checkpoint = (): Checkpoint => ({
  checkpoint_id: 'checkpoint-1',
  run_id: 'run-1',
  recipe_id: 'mail-meeting-minutes',
  gated_step_id: 'send',
  step_state: {},
  created_at: 0,
});

const ask = (overrides: Partial<PreflightAskContext> = {}) =>
  buildPreflightAsk({
    checkpoint: checkpoint(),
    context: {
      recipe_id: 'mail-meeting-minutes',
      gated_step_id: 'send',
      tool_slug: 'mail-send',
      risk_tier: 'write',
      ...overrides,
    },
  }).message;

const item = (to: string) => ({
  summary: `to: ${to}`,
  args_preview: { to: [to], subject: 'Minutes — Harbour fit-out' },
});

describe('the ask for a held foreach', () => {
  it('lists every recipient, says the subject once, and asks about all of them', () => {
    const { title, text } = ask({
      foreach_cover: {
        total: 3,
        items: [item('dana@x.example'), item('priya@x.example'), item('omar@x.example')],
      },
    });
    expect(title).toContain('Approve 3 ×');
    expect(text).toContain('for 3 items (step send). One approval covers them all.');
    for (const to of ['dana@x.example', 'priya@x.example', 'omar@x.example']) {
      expect(text).toContain(to);
    }
    // The common field is said once, not three times.
    expect(text.split('Minutes — Harbour fit-out').length - 1).toBe(1);
    expect(text.trimEnd().endsWith('Approve all 3?')).toBe(true);
  });

  it('without the list, the count is an upper bound and is worded as one', () => {
    const { title, text } = ask({ foreach_cover: { total: 5 } });
    expect(title).toContain('Approve up to 5 ×');
    expect(text).toContain('for up to 5 items (step send). One approval covers them all.');
    expect(text.trimEnd().endsWith('Approve all of them?')).toBe(true);
  });

  it('a malformed cover read back from a checkpoint degrades to the single-call ask', () => {
    for (const broken of [
      { total: 1 },
      { total: 'three' },
      null,
    ]) {
      const { text } = ask({ foreach_cover: broken as never });
      expect(text).toContain('(step send).');
      expect(text).not.toContain('items (step');
      expect(text.trimEnd().endsWith('Approve?')).toBe(true);
    }
    // A list that is broken, or does not match its total, is not shown; a sound
    // count still is.
    for (const items of ['nope', [item('dana@x.example')]]) {
      const { text } = ask({ foreach_cover: { total: 3, items } as never });
      expect(text).toContain('for up to 3 items');
      expect(text).not.toContain('dana@x.example');
    }
  });

  it('a batch-registered ask ignores a cover (one member is one call)', () => {
    const { text } = ask({
      foreach_cover: { total: 3 },
      batch: {
        batch_id: 'b1',
        payload_version: 1,
        items: [{ member_id: 'm1', canonical_payload_hash: 'h', summary: 'to: dana@x.example' }],
        unit: { kind: 'run', id: 'run-1' },
      },
    });
    expect(text).not.toContain('items (step');
  });
});
