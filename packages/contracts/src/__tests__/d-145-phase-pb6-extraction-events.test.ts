/** D-145 PB6 — extraction-events closed taxonomy + dispatch primitives.
 *
 *  Covers § B.7.1 (closed event taxonomy + per-event shape), § B.7.7
 *  (confidence-tier dispatch), § B.7.8 (composer-ordering class
 *  priority), substrate self-check (`assertExtractionEventInvariants`).
 */

import { describe, expect, it } from 'vitest';

import {
  EVENT_DISPATCH_KINDS,
  EVENT_DISPATCH_KIND_SET,
  EXTRACTION_EVENT_CLASS_PRIORITY,
  EXTRACTION_EVENT_CLASSES,
  EXTRACTION_EVENT_CLASS_SET,
  EXTRACTION_EVENT_KINDS,
  EXTRACTION_EVENT_KIND_SET,
  EXTRACTION_EVENT_VALIDATION_KINDS,
  EXTRACTION_EVENT_VALIDATION_KIND_SET,
  HIGH_CONFIDENCE_FLOOR,
  MEDIUM_CONFIDENCE_FLOOR,
  MULTI_EVENT_COLLAPSE_THRESHOLD,
  assertExtractionEventInvariants,
  classForExtractionEventKind,
  dispatchKindForConfidence,
  isExtractionEventKind,
  validateExtractionEvent,
  type ExtractionEvent,
} from '../extraction-events.js';

describe('D-145 PB6 — closed-list pins', () => {
  it('EXTRACTION_EVENT_KINDS contains exactly the 10 § B.7.1 entries', () => {
    expect(EXTRACTION_EVENT_KINDS.length).toBe(10);
    expect(new Set(EXTRACTION_EVENT_KINDS)).toEqual(
      new Set([
        'extraction.purchase',
        'extraction.plan',
        'extraction.commitment',
        'extraction.task',
        'extraction.note',
        'extraction.preference',
        'extraction.commitment_status_check',
        'resolution.alias',
        'resolution.contact_created_mention_only',
        'resolution.network_domain_inferred',
      ]),
    );
  });

  it('EXTRACTION_EVENT_KIND_SET membership pinned in lockstep with array', () => {
    expect(EXTRACTION_EVENT_KIND_SET.size).toBe(EXTRACTION_EVENT_KINDS.length);
    for (const kind of EXTRACTION_EVENT_KINDS) {
      expect(EXTRACTION_EVENT_KIND_SET.has(kind)).toBe(true);
    }
  });

  it('EXTRACTION_EVENT_CLASSES contains exactly 3 entries', () => {
    expect(EXTRACTION_EVENT_CLASSES.length).toBe(3);
    expect(new Set(EXTRACTION_EVENT_CLASSES)).toEqual(
      new Set(['resolution', 'extraction', 'derived_effect']),
    );
  });

  it('EXTRACTION_EVENT_CLASS_PRIORITY is monotonic (resolution < extraction < derived_effect)', () => {
    expect(EXTRACTION_EVENT_CLASS_PRIORITY.resolution).toBe(0);
    expect(EXTRACTION_EVENT_CLASS_PRIORITY.extraction).toBe(1);
    expect(EXTRACTION_EVENT_CLASS_PRIORITY.derived_effect).toBe(2);
  });

  it('EVENT_DISPATCH_KINDS is exactly 3 entries', () => {
    expect(EVENT_DISPATCH_KINDS.length).toBe(3);
    expect(new Set(EVENT_DISPATCH_KINDS)).toEqual(
      new Set(['auto_save', 'queue_for_confirm', 'annotate_only']),
    );
  });

  it('EVENT_DISPATCH_KIND_SET pinned in lockstep', () => {
    expect(EVENT_DISPATCH_KIND_SET.size).toBe(EVENT_DISPATCH_KINDS.length);
  });

  it('EXTRACTION_EVENT_CLASS_SET pinned in lockstep', () => {
    expect(EXTRACTION_EVENT_CLASS_SET.size).toBe(EXTRACTION_EVENT_CLASSES.length);
  });

  it('EXTRACTION_EVENT_VALIDATION_KINDS is exactly 3 entries', () => {
    expect(EXTRACTION_EVENT_VALIDATION_KINDS.length).toBe(3);
    expect(new Set(EXTRACTION_EVENT_VALIDATION_KINDS)).toEqual(
      new Set([
        'unknown_kind',
        'confidence_not_finite',
        'confidence_out_of_range',
      ]),
    );
    expect(EXTRACTION_EVENT_VALIDATION_KIND_SET.size).toBe(3);
  });

  it('confidence floors satisfy 0 < MEDIUM < HIGH ≤ 1 invariant', () => {
    expect(MEDIUM_CONFIDENCE_FLOOR).toBeGreaterThan(0);
    expect(HIGH_CONFIDENCE_FLOOR).toBeGreaterThan(MEDIUM_CONFIDENCE_FLOOR);
    expect(HIGH_CONFIDENCE_FLOOR).toBeLessThanOrEqual(1);
    // Spec § B.7.7: high ≥ 0.85, medium ≥ 0.6.
    expect(HIGH_CONFIDENCE_FLOOR).toBe(0.85);
    expect(MEDIUM_CONFIDENCE_FLOOR).toBe(0.6);
  });

  it('MULTI_EVENT_COLLAPSE_THRESHOLD is 6 per § B.7.10', () => {
    expect(MULTI_EVENT_COLLAPSE_THRESHOLD).toBe(6);
  });
});

