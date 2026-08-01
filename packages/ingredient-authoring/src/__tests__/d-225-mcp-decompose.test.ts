/** D-225 Slice 1 — the decomposer lowers an mcp bind to an mcp dispatch.
 *
 *  Two lowerings exist and they emit DIFFERENT wire shapes, which is the point
 *  of testing both: `connection.api` reads `method` + `path`, `connection.mcp`
 *  reads `tool` (`PER_CONNECTION_KIND_REQUIRED` in the ingredient validator).
 *  A lowering that emitted `method`/`path` for an mcp op would produce a
 *  wrapper the mcp handler cannot dispatch — and nothing at authoring time
 *  would say so.
 */
import { describe, expect, it } from 'vitest';
import type { ApiExecutionBinding, IngredientManifest } from '@recued/contracts';

import { decomposeComposition } from '../decomposer.js';

type Composition = Parameters<(typeof decomposeComposition)[1]>[0];

const composition = (over: Record<string, unknown> = {}): Composition => ({
  schema_version: 1,
  slug: 'peer-project-list',
  name: 'Peer Project List',
  description: 'D-225 Slice 1 mcp decompose fixture.',
  ingredients: [
    { slug: 'peer', kind: 'connection', connection: { connection: 'mcp' } },
  ],
  operations: [
    {
      op: 'project.list',
      ingredient: 'peer',
      risk: 'read',
      approval: 'never',
      bind: { kind: 'mcp', tool: 'project.list' },
    },
  ],
  ...over,
} as unknown as Composition);

const decompose = (c: Composition) => decomposeComposition[1]!(c);

describe('D-225 Slice 1 — mcp decompose', () => {
  it('lowers a 1x1 mcp composition to a connection_kind mcp wrapper carrying the tool', () => {
    const out = decompose(composition());
    const ing = out.ingredient as IngredientManifest;

    expect(ing).toBeDefined();
    expect(ing.kind).toBe('connection');
    expect(ing.input.connection_kind).toBe('mcp');
    expect(ing.input.tool).toBe('project.list');
    // The connection stays a `{{config.X}}` picker — a peer is chosen per dish,
    // never baked into the manifest.
    expect(String(ing.input.connection)).toMatch(/^\{\{config\./);
    // ⛔ The api wire keys must NOT be present. `connection.mcp` would ignore
    // them, and their presence would make the wrapper look dispatchable as api.
    expect(ing.input.method).toBeUndefined();
    expect(ing.input.path).toBeUndefined();
  });

  it('still lowers a 1x1 rest composition to method + path — the mcp arm is additive', () => {
    // The paired direction. A refactor that made every 1x1 emit the mcp shape
    // would pass the test above and break every shipped REST pack.
    const rest = composition({
      ingredients: [{ slug: 'peer', kind: 'http', http: { base: 'https://api.example.com' } }],
      operations: [{
        op: 'project.list',
        ingredient: 'peer',
        risk: 'read',
        approval: 'never',
        bind: { kind: 'rest', method: 'GET', path_template: '/projects' },
      }],
    });
    const ing = decompose(rest).ingredient as IngredientManifest;

    expect(ing.input.connection_kind).toBe('api');
    expect(ing.input.method).toBe('GET');
    expect(ing.input.path).toBe('/projects');
    expect(ing.input.tool).toBeUndefined();
  });

  it('derives transport mcp and an EMPTY base URL on a multi-op mcp catalog', () => {
    const multi = composition({
      operations: [
        { op: 'project.list', ingredient: 'peer', risk: 'read', approval: 'never',
          bind: { kind: 'mcp', tool: 'project.list' } },
        { op: 'project.create', ingredient: 'peer', risk: 'write', approval: 'ask',
          bind: { kind: 'mcp', tool: 'project.create' } },
      ],
    });
    const catalog = decompose(multi).catalog as IngredientManifest;

    expect(catalog.surfaces?.api?.transport).toBe('mcp');
    // ⚠ NOT the `https://api.example.com` placeholder the rest path falls back
    // to. An mcp surface joins no paths; emitting a placeholder would state
    // something false and teach the next author to copy it.
    expect(catalog.surfaces?.api?.default_base_url).toBe('');
    const executes = catalog.surfaces?.api?.executes as Record<string, ApiExecutionBinding>;
    expect(executes['project.list']).toMatchObject({ kind: 'mcp', tool: 'project.list' });
    expect(executes['project.create']).toMatchObject({ kind: 'mcp', tool: 'project.create' });
  });

  it('reports transport mcp even when the surface also carries a rest binding', () => {
    // A mixed surface carries ONE transport label while `executes` holds a mix,
    // and the per-op `bind.kind` is what actually dispatches. mcp must win the
    // label: the rest fallback would absorb it and leave the surface claiming a
    // transport that describes none of its mcp ops.
    const mixed = composition({
      ingredients: [{ slug: 'peer', kind: 'http', http: { base: 'https://api.example.com' } }],
      operations: [
        { op: 'project.list', ingredient: 'peer', risk: 'read', approval: 'never',
          bind: { kind: 'mcp', tool: 'project.list' } },
        { op: 'health.get', ingredient: 'peer', risk: 'read', approval: 'never',
          bind: { kind: 'rest', method: 'GET', path_template: '/health' } },
      ],
    });
    expect((decompose(mixed).catalog as IngredientManifest).surfaces?.api?.transport).toBe('mcp');
  });

  it('still refuses a 1x1 graphql composition — only rest and mcp lower here', () => {
    const gql = composition({
      ingredients: [{ slug: 'peer', kind: 'http', http: { base: 'https://api.example.com' } }],
      operations: [{
        op: 'project.list',
        ingredient: 'peer',
        risk: 'read',
        approval: 'never',
        bind: { kind: 'graphql', operation_type: 'query', endpoint_path: '/graphql', query: '{ p }' },
      }],
    });
    expect(() => decompose(gql)).toThrow(/requires a rest or mcp binding/);
  });
});
