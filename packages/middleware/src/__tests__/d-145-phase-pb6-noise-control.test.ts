/** D-145 PB6 — multi-event noise control tests.
 *
 *  Covers § B.7.10 (collapse-to-summary when count ≥ MULTI_EVENT_COLLAPSE_THRESHOLD).
 *  Verifies per-source-message bucketing + threshold + group-order
 *  determinism. */

import { describe, expect, it } from 'vitest';

import {
  MULTI_EVENT_COLLAPSE_THRESHOLD,
  type ExtractionEvent,
} from '@recued/contracts';

import { dispatchEvents } from '../ai-output/dispatch.js';
import { applyNoiseControl } from '../ai-output/noise-control.js';

const ev = (
  kind: ExtractionEvent['kind'],
  source_message_id?: string,
  confidence = 0.9,
): ExtractionEvent => ({
  kind,
  confidence,
  args: {},
  ...(source_message_id !== undefined ? { source_message_id } : {}),
});

describe('D-145 PB6 — applyNoiseControl per-source bucketing', () => {
  it('buckets events by source_message_id', () => {
    const { dispatched } = dispatchEvents([
      ev('extraction.commitment', 'msg-A'),
      ev('extraction.task', 'msg-B'),
      ev('extraction.note', 'msg-A'),
    ]);
    const { groups } = applyNoiseControl(dispatched);
    expect(groups.length).toBe(2);
    const a = groups.find((g) => g.source_message_id === 'msg-A')!;
    const b = groups.find((g) => g.source_message_id === 'msg-B')!;
    expect(a.events.length).toBe(2);
    expect(b.events.length).toBe(1);
  });

  it('preserves first-occurrence order in the groups output', () => {
    const { dispatched } = dispatchEvents([
      ev('extraction.commitment', 'msg-B'),
      ev('extraction.task', 'msg-A'),
      ev('extraction.note', 'msg-B'),
      ev('extraction.purchase', 'msg-A'),
    ]);
    const { groups } = applyNoiseControl(dispatched);
    expect(groups.map((g) => g.source_message_id)).toEqual(['msg-B', 'msg-A']);
  });

  it('groups unsourced events under a `null` bucket', () => {
    const { dispatched } = dispatchEvents([
      ev('extraction.commitment'),
      ev('extraction.task'),
    ]);
    const { groups } = applyNoiseControl(dispatched);
    expect(groups.length).toBe(1);
    expect(groups[0]!.source_message_id).toBe(null);
    expect(groups[0]!.events.length).toBe(2);
  });
});

describe('D-145 PB6 — applyNoiseControl threshold collapse (§ B.7.10)', () => {
  it('< threshold → mode `inline`', () => {
    const events = Array.from(
      { length: MULTI_EVENT_COLLAPSE_THRESHOLD - 1 },
      () => ev('extraction.note', 'msg-1'),
    );
    const { dispatched } = dispatchEvents(events);
    const { groups } = applyNoiseControl(dispatched);
    expect(groups.length).toBe(1);
    expect(groups[0]!.mode).toBe('inline');
    expect(groups[0]!.events.length).toBe(MULTI_EVENT_COLLAPSE_THRESHOLD - 1);
  });

  it('= threshold → mode `collapsed_summary`', () => {
    const events = Array.from(
      { length: MULTI_EVENT_COLLAPSE_THRESHOLD },
      () => ev('extraction.note', 'msg-storm'),
    );
    const { dispatched } = dispatchEvents(events);
    const { groups } = applyNoiseControl(dispatched);
    expect(groups[0]!.mode).toBe('collapsed_summary');
    if (groups[0]!.mode === 'collapsed_summary') {
      expect(groups[0]!.count).toBe(MULTI_EVENT_COLLAPSE_THRESHOLD);
      expect(groups[0]!.events.length).toBe(MULTI_EVENT_COLLAPSE_THRESHOLD);
    }
  });

  it('> threshold → mode `collapsed_summary` with the right count', () => {
    const COUNT = 10;
    const events = Array.from({ length: COUNT }, () =>
      ev('extraction.note', 'msg-storm'),
    );
    const { dispatched } = dispatchEvents(events);
    const { groups } = applyNoiseControl(dispatched);
    expect(groups[0]!.mode).toBe('collapsed_summary');
    if (groups[0]!.mode === 'collapsed_summary') {
      expect(groups[0]!.count).toBe(COUNT);
    }
  });

  it('threshold applies independently per-source-message bucket', () => {
    // msg-A: above threshold → collapsed
    // msg-B: below threshold → inline
    const events: ExtractionEvent[] = [
      ...Array.from({ length: 7 }, () =>
        ev('extraction.note', 'msg-A'),
      ),
      ev('extraction.commitment', 'msg-B'),
      ev('extraction.task', 'msg-B'),
    ];
    const { dispatched } = dispatchEvents(events);
    const { groups } = applyNoiseControl(dispatched);
    expect(groups.length).toBe(2);
    const a = groups.find((g) => g.source_message_id === 'msg-A')!;
    const b = groups.find((g) => g.source_message_id === 'msg-B')!;
    expect(a.mode).toBe('collapsed_summary');
    expect(b.mode).toBe('inline');
  });
});

describe('D-145 PB6 — applyNoiseControl edge cases', () => {
  it('empty dispatched returns empty groups', () => {
    expect(applyNoiseControl([]).groups).toEqual([]);
  });

  it('preserves event order within each group', () => {
    const e1 = ev('extraction.commitment', 'msg-A');
    const e2 = ev('extraction.task', 'msg-A');
    const e3 = ev('extraction.note', 'msg-A');
    const { dispatched } = dispatchEvents([e1, e2, e3]);
    const { groups } = applyNoiseControl(dispatched);
    expect(groups[0]!.events.map((d) => d.event)).toEqual([e1, e2, e3]);
  });
});