describe('D-145 PB6 — kind narrowing helpers', () => {
  it('isExtractionEventKind returns true for closed-list members', () => {
    for (const kind of EXTRACTION_EVENT_KINDS) {
      expect(isExtractionEventKind(kind)).toBe(true);
    }
  });

  it('isExtractionEventKind returns false for unknown / non-string', () => {
    expect(isExtractionEventKind('extraction.detected')).toBe(false);
    expect(isExtractionEventKind('something.else')).toBe(false);
    expect(isExtractionEventKind('')).toBe(false);
    expect(isExtractionEventKind(undefined)).toBe(false);
    expect(isExtractionEventKind(null)).toBe(false);
    expect(isExtractionEventKind(42)).toBe(false);
    expect(isExtractionEventKind({})).toBe(false);
  });

  it('classForExtractionEventKind dispatches resolution / extraction prefixes', () => {
    expect(classForExtractionEventKind('resolution.alias')).toBe('resolution');
    expect(classForExtractionEventKind('resolution.contact_created_mention_only')).toBe('resolution');
    expect(classForExtractionEventKind('resolution.network_domain_inferred')).toBe('resolution');
    expect(classForExtractionEventKind('extraction.purchase')).toBe('extraction');
    expect(classForExtractionEventKind('extraction.plan')).toBe('extraction');
    expect(classForExtractionEventKind('extraction.commitment')).toBe('extraction');
    expect(classForExtractionEventKind('extraction.task')).toBe('extraction');
    expect(classForExtractionEventKind('extraction.note')).toBe('extraction');
    expect(classForExtractionEventKind('extraction.preference')).toBe('extraction');
    expect(classForExtractionEventKind('extraction.commitment_status_check')).toBe('extraction');
  });

  it('classForExtractionEventKind throws on unknown prefix', () => {
    expect(() =>
      classForExtractionEventKind('unknown.something' as never),
    ).toThrowError(/unknown extraction event class/);
  });
});

describe('D-145 PB6 — dispatchKindForConfidence (§ B.7.7)', () => {
  it('≥ HIGH_CONFIDENCE_FLOOR → auto_save', () => {
    expect(dispatchKindForConfidence(0.85)).toBe('auto_save');
    expect(dispatchKindForConfidence(0.9)).toBe('auto_save');
    expect(dispatchKindForConfidence(0.95)).toBe('auto_save');
    expect(dispatchKindForConfidence(1.0)).toBe('auto_save');
  });

  it('[MEDIUM, HIGH) → queue_for_confirm', () => {
    expect(dispatchKindForConfidence(0.6)).toBe('queue_for_confirm');
    expect(dispatchKindForConfidence(0.7)).toBe('queue_for_confirm');
    expect(dispatchKindForConfidence(0.84999)).toBe('queue_for_confirm');
  });

  it('< MEDIUM → annotate_only', () => {
    expect(dispatchKindForConfidence(0.59999)).toBe('annotate_only');
    expect(dispatchKindForConfidence(0.5)).toBe('annotate_only');
    expect(dispatchKindForConfidence(0)).toBe('annotate_only');
  });

  it('NaN / non-finite → annotate_only (under-claim discipline)', () => {
    expect(dispatchKindForConfidence(NaN)).toBe('annotate_only');
    expect(dispatchKindForConfidence(Number.NEGATIVE_INFINITY)).toBe(
      'annotate_only',
    );
    // Positive infinity is also non-finite — the substrate refuses to
    // promote panicked overclaims; conservative behavior beats edge-
    // case auto-save.
    expect(dispatchKindForConfidence(Number.POSITIVE_INFINITY)).toBe(
      'annotate_only',
    );
  });

  it('finite negative confidence → annotate_only', () => {
    expect(dispatchKindForConfidence(-1)).toBe('annotate_only');
    expect(dispatchKindForConfidence(-0.0001)).toBe('annotate_only');
  });

  it('finite > 1 → auto_save (graceful clamp; only finite values clamp up)', () => {
    expect(dispatchKindForConfidence(1.0001)).toBe('auto_save');
    expect(dispatchKindForConfidence(1.5)).toBe('auto_save');
    expect(dispatchKindForConfidence(Number.MAX_SAFE_INTEGER)).toBe('auto_save');
  });
});

