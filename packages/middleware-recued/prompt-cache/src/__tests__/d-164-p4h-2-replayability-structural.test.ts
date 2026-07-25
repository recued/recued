import { describe, expect, it } from 'vitest';

import {
  classifyReplayability,
  DETERMINISTIC_STEP_KINDS,
  isDeterministicStepKind,
} from '../templates/audit-grow/replayability/structural';
import {
  classifyReplayability as classifyReplayabilityFromAuditGrowBarrel,
  DETERMINISTIC_STEP_KINDS as DETERMINISTIC_STEP_KINDS_FROM_AUDIT_GROW_BARREL,
  isDeterministicStepKind as isDeterministicStepKindFromAuditGrowBarrel,
} from '../templates/audit-grow/index';
import {
  classifyReplayability as classifyReplayabilityFromPublicBarrel,
  DETERMINISTIC_STEP_KINDS as DETERMINISTIC_STEP_KINDS_FROM_PUBLIC_BARREL,
  isDeterministicStepKind as isDeterministicStepKindFromPublicBarrel,
} from '../templates/index';
import type {
  ClassifyReplayabilityInput,
  DeterministicStepKind,
  ReplayabilityClassification,
} from '../templates/index';

const classify = (
  step_kinds: ReadonlyArray<string>,
): ReplayabilityClassification => classifyReplayability({ step_kinds });

describe('D-164 P4h-2 DETERMINISTIC_STEP_KINDS', () => {
  it('is the closed set of four kinds in design O-6 / § 3 Invariant 2', () => {
    expect([...DETERMINISTIC_STEP_KINDS]).toEqual([
      'query',
      'list',
      'transform',
      'render',
    ]);
  });

  it('is frozen at module-load to prevent silent allow-list widening', () => {
    expect(Object.isFrozen(DETERMINISTIC_STEP_KINDS)).toBe(true);
  });

  it('rejects mutation via push in strict mode', () => {
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (DETERMINISTIC_STEP_KINDS as any).push('ai-extract');
    }).toThrow(TypeError);
  });

  it('rejects mutation via index assignment in strict mode', () => {
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (DETERMINISTIC_STEP_KINDS as any)[0] = 'ai-extract';
    }).toThrow(TypeError);
  });
});

describe('D-164 P4h-2 isDeterministicStepKind', () => {
  it('returns true for each kind in the closed list', () => {
    expect(isDeterministicStepKind('query')).toBe(true);
    expect(isDeterministicStepKind('list')).toBe(true);
    expect(isDeterministicStepKind('transform')).toBe(true);
    expect(isDeterministicStepKind('render')).toBe(true);
  });

  it('returns false for the spec-flagged ai-* prototype', () => {
    expect(isDeterministicStepKind('ai-extract')).toBe(false);
    expect(isDeterministicStepKind('ai-classify')).toBe(false);
    expect(isDeterministicStepKind('ai-prompt')).toBe(false);
  });

  it('returns false for non-deterministic non-ai kinds', () => {
    expect(isDeterministicStepKind('ingredient')).toBe(false);
    expect(isDeterministicStepKind('guard')).toBe(false);
    expect(isDeterministicStepKind('entity-action')).toBe(false);
    expect(isDeterministicStepKind('entity-action-hubspot')).toBe(false);
  });

  it('is case-sensitive — canonical kinds are lowercase per spec', () => {
    expect(isDeterministicStepKind('Query')).toBe(false);
    expect(isDeterministicStepKind('QUERY')).toBe(false);
    expect(isDeterministicStepKind('Render')).toBe(false);
  });

  it('returns false for empty string and whitespace', () => {
    expect(isDeterministicStepKind('')).toBe(false);
    expect(isDeterministicStepKind(' query')).toBe(false);
    expect(isDeterministicStepKind('query ')).toBe(false);
  });

  it('returns false for prefix / suffix substrings of canonical kinds', () => {
    expect(isDeterministicStepKind('queryx')).toBe(false);
    expect(isDeterministicStepKind('xquery')).toBe(false);
    expect(isDeterministicStepKind('rende')).toBe(false);
  });
});

