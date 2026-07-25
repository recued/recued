import { describe, expect, it } from 'vitest';

import {
  computeContextInputTokenBudget,
  estimateConservativeMessageTokens,
  estimateConservativeMessagesTokens,
  estimateConservativeTextTokens,
} from '../context-budget.js';

describe('context budget', () => {
  it('reserves output and safety capacity from the declared model window', () => {
    expect(computeContextInputTokenBudget(8_192, 4_000)).toBe(3_936);
    expect(computeContextInputTokenBudget(8_192, 4_000, 192)).toBe(4_000);
  });

  it('rejects invalid metadata and windows with no input capacity', () => {
    expect(computeContextInputTokenBudget(0, 1)).toBeNull();
    expect(computeContextInputTokenBudget(8_192.5, 1)).toBeNull();
    expect(computeContextInputTokenBudget(8_192, -1)).toBeNull();
    expect(computeContextInputTokenBudget(4_000, 4_000)).toBeNull();
  });

  it('uses UTF-8 bytes rather than an unsafe chars-per-token heuristic', () => {
    expect(estimateConservativeTextTokens('plain')).toBe(5);
    expect(estimateConservativeTextTokens('👩‍💻')).toBeGreaterThan('👩‍💻'.length);
  });

  it('adds stable per-message framing and sums message lists', () => {
    const messages = [
      { role: 'system' as const, content: 'rules' },
      { role: 'user' as const, content: 'hello' },
    ];
    expect(estimateConservativeMessagesTokens(messages)).toBe(
      messages.reduce(
        (total, message) => total + estimateConservativeMessageTokens(message),
        0,
      ),
    );
  });
});
