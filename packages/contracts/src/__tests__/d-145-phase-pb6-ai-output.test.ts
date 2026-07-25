/** D-145 PB6 — AIOutput shape contract tests.
 *
 *  Covers § B.7.1 AIOutput closed shape (response + events +
 *  tool_calls), `validateAIOutput` shape gate, substrate self-check
 *  (`assertAIOutputInvariants`). D-164 P6b/c retired the
 *  `cognition_diff` slot + cognition placeholder helpers. */

import { describe, expect, it } from 'vitest';

import {
  AI_OUTPUT_VALIDATION_KINDS,
  AI_OUTPUT_VALIDATION_KIND_SET,
  assertAIOutputInvariants,
  coerceAIOutput,
  validateAIOutput,
  type AIOutput,
} from '../ai-output.js';

describe('D-145 PB6 — AI_OUTPUT_VALIDATION_KINDS closed list', () => {
  it('contains exactly 3 entries', () => {
    expect(AI_OUTPUT_VALIDATION_KINDS.length).toBe(3);
    expect(new Set(AI_OUTPUT_VALIDATION_KINDS)).toEqual(
      new Set([
        'response_not_string',
        'events_not_array',
        'tool_calls_not_array',
      ]),
    );
  });

  it('AI_OUTPUT_VALIDATION_KIND_SET pinned in lockstep', () => {
    expect(AI_OUTPUT_VALIDATION_KIND_SET.size).toBe(
      AI_OUTPUT_VALIDATION_KINDS.length,
    );
  });
});

