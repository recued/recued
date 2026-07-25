/** D-145 PB15 — no-alternative mapping tests. */

import { describe, it, expect } from 'vitest';
import {
  MAX_CONFLICT_EXPLANATION_LEN,
  composeNoAlternativeFailure,
} from '../no-alternative-mapping.js';

describe('D-145 PB15 — composeNoAlternativeFailure', () => {
  it('produces cancelled_no_alternative + synthesis failure_class', () => {
    const result = composeNoAlternativeFailure({
      conflict_explanation: 'date is fixed_slot but no free slot exists in week',
    });
    expect(result.status).toBe('cancelled_no_alternative');
    expect(result.failure_class).toBe('synthesis');
  });

  it('embeds conflict_explanation verbatim in user_response', () => {
    const result = composeNoAlternativeFailure({
      conflict_explanation: 'specific_conflict_reason',
    });
    expect(result.user_response).toContain('specific_conflict_reason');
  });

  it('truncates conflict_explanation above MAX_CONFLICT_EXPLANATION_LEN with ellipsis', () => {
    const long = 'x'.repeat(MAX_CONFLICT_EXPLANATION_LEN + 100);
    const result = composeNoAlternativeFailure({ conflict_explanation: long });
    expect(result.user_response).toContain('…');
    // The trimmed substring is MAX-1 chars + ellipsis = MAX total preserved
    // body within the broader template.
    expect(result.user_response.length).toBeLessThan(long.length + 200);
  });

  it('appends next_action_options when provided', () => {
    const result = composeNoAlternativeFailure({
      conflict_explanation: 'no slot',
      next_action_options: ['relax', 'escalate'],
    });
    expect(result.user_response).toMatch(/Options: relax, escalate/);
  });

  it('omits options clause when next_action_options is empty', () => {
    const result = composeNoAlternativeFailure({
      conflict_explanation: 'no slot',
      next_action_options: [],
    });
    expect(result.user_response).not.toMatch(/Options:/);
  });
});
