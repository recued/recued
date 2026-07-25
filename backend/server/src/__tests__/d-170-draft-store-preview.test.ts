/** D-170 N.4 / N.15 — draft store + test-before-save preview.
 *
 *  Covers the authoring side that precedes install: the per-pair `DraftStore`
 *  (save / get / list / delete + caps), the `runIngredientPreview` safety model
 *  (the load-bearing invariant — a mutation is NEVER executed; reads run through
 *  the injected adapter; output is redacted + bounded), and the
 *  `makeIngredientDraftHandlers` rpc surface. */

import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  INGREDIENT_DRAFT_MAX_BYTES,
  INGREDIENT_DRAFT_MAX_COUNT,
  INGREDIENT_PREVIEW_MAX_OUTPUT_BYTES,
  type CompositionIngredient,
  type ConnectionKind,
  type ConnectionRow,
  type IngredientPreviewResult,
  type PackOperationRow,
} from '@recued/contracts';
import type { ResolvedCall } from '@recued/ingredients';

import { createDraftStore, type DraftStore } from '../ingredient-authoring/draft-store.js';
import {
  runIngredientPreview,
  type IngredientPreviewDeps,
} from '../ingredient-authoring/preview.js';
import { makeIngredientDraftHandlers } from '../ingredient-authoring/draft-preview-rpc.js';

const NOW = 1_700_000_000_000;

// ── store harness ──────────────────────────────────────────────

const freshStore = (now = () => NOW, newId?: () => string): DraftStore => {
  let n = 0;
  return createDraftStore(new Database(':memory:'), {
    now,
    newId: newId ?? ((): string => `draft-${++n}`),
  });
};

// ── composition fixtures (D-182 two-table shape) ───────────────

const readOp = (op: string, path: string): PackOperationRow => ({
  op,
  ingredient: 'acme',
  risk: 'read',
  approval: 'never',
  bind: { kind: 'rest', method: 'GET', path_template: path },
});

const writeOp = (op: string, path: string): PackOperationRow => ({
  op,
  ingredient: 'acme',
  risk: 'write',
  approval: 'ask',
  bind: { kind: 'rest', method: 'POST', path_template: path },
});

/** The default `http` ingredient row — `acme` connection-kind, base URL the
 *  preview reads off the enrolled connection record (not this `base`). */
const httpIngredient = (): CompositionIngredient['ingredients'][number] => ({
  slug: 'acme',
  kind: 'http',
  http: { base: 'https://api.acme.example', connection: 'acme' },
  entities: {
    Deal: {
      fields: [
        { field_path: 'id', type: 'string', maps_to: 'result.id', source_operation: 'deal.read' },
        { field_path: 'name', type: 'string', maps_to: 'result.properties.name', source_operation: 'deal.read' },
      ],
    },
  },
});

const composition = (overrides: Partial<CompositionIngredient> = {}): CompositionIngredient => ({
  schema_version: 1,
  slug: 'acme',
  catalog_kind: 'private_byo',
  ingredients: [httpIngredient()],
  operations: [
    readOp('deal.read', '/v3/deals/{{deal_id}}'),
    writeOp('deal.create', '/v3/deals'),
  ],
  ...overrides,
});

const connectionRow = (name: string, baseUrl = 'https://api.acme.example'): ConnectionRow => ({
  pk: `api:${name}`,
  kind: 'api',
  name,
  display_name: name,
  config_json: JSON.stringify({ base_url: baseUrl }),
  auth_ciphertext: 'OPAQUE',
  enrolled_at: NOW,
  updated_at: NOW,
});

/** A preview deps harness: a draft store seeded with one composition draft, an
 *  optional enrolled connection, and a spy `execute`. */
