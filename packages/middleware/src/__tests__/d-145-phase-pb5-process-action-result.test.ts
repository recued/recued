/** D-145 PB5 — `processActionResult` substrate validator-gate processor tests.
 *
 *  Per § B.6.4 + § B.6.8 + § B.6.9. Cover sort-by-confidence-descending,
 *  empty-alternatives passthrough, conflict + meta preservation,
 *  Transparency Stream event emission for each violation.
 */

import { describe, it, expect } from 'vitest';

import {
  buildFixedSlotDriftEvent,
  FIXED_SLOT_DRIFT_EVENT_KIND,
  processActionResult,
} from '../ai-cooperative/process-action-result.js';
import type { ActionRequest, ActionResult } from '@recued/contracts';

interface Args {
  person: string;
  date?: string;
  time?: string;
}

describe('D-145 PB5 — processActionResult: sort + survivors', () => {
  it('sorts surviving alternatives by confidence descending', () => {
    const req: ActionRequest<Args> = { args: { person: 'Mary' }, fixed_slots: ['person'] };
    const res: ActionResult<Args> = {
      result: null,
      alternatives: [
        { args: { person: 'Mary', time: '12:00' }, confidence: 0.4 },
        { args: { person: 'Mary', time: '14:00' }, confidence: 0.9 },
        { args: { person: 'Mary', time: '13:00' }, confidence: 0.7 },
      ],
    };
    const { processed } = processActionResult(req, res);
    expect(processed.alternatives.length).toBe(3);
    expect(processed.alternatives[0]?.confidence).toBe(0.9);
    expect(processed.alternatives[1]?.confidence).toBe(0.7);
    expect(processed.alternatives[2]?.confidence).toBe(0.4);
  });

  it('stable-sort: equal-confidence entries preserve original order', () => {
    const req: ActionRequest<Args> = { args: { person: 'Mary' }, fixed_slots: ['person'] };
    const res: ActionResult<Args> = {
      result: null,
      alternatives: [
        { args: { person: 'Mary', time: '12:00' }, confidence: 0.7, annotation: 'first' },
        { args: { person: 'Mary', time: '13:00' }, confidence: 0.7, annotation: 'second' },
        { args: { person: 'Mary', time: '14:00' }, confidence: 0.7, annotation: 'third' },
      ],
    };
    const { processed } = processActionResult(req, res);
    expect(processed.alternatives[0]?.annotation).toBe('first');
    expect(processed.alternatives[1]?.annotation).toBe('second');
    expect(processed.alternatives[2]?.annotation).toBe('third');
  });

  it('drops drifting alternatives + emits one event per violation', () => {
    const req: ActionRequest<Args> = { args: { person: 'Mary' }, fixed_slots: ['person'] };
    const res: ActionResult<Args> = {
      result: null,
      alternatives: [
        { args: { person: 'Mary', time: '12:00' }, confidence: 0.9 },
        { args: { person: 'Sarah', time: '13:00' }, confidence: 0.8 },
        { args: { person: 'Bob', time: '14:00' }, confidence: 0.7 },
      ],
    };
    const { processed, events } = processActionResult(req, res);
    expect(processed.alternatives.length).toBe(1);
    expect(processed.violations.length).toBe(2);
    expect(events.length).toBe(2);
    for (const e of events) {
      expect(e.event.kind).toBe(FIXED_SLOT_DRIFT_EVENT_KIND);
    }
  });
});

