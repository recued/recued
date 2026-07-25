import { describe, expect, it } from 'vitest';
import {
  ERR,
  ERROR_MESSAGES,
  type RecipeErrorCode,
} from '../errors.js';

describe('D-200 typed model refusal contract', () => {
  it('registers a distinct attended-recovery error instead of a parse or network failure', () => {
    const code: RecipeErrorCode = 'AI_MODEL_REFUSED';

    expect(ERR[code]).toBe('warn');
    expect(ERROR_MESSAGES[code]).toContain('use a non-model path');
    expect(code).not.toBe('AI_OUTPUT_INVALID');
    expect(code).not.toBe('NETWORK_ERROR');
  });
});