const previewHarness = (opts: {
  comp?: CompositionIngredient;
  enrolled?: boolean;
  execute?: (call: ResolvedCall) => Promise<unknown>;
} = {}): {
  deps: IngredientPreviewDeps;
  draftId: string;
  execute: ReturnType<typeof vi.fn>;
} => {
  const store = freshStore();
  const saved = store.save({ body: opts.comp ?? composition() });
  if ('error' in saved) throw new Error('seed failed');
  const execute = vi.fn(opts.execute ?? (async () => ({ status: 200, headers: {}, result: {} })));
  const lookup = (kind: ConnectionKind, name: string): ConnectionRow | null =>
    opts.enrolled === false ? null : connectionRow(name);
  return {
    deps: {
      draftStore: store,
      connectionLookup: lookup,
      ...(opts.execute || opts.execute === undefined ? { execute } : {}),
    },
    draftId: saved.draft_id,
    execute,
  };
};

const okResult = (r: IngredientPreviewResult): Extract<IngredientPreviewResult, { ok: true }> => {
  if (!r.ok) throw new Error(`expected ok, got ${r.code}`);
  return r;
};

// ───────────────────────────────────────────────────────────────
describe('D-170 draft store', () => {
  it('save creates a draft with a generated id + timestamps', () => {
    const store = freshStore();
    const saved = store.save({ title: 'WIP', body: composition() });
    expect('error' in saved).toBe(false);
    if ('error' in saved) return;
    expect(saved.draft_id).toBe('draft-1');
    expect(saved.title).toBe('WIP');
    expect(saved.created_at).toBe(NOW);
    expect(saved.updated_at).toBe(NOW);
    expect(store.count()).toBe(1);
  });

  it('save overwrites in place by id — preserves created_at, bumps updated_at', () => {
    let t = NOW;
    const store = freshStore(() => t);
    const a = store.save({ body: composition() });
    if ('error' in a) throw new Error('seed');
    t = NOW + 5_000;
    const b = store.save({ draft_id: a.draft_id, body: composition({ slug: 'acme2' }) });
    if ('error' in b) throw new Error('overwrite');
    expect(b.draft_id).toBe(a.draft_id);
    expect(b.created_at).toBe(NOW);
    expect(b.updated_at).toBe(NOW + 5_000);
    expect(store.count()).toBe(1);
    expect((store.get(a.draft_id)?.body as CompositionIngredient).slug).toBe('acme2');
  });

  it('save honors a caller-supplied id for a create (idempotent create-with-id)', () => {
    const store = freshStore();
    const saved = store.save({ draft_id: 'my-id', body: composition() });
    if ('error' in saved) throw new Error('seed');
    expect(saved.draft_id).toBe('my-id');
    expect(store.get('my-id')).not.toBeNull();
  });

  it('list returns body-free summaries, newest-updated first', () => {
    let t = NOW;
    const store = freshStore(() => t);
    store.save({ draft_id: 'one', title: 'One', body: composition({ slug: 'one' }) });
    t = NOW + 1_000;
    // A `cli` primary ingredient → the summary derives `surface: 'connector'`.
    store.save({
      draft_id: 'two',
      body: composition({
        slug: 'two',
        ingredients: [{ slug: 'acme', kind: 'cli', cli: { tool: 'gh', probe: ['gh', '--version'] } }],
      }),
    });
    const list = store.list();
    expect(list.map((s) => s.draft_id)).toEqual(['two', 'one']);
    expect(list[0]).toMatchObject({ slug: 'two', surface: 'connector', operation_count: 2 });
    expect(list[1]).toMatchObject({ slug: 'one', title: 'One', surface: 'api' });
    expect(list[0]).not.toHaveProperty('body');
  });

  it('summary projects null/0 for an incomplete body', () => {
    const store = freshStore();
    store.save({ draft_id: 'x', body: { slug: 42, notes: 'wip' } });
    const [s] = store.list();
    expect(s).toMatchObject({ slug: null, surface: null, operation_count: 0 });
  });

  it('delete removes a draft; returns false for a missing id', () => {
    const store = freshStore();
    store.save({ draft_id: 'gone', body: composition() });
    expect(store.delete('gone')).toBe(true);
    expect(store.get('gone')).toBeNull();
    expect(store.delete('gone')).toBe(false);
  });

  it('rejects a body over the byte cap', () => {
    const store = freshStore();
    const huge = { slug: 'big', operation_families: [], blob: 'x'.repeat(INGREDIENT_DRAFT_MAX_BYTES) };
    const r = store.save({ body: huge });
    expect(r).toEqual({ error: 'too_large' });
    expect(store.count()).toBe(0);
  });

  it('rejects a NEW draft past the count cap but still allows overwrite', () => {
    const store = freshStore(() => NOW, (() => { let n = 0; return () => `d${n++}`; })());
    for (let i = 0; i < INGREDIENT_DRAFT_MAX_COUNT; i++) {
      const r = store.save({ body: composition() });
      if ('error' in r) throw new Error(`unexpected cap at ${i}`);
    }
    expect(store.count()).toBe(INGREDIENT_DRAFT_MAX_COUNT);
    expect(store.save({ body: composition() })).toEqual({ error: 'limit_reached' });
    // Overwrite of an existing id is exempt from the count cap.
    const overwrite = store.save({ draft_id: 'd0', body: composition({ slug: 'updated' }) });
    expect('error' in overwrite).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────
describe('D-170 preview — safety model', () => {
  it('NEVER executes a write — returns the redacted plan, execute untouched', async () => {
    const h = previewHarness();
    const r = okResult(await runIngredientPreview(h.deps, { draft_id: h.draftId, operation_key: 'deal.create' }));
    expect(r.risk_tier).toBe('write');
    expect(r.execution).toEqual({ executed: false, reason: 'mutation' });
    expect(h.execute).not.toHaveBeenCalled();
    // The plan is still informative: redacted target + auth source.
    expect(r.target.verb).toBe('POST');
    expect(r.target.request).toContain('https://api.acme.example/v3/deals');
    expect(r.target.auth).toEqual({ model: 'recued_injected', connection: 'acme', connection_enrolled: true });
  });

  it.each([
    ['admin', 'always' as const],
    ['destructive', 'always' as const],
  ])('NEVER executes a %s operation', async (tier) => {
    const comp = composition({
      operations: [
        {
          ...writeOp('deal.purge', '/v3/deals/{{deal_id}}'),
          risk: tier as PackOperationRow['risk'],
          bind: { kind: 'rest', method: 'DELETE', path_template: '/v3/deals/{{deal_id}}' },
        },
      ],
    });
    const h = previewHarness({ comp });
    const r = okResult(await runIngredientPreview(h.deps, { draft_id: h.draftId, operation_key: 'deal.purge' }));
    expect(r.execution).toEqual({ executed: false, reason: 'mutation' });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('executes a read through the adapter — bounded + redacted output + mapping', async () => {
    const h = previewHarness({
      execute: async (call) => {
        // The wire input is the same shape the gateway builds (binding owns
        // method/path; caller args ride alongside).
        expect(call.input).toMatchObject({
          method: 'GET',
          path: '/v3/deals/{{deal_id}}',
          connection_kind: 'api',
          connection: 'acme',
          deal_id: 'D1',
        });
        expect(call.risk_tier).toBe('read');
        return { status: 200, headers: {}, result: { id: 'D1', properties: { name: 'Acme' }, access_token: 'sk-LEAK' } };
      },
    });
    const r = okResult(
      await runIngredientPreview(h.deps, { draft_id: h.draftId, operation_key: 'deal.read', args: { deal_id: 'D1' } }),
    );
    expect(h.execute).toHaveBeenCalledOnce();
    expect(r.execution.executed).toBe(true);
    if (!r.execution.executed || r.execution.outcome !== 'ok') throw new Error('expected ok exec');
    expect(r.execution.status).toBe(200);
    // auth-like key masked in the output preview.
    expect((r.execution.output_preview as Record<string, unknown>).access_token).toBe('[redacted]');
    expect((r.execution.output_preview as Record<string, unknown>).id).toBe('D1');
    // mapping preview resolves samples off the live `{status,headers,result}`.
    const byField = Object.fromEntries(r.execution.mapping_preview.map((m) => [m.entity_field, m.sample]));
    expect(byField).toEqual({ id: 'D1', name: 'Acme' });
  });

  it('truncates an oversized read output', async () => {
    const big = 'y'.repeat(INGREDIENT_PREVIEW_MAX_OUTPUT_BYTES + 5_000);
    const h = previewHarness({
      execute: async () => ({ status: 200, headers: {}, result: { blob: big } }),
    });
    const r = okResult(await runIngredientPreview(h.deps, { draft_id: h.draftId, operation_key: 'deal.read' }));
    if (!r.execution.executed || r.execution.outcome !== 'ok') throw new Error('expected ok');
    expect(r.execution.truncated).toBe(true);
  });

  it('redacts the request target — userinfo + auth-like query param', async () => {
    const comp = composition({
      operations: [
        { ...readOp('deal.search', '/v3/search'), bind: { kind: 'rest', method: 'GET', path_template: '/v3/search', static_query: { api_key: 'SECRET123', q: 'acme' } } },
      ],
    });
    const h = previewHarness({ comp });
    const r = okResult(await runIngredientPreview(h.deps, { draft_id: h.draftId, operation_key: 'deal.search' }));
    if (!r.execution.executed || r.execution.outcome !== 'ok') throw new Error('expected exec');
    expect(r.target.request).not.toContain('SECRET123');
    expect(r.target.request.toLowerCase()).toContain('api_key=');
    expect(r.target.request.toLowerCase()).toContain('redacted');
    expect(r.target.request).toContain('q=acme');
  });

  it('read with no enrolled connection → no_connection, execute untouched', async () => {
    const h = previewHarness({ enrolled: false });
    const r = okResult(await runIngredientPreview(h.deps, { draft_id: h.draftId, operation_key: 'deal.read' }));
    expect(r.execution).toEqual({ executed: false, reason: 'no_connection' });
    expect(r.target.auth.connection_enrolled).toBe(false);
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('read with no execution seam → preview_unavailable', async () => {
    const h = previewHarness();
    const deps: IngredientPreviewDeps = { draftStore: h.deps.draftStore, connectionLookup: h.deps.connectionLookup };
    const r = okResult(await runIngredientPreview(deps, { draft_id: h.draftId, operation_key: 'deal.read' }));
    expect(r.execution).toEqual({ executed: false, reason: 'preview_unavailable' });
  });

  it('connector surface → connector_surface, never executed', async () => {
    const comp = composition({
      ingredients: [{ slug: 'acme', kind: 'cli', cli: { tool: 'gh', probe: ['gh', 'auth', 'status'] } }],
      operations: [
        { ...readOp('pr.list', ''), bind: { kind: 'cli_invocation', argv_template: ['gh', 'pr', 'list'], shape: 'text', exit_code_handling: 'zero_is_success' } },
      ],
    });
    const h = previewHarness({ comp });
    const r = okResult(await runIngredientPreview(h.deps, { draft_id: h.draftId, operation_key: 'pr.list' }));
    expect(r.execution).toEqual({ executed: false, reason: 'connector_surface' });
    expect(r.target.surface).toBe('connector');
    expect(r.target.request).toBe('gh pr list');
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('detached cli connector preview marks marker-file completion', async () => {
    const comp = composition({
      ingredients: [{ slug: 'acme', kind: 'cli', cli: { tool: 'codex', probe: ['codex', '--version'] } }],
      operations: [
        {
          ...readOp('codex.review', ''),
          bind: {
            kind: 'cli_invocation',
            argv_template: ['codex', 'exec', '--cd', '{repo_dir}', '{task}'],
            shape: 'text',
            exit_code_handling: 'zero_is_success',
            detached: {
              mode: 'runtime_managed',
              completion: {
                kind: 'marker_file',
                exit_pattern: '{result_dir}/{key}.exit.{code}',
              },
            },
          },
        },
      ],
    });
    const h = previewHarness({ comp });
    const r = okResult(await runIngredientPreview(h.deps, { draft_id: h.draftId, operation_key: 'codex.review' }));

    expect(r.execution).toEqual({ executed: false, reason: 'connector_surface' });
    expect(r.target.request).toBe('codex exec --cd {repo_dir} {task} (detached marker_file)');
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('graphql subscription binding → unsupported_binding', async () => {
    const comp = composition({
      operations: [
        { ...readOp('deal.stream', ''), bind: { kind: 'graphql', operation_type: 'subscription', endpoint_path: '/graphql', query: 'subscription { deals { id } }' } },
      ],
    });
    const h = previewHarness({ comp });
    const r = okResult(await runIngredientPreview(h.deps, { draft_id: h.draftId, operation_key: 'deal.stream' }));
    expect(r.execution).toEqual({ executed: false, reason: 'unsupported_binding' });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('executes a graphql query read (POST to endpoint with variables)', async () => {
    const comp = composition({
      operations: [
        { ...readOp('deal.query', ''), bind: { kind: 'graphql', operation_type: 'query', endpoint_path: '/graphql', query: 'query($id:ID!){ deal(id:$id){ id } }' } },
      ],
    });
    const h = previewHarness({
      comp,
      execute: async (call) => {
        expect(call.input).toMatchObject({ method: 'POST', path: '/graphql', 'body.query': expect.stringContaining('deal('), 'body.variables': { id: 'D9' } });
        return { status: 200, headers: {}, result: { data: { deal: { id: 'D9' } } } };
      },
    });
    const r = okResult(await runIngredientPreview(h.deps, { draft_id: h.draftId, operation_key: 'deal.query', args: { id: 'D9' } }));
    expect(r.target.request).toContain('graphql query');
    expect(r.execution.executed).toBe(true);
  });

  it('surfaces an executed-read failure as outcome:error with a redacted message', async () => {
    const h = previewHarness({
      execute: async () => {
        const e = new Error('401 from https://api.acme.example with Bearer sk-SUPERSECRET') as Error & { code: string };
        e.code = 'OAUTH_EXPIRED';
        throw e;
      },
    });
    const r = okResult(await runIngredientPreview(h.deps, { draft_id: h.draftId, operation_key: 'deal.read' }));
    if (!r.execution.executed || r.execution.outcome !== 'error') throw new Error('expected error outcome');
    expect(r.execution.error.code).toBe('OAUTH_EXPIRED');
    expect(r.execution.error.message).toContain('Bearer [redacted]');
    expect(r.execution.error.message).not.toContain('sk-SUPERSECRET');
  });

  it('the auth source never leaks a secret — model + connection name only', async () => {
    const h = previewHarness();
    const r = okResult(await runIngredientPreview(h.deps, { draft_id: h.draftId, operation_key: 'deal.read' }));
    expect(r.target.auth).toEqual({ model: 'recued_injected', connection: 'acme', connection_enrolled: true });
    expect(JSON.stringify(r.target)).not.toContain('OPAQUE');
  });

  it('rejects bad args + missing draft / operation', async () => {
    const h = previewHarness();
    expect((await runIngredientPreview(h.deps, { draft_id: '', operation_key: 'x' })).ok).toBe(false);
    expect((await runIngredientPreview(h.deps, { draft_id: 'nope', operation_key: 'deal.read' }))).toMatchObject({ ok: false, code: 'draft_not_found' });
    expect((await runIngredientPreview(h.deps, { draft_id: h.draftId, operation_key: 'ghost' }))).toMatchObject({ ok: false, code: 'operation_not_found' });
  });

  it('rejects a draft body that is not a composition', async () => {
    const store = freshStore();
    const saved = store.save({ body: { slug: 'x', notes: 'no operation_families' } });
    if ('error' in saved) throw new Error('seed');
    const r = await runIngredientPreview({ draftStore: store }, { draft_id: saved.draft_id, operation_key: 'deal.read' });
    expect(r).toMatchObject({ ok: false, code: 'invalid_draft' });
  });
});

// ───────────────────────────────────────────────────────────────
describe('D-170 preview — adversarial hardening', () => {
  // A draft is UNVALIDATED — the gate must key on the binding shape, not the
  // declared tier. An op labelled `read` with a mutating binding must NOT run.
  it.each([
    ['POST'],
    ['PUT'],
    ['PATCH'],
    ['DELETE'],
  ])('refuses a read-labelled %s binding (binding shape wins over tier)', async (method) => {
    const comp = composition({
      operations: [
        {
          op: 'deal.sneaky',
          ingredient: 'acme',
          risk: 'read', // MISLABELED — actually mutates
          approval: 'never',
          bind: { kind: 'rest', method: method as never, path_template: '/v3/deals/{{deal_id}}' },
        },
      ],
    });
    const h = previewHarness({ comp });
    const r = okResult(await runIngredientPreview(h.deps, { draft_id: h.draftId, operation_key: 'deal.sneaky', args: { deal_id: 'D1' } }));
    expect(r.execution).toEqual({ executed: false, reason: 'mutation' });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('refuses a read-labelled graphql mutation', async () => {
    const comp = composition({
      operations: [
        { ...readOp('deal.upsert', ''), bind: { kind: 'graphql', operation_type: 'mutation', endpoint_path: '/graphql', query: 'mutation { upsertDeal { id } }' } },
      ],
    });
    const h = previewHarness({ comp });
    const r = okResult(await runIngredientPreview(h.deps, { draft_id: h.draftId, operation_key: 'deal.upsert' }));
    expect(r.execution).toEqual({ executed: false, reason: 'mutation' });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('masks an auth-like mapping sample (source path / field name)', async () => {
    const comp = composition({
      ingredients: [{
        slug: 'acme',
        kind: 'http',
        http: { base: 'https://api.acme.example', connection: 'acme' },
        entities: {
          Deal: {
            fields: [
              { field_path: 'id', type: 'string', maps_to: 'result.id', source_operation: 'deal.read' },
            ],
          },
          Auth: {
            fields: [
              { field_path: 'leaked', type: 'string', maps_to: 'result.access_token', source_operation: 'deal.read' },
              { field_path: 'token', type: 'string', maps_to: 'result.value', source_operation: 'deal.read' },
            ],
          },
        },
      }],
    });
    const h = previewHarness({
      comp,
      execute: async () => ({ status: 200, headers: {}, result: { id: 'D1', access_token: 'sk-LEAK', value: 'sk-ALSO-LEAK' } }),
    });
    const r = okResult(await runIngredientPreview(h.deps, { draft_id: h.draftId, operation_key: 'deal.read' }));
    if (!r.execution.executed || r.execution.outcome !== 'ok') throw new Error('expected ok');
    const byField = Object.fromEntries(r.execution.mapping_preview.map((m) => [m.entity_field, m.sample]));
    expect(byField.id).toBe('D1');
    // auth-like SOURCE path (`result.access_token`) → masked
    expect(byField.leaked).toBe('[redacted]');
    // auth-like DESTINATION field (`token`) → masked even though source is benign
    expect(byField.token).toBe('[redacted]');
  });

  it('masks an auth-like path param in the redacted target', async () => {
    const comp = composition({
      operations: [
        { ...readOp('key.read', '/keys/{{api_key}}'), bind: { kind: 'rest', method: 'GET', path_template: '/keys/{{api_key}}' } },
      ],
    });
    const h = previewHarness({ comp });
    const r = okResult(await runIngredientPreview(h.deps, { draft_id: h.draftId, operation_key: 'key.read', args: { api_key: 'SECRETKEY123' } }));
    expect(r.target.request).not.toContain('SECRETKEY123');
    expect(r.target.request.toLowerCase()).toContain('redacted');
  });

  it('masks auth-like query params even with NO base url (unenrolled plan)', async () => {
    const comp = composition({
      operations: [
        { ...readOp('deal.search', '/v3/search'), bind: { kind: 'rest', method: 'GET', path_template: '/v3/search', static_query: { api_key: 'STATIC_SECRET', q: 'acme' } } },
      ],
    });
    const h = previewHarness({ comp, enrolled: false }); // no record → no base_url branch
    const r = okResult(await runIngredientPreview(h.deps, { draft_id: h.draftId, operation_key: 'deal.search', args: { 'query.access_token': 'ARG_SECRET' } }));
    expect(r.execution).toEqual({ executed: false, reason: 'no_connection' });
    expect(r.target.request).not.toContain('STATIC_SECRET');
    expect(r.target.request).not.toContain('ARG_SECRET');
    expect(r.target.request).toContain('q=acme');
  });

  it('scrubs a secret an author typed into a connector argv (display backstop)', async () => {
    const comp = composition({
      ingredients: [{ slug: 'acme', kind: 'cli', cli: { tool: 'curl', probe: ['curl', '--version'] } }],
      operations: [
        { ...readOp('fetch', ''), bind: { kind: 'cli_invocation', argv_template: ['curl', '-H', 'Authorization: Bearer ARGV_SECRET'], shape: 'text', exit_code_handling: 'zero_is_success' } },
      ],
    });
    const h = previewHarness({ comp });
    const r = okResult(await runIngredientPreview(h.deps, { draft_id: h.draftId, operation_key: 'fetch' }));
    expect(r.execution).toEqual({ executed: false, reason: 'connector_surface' });
    expect(r.target.request).not.toContain('ARGV_SECRET');
  });

  it('scrubs secret string VALUES under benign keys / arrays in executed-read output', async () => {
    const h = previewHarness({
      execute: async () => ({
        status: 200,
        headers: {},
        result: {
          echo: 'Authorization: Bearer SK_BENIGN_KEY',
          notes: ['ok', 'client_secret=SK_ARRAY'],
          id: 'D1',
        },
      }),
    });
    const r = okResult(await runIngredientPreview(h.deps, { draft_id: h.draftId, operation_key: 'deal.read' }));
    if (!r.execution.executed || r.execution.outcome !== 'ok') throw new Error('expected ok');
    const out = JSON.stringify(r.execution.output_preview);
    expect(out).not.toContain('SK_BENIGN_KEY');
    expect(out).not.toContain('SK_ARRAY');
    expect(out).toContain('D1');
  });

  it('redacts underscored auth keys + URLs in an executed-read error message', async () => {
    const h = previewHarness({
      execute: async () => {
        throw new Error('upstream 400: access_token=LEAK_AT client_secret=LEAK_CS at https://api.acme.example/x?token=LEAK_Q');
      },
    });
    const r = okResult(await runIngredientPreview(h.deps, { draft_id: h.draftId, operation_key: 'deal.read' }));
    if (!r.execution.executed || r.execution.outcome !== 'error') throw new Error('expected error');
    const msg = r.execution.error.message;
    expect(msg).not.toContain('LEAK_AT');
    expect(msg).not.toContain('LEAK_CS');
    expect(msg).not.toContain('LEAK_Q');
  });

  it('redacts QUOTED labeled secrets in a text/stringified-JSON output leaf', async () => {
    const h = previewHarness({
      execute: async () => ({
        status: 200,
        headers: {},
        // result is a STRING (text/plain or stringified JSON) — object-key
        // masking can't see inside, so the per-string-leaf scrub must.
        result: '{"access_token":"LEAK_QJSON","client_secret": "LEAK_SPACED"}',
      }),
    });
    const r = okResult(await runIngredientPreview(h.deps, { draft_id: h.draftId, operation_key: 'deal.read' }));
    if (!r.execution.executed || r.execution.outcome !== 'ok') throw new Error('expected ok');
    const out = JSON.stringify(r.execution.output_preview);
    expect(out).not.toContain('LEAK_QJSON');
    expect(out).not.toContain('LEAK_SPACED');
  });

  it('redacts a NON-Bearer (Basic) Authorization value — output + error', async () => {
    const B64 = 'dXNlcjpzdXBlcnNlY3JldHBhc3N3b3Jk';
    // executed-read output echoing a Basic header under a benign key
    const out = previewHarness({
      execute: async () => ({ status: 200, headers: {}, result: { echo: `Authorization: Basic ${B64}` } }),
    });
    const ro = okResult(await runIngredientPreview(out.deps, { draft_id: out.draftId, operation_key: 'deal.read' }));
    if (!ro.execution.executed || ro.execution.outcome !== 'ok') throw new Error('expected ok');
    expect(JSON.stringify(ro.execution.output_preview)).not.toContain(B64);
    // error message carrying the same
    const err = previewHarness({
      execute: async () => { throw new Error(`401 Authorization: Basic ${B64} rejected`); },
    });
    const re = okResult(await runIngredientPreview(err.deps, { draft_id: err.draftId, operation_key: 'deal.read' }));
    if (!re.execution.executed || re.execution.outcome !== 'error') throw new Error('expected error');
    expect(re.execution.error.message).not.toContain(B64);
  });
});

// ───────────────────────────────────────────────────────────────
describe('D-170 draft + preview rpc handlers', () => {
  it('returns undefined without a draft store (slice un-wired)', () => {
    expect(makeIngredientDraftHandlers(undefined)).toBeUndefined();
  });

  it('wires all six methods', () => {
    const slice = makeIngredientDraftHandlers({ draftStore: freshStore() });
    expect(slice?.methods).toEqual([
      'ingredient.draft.save',
      'ingredient.draft.list',
      'ingredient.draft.get',
      'ingredient.draft.delete',
      'ingredient.compose.decompose',
      'ingredient.preview',
    ]);
  });

  it('save → get → list → delete round-trip', async () => {
    const slice = makeIngredientDraftHandlers({ draftStore: freshStore() })!;
    const saved = await slice.handlers['ingredient.draft.save']({ title: 'T', body: composition() }, {} as never);
    if (!saved.ok) throw new Error('save failed');
    const id = saved.draft.draft_id;

    const got = await slice.handlers['ingredient.draft.get']({ draft_id: id }, {} as never);
    expect(got).toMatchObject({ ok: true, draft: { draft_id: id, title: 'T' } });

    const list = await slice.handlers['ingredient.draft.list'](undefined, {} as never);
    expect(list.ok && list.drafts.map((d) => d.draft_id)).toEqual([id]);

    const del = await slice.handlers['ingredient.draft.delete']({ draft_id: id }, {} as never);
    expect(del).toEqual({ ok: true, deleted: true });
    expect(await slice.handlers['ingredient.draft.get']({ draft_id: id }, {} as never)).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('save rejects a non-object body; get/delete reject a missing id', async () => {
    const slice = makeIngredientDraftHandlers({ draftStore: freshStore() })!;
    expect(await slice.handlers['ingredient.draft.save']({ body: 'nope' } as never, {} as never)).toMatchObject({ ok: false, code: 'bad_request' });
    expect(await slice.handlers['ingredient.draft.get']({ draft_id: '' }, {} as never)).toMatchObject({ ok: false, code: 'bad_request' });
    expect(await slice.handlers['ingredient.draft.delete']({} as never, {} as never)).toMatchObject({ ok: false, code: 'bad_request' });
  });

  it('preview dispatches through the handler with the injected execute', async () => {
    const store = freshStore();
    const saved = store.save({ body: composition() });
    if ('error' in saved) throw new Error('seed');
    const execute = vi.fn(async () => ({ status: 200, headers: {}, result: { id: 'D1' } }));
    const slice = makeIngredientDraftHandlers({
      draftStore: store,
      connectionLookup: (_k, name) => connectionRow(name),
      previewExecute: execute,
    })!;
    const r = await slice.handlers['ingredient.preview']({ draft_id: saved.draft_id, operation_key: 'deal.read', args: { deal_id: 'D1' } }, {} as never);
    expect(r.ok).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    // A write through the same handler must not execute.
    const w = await slice.handlers['ingredient.preview']({ draft_id: saved.draft_id, operation_key: 'deal.create' }, {} as never);
    expect(w.ok && w.execution).toEqual({ executed: false, reason: 'mutation' });
    expect(execute).toHaveBeenCalledOnce();
  });
});
