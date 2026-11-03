import { describe, expect, it } from 'vitest';
import { restIntegerSelector, restIntegerCandidate, restJsonShapeTarget, restJsonFields } from '../rest-json-authoring.js';
import { validateComposition } from '../validators.js';

const body = (): any => ({ schema_version: 1, slug: 'json-api', catalog_kind: 'official',
  ingredients: [{ slug: 'json-api', kind: 'http', http: { base: 'https://api.example.com' } }],
  operations: [{ op: 'record.create', ingredient: 'json-api', risk: 'write', approval: 'always',
    args: [{ key: 'body.id', type: 'string' }, { key: 'body.ids', type: 'array' }],
    request_schema: { type: 'object', properties: { 'body.id': { type: 'string' }, 'body.ids': { type: 'array', items: { type: 'string' } } } },
    bind: { kind: 'rest', method: 'POST', path_template: '/records', request_json: { decimal_integer_fields: ['id', 'ids[]'] }, response_json: { unsafe_integers: 'string' } },
  }],
});
describe('shared REST JSON authoring rules', () => {
  it('admits only the canonical top-level selector grammar and explicit string/array schema agreement', () => {
    expect(restIntegerSelector('ids[]')).toEqual({ key: 'ids', array: true, argument: 'body.ids' });
    for (const value of ['nested.id', 'id[0]', 'id[][]', '', 'id ', null]) expect(restIntegerSelector(value)).toBeUndefined();
    expect(restIntegerCandidate('body.id', undefined, 'string', undefined)?.selector).toBe('id');
    expect(restIntegerCandidate('body.ids', 'array', 'array', 'string')?.selector).toBe('ids[]');
    for (const args of [['body.ids', 'array', 'array', 'number'], ['body.id', 'number', 'string', undefined], ['body.id.child', 'string', 'string', undefined], ['query.id', 'string', 'string', undefined]] as const) expect(restIntegerCandidate(args[0], args[1], args[2], args[3])).toBeUndefined();
  });
  it('keeps valid declarations valid and locates both mismatch findings on the offending selector', () => {
    const source = body(); expect(validateComposition(source).valid).toBe(true);
    source.operations[0].bind.request_json.decimal_integer_fields = ['id', 'missing'];
    const issues = validateComposition(source).issues.filter(issue => issue.code.startsWith('composition_rest_request_json_'));
    expect(issues).toEqual([
      expect.objectContaining({ code: 'composition_rest_request_json_arg_mismatch', path: 'operations[0].bind.request_json.decimal_integer_fields[1]', message: "request_json selector 'missing' requires declared arg 'body.missing' with type 'string'" }),
      expect.objectContaining({ code: 'composition_rest_request_json_schema_mismatch', path: 'operations[0].bind.request_json.decimal_integer_fields[1]' }),
    ]);
  });
  it('retains one shape finding while locating bad or repeated items and misspelled setting keys', () => {
    for (const selectors of [['id', 'nested.id'], ['id', 'id'], ['id', 42]]) {
      const source = body(); source.operations[0].bind.request_json.decimal_integer_fields = selectors;
      const issues = validateComposition(source).issues.filter(issue => issue.code === 'composition_rest_request_json_decimal_integer_fields');
      expect(issues).toHaveLength(1); expect(issues[0]!.path).toBe('operations[0].bind.request_json.decimal_integer_fields[1]');
    }
    const source = body(); source.operations[0].bind.response_json = { unsafe_integerz: 'string' };
    expect(validateComposition(source).issues).toContainEqual(expect.objectContaining({ code: 'composition_rest_response_json_unsafe_integers', path: 'operations[0].bind.response_json.unsafe_integerz', reference_span: { target: 'key', offset: 0, length: 15 } }));
    expect(restJsonShapeTarget('request', { decimal_integer_fields: [] })).toEqual({ path: ['decimal_integer_fields'] });
  });
  it('keeps body-method, literal header and capture conflicts authoritative without changing policies', () => {
    const source = body(), op = source.operations[0]; op.bind.method = 'GET'; op.bind.static_headers = { 'cOnTeNt-TyPe': 'text/plain' }; op.bind.response_capture = { kind: 'file_ref', filename_source: { kind: 'header' } };
    const issues = validateComposition(source).issues;
    expect(issues).toContainEqual(expect.objectContaining({ code: 'composition_rest_request_json_content_type', path: 'operations[0].bind.static_headers["cOnTeNt-TyPe"]' }));
    expect(issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['composition_rest_request_json_method', 'composition_rest_response_json_capture_conflict']));
    expect(op.risk).toBe('write'); expect(op.approval).toBe('always');
    expect(restJsonFields('response')[0]!.description).toContain('Safe integers, floats');
  });
});
