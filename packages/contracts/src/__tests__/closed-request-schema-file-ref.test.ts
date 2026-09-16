/** `file_ref` / `file_ref[]` as closed-subset property types.
 *
 *  ⛔ WHY THEY EXIST. 99 cli ops across 45 packs could not declare a closed
 *  request schema at all, so they accepted ANY argument shape whatever their
 *  description claimed. The blocker was a type mismatch with no third option:
 *  spelling the property `file_ref` failed the schema definition (the closed
 *  types were string/number/integer/boolean/array/object), and spelling it
 *  `string` failed the authoring alignment check, which demands
 *  `schemaType === arg.type`. A `file_ref` is polymorphic — a record id string in
 *  one op, a temp-ref object in another — and the closed subset has no union
 *  keyword, deliberately.
 *
 *  🔑 THE RESOLUTION IS A TYPE WHOSE MEANING IS FIXED IN CONTRACTS, not a union
 *  every pack restates. That also keeps the subset's own rule intact: a publisher
 *  cannot write half a file_ref and have the other half silently unenforced.
 */
import { describe, expect, it } from 'vitest';

import {
  FILE_REF_JSON_SCHEMA,
  closedRequestSchemaDefinitionIssues,
  closedRequestSchemaViolation,
  isFileRefArgumentValue,
  projectClosedRequestSchemaForJsonSchema,
} from '../closed-request-schema.js';

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['source'],
  properties: { source: { type: 'file_ref' } },
};

const arraySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['sources'],
  properties: { sources: { type: 'file_ref[]', minItems: 2, maxItems: 16 } },
};

const TEMP_REF = {
  backing: 'temp', path: '/tmp/run/out.txt', mime_type: 'text/plain', filename: 'out.txt',
};
const PINNED_REF = {
  backing: 'cas',
  record_id: 'file:0123456789abcdef0123456789abcdef',
  content_sha256: 'a'.repeat(64),
};

describe('file_ref as a closed-subset type', () => {
  it('both schemas are well-formed definitions', () => {
    expect(closedRequestSchemaDefinitionIssues(schema)).toEqual([]);
    expect(closedRequestSchemaDefinitionIssues(arraySchema)).toEqual([]);
  });

  it('⛔ carries NO constraint keywords — a half-binding constraint is the thing forbidden', () => {
    // `pattern` / `maxLength` could only ever bind the string branch of the union,
    // which is exactly "a constraint that looks enforced while being ignored".
    expect(closedRequestSchemaDefinitionIssues({
      ...schema,
      properties: { source: { type: 'file_ref', pattern: '^file:' } },
    })).toEqual([`property 'source' uses unsupported keyword 'pattern' for type 'file_ref'`]);
  });

  it('a file_ref[] must declare a maxItems bound, like any other list', () => {
    expect(closedRequestSchemaDefinitionIssues({
      ...arraySchema,
      properties: { sources: { type: 'file_ref[]' } },
    })).toEqual([`property 'sources' must declare a non-negative maxItems bound`]);
  });
});

describe('the acceptor mirrors the runtime, and is not narrower', () => {
  // `input_materialize` resolves a temp ref to its path, materializes a pinned
  // carrier or a recognized record id, and passes anything else through to the
  // tool as a literal path/URL via `scalarString` (string/number/boolean).
  it.each([
    ['a CAS record id', 'file:0123456789abcdef0123456789abcdef'],
    ['a remote mirror id', 'file:remote:drive:1AbC'],
    ['a local path', '/home/me/report.pdf'],
    ['a relative path', 'docs/report.pdf'],
    ['a URL', 'https://example.com/a.pdf'],
    ['a numeric filename', 12345],
    ['a temp ref', TEMP_REF],
    ['a pinned CAS ref', PINNED_REF],
  ])('accepts %s', (_label, value) => {
    expect(closedRequestSchemaViolation(schema, { source: value })).toBeNull();
  });

  it.each([
    ['null', null],
    ['an empty string', ''],
    ['a list, for the singular form', ['a.pdf']],
    ['a bare object', {}],
    ['a HALF-FORMED temp ref', { backing: 'temp', path: '/etc/passwd' }],
    ['a pinned ref with a bad hash', { ...PINNED_REF, content_sha256: 'nope' }],
  ])('rejects %s', (_label, value) => {
    expect(closedRequestSchemaViolation(schema, { source: value })).toContain('file reference');
  });

  it('⛔ a LEADING DASH is flag injection, not a file', () => {
    // The passthrough lane hands this straight into argv, so `-i` would be read
    // by the tool as an option. Every pack that gave one of these args a card
    // pattern already wrote `^(?!-)`; a `pattern` could not bind the union, so
    // the rule lives in the acceptor.
    expect(closedRequestSchemaViolation(schema, { source: '-i' })).toContain('file reference');
    expect(isFileRefArgumentValue('--output')).toBe(false);
    // ...and a path that merely CONTAINS a dash is fine.
    expect(isFileRefArgumentValue('./-weird-name.txt')).toBe(true);
  });

  it('closes the argument surface the way any closed schema does', () => {
    expect(closedRequestSchemaViolation(schema, {})).toContain('missing required');
    expect(closedRequestSchemaViolation(schema, { source: 'a.pdf', extra: '--delete' }))
      .toContain('undeclared');
  });

  it('a file_ref[] validates its items and its bounds', () => {
    expect(closedRequestSchemaViolation(arraySchema, { sources: ['a.pdf', TEMP_REF] })).toBeNull();
    expect(closedRequestSchemaViolation(arraySchema, { sources: ['a.pdf'] }))
      .toContain('fewer than 2');
    expect(closedRequestSchemaViolation(arraySchema, { sources: Array(17).fill('a.pdf') }))
      .toContain('more than 16');
    expect(closedRequestSchemaViolation(arraySchema, { sources: ['a.pdf', null] }))
      .toContain('file reference');
  });
});

describe('the JSON-Schema projection', () => {
  it('⛔ no file_ref type survives — it is not JSON Schema', () => {
    const out = projectClosedRequestSchemaForJsonSchema(arraySchema) as {
      properties: { sources: { type?: string; items?: unknown; maxItems?: number } };
    };
    expect(out.properties.sources.type).toBe('array');
    expect(out.properties.sources.items).toEqual(FILE_REF_JSON_SCHEMA);
    expect(out.properties.sources.maxItems).toBe(16);
    // ⚠ The INVARIANT is that no file_ref TYPE survives — not that the word is
    // absent. The projection's human-readable description names the carrier on
    // purpose, and a blanket string check flags that as a leak.
    expect(JSON.stringify(out)).not.toContain('"type":"file_ref');
  });

  it('projects the singular form to the union', () => {
    const out = projectClosedRequestSchemaForJsonSchema(schema) as {
      properties: { source: unknown };
    };
    expect(out.properties.source).toEqual(FILE_REF_JSON_SCHEMA);
  });

  it('returns a schema with nothing to project UNCHANGED, by identity', () => {
    // The common path must not allocate; identity is the cheap way to assert it.
    const plain = {
      type: 'object',
      additionalProperties: false,
      properties: { q: { type: 'string', maxLength: 8 } },
    };
    expect(projectClosedRequestSchemaForJsonSchema(plain)).toBe(plain);
  });

  it('the projection is itself valid JSON Schema shape for every branch', () => {
    // Each branch names a concrete JSON type; nothing leaks a bespoke keyword.
    const branches = (FILE_REF_JSON_SCHEMA as { anyOf: { type: string }[] }).anyOf;
    expect(branches.map((b) => b.type)).toEqual(['string', 'number', 'boolean', 'object', 'object']);
  });
});