describe('D-145 PB5 — processActionResult: empty alternatives passthrough (§ B.6.9)', () => {
  it('alternatives: [] → processed.alternatives === []; zero events', () => {
    const req: ActionRequest<Args> = { args: { person: 'Mary' }, fixed_slots: ['person'] };
    const res: ActionResult<Args> = {
      result: null,
      alternatives: [],
      conflict: 'no available slot',
    };
    const { processed, events } = processActionResult(req, res);
    expect(processed.alternatives).toEqual([]);
    expect(processed.violations).toEqual([]);
    expect(events).toEqual([]);
    expect(processed.conflict).toBe('no available slot');
  });

  it('every alternative drops → no fabrication; processed.alternatives === []', () => {
    const req: ActionRequest<Args> = { args: { person: 'Mary' }, fixed_slots: ['person'] };
    const res: ActionResult<Args> = {
      result: null,
      alternatives: [
        { args: { person: 'A' }, confidence: 0.9 },
        { args: { person: 'B' }, confidence: 0.8 },
      ],
    };
    const { processed } = processActionResult(req, res);
    expect(processed.alternatives.length).toBe(0);
    expect(processed.violations.length).toBe(2);
  });

  it('alternatives undefined → processed.alternatives === []', () => {
    const req: ActionRequest<Args> = { args: { person: 'Mary' }, fixed_slots: ['person'] };
    const res: ActionResult<Args> = { result: { person: 'Mary' } };
    const { processed, events } = processActionResult(req, res);
    expect(processed.alternatives).toEqual([]);
    expect(events).toEqual([]);
  });
});

describe('D-145 PB5 — processActionResult: original-result + conflict + meta passthrough', () => {
  it('preserves original_result (TArgs)', () => {
    const req: ActionRequest<Args> = { args: { person: 'Mary' }, fixed_slots: ['person'] };
    const res: ActionResult<Args> = {
      result: { person: 'Mary', time: '14:00' },
    };
    const { processed } = processActionResult(req, res);
    expect(processed.original_result).toEqual({ person: 'Mary', time: '14:00' });
  });

  it('preserves original_result === null when conflict', () => {
    const req: ActionRequest<Args> = { args: { person: 'Mary' }, fixed_slots: ['person'] };
    const res: ActionResult<Args> = { result: null, conflict: 'no slot' };
    const { processed } = processActionResult(req, res);
    expect(processed.original_result).toBeNull();
    expect(processed.conflict).toBe('no slot');
  });

  it('omits conflict field when input conflict undefined', () => {
    const req: ActionRequest<Args> = { args: { person: 'Mary' }, fixed_slots: ['person'] };
    const res: ActionResult<Args> = { result: { person: 'Mary' } };
    const { processed } = processActionResult(req, res);
    expect('conflict' in processed).toBe(false);
  });

  it('preserves meta.rounds_avoided telemetry (B.6.13)', () => {
    const req: ActionRequest<Args> = { args: { person: 'Mary' }, fixed_slots: ['person'] };
    const res: ActionResult<Args> = {
      result: { person: 'Mary' },
      alternatives: [{ args: { person: 'Mary' }, confidence: 0.9 }],
      meta: { rounds_avoided: 3 },
    };
    const { processed } = processActionResult(req, res);
    expect(processed.meta?.rounds_avoided).toBe(3);
  });
});

describe('D-145 PB5 — buildFixedSlotDriftEvent: closed-list payload', () => {
  it('event carries violation_kind + slot + alternative_index — never user content', () => {
    const envelope = buildFixedSlotDriftEvent({
      kind: 'fixed_slot_drift',
      slot: 'person',
      alternative_index: 2,
    });
    expect(envelope.event.kind).toBe(FIXED_SLOT_DRIFT_EVENT_KIND);
    expect(envelope.event).toMatchObject({
      kind: 'fixed_slot_drift',
      violation_kind: 'fixed_slot_drift',
      slot: 'person',
      alternative_index: 2,
    });
    // PB7 wire envelope shape — { event, redaction, emitted_at }
    expect(envelope.redaction).toBeDefined();
    expect(typeof envelope.emitted_at).toBe('number');
  });

  it('builds same shape for fixed_slot_unknown_field', () => {
    const envelope = buildFixedSlotDriftEvent({
      kind: 'fixed_slot_unknown_field',
      slot: 'typo_slot',
      alternative_index: 0,
    });
    expect(envelope.event).toMatchObject({
      kind: 'fixed_slot_drift',
      violation_kind: 'fixed_slot_unknown_field',
      slot: 'typo_slot',
      alternative_index: 0,
    });
  });
});