describe('D-164 P4h-2 classifyReplayability — render_template branch', () => {
  it('classifies a single query step as render_template', () => {
    expect(classify(['query'])).toEqual({
      kind: 'render_template',
      disqualifying_step_kinds: [],
    });
  });

  it('classifies all four deterministic kinds together as render_template', () => {
    const result = classify(['query', 'list', 'transform', 'render']);

    expect(result.kind).toBe('render_template');
    expect(result.disqualifying_step_kinds).toEqual([]);
  });

  it('classifies repeated deterministic kinds as render_template', () => {
    const result = classify([
      'query',
      'query',
      'transform',
      'transform',
      'render',
      'render',
    ]);

    expect(result.kind).toBe('render_template');
    expect(result.disqualifying_step_kinds).toEqual([]);
  });

  it('does not consider order — `render` before `query` is still render_template', () => {
    expect(classify(['render', 'query', 'transform']).kind).toBe('render_template');
  });
});

describe('D-164 P4h-2 classifyReplayability — structural_plan branch', () => {
  it('classifies the spec-flagged ai-* disqualifier as structural_plan', () => {
    expect(classify(['query', 'ai-extract', 'render'])).toEqual({
      kind: 'structural_plan',
      disqualifying_step_kinds: ['ai-extract'],
    });
  });

  it('classifies any single non-deterministic kind as structural_plan', () => {
    expect(classify(['ingredient']).kind).toBe('structural_plan');
    expect(classify(['guard']).kind).toBe('structural_plan');
    expect(classify(['entity-action-hubspot']).kind).toBe('structural_plan');
  });

  it('treats case variants of canonical kinds as disqualifying', () => {
    const result = classify(['Query', 'render']);

    expect(result.kind).toBe('structural_plan');
    expect(result.disqualifying_step_kinds).toEqual(['Query']);
  });

  it('treats an empty-string step kind as disqualifying', () => {
    const result = classify(['']);

    expect(result.kind).toBe('structural_plan');
    expect(result.disqualifying_step_kinds).toEqual(['']);
  });

  it('flags every disqualifying kind across a mixed sequence', () => {
    const result = classify([
      'query',
      'ai-extract',
      'transform',
      'entity-action-hubspot',
      'render',
    ]);

    expect(result.kind).toBe('structural_plan');
    expect(result.disqualifying_step_kinds).toEqual([
      'ai-extract',
      'entity-action-hubspot',
    ]);
  });
});

describe('D-164 P4h-2 classifyReplayability — dedup + ordering', () => {
  it('deduplicates repeated disqualifying kinds', () => {
    expect(
      classify(['ai-extract', 'ai-extract', 'ai-extract'])
        .disqualifying_step_kinds,
    ).toEqual(['ai-extract']);
  });

  it('preserves first-seen order across distinct disqualifying kinds', () => {
    expect(
      classify(['ai-extract', 'entity-action', 'ai-extract', 'guard'])
        .disqualifying_step_kinds,
    ).toEqual(['ai-extract', 'entity-action', 'guard']);
  });

  it('first-seen order is independent of how deterministic kinds interleave', () => {
    expect(
      classify(['query', 'ai-extract', 'transform', 'guard', 'render'])
        .disqualifying_step_kinds,
    ).toEqual(['ai-extract', 'guard']);

    expect(
      classify(['query', 'guard', 'transform', 'ai-extract', 'render'])
        .disqualifying_step_kinds,
    ).toEqual(['guard', 'ai-extract']);
  });

  it('does not collapse case-variant kinds as duplicates', () => {
    expect(
      classify(['Query', 'query', 'QUERY']).disqualifying_step_kinds,
    ).toEqual(['Query', 'QUERY']);
  });
});

describe('D-164 P4h-2 classifyReplayability — empty input contract', () => {
  it('throws RangeError on an empty step_kinds array', () => {
    expect(() => classify([])).toThrow(RangeError);
  });

  it('throws with a message naming the offending field', () => {
    expect(() => classify([])).toThrow('step_kinds');
  });

  it('does not throw on a single-element array', () => {
    expect(() => classify(['query'])).not.toThrow();
    expect(() => classify(['ai-extract'])).not.toThrow();
  });
});

