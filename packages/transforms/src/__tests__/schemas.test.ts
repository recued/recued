import { describe, it, expect } from 'vitest';
import { TRANSFORMS } from '../index.js';
import { TRANSFORM_SCHEMAS, getTransformSchema } from '../schemas.js';

describe('TRANSFORM_SCHEMAS', () => {
  it('has exactly one schema per registered transform', () => {
    const transformNames = [...TRANSFORMS.keys()].sort();
    const schemaNames = Object.keys(TRANSFORM_SCHEMAS).sort();
    expect(schemaNames).toEqual(transformNames);
  });

  it('schemas the resolver-generated `project` transform (object + expression required)', () => {
    // `project` is emitted only by the connection-agnostic resolver (the
    // single-object response projection), never authored — but it MUST carry a
    // schema: `validateTransformStep` rejects any transform absent from
    // `TRANSFORM_SCHEMAS` as `unknown_transform`, and the resolved recipe is
    // re-validated at install (`installBulkPack` → `parseRecipe`).
    expect(TRANSFORMS.has('project')).toBe(true);
    const schema = getTransformSchema('project');
    expect(schema?.object?.required).toBe(true);
    expect(schema?.expression?.required).toBe(true);
  });

  it('every schema value is a non-empty object', () => {
    for (const [name, schema] of Object.entries(TRANSFORM_SCHEMAS)) {
      expect(typeof schema, `${name} schema`).toBe('object');
      expect(Object.keys(schema).length, `${name} schema param count`).toBeGreaterThan(0);
    }
  });

  it('every ParamDef has a valid type when declared', () => {
    const validTypes = new Set(['string', 'number', 'boolean', 'array', 'object', 'any']);
    for (const [name, schema] of Object.entries(TRANSFORM_SCHEMAS)) {
      for (const [param, def] of Object.entries(schema)) {
        if (def.type !== undefined) {
          expect(validTypes.has(def.type), `${name}.${param} has invalid type "${def.type}"`).toBe(true);
        }
      }
    }
  });

  it('getTransformSchema returns the schema for a known transform', () => {
    const filterSchema = getTransformSchema('filter');
    expect(filterSchema).toBeDefined();
    // Only `array` is always required. `field`/`operator` are optional
    // because the alternate `conditions` array mode carries its own
    // field+operator per entry.
    expect(filterSchema?.array).toEqual({ required: true, type: 'array' });
    expect(filterSchema?.field).toEqual({ required: false, type: 'string' });
    expect(filterSchema?.value).toEqual({ required: false, type: 'any' });
    expect(filterSchema?.operator?.required).toBe(false);
    expect(filterSchema?.operator?.type).toBe('string');
    expect(filterSchema?.operator?.enum).toBeDefined();
    expect(filterSchema?.operator?.enum).toContain('equal');
    expect(filterSchema?.operator?.enum).toContain('greater');
    expect(filterSchema?.operator?.enum?.length).toBe(14);
    // mode enum is the newer OR/AND toggle
    expect(filterSchema?.mode?.enum).toEqual(['all', 'any']);
  });

  it('getTransformSchema returns undefined for unknown transform', () => {
    expect(getTransformSchema('not_a_real_transform')).toBeUndefined();
  });

  it('every transform has at least one required param OR is marked explicitly optional', () => {
    // Sanity check: a schema with zero required params is suspicious —
    // either the transform really takes no params (none of ours) or the
    // schema is wrong. Flag it for review.
    for (const [name, schema] of Object.entries(TRANSFORM_SCHEMAS)) {
      const hasRequired = Object.values(schema).some(p => p.required === true);
      // Exceptions: sort can use either `fields` or `field`, merge can use
      // either `source` or `sources`, all/any can use either `values` or
      // `conditions`. These legitimately have no single always-required param.
      // math: expression OR left/operator/right — both modes have all-optional params.
      // http_changed: current_etag/previous_etag OR current_hash/previous_hash
      // pairs — either mode has all-optional params (D-115 reactive).
      // attendee_diff (D-117): accepts `prior`+`current` full events OR
      // `prior_attendees`+`current_attendees` raw arrays — both modes have
      // all-optional params to keep first-sync (`prior: null`) type-checking.
      const exceptions = new Set([
        'sort', 'merge', 'all', 'any', 'math', 'http_changed', 'attendee_diff',
      ]);
      if (!exceptions.has(name)) {
        expect(hasRequired, `${name} has no required params`).toBe(true);
      }
    }
  });
});
