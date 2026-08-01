/** D-192 Slice 6c — the shared connection-api wire-arg composer. */

import { describe, expect, it } from 'vitest';

import { composeWireArgs, wireTransportOf } from '../work-entity-wire-body.js';
import type { IngredientManifest } from '@recued/contracts';

const ok = (r: ReturnType<typeof composeWireArgs>): Record<string, unknown> => {
  if (!r.ok) throw new Error(`expected ok, got: ${r.reason}`);
  return r.args;
};

describe('composeWireArgs — rest', () => {
  it('nests 2-level body paths under a single top segment (the mangle fix)', () => {
    // Asana `task.create`: pushable body fields + dependency-attribute args all
    // land inside ONE `body.data` object — the adapter splits only the first
    // `body.` segment, so this composition is what keeps `workspace`/`projects`
    // from arriving as flat literal-dot keys the vendor never reads.
    const args = ok(composeWireArgs([
      ['body.data.name', 'Ship it'],
      ['body.data.workspace', 'w1'],
      ['body.data.projects', ['p1']],
    ], 'rest'));
    expect(args).toEqual({ 'body.data': { name: 'Ship it', workspace: 'w1', projects: ['p1'] } });
    // and crucially NOT the pre-composition flat form
    expect(Object.keys(args)).not.toContain('body.data.workspace');
  });

  it('passes non-body keys through flat alongside the composed body', () => {
    const args = ok(composeWireArgs([
      ['task_gid', 'g9'],
      ['body.data.name', 'Sub'],
    ], 'rest'));
    expect(args).toEqual({ task_gid: 'g9', 'body.data': { name: 'Sub' } });
  });

  it('composes a single-level body (HubSpot `body.properties`) unchanged', () => {
    const args = ok(composeWireArgs([
      ['body.properties.hs_task_subject', 'T'],
      ['body.properties.hs_task_status', 'OPEN'],
    ], 'rest'));
    expect(args).toEqual({ 'body.properties': { hs_task_subject: 'T', hs_task_status: 'OPEN' } });
  });

  it('refuses two args writing the same body leaf (one authority per arg)', () => {
    const r = composeWireArgs([['body.data.name', 'A'], ['body.data.name', 'B']], 'rest');
    expect(r).toMatchObject({ ok: false });
    if (r.ok) return;
    expect(r.reason).toContain('body.data.name');
  });

  it('refuses descending through a scalar already set at a parent segment', () => {
    const r = composeWireArgs([['body.data', 'scalar'], ['body.data.name', 'X']], 'rest');
    expect(r).toMatchObject({ ok: false });
  });

  it('refuses a prototype-sensitive body segment', () => {
    const r = composeWireArgs([['body.__proto__.polluted', true]], 'rest');
    expect(r).toMatchObject({ ok: false });
  });

  it('refuses a bare `body` key (empty path)', () => {
    expect(composeWireArgs([['body', { a: 1 }]], 'rest')).toMatchObject({ ok: false });
  });

  it('refuses a non-body key set by more than one source', () => {
    const r = composeWireArgs([['teamId', 't1'], ['teamId', 't2']], 'rest');
    expect(r).toMatchObject({ ok: false });
    if (r.ok) return;
    expect(r.reason).toContain('teamId');
  });
});

describe('composeWireArgs — graphql', () => {
  it('passes flat mutation variables through verbatim', () => {
    const args = ok(composeWireArgs([['title', 'T'], ['teamId', 't1']], 'graphql'));
    expect(args).toEqual({ title: 'T', teamId: 't1' });
  });

  it('rejects a nested (dotted) key — a graphql variable is a flat name', () => {
    const r = composeWireArgs([['body.data.name', 'T']], 'graphql');
    expect(r).toMatchObject({ ok: false });
    if (r.ok) return;
    expect(r.reason).toContain('flat argument name');
  });

  it('rejects a duplicate variable', () => {
    expect(composeWireArgs([['title', 'A'], ['title', 'B']], 'graphql')).toMatchObject({ ok: false });
  });
});

describe('wireTransportOf', () => {
  const manifest = (executes?: Record<string, { kind: string }>): IngredientManifest =>
    ({ surfaces: { api: executes !== undefined ? { executes } : {} } }) as unknown as IngredientManifest;

  it('reads graphql off the surface execution binding', () => {
    expect(wireTransportOf(manifest({ 'issue.create': { kind: 'graphql' } }), 'issue.create')).toBe('graphql');
  });

  it('defaults to rest for a non-graphql / absent binding', () => {
    expect(wireTransportOf(manifest({ 'project.create': { kind: 'rest' } }), 'project.create')).toBe('rest');
    expect(wireTransportOf(manifest(), 'anything')).toBe('rest');
  });

  // ── D-225 Slice 1 ───────────────────────────────────────────────────────
  it('reports mcp as ITSELF rather than letting the rest default absorb it', () => {
    expect(wireTransportOf(manifest({ 'project.create': { kind: 'mcp' } }), 'project.create')).toBe('mcp');
  });
});

describe('composeWireArgs — mcp (D-225 Slice 3)', () => {
  /** Slice 1 REFUSED mcp here, to stop it falling into the rest default and
   *  composing a `body.*` tree for a transport whose handler reads `args` — a
   *  write dispatched with arguments the tool never sees, request succeeding.
   *
   *  🔑 Slice 3 built the composer and found the Slice-1 refusal's stated reason
   *  half wrong. It said MCP arguments were "a typed object per the tool
   *  inputSchema, not a REST body tree or graphql variables" — but a graphql
   *  operation's variables are ALSO a typed object of named arguments. REST is
   *  the odd one out: only it has a URL plus a body TREE. So mcp joins the
   *  graphql branch instead of getting a third one.
   */
  it('🔑 D-225 Slice 3 — composes mcp like GRAPHQL: flat named arguments', () => {
    // Slice 1 refused mcp here, and Slice 3 found the stated reason half wrong:
    // a graphql operation's variables are ALSO a typed object of named
    // arguments. REST is the odd one out — only it has a body TREE. So mcp
    // takes the graphql branch rather than getting a third one.
    const args = ok(composeWireArgs([['title', 'Ship it'], ['workspace', 'w1']], 'mcp'));
    expect(args).toEqual({ title: 'Ship it', workspace: 'w1' });
  });

  it('rejects a dotted key on mcp — a body path is a REST shape', () => {
    const r = composeWireArgs([['body.data.name', 'Ship it']], 'mcp');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toMatch(/mcp wire arg/);
    expect(r.reason).toMatch(/flat argument name/);
  });

  it('an empty arg list composes to empty args, not a refusal', () => {
    // An arg-less tool call is legitimate — `tools/call` with `arguments: {}`.
    expect(ok(composeWireArgs([], 'mcp'))).toEqual({});
  });

  it('refuses a duplicate mcp argument — one authority per arg', () => {
    expect(composeWireArgs([['title', 'a'], ['title', 'b']], 'mcp').ok).toBe(false);
  });

  it('leaves rest and graphql composing exactly as before', () => {
    // The regression half: mcp joining the graphql branch must not change what
    // that branch does for graphql, nor touch rest's body-tree composition.
    expect(ok(composeWireArgs([['body.data.name', 'x']], 'rest')))
      .toEqual({ 'body.data': { name: 'x' } });
    expect(ok(composeWireArgs([['name', 'x']], 'graphql'))).toEqual({ name: 'x' });
  });
});