describe('D-164 P4h-2 classifyReplayability — immutability', () => {
  it('returns a frozen classification', () => {
    const result = classify(['query']);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('returns a frozen disqualifying_step_kinds array on render_template', () => {
    const result = classify(['query']);
    expect(Object.isFrozen(result.disqualifying_step_kinds)).toBe(true);
  });

  it('returns a frozen disqualifying_step_kinds array on structural_plan', () => {
    const result = classify(['ai-extract']);
    expect(Object.isFrozen(result.disqualifying_step_kinds)).toBe(true);
  });

  it('rejects mutation of the result kind in strict mode', () => {
    const result = classify(['query']);
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (result as any).kind = 'structural_plan';
    }).toThrow(TypeError);
  });

  it('rejects push onto disqualifying_step_kinds in strict mode', () => {
    const result = classify(['ai-extract']);
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (result.disqualifying_step_kinds as any).push('extra');
    }).toThrow(TypeError);
  });

  it('does not retain a reference to the caller-supplied step_kinds array', () => {
    const stepKinds: string[] = ['ai-extract', 'guard'];
    const result = classify(stepKinds);

    stepKinds.push('render');

    expect(result.disqualifying_step_kinds).toEqual(['ai-extract', 'guard']);
  });

  it('shares the empty-disqualifying array singleton across render_template calls', () => {
    const a = classify(['query']);
    const b = classify(['render', 'transform']);

    expect(a.disqualifying_step_kinds).toBe(b.disqualifying_step_kinds);
  });
});

describe('D-164 P4h-2 input shape — caller mutations do not affect output', () => {
  it('handles being called with a ReadonlyArray input', () => {
    const stepKinds: ReadonlyArray<string> = Object.freeze(['query', 'render']);
    const result = classifyReplayability({ step_kinds: stepKinds });

    expect(result.kind).toBe('render_template');
  });

  it('handles being called with a wrapping shape carrying just step_kinds', () => {
    const input: ClassifyReplayabilityInput = { step_kinds: ['ai-extract'] };
    const result = classifyReplayability(input);

    expect(result.kind).toBe('structural_plan');
  });
});

describe('D-164 P4h-2 export-surface symmetry with promotion.ts (P4h-1)', () => {
  it('re-exports classifyReplayability via templates/audit-grow/index', () => {
    expect(classifyReplayabilityFromAuditGrowBarrel).toBe(classifyReplayability);
  });

  it('re-exports DETERMINISTIC_STEP_KINDS via templates/audit-grow/index', () => {
    expect(DETERMINISTIC_STEP_KINDS_FROM_AUDIT_GROW_BARREL).toBe(
      DETERMINISTIC_STEP_KINDS,
    );
  });

  it('re-exports isDeterministicStepKind via templates/audit-grow/index', () => {
    expect(isDeterministicStepKindFromAuditGrowBarrel).toBe(
      isDeterministicStepKind,
    );
  });

  it('re-exports classifyReplayability via templates/index public barrel', () => {
    expect(classifyReplayabilityFromPublicBarrel).toBe(classifyReplayability);
  });

  it('re-exports DETERMINISTIC_STEP_KINDS via templates/index public barrel', () => {
    expect(DETERMINISTIC_STEP_KINDS_FROM_PUBLIC_BARREL).toBe(
      DETERMINISTIC_STEP_KINDS,
    );
  });

  it('re-exports isDeterministicStepKind via templates/index public barrel', () => {
    expect(isDeterministicStepKindFromPublicBarrel).toBe(isDeterministicStepKind);
  });
});

describe('D-164 P4h-2 TemplateKind alignment with types.ts', () => {
  it('uses the exact "render_template" literal from the TemplateKind union', () => {
    expect(classify(['query']).kind).toBe('render_template');
  });

  it('uses the exact "structural_plan" literal from the TemplateKind union', () => {
    expect(classify(['ai-extract']).kind).toBe('structural_plan');
  });
});

describe('D-164 P4h-2 DeterministicStepKind type — compile-time spot checks', () => {
  // These are compile-time assertions; if the union widens or narrows
  // beyond the spec'd four, they will fail to typecheck.
  it('admits exactly the four canonical kinds', () => {
    const _q: DeterministicStepKind = 'query';
    const _l: DeterministicStepKind = 'list';
    const _t: DeterministicStepKind = 'transform';
    const _r: DeterministicStepKind = 'render';

    // Runtime sanity — the closed list IS the union's value set.
    expect([_q, _l, _t, _r]).toEqual([...DETERMINISTIC_STEP_KINDS]);
  });
});
