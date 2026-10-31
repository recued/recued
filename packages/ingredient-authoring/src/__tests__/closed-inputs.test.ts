import { describe, expect, it } from 'vitest';
import { closedRequestSchemaViolation } from '@recued/contracts';
import { checkClosedInputs, closedInputMetadata } from '../closed-inputs.js';

const schema = { type: 'object', additionalProperties: false, required: ['settings'], properties: {
  settings: { type: 'object', additionalProperties: false, required: ['status'], properties: {
    status: { type: 'string', enum: ['open', 'closed'] }, count: { type: 'integer', minimum: 1, maximum: 4 },
    tags: { type: 'array', maxItems: 3, uniqueItems: true, items: { type: 'string', maxLength: 4 } },
    file: { type: 'file_ref' }, files: { type: 'file_ref[]', maxItems: 2 },
  } },
} };
const prepared = () => closedInputMetadata(schema).schema!;
describe('closed input authoring checks', () => {
  it('agrees with runtime acceptance for literal types, enums, bounds, uniqueness, carriers, unknown and required fields', () => {
    for (const input of [{}, { extra: true }, { settings: {} }, ...[
      { status: 'open' }, { status: 'OPEN' }, { status: 'open', count: 1.5 }, { status: 'open', count: 5 },
      { status: 'open', tags: ['a', 'a'] }, { status: 'open', tags: ['longer'] }, { status: 'open', file: false },
      { status: 'open', file: '-unsafe' }, { status: 'open', file: { backing: 'temp', path: '/tmp/a', filename: 'a', mime_type: 'text/plain' } },
      { status: 'open', files: [true, 5] }, { status: 'open', files: [null] }, { status: 'open', unknown: true },
    ].map(settings => ({ settings }))]) {
      const result = checkClosedInputs(prepared(), input);
      expect(result.complete).toBe(true);
      expect(result.findings.length > 0, JSON.stringify(input)).toBe(closedRequestSchemaViolation(schema, input) !== null);
    }
  });
  it('defers runtime leaves and file carriers while checking literal siblings and array lengths', () => {
    const result = checkClosedInputs(prepared(), { settings: { status: 'status {{step.value}}', count: 0, file: { backing: 'temp', path: '{{step.file}}' }, files: ['{{step.file}}', true, false] } });
    expect(result.findings.map(row => row.path)).toEqual([['settings', 'count'], ['settings', 'files']]);
    expect(result.deferredValues).toBe(3); expect(result.complete).toBe(true);
    // A reference inside an array cannot make that known array a file carrier.
    expect(checkClosedInputs(prepared(), { settings: { status: 'open', file: ['{{step.file}}'] } }).findings.map(row => row.path)).toEqual([['settings', 'file']]);
  });
  it('reports patterns as deferred without running potentially catastrophic regexes', () => {
    const field = closedInputMetadata({ type: 'object', additionalProperties: false, properties: { name: { type: 'string', maxLength: 100, pattern: '^(a+)+$' } } }).schema!;
    const result = checkClosedInputs(field, { name: 'a'.repeat(80) + '!' });
    expect(result.findings).toEqual([]); expect(result.deferredPatterns).toBe(1);
  });
  it('keeps open schemas permissive and refuses invalid or oversized closed metadata and excessive input work', () => {
    expect(closedInputMetadata({ type: 'object', properties: { x: {} } })).toMatchObject({ closed: false, complete: true });
    expect(closedInputMetadata({ ...schema, nullable: true })).toMatchObject({ closed: true, complete: false });
    expect(closedInputMetadata({ ...schema, required: Array(501).fill('settings') })).toMatchObject({ complete: false });
    const many = { type: 'object', additionalProperties: false, properties: { rows: { type: 'array', maxItems: 10000, items: { type: 'integer' } } } };
    expect(checkClosedInputs(closedInputMetadata(many).schema!, { rows: Array(6000).fill(1) }).complete).toBe(false);
  });
});
