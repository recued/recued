import { describe, expect, it } from 'vitest';

import { formatRecipeRunFacts } from '../run-facts.js';

describe('recipe Run facts receipt', () => {
  it('formats the persisted receipt in one stable, grouped order', () => {
    expect(formatRecipeRunFacts({
      steps_run: 34,
      items_total: 1_249,
      provider_calls: 2,
      total_tokens: 13_385,
      duration_ms: 42_000,
    })).toBe(
      '34 steps · 1,249 items · 2 provider calls · 13,385 tokens · 42 seconds',
    );
  });

  it('says where a stop_when ended the run, right after the steps that ran', () => {
    expect(formatRecipeRunFacts({
      steps_run: 3,
      items_total: 0,
      duration_ms: 1_200,
      stopped_at: 'no_new_mail',
    })).toBe('3 steps · ended early at no_new_mail · 0 items · 1.2 seconds');
  });

  it('pluralizes and rounds sub-second duration without losing the receipt', () => {
    expect(formatRecipeRunFacts({
      steps_run: 1,
      items_total: 1,
      provider_calls: 1,
      total_tokens: 1,
      duration_ms: 1_000,
    })).toBe('1 step · 1 item · 1 provider call · 1 token · 1 second');
    expect(formatRecipeRunFacts({
      steps_run: 0,
      items_total: 0,
      duration_ms: 550,
    })).toBe('0 steps · 0 items · 0.6 seconds');
  });

  it('omits an incomplete usage pair and rejects malformed core facts', () => {
    expect(formatRecipeRunFacts({
      steps_run: 3,
      items_total: 8,
      provider_calls: 2,
      duration_ms: 2_000,
    })).toBe('3 steps · 8 items · 2 seconds');
    expect(formatRecipeRunFacts({
      steps_run: -1,
      items_total: 8,
      duration_ms: 2_000,
    })).toBeNull();
  });
});