describe('D-145 PB6 — validateExtractionEvent (§ B.7.1 substrate)', () => {
  const baseValid: ExtractionEvent = {
    kind: 'extraction.purchase',
    confidence: 0.92,
    args: { amount: 5000, currency: 'USD' },
  };

  it('accepts a fully-valid event with no issues', () => {
    expect(validateExtractionEvent(baseValid)).toEqual([]);
  });

  it('flags unknown_kind for off-list kinds', () => {
    const issues = validateExtractionEvent({
      ...baseValid,
      kind: 'extraction.weird' as never,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.kind).toBe('unknown_kind');
  });

  it('flags confidence_not_finite for NaN / Infinity', () => {
    expect(
      validateExtractionEvent({ ...baseValid, confidence: NaN })[0]!.kind,
    ).toBe('confidence_not_finite');
    expect(
      validateExtractionEvent({
        ...baseValid,
        confidence: Number.POSITIVE_INFINITY,
      })[0]!.kind,
    ).toBe('confidence_not_finite');
  });

  it('flags confidence_out_of_range for finite values outside [0, 1]', () => {
    expect(
      validateExtractionEvent({ ...baseValid, confidence: -0.01 })[0]!.kind,
    ).toBe('confidence_out_of_range');
    expect(
      validateExtractionEvent({ ...baseValid, confidence: 1.5 })[0]!.kind,
    ).toBe('confidence_out_of_range');
  });

  it('reports BOTH kind + confidence issues at once when both invalid', () => {
    const issues = validateExtractionEvent({
      kind: 'bogus.kind' as never,
      confidence: NaN,
      args: {},
    });
    expect(issues).toHaveLength(2);
    expect(new Set(issues.map((i) => i.kind))).toEqual(
      new Set(['unknown_kind', 'confidence_not_finite']),
    );
  });

  it('accepts boundary confidence 0 and 1', () => {
    expect(
      validateExtractionEvent({ ...baseValid, confidence: 0 }),
    ).toEqual([]);
    expect(
      validateExtractionEvent({ ...baseValid, confidence: 1 }),
    ).toEqual([]);
  });

  it('preserves args and optional fields verbatim through validation', () => {
    const event: ExtractionEvent = {
      kind: 'resolution.alias',
      confidence: 0.99,
      args: { alias: 'mom', contact_id: 'contact-001' },
      source_message_id: 'msg-007',
      subject_contact_id: 'contact-001',
    };
    expect(validateExtractionEvent(event)).toEqual([]);
  });
});

describe('D-145 PB6 — validateExtractionEvent untrusted-input guard (Codex P2)', () => {
  it('null input emits structural issues without throwing', () => {
    const issues = validateExtractionEvent(null);
    // null → unknown_kind + confidence_not_finite (substrate emits both
    // shape errors so the composer halts on a single pass)
    expect(issues.length).toBe(2);
    expect(new Set(issues.map((i) => i.kind))).toEqual(
      new Set(['unknown_kind', 'confidence_not_finite']),
    );
  });

  it('undefined input emits structural issues without throwing', () => {
    const issues = validateExtractionEvent(undefined);
    expect(issues.length).toBe(2);
  });

  it('primitive input (string / number / boolean) emits structural issues', () => {
    expect(validateExtractionEvent('not an event').length).toBe(2);
    expect(validateExtractionEvent(42).length).toBe(2);
    expect(validateExtractionEvent(true).length).toBe(2);
  });

  it('array input emits structural issues (arrays are objects but not event-shaped)', () => {
    const issues = validateExtractionEvent([]);
    // Empty array has no `kind` property → unknown_kind; no `confidence`
    // property → confidence_not_finite. Two structural issues.
    expect(issues.length).toBe(2);
    expect(new Set(issues.map((i) => i.kind))).toEqual(
      new Set(['unknown_kind', 'confidence_not_finite']),
    );
  });

  it('object missing kind / confidence emits both kind + confidence issues', () => {
    const issues = validateExtractionEvent({});
    expect(issues.length).toBe(2);
    expect(new Set(issues.map((i) => i.kind))).toEqual(
      new Set(['unknown_kind', 'confidence_not_finite']),
    );
  });
});

describe('D-145 PB6 — assertExtractionEventInvariants', () => {
  it('passes on the as-shipped substrate', () => {
    expect(() => assertExtractionEventInvariants()).not.toThrow();
  });
});
