/** D-145 PB6 — confirmation queue batching tests.
 *
 *  Covers § B.7.11 — medium-confidence events from the same source
 *  message form a related group with shared source-message reference;
 *  high / low events flow through to passthrough. */

import { describe, expect, it } from 'vitest';

import type { ExtractionEvent } from '@recued/contracts';

import { batchForConfirmation } from '../ai-output/confirmation-queue.js';
import { dispatchEvents } from '../ai-output/dispatch.js';

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

describe('D-145 PB6 — batchForConfirmation only batches medium-confidence', () => {
  it('high-confidence → passthrough', () => {
    const { dispatched } = dispatchEvents([
      ev('extraction.commitment', 0.95, 'msg-A'),
      ev('extraction.task', 0.9, 'msg-A'),
    ]);
    const { groups, passthrough } = batchForConfirmation(dispatched);
    expect(groups).toEqual([]);
    expect(passthrough.length).toBe(2);
  });

  it('low-confidence → passthrough', () => {
    const { dispatched } = dispatchEvents([
      ev('extraction.note', 0.3, 'msg-A'),
      ev('extraction.preference', 0.1, 'msg-A'),
    ]);
    const { groups, passthrough } = batchForConfirmation(dispatched);
    expect(groups).toEqual([]);
    expect(passthrough.length).toBe(2);
  });

  it('medium-confidence with same source_message_id → one group', () => {
    const { dispatched } = dispatchEvents([
      ev('extraction.plan', 0.7, 'msg-A'),
      ev('extraction.task', 0.65, 'msg-A'),
      ev('extraction.note', 0.8, 'msg-A'),
    ]);
    const { groups, passthrough } = batchForConfirmation(dispatched);
    expect(groups.length).toBe(1);
    expect(groups[0]!.source_message_id).toBe('msg-A');
    expect(groups[0]!.events.length).toBe(3);
    expect(passthrough).toEqual([]);
  });

  it('medium-confidence across different source_message_ids → separate groups', () => {
    const { dispatched } = dispatchEvents([
      ev('extraction.plan', 0.7, 'msg-A'),
      ev('extraction.task', 0.65, 'msg-B'),
      ev('extraction.note', 0.8, 'msg-A'),
    ]);
    const { groups } = batchForConfirmation(dispatched);
    expect(groups.length).toBe(2);
    const a = groups.find((g) => g.source_message_id === 'msg-A')!;
    const b = groups.find((g) => g.source_message_id === 'msg-B')!;
    expect(a.events.length).toBe(2);
    expect(b.events.length).toBe(1);
  });

  it('medium-confidence without source_message_id → singleton groups (one each)', () => {
    const { dispatched } = dispatchEvents([
      ev('extraction.plan', 0.7),
      ev('extraction.task', 0.65),
    ]);
    const { groups, passthrough } = batchForConfirmation(dispatched);
    expect(groups.length).toBe(2);
    expect(groups.every((g) => g.source_message_id === null)).toBe(true);
    expect(groups.every((g) => g.events.length === 1)).toBe(true);
    expect(passthrough).toEqual([]);
  });

  it('mixed high + medium + low — proper segregation', () => {
    const { dispatched } = dispatchEvents([
      ev('extraction.commitment', 0.95, 'msg-A'),  // high → passthrough
      ev('extraction.plan', 0.7, 'msg-A'),         // medium → group msg-A
      ev('extraction.note', 0.5, 'msg-A'),         // low → passthrough
      ev('extraction.task', 0.65, 'msg-A'),        // medium → group msg-A
      ev('resolution.alias', 0.99, 'msg-A'),       // high → passthrough
    ]);
    const { groups, passthrough } = batchForConfirmation(dispatched);
    expect(groups.length).toBe(1);
    expect(groups[0]!.source_message_id).toBe('msg-A');
    expect(groups[0]!.events.length).toBe(2);
    expect(passthrough.length).toBe(3);
  });
});

describe('D-145 PB6 — batchForConfirmation group ordering', () => {
  it('sourced groups in first-occurrence order; singletons at the end', () => {
    const { dispatched } = dispatchEvents([
      ev('extraction.plan', 0.7),                  // singleton
      ev('extraction.task', 0.65, 'msg-B'),        // group msg-B
      ev('extraction.note', 0.7, 'msg-A'),         // group msg-A
      ev('extraction.commitment', 0.65),           // singleton
      ev('extraction.purchase', 0.7, 'msg-A'),     // group msg-A append
    ]);
    const { groups } = batchForConfirmation(dispatched);
    expect(groups.map((g) => g.source_message_id)).toEqual([
      'msg-B',
      'msg-A',
      null,
      null,
    ]);
  });

  it('preserves event order within each group', () => {
    const { dispatched } = dispatchEvents([
      ev('extraction.plan', 0.7, 'msg-X'),
      ev('extraction.task', 0.7, 'msg-X'),
      ev('extraction.note', 0.7, 'msg-X'),
    ]);
    const { groups } = batchForConfirmation(dispatched);
    expect(
      groups[0]!.events.map((d) => d.event.kind),
    ).toEqual(['extraction.plan', 'extraction.task', 'extraction.note']);
  });
});

describe('D-145 PB6 — batchForConfirmation pure-function discipline', () => {
  it('empty input → empty output', () => {
    const { groups, passthrough } = batchForConfirmation([]);
    expect(groups).toEqual([]);
    expect(passthrough).toEqual([]);
  });

  it('does not mutate input ordering', () => {
    const { dispatched } = dispatchEvents([
      ev('extraction.plan', 0.7, 'msg-1'),
      ev('extraction.commitment', 0.95, 'msg-1'),
    ]);
    const beforeKinds = dispatched.map((d) => d.event.kind);
    batchForConfirmation(dispatched);
    const afterKinds = dispatched.map((d) => d.event.kind);
    expect(afterKinds).toEqual(beforeKinds);
  });
});
