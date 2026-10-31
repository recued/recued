import { describe, expect, it } from 'vitest';
import { closedRequestSchemaDefinitionFindings, closedRequestSchemaDefinitionIssues } from '../closed-request-schema.js';

describe('closed schema definition locations', () => {
  it('retains legacy messages and order while separating dotted keys, type values and required-name indices', () => {
    const schema = { type: 'object', additionalProperties: false, requred: [], properties: {
      'a.b': { type: 'object', additionalProperties: false, required: ['sttaus'], properties: { status: { type: 'boolen' } } },
    } };
    const findings = closedRequestSchemaDefinitionFindings(schema);
    const messages = ["unsupported root keyword 'requred'", "property 'a.b' required property 'sttaus' is not declared in properties", "property 'a.b.status' type must be string, number, integer, boolean, array, object, file_ref, or file_ref[]"];
    expect(closedRequestSchemaDefinitionIssues(schema)).toEqual(messages); expect(findings.map(row => row.message)).toEqual(messages);
    expect(findings.map(row => [row.kind, row.path, row.target])).toEqual([
      ['keyword', ['requred'], 'key'], ['required_name', ['properties', 'a.b', 'required', 0], 'value'], ['type', ['properties', 'a.b', 'properties', 'status', 'type'], 'value'],
    ]);
    expect(findings[1]!.choices).toEqual(['status']); expect(findings[2]!.choices).toContain('boolean');
  });
  it('uses the array-item type vocabulary and leaves descriptive schemas open', () => {
    const findings = closedRequestSchemaDefinitionFindings({ type: 'object', additionalProperties: false, properties: { rows: { type: 'array', maxItems: 3, items: { type: 'boolen' } } } });
    expect(findings[0]).toMatchObject({ kind: 'type', path: ['properties', 'rows', 'items', 'type'], choices: ['string', 'number', 'integer', 'boolean', 'object'] });
    expect(closedRequestSchemaDefinitionFindings({ type: 'object', properties: { anything: { type: 'arbitrary' } } })).toEqual([]);
  });
});
