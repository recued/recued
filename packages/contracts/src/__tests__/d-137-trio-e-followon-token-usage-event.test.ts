/** D-137 Trio #E follow-on — `recued.token_usage` transparency event
 *  taxonomy ratchets.
 *
 *  Coverage:
 *    1. Kind enrolled in `TRANSPARENCY_EVENT_KINDS` + kind set membership.
 *    2. Variant lives in the `TransparencyEvent` discriminated union.
 *    3. Class assignment is `'orchestration'`.
 *    4. Default redaction is `'summary_only'`.
 *    5. Template renders the compact "12.3k tokens (in 8k / out 4.3k)"
 *       cue with k-scaling for ≥1000 / ≥10000.
 *    6. Validator accepts well-formed payloads + rejects missing /
 *       non-finite required fields + rejects non-finite optional
 *       fields when present (preserves absent vs measured-zero). */

import { describe, expect, it } from 'vitest';
import {
  TRANSPARENCY_EVENT_KINDS,
  TRANSPARENCY_EVENT_KIND_SET,
  TRANSPARENCY_EVENT_CLASS_FOR_KIND,
  TRANSPARENCY_DEFAULT_REDACTION_FOR_KIND,
  isTransparencyEventKind,
  renderTransparencyTemplate,
  validateTransparencyEvent,
  classForTransparencyEventKind,
  defaultRedactionForKind,
  type TransparencyEvent,
} from '../transparency-stream/index.js';

describe('recued.token_usage — taxonomy enrolment', () => {
  it('appears in TRANSPARENCY_EVENT_KINDS', () => {
    expect(TRANSPARENCY_EVENT_KINDS).toContain('recued.token_usage');
  });

  it('is recognised by isTransparencyEventKind', () => {
    expect(isTransparencyEventKind('recued.token_usage')).toBe(true);
  });

  it('lives in the kind set', () => {
    expect(TRANSPARENCY_EVENT_KIND_SET.has('recued.token_usage')).toBe(true);
  });

  it('maps to orchestration class', () => {
    expect(TRANSPARENCY_EVENT_CLASS_FOR_KIND['recued.token_usage']).toBe('orchestration');
    expect(classForTransparencyEventKind('recued.token_usage')).toBe('orchestration');
  });

  it('default redaction is summary_only (mirrors multi_turn events)', () => {
    expect(TRANSPARENCY_DEFAULT_REDACTION_FOR_KIND['recued.token_usage']).toBe('summary_only');
    expect(defaultRedactionForKind('recued.token_usage')).toBe('summary_only');
  });
});

describe('recued.token_usage — template rendering', () => {
  const mk = (extra: Partial<Extract<TransparencyEvent, { kind: 'recued.token_usage' }>> = {}) =>
    ({
      kind: 'recued.token_usage',
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      ...extra,
    }) as TransparencyEvent;

  it('renders raw counts under 1000', () => {
    expect(renderTransparencyTemplate(mk({ input_tokens: 100, output_tokens: 50, total_tokens: 150 })))
      .toBe('150 tokens (in 100 / out 50)');
  });

  it('renders 1.3k-style for counts in [1000, 10_000)', () => {
    expect(renderTransparencyTemplate(mk({ input_tokens: 800, output_tokens: 500, total_tokens: 1300 })))
      .toBe('1.3k tokens (in 800 / out 500)');
  });

  it('rounds to whole k for counts ≥ 10_000', () => {
    expect(renderTransparencyTemplate(mk({ input_tokens: 8000, output_tokens: 4000, total_tokens: 12000 })))
      .toBe('12k tokens (in 8k / out 4k)');
  });

  it('mixed scale renders consistently', () => {
    expect(renderTransparencyTemplate(mk({ input_tokens: 11500, output_tokens: 200, total_tokens: 11700 })))
      .toBe('12k tokens (in 12k / out 200)');
  });
});

describe('recued.token_usage — validator', () => {
  it('accepts a minimal well-formed payload', () => {
    expect(validateTransparencyEvent({
      kind: 'recued.token_usage',
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
    })).toEqual([]);
  });

  it('accepts payload with all optional fields populated', () => {
    expect(validateTransparencyEvent({
      kind: 'recued.token_usage',
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      cache_read_input_tokens: 20,
      cache_write_input_tokens: 5,
      reasoning_tokens: 10,
    })).toEqual([]);
  });

  it('accepts measured-zero on optional fields (distinct from absent)', () => {
    expect(validateTransparencyEvent({
      kind: 'recued.token_usage',
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      cache_read_input_tokens: 0,
    })).toEqual([]);
  });

  it('rejects when required input_tokens is missing', () => {
    const issues = validateTransparencyEvent({
      kind: 'recued.token_usage',
      output_tokens: 50,
      total_tokens: 150,
    });
    expect(issues.some((i) => i.path === 'input_tokens')).toBe(true);
  });

  it('rejects when required field is non-finite', () => {
    const issues = validateTransparencyEvent({
      kind: 'recued.token_usage',
      input_tokens: Number.NaN,
      output_tokens: 50,
      total_tokens: 150,
    });
    expect(issues.some((i) => i.path === 'input_tokens')).toBe(true);
  });

  it('rejects when an optional field is present but non-finite', () => {
    const issues = validateTransparencyEvent({
      kind: 'recued.token_usage',
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      reasoning_tokens: 'lots' as unknown as number,
    });
    expect(issues.some((i) => i.path === 'reasoning_tokens')).toBe(true);
  });

  it('rejects when an optional field is positive infinity', () => {
    const issues = validateTransparencyEvent({
      kind: 'recued.token_usage',
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      cache_read_input_tokens: Number.POSITIVE_INFINITY,
    });
    expect(issues.some((i) => i.path === 'cache_read_input_tokens')).toBe(true);
  });
});
