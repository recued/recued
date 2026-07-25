import { describe, it, expect } from 'vitest';
import { evaluateCondition } from '../condition.js';
import type { NamespaceStores } from '@recued/contracts';

const stores: NamespaceStores = {
  vault: {},
  config: { threshold: 7, level: 'high' },
  context: {},
  meta: {},
  step: {
    deal: { close_date: '2026-04-01', amount: 150000, stage: 'won' },
    days: 12,
    is_overdue: true,
    risk_score: null,
  },
};

describe('evaluateCondition — string form', () => {
  it('unary is_null (true)', () => {
    expect(evaluateCondition('{{step.risk_score}} is_null', stores)).toBe(true);
  });
  it('unary is_null (false)', () => {
    expect(evaluateCondition('{{step.days}} is_null', stores)).toBe(false);
  });
  it('binary equal', () => {
    expect(evaluateCondition('{{step.deal.stage}} equal won', stores)).toBe(true);
  });
  it('binary equal (false)', () => {
    expect(evaluateCondition('{{step.deal.stage}} equal lost', stores)).toBe(false);
  });
  it('binary greater with ref value', () => {
    expect(evaluateCondition('{{step.days}} greater {{config.threshold}}', stores)).toBe(true);
  });
  it('binary greater with literal', () => {
    expect(evaluateCondition('{{step.days}} greater 20', stores)).toBe(false);
  });
  it('equal true (boolean)', () => {
    expect(evaluateCondition('{{step.is_overdue}} equal true', stores)).toBe(true);
  });
  it('equal false (boolean)', () => {
    expect(evaluateCondition('{{step.is_overdue}} equal false', stores)).toBe(false);
  });
});

describe('evaluateCondition — object form', () => {
  it('object with array value (in)', () => {
    expect(evaluateCondition(
      { field: '{{step.deal.stage}}', operator: 'in', value: ['won', 'lost'] },
      stores,
    )).toBe(true);
  });
  it('object is_not_empty', () => {
    expect(evaluateCondition(
      { field: '{{step.deal}}', operator: 'is_not_empty' },
      stores,
    )).toBe(true);
  });
});