describe('D-145 PB6 — validateAIOutput', () => {
  const baseValid: AIOutput = {
    response: 'Nice — what kind?',
    events: [
      {
        kind: 'extraction.purchase',
        confidence: 0.92,
        args: { amount: 5000, currency: 'USD' },
      },
    ],
    tool_calls: [],
  };

  it('accepts a fully-valid AIOutput', () => {
    expect(validateAIOutput(baseValid)).toEqual([]);
  });

  it('accepts AIOutput with empty events + tool_calls', () => {
    expect(
      validateAIOutput({
        response: 'Sounds good',
        events: [],
        tool_calls: [],
      }),
    ).toEqual([]);
  });

  it('flags response_not_string when response is missing / wrong type', () => {
    const issues = validateAIOutput({
      ...baseValid,
      response: 42 as unknown as string,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.kind).toBe('response_not_string');
  });

  it('flags events_not_array when events is not array', () => {
    const issues = validateAIOutput({
      ...baseValid,
      events: 'not array' as unknown as AIOutput['events'],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.kind).toBe('events_not_array');
  });

  it('flags tool_calls_not_array when tool_calls is not array', () => {
    const issues = validateAIOutput({
      ...baseValid,
      tool_calls: null as unknown as AIOutput['tool_calls'],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.kind).toBe('tool_calls_not_array');
  });

  it('reports ALL issues at once when multiple fields are bad', () => {
    const issues = validateAIOutput({
      response: undefined as unknown as string,
      events: 'oops' as unknown as AIOutput['events'],
      tool_calls: undefined as unknown as AIOutput['tool_calls'],
    });
    expect(issues).toHaveLength(3);
    expect(new Set(issues.map((i) => i.kind))).toEqual(
      new Set([
        'response_not_string',
        'events_not_array',
        'tool_calls_not_array',
      ]),
    );
  });
});

describe('D-145 PB6 — validateAIOutput untrusted-input guard (Codex P2)', () => {
  it('null input emits all three structural issues without throwing', () => {
    const issues = validateAIOutput(null);
    expect(issues).toHaveLength(3);
    expect(new Set(issues.map((i) => i.kind))).toEqual(
      new Set([
        'response_not_string',
        'events_not_array',
        'tool_calls_not_array',
      ]),
    );
  });

  it('undefined input emits all three structural issues without throwing', () => {
    const issues = validateAIOutput(undefined);
    expect(issues).toHaveLength(3);
  });

  it('primitive input (string / number / boolean) emits all three issues', () => {
    expect(validateAIOutput('not an output')).toHaveLength(3);
    expect(validateAIOutput(42)).toHaveLength(3);
    expect(validateAIOutput(true)).toHaveLength(3);
  });

  it('object missing all three fields emits all three issues', () => {
    const issues = validateAIOutput({});
    expect(issues).toHaveLength(3);
  });
});

describe('D-145 PB6 — assertAIOutputInvariants', () => {
  it('passes on the as-shipped substrate', () => {
    expect(() => assertAIOutputInvariants()).not.toThrow();
  });
});

describe('coerceAIOutput — real-model envelope normalization', () => {
  it('fills a MISSING events key (model dropped the empty optional)', () => {
    const out = coerceAIOutput({
      response: 'hi',
      tool_calls: [{ tool: 'contact.search', args: { query: 'x' } }],
    });
    expect(validateAIOutput(out)).toHaveLength(0);
    expect((out as AIOutput).events).toEqual([]);
    // present fields preserved untouched
    expect((out as AIOutput).response).toBe('hi');
    expect((out as AIOutput).tool_calls).toHaveLength(1);
  });

  it('fills missing tool_calls AND events for a response-only object', () => {
    const out = coerceAIOutput({ response: 'just talking' }) as AIOutput;
    expect(validateAIOutput(out)).toHaveLength(0);
    expect(out.events).toEqual([]);
    expect(out.tool_calls).toEqual([]);
  });

  it('fills a missing response (model emitted only a tool call)', () => {
    const out = coerceAIOutput({ events: [], tool_calls: [] }) as AIOutput;
    expect(validateAIOutput(out)).toHaveLength(0);
    expect(out.response).toBe('');
  });

  it('is a no-op on a well-formed envelope (all keys present)', () => {
    const input = { response: 'r', events: [], tool_calls: [] };
    const out = coerceAIOutput(input) as AIOutput;
    expect(out).toEqual(input);
    expect(validateAIOutput(out)).toHaveLength(0);
  });

  it('does NOT mask a present null field — validateAIOutput still flags it', () => {
    // A genuinely malformed envelope (null, not a dropped key) must stay
    // malformed; `??` would have masked this, the `=== undefined` guard does not.
    const out = coerceAIOutput({ response: 'r', events: null, tool_calls: [] });
    const issues = validateAIOutput(out);
    expect(issues.map((i) => i.kind)).toContain('events_not_array');
  });

  it('does NOT rewrite a present wrong-typed field', () => {
    const out = coerceAIOutput({
      response: 'r',
      events: 'oops',
      tool_calls: [],
    }) as Record<string, unknown>;
    expect(out.events).toBe('oops');
    expect(validateAIOutput(out).map((i) => i.kind)).toContain(
      'events_not_array',
    );
  });

  it('wraps a bare {tool, args} into the tool_calls envelope', () => {
    const out = coerceAIOutput({
      tool: 'bench/send-email',
      args: { to: 'a@b.com' },
    }) as AIOutput;
    expect(validateAIOutput(out)).toHaveLength(0);
    expect(out.response).toBe('');
    expect(out.tool_calls).toEqual([
      { tool: 'bench/send-email', args: { to: 'a@b.com' } },
    ]);
  });

  it('does NOT reinterpret a normal envelope that also happens to carry a tool key', () => {
    // wrapper keys present → common-case branch, NOT the bare-tool branch.
    const out = coerceAIOutput({
      response: 'r',
      tool_calls: [{ tool: 't', args: {} }],
      tool: 'stray',
    }) as Record<string, unknown>;
    expect((out.tool_calls as unknown[])).toHaveLength(1);
    expect(out.tool).toBe('stray'); // spread preserves the stray key, not wrapped
  });

  it('wraps a bare array of tool calls into the envelope', () => {
    const out = coerceAIOutput([
      { tool: 'a', args: {} },
      { tool: 'b', args: {} },
    ]) as AIOutput;
    expect(validateAIOutput(out)).toHaveLength(0);
    expect(out.tool_calls).toHaveLength(2);
  });

  it('returns non-object / non-array primitives unchanged', () => {
    expect(coerceAIOutput(null)).toBeNull();
    expect(coerceAIOutput('raw text')).toBe('raw text');
    expect(coerceAIOutput(42)).toBe(42);
    // and validateAIOutput still rejects them
    expect(validateAIOutput(coerceAIOutput('raw text'))).toHaveLength(3);
  });
});
