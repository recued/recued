import { describe, it, expect } from 'vitest';
import { OPS, type ConditionOp } from '@recued/contracts';
import type { RecipeStep } from '@recued/contracts';
import {
  CONDITION_OP_LABELS,
  detectStepKind,
  getStepDiscriminator,
  isReference,
  detectStepFieldType,
  enumerateTransformParams,
  enumerateIngredientInputs,
  enumerateOpArgs,
} from '../step-logic.js';

const transformStep = { id: 't', transform: 'filter', field: '{{step.x}}', operator: 'equal', value: '1' } as unknown as RecipeStep;
const ingredientStep = { id: 'i', ingredient: 'reader-x', input: { url: 'https://x', limit: 5 } } as unknown as RecipeStep;
const guardStep = { id: 'g', guard: 'has-token' } as unknown as RecipeStep;
const opStep = { id: 'o', op: 'deal.search', args: { query: 'x', limit: 10 } } as unknown as RecipeStep;

describe('detectStepKind', () => {
  it('discriminates all four kinds — incl. the op branch (D-182 drift fix)', () => {
    expect(detectStepKind(transformStep)).toBe('transform');
    expect(detectStepKind(ingredientStep)).toBe('ingredient');
    expect(detectStepKind(guardStep)).toBe('guard');
    expect(detectStepKind(opStep)).toBe('op');
  });
});

describe('getStepDiscriminator', () => {
  it('returns the discriminator string per kind', () => {
    expect(getStepDiscriminator(transformStep)).toBe('filter');
    expect(getStepDiscriminator(ingredientStep)).toBe('reader-x');
    expect(getStepDiscriminator(guardStep)).toBe('has-token');
    expect(getStepDiscriminator(opStep)).toBe('deal.search');
  });
});

describe('isReference', () => {
  it('detects template refs vs literals', () => {
    expect(isReference('{{step.x}}')).toBe(true);
    expect(isReference('plain')).toBe(false);
    expect(isReference(5)).toBe(false);
  });
});

describe('detectStepFieldType', () => {
  it('refs are unsupported, enums win, else runtime type', () => {
    expect(detectStepFieldType('{{step.x}}')).toBe('unsupported');
    expect(detectStepFieldType('hi', { enum: ['a', 'b'] } as never)).toBe('enum');
    expect(detectStepFieldType(true)).toBe('boolean');
    expect(detectStepFieldType(3)).toBe('number');
    expect(detectStepFieldType('s')).toBe('string');
    expect(detectStepFieldType({ a: 1 })).toBe('unsupported');
    expect(detectStepFieldType([1, 2])).toBe('unsupported');
  });
});

describe('enumerateTransformParams', () => {
  it('returns non-reserved params for a transform; [] for other kinds', () => {
    const names = enumerateTransformParams(transformStep).map((p) => p.name);
    expect(names).toContain('field');
    expect(names).toContain('operator');
    expect(names).toContain('value');
    expect(names).not.toContain('id');
    expect(names).not.toContain('transform');
    expect(enumerateTransformParams(ingredientStep)).toEqual([]);
  });
});

describe('enumerateIngredientInputs / enumerateOpArgs', () => {
  it('walks input / args maps', () => {
    expect(enumerateIngredientInputs(ingredientStep).map((e) => e.name).sort()).toEqual(['limit', 'url']);
    expect(enumerateIngredientInputs(transformStep)).toEqual([]);
    expect(enumerateOpArgs(opStep).map((e) => e.name).sort()).toEqual(['limit', 'query']);
    expect(enumerateOpArgs(ingredientStep)).toEqual([]);
  });
});

describe('CONDITION_OP_LABELS', () => {
  it('covers exactly the 14 canonical operators, no extras', () => {
    expect(CONDITION_OP_LABELS).toHaveLength(14);
    const labelled = new Set(CONDITION_OP_LABELS.map((o) => o.op));
    expect(labelled.size).toBe(14);
    for (const op of OPS as Set<ConditionOp>) {
      expect(labelled.has(op)).toBe(true);
    }
  });
});
