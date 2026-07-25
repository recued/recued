/** D-145 PB6 — confidence-tier dispatch tests.
 *
 *  Covers § B.7.7 (per-event dispatch over high / medium / low),
 *  § B.7.9 (per-event undo token derivation; per-source-message
 *  independent counters). */

import { describe, expect, it } from 'vitest';

import type { ExtractionEvent } from '@recued/contracts';

import {
  buildUndoToken,
  dispatchEvents,
} from '../ai-output/dispatch.js';

const ev = (
  kind: ExtractionEvent['kind'],
  confidence: number,
  source_message_id?: string,
): ExtractionEvent => ({
  kind,
  confidence,
  args: {},
  ...(source_message_id !== undefined ? { source_message_id } : {}),
});

describe('D-145 PB6 — buildUndoToken', () => {
  it('uses `s:<source_message_id>#<index>` for sourced events', () => {
    expect(
      buildUndoToken({ source_message_id: 'msg-1', index_within_source: 0 }),
    ).toBe('s:msg-1#0');
    expect(
      buildUndoToken({ source_message_id: 'msg-1', index_within_source: 3 }),
    ).toBe('s:msg-1#3');
  });

  it('uses `u#<index>` for events with no source_message_id', () => {
    expect(buildUndoToken({ index_within_source: 0 })).toBe('u#0');
    expect(buildUndoToken({ index_within_source: 7 })).toBe('u#7');
  });

  it('Codex P2 fold — `unsourced` source_message_id never collides with the unsourced bucket', () => {
    // The dangerous overlap before the fix: source_message_id = 'unsourced'
    // would emit `'unsourced#0'`, which is identical to the unsourced
    // bucket's token. Now the prefix discriminates: `s:unsourced#0` vs
    // `u#0`.
    expect(
      buildUndoToken({
        source_message_id: 'unsourced',
        index_within_source: 0,
      }),
    ).toBe('s:unsourced#0');
    expect(buildUndoToken({ index_within_source: 0 })).toBe('u#0');
    expect(
      buildUndoToken({
        source_message_id: 'unsourced',
        index_within_source: 0,
      }),
    ).not.toBe(buildUndoToken({ index_within_source: 0 }));
  });
});

describe('D-145 PB6 — dispatchEvents tier discrimination', () => {
  it('high (≥ 0.85) maps to auto_save', () => {
    const { dispatched } = dispatchEvents([
      ev('extraction.purchase', 0.95),
      ev('extraction.commitment', 0.85),
    ]);
    expect(dispatched.map((d) => d.dispatch)).toEqual([
      'auto_save',
      'auto_save',
    ]);
  });

  it('medium ([0.6, 0.85)) maps to queue_for_confirm', () => {
    const { dispatched } = dispatchEvents([
      ev('extraction.plan', 0.6),
      ev('extraction.task', 0.7),
      ev('extraction.note', 0.84),
    ]);
    expect(dispatched.map((d) => d.dispatch)).toEqual([
      'queue_for_confirm',
      'queue_for_confirm',
      'queue_for_confirm',
    ]);
  });

  it('low (< 0.6) maps to annotate_only', () => {
    const { dispatched } = dispatchEvents([
      ev('extraction.preference', 0.59),
      ev('extraction.commitment_status_check', 0.3),
    ]);
    expect(dispatched.map((d) => d.dispatch)).toEqual([
      'annotate_only',
      'annotate_only',
    ]);
  });

  it('preserves original AI-emitted order in the dispatched output', () => {
    const events = [
      ev('extraction.commitment', 0.92, 'msg-A'),
      ev('resolution.alias', 0.99, 'msg-A'),
      ev('extraction.note', 0.7, 'msg-A'),
    ];
    const { dispatched } = dispatchEvents(events);
    expect(dispatched.map((d) => d.event)).toEqual(events);
  });
});

describe('D-145 PB6 — dispatchEvents undo token assignment', () => {
  it('per-source-message counter increments independently', () => {
    const { dispatched } = dispatchEvents([
      ev('extraction.commitment', 0.9, 'msg-A'),
      ev('extraction.task', 0.8, 'msg-A'),
      ev('extraction.note', 0.95, 'msg-B'),
      ev('extraction.purchase', 0.91, 'msg-A'),
    ]);
    expect(dispatched.map((d) => d.undo_token)).toEqual([
      's:msg-A#0',
      's:msg-A#1',
      's:msg-B#0',
      's:msg-A#2',
    ]);
  });

  it('unsourced events use the `u#<index>` counter independently', () => {
    const { dispatched } = dispatchEvents([
      ev('extraction.commitment', 0.9, 'msg-A'),
      ev('extraction.note', 0.5),
      ev('extraction.note', 0.5),
      ev('extraction.purchase', 0.7, 'msg-A'),
    ]);
    expect(dispatched.map((d) => d.undo_token)).toEqual([
      's:msg-A#0',
      'u#0',
      'u#1',
      's:msg-A#1',
    ]);
  });

  it('deterministic across re-runs (audit replay safety)', () => {
    const events = [
      ev('extraction.commitment', 0.9, 'msg-A'),
      ev('resolution.alias', 0.99),
      ev('extraction.note', 0.7, 'msg-A'),
    ];
    const a = dispatchEvents(events).dispatched.map((d) => d.undo_token);
    const b = dispatchEvents(events).dispatched.map((d) => d.undo_token);
    expect(a).toEqual(b);
  });

  it('empty input returns empty dispatched (graceful no-op)', () => {
    const { dispatched } = dispatchEvents([]);
    expect(dispatched).toEqual([]);
  });
});

describe('D-145 PB6 — dispatchEvents preserves the original event reference', () => {
  it('no mutation, no field copy — original bytes flow through', () => {
    const event = ev('extraction.commitment', 0.92, 'msg-1');
    const { dispatched } = dispatchEvents([event]);
    expect(dispatched[0]!.event).toBe(event);
  });
});
