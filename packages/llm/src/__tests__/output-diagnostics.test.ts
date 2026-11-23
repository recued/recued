import { expect, it } from 'vitest';
import { inspectLLMOutput } from '../output-diagnostics.js';

it('counts serialized top-level spans while respecting escapes, nesting and repeated fields', () => {
  const value = [{ tool: 'browser', args: { text: 'A } , " \\ value', list: [1, 2] } }];
  const serialized = JSON.stringify(value);
  const raw = `{"reasoning":"short","tool_calls":${serialized},"response":"a","response":"bc"}`;
  const result = inspectLLMOutput(raw, 'stop');
  expect(result).toMatchObject({ json_valid: true, root_closed: true, raw_chars: raw.length,
    tail_field: null, tail_position: null, tail_in_string: false,
    fields: { reasoning: { serialized_chars: 7, occurrences: 1, closed: true },
      tool_calls: { serialized_chars: serialized.length, occurrences: 1, closed: true },
      response: { serialized_chars: 7, occurrences: 2, closed: true } } });
});

it.each([
  ['{"reasoning":"unfinished', 'reasoning', 'value', true],
  ['{"response":"","tool_calls":[{"args":{"text":"unfinished', 'tool_calls', 'value', true],
  ['{"response":"done","tool_ca', null, 'key', true],
  ['{"response":"done",', null, 'key', false],
  ['{"response":"done"', 'response', 'after_value', false],
  ['{"nothing_outstanding":', 'nothing_outstanding', 'value', false],
] as const)('identifies the truncation location without returning generated text (%s)', (raw, field, position, inString) => {
  expect(inspectLLMOutput(raw, 'length')).toMatchObject({ json_valid: false, root_closed: false,
    finish_reason: 'length', tail_field: field, tail_position: position, tail_in_string: inString });
});

it('never retains values or arbitrary generated property names, including malformed secret-like output', () => {
  for (const raw of ['{"secret-email@example.test":"password-private","response":"private-answer"}',
    '{"secret-email@example.test":{"password":"private-answer', 'private-answer']) {
    const encoded = JSON.stringify(inspectLLMOutput(raw));
    for (const secret of ['secret-email', 'password', 'private-answer']) expect(encoded).not.toContain(secret);
  }
  expect(inspectLLMOutput('{"anything":1}').fields).toEqual({ other: { serialized_chars: 1, occurrences: 1, closed: true } });
});

it('bounds scanning and handles fenced JSON and malformed nesting without failing', () => {
  expect(inspectLLMOutput('```json\n{"response":"yes"}\n```')).toMatchObject({ json_valid: true, root_closed: true });
  expect(inspectLLMOutput('{"tool_calls":' + '['.repeat(130))).toMatchObject({ json_valid: false, root_closed: false });
  expect(inspectLLMOutput('{"tool_calls":[}')).toMatchObject({ json_valid: false, root_closed: false });
  const result = inspectLLMOutput('{"reasoning":"' + 'x'.repeat(2_000_001));
  expect(result).toMatchObject({ scanned_chars: 2_000_000, scan_truncated: true, json_valid: null,
    tail_field: 'reasoning', tail_position: 'value', tail_in_string: true });
});

it('counts browser checklist metadata without retaining its owner quotes or source excerpts', () => {
  const raw = JSON.stringify({ browser_task_progress: [{ requirement: 'private owner request', status: 'confirmed',
    evidence: [{ call: 0, quote: 'private page excerpt' }] }], response: '' });
  const result = inspectLLMOutput(raw);
  expect(result.fields.browser_task_progress).toMatchObject({ occurrences: 1, closed: true });
  expect(JSON.stringify(result)).not.toContain('private');
});
